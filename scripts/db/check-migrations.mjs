#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * `pnpm db:check-migrations --base <git-ref>` — PR checks for migrations.
 *
 * Needs CHECK_DATABASE_URL: a superuser URL to a DISPOSABLE Postgres (CI
 * service container). It creates and removes its own `knowledge_base_check_*`
 * scratch databases there and touches nothing else.
 *
 * A migration folder holds migration.sql (applied at deploy) and, when
 * something is deleted, contract.sql (applied by the deploy runner about 7
 * days later, once no older release is running; docs/schema-migrations.md,
 * expand and contract). Scratch databases get every contract.sql at once
 * (scripts/db/lib/contracts.mjs applyAllContracts), like a fresh database.
 *
 * Blocking:
 *   1. Consistency   two ways to reach the schema, both on real Postgres:
 *                    A. every migration, then every contract (each validated
 *                       first the way the deploy runner validates it);
 *                    B. the base's migrations and contracts, then the PR's.
 *                    Both must reproduce the Prisma schema; the only residue
 *                    allowed is an enum value a contract kept on purpose
 *                    (`knowledge-base:label-kept`, classifyEnumRebuild).
 *   2. Ordering      every migration folder added vs <base> sorts after <base>'s
 *                    latest, and no two folders share a timestamp
 *   3. Immutability  no migration folder on <base> is modified, renamed, or
 *                    deleted, and no file (e.g. contract.sql) is added to one
 *   4. Applies with data
 *                    base migrations + fixtures (packages/db/prisma/fixtures/<m>.sql
 *                    loaded right after <m>), base contracts, then the new
 *                    migrations and their contracts; rows and values survive
 *                    except what the new SQL deletes; every fixtures/*.check.sql
 *                    returns no rows
 *   5. Safe for the running release
 *                    in each new migration.sql: nothing the running release
 *                    cannot work with (a drop, rename or in-place type change),
 *                    no SQL the analyzer cannot read unless it carries
 *                    `-- knowledge-base:reviewed <reason>`, generated templates intact
 *                    and of a known version, an intact transactional wrapper;
 *                    contract.sql only plain deletions (+ the enum template,
 *                    first); no reuse of a deleted name; no drop + add that
 *                    looks like a rename; never the retired
 *                    `-- requires: maintenance-deploy` marker. There is no
 *                    override: the deploy runner refuses the same things.
 * Report-only: per migration, in plain English, what changes now, what is
 * deleted later, what was reviewed by hand, and whether a rollback works.
 *
 * Output: markdown to $GITHUB_STEP_SUMMARY when set, else stdout. Exit 1 on
 * any blocking failure.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAllContracts,
  describeEffects,
  readLiveCatalog,
  validateContract,
} from "./lib/contracts.mjs";
import {
  ENUM_KEPT_CAVEAT,
  filterDiff,
  keptLabelsFromNotices,
  retiredColumnTypes,
} from "./lib/diff-source.mjs";
import { git, migrationFoldersAt } from "./lib/local.mjs";
import { withDatabase } from "./lib/local-db-name.mjs";
import {
  pgConnectionString,
  readApplicationCatalog,
  readMigrationsFolder,
} from "./lib/migration-state.mjs";
import {
  FIXTURES_DIR,
  loadPg,
  MIGRATIONS_DIR,
  prisma,
  ROOT,
  SCHEMA_DIR,
  tempConfig,
} from "./lib/prisma.mjs";
import { adminClient, createDatabase, removeDatabase } from "./lib/scratch-db.mjs";
import {
  analyzeContract,
  analyzeMigration,
  CONTRACT_FILE,
  catalogFromSql,
  checkWrapper,
  enumColumns,
  enumDefaultNamesRemoved,
  findNameReuse,
  RETIRED_MAINTENANCE_MARKER,
  REVIEWED_MARKER,
  rollbackSafety,
  summarizeEffects,
  typeOfFromCatalog,
} from "./lib/sql.mjs";

const MIGRATIONS_REL = "packages/db/prisma/migrations";
const NAME_RE = /^(0_init|\d{14}_[a-z0-9_]{1,60})$/;

const gitBlobSha = (bytes) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");

/** Identify catalog differences; only each replay's own kept-label notices excuse extra labels. */
export function compareApplicationCatalogs(a, b, { keptA = new Map(), keptB = new Map() } = {}) {
  const key = (row) => JSON.stringify([row.kind, row.identity]);
  const left = new Map(a.map((row) => [key(row), row]));
  const right = new Map(b.map((row) => [key(row), row]));
  const differences = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const x = left.get(id);
    const y = right.get(id);
    if (x && y && x.definition === y.definition) continue;
    if (x && y && x.kind === "enum") {
      // JSON preserves label boundaries (labels may contain commas) and sort order.
      const labelsA = JSON.parse(x.definition);
      const labelsB = JSON.parse(y.definition);
      const remainingA = labelsA.filter(
        (label) => labelsB.includes(label) || !keptA.get(x.identity)?.includes(label),
      );
      const remainingB = labelsB.filter(
        (label) => labelsA.includes(label) || !keptB.get(y.identity)?.includes(label),
      );
      if (JSON.stringify(remainingA) === JSON.stringify(remainingB)) continue;
    }
    const row = x ?? y;
    differences.push(
      `${row.kind} ${JSON.stringify(row.identity)}: ${!x ? "only in B" : !y ? "only in A" : "definition differs"}${row.kind === "enum" && x && y ? ` (A: ${JSON.stringify(x.definition)}; B: ${JSON.stringify(y.definition)})` : ""}`,
    );
  }
  return differences;
}

/** @typedef {{ id: string, title: string, status: "pass" | "fail" | "skip", details: string[] }} Check */

/** Checks 2 and 3: pure functions over folder listings (exported for tests). */
export function checkOrdering(baseFolders, headFolders) {
  const base = new Set(baseFolders);
  const latest = [...baseFolders].sort().at(-1);
  const added = headFolders.filter((name) => !base.has(name)).sort();
  const details = [];
  for (const name of added) {
    if (!NAME_RE.test(name))
      details.push(
        `\`${name}\`: folder name must be \`<YYYYMMDDHHMMSS>_<snake_case>\` (use \`pnpm db:migrate <name>\`).`,
      );
    if (latest && name <= latest) {
      details.push(
        `\`${name}\` sorts before the base branch's latest migration \`${latest}\`. Run \`pnpm db:migrate:rebase\`.`,
      );
    }
    const prefix = /^\d{14}_/.exec(name)?.[0];
    const twin = prefix && headFolders.find((other) => other !== name && other.startsWith(prefix));
    if (twin)
      details.push(
        `\`${name}\` and \`${twin}\` share the timestamp ${prefix.slice(0, -1)}; their order is ambiguous. Run \`pnpm db:migrate:rebase\`.`,
      );
  }
  return { added, details };
}

/** @param {Array<{ path: string, sha: string }>} baseFiles @param {(rel: string) => Buffer | null} readHead */
export function checkImmutability(baseFiles, headFilesByFolder, readHead) {
  const details = [];
  const baseFolders = new Set();
  const basePaths = new Set(baseFiles.map((f) => f.path));
  for (const file of baseFiles) {
    const folder = file.path.split("/")[0];
    if (file.path.includes("/")) baseFolders.add(folder);
    const bytes = readHead(file.path);
    if (bytes === null)
      details.push(`\`${file.path}\` exists on the base branch but was deleted or renamed.`);
    else if (gitBlobSha(bytes) !== file.sha)
      details.push(
        `\`${file.path}\` was modified. Applied migrations are immutable: write a new migration instead.`,
      );
  }
  for (const folder of baseFolders) {
    for (const rel of headFilesByFolder(folder)) {
      if (!basePaths.has(rel))
        details.push(`\`${rel}\` was added inside an existing migration folder.`);
    }
  }
  return details;
}

function baseMigrationFiles(ref) {
  const out = git(["ls-tree", "-r", ref, "--", MIGRATIONS_REL]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      return { sha: meta.split(" ")[2], path: file.slice(MIGRATIONS_REL.length + 1) };
    });
}

function listFolderFiles(folder) {
  const dir = path.join(MIGRATIONS_DIR, folder);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, folder);
  return out;
}

export function exportBaseMigrations(ref, dest) {
  mkdirSync(dest, { recursive: true });
  // A first migration PR has no migrations path on its base. Empty history
  // still runs every consistency/data check; it is not a skipped check.
  if (baseMigrationFiles(ref).length === 0) return;
  const archive = spawnSync("git", ["archive", "--format=tar", ref, MIGRATIONS_REL], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  });
  if (archive.status !== 0) {
    if (/did not match any files/.test(String(archive.stderr))) return;
    throw new Error(`git archive ${ref} failed`);
  }
  const untar = spawnSync("tar", ["-x", "-C", dest, "--strip-components=4"], {
    input: archive.stdout,
  });
  if (untar.status !== 0) throw new Error("tar extract of base migrations failed");
}

/** Copy the first `count` folders (by name) of `allDir` into a new migrations dir. */
function stepDir(root, allDir, folders, label) {
  const dir = path.join(root, `step-${label}`);
  mkdirSync(dir, { recursive: true });
  for (const name of folders)
    cpSync(path.join(allDir, name), path.join(dir, name), { recursive: true });
  const lock = path.join(MIGRATIONS_DIR, "migration_lock.toml");
  if (existsSync(lock)) cpSync(lock, path.join(dir, "migration_lock.toml"));
  return dir;
}

async function deployTo(url, migrations) {
  const config = tempConfig({ url, migrations });
  const result = await prisma(["migrate", "deploy", "--config", config], { capture: true });
  rmSync(path.dirname(config), { recursive: true, force: true });
  return result;
}

const tail = (text, lines = 25) => text.trim().split("\n").slice(-lines).join("\n");

async function snapshot(client) {
  const tables = (
    await client.query(
      `SELECT c.relname AS name,
              COALESCE((SELECT array_agg(a.attname::text ORDER BY a.attnum)
                          FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                         WHERE i.indrelid = c.oid AND i.indisprimary), '{}'::text[]) AS pk
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'`,
    )
  ).rows;
  const result = new Map();
  for (const table of tables) {
    const rows = (
      await client.query(`SELECT to_jsonb(t) AS row FROM ${client.escapeIdentifier(table.name)} t`)
    ).rows.map((r) => r.row);
    result.set(`public.${table.name}`, { pk: table.pk, rows });
  }
  return result;
}

/** Compare the pre-PR snapshot with the final DB (exported for tests). */
export function compareSnapshots(before, after, effects) {
  const failures = [];
  const warnings = [];
  for (const [table, { pk, rows }] of before) {
    if (!rows.length || effects.droppedTables.has(table)) continue;
    const target = effects.tableRenames.get(table) ?? table;
    const now = after.get(target);
    const label = `\`${table.replace(/^public\./, "")}\``;
    if (!now) {
      failures.push(
        `table ${label} with ${rows.length} fixture row(s) is gone, but no migration drops or renames it.`,
      );
      continue;
    }
    if (effects.rowsRemoved.has(table)) continue;
    const column = (name) => effects.columnRenames.get(`${table}.${name}`) ?? name;
    const key = (row, map) => JSON.stringify(pk.map((name) => row[map ? column(name) : name]));
    if (!pk.length) {
      if (now.rows.length < rows.length)
        failures.push(`${label}: ${rows.length} row(s) before, ${now.rows.length} after.`);
      continue;
    }
    const index = new Map(
      now.rows.map((row) => [JSON.stringify(now.pk.map((name) => row[name])), row]),
    );
    for (const row of rows) {
      const match = index.get(key(row, true));
      if (!match) {
        failures.push(`${label}: row ${key(row, false)} disappeared.`);
        continue;
      }
      for (const [name, value] of Object.entries(row)) {
        const colKey = `${table}.${name}`;
        if (
          effects.droppedColumns.has(colKey) ||
          effects.updatedColumns.has(`${target}.${column(name)}`)
        )
          continue;
        if (effects.updatedColumns.has(colKey)) continue;
        const renamed = column(name);
        if (!(renamed in match)) {
          failures.push(
            `${label}: column \`${name}\` is gone but no migration drops or renames it.`,
          );
          continue;
        }
        if (JSON.stringify(match[renamed]) === JSON.stringify(value)) continue;
        const message = `${label} row ${key(row, false)}: \`${name}\`${renamed !== name ? ` (now \`${renamed}\`)` : ""} changed from ${JSON.stringify(value)} to ${JSON.stringify(match[renamed])}.`;
        if (effects.typeChanged.has(colKey)) warnings.push(`${message} (type change)`);
        else failures.push(message);
      }
    }
  }
  return { failures: [...new Set(failures)], warnings };
}

function mergeEffects(list) {
  const merged = summarizeEffects("");
  for (const effects of list) {
    for (const key of Object.keys(merged)) {
      if (merged[key] instanceof Map) for (const [k, v] of effects[key]) merged[key].set(k, v);
      else if (merged[key] instanceof Set) for (const v of effects[key]) merged[key].add(v);
      else merged[key] = merged[key] || effects[key];
    }
  }
  return merged;
}
const knownTablesOf = (catalog) =>
  new Map([...catalog.tables].map(([key, table]) => [key, new Set(table.columns.keys())]));

/** The catalog fold the runner's recordApplied uses: migration.sql, then contract.sql, per folder. */
const folderFiles = (migration) =>
  migration.contract ? [migration.sql, migration.contract.sql] : [migration.sql];

const sameHeader = (a, b) =>
  JSON.stringify([a.enumName, a.pairs, a.columns]) ===
  JSON.stringify([b.enumName, b.pairs, b.columns]);

const NOT_ANALYZED_HINT = `fails unless the line above the statement is \`${REVIEWED_MARKER} <reason>\` (an attestation that the running release is unaffected; never annotate to silence a failure you have not understood)`;

/**
 * Check 5 and the report for one added folder (pure; exported for tests).
 * @param {{ name: string, sql: string, contract: { sql: string } | null }} migration
 * @param {{ catalog: ReturnType<typeof catalogFromSql>,
 *   retired: Map<string, any> }} context catalog: before this folder (base,
 *   then the earlier folders of this PR); retired: columns deleted by a
 *   contract.sql of an earlier folder (base or this PR) → type.
 */
export function checkFolder(migration, { catalog, retired, initial = false }) {
  const { name } = migration;
  const rel = `${MIGRATIONS_REL}/${name}/migration.sql`;
  const crel = `${MIGRATIONS_REL}/${name}/${CONTRACT_FILE}`;
  const failures = [];
  const fail = (text) => failures.push(text);
  // With no base history, 0_init has no running release to break. Preserve
  // wrapper/retired-marker checks; the full SQL must still apply successfully
  // in BOTH replay orders and pass fixtures. Every later folder uses the
  // ordinary no-in-place-breaking policy.
  const firstInstall =
    initial && name === "0_init" && catalog.tables.size === 0 && catalog.enums.size === 0;
  const analysis = analyzeMigration(migration.sql, {
    folder: name,
    knownTables: knownTablesOf(catalog),
    typeOf: typeOfFromCatalog(catalog),
  });
  if (analysis.markers.retiredMaintenance)
    fail(
      `\`${rel}\`: \`${RETIRED_MAINTENANCE_MARKER}\` is retired; there is no maintenance deploy any more and the deploy runner refuses any file that carries it. Remove the marker and split the change with expand/contract: a deletion: re-run \`pnpm db:migrate\` (it schedules the deletion in ${CONTRACT_FILE}); a rename: @map / @@map; a type change: the two-PR recipe (docs/schema-changes-recipe.md, Recipe 5).`,
    );
  if (analysis.markers.transactional) {
    const wrapper = checkWrapper(migration.sql);
    if (!wrapper.ok)
      fail(`\`${rel}\`: marked transactional but the wrapper is broken (${wrapper.reason}).`);
  }
  for (const item of analysis.incompatible)
    if (!firstInstall)
      fail(
        `\`${rel}\` line ${item.line}: ${item.what}, and the release that is still running breaks. A deletion: delete this folder and re-run \`pnpm db:migrate\` (it schedules the deletion for after the old release is gone); a rename: keep the database name with @map / @@map; a type change: the two-PR recipe (docs/schema-changes-recipe.md, Recipe 5); anything else: stop and ask the owner.`,
      );
  for (const item of analysis.notAnalyzed) {
    if (item.reviewed !== null || firstInstall) continue;
    const unknown = /^template (v\d+) not known/.exec(item.reason);
    if (unknown)
      fail(
        `\`${rel}\` line ${item.line}: template ${unknown[1]} not known; regenerate with \`pnpm db:migrate\`.`,
      );
    else if (item.template) fail(`\`${rel}\` line ${item.line}: ${item.reason}.`);
    else
      fail(
        `\`${rel}\` line ${item.line}: not analyzed (${item.reason})${item.reviewIgnored ? `; the \`${REVIEWED_MARKER}\` annotation does not apply to this kind of statement` : ""}. It ${NOT_ANALYZED_HINT}.`,
      );
  }
  const expands = analysis.templates.filter((t) => t.kind === "enum-remove");
  if (expands.length > 1)
    fail(
      `\`${rel}\`: more than one enum-remove block; one migration may remove values from one enum only (regenerate with \`pnpm db:migrate\`).`,
    );

  // contract.sql
  let contractAnalysis = null;
  if (migration.contract) {
    contractAnalysis = analyzeContract(migration.contract.sql, { folder: name });
    for (const finding of contractAnalysis.findings)
      fail(
        `\`${crel}\` line ${finding.line}: ${finding.message.replace(/: deploy a newer image$/, "; regenerate with `pnpm db:migrate`")}.`,
      );
  }
  const header = contractAnalysis?.template ?? null;
  const expand = expands[0]?.header ?? null;
  if (header || expand) {
    if (!header || !expand || !sameHeader(header, expand))
      fail(
        `\`${name}\`: the enum-remove blocks of migration.sql and ${CONTRACT_FILE} must come from one generated header; regenerate with \`pnpm db:migrate\`.`,
      );
  }
  // §1.5 header rules, against the catalog before this folder.
  if (header) {
    const enumKey = [...catalog.enums.keys()].find((key) => key.endsWith(`.${header.enumName}`));
    const labels = enumKey ? catalog.enums.get(enumKey).labels : [];
    const removed = header.pairs.map((p) => p.from);
    if (!enumKey)
      fail(`\`${name}\`: enum "${header.enumName}" does not exist before this migration.`);
    for (const { from, to } of header.pairs) {
      if (enumKey && !labels.includes(from))
        fail(`\`${name}\`: ${header.enumName}.${from} does not exist before this migration.`);
      if (enumKey && (!labels.includes(to) || removed.includes(to)))
        fail(
          `\`${name}\`: rows of ${header.enumName}.${from} move to ${to}, which must be a value ${header.enumName} already has and keeps.`,
        );
    }
    if (enumKey) {
      const after = catalogFromSql(migration.sql, catalog);
      const added = (after.enums.get(enumKey)?.labels ?? []).filter((l) => !labels.includes(l));
      if (added.length)
        fail(
          `\`${name}\`: adds ${added.map((l) => `${header.enumName}.${l}`).join(", ")} in the same migration that removes ${removed.map((l) => `${header.enumName}.${l}`).join(", ")}. Add the new value in an earlier PR.`,
        );
      const columns = enumColumns(catalog, enumKey);
      const key = (c) => `${c.tableName ?? c.table}\0${c.column}\0${c.array}`;
      const listed = new Set(header.columns.map(key));
      if (columns.length !== listed.size || !columns.every((c) => listed.has(key(c))))
        fail(
          `\`${name}\`: the enum-remove header must list every column of type "${header.enumName}"; regenerate with \`pnpm db:migrate\`.`,
        );
      for (const column of enumColumns(after, enumKey)) {
        const named = enumDefaultNamesRemoved(column.default, removed);
        if (named.length)
          fail(
            `\`${name}\`: the default of "${column.tableName}"."${column.column}" still names the removed value ${named.join(", ")}; give it a new default in the schema and regenerate.`,
          );
      }
    }
  }
  // Recover blocks (§1.8).
  const recovers = analysis.templates.filter((t) => t.kind === "recover").map((t) => t.header);
  if (recovers.length) {
    const after = catalogFromSql(migration.sql, catalog);
    for (const r of recovers) {
      const tableKey = `public.${r.table}`;
      const source = retired.get(`${tableKey}.${r.from}`);
      const target = after.tables.get(tableKey)?.columns.get(r.to);
      if (source === undefined)
        fail(
          `\`${name}\`: --recover "${r.table}"."${r.from}" is not deleted by an earlier ${CONTRACT_FILE}.`,
        );
      if (!target || catalog.tables.get(tableKey)?.columns.has(r.to))
        fail(
          `\`${name}\`: --recover target "${r.table}"."${r.to}" must be a column this migration adds.`,
        );
      else if (source !== undefined && JSON.stringify(source) !== JSON.stringify(target.type))
        fail(
          `\`${name}\`: --recover target "${r.table}"."${r.to}" must have the same type as "${r.from}".`,
        );
    }
  }
  // Drop + add that looks like a rename, across both files (the drop sits in contract.sql).
  const renames = new Set(analysis.renames.map((r) => r.message));
  if (migration.contract)
    for (const r of analyzeMigration(`${migration.sql}\n${migration.contract.sql}`, {
      knownTables: knownTablesOf(catalog),
    }).renames)
      renames.add(r.message);
  for (const message of renames) fail(`\`${name}\`: ${message}`);

  const rollback = rollbackSafety(migration.sql, {
    priorTables: new Set(catalog.tables.keys()),
    catalog,
    folder: name,
  });
  return {
    name,
    failures,
    analysis,
    rollback,
    deletes: migration.contract
      ? describeEffects(summarizeEffects(migration.contract.sql, { folder: name }))
      : null,
    enumRemoval: header,
    recovers,
    reviewed: analysis.notAnalyzed.filter((item) => item.reviewed !== null),
  };
}

/** Apply each folder's contract.sql in order on a scratch DB, capturing `knowledge-base:` notices. */
async function applyContractsCapturing(client, migrations, { before } = {}) {
  const notices = [];
  const listener = (notice) => {
    const text = String(notice?.message ?? "");
    if (text.startsWith("knowledge-base:")) notices.push(text);
  };
  client.on("notice", listener);
  try {
    for (const migration of migrations) {
      if (!migration.contract) continue;
      if (before) {
        const finding = await before(migration);
        if (finding) return { notices, error: finding };
      }
      await applyAllContracts(client, [migration], { schema: "public" });
    }
    return { notices, error: null };
  } catch (error) {
    return { notices, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.removeListener("notice", listener);
  }
}

/**
 * Diff a scratch DB against the schema; the residue may only be enum
 * rebuilds of labels that `kept` (from label-kept notices) names.
 */
async function residue(client, url, kept) {
  const config = tempConfig({ url });
  try {
    const diff = await prisma(
      [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        SCHEMA_DIR,
        "--script",
        "--config",
        config,
      ],
      { capture: true },
    );
    if (diff.code !== 0) return { error: tail(diff.stderr || diff.stdout) };
    const live = await readLiveCatalog(client, "public");
    const filtered = filterDiff(diff.stdout, live, kept);
    return { sql: filtered.empty ? "" : filtered.sql, notes: filtered.notes };
  } finally {
    rmSync(path.dirname(config), { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
  if (!baseRef) {
    console.error("usage: pnpm db:check-migrations --base <git-ref>   (needs CHECK_DATABASE_URL)");
    process.exit(2);
  }
  const serverUrl = process.env.CHECK_DATABASE_URL;
  if (!serverUrl) {
    console.error(
      "FATAL: CHECK_DATABASE_URL (superuser URL to a disposable Postgres) is required.",
    );
    process.exit(2);
  }
  git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);

  /** @type {Check[]} */
  const checks = [];
  const add = (id, title, details, { skip = false } = {}) =>
    checks.push({ id, title, status: skip ? "skip" : details.length ? "fail" : "pass", details });

  const head = readMigrationsFolder(MIGRATIONS_DIR);
  const headNames = head.map((m) => m.name);
  const baseFolders = migrationFoldersAt(baseRef);
  const ordering = checkOrdering(baseFolders, headNames);
  const added = ordering.added;
  const addedSet = new Set(added);
  const byName = new Map(head.map((m) => [m.name, m]));

  // --- static analysis (checks 2, 3, 5 + report) -------------------------
  add("2", "Ordering", ordering.details);
  const immutability = checkImmutability(baseMigrationFiles(baseRef), listFolderFiles, (rel) => {
    const file = path.join(MIGRATIONS_DIR, rel);
    return existsSync(file) ? readFileSync(file) : null;
  });
  add("3", "Immutability", immutability);

  const previous = head.filter((m) => !addedSet.has(m.name));
  // Base catalog: one fold of every base file (no `newInRun`); each added
  // folder then folds on top, like the runner's fold over the live database.
  let catalog = catalogFromSql(previous.flatMap(folderFiles));
  const safety = [];
  const report = [];
  for (const name of added) {
    const migration = byName.get(name);
    const upTo = head.slice(0, headNames.indexOf(name));
    const result = checkFolder(migration, {
      catalog,
      retired: retiredColumnTypes(upTo),
      initial: baseFolders.length === 0,
    });
    safety.push(...result.failures);
    report.push(result);
    catalog = catalogFromSql(folderFiles(migration), catalog);
  }
  for (const match of findNameReuse(head))
    if (addedSet.has(match.folder))
      safety.push(
        `\`${match.folder}\` line ${match.line}: recreates ${match.key.replace(/^(\w+):public\./, "$1 ")}, which the scheduled deletion in \`${match.droppedBy}\` removes. Use a new physical name with @map / @@map.`,
      );
  add("5", "Safe for the running release", safety, { skip: !added.length });

  // --- database checks (1, 4) -------------------------------------------
  const pg = loadPg();
  const admin = await adminClient(pg, serverUrl);
  const suffix = randomBytes(5).toString("hex");
  const scratch = [
    `knowledge_base_check_${suffix}a`,
    `knowledge_base_check_${suffix}b`,
    `knowledge_base_check_${suffix}c`,
  ];
  const work = mkdtempSync(path.join(tmpdir(), "knowledge-base-check-"));
  const connect = async (url) => {
    const client = new pg.Client({ connectionString: pgConnectionString(url) });
    await client.connect();
    return client;
  };
  try {
    for (const name of scratch) await createDatabase(admin, name);
    const all = path.join(work, "all");
    exportBaseMigrations(baseRef, all);
    for (const name of added)
      cpSync(path.join(MIGRATIONS_DIR, name), path.join(all, name), { recursive: true });
    const baseOrdered = baseFolders.filter((name) =>
      existsSync(path.join(all, name, "migration.sql")),
    );
    const allFolders = readMigrationsFolder(all);
    const baseSet = new Set(baseOrdered);
    const baseMigrations = allFolders.filter((m) => baseSet.has(m.name));
    const addedMigrations = allFolders.filter((m) => addedSet.has(m.name));

    // Check 1, path A: every migration, then every contract (validated first).
    const consistency = [];
    const kept = [];
    let keptA = new Map();
    let catalogA;
    const url1 = withDatabase(serverUrl, scratch[0]);
    const deployed = await deployTo(url1, MIGRATIONS_DIR);
    if (deployed.code !== 0)
      consistency.push(
        `Applying all migrations to an empty database failed:\n\n\`\`\`\n${tail(deployed.stdout + deployed.stderr)}\n\`\`\``,
      );
    else {
      const client = await connect(url1);
      try {
        const image = await imageSchema(url1);
        const ran = await applyContractsCapturing(client, head, {
          before: async (migration) => {
            const verdict = validateContract({
              migration,
              row: { contract_checksum: migration.contract.checksum },
              live: await readLiveCatalog(client, "public"),
              image,
            });
            return verdict.ok
              ? null
              : `The deploy runner would refuse this scheduled deletion: ${verdict.finding}`;
          },
        });
        catalogA = await readApplicationCatalog(client, "public");
        keptA = keptLabelsFromNotices(ran.notices);
        kept.push(...ran.notices);
        if (ran.error) consistency.push(`A (all migrations, then all contracts): ${ran.error}`);
        else {
          const left = await residue(client, url1, keptLabelsFromNotices(ran.notices));
          if (left.error)
            consistency.push(`prisma migrate diff errored:\n\n\`\`\`\n${left.error}\n\`\`\``);
          else if (left.sql)
            consistency.push(
              `A (all migrations, then all contracts): the migrations do not produce \`packages/db/prisma/schema\`. The schema changed without matching SQL — run \`pnpm db:migrate <name>\`. Missing:\n\n\`\`\`sql\n${tail(left.sql, 60)}\n\`\`\``,
            );
        }
      } finally {
        await client.end().catch(() => {});
      }
    }
    // Path B: base migrations, base contracts, then the PR's migrations and contracts.
    if (added.length) {
      const url3 = withDatabase(serverUrl, scratch[2]);
      const client = await connect(url3);
      try {
        const steps = [
          ["the base's migrations", baseOrdered],
          ["the PR's migrations", [...baseOrdered, ...added]],
        ];
        const notices = [];
        for (const [index, [label, folders]] of steps.entries()) {
          if (!folders.length) continue;
          const result = await deployTo(url3, stepDir(work, all, folders, `b${index}`));
          if (result.code !== 0) {
            consistency.push(
              `B: applying ${label} failed:\n\n\`\`\`\n${tail(result.stdout + result.stderr)}\n\`\`\``,
            );
            break;
          }
          const ran = await applyContractsCapturing(
            client,
            index === 0 ? baseMigrations : addedMigrations,
          );
          notices.push(...ran.notices);
          if (ran.error) {
            consistency.push(`B (${label}, then their contracts): ${ran.error}`);
            break;
          }
          if (index === 1) {
            const left = await residue(client, url3, keptLabelsFromNotices(notices));
            if (left.error)
              consistency.push(`prisma migrate diff errored:\n\n\`\`\`\n${left.error}\n\`\`\``);
            else if (left.sql)
              consistency.push(
                `B (base, then this PR): the result differs from \`packages/db/prisma/schema\`. Missing:\n\n\`\`\`sql\n${tail(left.sql, 60)}\n\`\`\``,
              );
          }
        }
        const catalogB = await readApplicationCatalog(client, "public");
        if (catalogA) {
          const differences = compareApplicationCatalogs(catalogA, catalogB, {
            keptA,
            keptB: keptLabelsFromNotices(notices),
          });
          if (differences.length)
            consistency.push(
              `The two migration/contract replay orders produce different application catalogs (including constraints, triggers, functions and partial indexes). Differing objects (A: all migrations, then contracts; B: base contracts before PR migrations):\n${differences.map((difference) => `  - ${difference}`).join("\n")}`,
            );
        }
        kept.push(...notices);
      } finally {
        await client.end().catch(() => {});
      }
    }
    add("1", "Consistency", consistency);

    // Check 4
    const data = [];
    const dataWarnings = [];
    const ordered = [...baseOrdered, ...added];
    const fixtures = existsSync(FIXTURES_DIR) ? readdirSync(FIXTURES_DIR) : [];
    for (const file of fixtures) {
      const pinned = file.replace(/\.check\.sql$|\.sql$/, "");
      if (!file.endsWith(".sql")) continue;
      if (!ordered.includes(pinned))
        data.push(`\`packages/db/prisma/fixtures/${file}\` is not named after a migration folder.`);
    }
    const url2 = withDatabase(serverUrl, scratch[1]);
    const client = await connect(url2);
    try {
      let appliedCount = -1;
      let step = 0;
      const applyFolders = async (folders) => {
        if (folders.length === appliedCount) return true;
        const result = await deployTo(url2, stepDir(work, all, folders, String(step++)));
        if (result.code !== 0) {
          data.push(
            `Applying migrations through \`${folders.at(-1)}\` on top of fixture data failed:\n\n\`\`\`\n${tail(result.stdout + result.stderr)}\n\`\`\``,
          );
          return false;
        }
        appliedCount = folders.length;
        return true;
      };
      const loadFixture = async (name) => {
        const file = path.join(FIXTURES_DIR, `${name}.sql`);
        if (!existsSync(file)) return true;
        try {
          await client.query("BEGIN");
          await client.query(readFileSync(file, "utf8"));
          await client.query("COMMIT");
          return true;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          data.push(
            `Loading \`packages/db/prisma/fixtures/${name}.sql\` failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      };
      const contractsOf = async (migrations, label) => {
        const ran = await applyContractsCapturing(client, migrations);
        if (ran.error)
          data.push(
            `Applying ${label} scheduled deletions on top of fixture data failed: ${ran.error}`,
          );
        return !ran.error;
      };
      // Phase A: base migrations, each fixture loaded right after its
      // migration, then the base's scheduled deletions.
      // Phase B: the PR's migrations (their own fixtures load after them
      // too), then the PR's scheduled deletions.
      const sequence = [...baseOrdered, ...added];
      let ok = true;
      let before = new Map();
      for (let i = 0; ok && i < sequence.length; i++) {
        const name = sequence[i];
        const lastBase = i === baseOrdered.length - 1;
        if (
          existsSync(path.join(FIXTURES_DIR, `${name}.sql`)) ||
          lastBase ||
          i === sequence.length - 1
        ) {
          ok = (await applyFolders(sequence.slice(0, i + 1))) && (await loadFixture(name));
        }
        if (ok && lastBase) {
          ok = await contractsOf(baseMigrations, "the base's");
          if (ok) before = await snapshot(client);
        }
      }
      if (ok && added.length) ok = await contractsOf(addedMigrations, "this PR's");
      if (ok && added.length) {
        const effects = mergeEffects(
          addedMigrations.flatMap((m) => [
            summarizeEffects(m.sql, { folder: m.name }),
            ...(m.contract ? [summarizeEffects(m.contract.sql, { folder: m.name })] : []),
          ]),
        );
        if (effects.opaque)
          dataWarnings.push(
            "A new migration has SQL the analyzer cannot see through (dollar-quoted/DO/EXECUTE); renames inside it are not mapped.",
          );
        const after = await snapshot(client);
        const compared = compareSnapshots(before, after, effects);
        data.push(...compared.failures);
        dataWarnings.push(...compared.warnings);
      }
      if (ok) {
        for (const file of fixtures.filter((f) => f.endsWith(".check.sql")).sort()) {
          try {
            const results = await client.query(readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
            for (const result of Array.isArray(results) ? results : [results]) {
              if (result.rowCount && result.command === "SELECT") {
                data.push(
                  `\`packages/db/prisma/fixtures/${file}\` returned ${result.rowCount} violating row(s): ${JSON.stringify(result.rows.slice(0, 3))}`,
                );
              }
            }
          } catch (error) {
            data.push(
              `\`packages/db/prisma/fixtures/${file}\` errored: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    } finally {
      await client.end().catch(() => {});
    }
    checks.push({
      id: "4",
      title: "Applies with data",
      status: data.length ? "fail" : "pass",
      details: [...data, ...dataWarnings.map((w) => `warning: ${w}`)],
    });
    for (const result of report)
      result.kept = [...keptLabelsFromNotices(kept)]
        .filter(([enumName]) => result.enumRemoval?.enumName === enumName)
        .flatMap(([enumName, labels]) =>
          labels
            .filter((label) => result.enumRemoval.pairs.some((pair) => pair.from === label))
            .map((label) => `${enumName}.${label}`),
        );
  } finally {
    for (const name of scratch) {
      await removeDatabase(admin, name, { kind: "scratch" }).catch(() => {});
    }
    await admin.end().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }

  checks.sort((a, b) => a.id.localeCompare(b.id));
  const markdown = render({ baseRef, added, checks, report });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(markdown);
  process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
}

/** The image-schema catalog the runner validates against (7c-4): the PR's Prisma schema. */
async function imageSchema(url) {
  const config = tempConfig({ url });
  try {
    const result = await prisma(
      [
        "migrate",
        "diff",
        "--from-empty",
        "--to-schema",
        SCHEMA_DIR,
        "--script",
        "--config",
        config,
      ],
      { capture: true },
    );
    return result.code === 0
      ? catalogFromSql(result.stdout)
      : new Error(`prisma migrate diff exited ${result.code}`);
  } finally {
    rmSync(path.dirname(config), { recursive: true, force: true });
  }
}

/** The PR summary (exported for tests). */
export function render({ baseRef, added, checks, report }) {
  const lines = [
    "## Database migrations",
    "",
    `Base: \`${baseRef}\` · new migrations: ${added.length ? added.map((n) => `\`${n}\``).join(", ") : "none"}`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...checks.map((c) => `| ${c.id}. ${c.title} | ${c.status.toUpperCase()} |`),
    "",
  ];
  for (const check of checks.filter((c) => c.details.length)) {
    lines.push(`### ${check.id}. ${check.title}`, "", ...check.details.map((d) => `- ${d}`), "");
  }
  lines.push("### What the new migrations change (plain English, report-only)", "");
  if (!added.length) lines.push("No new migrations.", "");
  for (const result of report) {
    const { analysis } = result;
    lines.push(
      `**\`${result.name}\`**${analysis.markers.transactional ? "" : " — not transactional (a failure needs a person)"}`,
    );
    if (!analysis.destructive.length) lines.push("- Changes now: nothing is deleted at deploy.");
    for (const finding of analysis.destructive)
      lines.push(`- Changes now, line ${finding.line}: ${finding.message}`);
    if (result.deletes) {
      lines.push(
        `- Deleted about 7 days after this deploys, once no older release is running: ${result.deletes}.`,
      );
      if (result.enumRemoval) lines.push(`  For the enum value: ${ENUM_KEPT_CAVEAT}.`);
      if (result.kept?.length)
        lines.push(
          `  In this check's scratch database something used the column, so ${result.kept.join(", ")} ${result.kept.length > 1 ? "were" : "was"} kept.`,
        );
    }
    for (const r of result.recovers)
      lines.push(
        `- Recovers "${r.table}"."${r.from}" into "${r.to}" (copies the data while the old column still exists).`,
      );
    for (const item of result.reviewed)
      lines.push(
        `- Reviewed by hand (line ${item.line}): ${item.reviewed} — attested by the author, not verified.`,
      );
    lines.push(
      result.rollback.safe
        ? `- Rollback to the previous release: possible${result.deletes ? " until the deletion runs" : ""}.`
        : `- Rollback to the previous release: not possible (${result.rollback.reasons.join("; ")}).`,
    );
    lines.push("");
  }
  if (report.some((r) => r.analysis.destructive.length || r.deletes)) {
    lines.push("Agents: show this summary to the user before merging.", "");
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
