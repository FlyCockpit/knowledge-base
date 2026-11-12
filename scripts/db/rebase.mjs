#!/usr/bin/env node
/**
 * `pnpm db:migrate:rebase [--base <ref>]` — after rebasing onto the default
 * branch, keep this branch's migrations ordered after the base's.
 *
 *   1. Detect: do this branch's migration folders (not on <base>) all sort
 *      after <base>'s latest folder? If yes, nothing is renamed.
 *   2. Only if not: re-timestamp those folders (migration.sql and contract.sql
 *      move together), and rename matching packages/db/prisma/fixtures/<folder>.sql
 *      / .check.sql. The SQL bytes are untouched, except the generated
 *      enum-remove blocks, whose object names hash the folder name: they are
 *      regenerated for the new name.
 *   3. Consistency check (CI check 1) against the shadow DB: the schema diffed
 *      against every migration.sql, then every contract.sql
 *      (scripts/db/lib/diff-source.mjs). A residue made only of enum values a
 *      scheduled deletion kept on purpose counts as consistent.
 *   4. Never resets this checkout's DB. If it has diverged (renamed folders
 *      were applied under the old name), print `pnpm db:reset:local`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffToSchema,
  filterDiff,
  priorRemovedLabels,
  staticCatalog,
  syntheticMigrationsDir,
} from "./lib/diff-source.mjs";
import { assertLocal, defaultBaseRef, migrationFoldersAt } from "./lib/local.mjs";
import { describeUrl, shadowName } from "./lib/local-db-name.mjs";
import { readMigrationState, readMigrationsFolder } from "./lib/migration-state.mjs";
import { FIXTURES_DIR, loadPg, MIGRATIONS_DIR } from "./lib/prisma.mjs";
import { adminClient, createDatabase } from "./lib/scratch-db.mjs";
import { CONTRACT_FILE, parseTemplateHeader, TEMPLATES } from "./lib/sql.mjs";
import { nextPrefix } from "./migrate.mjs";

/** Pure planning step (exported for tests). */
export function planRebase(baseFolders, localFolders, now = new Date()) {
  const base = new Set(baseFolders);
  const own = localFolders.filter((name) => !base.has(name)).sort();
  const latestBase = [...baseFolders].sort().at(-1);
  if (!latestBase || own.every((name) => name > latestBase)) return { own, renames: [] };
  const renames = [];
  const taken = [...baseFolders].sort();
  for (const name of own) {
    const suffix = name.replace(/^[^_]*_/, "");
    const prefix = nextPrefix(taken, now);
    const to = `${prefix}_${suffix}`;
    renames.push({ from: name, to });
    taken.push(to);
    taken.sort();
  }
  return { own, renames };
}

/**
 * Regenerate the enum-remove blocks of a renamed folder (exported for tests).
 * Only exact generated text is replaced; anything else is left as it is (CI
 * check 5 then reports a block that does not match).
 * @param {string} sql migration.sql or contract.sql
 * @param {string} from old folder name
 * @param {string} to new folder name
 */
export function retargetTemplates(sql, from, to) {
  let out = sql;
  for (const line of sql.split("\n")) {
    const header = parseTemplateHeader(line);
    const set = header?.version ? TEMPLATES[header.version] : undefined;
    if (header?.kind !== "enum-remove" || header.malformed || !set) continue;
    for (const make of [set.enumRemoveExpand, set.enumRemoveContract]) {
      let before;
      let after;
      try {
        before = make({ ...header, folder: from });
        after = make({ ...header, folder: to });
      } catch {
        continue;
      }
      out = out.replace(before, () => after);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex >= 0 ? args[baseIndex + 1] : defaultBaseRef();
  if (!baseRef) {
    console.error("FATAL: cannot determine the base branch; pass --base origin/<default-branch>.");
    process.exit(2);
  }
  const url = assertLocal("db:migrate:rebase", { shadow: true });
  const baseFolders = migrationFoldersAt(baseRef);
  const localFolders = readMigrationsFolder(MIGRATIONS_DIR).map((m) => m.name);
  const missing = baseFolders.filter((name) => !localFolders.includes(name));
  if (missing.length) {
    console.error(
      `FATAL: ${baseRef} has migration(s) this checkout lacks: ${missing.join(", ")}. Rebase onto ${baseRef} first.`,
    );
    process.exit(1);
  }
  const plan = planRebase(baseFolders, localFolders);
  if (!plan.own.length) console.log(`No branch-only migrations relative to ${baseRef}.`);
  else if (!plan.renames.length)
    console.log(`Ordering OK: ${plan.own.join(", ")} sort after ${baseRef}'s latest migration.`);
  for (const { from, to } of plan.renames) {
    // Fixtures first, the folder last: an interruption never leaves a renamed
    // migration whose fixtures still carry the old name and silently stop
    // being loaded by check 4.
    if (existsSync(FIXTURES_DIR)) {
      for (const file of readdirSync(FIXTURES_DIR)) {
        if (file === `${from}.sql` || file === `${from}.check.sql`) {
          renameSync(
            path.join(FIXTURES_DIR, file),
            path.join(FIXTURES_DIR, file.replace(from, to)),
          );
        }
      }
    }
    let retargeted = false;
    for (const file of ["migration.sql", CONTRACT_FILE]) {
      const full = path.join(MIGRATIONS_DIR, from, file);
      if (!existsSync(full)) continue;
      const before = readFileSync(full, "utf8");
      const after = retargetTemplates(before, from, to);
      if (after !== before) {
        writeFileSync(full, after);
        retargeted = true;
      }
    }
    renameSync(path.join(MIGRATIONS_DIR, from), path.join(MIGRATIONS_DIR, to));
    console.log(
      `renamed ${from} -> ${to} (${retargeted ? "generated enum-remove blocks regenerated for the new name; other SQL unchanged" : "SQL unchanged"})`,
    );
  }

  const pg = loadPg();
  const admin = await adminClient(pg, url);
  try {
    await createDatabase(admin, shadowName(describeUrl(url).database));
  } finally {
    await admin.end();
  }
  const env = { DATABASE_URL: url };
  const migrations = readMigrationsFolder(MIGRATIONS_DIR);
  const lockPath = path.join(MIGRATIONS_DIR, "migration_lock.toml");
  const source = syntheticMigrationsDir(migrations, {
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
    console.error("FAIL consistency: prisma migrate diff errored (see above).");
    process.exitCode = 1;
  } else {
    const filtered = filterDiff(diff.sql, base.catalog, priorRemovedLabels(migrations));
    for (const note of filtered.notes) console.log(`Note: ${note}`);
    if (!filtered.empty) {
      console.error(
        "FAIL consistency: the migrations (then their scheduled deletions) do not produce packages/db/prisma/schema. Missing SQL:\n\n" +
          filtered.sql +
          "\nGenerate it with `pnpm db:migrate <name>` (or fix the hand-edited migration).",
      );
      process.exitCode = 1;
    } else console.log("Consistency OK: migrations reproduce the Prisma schema.");
  }

  const state = await readMigrationState({ databaseUrl: url, migrationsDir: MIGRATIONS_DIR, pg });
  if (
    ["db-ahead", "failed", "no-history-nonempty"].includes(state.state) ||
    state.checksumMismatch.length
  ) {
    console.log(
      `\nYour local database has diverged from these migrations (${state.state}${state.ahead.length ? `: ${state.ahead.join(", ")}` : ""}).` +
        "\nIt is disposable local data. Recreate it explicitly with:\n\n  pnpm db:reset:local\n",
    );
  } else if (state.state === "pending") {
    console.log("\nLocal database is behind; run `pnpm db:migrate:apply`.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
