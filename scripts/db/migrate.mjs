#!/usr/bin/env node
/**
 * `pnpm db:migrate <name>` — GENERATE a migration. Applies nothing.
 *
 *   pnpm db:migrate add_project_archive      diff migrations → schema
 *   pnpm db:migrate drop_status_b --remap 'Status.B=A'
 *                                            an enum value removal: which value
 *                                            existing rows become (ask the user)
 *   pnpm db:migrate restore_notes --recover 'project.notes=notes2'
 *                                            copy a retired column's data into a
 *                                            new column before its deletion runs
 *   pnpm db:migrate backfill_x --empty       wrapped, empty file to hand-write
 *   pnpm db:migrate idx_x --empty --no-transaction
 *                                            unwrapped (CREATE INDEX CONCURRENTLY)
 *
 * Diffs the Prisma schema against what production ends up with: every
 * migration.sql, then every contract.sql (scripts/db/lib/diff-source.mjs).
 * Splits the result (expand and contract, docs/schema-migrations.md):
 *   packages/db/prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql
 *     what changes at deploy, safe for the release that is still running;
 *   …/contract.sql (only when something is deleted)
 *     the deletions, applied by the deploy runner about 7 days later, once no
 *     older release is running.
 * Never applies anything, and never uses Prisma's dev-mode migrate command.
 * Refuses (writing nothing) what cannot be automated, with the next step in
 * plain English.
 *
 * Next: review/edit the SQL, then `pnpm db:migrate:apply`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeEffects } from "./lib/contracts.mjs";
import {
  diffToSchema,
  ENUM_KEPT_CAVEAT,
  filterDiff,
  priorRemovedLabels,
  retiredColumnTypes,
  staticCatalog,
  syntheticMigrationsDir,
} from "./lib/diff-source.mjs";
import { assertLocal } from "./lib/local.mjs";
import { describeUrl, shadowName } from "./lib/local-db-name.mjs";
import { readMigrationsFolder } from "./lib/migration-state.mjs";
import { loadPg, MIGRATIONS_DIR, ROOT } from "./lib/prisma.mjs";
import { adminClient, createDatabase } from "./lib/scratch-db.mjs";
import {
  analyzeContract,
  analyzeMigration,
  CONTRACT_FILE,
  catalogFromSql,
  REVIEWED_MARKER,
  rollbackSafety,
  splitForContract,
  summarizeEffects,
  typeOfFromCatalog,
  wrapTransactional,
} from "./lib/sql.mjs";

export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** A folder prefix strictly after every existing folder name. */
export function nextPrefix(existing, now = new Date()) {
  let date = new Date(now.getTime());
  const latest = [...existing].sort().at(-1);
  const stamp = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(latest ?? "");
  if (stamp) {
    const [, y, mo, d, h, mi, s] = stamp.map(Number);
    const after = new Date(Date.UTC(y, mo - 1, d, h, mi, s) + 1000);
    if (after > date) date = after;
  }
  for (;;) {
    const prefix = timestamp(date);
    if (!latest || `${prefix}_` > latest) return prefix;
    date = new Date(date.getTime() + 1000);
  }
}

const USAGE =
  "usage: pnpm db:migrate <snake_case_name> [--remap 'Enum.OLD=NEW']… [--recover 'table.old=new']… [--empty] [--no-transaction]";

/**
 * Parse the command line (exported for tests).
 * @returns {{ name?: string, empty: boolean, noTransaction: boolean,
 *   remap: Map<string, string>, recover: Array<{ table: string, from: string, to: string }>, errors: string[] }}
 */
export function parseArgs(args) {
  const out = {
    name: undefined,
    empty: false,
    noTransaction: false,
    remap: new Map(),
    recover: [],
    errors: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const [flag, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg];
    const value = () => (inline !== undefined ? inline : args[++i]);
    if (flag === "--empty") out.empty = true;
    else if (flag === "--no-transaction") out.noTransaction = true;
    else if (flag === "--remap") {
      const spec = value() ?? "";
      const match = /^(.+)\.([^.=]+)=(.+)$/.exec(spec);
      if (!match) out.errors.push(`--remap '${spec}': expected 'Enum.OLD=NEW'`);
      else out.remap.set(`${match[1]}.${match[2]}`, match[3]);
    } else if (flag === "--recover") {
      const spec = value() ?? "";
      const match = /^(.+)\.([^.=]+)=([^.=]+)$/.exec(spec);
      if (!match) out.errors.push(`--recover '${spec}': expected 'table.old_column=new_column'`);
      else out.recover.push({ table: match[1], from: match[2], to: match[3] });
    } else if (arg.startsWith("--")) out.errors.push(`unknown flag ${arg}`);
    else if (out.name) out.errors.push(`unexpected argument ${arg}`);
    else out.name = arg;
  }
  if (out.empty && (out.remap.size || out.recover.length))
    out.errors.push("--remap / --recover need a schema diff; they cannot be combined with --empty");
  return out;
}

const knownTablesOf = (catalog) =>
  new Map([...catalog.tables].map(([key, table]) => [key, new Set(table.columns.keys())]));

const NOT_TRANSACTIONAL_NOTE =
  "-- Not transactional: a failure can leave part of this migration applied,\n-- and the deploy runner will stop for a person instead of retrying.";

/**
 * Build both files + their analysis for a generated diff (exported for tests).
 * @param {string} rawSql Prisma's diff (kept-only enum blocks already filtered)
 * @param {{ previous?: string[], catalog?: ReturnType<typeof catalogFromSql>, folder?: string,
 *   noTransaction?: boolean, remap?: Map<string, string>, recover?: Array<{ table: string, from: string, to: string }>,
 *   allowedKept?: Map<string, string[]>, retiredColumns?: Map<string, any>, empty?: boolean }} [options]
 *   catalog: the static pre-change catalog (default: a fold of `previous`).
 */
export function buildMigration(rawSql, options = {}) {
  const folder = options.folder ?? "20990101000000_migration";
  const catalog = options.catalog ?? catalogFromSql(options.previous ?? []);
  const split = options.empty
    ? { migration: [], contract: [], refusals: [], warnings: [], notes: [], enumRemoval: null }
    : splitForContract(rawSql, catalog, {
        folder,
        remap: options.remap,
        allowedKept: options.allowedKept,
        recover: options.recover,
        retiredColumns: options.retiredColumns,
      });
  if (split.refusals.length) return { refusals: split.refusals, split };
  const body = split.migration.length
    ? split.migration.join("\n\n")
    : split.contract.length
      ? "-- Nothing changes at deploy: this migration only schedules deletions (contract.sql)."
      : "";
  const pre = analyzeMigration(body, { folder });
  const wrapped = !options.noTransaction && !pre.concurrently;
  const content = wrapped
    ? wrapTransactional(body)
    : `${NOT_TRANSACTIONAL_NOTE}\n\n${body.trim()}\n`;
  const contract = split.contract.length ? `${split.contract.join("\n\n")}\n` : null;
  const analysis = analyzeMigration(content, {
    folder,
    knownTables: knownTablesOf(catalog),
    typeOf: typeOfFromCatalog(catalog),
  });
  const rollback = rollbackSafety(content, {
    priorTables: new Set(catalog.tables.keys()),
    catalog,
    folder,
  });
  const contractFindings = contract ? analyzeContract(contract, { folder }).findings : [];
  const deletes = contract ? describeEffects(summarizeEffects(contract, { folder })) : null;
  return {
    refusals: [],
    split,
    content,
    contract,
    analysis,
    rollback,
    contractFindings,
    deletes,
    wrapped,
  };
}

/** The human report for a built migration (exported for tests). */
export function report(built, { rel, contractRel }) {
  const lines = [];
  const say = (...more) => lines.push(...more);
  say(`\nWrote ${rel}${built.wrapped ? " (transactional)" : " (NOT transactional)"}`);
  if (built.contract) say(`Wrote ${contractRel} (scheduled deletions)`);
  if (!built.wrapped)
    say(
      built.analysis.concurrently
        ? "  CONCURRENTLY cannot run inside a transaction, so the wrapper was skipped. Keep this migration to that one statement."
        : "  --no-transaction: no BEGIN/COMMIT wrapper. A failure needs a person (no automatic retry).",
    );
  say("\nChanges now (migration.sql, at deploy):");
  if (!built.analysis.destructive.length) say("  Nothing is deleted at deploy.");
  for (const finding of built.analysis.destructive)
    say(`  line ${finding.line}: ${finding.message}`);
  if (built.contract) {
    say(
      `\nDeleted about 7 days after this deploys, once no older release is running (${CONTRACT_FILE}):`,
      `  ${built.deletes}`,
    );
    if (built.split.enumRemoval) say(`  For the enum value: ${ENUM_KEPT_CAVEAT}.`);
    say("  Show this to the user before merge.");
  }
  say(
    built.rollback.safe
      ? `\nRollback to the previous release: possible${built.contract ? " until the deletion runs" : ""}.`
      : `\nRollback to the previous release: not possible (${built.rollback.reasons.join("; ")}).`,
  );
  if (built.analysis.incompatible.length) {
    say("\nThe release that is still running cannot work with this change (CI check 5 fails it):");
    for (const item of built.analysis.incompatible) say(`  line ${item.line}: ${item.what}`);
    say(
      "  A rename: undo it and keep the database name with @map / @@map (docs/schema-changes-recipe.md, Recipe 3).",
      "  A type change: use the two-PR recipe (docs/schema-changes-recipe.md, Recipe 5).",
      "  Anything else: stop and ask the owner.",
    );
  }
  const notAnalyzed = built.analysis.notAnalyzed.filter((item) => item.reviewed === null);
  if (notAnalyzed.length) {
    say(
      `\nNot analyzed (CI check 5 fails these unless the line above the statement is "${REVIEWED_MARKER} <reason>"):`,
    );
    for (const item of notAnalyzed) say(`  line ${item.line}: ${item.reason}`);
  }
  for (const finding of built.contractFindings)
    say(`\n${CONTRACT_FILE} line ${finding.line}: ${finding.message}`);
  if (built.split.warnings.length) {
    say("\nWarnings:");
    for (const warning of built.split.warnings) say(`  - ${warning}`);
  }
  if (built.split.notes.length) {
    say("\nNotes:");
    for (const note of built.split.notes) say(`  - ${note}`);
  }
  say(
    `\nNext: review ${rel}${built.contract ? ` and ${contractRel}` : ""}. A drop + add that is really a rename:` +
      "\ndelete this folder and use @map in the schema instead; a type change: the two-PR recipe (Recipe 5)." +
      "\nAdd a backfill UPDATE if needed, extend packages/db/prisma/fixtures/ if this touches a table with data," +
      "\nthen run `pnpm db:migrate:apply`.",
  );
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.errors.length || !options.name) {
    for (const error of options.errors) console.error(`FATAL: ${error}`);
    console.error(USAGE);
    process.exit(2);
  }
  const { name } = options;
  if (!/^[a-z0-9][a-z0-9_]{0,59}$/.test(name)) {
    console.error(
      `FATAL: migration name "${name}" must be lower_snake_case (a-z, 0-9, _), at most 60 characters.`,
    );
    process.exit(2);
  }
  const existing = readMigrationsFolder(MIGRATIONS_DIR);
  const folder = `${nextPrefix(existing.map((m) => m.name))}_${name}`;
  let built;
  if (options.empty) built = buildMigration("", { empty: true, folder });
  else {
    const url = assertLocal("db:migrate", { shadow: true });
    const pg = loadPg();
    const admin = await adminClient(pg, url);
    try {
      if (await createDatabase(admin, shadowName(describeUrl(url).database)))
        console.log("Created the shadow database.");
    } finally {
      await admin.end();
    }
    const env = { DATABASE_URL: url };
    const lockPath = path.join(MIGRATIONS_DIR, "migration_lock.toml");
    const source = syntheticMigrationsDir(existing, {
      lockFile: existsSync(lockPath) ? readFileSync(lockPath, "utf8") : undefined,
    });
    let diff;
    let base;
    try {
      diff = await diffToSchema(source.dir, { env });
      base = diff.ok ? await staticCatalog(source.dir, { env }) : null;
    } finally {
      source.cleanup();
    }
    if (!diff.ok || !base?.ok) {
      process.stderr.write(diff.ok ? (base?.stderr ?? "") : diff.stderr);
      console.error("FATAL: prisma migrate diff failed (see above). Nothing was written.");
      process.exit(1);
    }
    const priorRemoved = priorRemovedLabels(existing);
    const filtered = filterDiff(diff.sql, base.catalog, priorRemoved);
    if (filtered.empty) {
      for (const note of filtered.notes) console.log(`Note: ${note}`);
      console.log(
        "No schema changes: the migrations already produce packages/db/prisma/schema. Nothing generated.",
      );
      console.log("Writing a data-only migration? Use: pnpm db:migrate <name> --empty");
      return;
    }
    built = buildMigration(filtered.sql, {
      catalog: base.catalog,
      folder,
      noTransaction: options.noTransaction,
      remap: options.remap,
      recover: options.recover,
      allowedKept: priorRemoved,
      retiredColumns: options.recover.length ? retiredColumnTypes(existing) : undefined,
    });
    built.split.notes.unshift(...filtered.notes);
  }
  if (built.refusals.length) {
    console.error("Nothing was written. This change cannot be generated as it is:");
    for (const refusal of built.refusals) console.error(`  - ${refusal}`);
    process.exit(1);
  }
  const dir = path.join(MIGRATIONS_DIR, folder);
  if (existsSync(dir)) throw new Error(`${dir} already exists`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "migration.sql");
  writeFileSync(file, built.content);
  const contractFile = path.join(dir, CONTRACT_FILE);
  if (built.contract) writeFileSync(contractFile, built.contract);
  console.log(
    report(built, {
      rel: path.relative(ROOT, file),
      contractRel: path.relative(ROOT, contractFile),
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
