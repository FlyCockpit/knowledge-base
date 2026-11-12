/**
 * Scheduled deletions (expand / contract) at runtime: the runner-owned
 * tables, the rollback admission check, the database identity check and its
 * holds, the due rule, contract validation and tracked application.
 *
 * A migration folder may carry a `contract.sql` next to `migration.sql`.
 * Prisma applies `migration.sql` (the expand step) at deploy; this module
 * applies `contract.sql` (the deletions) later, once no release that still
 * uses the deleted objects can be running:
 *   - a release whose image contains the folder became ready at least
 *     SOAK_MS ago;
 *   - no release whose image lacks it was seen alive in the last SOAK_MS;
 *   - no hold is active (a restore, a database move, the owner);
 *   - it passes validation against the live database and the image's schema.
 *
 * Plain Node, no dependencies: it runs inside the production image
 * (scripts/db/migrate-runtime.mjs, scripts/lib/kb-restore.mjs). Every query is
 * qualified with Prisma's schema (`prismaSchemaName(DATABASE_URL)`). The
 * contract SQL itself comes from the committed files; this module never
 * builds a deletion statement of its own.
 */
import {
  analyzeContract,
  catalogFromSql,
  emptyCatalog,
  enumColumns,
  enumDefaultNamesRemoved,
  normalizeType,
  rollbackSafety,
  splitStatements,
  summarizeEffects,
} from "./sql.mjs";

/** How long a release must have been ready, and older ones gone, before a deletion runs. */
export const SOAK_MS = 7 * 24 * 60 * 60 * 1000;
/** A hold (restore, database move) lasts this long. */
const HOLD_MS = SOAK_MS;
/**
 * A contract starts only with at least this much of the run budget left: its
 * two bookkeeping lock waits (CONTRACT_PREAMBLE_TIMEOUT_MS each) leave room
 * for work. The enum template itself starts only with its full fixed timeout
 * left, and no statement starts with less than 1 s, so every contract
 * statement ends by the run deadline.
 */
export const CONTRACT_START_MIN_MS = 20_000;
/** Lock and statement timeout of a contract's bookkeeping (attempt accounting, row lock, re-plan). */
export const CONTRACT_PREAMBLE_TIMEOUT_MS = 5_000;
/** Fixed statement timeout of the enum `DO` template; the cap for every other statement. */
export const CONTRACT_STATEMENT_TIMEOUT_MS = 15_000;
/** Deterministic failures within one image level before a contract "needs a person". */
const MAX_CONTRACT_ATTEMPTS = 3;
/** Registry rows not seen for this long are pruned. */
const INSTANCE_PRUNE_DAYS = 30;

const LOCK_TIMEOUT = "5s";
const MIN_STATEMENT_TIMEOUT_MS = 1_000;
const SHORT_TIMEOUT_PREFIX = /^short-timeout (\S+) ([12])\/3: /;

// --- runner-owned tables (§1.10) ---------------------------------------------
//
// `%1$I` is the schema. The same text works with PostgreSQL's
// `format(<ddl>, schema)` (kb-restore.mjs) and with `ddlFor(<ddl>, schema)`.
// Created only by the production runner (apply mode, under the runner lock,
// after `_prisma_migrations` exists) and by kb-restore.mjs (the hold table only).

const INSTANCE_DDL = `CREATE TABLE IF NOT EXISTS %1$I."_knowledge_base_instance" (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  schema_level text,
  host text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  contract_folders text[]
)`;
const INSTANCE_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "_knowledge_base_instance_last_seen_at_idx" ON %1$I."_knowledge_base_instance" (last_seen_at)`;
const MIGRATION_DDL = `CREATE TABLE IF NOT EXISTS %1$I."_knowledge_base_migration" (
  name text PRIMARY KEY,
  rollback_safe boolean NOT NULL,
  rollback_reasons text,
  contract_checksum text,
  contract_effects text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  contract_applied_at timestamptz,
  contract_attempts int NOT NULL DEFAULT 0,
  contract_attempt_level text,
  contract_last_error text,
  contract_backup text,
  contract_note text,
  contract_notified_at timestamptz
)`;
export const HOLD_DDL = `CREATE TABLE IF NOT EXISTS %1$I."_knowledge_base_hold" (
  reason text PRIMARY KEY,
  until timestamptz NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now()
)`;
// ADD COLUMN only. Never recreate this table: its own oid (registry_oid) is
// how a logical restore is detected, so a recreate reads as a restore and
// costs one false 7-day hold (fail-safe, but avoidable).
export const CLUSTER_DDL = `CREATE TABLE IF NOT EXISTS %1$I."_knowledge_base_cluster" (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  system_identifier text NOT NULL,
  timeline int,
  database_oid oid NOT NULL,
  registry_oid oid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
)`;
const RUNTIME_DDL = [INSTANCE_DDL, INSTANCE_INDEX_DDL, MIGRATION_DDL, HOLD_DDL, CLUSTER_DDL];

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** One of the DDL constants with its schema filled in. */
export function ddlFor(ddl, schema) {
  return ddl.replaceAll("%1$I", quoteIdent(schema));
}

function tables(schema) {
  const s = quoteIdent(schema);
  return {
    instance: `${s}."_knowledge_base_instance"`,
    migration: `${s}."_knowledge_base_migration"`,
    hold: `${s}."_knowledge_base_hold"`,
    cluster: `${s}."_knowledge_base_cluster"`,
  };
}

/**
 * The hold upsert every hold source uses (R4-8): an existing longer hold is
 * never shortened. `$1` reason, `$2` duration in milliseconds.
 */
export function holdUpsertSql(schema) {
  return `INSERT INTO ${tables(schema).hold} AS h (reason, until)
          VALUES ($1, now() + ($2::double precision * interval '1 millisecond'))
          ON CONFLICT (reason) DO UPDATE SET until = greatest(h.until, EXCLUDED.until), set_at = now()
          RETURNING until`;
}

const sqlState = (error) =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
const errorText = (error) => {
  const code = sqlState(error);
  const message = error instanceof Error ? error.message : String(error);
  return `${code ? `${code}: ` : ""}${message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>")}`;
};
const ms = (value) => (value === null || value === undefined ? null : new Date(value).getTime());
const iso = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");

async function rollbackQuietly(client) {
  await client.query("ROLLBACK").catch(() => {});
}

/** Do the runner-owned tables exist? (`_knowledge_base_migration` stands for all of them.) */
export async function runtimeTablesExist(client, schema) {
  const { rows } = await client.query(
    `SELECT to_regclass(format('%I."_knowledge_base_migration"', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return rows[0]?.present === true;
}

/** CREATE TABLE IF NOT EXISTS for every runner-owned table. Runner lock held. */
export async function ensureRuntimeTables(client, schema) {
  for (const ddl of RUNTIME_DDL) await client.query(ddlFor(ddl, schema));
}

// --- recording applied migrations (F7) ---------------------------------------

const displayKey = (key) =>
  String(key)
    .replace(/^public\./, "")
    .split(".")
    .map((part) => quoteIdent(part))
    .join(".");

/** One human line for what a contract.sql deletes (`contract_effects`, the logs, the generator and the CI summary). */
export function describeEffects(effects) {
  const parts = [];
  for (const key of effects.droppedTables) parts.push(`table ${displayKey(key)}`);
  for (const key of effects.droppedColumns) parts.push(`column ${displayKey(key)}`);
  for (const key of effects.droppedTypes) parts.push(`type ${displayKey(key)}`);
  for (const key of effects.droppedIndexes) parts.push(`index ${displayKey(key)}`);
  for (const key of effects.droppedConstraints) parts.push(`constraint ${displayKey(key)}`);
  for (const removal of effects.enumValuesRemoved)
    for (const [i, label] of removal.removed.entries())
      parts.push(
        `value ${quoteIdent(label)} of enum ${displayKey(removal.enum)} (rows moved to ${quoteIdent(removal.mapped[i])})`,
      );
  return parts.length ? parts.join("; ") : "nothing recognizable";
}

/**
 * Record every image migration that has no `_knowledge_base_migration` row yet
 * (`INSERT … ON CONFLICT DO NOTHING`): rollback safety, the contract checksum
 * and what the contract deletes. Rows are never rewritten.
 * @param {import("pg").Client} client
 * @param {{ schema: string, migrations: Array<{ name: string, sql: string,
 *   contract: { sql: string, checksum: string } | null }> }} options in folder order
 * @returns {Promise<number>} rows inserted
 */
export async function recordApplied(client, { schema, migrations }) {
  const t = tables(schema);
  const { rows } = await client.query(`SELECT name FROM ${t.migration}`);
  const known = new Set(rows.map((row) => row.name));
  if (migrations.every((m) => known.has(m.name))) return 0;
  let catalog = emptyCatalog();
  let inserted = 0;
  for (const migration of migrations) {
    if (!known.has(migration.name)) {
      const safety = rollbackSafety(migration.sql, {
        priorTables: new Set(catalog.tables.keys()),
        catalog,
        folder: migration.name,
      });
      const effects = migration.contract
        ? describeEffects(summarizeEffects(migration.contract.sql, { folder: migration.name }))
        : null;
      const result = await client.query(
        `INSERT INTO ${t.migration} (name, rollback_safe, rollback_reasons, contract_checksum, contract_effects)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
        [
          migration.name,
          safety.safe,
          safety.reasons.length ? safety.reasons.join("; ") : null,
          migration.contract?.checksum ?? null,
          effects,
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    catalog = catalogFromSql(
      migration.contract ? [migration.sql, migration.contract.sql] : [migration.sql],
      catalog,
    );
  }
  return inserted;
}

// --- admission and registration (§1.11) ------------------------------------

/** Lock and statement timeout of a registration that admits nothing (no `ahead`). */
export const REGISTER_TIMEOUT_MS = 5_000;
/** Lock and statement timeout of a rollback admission: it may wait out a running contract. */
const ADMIT_TIMEOUT_MS = 60_000;

/**
 * Rollback admission and self-registration in one transaction. With `ahead`
 * (the database has migrations this image lacks), the image is admitted only
 * if every one of them is recorded, rollback-safe, and its contract has not
 * run; the rows are read FOR SHARE, so a contract that is being applied
 * (FOR UPDATE) either finishes first (and the image is refused) or sees this
 * registration when it re-plans. With `id`, the instance is registered
 * (admitted images only), with `contracts`: the folders of its image that
 * carry a contract.sql. The due rule reads that list, not the level, to
 * decide whether an instance's image contains a contract (a folder merged
 * out of order sorts below an older release's level).
 * @param {import("pg").Client} client
 * @param {{ schema: string, ahead?: string[], id?: string | null, role?: string,
 *   level?: string | null, host?: string | null, contracts?: string[] }} options
 * @returns {Promise<{ admitted: boolean, reasons: string[], registered: boolean, missingTables: boolean }>}
 */
export async function admit(
  client,
  { schema, ahead = [], id = null, role, level, host, contracts = [] },
) {
  const t = tables(schema);
  if (!(await runtimeTablesExist(client, schema)))
    return {
      admitted: ahead.length === 0,
      reasons: ahead.length
        ? [
            `the database has no rollback records ("_knowledge_base_migration" is missing), so nothing shows that ${ahead.join(", ")} can be rolled back`,
          ]
        : [],
      registered: false,
      missingTables: true,
    };
  await client.query("BEGIN");
  try {
    const timeoutMs = ahead.length ? ADMIT_TIMEOUT_MS : REGISTER_TIMEOUT_MS;
    await client.query(`SET LOCAL lock_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const reasons = [];
    if (ahead.length) {
      const { rows } = await client.query(
        `SELECT name, rollback_safe, rollback_reasons, contract_applied_at
           FROM ${t.migration} WHERE name = ANY($1::text[]) ORDER BY name FOR SHARE`,
        [ahead],
      );
      const byName = new Map(rows.map((row) => [row.name, row]));
      for (const name of ahead) {
        const row = byName.get(name);
        if (!row) reasons.push(`${name} has no rollback record`);
        else if (row.contract_applied_at)
          reasons.push(
            `${name}'s scheduled deletion already ran (${iso(row.contract_applied_at)}), so the data the older code needs is gone`,
          );
        else if (!row.rollback_safe)
          reasons.push(`${name} is not rollback-safe (${row.rollback_reasons ?? "unknown"})`);
      }
    }
    const admitted = reasons.length === 0;
    let registered = false;
    if (admitted && id) {
      await client.query(
        `INSERT INTO ${t.instance} (id, role, schema_level, host, contract_folders)
         VALUES ($1::uuid, $2, $3, $4, $5::text[])
         ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
        [id, role ?? "server", level ?? null, host ?? null, [...contracts]],
      );
      registered = true;
    }
    await client.query("COMMIT");
    return { admitted, reasons, registered, missingTables: false };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

/** Delete registry rows not seen for INSTANCE_PRUNE_DAYS. */
export async function pruneInstances(client, schema) {
  const result = await client.query(
    `DELETE FROM ${tables(schema).instance} WHERE last_seen_at < now() - ($1::double precision * interval '86400 seconds')`,
    [INSTANCE_PRUNE_DAYS],
  );
  return result.rowCount ?? 0;
}

// --- database identity and holds (§1.12 source 2) --------------------------

/** SQLSTATEs that mean "this provider does not let the app role read the identity". */
const IDENTITY_UNAVAILABLE = new Set(["42501", "42883", "0A000", "55000"]);
const UNAVAILABLE = "unavailable";

/**
 * Compare the database's identity (system identifier, WAL timeline, database
 * oid, and the registry table's own oid) with the stored row. A difference,
 * or a missing row on a database that already has history, upserts a
 * `cluster-changed` hold. The identity functions are read in autocommit,
 * outside the compare transaction; any read error other than "unavailable"
 * skips every contract this run. Runner lock held, apply mode only.
 * @param {import("pg").Client} client
 * @param {{ schema: string, fresh: boolean, log?: (line: string) => void }} options
 * @returns {Promise<{ skipContracts: boolean, held: boolean }>}
 */
export async function checkClusterIdentity(client, { schema, fresh, log = () => {} }) {
  const t = tables(schema);
  let databaseOid;
  /** @type {{ system_identifier: string, timeline: number | null }} */
  const identity = { system_identifier: UNAVAILABLE, timeline: null };
  try {
    const db = await client.query(
      "SELECT oid::text AS oid FROM pg_database WHERE datname = current_database()",
    );
    databaseOid = db.rows[0]?.oid;
    if (!databaseOid) throw new Error("current database not found in pg_database");
  } catch (error) {
    log(
      `cluster identity read failed (${sqlState(error) || "error"}); scheduled deletions skipped this run`,
    );
    return { skipContracts: true, held: false };
  }
  // Each part is read on its own: a provider that revokes one function still
  // lets the other detect a move (a PITR changes only the timeline).
  for (const [field, sql] of [
    ["system_identifier", "SELECT (pg_control_system()).system_identifier::text AS value"],
    [
      "timeline",
      "SELECT ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::int AS value",
    ],
  ]) {
    try {
      const { rows } = await client.query(sql);
      const value = rows[0]?.value;
      if (value !== null && value !== undefined) identity[field] = value;
    } catch (error) {
      if (!IDENTITY_UNAVAILABLE.has(sqlState(error))) {
        log(
          `cluster identity read failed (${sqlState(error) || "error"}); scheduled deletions skipped this run`,
        );
        return { skipContracts: true, held: false };
      }
    }
  }
  await client.query("BEGIN");
  try {
    // R6-1: the parameter is typed, or preparing the statement fails.
    const registry = await client.query(
      `SELECT to_regclass(format('%I."_knowledge_base_cluster"', $1::text))::oid::text AS oid`,
      [schema],
    );
    const registryOid = registry.rows[0]?.oid;
    if (!registryOid) throw new Error('"_knowledge_base_cluster" does not exist');
    const live = {
      system_identifier: identity.system_identifier,
      timeline: identity.timeline,
      database_oid: databaseOid,
      registry_oid: registryOid,
    };
    const stored = (
      await client.query(
        `SELECT system_identifier, timeline, database_oid::text AS database_oid,
                registry_oid::text AS registry_oid
           FROM ${t.cluster} FOR UPDATE`,
      )
    ).rows[0];
    let held = false;
    const hold = async () => {
      const { rows } = await client.query(holdUpsertSql(schema), ["cluster-changed", HOLD_MS]);
      held = true;
      return iso(rows[0].until);
    };
    const values = [live.system_identifier, live.timeline, live.database_oid, live.registry_oid];
    if (!stored) {
      await client.query(
        `INSERT INTO ${t.cluster} (system_identifier, timeline, database_oid, registry_oid)
         VALUES ($1, $2, $3::oid, $4::oid)`,
        values,
      );
      if (!fresh) {
        const until = await hold();
        log(`deletion scheduling starts on this database; scheduled deletions held until ${until}`);
      }
    } else {
      const changed = ["system_identifier", "timeline", "database_oid", "registry_oid"].filter(
        (field) => String(stored[field] ?? "") !== String(live[field] ?? ""),
      );
      if (changed.length) {
        await client.query(
          `UPDATE ${t.cluster} SET system_identifier = $1, timeline = $2, database_oid = $3::oid,
                  registry_oid = $4::oid, changed_at = now()`,
          values,
        );
        const until = await hold();
        if (changed.includes("registry_oid"))
          log(
            `database was restored from a logical backup (registry table recreated); scheduled deletions held until ${until}`,
          );
        else
          log(
            `database was restored or moved (${changed
              .map((field) => `${field}: ${stored[field] ?? "null"} → ${live[field] ?? "null"}`)
              .join(", ")}); scheduled deletions held until ${until}`,
          );
      }
    }
    await client.query("COMMIT");
    return { skipContracts: false, held };
  } catch (error) {
    await rollbackQuietly(client);
    log(
      `cluster identity check failed (${errorText(error)}); scheduled deletions skipped this run`,
    );
    return { skipContracts: true, held: false };
  }
}

// --- live catalog (§1.3, §1.6) ---------------------------------------------

/**
 * The live schema in the same shape as `catalogFromSql`. Keys use the
 * analyzer's convention for unqualified names (`public.<name>`): Prisma's SQL
 * is unqualified and runs in `schema`.
 *
 * Column defaults come from `pg_get_expr`, which takes an AccessShareLock on
 * each table, so a read with defaults waits behind any ACCESS EXCLUSIVE lock.
 * The pre-deploy gate needs only types and existence (`defaults: false`
 * leaves every `default` undefined and takes no table lock); every read runs
 * in its own transaction with a lock timeout, and `timeoutMs` bounds the
 * whole read: each query's statement timeout is what is left of it.
 * @param {import("pg").Client} client a session not inside a transaction
 * @param {string} schema Prisma's schema (`prismaSchemaName(url)`)
 * @param {{ defaults?: boolean, timeoutMs?: number }} [options]
 */
export async function readLiveCatalog(
  client,
  schema,
  { defaults = true, timeoutMs = 30_000 } = {},
) {
  const end = Date.now() + timeoutMs;
  const query = async (text, params) => {
    const left = Math.max(1, Math.floor(end - Date.now()));
    await client.query(`SET LOCAL statement_timeout = ${left}`);
    return client.query(text, params);
  };
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    const catalog = await readCatalogQueries(query, schema, defaults);
    await client.query("COMMIT");
    return catalog;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function readCatalogQueries(query, schema, defaults) {
  const catalog = emptyCatalog();
  const key = (name) => `public.${name}`;
  const enums = await query(
    `SELECT t.typname::text AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = $1 GROUP BY t.typname`,
    [schema],
  );
  for (const row of enums.rows)
    catalog.enums.set(key(row.name), { schema: "public", name: row.name, labels: row.labels });
  const columns = await query(
    `SELECT c.table_name::text AS table_name, c.column_name::text AS column_name, c.data_type::text AS data_type,
            c.udt_schema::text AS udt_schema, c.udt_name::text AS udt_name,
            c.character_maximum_length, c.numeric_precision, c.numeric_scale, c.datetime_precision,
            c.is_nullable::text AS is_nullable,${defaults ? " c.column_default::text AS column_default," : ""}
            c.is_generated::text AS is_generated
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
    [schema],
  );
  for (const row of columns.rows) {
    const tableKey = key(row.table_name);
    if (!catalog.tables.has(tableKey))
      catalog.tables.set(tableKey, { schema: "public", name: row.table_name, columns: new Map() });
    const type = normalizeType(row);
    const enumName = row.udt_schema === schema ? String(row.udt_name).replace(/^_/, "") : null;
    catalog.tables.get(tableKey).columns.set(row.column_name, {
      name: row.column_name,
      typeText: row.data_type,
      type,
      enum: enumName && catalog.enums.has(key(enumName)) ? key(enumName) : null,
      notNull: row.is_nullable === "NO",
      default: defaults ? (row.column_default ?? null) : undefined,
      generated: row.is_generated === "ALWAYS",
    });
  }
  const indexes = await query(
    `SELECT i.relname::text AS name, t.relname::text AS table_name, x.indisunique AS is_unique,
            coalesce(array(SELECT a.attname::text FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, n)
                           JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.n), '{}') AS columns,
            EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.oid) AS is_constraint
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1`,
    [schema],
  );
  for (const row of indexes.rows)
    catalog.indexes.set(key(row.name), {
      name: row.name,
      table: key(row.table_name),
      columns: row.columns,
      unique: row.is_unique,
      ...(row.is_constraint ? { constraint: true } : {}),
    });
  const constraints = await query(
    `SELECT c.conname::text AS name, t.relname::text AS table_name, c.contype::text AS kind,
            coalesce(array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, n)
                           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.n), '{}') AS columns,
            r.relname::text AS ref, c.confdeltype::text AS on_delete
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_class r ON r.oid = c.confrelid
      WHERE n.nspname = $1 AND c.contype IN ('p', 'u', 'f', 'c')`,
    [schema],
  );
  const kinds = { p: "primary", u: "unique", f: "foreign", c: "check" };
  const actions = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  for (const row of constraints.rows)
    catalog.constraints.set(`${key(row.table_name)}:${row.name}`, {
      name: row.name,
      table: key(row.table_name),
      kind: kinds[row.kind],
      columns: row.columns,
      ...(row.kind === "f" ? { references: key(row.ref), onDelete: actions[row.on_delete] } : {}),
    });
  return catalog;
}

// --- lookups shared by validation, name reuse and late recovery -------------

/** Map a target written with Prisma's schema name onto the analyzer's `public.` keys. */
function canonical(target, schema) {
  const text = String(target);
  return schema && schema !== "public" && text.startsWith(`${schema}.`)
    ? `public.${text.slice(schema.length + 1)}`
    : text;
}

function findColumn(catalog, target) {
  for (const [tableKey, table] of catalog.tables)
    for (const column of table.columns.values())
      if (`${tableKey}.${column.name}` === target) return { tableKey, table, column };
  return null;
}

function hasObject(catalog, kind, target) {
  if (kind === "table") return catalog.tables.has(target);
  if (kind === "column") return findColumn(catalog, target) !== null;
  if (kind === "type") return catalog.enums.has(target);
  if (kind === "index") return catalog.indexes.has(target);
  if (kind === "constraint")
    return [...catalog.constraints.values()].some((c) => `${c.table}.${c.name}` === target);
  return false;
}

// --- validation (§1.14 7c) -------------------------------------------------

/**
 * Validate one due contract (pure). The runner applies the longest valid
 * prefix in folder order.
 * @param {{ migration: { name: string, contract: { sql: string, checksum: string } },
 *   row: { contract_checksum: string | null } | undefined,
 *   live: ReturnType<typeof emptyCatalog>, image: ReturnType<typeof emptyCatalog> | Error | null,
 *   schema?: string }} input
 * @returns {{ ok: true, analysis: ReturnType<typeof analyzeContract> } | { ok: false, finding: string }}
 */
export function validateContract({ migration, row, live, image, schema = "public" }) {
  const fail = (finding) => ({ ok: false, finding: `${migration.name}: ${finding}` });
  if (!row) return fail("this migration has no record in the database");
  if (row.contract_checksum !== migration.contract.checksum)
    return fail(
      "contract.sql differs from the copy recorded when this migration was applied; applied migrations are immutable",
    );
  const analysis = analyzeContract(migration.contract.sql, { folder: migration.name });
  if (analysis.findings.length)
    return fail(
      analysis.findings.map((finding) => `line ${finding.line}: ${finding.message}`).join("; "),
    );
  if (!image || image instanceof Error)
    return fail(
      `the image's schema could not be read${image instanceof Error ? ` (${image.message})` : ""}`,
    );
  for (const drop of analysis.drops) {
    const target = canonical(drop.target, schema);
    if (drop.kind === "column") {
      const found = findColumn(live, target);
      if (!found) return fail(`column ${displayKey(target)} does not exist in the database`);
      if (found.column.notNull && found.column.default === null && !found.column.generated)
        return fail(
          `column ${displayKey(target)} is NOT NULL without a default in the database: the expand step for this removal is missing`,
        );
    }
    if (hasObject(image, drop.kind, target))
      return fail(
        `${drop.kind} ${displayKey(target)} still exists in this image's Prisma schema; deleting it would break this release`,
      );
  }
  const header = analysis.template;
  if (header) {
    const removed = header.pairs.map((pair) => pair.from);
    const mapped = header.pairs.map((pair) => pair.to);
    const enumKey = `public.${header.enumName}`;
    const imageEnum = image.enums.get(enumKey);
    if (!imageEnum)
      return fail(`enum ${displayKey(enumKey)} does not exist in this image's Prisma schema`);
    const stillThere = removed.filter((label) => imageEnum.labels.includes(label));
    if (stillThere.length)
      return fail(
        `this image's Prisma schema still has ${stillThere.map((l) => `${header.enumName}.${l}`).join(", ")}`,
      );
    const missing = mapped.filter((label) => !imageEnum.labels.includes(label));
    if (missing.length)
      return fail(
        `this image's Prisma schema lacks ${missing.map((l) => `${header.enumName}.${l}`).join(", ")}, which existing rows are moved to`,
      );
    for (const column of enumColumns(live, header.enumName)) {
      const named = enumDefaultNamesRemoved(column.default, removed);
      if (named.length)
        return fail(
          `the default of ${displayKey(`${column.table}.${column.column}`)} still names ${named.join(", ")}: the expand step for this removal is missing`,
        );
    }
  }
  return { ok: true, analysis };
}

// --- the due rule (§1.14.1) --------------------------------------------------

/**
 * Does this instance's image contain contract folder `name`? Read from the
 * folder list it registered (`contract_folders`), never from its level: a
 * folder merged out of order sorts below the level of an older release that
 * lacks it. An instance with no list (registered only by its heartbeat)
 * counts as lacking every contract.
 */
export function imageContains(instance, name) {
  return Array.isArray(instance.contract_folders) && instance.contract_folders.includes(name);
}

/** attempts'(R): a newer image level starts a fresh set of tries. */
function effectiveAttempts(row, level) {
  if (!row) return 0;
  const recorded = row.contract_attempt_level;
  if (recorded === null || recorded === undefined || level > recorded) return 0;
  return Number(row.contract_attempts ?? 0);
}

/**
 * Which pending contracts are due (pure, DB clock). Folder order; `due` is
 * the longest prefix whose every entry is due (monotonic in R).
 * @param {{ now: number | Date, fresh: boolean, level: string,
 *   pending: Array<{ name: string, row?: object }>,
 *   instances: Array<{ id?: string, role: string, host?: string | null, schema_level: string | null,
 *     contract_folders: string[] | null, ready_at: Date | number | null, last_seen_at: Date | number }>,
 *   holds: Array<{ reason: string, until: Date | number }>, ignoreAttempts?: boolean }} input
 *   ignoreAttempts: the re-plan inside a contract's own transaction, after
 *   this attempt was already counted (the attempt limit was checked then).
 */
export function planContracts({
  now,
  fresh,
  level,
  pending,
  instances = [],
  holds = [],
  ignoreAttempts = false,
}) {
  const clock = ms(now);
  const activeHolds = holds.filter((hold) => ms(hold.until) > clock);
  const entries = [];
  for (const { name, row } of pending) {
    const attempts = effectiveAttempts(row, level);
    const entry = { name, row, attempts, status: "due" };
    if (!row) entry.status = "unrecorded";
    else if (activeHolds.length) {
      entry.status = "held";
      entry.until = Math.max(...activeHolds.map((hold) => ms(hold.until)));
      entry.reasons = activeHolds.map((hold) => hold.reason).sort();
    } else if (!ignoreAttempts && attempts >= MAX_CONTRACT_ATTEMPTS) entry.status = "needs-person";
    else if (!fresh) {
      const blockers = instances.filter(
        (j) => !imageContains(j, name) && ms(j.last_seen_at) > clock - SOAK_MS,
      );
      const ready = instances
        .filter((i) => imageContains(i, name) && i.ready_at !== null)
        .map((i) => ms(i.ready_at))
        .filter((at) => at !== null);
      if (blockers.length) {
        entry.status = "waiting";
        entry.blockers = blockers;
      } else if (!ready.some((at) => at <= clock - SOAK_MS)) {
        entry.status = "soak";
        entry.until = ready.length ? Math.min(...ready) + SOAK_MS : null;
      }
    }
    entries.push(entry);
  }
  const firstNotDue = entries.findIndex((entry) => entry.status !== "due");
  const due = (firstNotDue < 0 ? entries : entries.slice(0, firstNotDue)).map((e) => e.name);
  return { due, entries };
}

/** Read what `planContracts` needs (inside the caller's transaction, if any). */
export async function readPlanInputs(client, schema, names) {
  const t = tables(schema);
  const [now, rows, instances, holds] = await Promise.all([
    client.query("SELECT now() AS now"),
    client.query(`SELECT * FROM ${t.migration} WHERE name = ANY($1::text[])`, [names]),
    client.query(
      `SELECT id::text AS id, role, host, schema_level, contract_folders, ready_at, last_seen_at
         FROM ${t.instance}`,
    ),
    client.query(`SELECT reason, until FROM ${t.hold}`),
  ]);
  return {
    now: now.rows[0].now,
    rows: new Map(rows.rows.map((row) => [row.name, row])),
    instances: instances.rows,
    holds: holds.rows,
  };
}

/**
 * The schedule log (§1.14 step 8): one line per pending contract.
 * @param {ReturnType<typeof planContracts>} plan
 */
export function scheduleLines(plan) {
  return plan.entries.map(({ name, row, attempts, status, until, reasons, blockers }) => {
    const effects = row?.contract_effects ?? "its scheduled deletions";
    const lastError = row?.contract_last_error ?? null;
    if (status === "unrecorded") return `${name}: not recorded yet; checked on the next start`;
    if (status === "held") return `${name}: held until ${iso(until)} (${reasons.join(", ")})`;
    if (status === "needs-person") {
      const short = /^short-timeout \S+ 3\/3: /.test(lastError ?? "");
      return short
        ? `${name}: needs a person: the database stayed busy while deleting (${effects}); 3 tries ran out of time. A release that adds a migration tries again.`
        : `${name}: needs a person: ${lastError ?? "unknown error"} (3 tries failed; a release that adds a migration tries again)`;
    }
    if (status === "waiting")
      return `${name}: waiting for: ${blockers
        .map(
          (j) =>
            `${j.role}@${j.host ?? "?"} on ${j.schema_level ?? "unknown level"}${
              j.schema_level && j.schema_level >= name ? ", an image without this migration" : ""
            } (last seen ${iso(j.last_seen_at)})`,
        )
        .join(", ")}`;
    if (status === "soak")
      return until === null
        ? `${name}: will delete ${effects} 7 days after a release that contains it is ready`
        : `${name}: will delete ${effects} after ${iso(until)}`;
    const short = SHORT_TIMEOUT_PREFIX.exec(lastError ?? "");
    if (short) return `${name}: retrying (database busy: 57014, ${short[2]}/3)`;
    if (attempts > 0) return `${name}: retrying (attempt ${attempts + 1}/3)`;
    if (lastError)
      return `${name}: retrying (database busy: ${/^([0-9A-Z]{5}):/.exec(lastError)?.[1] ?? "connection"})`;
    return `${name}: will delete ${effects}; continues on the next start`;
  });
}

// --- applying one contract (§1.14 7e) --------------------------------------

/** Statement timeout for one contract statement. */
export function statementTimeoutMs({ template, remainingMs }) {
  if (template) return CONTRACT_STATEMENT_TIMEOUT_MS;
  return Math.max(
    MIN_STATEMENT_TIMEOUT_MS,
    Math.min(CONTRACT_STATEMENT_TIMEOUT_MS, Math.floor(remainingMs)),
  );
}

/** The R5-5 repeat counter: n of the next shortened timeout at `level`. */
function shortTimeout(level, lastError, message) {
  const prefix = SHORT_TIMEOUT_PREFIX.exec(lastError ?? "");
  const n = prefix && prefix[1] === level ? Number(prefix[2]) + 1 : 1;
  return { kind: "short-timeout", n, lastError: `short-timeout ${level} ${n}/3: ${message}` };
}

/**
 * Classify a failed contract statement (§1.14 7e, R5-5, R6-2).
 *   transient      55P03, 40P01, 08*, a connection loss, or a 57014 that came
 *                  before its statement's timeout (an external cancel): the
 *                  attempt is undone; an existing short-timeout prefix is kept.
 *   short-timeout  a 57014 at a shortened timeout, or one that escaped the
 *                  enum template's own handler (its lock waits outside the
 *                  rebuild sub-block): transient twice in a row at one image
 *                  level, then counted as the 3rd attempt.
 *   counted        everything else (a full-15 s timeout on a plain statement).
 * @returns {{ kind: "transient" | "short-timeout" | "counted", n?: number, lastError: string }}
 */
export function classifyFailure({ error, timeoutMs, elapsedMs, template, level, lastError }) {
  const code = sqlState(error);
  const message = errorText(error);
  const prefix = SHORT_TIMEOUT_PREFIX.exec(lastError ?? "");
  const keep = (text) => (prefix ? `${prefix[0]}${text}` : text);
  const connectionLost = !/^[0-9A-Z]{5}$/.test(code);
  if (code === "55P03" || code === "40P01" || code.startsWith("08") || connectionLost)
    return { kind: "transient", lastError: keep(message) };
  if (code === "57014") {
    if (elapsedMs + MIN_STATEMENT_TIMEOUT_MS < timeoutMs)
      return { kind: "transient", lastError: keep(message) };
    if (template || timeoutMs < CONTRACT_STATEMENT_TIMEOUT_MS)
      return shortTimeout(level, lastError, message);
  }
  return { kind: "counted", lastError: message };
}

/** Statements of a contract.sql, each with whether it is the enum template. */
function contractStatements(sql, analysis) {
  return splitStatements(sql).map((statement, index) => ({
    text: statement.text,
    template: index === 0 && analysis.template !== null,
  }));
}

/**
 * Apply one validated contract, tracked (§1.14 7e).
 * @param {import("pg").Client} client a session of its own (notices are captured)
 * @param {{ schema: string, migration: { name: string, contract: { sql: string } },
 *   analysis: ReturnType<typeof analyzeContract>, level: string, deadline: number,
 *   backup: string | null, now?: () => number,
 *   replan: (client: import("pg").Client) => Promise<boolean>,
 *   assertHeld?: (before: string) => void }} options
 * @returns {Promise<{ status: "applied" | "noop" | "not-due" | "not-started" | "transient"
 *   | "short-timeout" | "counted", notes?: string[], error?: string }>}
 */
export async function applyContract(client, options) {
  const { schema, migration, analysis, level, deadline, backup, replan } = options;
  const now = options.now ?? Date.now;
  const t = tables(schema);
  const name = migration.name;
  if (deadline - now() < CONTRACT_START_MIN_MS) return { status: "not-started" };
  options.assertHeld?.(`the scheduled deletion of ${name}`);

  // Attempt accounting, committed on its own: a crash or kill counts.
  await client.query("BEGIN");
  let previous;
  try {
    await client.query(`SET LOCAL lock_timeout = ${CONTRACT_PREAMBLE_TIMEOUT_MS}`);
    await client.query(`SET LOCAL statement_timeout = ${CONTRACT_PREAMBLE_TIMEOUT_MS}`);
    previous = (
      await client.query(
        `SELECT contract_attempts, contract_attempt_level, contract_last_error, contract_applied_at
           FROM ${t.migration} WHERE name = $1 FOR UPDATE`,
        [name],
      )
    ).rows[0];
    if (!previous || previous.contract_applied_at) {
      await client.query("ROLLBACK");
      return { status: "noop" };
    }
    await client.query(
      `UPDATE ${t.migration}
          SET contract_attempts = CASE WHEN contract_attempt_level IS NULL
                                         OR $2 > contract_attempt_level COLLATE "C"
                                       THEN 1 ELSE contract_attempts + 1 END,
              contract_attempt_level = $2
        WHERE name = $1`,
      [name, level],
    );
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
  const undo = (lastError) =>
    client.query(
      `UPDATE ${t.migration} SET contract_attempts = $2, contract_attempt_level = $3,
              contract_last_error = $4 WHERE name = $1`,
      [name, previous.contract_attempts, previous.contract_attempt_level, lastError],
    );

  const notes = [];
  const onNotice = (notice) => {
    const text = String(notice?.message ?? "");
    if (text.startsWith("knowledge-base:")) notes.push(text);
  };
  client.on("notice", onNotice);
  let current = { timeoutMs: CONTRACT_STATEMENT_TIMEOUT_MS, started: now(), template: false };
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query(`SET LOCAL statement_timeout = ${CONTRACT_PREAMBLE_TIMEOUT_MS}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
    const locked = (
      await client.query(
        `SELECT contract_applied_at FROM ${t.migration} WHERE name = $1 FOR UPDATE`,
        [name],
      )
    ).rows[0];
    if (!locked || locked.contract_applied_at) {
      await client.query("ROLLBACK");
      await undo(previous.contract_last_error);
      return { status: "noop" };
    }
    if (!(await replan(client))) {
      await client.query("ROLLBACK");
      await undo(previous.contract_last_error);
      return { status: "not-due" };
    }
    const statements = contractStatements(migration.contract.sql, analysis);
    for (const [index, statement] of statements.entries()) {
      const remainingMs = deadline - now();
      // The enum template needs its whole fixed timeout: never start it with
      // less (the bookkeeping above may have waited on locks).
      if (statement.template && remainingMs < CONTRACT_STATEMENT_TIMEOUT_MS) {
        await client.query("ROLLBACK");
        await undo(previous.contract_last_error);
        return { status: "not-started" };
      }
      // Past the deadline, stop instead of running more 1 s statements. Like a
      // shortened timeout, this is transient twice at one level (R5-5).
      if (!statement.template && remainingMs < MIN_STATEMENT_TIMEOUT_MS) {
        throw Object.assign(
          new Error(
            `the time budget ran out before statement ${index + 1} of ${statements.length}`,
          ),
          { budgetExhausted: true },
        );
      }
      const timeoutMs = statementTimeoutMs({ template: statement.template, remainingMs });
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      current = { timeoutMs, started: now(), template: statement.template };
      await client.query(statement.text);
    }
    const note = notes.length ? notes.join("; ") : null;
    await client.query(`SET LOCAL statement_timeout = ${CONTRACT_PREAMBLE_TIMEOUT_MS}`);
    await client.query(
      `UPDATE ${t.migration} SET contract_applied_at = now(), contract_backup = $2, contract_note = $3,
              contract_last_error = NULL WHERE name = $1`,
      [name, backup, note],
    );
    await client.query("COMMIT");
    return { status: "applied", notes };
  } catch (error) {
    await rollbackQuietly(client);
    const failure = error?.budgetExhausted
      ? shortTimeout(level, previous.contract_last_error, error.message)
      : classifyFailure({
          error,
          timeoutMs: current.timeoutMs,
          elapsedMs: now() - current.started,
          template: current.template,
          level,
          lastError: previous.contract_last_error,
        });
    try {
      if (failure.kind === "transient" || (failure.kind === "short-timeout" && failure.n < 3))
        await undo(failure.lastError);
      else if (failure.kind === "short-timeout")
        await client.query(
          `UPDATE ${t.migration} SET contract_attempts = $2, contract_attempt_level = $3,
                  contract_last_error = $4 WHERE name = $1`,
          [name, MAX_CONTRACT_ATTEMPTS, level, failure.lastError],
        );
      else
        await client.query(`UPDATE ${t.migration} SET contract_last_error = $2 WHERE name = $1`, [
          name,
          failure.lastError,
        ]);
    } catch {
      // The session is gone (connection loss): the attempt stays counted,
      // exactly like a crash. The next start reads the row again.
    }
    const status = failure.kind === "short-timeout" && failure.n >= 3 ? "counted" : failure.kind;
    return { status, error: failure.lastError };
  } finally {
    client.removeListener?.("notice", onNotice);
  }
}

/**
 * Apply every contract.sql, untracked, each in its own transaction with
 * Prisma's schema on the search_path and no timeouts (§1.16). Only for
 * databases nothing has ever served from: `pnpm db:reset:local` and CI
 * scratch databases. Never the production path.
 * @param {import("pg").Client} client
 * @param {Array<{ name: string, contract: { sql: string } | null }>} migrations folder order
 * @param {{ schema: string }} options
 * @returns {Promise<string[]>} the folders whose contract ran
 */
export async function applyAllContracts(client, migrations, { schema }) {
  const done = [];
  for (const migration of migrations) {
    if (!migration.contract) continue;
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
      await client.query(migration.contract.sql);
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw new Error(`contract.sql of ${migration.name} failed: ${errorText(error)}`);
    }
    done.push(migration.name);
  }
  return done;
}

// --- pre-deploy checks (§1.7, §1.8) ----------------------------------------

/**
 * Name-reuse matches (from `findNameReuse`) that block this deploy: on a
 * fresh database every match; otherwise those whose dropped object still
 * exists in the live database (the deletion has not run yet).
 * @param {Array<{ key: string, folder: string, line: number, droppedBy: string }>} matches
 * @param {{ toApply: string[], fresh: boolean, live: ReturnType<typeof emptyCatalog> | null, schema?: string }} options
 */
export function nameReuseLive(matches, { toApply, fresh, live, schema = "public" }) {
  const pending = new Set(toApply);
  return matches.filter((match) => {
    if (!pending.has(match.folder)) return false;
    if (fresh || !live) return true;
    const [kind, ...rest] = match.key.split(":");
    const target = canonical(rest.join(":"), schema);
    if (kind === "label") {
      const [enumKey, label] = [
        target.slice(0, target.lastIndexOf(":")),
        target.slice(target.lastIndexOf(":") + 1),
      ];
      return live.enums.get(enumKey)?.labels.includes(label) ?? false;
    }
    return hasObject(live, kind, target);
  });
}

/**
 * Pending recover blocks whose source column a contract already deleted
 * (§1.8): the runner logs them loudly and proceeds.
 * @param {Array<{ name: string, templates: Array<{ kind: string, header: any }> }>} pendingAnalyses
 * @param {{ live: ReturnType<typeof emptyCatalog>, applied: Array<{ name: string,
 *   contract_applied_at: Date | null, contract_backup: string | null, droppedColumns: Set<string> }>, schema?: string }} options
 */
export function lateRecoveries(pendingAnalyses, { live, applied, schema = "public" }) {
  const out = [];
  for (const migration of pendingAnalyses)
    for (const template of migration.templates) {
      if (template.kind !== "recover") continue;
      const target = canonical(`public.${template.header.table}.${template.header.from}`, schema);
      if (findColumn(live, target)) continue;
      const by = applied.find((row) => row.contract_applied_at && row.droppedColumns.has(target));
      out.push({
        folder: migration.name,
        column: displayKey(target),
        deletedAt: by ? iso(by.contract_applied_at) : null,
        backup: by?.contract_backup ?? null,
      });
    }
  return out;
}

/**
 * W2 offline-restore interface (ALL helpers use the caller's existing session).
 * captureMigrationHistory(client, {schema, migrations}) -> snapshot metadata.
 * validateMigrationHistory(history, migrations) -> throws on invalid history.
 * finalizeRestoreState(client, {schema, holdMs = SOAK_MS}) -> hold-until Date.
 *
 * The snapshot caller owns DADP -> Prisma exclusion and its exported snapshot;
 * the restore caller owns runner -> request -> maintenance -> DADP -> Prisma
 * exclusion and its final transaction. These helpers never connect, BEGIN,
 * COMMIT, acquire locks, or invoke another runner. Finalize and KB READY must
 * commit together. Do not infer that shipped-but-unapplied migrations ran.
 */
export async function captureMigrationHistory(client, { schema, migrations }) {
  const history = (
    await client.query(
      `SELECT migration_name AS name, checksum, finished_at, rolled_back_at FROM ${quoteIdent(schema)}._prisma_migrations ORDER BY migration_name, started_at`,
    )
  ).rows;
  if (history.some((row) => !row.finished_at && !row.rolled_back_at))
    throw new Error("Cannot capture unfinished migration history.");
  const result = {
    version: 1,
    schema,
    migrations: migrations.map((m) => ({
      name: m.name,
      checksum: m.checksum,
      contractChecksum: m.contract?.checksum ?? null,
    })),
    applied: history
      .filter((r) => r.finished_at && !r.rolled_back_at)
      .map(({ name, checksum }) => ({ name, checksum })),
    contracts: (await runtimeTablesExist(client, schema))
      ? (await client.query(`SELECT * FROM ${tables(schema).migration} ORDER BY name`)).rows
      : [],
  };
  validateMigrationHistory(result, migrations);
  return result;
}

/** Pure archive validation, including applied-set membership and contract checksums. */
export function validateMigrationHistory(history, migrations) {
  if (
    history?.version !== 1 ||
    !Array.isArray(history.applied) ||
    !Array.isArray(history.migrations) ||
    !Array.isArray(history.contracts)
  )
    throw new Error("Invalid snapshot migration history.");
  const local = new Map(migrations.map((m) => [m.name, m]));
  if (
    history.migrations.length !== migrations.length ||
    history.migrations.some(
      (m, i) =>
        m.name !== migrations[i].name ||
        m.checksum !== migrations[i].checksum ||
        m.contractChecksum !== (migrations[i].contract?.checksum ?? null),
    )
  )
    throw new Error("Snapshot migration files/checksums differ from the shipped archive files.");
  const applied = new Set();
  for (const row of history.applied) {
    if (
      applied.has(row.name) ||
      !local.has(row.name) ||
      row.checksum !== local.get(row.name).checksum
    )
      throw new Error(
        "Snapshot applied migrations are not a unique matching subset of shipped migration files.",
      );
    applied.add(row.name);
  }
  const seen = new Set();
  for (const row of history.contracts) {
    const m = local.get(row.name);
    if (
      seen.has(row.name) ||
      !applied.has(row.name) ||
      !m ||
      row.contract_checksum !== (m.contract?.checksum ?? null) ||
      (row.contract_applied_at && !m.contract)
    )
      throw new Error("Snapshot contract state does not match applied migration files.");
    seen.add(row.name);
  }
  if (history.applied.some((row) => local.get(row.name)?.contract && !seen.has(row.name)))
    throw new Error("Snapshot lacks contract execution state for an applied migration.");
}

/** Preserve longer holds and invalidate every imported live instance in the final restore transaction. */
export async function finalizeRestoreState(client, { schema, holdMs = SOAK_MS }) {
  if (!Number.isSafeInteger(holdMs) || holdMs < SOAK_MS)
    throw new Error("Restore deletion hold must be at least seven days.");
  await ensureRuntimeTables(client, schema);
  const result = await client.query(holdUpsertSql(schema), ["restore", holdMs]);
  await client.query(`DELETE FROM ${tables(schema).instance} WHERE id IS NOT NULL`);
  return result.rows[0].until;
}
