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
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyAllContracts,
  describeEffects,
  ensureRuntimeTables,
  readLiveCatalog,
  recordApplied,
  validateContract,
} from "./lib/contracts.mjs";
import {
  ENUM_KEPT_CAVEAT,
  filterDiff,
  keptLabelsFromNotices,
  retiredColumnTypes,
} from "./lib/diff-source.mjs";
import { git, migrationFoldersAt, releasedFolders } from "./lib/local.mjs";
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
import {
  applyReconcile,
  FROM_MARKER,
  planReconcile,
  READ_HISTORY_SQL,
  REPLACED_DIR,
  REPLACES_FILE,
  readReleases,
  remainingContract,
  sectionNames,
  splitSections,
  wrappedBody,
} from "./lib/replaces.mjs";
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
import { buildRelease } from "./release-squash.mjs";

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

/**
 * Check 3. Every file of a base migration folder stays byte-identical, and no
 * file is added to one. Release squashes (scripts/db/lib/replaces.mjs) are the
 * only exceptions, and only for what no release tag contains:
 *   - a base folder may disappear when a release folder of the head lists it
 *     in replaces.json and keeps a byte-identical `replaced/<folder>/` copy of
 *     every file it had;
 *   - in a release PR (`releasePr`), a base folder's `replaced/` copies and
 *     `replaces.json` may be removed (the previous release's, one release later).
 * A folder that is in any release tag (`released`) never changes or disappears.
 * @param {Array<{ path: string, sha: string }>} baseFiles paths relative to the migrations dir
 * @param {(folder: string) => string[]} headFilesByFolder
 * @param {(rel: string) => Buffer | null} readHead
 * @param {{ releases?: Array<{ name: string, replaces: Array<{ name: string }> }>,
 *   released?: Set<string>, releasePr?: boolean }} [options]
 */
export function checkImmutability(baseFiles, headFilesByFolder, readHead, options = {}) {
  const { releases = [], released = new Set(), releasePr = false } = options;
  const details = [];
  const baseFolders = new Set();
  const basePaths = new Set(baseFiles.map((f) => f.path));
  const replacedBy = new Map();
  for (const release of releases)
    for (const entry of release.replaces) replacedBy.set(entry.name, release.name);
  const isCopyOrManifest = (rel) => {
    const [, second] = rel.split("/");
    return second === REPLACES_FILE || second === REPLACED_DIR;
  };
  for (const file of baseFiles) {
    const folder = file.path.split("/")[0];
    if (file.path.includes("/")) baseFolders.add(folder);
    const bytes = readHead(file.path);
    if (bytes !== null) {
      if (gitBlobSha(bytes) !== file.sha)
        details.push(
          `\`${file.path}\` was modified. ${released.has(folder) ? "It is in a release tag, and released" : "Applied"} migrations are immutable: write a new migration instead.`,
        );
      continue;
    }
    if (releasePr && file.path.includes("/") && isCopyOrManifest(file.path)) continue;
    if (released.has(folder)) {
      details.push(
        `\`${file.path}\` is in a release tag but was deleted or renamed. Released migrations are immutable.`,
      );
      continue;
    }
    const release = replacedBy.get(folder);
    if (release) {
      const rest = file.path.slice(folder.length + 1);
      const copy = readHead(`${release}/${REPLACED_DIR}/${folder}/${rest}`);
      if (copy !== null && gitBlobSha(copy) === file.sha) continue;
      details.push(
        `\`${file.path}\` was squashed into \`${release}\`, but \`${release}/${REPLACED_DIR}/${folder}/${rest}\` is ${copy === null ? "missing" : "not byte-identical"}. Re-run \`pnpm db:release-squash\`.`,
      );
      continue;
    }
    details.push(`\`${file.path}\` exists on the base branch but was deleted or renamed.`);
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

export async function deployTo(url, migrations) {
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
export function checkFolder(migration, { catalog, retired, initial = false, sections = null }) {
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
  // Drop + add that looks like a rename, across both files (the drop sits in
  // contract.sql). A release folder is judged per squashed migration, as each
  // was when it merged: one section's drop and a later section's add are two
  // migrations, not a rename.
  const renames = new Set();
  if (sections) {
    let at = catalog;
    for (const section of sections) {
      const files = section.contract ? [section.sql, section.contract.sql] : [section.sql];
      for (const r of analyzeMigration(files.join("\n"), { knownTables: knownTablesOf(at) })
        .renames)
        renames.add(r.message);
      at = catalogFromSql(files, at);
    }
  } else {
    for (const r of analysis.renames) renames.add(r.message);
    if (migration.contract)
      for (const r of analyzeMigration(`${migration.sql}\n${migration.contract.sql}`, {
        knownTables: knownTablesOf(catalog),
      }).renames)
        renames.add(r.message);
  }
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
export async function residue(client, url, kept) {
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

/** Run `fn(client)` on a fresh connection to `url`. */
async function withClient(connect, url, fn) {
  const client = await connect(url);
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The schema of `public` as sorted text lines (tables' columns in order with
 * type, nullability and default; constraints; indexes; enums; triggers;
 * functions and sequences outside extensions; extensions). Runner-owned
 * tables and Prisma's history are left out. Equal fingerprints ⇔ equal
 * schemas for everything migrations create (the release check's Guard A).
 */
export const FINGERPRINT_SQL = `
WITH rel AS (
  SELECT c.oid, c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
     AND c.relname <> '_prisma_migrations' AND c.relname NOT LIKE '\\_knowledge_base\\_%'
)
SELECT line FROM (
  SELECT format('column %s #%s %s %s%s%s', r.relname,
           row_number() OVER (PARTITION BY r.oid ORDER BY a.attnum), a.attname,
           format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN ' not null' ELSE '' END,
           coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')) AS line
    FROM rel r JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  UNION ALL
  SELECT format('constraint %s %s %s', r.relname, co.conname, pg_get_constraintdef(co.oid))
    FROM rel r JOIN pg_catalog.pg_constraint co ON co.conrelid = r.oid
  UNION ALL
  SELECT format('index %s', pg_get_indexdef(i.indexrelid))
    FROM rel r JOIN pg_catalog.pg_index i ON i.indrelid = r.oid
  UNION ALL
  SELECT format('enum %s %s', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder))
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' GROUP BY t.typname
  UNION ALL
  SELECT format('trigger %s', pg_get_triggerdef(tg.oid))
    FROM rel r JOIN pg_catalog.pg_trigger tg ON tg.tgrelid = r.oid WHERE NOT tg.tgisinternal
  UNION ALL
  SELECT format('function %s(%s) %s', p.proname, pg_get_function_identity_arguments(p.oid), md5(pg_get_functiondef(p.oid)))
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.objid = p.oid AND dep.deptype = 'e')
  UNION ALL
  SELECT format('sequence %s', c.relname) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.objid = c.oid AND dep.deptype = 'e')
  UNION ALL
  SELECT format('extension %s', extname) FROM pg_catalog.pg_extension
) lines ORDER BY line COLLATE "C"`;

export async function fingerprint(client) {
  return (await client.query(FINGERPRINT_SQL)).rows.map((row) => row.line);
}

/** Lines only in `a` / only in `b` (pure, exported for tests). */
export function fingerprintDiff(a, b) {
  const inB = new Set(b);
  const inA = new Set(a);
  return { onlyA: a.filter((l) => !inB.has(l)), onlyB: b.filter((l) => !inA.has(l)) };
}

/**
 * The release folder must be exactly what `pnpm db:release-squash` generates
 * from its `replaced/` copies: the replaced SQL CONCATENATED, in manifest
 * order, nothing else (never regenerated from a schema diff, no extra SQL
 * outside the sections that only fresh databases would run). Section-level
 * findings explain a mismatch (pure; exported for tests).
 * @param {import("./lib/replaces.mjs").Release} release
 * @param {{ sql: string, contract: { sql: string } | null }} migration the release folder
 */
export function checkReleaseSections(release, migration) {
  const where = `\`${release.name}\``;
  if (release.replaces.some((e) => e.sql === null)) return []; // reported as a manifest problem
  const expected = buildRelease({
    release: release.name,
    tag: release.tag ?? "",
    migrations: release.replaces.map((e) => ({
      name: e.name,
      sql: e.sql,
      checksum: e.checksum,
      contract: e.contractChecksum ? { sql: e.contract ?? "", checksum: e.contractChecksum } : null,
    })),
  });
  if (expected.problems.length) return expected.problems.map((p) => `${where}: ${p}`);
  const contractOk = (migration.contract?.sql ?? null) === expected.contractSql;
  if (migration.sql === expected.migrationSql && contractOk) return [];
  const out = [];
  const names = release.replaces.map((e) => e.name);
  let body = null;
  try {
    body = wrappedBody(migration.sql);
  } catch (error) {
    out.push(`${where}/migration.sql: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (body !== null) {
    const { preamble, sections } = splitSections(body);
    if (JSON.stringify(sections.map((x) => x.name)) !== JSON.stringify(names))
      out.push(
        `${where}/migration.sql: its \`${FROM_MARKER}\` sections (${sections.map((x) => x.name).join(", ") || "none"}) are not the migrations ${REPLACES_FILE} lists, in order (${names.join(", ")}).`,
      );
    else
      for (const [i, entry] of release.replaces.entries())
        if (
          sections[i].text.trimEnd() !==
          `${FROM_MARKER} ${entry.name}\n${wrappedBody(entry.sql)}`.trimEnd()
        )
          out.push(
            `${where}/migration.sql: the section for ${entry.name} is not its ${REPLACED_DIR}/ copy verbatim. A release migration concatenates the replaced SQL; regenerate it with \`pnpm db:release-squash\`, never from a schema diff.`,
          );
    if (preamble.replace(/^\s*--[^\n]*$/gm, "").trim())
      out.push(
        `${where}/migration.sql: SQL outside the \`${FROM_MARKER}\` sections (it would run only on databases that apply the release, never on reconciled ones).`,
      );
  }
  if (!contractOk)
    out.push(
      `${where}/contract.sql: not the replaced contract.sql files concatenated in order (${
        release.replaces
          .filter((e) => e.contractChecksum)
          .map((e) => e.name)
          .join(", ") || "none"
      }); regenerate with \`pnpm db:release-squash\`.`,
    );
  if (!out.length)
    out.push(
      `${where}/migration.sql: differs from what \`pnpm db:release-squash\` generates from ${REPLACED_DIR}/; regenerate it, never edit a release folder by hand.`,
    );
  return out;
}

/**
 * A migration's data fixture: fixtures/<folder>.sql, or, for a folder a
 * release replaced, fixtures/<release>/<folder>.sql (moved there by
 * `pnpm db:release-squash`). null when there is none.
 */
function fixtureFile(name, releases) {
  const own = path.join(FIXTURES_DIR, `${name}.sql`);
  if (existsSync(own)) return own;
  const release = releases.find((r) => r.replaces.some((e) => e.name === name));
  const moved = release && path.join(FIXTURES_DIR, release.name, `${name}.sql`);
  return moved && existsSync(moved) ? moved : null;
}

/**
 * A release folder whose data fixtures CI replays: it has `-- knowledge-base:from`
 * sections and a fixtures/<release>/ directory (`pnpm db:release-squash`
 * keeps them there for good).
 */
function replayable(migration) {
  if (!migration) return false;
  const dir = path.join(FIXTURES_DIR, migration.name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  return sectionNames(migration.sql).length > 0;
}

/**
 * Apply a release folder on a scratch database section by section, each in
 * its own transaction, with fixtures/<release>/<section>.sql loaded right
 * after its section (the order its rows were written in, on the default
 * branch), then record the release as applied the way the runner's
 * reconciliation does (Prisma skips it), then load fixtures/<release>.sql
 * if there is one. The release SQL is immutable and
 * keeps every section, so this works long after `replaced/` is gone.
 * Returns an error or null.
 */
async function replayRelease(client, migration) {
  const { sections } = splitSections(wrappedBody(migration.sql));
  const run = async (label, sql) => {
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      return `${label}: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  for (const section of sections) {
    const error = await run(`${migration.name} section ${section.name}`, section.text);
    if (error) return error;
    const fixture = path.join(FIXTURES_DIR, migration.name, `${section.name}.sql`);
    if (existsSync(fixture)) {
      const loaded = await run(
        `loading fixtures/${migration.name}/${section.name}.sql`,
        readFileSync(fixture, "utf8"),
      );
      if (loaded) return loaded;
    }
  }
  await client.query(
    `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES ($1, $2, now(), $3, NULL, NULL, now(), 1)`,
    [randomUUID(), migration.checksum, migration.name],
  );
  // The release folder's own data fixture (rows written after the release).
  const own = path.join(FIXTURES_DIR, `${migration.name}.sql`);
  return existsSync(own)
    ? run(`loading fixtures/${migration.name}.sql`, readFileSync(own, "utf8"))
    : null;
}

/** Every fixtures/*.check.sql statement must return no rows; returns the violations. */
async function runFixtureChecks(client) {
  const out = [];
  const files = existsSync(FIXTURES_DIR)
    ? readdirSync(FIXTURES_DIR)
        .filter((f) => f.endsWith(".check.sql"))
        .sort()
    : [];
  for (const file of files) {
    try {
      const results = await client.query(readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
      for (const result of Array.isArray(results) ? results : [results])
        if (result.rowCount && result.command === "SELECT")
          out.push(
            `\`packages/db/prisma/fixtures/${file}\` returned ${result.rowCount} violating row(s): ${JSON.stringify(result.rows.slice(0, 3))}`,
          );
    } catch (error) {
      out.push(
        `\`packages/db/prisma/fixtures/${file}\` errored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return out;
}

/**
 * Guard A for every prefix of a release's replaced chain: a database that
 * applied the folders before the release plus the first k replaced
 * migrations one by one (k = 0 … n; k = 0 is a self-hoster on the last
 * release, k = n a deployment that tracked the default branch), each data
 * fixture loaded right after its migration, then the runner's
 * reconciliation, the head's migrations and every remaining contract, must
 * end with exactly the fresh head database's schema (`target`); on the
 * complete chain (k = n) every fixtures/*.check.sql must pass too. An
 * earlier release with data fixtures is replayed section by section
 * (replayRelease). When the prefix carries contracts, a second
 * database runs them BEFORE the reconciliation too (tracked in
 * `_knowledge_base_migration`, as the runner does), so the release runs only the
 * remaining sections.
 */
async function guardAPrefixes({
  release,
  releases,
  head,
  headNames,
  work,
  scratchDb,
  connect,
  target,
}) {
  const failures = [];
  const before = head.filter((m) => m.name < release.name);
  const replaced = readMigrationsFolder(path.join(MIGRATIONS_DIR, release.name, REPLACED_DIR));
  const lock = path.join(MIGRATIONS_DIR, "migration_lock.toml");
  for (let k = 0; k <= release.replaces.length; k++) {
    const prefix = replaced.slice(0, k);
    const chain = [...before, ...prefix];
    const label =
      k === 0 ? "none of the replaced migrations" : `${prefix.map((m) => m.name).join(" + ")}`;
    /** A migrations dir with the first `count` folders of the chain. */
    const dirOf = (count) => {
      const dir = path.join(work, `release-${release.name}-${k}-${count}`);
      if (existsSync(dir)) return dir;
      mkdirSync(dir, { recursive: true });
      for (const m of chain.slice(0, count))
        cpSync(path.dirname(m.file), path.join(dir, m.name), { recursive: true });
      if (existsSync(lock)) cpSync(lock, path.join(dir, "migration_lock.toml"));
      return dir;
    };
    const variants = prefix.some((m) => m.contract) ? [false, true] : [false];
    for (const contractsFirst of variants) {
      const what = `${label}${contractsFirst ? ", their scheduled deletions already run" : ""}`;
      const url = await scratchDb();
      // The one-by-one path, each data fixture loaded right after its migration.
      let error = null;
      for (let i = 0; !error && i < chain.length; i++) {
        if (replayable(chain[i])) {
          // An earlier release with data fixtures: replay it section by section.
          if (i > 0) {
            const deployed = await deployTo(url, dirOf(i));
            if (deployed.code !== 0) {
              error = `applying the prefix failed:\n\n\`\`\`\n${tail(deployed.stdout + deployed.stderr)}\n\`\`\``;
              break;
            }
          }
          error = await withClient(connect, url, (client) => replayRelease(client, chain[i]));
          continue;
        }
        const fixture = fixtureFile(chain[i].name, releases);
        if (!fixture && i < chain.length - 1) continue;
        const deployed = await deployTo(url, dirOf(i + 1));
        if (deployed.code !== 0)
          error = `applying the prefix failed:\n\n\`\`\`\n${tail(deployed.stdout + deployed.stderr)}\n\`\`\``;
        else if (fixture)
          error = await withClient(connect, url, (client) =>
            client.query(readFileSync(fixture, "utf8")).then(
              () => null,
              (e) =>
                `loading ${path.relative(ROOT, fixture)} failed: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
      }
      if (error) {
        failures.push(`Guard A (${what}): ${error}`);
        continue;
      }
      const result = await withClient(connect, url, async (client) => {
        const done = new Set();
        if (contractsFirst) {
          await ensureRuntimeTables(client, "public");
          await recordApplied(client, { schema: "public", migrations: chain });
          for (const m of chain) {
            if (!m.contract) continue;
            await applyAllContracts(client, [m], { schema: "public" });
            done.add(m.name);
          }
          await client.query(
            `UPDATE "_knowledge_base_migration" SET contract_applied_at = now() WHERE name = ANY($1::text[])`,
            [[...done]],
          );
        }
        const reconcile = await reconcileScratch(client, releases, headNames);
        if (reconcile) return { error: `reconciling failed: ${reconcile}` };
        const headDeploy = await deployTo(url, MIGRATIONS_DIR);
        if (headDeploy.code !== 0)
          return {
            error: `applying the head's migrations failed:\n\n\`\`\`\n${tail(headDeploy.stdout + headDeploy.stderr)}\n\`\`\``,
          };
        const rows = contractsFirst
          ? new Map(
              (
                await client.query(
                  `SELECT name, contract_done_parts, contract_applied_at FROM "_knowledge_base_migration"`,
                )
              ).rows.map((row) => [row.name, row]),
            )
          : new Map();
        for (const m of head) {
          if (!m.contract || done.has(m.name)) continue;
          const row = rows.get(m.name);
          if (row?.contract_applied_at) continue;
          try {
            await applyAllContracts(client, [remainingContract(m, row)], { schema: "public" });
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }
        // Fixture checks only on the complete one-by-one chain: a shorter
        // prefix never loaded the later migrations' rows.
        return {
          lines: await fingerprint(client),
          violations: k === release.replaces.length ? await runFixtureChecks(client) : [],
        };
      });
      if (result.error) {
        failures.push(`Guard A (${what}): ${result.error}`);
        continue;
      }
      for (const violation of result.violations)
        failures.push(`Guard A (${what}): fixture data: ${violation}`);
      const diff = fingerprintDiff(target, result.lines);
      if (diff.onlyA.length || diff.onlyB.length)
        failures.push(
          `Guard A (${what}): the schema differs from a fresh database at this commit.\n\n\`\`\`\n${[
            ...diff.onlyA.slice(0, 20).map((l) => `- fresh only:  ${l}`),
            ...diff.onlyB.slice(0, 20).map((l) => `+ prefix only: ${l}`),
          ].join("\n")}\n\`\`\``,
        );
    }
  }
  return failures;
}

/**
 * Columns retired (deleted by a contract.sql) before a folder's own SQL, for
 * check 5's `--recover` rule: the earlier folders, and for a release folder
 * also the sections it squashed (a section may recover what an earlier
 * section retired). Pure; exported for tests.
 * @param {Array<{ name: string, sql: string, contract: { sql: string } | null }>} upTo
 * @param {import("./lib/replaces.mjs").Release | undefined} release
 */
export function retiredBefore(upTo, release) {
  const sections = (release?.replaces ?? []).map((e) => ({
    name: e.name,
    sql: e.sql ?? "",
    contract: e.contract ? { sql: e.contract } : null,
  }));
  return retiredColumnTypes([...upTo, ...sections]);
}

/**
 * Reconcile a scratch database's replaced migrations onto the head's
 * release folders, with the deploy runner's own code. Returns an error or null.
 */
async function reconcileScratch(client, releases, localNames) {
  try {
    const { rows } = await client.query(READ_HISTORY_SQL("public"));
    const plan = planReconcile({ rows, releases, localNames });
    if (plan.refusals.length) return plan.refusals.join(" ");
    for (const step of plan.steps)
      await applyReconcile(client, {
        schema: "public",
        step,
        releases,
        localNames,
        migrations: readMigrationsFolder(MIGRATIONS_DIR),
      });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The contract.sql the deploy runner would still apply for each added
 * folder, when every folder in `doneBefore` already had its contract applied
 * (a release runs only the sections of replaced migrations that did not).
 */
export function contractsAfter(migrations, releases, doneBefore) {
  return migrations.map((m) => {
    const release = releases.find((r) => r.name === m.name);
    if (!release) return m;
    const done = release.replaces
      .filter((e) => e.contractChecksum && doneBefore.has(e.name))
      .map((e) => e.name);
    return remainingContract(m, { contract_done_parts: done });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
  // pnpm db:check-release: the base is the last release tag, and a release folder must exist.
  const requireRelease = args.includes("--require-release");
  if (!baseRef) {
    console.error(
      "usage: pnpm db:check-migrations --base <git-ref> [--require-release]   (needs CHECK_DATABASE_URL)",
    );
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
  const manifests = readReleases(MIGRATIONS_DIR);
  /** Release folders this change adds, and the base folders they replace. */
  const addedReleases = manifests.releases.filter((r) => addedSet.has(r.name));
  const replacedSet = new Set(addedReleases.flatMap((r) => r.replaces.map((e) => e.name)));

  // --- static analysis (checks 2, 3, 5 + report) -------------------------
  add("2", "Ordering", ordering.details);
  const immutability = checkImmutability(
    baseMigrationFiles(baseRef),
    listFolderFiles,
    (rel) => {
      const file = path.join(MIGRATIONS_DIR, rel);
      return existsSync(file) ? readFileSync(file) : null;
    },
    {
      releases: addedReleases,
      released: releasedFolders(),
      releasePr: addedReleases.length > 0,
    },
  );
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
    const release = manifests.releases.find((r) => r.name === name);
    const result = checkFolder(migration, {
      catalog,
      retired: retiredBefore(upTo, release),
      initial: baseFolders.length === 0,
      sections: release?.replaces.every((e) => e.sql !== null)
        ? release.replaces.map((e) => ({
            name: e.name,
            sql: e.sql,
            contract: e.contract ? { sql: e.contract } : null,
          }))
        : null,
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
    const baseKept = baseOrdered.filter((name) => !replacedSet.has(name));
    // Base contracts ran (untracked) before the PR's: a release runs only the rest.
    const addedAfterBase = contractsAfter(addedMigrations, addedReleases, baseSet);

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
        // A release folder replaces base folders: the head no longer has
        // them, and the runner reconciles them before the deploy.
        const steps = [
          ["the base's migrations", baseOrdered],
          ["the PR's migrations", [...baseKept, ...added]],
        ];
        const notices = [];
        for (const [index, [label, folders]] of steps.entries()) {
          if (!folders.length) continue;
          if (index === 1 && addedReleases.length) {
            const error = await reconcileScratch(client, addedReleases, headNames);
            if (error) {
              consistency.push(`B: reconciling the base's replaced migrations failed: ${error}`);
              break;
            }
          }
          const result = await deployTo(url3, stepDir(work, all, folders, `b${index}`));
          if (result.code !== 0) {
            consistency.push(
              `B: applying ${label} failed:\n\n\`\`\`\n${tail(result.stdout + result.stderr)}\n\`\`\``,
            );
            break;
          }
          const ran = await applyContractsCapturing(
            client,
            index === 0 ? baseMigrations : addedAfterBase,
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
      const release = allFolders.find((m) => m.name === file);
      const names = release ? sectionNames(release.sql) : [];
      if (names.length) {
        // fixtures/<release>/<replaced folder>.sql (pnpm db:release-squash)
        for (const inner of readdirSync(path.join(FIXTURES_DIR, file)))
          if (!names.some((name) => `${name}.sql` === inner))
            data.push(
              `\`packages/db/prisma/fixtures/${file}/${inner}\` is not named after a migration ${file} replaces.`,
            );
        continue;
      }
      if (!file.endsWith(".sql")) continue;
      if (!ordered.includes(pinned))
        data.push(`\`packages/db/prisma/fixtures/${file}\` is not named after a migration folder.`);
    }
    const url2 = withDatabase(serverUrl, scratch[1]);
    const client = await connect(url2);
    try {
      let appliedKey = "";
      let step = 0;
      let reconciled = !addedReleases.length;
      const applyFolders = async (folders) => {
        if (folders.join("\n") === appliedKey) return true;
        if (!reconciled && folders.some((name) => addedSet.has(name))) {
          reconciled = true;
          const error = await reconcileScratch(client, addedReleases, headNames);
          if (error) {
            data.push(
              `Reconciling the base's replaced migrations on fixture data failed: ${error}`,
            );
            return false;
          }
        }
        const result = await deployTo(url2, stepDir(work, all, folders, String(step++)));
        if (result.code !== 0) {
          data.push(
            `Applying migrations through \`${folders.at(-1)}\` on top of fixture data failed:\n\n\`\`\`\n${tail(result.stdout + result.stderr)}\n\`\`\``,
          );
          return false;
        }
        appliedKey = folders.join("\n");
        return true;
      };
      const loadFixture = async (name) => {
        const file = fixtureFile(name, manifests.releases);
        if (!file) return true;
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
      const allByName = new Map(allFolders.map((m) => [m.name, m]));
      for (let i = 0; ok && i < sequence.length; i++) {
        const name = sequence[i];
        const lastBase = i === baseOrdered.length - 1;
        if (i < baseOrdered.length && replayable(allByName.get(name))) {
          // A released base folder: its rows were written section by section.
          ok = i === 0 || (await applyFolders(sequence.slice(0, i)));
          const error = ok ? await replayRelease(client, allByName.get(name)) : null;
          if (error) {
            data.push(`Replaying the base release \`${name}\` with its fixtures failed: ${error}`);
            ok = false;
          } else if (ok) appliedKey = sequence.slice(0, i + 1).join("\n");
        } else if (fixtureFile(name, manifests.releases) || lastBase || i === sequence.length - 1) {
          const folders =
            i < baseOrdered.length
              ? sequence.slice(0, i + 1)
              : [...baseKept, ...added.slice(0, i - baseOrdered.length + 1)];
          ok = (await applyFolders(folders)) && (await loadFixture(name));
        }
        if (ok && lastBase) {
          ok = await contractsOf(baseMigrations, "the base's");
          if (ok) before = await snapshot(client);
        }
      }
      if (ok && added.length) ok = await contractsOf(addedAfterBase, "this PR's");
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
        // A release added here is applied as one migration on the base's data,
        // without the fixture rows of the migrations it squashed.
        const hint = (file) =>
          addedReleases.some((r) => `${r.name}.check.sql` === file)
            ? " (This runs on the base's data upgraded by the release, without the squashed migrations' own fixture rows: a check must select the rows that are wrong, never require a fixture row to exist.)"
            : "";
        for (const file of fixtures.filter((f) => f.endsWith(".check.sql")).sort()) {
          try {
            const results = await client.query(readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
            for (const result of Array.isArray(results) ? results : [results]) {
              if (result.rowCount && result.command === "SELECT") {
                data.push(
                  `\`packages/db/prisma/fixtures/${file}\` returned ${result.rowCount} violating row(s): ${JSON.stringify(result.rows.slice(0, 3))}${hint(file)}`,
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

    // Check 6: release squash (only when this change adds a release folder).
    if (requireRelease && !addedReleases.length)
      add("6", "Release squash", [
        `No release migration (a folder with ${REPLACES_FILE}) was added since \`${baseRef}\`. Run \`pnpm db:release-squash ${baseRef} <release-name>\` first.`,
      ]);
    else if (addedReleases.length || manifests.problems.length) {
      const release = [...manifests.problems];
      for (const r of addedReleases) release.push(...checkReleaseSections(r, byName.get(r.name)));
      if (!release.length && consistency.length)
        release.push("Guard A skipped: check 1 path A (the fresh head database) failed.");
      else if (!release.length) {
        const target = await withClient(connect, url1, fingerprint);
        let n = 0;
        const scratchDb = async () => {
          const db = `knowledge_base_check_${suffix}p${n++}`;
          scratch.push(db);
          await createDatabase(admin, db);
          return withDatabase(serverUrl, db);
        };
        for (const r of addedReleases)
          release.push(
            ...(await guardAPrefixes({
              releases: manifests.releases,
              release: r,
              head,
              headNames,
              work,
              scratchDb,
              connect,
              target,
            })),
          );
      }
      add("6", "Release squash", release);
    }
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
