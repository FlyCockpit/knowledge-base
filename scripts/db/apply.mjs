#!/usr/bin/env node
/**
 * `pnpm db:migrate:apply` — `prisma migrate deploy` on THIS checkout's local
 * database, then `prisma generate`. Run after reviewing/editing a generated
 * migration and after pulling. It applies migration.sql only: a folder's
 * scheduled deletions (contract.sql) are applied by `pnpm db:reset:local`
 * (and in production by the deploy runner, about 7 days later).
 *
 * A local transactional migration that failed is rolled back by PostgreSQL;
 * this wrapper marks it rolled back so you can fix the SQL and re-run. One
 * that was interrupted AFTER its COMMIT (its commit marker is recorded) is
 * marked applied instead, so its changes are never run twice. It
 * never resets the database — divergence prints the `pnpm db:reset:local`
 * command for you to run explicitly.
 */
import { fileURLToPath } from "node:url";
import { assertLocal } from "./lib/local.mjs";
import { readMigrationState, readMigrationsFolder } from "./lib/migration-state.mjs";
import { loadPg, MIGRATIONS_DIR, prisma } from "./lib/prisma.mjs";
import { COMMIT_SENTINEL, checkWrapper } from "./lib/sql.mjs";

async function main() {
  const url = assertLocal("db:migrate:apply");
  const pg = loadPg();
  const env = { DATABASE_URL: url };
  const state = await readMigrationState({ databaseUrl: url, migrationsDir: MIGRATIONS_DIR, pg });
  if (state.state === "restore-pending") {
    console.error(
      "FATAL: offline KB restore is pending; finish the same restore attempt before applying migrations.",
    );
    process.exit(1);
  }
  if (state.state === "unreachable") {
    console.error(
      `FATAL: cannot reach your local database (${state.error}). Is it running? Try \`pnpm dev:services\`, then \`pnpm db:worktree\`.`,
    );
    process.exit(1);
  }
  if (state.state === "no-history-nonempty") {
    console.error(
      "FATAL: your local database has tables but no migration history (something other than these migrations created them).\n" +
        "It is disposable local data, so recreate it from the migrations:\n\n  pnpm db:reset:local\n",
    );
    process.exit(1);
  }
  if (state.state === "db-ahead") {
    console.error(
      `FATAL: your local database has migration(s) this checkout does not: ${state.ahead.join(", ")}\n` +
        "(another branch, or a migration folder that was renamed by db:migrate:rebase). Recreate it:\n\n  pnpm db:reset:local\n",
    );
    process.exit(1);
  }
  if (state.checksumMismatch.length) {
    console.error(
      `WARNING: migration(s) edited after you applied them locally: ${state.checksumMismatch.join(", ")}.\n` +
        "The database does not re-run edits. If the edit matters, run `pnpm db:reset:local`.",
    );
  }
  if (state.state === "failed") {
    const byName = new Map(readMigrationsFolder(MIGRATIONS_DIR).map((m) => [m.name, m]));
    for (const failure of state.failed) {
      const migration = byName.get(failure.name);
      if (!migration || !checkWrapper(migration.sql).ok) {
        console.error(
          `FATAL: migration ${failure.name} failed earlier and is not transactional, so part of it may be applied.\n` +
            "This is local data: fix the SQL, then run `pnpm db:reset:local`.",
        );
        process.exit(1);
      }
      if (failure.logs === COMMIT_SENTINEL) {
        if (failure.checksum && failure.checksum !== migration.checksum) {
          console.error(
            `FATAL: migration ${failure.name} committed, but its file has changed since. This is local data: run \`pnpm db:reset:local\`.`,
          );
          process.exit(1);
        }
        console.log(
          `Migration ${failure.name} was interrupted after it committed; marking it applied (not re-running it).`,
        );
        const applied = await prisma(["migrate", "resolve", "--applied", failure.name], { env });
        if (applied.code !== 0) process.exit(applied.code);
        continue;
      }
      console.log(
        `Migration ${failure.name} failed earlier and was rolled back; marking it rolled back and retrying.`,
      );
      const resolved = await prisma(["migrate", "resolve", "--rolled-back", failure.name], { env });
      if (resolved.code !== 0) process.exit(resolved.code);
    }
  }
  const deployed = await prisma(["migrate", "deploy"], { env });
  if (deployed.code !== 0) {
    console.error(
      "\nFATAL: a migration failed. If it is transactional (first line `-- knowledge-base:transactional`), nothing from it\n" +
        "was applied: fix the SQL and re-run `pnpm db:migrate:apply`. Otherwise run `pnpm db:reset:local`.",
    );
    process.exit(deployed.code);
  }
  const scheduled = readMigrationsFolder(MIGRATIONS_DIR).filter((m) => m.contract).length;
  if (scheduled)
    console.log(
      `${scheduled} scheduled deletion(s) are not applied locally; \`pnpm db:reset:local\` applies them.`,
    );
  const generated = await prisma(["generate"], { env });
  process.exit(generated.code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
