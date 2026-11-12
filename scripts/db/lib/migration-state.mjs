/**
 * Classify a database's Prisma Migrate state against a migrations folder.
 *
 * Deliberately does NOT trust `prisma migrate status`'s exit code (it exits 1
 * for several unrelated states). It reads `_prisma_migrations` directly with
 * `pg` and compares it with the folder shipped next to this code.
 *
 * States (shared vocabulary — docs/schema-migrations.md uses the same):
 *   up-to-date           every folder migration is applied, nothing extra
 *   pending              some folder migrations are not applied yet
 *   db-ahead             the database has applied migrations this folder
 *                        does not contain (stale image / rollback)
 *   failed               a migration is recorded as started but never
 *                        finished nor rolled back (`inProgress` when Prisma's
 *                        advisory lock is currently held by another session)
 *   no-history-nonempty  no `_prisma_migrations` table, but the schema already
 *                        holds tables (a database Prisma Migrate never managed)
 *   unreachable          cannot connect / query
 *
 * Every state also reports `runnerActive`: some session holds the migration
 * runner lock (MIGRATION_RUNNER_LOCK_KEY), i.e. a `migrate-runtime.mjs apply`
 * (or a restore) is working on this database right now. The reading session
 * never holds it itself, so a runner that reads the state while holding the
 * lock sees its own lock here.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACT_FILE } from "./sql.mjs";

/** Prisma's migrate advisory lock key (verified against Prisma 7 pg_locks). */
export const PRISMA_ADVISORY_LOCK = 72707369;
/**
 * Session advisory lock held by `migrate-runtime.mjs apply` for its whole
 * classify → recover → backup → deploy → final check, so two leaders (Dokploy
 * app + worker) never interleave. Prisma's own lock covers only `migrate
 * deploy` itself. restore.mjs takes this lock too.
 */
export const MIGRATION_RUNNER_LOCK_KEY = 72707370;

/**
 * Is a single-key (bigint) session advisory lock granted to any session in the
 * current database? For keys below 2^32: classid 0, objid = key, objsubid 1.
 */
const ADVISORY_HELD_SQL = `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_locks
          WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND objsubid = 1 AND granted
            AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
       ) AS held`;

/**
 * `contract` is the folder's optional `contract.sql` (applied by the runner
 * after the soak; Prisma never reads it), or null.
 * @returns {Array<{ name: string, file: string, sql: string, checksum: string,
 *   contract: { sql: string, checksum: string } | null }>} sorted like Prisma
 */
export function readMigrationsFolder(dir) {
  if (!existsSync(dir)) return [];
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "migration.sql")),
    )
    .map((entry) => {
      const file = path.join(dir, entry.name, "migration.sql");
      const bytes = readFileSync(file);
      const contractFile = path.join(dir, entry.name, CONTRACT_FILE);
      const contractBytes = existsSync(contractFile) ? readFileSync(contractFile) : null;
      return {
        name: entry.name,
        file,
        sql: bytes.toString("utf8"),
        checksum: sha256(bytes),
        contract: contractBytes
          ? { sql: contractBytes.toString("utf8"), checksum: sha256(contractBytes) }
          : null,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Postgres schema Prisma uses for this URL (`?schema=`, default public). */
export function prismaSchemaName(url) {
  try {
    return new URL(url).searchParams.get("schema") || "public";
  } catch {
    return "public";
  }
}

/** Strip Prisma-only URL params that `pg` would misread. */
export function pgConnectionString(url) {
  const parsed = new URL(url);
  for (const key of [
    "schema",
    "connection_limit",
    "pool_timeout",
    "pgbouncer",
    "statement_cache_size",
  ])
    parsed.searchParams.delete(key);
  return parsed.toString();
}

/**
 * @param {{ databaseUrl: string, migrationsDir: string, pg: typeof import("pg"),
 *   connectTimeoutMs?: number, client?: import("pg").Client }} options
 */
export async function readMigrationState({
  databaseUrl,
  migrationsDir,
  pg,
  connectTimeoutMs = 10_000,
  client: existingClient,
}) {
  const local = readMigrationsFolder(migrationsDir);
  const base = {
    local: local.map((m) => m.name),
    applied: /** @type {string[]} */ ([]),
    pending: /** @type {string[]} */ ([]),
    ahead: /** @type {string[]} */ ([]),
    failed:
      /** @type {Array<{ name: string, logs: string | null, checksum: string | null }>} */ ([]),
    checksumMismatch: /** @type {string[]} */ ([]),
    inProgress: false,
    runnerActive: false,
    error: /** @type {string | null} */ (null),
  };
  const schema = prismaSchemaName(databaseUrl);
  const client =
    existingClient ??
    new pg.Client({
      connectionString: pgConnectionString(databaseUrl),
      connectionTimeoutMillis: connectTimeoutMs,
      application_name: "knowledge-base-migrate-state",
    });
  try {
    if (!existingClient) await client.connect();
  } catch (error) {
    if (!existingClient) await client.end().catch(() => {});
    // Never echo the driver error object: it can carry connection parameters.
    return { ...base, state: "unreachable", error: safeError(error) };
  }
  try {
    await assertNoPendingRestore(client);
    const runner = await client.query(ADVISORY_HELD_SQL, [MIGRATION_RUNNER_LOCK_KEY]);
    base.runnerActive = Boolean(runner.rows[0].held);
    const table = await client.query(
      "SELECT to_regclass(format('%I._prisma_migrations', $1::text)) AS t",
      [schema],
    );
    if (!table.rows[0].t) {
      if (!(await isManagedSchemaEmpty(client, schema)))
        return { ...base, state: "no-history-nonempty" };
      return {
        ...base,
        pending: base.local,
        state: base.local.length ? "pending" : "up-to-date",
      };
    }
    const rows = (
      await client.query(
        `SELECT migration_name, checksum, finished_at, rolled_back_at, logs
           FROM ${client.escapeIdentifier(schema)}._prisma_migrations
          ORDER BY started_at, migration_name`,
      )
    ).rows;
    const lock = await client.query(ADVISORY_HELD_SQL, [PRISMA_ADVISORY_LOCK]);
    return classify(base, local, rows, lock.rows[0].held);
  } catch (error) {
    return {
      ...base,
      state: error.code === "KB_RESTORE_PENDING" ? "restore-pending" : "unreachable",
      error: safeError(error),
    };
  } finally {
    if (!existingClient) await client.end().catch(() => {});
  }
}

/** Pure classification, exported for unit tests. */
export function classify(base, local, rows, lockHeld) {
  const localNames = new Set(local.map((m) => m.name));
  const byName = new Map(local.map((m) => [m.name, m]));
  const applied = new Set();
  const failed = [];
  const mismatch = [];
  for (const row of rows) {
    if (row.rolled_back_at) continue;
    if (row.finished_at) {
      applied.add(row.migration_name);
      const file = byName.get(row.migration_name);
      if (file && file.checksum !== row.checksum) mismatch.push(row.migration_name);
    } else
      failed.push({
        name: row.migration_name,
        logs: row.logs ?? null,
        checksum: row.checksum ?? null,
      });
  }
  // A failure that was later re-run successfully is history, not a failure.
  const openFailures = failed.filter((f) => !applied.has(f.name));
  const ahead = [...applied, ...openFailures.map((f) => f.name)].filter(
    (name) => !localNames.has(name),
  );
  const pending = local
    .map((m) => m.name)
    .filter((name) => !applied.has(name) && !openFailures.some((f) => f.name === name));
  const result = {
    ...base,
    applied: [...applied],
    pending,
    ahead: [...new Set(ahead)],
    failed: openFailures,
    checksumMismatch: mismatch,
    inProgress: Boolean(lockHeld),
  };
  if (result.ahead.length) return { ...result, state: "db-ahead" };
  if (openFailures.length) return { ...result, state: "failed" };
  if (pending.length) return { ...result, state: "pending" };
  return { ...result, state: "up-to-date" };
}

export function safeError(error) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  // Keep the class of failure, never a URL.
  return `${code ? `${code}: ` : ""}${message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>")}`;
}

/** KB snapshot/restore exclusion. Never hold this lock while calling a backup hook. */
export const KB_DDL_LOCK_KEY = 1145389648;

/** Existing-client admission gate; READY is the only completed restore state. */
export async function assertNoPendingRestore(client) {
  const table = await client.query(
    "SELECT to_regclass('knowledge_base_control.kb_restore') AS restore_table",
  );
  if (!table.rows[0]?.restore_table) return;
  const pending = await client.query(
    "SELECT 1 FROM knowledge_base_control.kb_restore WHERE state IS DISTINCT FROM 'READY' LIMIT 1",
  );
  if (pending.rows.length)
    throw Object.assign(
      new Error(
        "A KB restore is pending; finish the same offline restore attempt before starting migrations or registering an instance.",
      ),
      { code: "KB_RESTORE_PENDING" },
    );
}

/**
 * Prove application-catalog emptiness even when an empty/rolled-back history
 * table exists. Ignore ONLY exact runner tables and their attached indexes /
 * composite types, and extension-owned objects (e.g. pg_trgm). Caller holds
 * DADP then Prisma exclusion on this existing client; never use app_setting as
 * a proxy for emptiness.
 */
export async function isManagedSchemaEmpty(client, schema) {
  const owned = [
    "_prisma_migrations",
    "_knowledge_base_migration",
    "_knowledge_base_instance",
    "_knowledge_base_hold",
    "_knowledge_base_cluster",
  ];
  const { rows } = await client.query(
    `
    WITH owned AS (SELECT c.oid, c.reltype FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND c.relkind='r'),
    unexpected AS (
      SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.oid NOT IN (SELECT oid FROM owned)
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_index i WHERE i.indexrelid=c.oid AND i.indrelid IN (SELECT oid FROM owned))
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      UNION ALL
      SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      UNION ALL
      SELECT t.oid FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=$1 AND t.oid NOT IN (SELECT reltype FROM owned)
        AND t.typelem NOT IN (SELECT reltype FROM owned)
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
        AND NOT EXISTS (SELECT FROM pg_catalog.pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.typelem AND d.deptype='e')
    ) SELECT EXISTS (SELECT FROM unexpected) AS occupied`,
    [schema, owned],
  );
  return rows[0]?.occupied === false;
}

/**
 * Stable application-catalog signature for locked revalidation and CI's two
 * replay orders. OIDs/runner bookkeeping are excluded by exact object identity;
 * constraints, triggers, function bodies, privileges and partial indexes remain.
 */
export async function readApplicationCatalog(client, schema) {
  const owned = [
    "_prisma_migrations",
    "_knowledge_base_migration",
    "_knowledge_base_instance",
    "_knowledge_base_hold",
    "_knowledge_base_cluster",
  ];
  const { rows } = await client.query(
    `
    WITH app AS (SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND NOT c.relname=ANY($2::text[]) AND c.relkind IN ('r','p','v','m','S')),
    objects AS (
      SELECT 'column' AS kind, c.relname || '.' || a.attname AS identity,
        jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
          pg_get_expr(d.adbin,d.adrelid))::text AS definition
        FROM app c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      UNION ALL
      SELECT 'constraint',c.relname||'.'||x.conname,pg_get_constraintdef(x.oid,true)
        FROM app c JOIN pg_catalog.pg_constraint x ON x.conrelid=c.oid
      UNION ALL
      SELECT 'index',i.relname,pg_get_indexdef(i.oid)
        FROM app c JOIN pg_catalog.pg_index x ON x.indrelid=c.oid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
      UNION ALL
      SELECT 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid,true)||':'||t.tgenabled::text
        FROM app c JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND NOT t.tgisinternal
      UNION ALL
      SELECT 'function',p.oid::regprocedure::text,pg_get_functiondef(p.oid)
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$1 AND p.prokind IN ('f','p') AND NOT EXISTS
          (SELECT FROM pg_catalog.pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      UNION ALL
      SELECT 'enum',t.typname,jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)::text
        FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
        JOIN pg_catalog.pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=$1 GROUP BY t.typname
      UNION ALL
      SELECT 'relation',c.relname,jsonb_build_array(c.relkind,c.relacl,CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END)::text FROM app c
      UNION ALL
      SELECT 'schema',nspname,coalesce(nspacl::text,'') FROM pg_catalog.pg_namespace WHERE nspname=$1
    ) SELECT kind,identity,definition FROM objects ORDER BY kind,identity,definition`,
    [schema, owned],
  );
  return rows;
}
