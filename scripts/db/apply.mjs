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
 * marked applied instead, so its changes are never run twice. Before it
 * touches the history it takes the migration runner lock (the key every
 * production runner and offline restore takes) and refuses while any other
 * session is applying a migration or holds the KB lifecycle (DADP) lock, like
 * the production runner, and while a KB restore is pending: a row with no
 * finished_at might belong to a deploy that is still running, and marking it
 * rolled back would let its migration run twice. It never resets the
 * database — divergence prints the `pnpm db:reset:local`
 * command for you to run explicitly.
 *
 * After pulling a release squash, the migrations this database applied one by
 * one are reconciled onto the release folder first, exactly like the deploy
 * runner does (scripts/db/lib/replaces.mjs).
 */
import { fileURLToPath } from "node:url";
import { assertLocal } from "./lib/local.mjs";
import {
  migrationInFlight,
  pgConnectionString,
  prismaSchemaName,
  readMigrationState,
  readMigrationsFolder,
  tryHoldRunnerLock,
} from "./lib/migration-state.mjs";
import { loadPg, MIGRATIONS_DIR, prisma } from "./lib/prisma.mjs";
import {
  applyReconcile,
  needsReconcile,
  planReconcile,
  READ_HISTORY_SQL,
  readReleases,
} from "./lib/replaces.mjs";
import { COMMIT_SENTINEL, checkWrapper } from "./lib/sql.mjs";

const IN_FLIGHT_HELP =
  "Nothing was changed. Wait for it to finish and re-run `pnpm db:migrate:apply`. If nothing should be\n" +
  "migrating, find the session holding the advisory lock (pg_locks, keys 72707369/72707370/1145389648).";
const RESTORE_PENDING =
  "FATAL: offline KB restore is pending; finish the same restore attempt before applying migrations.";

/**
 * The wrapper's body with its IO injected (unit tests drive it with a fake
 * `pg` and `prisma`). Returns the process exit code.
 * @param {{ url: string, pg: typeof import("pg"), migrationsDir?: string,
 *   prisma: (args: string[], options: { env: Record<string, string> }) => Promise<{ code: number }> }} deps
 */
export async function applyLocal({ url, pg, prisma: runPrisma, migrationsDir = MIGRATIONS_DIR }) {
  const read = () => readMigrationState({ databaseUrl: url, migrationsDir, pg });
  const first = await read();
  if (first.state === "unreachable") {
    console.error(
      `FATAL: cannot reach your local database (${first.error}). Is it running? Try \`pnpm dev:services\`, then \`pnpm db:worktree\`.`,
    );
    return 1;
  }
  if (first.state === "restore-pending") {
    console.error(RESTORE_PENDING);
    return 1;
  }
  const busy = migrationInFlight(first);
  if (busy) {
    console.error(`FATAL: ${busy}.\n${IN_FLIGHT_HELP}`);
    return 1;
  }
  const lock = await tryHoldRunnerLock({ databaseUrl: url, pg });
  if (!lock) {
    console.error(
      `FATAL: ${migrationInFlight({ inProgress: false, runnerActive: true })}.\n${IN_FLIGHT_HELP}`,
    );
    return 1;
  }
  try {
    return await applyHoldingLock({ url, pg, read, prisma: runPrisma, migrationsDir });
  } finally {
    await lock.release();
  }
}

async function applyHoldingLock({ url, pg, read, prisma, migrationsDir }) {
  const env = { DATABASE_URL: url };
  // Re-read under the lock: our own session now holds the runner key, so only
  // Prisma's lock and the KB lifecycle lock still tell us someone else is
  // mid-migration (or mid-snapshot).
  let state = await read();
  if (state.state === "restore-pending") {
    console.error(RESTORE_PENDING);
    return 1;
  }
  if (state.state === "unreachable") {
    console.error(
      `FATAL: cannot reach your local database (${state.error}). Is it running? Try \`pnpm dev:services\`, then \`pnpm db:worktree\`.`,
    );
    return 1;
  }
  const busyNow = migrationInFlight({ ...state, runnerActive: false });
  if (busyNow) {
    console.error(`FATAL: ${busyNow}.\n${IN_FLIGHT_HELP}`);
    return 1;
  }
  if (state.state === "no-history-nonempty") {
    console.error(
      "FATAL: your local database has tables but no migration history (something other than these migrations created them).\n" +
        "It is disposable local data, so recreate it from the migrations:\n\n  pnpm db:reset:local\n",
    );
    return 1;
  }
  const manifests = readReleases(migrationsDir);
  if (manifests.problems.length) {
    console.error(
      `FATAL: this checkout's release manifests are not intact: ${manifests.problems.join("; ")}.\n` +
        "A release folder's replaced/ copies must match its replaces.json; restore them from git.",
    );
    return 1;
  }
  if (state.state === "db-ahead" && needsReconcile(state, manifests.releases)) {
    const code = await reconcileLocal({
      url,
      pg,
      state,
      releases: manifests.releases,
      migrations: readMigrationsFolder(migrationsDir),
    });
    if (code !== 0) return code;
    state = await read();
  }
  if (state.state === "db-ahead") {
    console.error(
      `FATAL: your local database has migration(s) this checkout does not: ${state.ahead.join(", ")}\n` +
        "(another branch, or a migration folder that was renamed by db:migrate:rebase). Recreate it:\n\n  pnpm db:reset:local\n",
    );
    return 1;
  }
  if (state.checksumMismatch.length) {
    console.error(
      `WARNING: migration(s) edited after you applied them locally: ${state.checksumMismatch.join(", ")}.\n` +
        "The database does not re-run edits. If the edit matters, run `pnpm db:reset:local`.",
    );
  }
  if (state.state === "failed") {
    const byName = new Map(readMigrationsFolder(migrationsDir).map((m) => [m.name, m]));
    for (const failure of state.failed) {
      const migration = byName.get(failure.name);
      if (!migration || !checkWrapper(migration.sql).ok) {
        console.error(
          `FATAL: migration ${failure.name} failed earlier and is not transactional, so part of it may be applied.\n` +
            "This is local data: fix the SQL, then run `pnpm db:reset:local`.",
        );
        return 1;
      }
      if (failure.logs === COMMIT_SENTINEL) {
        if (failure.checksum && failure.checksum !== migration.checksum) {
          console.error(
            `FATAL: migration ${failure.name} committed, but its file has changed since. This is local data: run \`pnpm db:reset:local\`.`,
          );
          return 1;
        }
        console.log(
          `Migration ${failure.name} was interrupted after it committed; marking it applied (not re-running it).`,
        );
        const applied = await prisma(["migrate", "resolve", "--applied", failure.name], { env });
        if (applied.code !== 0) return applied.code;
        continue;
      }
      console.log(
        `Migration ${failure.name} failed earlier and was rolled back; marking it rolled back and retrying.`,
      );
      const resolved = await prisma(["migrate", "resolve", "--rolled-back", failure.name], { env });
      if (resolved.code !== 0) return resolved.code;
    }
  }
  const deployed = await prisma(["migrate", "deploy"], { env });
  if (deployed.code !== 0) {
    console.error(
      "\nFATAL: a migration failed. If it is transactional (first line `-- knowledge-base:transactional`), nothing from it\n" +
        "was applied: fix the SQL and re-run `pnpm db:migrate:apply`. Otherwise run `pnpm db:reset:local`.",
    );
    return deployed.code;
  }
  const scheduled = readMigrationsFolder(migrationsDir).filter((m) => m.contract).length;
  if (scheduled)
    console.log(
      `${scheduled} scheduled deletion(s) are not applied locally; \`pnpm db:reset:local\` applies them.`,
    );
  const generated = await prisma(["generate"], { env });
  return generated.code;
}

/** Reconcile replaced migrations onto their release folder (one transaction per release). */
async function reconcileLocal({ url, pg, state, releases, migrations }) {
  const client = new pg.Client({ connectionString: pgConnectionString(url) });
  await client.connect();
  try {
    const schema = prismaSchemaName(url);
    const { rows } = await client.query(READ_HISTORY_SQL(schema));
    const plan = planReconcile({ rows, releases, localNames: state.local });
    if (plan.refusals.length) {
      console.error(
        `FATAL: ${plan.refusals.join(" ")}\nThis is local data: \`pnpm db:reset:local\` rebuilds it from this checkout.`,
      );
      return 1;
    }
    for (const step of plan.steps) {
      const result = await applyReconcile(client, {
        schema,
        step,
        releases,
        localNames: state.local,
        migrations,
        log: (message) => console.log(message),
      });
      console.log(
        `Release ${step.release.name}: reconciled the ${step.present.length} replaced migration(s) you had applied` +
          `${result.applied.length ? ` (applied the missing ${result.applied.join(", ")})` : ""}.`,
      );
    }
    return 0;
  } catch (error) {
    console.error(
      `FATAL: release reconciliation failed and was rolled back: ${error instanceof Error ? error.message : String(error)}\n` +
        "This is local data: `pnpm db:reset:local` rebuilds it from this checkout.",
    );
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const url = assertLocal("db:migrate:apply");
  process.exit(await applyLocal({ url, pg: loadPg(), prisma }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
