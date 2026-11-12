#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
/**
 * Container migration runner (app + worker images).
 *
 *   node scripts/db/migrate-runtime.mjs apply   (default)
 *     The `migrate` image command and MIGRATE_ON_START=true. Classifies the
 *     database, refuses unsafe states, runs the optional pre-migration backup,
 *     then `prisma migrate deploy`. Exits 0 only when the DB is up to date.
 *
 *     Everything from the first classification to the final check runs while
 *     this process holds the migration runner lock (a session advisory lock,
 *     MIGRATION_RUNNER_LOCK_KEY), so two leaders (Dokploy app + worker both
 *     with MIGRATE_ON_START=true) never interleave: the second waits, then
 *     re-reads the state and normally finds it up to date. If the lock is
 *     still held after WAIT_TIMEOUT_MS it exits 1 and the platform restarts
 *     it, which is expected when the other leader's backup + deploy is longer.
 *
 *     After the database is up to date (also when nothing was pending) it
 *     records the image's migrations in `_knowledge_base_migration`, registers this
 *     instance (KB_INSTANCE_ID, set by the entrypoint), then runs the
 *     scheduled deletions phase: each folder's optional `contract.sql`, once
 *     no release that still uses what it deletes can be running
 *     (scripts/db/lib/contracts.mjs). That phase never fails the start: its
 *     errors are logged and the runner still exits 0.
 *
 *   node scripts/db/migrate-runtime.mjs wait
 *     Followers (MIGRATE_ON_START=false, dedicated worker). Read-only except
 *     for registering this instance: waits up to a fixed 300 s for
 *     `up-to-date`; refuses a failed migration that no runner is working on,
 *     or a non-empty database with no history.
 *
 *   --role server|worker names this instance in the registry (both modes).
 *
 *   node scripts/db/migrate-runtime.mjs hold [days]      (default 7, 1..90)
 *   node scripts/db/migrate-runtime.mjs hold --clear
 *     The `hold-deletions` image command (owner, one-shot). Pauses every
 *     scheduled deletion for `days` (the `owner` row in `_knowledge_base_hold`; an
 *     existing later hold is never shortened), or removes that row. Takes
 *     the runner lock and creates the runner-owned tables if needed. Use it
 *     after a restore the runner cannot detect, before starting the app.
 *
 * Every pending migration must be safe for the release that is still
 * running. An in-place drop, rename or type change, unattested unreadable
 * SQL, or the retired `-- requires: maintenance-deploy` marker is refused
 * outright (no override) unless the database is brand new; the fix is the
 * expand/contract recipes in docs/schema-changes-recipe.md.
 *
 * db-ahead (this image is older than the database, a rollback): admitted
 * only when every migration the image lacks is recorded as rollback-safe and
 * its scheduled deletion has not run (`admit`); the instance then registers,
 * which pauses scheduled deletions while it runs. Otherwise refused.
 *
 * Auto-recovery applies only to files with the generator's intact wrapper
 * (`-- knowledge-base:transactional`, BEGIN … commit marker, COMMIT). The commit
 * marker is the wrapper's last statement inside the transaction, so it shows
 * which side of COMMIT an interrupted attempt died on:
 *   - marker recorded → the transaction COMMITTED (e.g. the process was killed
 *     before Prisma recorded success): mark it applied
 *     (`prisma migrate resolve --applied`). It is never run a second time.
 *   - marker absent → PostgreSQL rolled the whole file back: mark it rolled
 *     back (`prisma migrate resolve --rolled-back`) and retry ONCE.
 * Anything else stops for a person: docs/schema-migrations.md § Recovery
 * runbook.
 *
 * An applied migration whose file changed since (checksum mismatch) is a
 * refusal in both modes: the running schema is not what the image describes.
 *
 * Never prints DATABASE_URL.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  admit,
  applyContract,
  checkClusterIdentity,
  ensureRuntimeTables,
  holdUpsertSql,
  imageContains,
  lateRecoveries,
  nameReuseLive,
  planContracts,
  pruneInstances,
  readLiveCatalog,
  readPlanInputs,
  recordApplied,
  runtimeTablesExist,
  scheduleLines,
  validateContract,
} from "./lib/contracts.mjs";
import {
  assertNoPendingRestore,
  isManagedSchemaEmpty,
  KB_DDL_LOCK_KEY,
  MIGRATION_RUNNER_LOCK_KEY,
  PRISMA_ADVISORY_LOCK,
  pgConnectionString,
  prismaSchemaName,
  readApplicationCatalog,
  readMigrationState,
  readMigrationsFolder,
  safeError,
} from "./lib/migration-state.mjs";
import { loadPg, MIGRATIONS_DIR, prisma, ROOT, SCHEMA_DIR } from "./lib/prisma.mjs";
import {
  analyzeMigration,
  COMMIT_SENTINEL,
  catalogFromSql,
  checkWrapper,
  emptyCatalog,
  findNameReuse,
  markers,
  RETIRED_MAINTENANCE_MARKER,
  summarizeEffects,
  typeOfFromCatalog,
  unwrapBody,
} from "./lib/sql.mjs";

// Startup budget. scripts/check-docker-copy.ts parses every constant below
// (and REGISTER_TIMEOUT_MS / CONTRACT_PREAMBLE_TIMEOUT_MS from
// lib/contracts.mjs) and requires the images' HEALTHCHECK start-period to
// exceed their sum, so every timed step of a start is counted once.

/** Connection retries plus the runner lock wait (apply), or the follower wait (wait), from process start. */
export const WAIT_TIMEOUT_MS = 300_000;
/** The pre-deploy gate's catalog read (readLiveCatalog without defaults), all queries together. */
export const PREDEPLOY_CATALOG_TIMEOUT_MS = 10_000;
/**
 * Clock for the scheduled deletions phase, started after its backup. A
 * contract starts only with ≥ CONTRACT_START_MIN_MS (20 s) of it left, and
 * every contract statement ends by it; only the bookkeeping of the contract
 * running at the deadline (≤ CONTRACT_PREAMBLE_TIMEOUT_MS) runs past it.
 */
export const CONTRACT_RUN_BUDGET_MS = 30_000;
/** Child timeout of the image-schema diff (`prisma migrate diff --from-empty --to-schema`). */
export const IMAGE_SCHEMA_TIMEOUT_MS = 20_000;
/** The scheduled deletions phase's catalog read (readLiveCatalog with defaults), all queries together. */
export const CONTRACTS_CATALOG_TIMEOUT_MS = 5_000;
/**
 * Statement and lock timeout of the scheduled-deletion session's own steps
 * on the runner-owned tables (session defaults; transactions that need
 * another bound set their own).
 */
export const RUNTIME_STEP_TIMEOUT_MS = 2_000;
/**
 * Those steps per start, each counted as one lock wait (the runner-owned
 * tables are written only under the runner lock): record the applied
 * migrations, the identity check, the plan, the prune, the schedule log.
 * Registration has its own REGISTER_TIMEOUT_MS.
 */
export const RUNTIME_STEPS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNBOOK = "docs/schema-migrations.md § Recovery runbook";
const NO_HISTORY = "docs/schema-migrations.md § A database with tables but no migration history";
const RUNNER_APP_NAME = "knowledge-base-migrate-runner";
const TYPE_CHANGE_RECIPE = "docs/schema-changes-recipe.md § Recipe 5 — Backfill or change a type";

const log = (message) => console.log(`[migrate] ${message}`);
const warn = (message) => console.error(`[migrate] WARNING: ${message}`);
const loud = (lines) => {
  const bar = "!".repeat(72);
  console.error([bar, ...lines.map((line) => `[migrate] ${line}`), bar].join("\n"));
};

class Refusal extends Error {}

/**
 * @typedef {{ imageCatalog?: () => Promise<ReturnType<typeof emptyCatalog> | Error>,
 *   budgetMs?: number, now?: () => number }} ContractOptions
 *   Test seams for the scheduled deletions phase; `false` skips the phase.
 */

/**
 * @param {{ mode?: "apply" | "wait", role?: string, env?: NodeJS.ProcessEnv, migrationsDir?: string,
 *   pg?: typeof import("pg"), runPrisma?: typeof prisma, backupHook?: string,
 *   waitTimeoutMs?: number, pollMs?: number, connectRetryMs?: number,
 *   contracts?: ContractOptions | false }} [options]
 * @returns {Promise<number>} exit code
 */
export async function run(options = {}) {
  const mode = options.mode ?? "apply";
  const env = options.env ?? process.env;
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const pg = options.pg ?? loadPg();
  const runPrisma = options.runPrisma ?? prisma;
  const backupHook = options.backupHook ?? path.join(ROOT, "scripts/backup/pre-migrate.sh");
  const databaseUrl = env.DATABASE_URL;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(name, cancel);
  try {
    if (!databaseUrl) throw new Refusal("DATABASE_URL is not set.");
    const role = options.role ?? "server";
    if (role !== "server" && role !== "worker")
      throw new Refusal(`--role must be "server" or "worker" (got "${role}").`);
    const instanceId = env.KB_INSTANCE_ID || null;
    if (instanceId && !UUID.test(instanceId))
      throw new Refusal("KB_INSTANCE_ID is not a UUID (the entrypoint sets it; leave it unset).");
    const ctx = {
      abort,
      env,
      databaseUrl,
      migrationsDir,
      pg,
      runPrisma: async (args, options = {}) => {
        if (abort.signal.aborted) throw new Refusal("Migration cancelled before native start.");
        const result = await runPrisma(args, { ...options, signal: abort.signal });
        if (abort.signal.aborted || result.timedOut)
          throw new Refusal(
            "Migration cancelled or timed out; owned children drained, stopping before recovery or retry.",
          );
        return result;
      },
      backupHook,
      schema: prismaSchemaName(databaseUrl),
      role,
      instanceId,
      host: hostname(),
      contracts: options.contracts ?? {},
      state: (client) => readMigrationState({ databaseUrl, migrationsDir, pg, client }),
    };
    if (mode === "wait") return await waitMode(ctx, options);
    if (mode !== "apply") throw new Refusal(`unknown mode "${mode}" (use apply or wait).`);
    return await applyMode(ctx, options);
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`[migrate] FATAL: ${error.message}`);
      return 1;
    }
    console.error(`[migrate] FATAL: ${safeError(error)}`);
    return 1;
  } finally {
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeListener(name, cancel);
  }
}

async function readyState(ctx, options, waitDeadline = Number.POSITIVE_INFINITY) {
  // The database may still be starting next to us (Dokploy compose). Retry
  // connection failures briefly; every other state is answered immediately.
  const deadline = Math.min(waitDeadline, Date.now() + (options.connectRetryMs ?? 60_000));
  for (;;) {
    if (ctx.abort?.signal.aborted) throw new Refusal("Migration runner cancelled.");
    const state = await ctx.state();
    if (state.state !== "unreachable" || Date.now() >= deadline) return state;
    warn(`database unreachable (${state.error}); retrying…`);
    await delay(options.pollMs ?? 3_000);
  }
}

function refuseCommon(state) {
  if (state.state === "restore-pending") throw new Refusal(state.error);
  if (state.state === "unreachable") {
    throw new Refusal(
      `cannot reach the database (${state.error}). Check DATABASE_URL and the network. ${RUNBOOK}.`,
    );
  }
  if (state.state === "no-history-nonempty") {
    throw new Refusal(
      "the database already has tables but no Prisma migration history (_prisma_migrations), so this " +
        "runner cannot tell what schema it holds. Check that DATABASE_URL names this app's database. " +
        `This runner never adopts an existing schema automatically. See ${NO_HISTORY}.`,
    );
  }
}

/** db-ahead where admission does not apply (mid-run, or with pending/failed migrations). */
function refuseAhead(state, why = "") {
  if (state.state !== "db-ahead") return;
  throw new Refusal(
    `the database has applied migration(s) this image does not contain: ${state.ahead.join(", ")}. ` +
      `This image is older than the database (a rollback or stale deploy)${why}. Deploy the newer image, or ` +
      `restore/repair per ${RUNBOOK}. Refusing to start old code against a newer schema.`,
  );
}

/** A dedicated session for the runner-owned tables. */
async function openClient(ctx, applicationName) {
  const client = new ctx.pg.Client({
    connectionString: pgConnectionString(ctx.databaseUrl),
    connectionTimeoutMillis: 10_000,
    application_name: applicationName,
  });
  // An idle client whose backend dies emits "error"; never crash on it.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}

/** The image's schema level: its newest migration folder. */
function imageLevel(ctx) {
  return readMigrationsFolder(ctx.migrationsDir).at(-1)?.name ?? null;
}

/** The image's folders that carry a contract.sql (registered with the instance). */
function imageContracts(ctx) {
  return readMigrationsFolder(ctx.migrationsDir)
    .filter((m) => m.contract)
    .map((m) => m.name);
}

/**
 * The database is ahead of this image (a rollback). Admit it only when every
 * migration it lacks is rollback-safe and its scheduled deletion has not run;
 * an admitted instance with an id registers (one transaction, `admit`).
 */
async function admitOlderImage(ctx, state) {
  refuseMismatch(state);
  if (state.pending.length || state.failed.length)
    refuseAhead(state, ", and it also has migrations the database lacks (a diverged branch)");
  let client;
  try {
    client = await openClient(ctx, RUNNER_APP_NAME);
  } catch (error) {
    throw new Refusal(`cannot reach the database (${safeError(error)}). ${RUNBOOK}.`);
  }
  try {
    await assertNoPendingRestore(client);
    const result = await admit(client, {
      schema: ctx.schema,
      ahead: state.ahead,
      id: ctx.instanceId,
      role: ctx.role,
      level: imageLevel(ctx),
      host: ctx.host,
      contracts: imageContracts(ctx),
    });
    if (!result.admitted)
      refuseAhead(state, `, and it cannot run against it: ${result.reasons.join("; ")}`);
    if (ctx.instanceId)
      log(
        `older release running against a newer schema (rollback of ${state.ahead.join(", ")}); scheduled deletions are paused while it runs.`,
      );
    else
      log(
        `rollback admitted (${state.ahead.join(", ")} can be rolled back); replicas will register.`,
      );
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Register this instance (up-to-date database). Never fatal. */
async function registerSelf(ctx, client) {
  if (!ctx.instanceId) return;
  try {
    await assertNoPendingRestore(client);
    const result = await admit(client, {
      schema: ctx.schema,
      id: ctx.instanceId,
      role: ctx.role,
      level: imageLevel(ctx),
      host: ctx.host,
      contracts: imageContracts(ctx),
    });
    if (result.missingTables)
      warn(
        "the scheduled-deletion tables do not exist yet (no migrating runner has finished on this database); this instance is not registered.",
      );
  } catch (error) {
    if (error.code === "KB_RESTORE_PENDING") throw error;
    warn(
      `could not register this instance (${safeError(error)}); scheduled deletions wait for it.`,
    );
  }
}

function refuseMismatch(state) {
  if (state.checksumMismatch.length) {
    throw new Refusal(
      `applied migration file(s) changed after they were applied: ${state.checksumMismatch.join(", ")}. ` +
        "Applied migrations are immutable, and the database was never migrated for these edits, so this " +
        "image describes a schema the database does not have. Restore the original file contents (from the " +
        "commit that first shipped them) and put any change in a NEW migration. CI check 3 (immutability) " +
        `should have blocked this. ${RUNBOOK}.`,
    );
  }
}

/** Did this interrupted attempt commit? (the wrapper's commit marker) */
const committed = (failure) => failure.logs === COMMIT_SENTINEL;

/**
 * Take the migration runner lock on a dedicated session, polling
 * `pg_try_advisory_lock` until `deadline`. The lock lives as long as the
 * session: `release()` ends it, and so does this process dying, so a crashed
 * runner never leaves it behind.
 * @returns {Promise<{ assertHeld: (before: string) => void, release: () => Promise<void> }>}
 */
async function acquireRunnerLock(ctx, deadline, pollMs, timeoutMs) {
  ctx.abort ??= new AbortController();
  const client = new ctx.pg.Client({
    connectionString: pgConnectionString(ctx.databaseUrl),
    connectionTimeoutMillis: 10_000,
    application_name: RUNNER_APP_NAME,
  });
  let releasing = false;
  let lost = false;
  const markLost = (why) => {
    if (releasing || lost) return;
    lost = true;
    ctx.abort?.abort();
    warn(`the migration runner lock session ended (${why}); stopping before the next step.`);
  };
  // An idle client whose backend is terminated emits "error"; without a
  // listener that would crash the process mid-step.
  client.on("error", (error) => markLost(safeError(error)));
  client.on("end", () => markLost("connection closed"));
  const end = async () => {
    releasing = true;
    await client.end().catch(() => {});
  };
  try {
    await client.connect();
  } catch (error) {
    await end();
    throw new Refusal(
      `cannot open the migration runner lock session (${safeError(error)}). Check DATABASE_URL and the network. ${RUNBOOK}.`,
    );
  }
  try {
    let announced = false;
    for (;;) {
      if (ctx.abort.signal.aborted)
        throw new Refusal("Migration runner cancelled while waiting for its lock.");
      const { rows } = await client.query(
        `SELECT pg_try_advisory_lock(${MIGRATION_RUNNER_LOCK_KEY}) AS acquired`,
      );
      if (rows[0]?.acquired === true) break;
      if (lost)
        throw new Refusal(
          "lost the database connection while waiting for the migration runner lock.",
        );
      if (Date.now() >= deadline) {
        throw new Refusal(
          `another migration runner (MIGRATE_ON_START=true or the \`migrate\` job) still holds the migration lock ` +
            `after ${Math.round(timeoutMs / 1000)} s. Exiting so the platform restarts this ` +
            "container and checks again; this is expected when the other runner's pre-migration backup plus " +
            "migrate deploy takes longer than this timeout. If it repeats while no other runner is up, find the " +
            `session holding advisory lock ${MIGRATION_RUNNER_LOCK_KEY} (pg_locks; application_name ${RUNNER_APP_NAME}). ${RUNBOOK}.`,
        );
      }
      if (!announced) {
        log("another migration runner is working on this database (its lock is held); waiting…");
        announced = true;
      }
      await delay(pollMs);
    }
  } catch (error) {
    await end();
    throw error;
  }
  // Unlock explicitly before closing: behind a connection pooler the server
  // backend can outlive this client, and a session-level lock held on a pooled
  // backend would block every later runner. (Prisma migrate needs a direct
  // connection anyway; this keeps a misconfiguration from becoming permanent.)
  const unlockAndEnd = async () => {
    if (!lost) {
      await client
        .query(`SELECT pg_advisory_unlock(${MIGRATION_RUNNER_LOCK_KEY})`)
        .catch((error) =>
          warn(`could not release the migration runner lock explicitly (${safeError(error)}).`),
        );
    }
    await end();
  };
  return {
    assertHeld(before) {
      if (lost) {
        throw new Refusal(
          `lost the migration runner lock before ${before}; stopping without changing anything else. ` +
            `The next start retries. ${RUNBOOK}.`,
        );
      }
    },
    client,
    release: unlockAndEnd,
  };
}

async function applyMode(ctx, options) {
  const pollMs = options.pollMs ?? 3_000;
  const timeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  // One window from process start covers the connection retries and the
  // lock wait (the startup budget counts WAIT_TIMEOUT_MS once).
  const deadline = Date.now() + timeoutMs;
  // Connection retries first (the database may still be starting), and the
  // states that need no lock are refused (or admitted) before taking it.
  const initial = await readyState(ctx, options, deadline);
  refuseCommon(initial);
  const lock = await acquireRunnerLock(ctx, deadline, pollMs, timeoutMs);
  try {
    return await applyLocked(ctx, lock, deadline, pollMs);
  } finally {
    await lock.release();
  }
}

/** applyMode's body; runs only while this process holds the runner lock. */
async function applyLocked(ctx, lock, deadline, pollMs) {
  // Re-read: another runner may have finished everything while we waited.
  let state = await ctx.state();
  refuseCommon(state);
  if (state.state === "db-ahead") return await admitOlderImage(ctx, state);
  // Something other than a runner (an operator's `prisma migrate deploy`)
  // holds Prisma's lock and its migration is mid-flight: wait for it rather
  // than treat its row as a failure.
  let announcedForeignLock = false;
  while (state.state === "failed" && state.inProgress && Date.now() < deadline) {
    if (!announcedForeignLock) {
      log(
        `migration ${state.failed.map((f) => f.name).join(", ")} is being applied by another session; waiting…`,
      );
      announcedForeignLock = true;
    }
    await delay(pollMs);
    state = await ctx.state();
    refuseCommon(state);
    refuseAhead(state);
  }
  if (state.state === "failed" && state.inProgress) {
    throw new Refusal(
      `migration ${state.failed.map((f) => f.name).join(", ")} is still being applied by another session ` +
        "(Prisma's migration lock is held); not touching it. The next start checks again. " +
        `If nothing should be migrating, find the session holding the lock (pg_locks). ${RUNBOOK}.`,
    );
  }
  refuseMismatch(state);
  if (state.state === "up-to-date") {
    log(`database is up to date (${state.applied.length} migration(s) applied).`);
    return await afterUpToDate(ctx, lock, { fresh: false, backup: null });
  }

  const byName = new Map(readMigrationsFolder(ctx.migrationsDir).map((m) => [m.name, m]));
  // Interrupted attempts that provably COMMITTED: record them as applied.
  // They already changed the database, so they are not "to apply" and do not
  // go through the breaking-change gate a second time.
  if (state.state === "failed") {
    for (const failure of state.failed.filter(committed)) {
      lock.assertHeld(`recording ${failure.name} as applied`);
      await withMutation(ctx, async () => markCommitted(ctx, failure, byName.get(failure.name)));
    }
    state = await ctx.state();
    refuseCommon(state);
    refuseAhead(state);
    refuseMismatch(state);
    if (state.state === "up-to-date") {
      log(`database is up to date (${state.applied.length} migration(s) applied).`);
      return await afterUpToDate(ctx, lock, { fresh: false, backup: null });
    }
  }
  /** @type {Array<{ name: string, logs: string | null }>} */
  let recoverable = [];
  if (state.state === "failed") {
    recoverable = state.failed.map((failure) => {
      if (committed(failure))
        throw new Refusal(`migration ${failure.name} is still unresolved. ${RUNBOOK}.`);
      assertRecoverable(failure.name, byName.get(failure.name));
      return failure;
    });
  }

  // Pre-deploy gates, before anything mutates the history (§1.14 step 3).
  const toApply = [...recoverable.map((f) => f.name), ...state.pending];
  // Both conditions, so this never rests on 0_init failing on a non-empty
  // schema: nothing applied, and the baseline is the first thing to apply.
  let facts = await withMutation(ctx, async (client) => readMutationFacts(ctx, client));
  const freshDatabase = state.applied.length === 0 && toApply[0] === "0_init" && facts.empty;
  if (state.applied.length === 0 && toApply[0] === "0_init" && !facts.empty)
    throw new Refusal(
      "0_init requires a genuinely empty application catalog, even when migration history is empty or rolled back.",
    );
  warnOutOfOrder(state.applied, toApply);
  await preDeployGates(ctx, { toApply, freshDatabase, byName });

  // A snapshot refuses unfinished history. Resolve only proven rolled-back
  // attempts under mutation exclusion before capturing the required backup.
  if (recoverable.length) {
    const recovered = await withMutation(ctx, async (client) => {
      if (JSON.stringify(await readMutationFacts(ctx, client)) !== JSON.stringify(facts))
        return false;
      for (const failure of recoverable) {
        lock.assertHeld(`recovering ${failure.name}`);
        await recover(ctx, failure, byName.get(failure.name), "previous deploy");
      }
      facts = await readMutationFacts(ctx, client);
      return true;
    });
    if (!recovered) return applyLocked(ctx, lock, deadline, pollMs);
  }

  log(`pending migration(s): ${toApply.join(", ")}`);
  lock.assertHeld("the pre-migration backup");
  const backup = freshDatabase ? { ran: false, label: null } : await preMigrateBackup(ctx);

  return await withMutation(ctx, async (client) => {
    const current = await readMutationFacts(ctx, client);
    if (JSON.stringify(current) !== JSON.stringify(facts)) {
      log(
        "database/history/contract state changed during backup; restarting classification and backup.",
      );
      return { restart: true };
    }
    lock.assertHeld("migrate deploy");
    let attempt = await deploy(ctx);
    if (attempt !== 0) {
      state = await ctx.state();
      refuseCommon(state);
      refuseAhead(state);
      // Our deploy has exited, so a held Prisma lock belongs to someone else
      // who may be applying this very migration: its row is not ours to resolve.
      if (state.inProgress) {
        throw new Refusal(
          `prisma migrate deploy failed (exit ${attempt}) while another session holds Prisma's migration lock; ` +
            `not touching the migration history. The next start checks again. ${RUNBOOK}.`,
        );
      }
      if (state.state !== "failed")
        throw new Refusal(`prisma migrate deploy failed (exit ${attempt}). ${RUNBOOK}.`);
      for (const failure of state.failed) {
        lock.assertHeld(`resolving ${failure.name}`);
        if (committed(failure)) {
          await markCommitted(ctx, failure, byName.get(failure.name));
          continue;
        }
        assertRecoverable(failure.name, byName.get(failure.name));
        // Never retry something that was already auto-recovered in this run.
        if (recoverable.some((r) => r.name === failure.name)) {
          await reportReplayError(ctx, byName.get(failure.name));
          throw new Refusal(
            `migration ${failure.name} failed again after one automatic retry. Stopping for a person: ${RUNBOOK}.`,
          );
        }
        await recover(ctx, failure, byName.get(failure.name), "this deploy");
        recoverable.push(failure);
      }
      lock.assertHeld("retrying migrate deploy");
      attempt = await deploy(ctx);
      if (attempt !== 0) {
        const after = await ctx.state();
        for (const failure of after.failed) await reportReplayError(ctx, byName.get(failure.name));
        throw new Refusal(
          `migration failed again after one automatic retry. Stopping for a person: ${RUNBOOK}.`,
        );
      }
    }

    const final = await ctx.state();
    // Another deployer outside the runner lock (an operator) may have applied
    // different bytes under the same name; Prisma would then skip ours.
    refuseMismatch(final);
    if (final.state !== "up-to-date") {
      throw new Refusal(
        `after migrate deploy the database is "${final.state}", not up to date. ${RUNBOOK}.`,
      );
    }
    log(`database is up to date (${final.applied.length} migration(s) applied).`);
    return { fresh: freshDatabase, backup };
  }).then(async (result) =>
    result.restart ? applyLocked(ctx, lock, deadline, pollMs) : afterUpToDate(ctx, lock, result),
  );
}

/**
 * A pending folder that sorts before an applied one was merged out of order
 * (CI check 2 blocks this where branch rules are enforced). It is applied
 * normally; its scheduled deletion waits until no running instance's image
 * lacks it (the registry records each image's contract folders).
 */
function warnOutOfOrder(applied, toApply) {
  // Code-unit order, like Prisma's folder order.
  const newest = [...applied].sort().at(-1) ?? "";
  const early = toApply.filter((name) => name < newest);
  if (!early.length) return;
  loud([
    `OUT-OF-ORDER MIGRATION: ${early.join(", ")} sort${early.length === 1 ? "s" : ""} before the already-applied ${newest}.`,
    "It was merged after a newer migration (CI check 2, Ordering, should have blocked it). It is applied now;",
    "any scheduled deletion it carries waits until no running release lacks it. Next time run",
    "`pnpm db:migrate:rebase` on the branch before merging.",
  ]);
}

/** Columns per table, for analyzeMigration's `knownTables`. */
const knownTablesOf = (catalog) =>
  new Map([...catalog.tables].map(([key, table]) => [key, new Set(table.columns.keys())]));

/**
 * §1.14 step 3, over `toApply` (folder order):
 *   - breaking gate: a statement old code cannot run against (`incompatible`:
 *     an in-place drop, rename or type change, with column types from the
 *     live database folded through the earlier pending folders), SQL the
 *     analyzer cannot read that carries no `-- knowledge-base:reviewed <reason>`
 *     (unannotated `notAnalyzed`, incl. unknown template versions), or the
 *     retired `-- requires: maintenance-deploy` marker → refused, no
 *     override, except on a fresh database (nothing can be running on it);
 *   - name reuse: a pending migration recreates something an earlier
 *     contract.sql deletes, while it still exists → refused, no override;
 *   - late recovery: a pending recover block whose source column is already
 *     deleted → a loud log, not a refusal.
 */
async function preDeployGates(ctx, { toApply, freshDatabase, byName }) {
  let live = null;
  /** @type {Array<{ name: string, contract_applied_at: Date | null, contract_backup: string | null }>} */
  let deletedRows = [];
  if (!freshDatabase) {
    const client = await openClient(ctx, RUNNER_APP_NAME);
    try {
      live = await readLiveCatalog(client, ctx.schema, {
        defaults: false,
        timeoutMs: PREDEPLOY_CATALOG_TIMEOUT_MS,
      });
      if (await runtimeTablesExist(client, ctx.schema))
        deletedRows = (
          await client.query(
            `SELECT name, contract_applied_at, contract_backup FROM ${client.escapeIdentifier(ctx.schema)}."_knowledge_base_migration"
              WHERE contract_applied_at IS NOT NULL`,
          )
        ).rows;
    } finally {
      await client.end().catch(() => {});
    }
  }
  let catalog = live ?? emptyCatalog();
  const breaking = [];
  const analyses = [];
  for (const name of toApply) {
    const sql = byName.get(name)?.sql ?? "";
    const analysis = analyzeMigration(sql, {
      folder: name,
      typeOf: live ? typeOfFromCatalog(catalog) : undefined,
      knownTables: knownTablesOf(catalog),
    });
    analyses.push({ name, templates: analysis.templates });
    const why = [];
    if (analysis.markers.retiredMaintenance)
      why.push(`carries the retired marker "${RETIRED_MAINTENANCE_MARKER}"`);
    for (const item of analysis.incompatible) why.push(`line ${item.line} ${item.what}`);
    // SQL the tooling cannot read (DO, EXECUTE, dollar bodies, unknown
    // template versions…) counts as breaking unless its author attested it
    // with `-- knowledge-base:reviewed <reason>`; CI check 5 fails the same lines.
    for (const item of analysis.notAnalyzed)
      if (item.reviewed === null) why.push(`line ${item.line} not analyzed: ${item.reason}`);
    if (why.length) {
      breaking.push(`${name} (${why.join("; ")})`);
    }
    catalog = catalogFromSql(sql, catalog);
  }
  // A database with no applied migration has never had a schema any release
  // could run against, so no old code can be serving from it: a brand-new
  // environment applies its whole history in one ordinary deploy.
  if (breaking.length && freshDatabase) {
    log(
      `new database: applying in-place breaking migration(s) ${breaking.join(", ")} (no earlier release can be running against it).`,
    );
  } else if (breaking.length) {
    throw new Refusal(
      `pending migration(s) change the schema in place, which would break the release that is still running: ${breaking.join(", ")}. ` +
        "Nothing was applied, and there is no override (CI check 5 should have blocked this before merge). " +
        "Ship a corrected migration instead. " +
        "To delete a column or table: remove it from the schema and regenerate with `pnpm db:migrate`, which " +
        "schedules the deletion in contract.sql. To rename: keep the database name with @map / @@map. " +
        `To change a type: two PRs (${TYPE_CHANGE_RECIPE}). Unreadable SQL needs ` +
        "`-- knowledge-base:reviewed <reason>` on the line above it, only when the running release is truly unaffected.",
    );
  }

  const all = [...byName.values()];
  const reuse = nameReuseLive(findNameReuse(all), {
    toApply,
    fresh: freshDatabase,
    live,
    schema: ctx.schema,
  });
  if (reuse.length) {
    throw new Refusal(
      `pending migration(s) reuse a name that an earlier scheduled deletion removes: ${reuse
        .map((m) => `${m.folder} line ${m.line} (${m.key}, deleted by ${m.droppedBy})`)
        .join(", ")}. ` +
        "The old object may still hold data or be deleted later. Use a new physical name with @map / @@map " +
        "(docs/schema-changes-recipe.md). This cannot be overridden.",
    );
  }

  if (live) {
    const applied = deletedRows.map((row) => ({
      ...row,
      droppedColumns: summarizeEffects(byName.get(row.name)?.contract?.sql ?? "", {
        folder: row.name,
      }).droppedColumns,
    }));
    for (const late of lateRecoveries(analyses, { live, applied, schema: ctx.schema }))
      loud([
        `RECOVERY TOO LATE: ${late.column} was deleted${late.deletedAt ? ` on ${late.deletedAt}` : ""} (backup: ${late.backup ?? "none"}).`,
        `${late.folder} copies nothing. To get the data back, restore that backup (docs/backup-restore.md),`,
        "then redeploy within 7 days.",
      ]);
  }
}

/** The image's own Prisma schema as a catalog (7c-4). Errors are returned, not thrown. */
async function imageCatalog(ctx) {
  if (ctx.contracts.imageCatalog) return ctx.contracts.imageCatalog();
  try {
    const result = await ctx.runPrisma(
      ["migrate", "diff", "--from-empty", "--to-schema", SCHEMA_DIR, "--script"],
      { capture: true, env: { DATABASE_URL: ctx.databaseUrl }, timeoutMs: IMAGE_SCHEMA_TIMEOUT_MS },
    );
    if (result.timedOut)
      return new Error(`prisma migrate diff timed out after ${IMAGE_SCHEMA_TIMEOUT_MS / 1000} s`);
    if (result.code !== 0) return new Error(`prisma migrate diff exited ${result.code}`);
    return catalogFromSql(result.stdout ?? "");
  } catch (error) {
    return new Error(safeError(error));
  }
}

/**
 * Steps 5–8 of §1.14, on every successful apply (also when nothing was
 * pending): record, register, scheduled deletions, prune, schedule log.
 * Nothing here fails the start.
 * @param {{ fresh: boolean, backup: { ran: boolean, label: string | null } | null }} run
 */
async function afterUpToDate(ctx, lock, run) {
  let client;
  await assertNoPendingRestore(lock.client);
  try {
    client = await openClient(ctx, "knowledge-base-migrate-contracts");
  } catch (error) {
    warn(
      `could not open a session for scheduled deletions (${safeError(error)}); skipped this run.`,
    );
    return 0;
  }
  try {
    const migrations = readMigrationsFolder(ctx.migrationsDir);
    try {
      // Session defaults bound every runner-table step below (RUNTIME_STEPS);
      // transactions that need another bound set their own.
      await client.query(`SET statement_timeout = ${RUNTIME_STEP_TIMEOUT_MS}`);
      await client.query(`SET lock_timeout = ${RUNTIME_STEP_TIMEOUT_MS}`);
      lock.assertHeld("recording the applied migrations");
      await withMutation(
        ctx,
        async () => {
          await ensureRuntimeTables(client, ctx.schema);
          await recordApplied(client, { schema: ctx.schema, migrations });
        },
        { client, excludePrisma: true },
      );
    } catch (error) {
      warn(
        `could not record the applied migrations (${error instanceof Refusal ? error.message : safeError(error)}); scheduled deletions skipped this run, and an older image will be refused.`,
      );
      return 0;
    }
    await registerSelf(ctx, client);
    if (ctx.contracts === false) return 0;
    try {
      await contractsPhase(ctx, client, lock, migrations, run);
    } catch (error) {
      if (error instanceof Refusal) {
        warn(`${error.message}`);
        return 0;
      }
      warn(
        `scheduled deletions stopped (${safeError(error)}); the app starts normally and the next start tries again.`,
      );
    }
    return 0;
  } finally {
    await client.end().catch(() => {});
  }
}

/** §1.14 step 7 (identity → plan → validate → backup → clock → apply) and step 8. */
async function contractsPhase(ctx, client, lock, migrations, run) {
  const schema = ctx.schema;
  const level = migrations.at(-1)?.name ?? "";
  const now = ctx.contracts.now ?? Date.now;
  lock.assertHeld("the database identity check");
  const identity = await checkClusterIdentity(client, { schema, fresh: run.fresh, log });
  if (identity.skipContracts) return;
  const withContract = migrations.filter((m) => m.contract);
  const plan = async () => {
    const inputs = await readPlanInputs(
      client,
      schema,
      withContract.map((m) => m.name),
    );
    const pending = withContract
      .filter((m) => !inputs.rows.get(m.name)?.contract_applied_at)
      .map((m) => ({ name: m.name, row: inputs.rows.get(m.name) }));
    return {
      inputs,
      plan: planContracts({ ...inputs, fresh: run.fresh, level, pending }),
    };
  };
  if (withContract.length) {
    const { inputs, plan: first } = await plan();
    if (first.due.length)
      await applyDue(ctx, client, lock, { migrations, run, level, now, inputs, due: first.due });
  }
  await pruneInstances(client, schema);
  if (withContract.length) {
    const { plan: after } = await plan();
    for (const line of scheduleLines(after)) log(`scheduled deletion ${line}`);
  }
}

async function applyDue(ctx, client, lock, { migrations, run, level, now, inputs, due }) {
  const schema = ctx.schema;
  const byName = new Map(migrations.map((m) => [m.name, m]));
  const live = await readLiveCatalog(client, schema, { timeoutMs: CONTRACTS_CATALOG_TIMEOUT_MS });
  const image = await imageCatalog(ctx);
  if (image instanceof Error) {
    warn(
      `could not read this image's schema (${image.message}); scheduled deletions skipped this run.`,
    );
    return;
  }
  const valid = [];
  for (const name of due) {
    const migration = byName.get(name);
    const check = validateContract({ migration, row: inputs.rows.get(name), live, image, schema });
    if (!check.ok) {
      loud([
        `SCHEDULED DELETION SKIPPED: ${check.finding}`,
        "It and every later scheduled deletion wait until a release fixes it. Nothing was deleted.",
      ]);
      break;
    }
    valid.push({ migration, analysis: check.analysis });
  }
  if (!valid.length) return;
  let backup = run.backup?.label ?? null;
  if (!run.fresh && !run.backup?.ran) {
    lock.assertHeld("the pre-drop backup");
    const result = await runBackupHook(ctx, ["--label", "pre-drop"]);
    if (result.missing || result.code !== 0) {
      loud([
        `the configured pre-drop backup failed (exit ${result.code}); scheduled deletions skipped this run.`,
        "Fix the backup configuration (docs/backup-restore.md).",
      ]);
      return;
    }
    backup = result.label;
  }
  const budget = ctx.contracts.budgetMs ?? CONTRACT_RUN_BUDGET_MS;
  const deadline = run.fresh ? Number.POSITIVE_INFINITY : now() + budget;
  for (const { migration } of valid) {
    const name = migration.name;
    const result = await withMutation(
      ctx,
      async (session) => {
        const state = await ctx.state(session);
        refuseCommon(state);
        refuseMismatch(state);
        if (state.state !== "up-to-date")
          throw new Refusal(
            "Migration state changed before scheduled deletion; retry classification on the next start.",
          );
        const current = await readPlanInputs(session, schema, [name]);
        const check = validateContract({
          migration,
          row: current.rows.get(name),
          live: await readLiveCatalog(session, schema),
          image,
          schema,
        });
        if (!check.ok) throw new Refusal(check.finding);
        return applyContract(session, {
          schema,
          migration,
          analysis: check.analysis,
          level,
          deadline,
          backup,
          now,
          assertHeld: (before) => lock.assertHeld(before),
          replan: async (session) => {
            await assertNoPendingRestore(session);
            const fresh = await readPlanInputs(session, schema, [name]);
            return planContracts({
              ...fresh,
              fresh: run.fresh,
              level,
              pending: [{ name, row: fresh.rows.get(name) }],
              // This attempt is already counted; the limit was checked before it.
              ignoreAttempts: true,
            }).due.includes(name);
          },
        });
      },
      { client, excludePrisma: true },
    );
    if (result.status === "applied") {
      const released = inputs.instances
        .filter((i) => imageContains(i, name) && i.ready_at)
        .map((i) => new Date(i.ready_at).getTime());
      const row = inputs.rows.get(name);
      loud([
        `DATA DELETED: ${row?.contract_effects ?? name}${result.notes?.length ? `; ${result.notes.join("; ")}` : ""}`,
        `(retired by ${name}${released.length ? `, released ${new Date(Math.min(...released)).toISOString()}` : ""}; backup: ${backup ?? "none configured"})`,
      ]);
      continue;
    }
    if (result.status === "noop") continue;
    if (result.status === "not-started")
      log(`scheduled deletion of ${name} continues on the next start (time budget used).`);
    else if (result.status === "not-due")
      log(`scheduled deletion of ${name} is no longer due; nothing was deleted.`);
    else
      loud([
        `scheduled deletion of ${name} failed and was rolled back (${result.status}): ${result.error}`,
        result.status === "counted"
          ? "It counts as one of 3 tries for this release."
          : "The database was busy; this does not count as a try. The next start tries again.",
      ]);
    return;
  }
}

function assertRecoverable(name, migration) {
  if (!migration) {
    throw new Refusal(`failed migration ${name} is not in this image. ${RUNBOOK}.`);
  }
  if (!markers(migration.sql).transactional) {
    throw new Refusal(
      `migration ${name} failed and is not marked "-- knowledge-base:transactional", so PostgreSQL may have kept ` +
        `part of it. A person must inspect the database and resolve it: ${RUNBOOK}.`,
    );
  }
  const wrapper = checkWrapper(migration.sql);
  if (!wrapper.ok) {
    throw new Refusal(
      `migration ${name} failed; it carries the transactional marker but its wrapper is not intact ` +
        `(${wrapper.reason}), so automatic recovery is unsafe. ${RUNBOOK}.`,
    );
  }
}

/**
 * The attempt's transaction committed but Prisma never recorded success (the
 * process died in between). Record it as applied so it is never re-run.
 */
async function markCommitted(ctx, failure, migration) {
  if (!migration) {
    throw new Refusal(`interrupted migration ${failure.name} is not in this image. ${RUNBOOK}.`);
  }
  if (failure.checksum && failure.checksum !== migration.checksum) {
    throw new Refusal(
      `migration ${failure.name} committed, but this image's file differs from the one that ran. ` +
        `A person must compare them before it is recorded as applied: ${RUNBOOK}.`,
    );
  }
  loud([
    `RECOVERY: migration ${failure.name} was interrupted AFTER its transaction committed`,
    "(the process stopped before Prisma recorded success). Its commit marker proves the",
    "changes are in the database, so it is recorded as applied and NOT run again.",
  ]);
  const resolved = await ctx.runPrisma(["migrate", "resolve", "--applied", failure.name], {
    env: { DATABASE_URL: ctx.databaseUrl },
  });
  if (resolved.code !== 0)
    throw new Refusal(`prisma migrate resolve --applied ${failure.name} failed.`);
}

async function recover(ctx, failure, migration, when) {
  const original = await reportReplayError(ctx, migration);
  loud([
    `AUTO-RECOVERY: migration ${failure.name} failed (${when}).`,
    `Original error: ${original ?? failure.logs ?? "unavailable"}`,
    "Its intact wrapper never recorded the commit marker, so PostgreSQL rolled it back completely.",
    `Marking it rolled back and retrying ONCE. A second failure stops for a person (${RUNBOOK}).`,
  ]);
  const resolved = await ctx.runPrisma(["migrate", "resolve", "--rolled-back", failure.name], {
    env: { DATABASE_URL: ctx.databaseUrl },
  });
  if (resolved.code !== 0)
    throw new Refusal(`prisma migrate resolve --rolled-back ${failure.name} failed.`);
}

/**
 * Prisma loses the real error of a wrapped migration (it reports "current
 * transaction is aborted" and stores no logs), so replay the body inside a
 * transaction that is always rolled back and capture what PostgreSQL says.
 * Only called for files whose wrapper was verified intact.
 */
async function reportReplayError(ctx, migration) {
  if (!migration || !checkWrapper(migration.sql).ok) return null;
  const client = ctx.mutationClient;
  if (!client) return withMutation(ctx, () => reportReplayError(ctx, migration));
  try {
    await assertNoPendingRestore(client);
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    try {
      await client.query(unwrapBody(migration.sql));
      return "(replay in a rolled-back transaction succeeded — the failure was transient, e.g. a lock timeout)";
    } catch (error) {
      const position =
        error && typeof error === "object" && "where" in error && error.where
          ? ` (${error.where})`
          : "";
      return `${safeError(error)}${position}`;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } catch (error) {
    return `could not replay to capture the error: ${safeError(error)}`;
  }
}

/**
 * W2 BACKUP_RESULT_FILE interface (JSON, version 1), published atomically by
 * scripts/backup/pre-migrate.sh only after a verified full encrypted KB bundle:
 * {version:1, runId:<UUID>, label:"pre-migrate"|"pre-drop"|"manual"|"daily",
 *  createdAt:<ISO UTC>, utcDay:"YYYY-MM-DD", bundlePath:<absolute backup-UUID.age>,
 *  completion:{path:<bundlePath + ".complete">, sha256:<marker SHA-256>},
 *  upload:{configured:<boolean>, outcome:"uploaded"|"local-only"|"failed",
 *          ...verified remote identity fields}}
 * The completion file is KB's {version:1,size,sha256} bundle digest marker.
 * The runner supplies KB_BACKUP_RUN_ID, BACKUP_RESULT_FILE and
 * --label; the hook preserves human stdout. No result, disabled backup, missing
 * pair, mismatched UUID/label/digest, or configured upload failure blocks DDL.
 * contract_backup stores JSON.stringify(result), retaining the entire identity.
 * This hook runs under runner 72707370, NEVER under DADP or Prisma exclusion.
 */
export function validateBackupResult(result, { runId, label, uploadConfigured = false }) {
  if (
    result?.version !== 1 ||
    result.runId !== runId ||
    result.label !== label ||
    !UUID.test(result.runId) ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(result.createdAt ?? "") ||
    !Number.isFinite(Date.parse(result.createdAt)) ||
    result.utcDay !== result.createdAt.slice(0, 10) ||
    !path.isAbsolute(result.bundlePath ?? "") ||
    path.basename(result.bundlePath) !== `backup-${runId}.age` ||
    result.completion?.path !== `${result.bundlePath}.complete` ||
    !/^[a-f0-9]{64}$/.test(result.completion?.sha256 ?? "") ||
    typeof result.upload?.configured !== "boolean" ||
    (uploadConfigured && !result.upload.configured) ||
    result.upload.outcome !== (result.upload.configured ? "uploaded" : "local-only")
  )
    throw new Error(
      "Backup result is incomplete or does not identify this verified bundle/upload.",
    );
  const marker = readFileSync(result.completion.path);
  const digest = JSON.parse(marker);
  if (
    createHash("sha256").update(marker).digest("hex") !== result.completion.sha256 ||
    digest.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(digest.sha256) ||
    !Number.isSafeInteger(digest.size) ||
    digest.size <= 0
  )
    throw new Error("Backup completion marker does not match its result.");
  // The bundle service verifies ciphertext before publishing this marker; no
  // second multi-GB read here. Existence/size still bind the reported pair.
  if (statSync(result.bundlePath).size !== digest.size)
    throw new Error("Backup bundle is missing or incomplete.");
  return result;
}

export async function runBackupHook(ctx, args = []) {
  if (!existsSync(ctx.backupHook)) return { missing: true, code: 1, label: null };
  const staging = mkdtempSync(path.join(tmpdir(), "knowledge-base-backup-result-"));
  const resultFile = path.join(staging, "result.json");
  const runId = randomUUID();
  const labelAt = args.indexOf("--label");
  const label = labelAt < 0 ? "pre-migrate" : args[labelAt + 1];
  try {
    const code = await new Promise((resolve) => {
      const child = spawn("bash", [ctx.backupHook, ...(labelAt < 0 ? ["--label", label] : args)], {
        env: {
          ...ctx.env,
          KB_BACKUP_RUN_ID: runId,
          BACKUP_RESULT_FILE: resultFile,
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", () => resolve(1));
      child.on("close", (status) => resolve(status ?? 1));
    });
    if (code !== 0) return { missing: false, code, label: null };
    const result = validateBackupResult(JSON.parse(readFileSync(resultFile, "utf8")), {
      runId,
      label,
      uploadConfigured: Boolean(ctx.env.BACKUP_S3_BUCKET),
    });
    return { missing: false, code: 0, label: JSON.stringify(result) };
  } catch {
    return { missing: false, code: 1, label: null };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function preMigrateBackup(ctx) {
  log("running the pre-migration full-bundle backup hook…");
  const { code, label } = await runBackupHook(ctx);
  if (code !== 0 || !label)
    throw new Refusal(
      "the required pre-migration full-bundle backup failed or returned no verified result; refusing to migrate. Fix the backup configuration (docs/backup-restore.md).",
    );
  return { ran: true, label };
}

async function deploy(ctx) {
  log("prisma migrate deploy…");
  const result = await ctx.runPrisma(["migrate", "deploy"], {
    env: { DATABASE_URL: ctx.databaseUrl },
  });
  return result.code;
}

async function waitMode(ctx, options) {
  const timeout = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const poll = options.pollMs ?? 3_000;
  const deadline = Date.now() + timeout;
  let failedSince = null;
  let last = "";
  for (;;) {
    if (ctx.abort?.signal.aborted) throw new Refusal("Migration runner cancelled.");
    const state = await ctx.state();
    if (state.state === "restore-pending") refuseCommon(state);
    if (state.state === "up-to-date" || state.state === "db-ahead") {
      const lock = await acquireRunnerLock(ctx, deadline, poll, timeout);
      try {
        const locked = await ctx.state(lock.client);
        refuseCommon(locked);
        refuseMismatch(locked);
        if (locked.state === "db-ahead") return await admitOlderImage(ctx, locked);
        if (locked.state !== "up-to-date") continue;
        log("database is up to date; starting.");
        await registerSelf(ctx, lock.client);
        return 0;
      } finally {
        await lock.release();
      }
    }
    if (state.state === "no-history-nonempty") refuseCommon(state);
    // A runner holding its lock (or Prisma's) is still working on the
    // failure: between a failure and its one automatic retry, or waiting.
    if (state.state === "failed" && !state.inProgress && !state.runnerActive) {
      failedSince ??= Date.now();
      if (Date.now() - failedSince > Math.min(30_000, timeout)) {
        throw new Refusal(
          `migration ${state.failed.map((f) => f.name).join(", ")} is recorded as failed. Not starting. ${RUNBOOK}.`,
        );
      }
    } else failedSince = null;
    if (state.state !== last) {
      log(`waiting for migrations to be applied by the migrating service (state: ${state.state})…`);
      last = state.state;
    }
    if (Date.now() >= deadline) {
      throw new Refusal(
        `timed out after ${Math.round(timeout / 1000)} s waiting for the database to be up to date (state: ${state.state}). ` +
          "Is a migrating service (MIGRATE_ON_START=true, or the `migrate` job) running for this release?",
      );
    }
    await delay(poll);
  }
}

export const HOLD_DEFAULT_DAYS = 7;
export const HOLD_MAX_DAYS = 90;

/**
 * The `hold-deletions` image command: write (or with `clear`, remove) the
 * owner hold. Same row and `greatest` semantics as every other hold source.
 * @param {{ args?: string[], env?: NodeJS.ProcessEnv, pg?: typeof import("pg"),
 *   waitTimeoutMs?: number, pollMs?: number }} [options]
 * @returns {Promise<number>} exit code
 */
export async function runHold(options = {}) {
  const env = options.env ?? process.env;
  const args = options.args ?? [];
  try {
    if (!env.DATABASE_URL) throw new Refusal("DATABASE_URL is not set.");
    const clear = args[0] === "--clear";
    let days = HOLD_DEFAULT_DAYS;
    if (!clear && args[0] !== undefined) {
      if (!/^\d+$/.test(args[0]) || Number(args[0]) < 1 || Number(args[0]) > HOLD_MAX_DAYS)
        throw new Refusal(
          `hold-deletions takes a whole number of days from 1 to ${HOLD_MAX_DAYS}, or --clear (got "${args[0]}").`,
        );
      days = Number(args[0]);
    }
    if (args.length > 1) throw new Refusal("hold-deletions takes one argument: [days] or --clear.");
    const ctx = {
      databaseUrl: env.DATABASE_URL,
      pg: options.pg ?? loadPg(),
      schema: prismaSchemaName(env.DATABASE_URL),
    };
    const timeoutMs = options.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
    const lock = await acquireRunnerLock(
      ctx,
      Date.now() + timeoutMs,
      options.pollMs ?? 3_000,
      timeoutMs,
    );
    let client;
    try {
      client = await openClient(ctx, RUNNER_APP_NAME);
      await assertNoPendingRestore(client);
      const { rows } = await client.query(
        "SELECT to_regclass(format('%I._prisma_migrations', $1::text)) IS NOT NULL AS present",
        [ctx.schema],
      );
      if (rows[0]?.present !== true)
        throw new Refusal(
          "this database has no migration history (_prisma_migrations), so there is nothing to hold. " +
            "Check that DATABASE_URL names this app's database.",
        );
      lock.assertHeld("writing the hold");
      return await withMutation(
        ctx,
        async () => {
          if (clear) {
            const exists = await runtimeTablesExist(client, ctx.schema);
            const removed = exists
              ? (
                  await client.query(
                    `DELETE FROM ${client.escapeIdentifier(ctx.schema)}."_knowledge_base_hold" WHERE reason = 'owner'`,
                  )
                ).rowCount
              : 0;
            console.log(
              removed
                ? "[hold-deletions] Removed the owner hold. Scheduled deletions can run again (other holds, if any, still apply)."
                : "[hold-deletions] There was no owner hold; nothing changed.",
            );
            return 0;
          }
          await ensureRuntimeTables(client, ctx.schema);
          const result = await client.query(holdUpsertSql(ctx.schema), [
            "owner",
            days * 24 * 60 * 60 * 1000,
          ]);
          const until = new Date(result.rows[0].until).toISOString().replace(/\.\d{3}Z$/, "Z");
          console.log(
            `[hold-deletions] Scheduled deletions are paused until ${until} (owner hold, ${days} day${days === 1 ? "" : "s"}; a longer existing hold is kept). The app can run (or be started) as usual. Remove it early with \`hold-deletions --clear\`.`,
          );
          return 0;
        },
        { client, excludePrisma: true },
      );
    } finally {
      await client?.end().catch(() => {});
      await lock.release();
    }
  } catch (error) {
    console.error(
      `[hold-deletions] FATAL: ${error instanceof Refusal ? error.message : safeError(error)}`,
    );
    return 1;
  }
}

/** DADP covers only mutation/inspection, never the bundle hook. */
async function withMutation(ctx, action, { client: existing, excludePrisma = false } = {}) {
  if (ctx.abort?.signal.aborted)
    throw new Refusal("Runner or mutation session was cancelled; continuation refused.");
  if (ctx.mutationClient && !existing) return action(ctx.mutationClient);
  const client = existing ?? (await openClient(ctx, "knowledge-base-migrate-ddl"));
  let lost = false;
  const onLost = () => {
    lost = true;
    ctx.abort?.abort();
  };
  client.on("error", onLost);
  client.on("end", onLost);
  let dadp = false;
  let prismaHeld = false;
  const previous = ctx.mutationClient;
  try {
    await client.query(`SELECT pg_advisory_lock(${KB_DDL_LOCK_KEY})`);
    dadp = true;
    if (excludePrisma) {
      await client.query(`SELECT pg_advisory_lock(${PRISMA_ADVISORY_LOCK})`);
      prismaHeld = true;
    }
    await assertNoPendingRestore(client);
    if (ctx.abort?.signal.aborted)
      throw new Refusal("Runner or mutation session was cancelled; continuation refused.");
    ctx.mutationClient = client;
    const result = await action(client);
    if (lost) throw new Refusal("Mutation lock connection was lost; continuation refused.");
    return result;
  } finally {
    client.removeListener?.("error", onLost);
    client.removeListener?.("end", onLost);
    ctx.mutationClient = previous;
    try {
      if (prismaHeld && !lost)
        await client.query(`SELECT pg_advisory_unlock(${PRISMA_ADVISORY_LOCK})`);
      if (dadp && !lost) await client.query(`SELECT pg_advisory_unlock(${KB_DDL_LOCK_KEY})`);
    } finally {
      if (!existing) await client.end().catch(() => {});
    }
  }
}

async function readMutationFacts(ctx, client) {
  // Never hold this key around a Prisma child, which obtains its own key.
  await client.query(`SELECT pg_advisory_lock(${PRISMA_ADVISORY_LOCK})`);
  try {
    await assertNoPendingRestore(client);
    const state = await ctx.state(client);
    refuseCommon(state);
    const empty = await isManagedSchemaEmpty(client, ctx.schema);
    const contracts = (await runtimeTablesExist(client, ctx.schema))
      ? (
          await client.query(
            `SELECT name, contract_checksum, contract_applied_at FROM ${client.escapeIdentifier(ctx.schema)}."_knowledge_base_migration" ORDER BY name`,
          )
        ).rows
      : [];
    const catalog = await readApplicationCatalog(client, ctx.schema);
    return {
      catalog,
      state: state.state,
      applied: state.applied,
      pending: state.pending,
      failed: state.failed,
      mismatch: state.checksumMismatch,
      empty,
      contracts,
    };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(${PRISMA_ADVISORY_LOCK})`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "hold") process.exitCode = await runHold({ args: args.slice(1) });
  else {
    const roleAt = args.indexOf("--role");
    const role = roleAt >= 0 ? args.splice(roleAt, 2)[1] : undefined;
    const mode = /** @type {"apply" | "wait"} */ (args[0] ?? "apply");
    process.exitCode = await run({ mode, role });
  }
}
