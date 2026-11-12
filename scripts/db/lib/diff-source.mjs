/**
 * The generator's diff source (docs/schema-migrations.md, expand and
 * contract): what `pnpm db:migrate` and `pnpm db:migrate:rebase` diff the
 * Prisma schema against.
 *
 * Production applies every `migration.sql` and, about 7 days later, the
 * folder's `contract.sql`. Prisma only reads `migration.sql`, so a plain
 * `--from-migrations packages/db/prisma/migrations` would see every column a
 * contract deletes as still present and generate the deletion again. The
 * synthetic directory below holds every real folder's `migration.sql`, the
 * lock file, and one last folder (`zzzz_contracts`, which sorts after every
 * timestamped folder) that concatenates every `contract.sql` in folder order.
 * Prisma replays it in its own shadow database (it never touches another one).
 *
 * "All migrations, then all contracts" reproduces production for drops, but
 * not always for enum labels: a scheduled enum rebuild keeps a label instead
 * when something depends on the column (a view, policy, trigger or function).
 * `filterDiff` drops exactly those `kept-only` rebuild blocks (shared rule:
 * `classifyEnumRebuild` in sql.mjs; CI check 1 uses the same function).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma, SCHEMA_DIR } from "./prisma.mjs";
import {
  CONTRACT_FILE,
  catalogFromSql,
  classifyEnumRebuild,
  ENUM_REBUILD_MAX_BYTES,
  findEnumRebuilds,
  keptLabelNote,
  parseTemplateHeader,
  splitStatements,
  summarizeEffects,
} from "./sql.mjs";

/** The synthetic last folder; sorts after every `<14 digits>_name` and `0_init`. */
export const CONTRACTS_FOLDER = "zzzz_contracts";

/** The enum line of the generator's and CI's "Deleted …" section. */
export const ENUM_KEPT_CAVEAT = `if the table is larger than ${ENUM_REBUILD_MAX_BYTES / 1024 / 1024} MB, or something else in the database uses the column (a view, policy, trigger or function), the unused value is kept instead`;

/**
 * Labels a contract run kept, from its `knowledge-base:label-kept "E" "L" (…)`
 * notices: enum name → labels.
 * @param {Iterable<string>} messages
 * @returns {Map<string, string[]>}
 */
export function keptLabelsFromNotices(messages) {
  const out = new Map();
  const unquote = (text) => text.replaceAll('""', '"');
  for (const message of messages) {
    const match = /^knowledge-base:label-kept "((?:[^"]|"")*)" "((?:[^"]|"")*)"/.exec(
      String(message),
    );
    if (!match) continue;
    const [enumName, label] = [unquote(match[1]), unquote(match[2])];
    const labels = out.get(enumName) ?? [];
    if (!labels.includes(label)) labels.push(label);
    out.set(enumName, labels);
  }
  return out;
}

const LOCK_FILE = 'provider = "postgresql"\n';

/**
 * Build the synthetic migrations directory (§1.3).
 * @param {Array<{ name: string, sql: string, contract: { sql: string } | null }>} migrations folder order
 * @param {{ lockFile?: string }} [options] the real migration_lock.toml text
 * @returns {{ dir: string, contracts: number, cleanup: () => void }}
 */
export function syntheticMigrationsDir(migrations, { lockFile = LOCK_FILE } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "knowledge-base-diff-source-"));
  writeFileSync(path.join(dir, "migration_lock.toml"), lockFile);
  const contracts = [];
  for (const migration of migrations) {
    mkdirSync(path.join(dir, migration.name));
    writeFileSync(path.join(dir, migration.name, "migration.sql"), migration.sql);
    if (migration.contract)
      contracts.push(`-- ${migration.name}/${CONTRACT_FILE}\n${migration.contract.sql.trim()}\n`);
  }
  if (contracts.length) {
    mkdirSync(path.join(dir, CONTRACTS_FOLDER));
    writeFileSync(path.join(dir, CONTRACTS_FOLDER, "migration.sql"), contracts.join("\n"));
  }
  return {
    dir,
    contracts: contracts.length,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * `prisma migrate diff --from-migrations <synthetic> --to-schema SCHEMA_DIR --script`.
 * @param {string} dir synthetic directory
 * @param {{ env?: NodeJS.ProcessEnv, schemaDir?: string, run?: typeof prisma }} [options]
 * @returns {Promise<{ ok: boolean, sql: string, stderr: string }>}
 */
export async function diffToSchema(dir, { env, schemaDir = SCHEMA_DIR, run = prisma } = {}) {
  const result = await run(
    ["migrate", "diff", "--from-migrations", dir, "--to-schema", schemaDir, "--script"],
    { capture: true, env },
  );
  return { ok: result.code === 0, sql: result.stdout, stderr: result.stderr };
}

/**
 * The static pre-change catalog: `prisma migrate diff --from-empty
 * --to-migrations <synthetic> --script` (Step 0 e), folded by catalogFromSql.
 * @param {string} dir synthetic directory
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof prisma }} [options]
 */
export async function staticCatalog(dir, { env, run = prisma } = {}) {
  const result = await run(
    ["migrate", "diff", "--from-empty", "--to-migrations", dir, "--script"],
    { capture: true, env },
  );
  if (result.code !== 0)
    return { ok: false, catalog: null, stderr: result.stderr || result.stdout };
  return { ok: true, catalog: catalogFromSql(result.stdout), stderr: "" };
}

/**
 * Labels an existing contract.sql already removes, per enum name (from the
 * `-- knowledge-base:enum-remove` headers): the labels that may linger as kept.
 * @param {Array<{ contract: { sql: string } | null }>} migrations
 * @returns {Map<string, string[]>}
 */
export function priorRemovedLabels(migrations) {
  const out = new Map();
  for (const migration of migrations) {
    if (!migration.contract) continue;
    for (const line of migration.contract.sql.split("\n")) {
      const header = parseTemplateHeader(line);
      if (header?.kind !== "enum-remove" || header.malformed) continue;
      const labels = out.get(header.enumName) ?? [];
      for (const { from } of header.pairs) if (!labels.includes(from)) labels.push(from);
      out.set(header.enumName, labels);
    }
  }
  return out;
}

/**
 * Columns an existing contract.sql deletes, with their type before deletion
 * (for `--recover`): "schema.table.column" → normalized type.
 * @param {Array<{ name: string, sql: string, contract: { sql: string } | null }>} migrations
 */
export function retiredColumnTypes(migrations) {
  const out = new Map();
  let catalog = catalogFromSql([]);
  for (const migration of migrations) {
    catalog = catalogFromSql(migration.sql, catalog);
    if (migration.contract) {
      const { droppedColumns } = summarizeEffects(migration.contract.sql, {
        folder: migration.name,
      });
      for (const key of droppedColumns) {
        const at = key.lastIndexOf(".");
        const column = catalog.tables.get(key.slice(0, at))?.columns.get(key.slice(at + 1));
        if (column) out.set(key, column.type);
      }
      catalog = catalogFromSql(migration.contract.sql, catalog);
    }
  }
  return out;
}

/**
 * Drop the enum rebuild blocks that only remove labels an earlier contract
 * already removes (`kept-only`, §1.3) from a diff script.
 * @param {string} script Prisma's `--script` output
 * @param {ReturnType<typeof catalogFromSql>} catalog the "from" side (staticCatalog)
 * @param {Map<string, string[]>} priorRemoved from priorRemovedLabels
 * @returns {{ sql: string, empty: boolean, notes: string[],
 *   blocks: Array<{ enumName: string, kind: string, newRemoved: string[] }> }}
 */
export function filterDiff(script, catalog, priorRemoved) {
  const notes = [];
  const blocks = [];
  let sql = script;
  const found = findEnumRebuilds(script);
  for (const block of [...found].reverse()) {
    const verdict = classifyEnumRebuild(block, catalog, priorRemoved.get(block.enum.name) ?? []);
    blocks.unshift({
      enumName: block.enum.name,
      kind: verdict.kind,
      newRemoved: verdict.newRemoved,
    });
    if (verdict.kind !== "kept-only") continue;
    for (const label of verdict.removed) notes.unshift(keptLabelNote(block.enum.name, label));
    let end = block.to;
    while (sql[end] === "\n" || sql[end] === "\r") end++;
    sql = sql.slice(0, block.from) + sql.slice(end);
  }
  let empty;
  try {
    empty = splitStatements(sql).length === 0;
  } catch {
    empty = false;
  }
  return { sql, empty, notes, blocks };
}
