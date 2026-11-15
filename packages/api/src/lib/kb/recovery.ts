import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@knowledge-base/db/client";
import { logInternalError } from "@knowledge-base/env/log";
import { recoverCasPublications } from "./asset-lineage";
import { kbBareRepoPath, readHeadSha, readRefOrBroken, runGit } from "./git-read";
import { fsyncPublishedRef, objectExists } from "./git-write";
import type { KbCreatePreparedDelta } from "./kb-lifecycle-intent";
import {
  checkoutPinnedSession,
  enqueueKbOperation,
  KB_LOCK_CLASSID,
  KbLockError,
  kbLockObjid,
  type LockQuery,
} from "./lock";
import { sweepMergeScratch } from "./merge-scratch";
import {
  abortIntent,
  finalizeIntent,
  KB_CREATE_OPERATION,
  reconcileKbIntents,
} from "./operation-intent";
import { sweepAbandonedPushSpools } from "./push-spool";
import { releaseQuota } from "./quota";
import { setKbRecoveryComplete } from "./recovery-gate";
import { sweepExpiredStagedUploads } from "./uploads";

export {
  assertKbRecoveryComplete,
  kbRecoveryGateOpen,
  setKbRecoveryComplete,
} from "./recovery-gate";

export const RECOVERY_SWEEP_MS = 60_000;
/**
 * The most ACTIVE KBs one recovery pass may newly quarantine. A pass whose
 * KB-local failures exceed it, or exceed half of the ACTIVE KBs, quarantines
 * nothing and aborts instead (retried next pass): that many healthy-until-now
 * KBs failing together is more likely one host fault than separate damage,
 * and quarantine is permanent until an operator acts. KBs already
 * REPAIR_REQUIRED that keep failing do not count.
 */
export const RECOVERY_QUARANTINE_LIMIT_PER_PASS = 3;

let sweepInFlight: Promise<void> | undefined;

/** A failed ref read alone cannot distinguish an unborn repo from corruption. */
function initialMainRefIsAbsent(repoPath: string): boolean {
  try {
    if (!lstatSync(repoPath).isDirectory()) return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  try {
    // Even a malformed or dangling loose ref is evidence of publication.
    lstatSync(join(repoPath, "refs/heads/main"));
    return false;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  try {
    // Check packed refs too; only Git's explicit missing-ref status is absent.
    runGit(repoPath, ["show-ref", "--verify", "--quiet", "refs/heads/main"]);
    return false;
  } catch (error) {
    return error instanceof Error && "status" in error && error.status === 1;
  }
}

export async function recoverCreatingKnowledgeBase(
  query: LockQuery,
  reposDir: string,
  kbId: string,
): Promise<void> {
  const rows = await query<{ state: string }>(
    `SELECT state::text AS state FROM "knowledge_base" WHERE id = $1`,
    [kbId],
  );
  const state = rows.rows[0]?.state;
  if (state !== "CREATING") return;
  const intents = await query<{
    opId: string;
    phase: string;
    oldRef: string | null;
    newRef: string | null;
    reservedKbId: string | null;
    preparedDelta: unknown;
  }>(
    `SELECT "opId", phase::text AS phase, "oldRef", "newRef", "reservedKbId", "preparedDelta"
       FROM "operation_intent"
      WHERE operation = $2 AND ("reservedKbId" = $1 OR "kbId" = $1)
      ORDER BY "createdAt" DESC LIMIT 1`,
    [kbId, KB_CREATE_OPERATION],
  );
  const intent = intents.rows[0];
  if (intent?.phase === "FINALIZED") return;
  const targetKbId = intent?.reservedKbId ?? kbId;
  const repoPath = kbBareRepoPath(reposDir, targetKbId);
  // A broken ref settles below as REPAIR_REQUIRED (readRefOrBroken).
  const actual = await readRefOrBroken(() => readHeadSha(repoPath));
  if (
    intent?.phase === "COMMITTING" &&
    intent.newRef &&
    intent.newRef !== intent.oldRef &&
    actual === intent.newRef &&
    objectExists({ reposDir, kbId: targetKbId }, intent.newRef)
  ) {
    fsyncPublishedRef({ reposDir, kbId: targetKbId }, "refs/heads/main");
    await finalizeIntent(query, intent.opId);
    return;
  }

  const unpublished =
    actual === null
      ? (!intent?.oldRef || intent.oldRef === "0".repeat(40)) && initialMainRefIsAbsent(repoPath)
      : actual === intent?.oldRef && objectExists({ reposDir, kbId: targetKbId }, actual);
  if (!unpublished) {
    // Stop retries without discarding the ref/delta evidence or releasing the
    // held quota for history that may already be published. Never adopt/reset.
    if (intent) {
      await abortIntent(query, intent.opId, "kb create ref diverged or is corrupt");
    }
    await query(
      `UPDATE "knowledge_base"
          SET state = 'REPAIR_REQUIRED'::"KnowledgeBaseState", "updatedAt" = now()
        WHERE id = $1 AND state = 'CREATING'::"KnowledgeBaseState"`,
      [kbId],
    );
    return;
  }
  if (intent) {
    await abortIntent(query, intent.opId, "interrupted kb create");
    await releaseKbCreateQuotaIfRecorded(query, intent);
  }
  await query(
    `UPDATE "knowledge_base"
        SET state = 'TOMBSTONED'::"KnowledgeBaseState", "updatedAt" = now()
      WHERE id = $1 AND state = 'CREATING'::"KnowledgeBaseState"`,
    [kbId],
  );
}

/** Release a kb_create's held publication quota exactly once per abort path. */
async function releaseKbCreateQuotaIfRecorded(
  query: LockQuery,
  intent: { preparedDelta: unknown },
): Promise<void> {
  const delta = intent.preparedDelta as KbCreatePreparedDelta | null | undefined;
  if (delta?.kind === "kb_create" && delta.quotaReservationId) {
    await releaseQuota({ transactionQuery: query }, [delta.quotaReservationId]);
  }
}

/**
 * Settle a KB_CREATE intent whose CREATING-row transaction never linked it
 * (kbId is still NULL). Must run under the reserved KB's operation gate and
 * advisory lock: an in-flight create holds the same gate from its reservation
 * insert through COMMITTING, so this can never abort a live preparation.
 */
async function settleOrphanKbCreateIntent(query: LockQuery, opId: string): Promise<void> {
  const rows = await query<{
    phase: string;
    kbId: string | null;
    preparedDelta: unknown;
  }>(
    `SELECT phase::text AS phase, "kbId", "preparedDelta"
       FROM "operation_intent" WHERE "opId" = $1 FOR UPDATE`,
    [opId],
  );
  const intent = rows.rows[0];
  if (!intent || intent.kbId) return;
  if (intent.phase !== "PREPARED" && intent.phase !== "COMMITTING") return;
  await abortIntent(query, opId, "orphaned kb create reservation");
  await releaseKbCreateQuotaIfRecorded(query, intent);
}

async function recoverOneKnowledgeBase(
  query: LockQuery,
  reposDir: string,
  kbId: string,
): Promise<void> {
  await recoverCreatingKnowledgeBase(query, reposDir, kbId);
  await reconcileKbIntents(query, reposDir, kbId);
}

/**
 * Error codes of the host, not of one KB: no space or quota, descriptor or
 * process exhaustion, memory, a read-only or busy mount, a timeout. Every KB would fail the same way, and the fault can clear, so they
 * abort the sweep (retried next pass) rather than quarantine anything.
 */
const HOST_LEVEL_ERROR_CODES = new Set([
  "ENOSPC",
  "EDQUOT",
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "EWOULDBLOCK",
  "ENOMEM",
  "EROFS",
  "EBUSY",
  "ETIMEDOUT",
  "EINTR",
]);

/**
 * Whether a recovery failure may be this KB's own (an I/O error on its files,
 * a Git failure or unreadable storage in its repository, a corrupt journal
 * row) and so a quarantine candidate. Never one, so the pass aborts as before
 * and the next one retries:
 * - a PostgreSQL error (SQLSTATE `code` plus `severity`) and a lost KB lock;
 * - a host-level errno ({@link HOST_LEVEL_ERROR_CODES}).
 * Everything else is only a candidate: whether it is quarantined depends on
 * how many KBs failed in the same pass ({@link RECOVERY_QUARANTINE_LIMIT_PER_PASS}),
 * which is what tells one damaged repository from git missing or a broken mount.
 */
export function isKbLocalRecoveryFailure(error: unknown): boolean {
  if (error instanceof KbLockError) return false;
  if (!error || typeof error !== "object") return true;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  if (typeof severity === "string" && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return false;
  }
  if (typeof code === "string" && HOST_LEVEL_ERROR_CODES.has(code)) return false;
  return true;
}

/**
 * Whether a pass may quarantine its `candidates` newly failing ACTIVE KBs out
 * of `activeKbs`: at most {@link RECOVERY_QUARANTINE_LIMIT_PER_PASS}, and at
 * most half of the ACTIVE KBs (a single-KB instance never isolates; its pass
 * aborts and retries, as before isolation existed).
 */
export function mayQuarantine(candidates: number, activeKbs: number): boolean {
  return candidates <= RECOVERY_QUARANTINE_LIMIT_PER_PASS && candidates * 2 <= activeKbs;
}

/** KBs whose continuing failure (already quarantined, or not ACTIVE) this process has logged. */
const loggedStillFailing = new Set<string>();

function logStillFailing(
  site: "kb.recovery-kb-quarantined" | "kb.recovery-kb-unmarked",
  kbId: string,
  error: unknown,
) {
  // Retried every pass; say so once per process (until it recovers), not every minute.
  if (loggedStillFailing.has(kbId)) return;
  loggedStillFailing.add(kbId);
  logInternalError(site, error, { kbId });
}

/**
 * Mark one ACTIVE KB REPAIR_REQUIRED after its recovery failed, under its
 * operation gate, advisory lock and the volume fence (no writer interleaves).
 * Only an ACTIVE row changes: CREATING is left to `recoverCreatingKnowledgeBase`
 * (creation finalization only accepts CREATING; marking it would strand the
 * create intent, its reservation and its slug), and a TOMBSTONED KB is never
 * resurrected. A KB whose lock is busy is left as it is (retried next pass).
 * A mark that cannot be written propagates and aborts the pass.
 */
async function markRecoveryQuarantine(
  connectionString: string,
  kbId: string,
  error: unknown,
  assertFence: () => void,
): Promise<void> {
  await enqueueKbOperation(kbId, async () => {
    const lease = await checkoutPinnedSession({
      connectionString,
      opId: `recovery-quarantine-${randomUUID()}`,
    });
    try {
      const locked = await lease.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS ok",
        [KB_LOCK_CLASSID, kbLockObjid(kbId)],
      );
      if (!locked.rows[0]?.ok) {
        logStillFailing("kb.recovery-kb-unmarked", kbId, error);
        return;
      }
      assertFence();
      const marked = await lease.transaction(async (query) => {
        const updated = await query(
          `UPDATE "knowledge_base"
              SET state = 'REPAIR_REQUIRED'::"KnowledgeBaseState", "updatedAt" = now()
            WHERE id = $1 AND state = 'ACTIVE'::"KnowledgeBaseState"`,
          [kbId],
        );
        return (updated.rowCount ?? 0) > 0;
      });
      if (marked) {
        loggedStillFailing.delete(kbId);
        logInternalError("kb.recovery-kb", error, { kbId });
      } else {
        logStillFailing("kb.recovery-kb-unmarked", kbId, error);
      }
    } finally {
      await lease.close();
    }
  });
}

/**
 * Recover one KB under its operation gate, advisory lock and the volume fence.
 *
 * Failure isolation: a failure while reconciling THIS KB (a storage error in
 * its repository or CAS files, a corrupt journal row) is returned instead of
 * thrown, so the sweep goes on with the other KBs; `settleRecoveryFailures`
 * then decides whether to quarantine it. The KB's transaction rolled back, so
 * nothing it held is released: reservations, staged-upload claims and pending
 * CAS rows stay as they were.
 * Everything that is not a KB-local failure still aborts the sweep, as before:
 * a lost volume fence (re-asserted first), a database, KB-lock or host-level
 * error ({@link isKbLocalRecoveryFailure}), or a session or lock that cannot be
 * obtained.
 */
async function recoverKbUnderFence(
  connectionString: string,
  reposDir: string,
  kbId: string,
  assertFence: () => void,
  settleIntent?: (query: LockQuery) => Promise<void>,
  casOnly = false,
): Promise<{ failure?: unknown }> {
  let failure: unknown;
  let failed = false;
  await enqueueKbOperation(kbId, async () => {
    const lease = await checkoutPinnedSession({
      connectionString,
      opId: `recovery-${randomUUID()}`,
    });
    try {
      const locked = await lease.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS ok",
        [KB_LOCK_CLASSID, kbLockObjid(kbId)],
      );
      if (!locked.rows[0]?.ok) return;
      // The operation gate admits us only after the previous writer drained;
      // the lifetime volume fence also excludes a former server's descendants.
      // Both must hold before reconciliation unlinks Git's abandoned ref lock.
      assertFence();
      try {
        if (casOnly) {
          // Separate transactions preserve disk-before-logical order even across
          // abandoned attempts that used different backing volumes.
          while (await lease.transaction((query) => recoverCasPublications(query, kbId))) {
            assertFence();
          }
          return;
        }
        // One transaction per KB reconciliation: the complete delta — head
        // update, durable job, audit, and the FINALIZED receipt — commits
        // atomically, so no half-finalized intent is ever observable.
        await lease.transaction(async (query) => {
          await settleIntent?.(query);
          await recoverOneKnowledgeBase(query, reposDir, kbId);
        }, false);
      } catch (error) {
        // A lost fence is never one KB's failure: fail the whole sweep closed.
        assertFence();
        if (!isKbLocalRecoveryFailure(error)) throw error;
        // A quarantine candidate: the pass decides once it has seen every KB.
        failure = error;
        failed = true;
      }
    } finally {
      await lease.close();
    }
  });
  return failed ? { failure } : {};
}

/**
 * Decide the pass's KB-local failures once every KB was tried. ACTIVE ones are
 * quarantine candidates: within {@link mayQuarantine} each is marked
 * REPAIR_REQUIRED and the pass continues; beyond it the pass quarantines
 * nothing and aborts with the first failure (fail closed, retried next pass).
 * Failures of KBs that are not ACTIVE (already REPAIR_REQUIRED, CREATING, a
 * tombstone's CAS rows, a vanished row) never count and are only logged.
 * Nothing a failed KB held was released: its transaction rolled back.
 */
async function settleRecoveryFailures(
  db: PrismaClient,
  connectionString: string,
  failures: Map<string, unknown>,
  assertFence: () => void,
): Promise<void> {
  if (failures.size === 0) return;
  const ids = [...failures.keys()];
  const rows = await db.$queryRaw<{ id: string; state: string }[]>`
    SELECT id, state::text AS state FROM "knowledge_base" WHERE id = ANY(${ids}::text[])`;
  const stateOf = new Map(rows.map((row) => [row.id, row.state]));
  const candidates = ids.filter((id) => stateOf.get(id) === "ACTIVE");
  for (const id of ids) {
    if (stateOf.get(id) === "ACTIVE") continue;
    logStillFailing(
      stateOf.get(id) === "REPAIR_REQUIRED"
        ? "kb.recovery-kb-quarantined"
        : "kb.recovery-kb-unmarked",
      id,
      failures.get(id),
    );
  }
  if (candidates.length === 0) return;
  const totals = await db.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM "knowledge_base" WHERE state = 'ACTIVE'::"KnowledgeBaseState"`;
  if (!mayQuarantine(candidates.length, totals[0]?.count ?? 0)) throw failures.get(candidates[0]!);
  assertFence();
  for (const id of candidates) {
    await markRecoveryQuarantine(connectionString, id, failures.get(id), assertFence);
  }
}

export async function runStartupJournalRecovery(
  db: PrismaClient,
  reposDir: string,
  assetsDir: string,
  connectionString: string,
  assertFence: () => void,
): Promise<void> {
  setKbRecoveryComplete(false);
  try {
    // Startup recovery is the same fenced, per-KB-transactional pass as the
    // periodic sweep — there is exactly one reconciliation implementation.
    await runJournalRecoverySweep(db, reposDir, assetsDir, connectionString, assertFence);
    setKbRecoveryComplete(true);
  } catch (error) {
    setKbRecoveryComplete(false);
    throw error;
  }
}

export async function runJournalRecoverySweep(
  db: PrismaClient,
  reposDir: string,
  assetsDir: string,
  connectionString: string,
  assertFence: () => void,
): Promise<void> {
  // CAS settlement does not inspect Git. Recover its entire pending inventory
  // first so an unrelated broken repository cannot strand its held quota.
  // Include tombstones: quota ownership survives KB lifecycle changes. Keyset
  // pages stay bounded while recovering rows disappear from the pending set.
  sweepAbandonedPushSpools(reposDir, assertFence);
  await sweepMergeScratch(reposDir, assertFence, async (opId) => {
    const lease = await checkoutPinnedSession({
      connectionString,
      opId: `recovery-${randomUUID()}`,
    });
    try {
      await lease.transaction(async (query) => {
        const rows = await query<{ id: string }>(
          `SELECT id FROM quota_reservation WHERE "opId"=$1 AND outcome='RESERVED' LIMIT 32`,
          [opId],
        );
        if (rows.rows.length)
          await releaseQuota(
            { transactionQuery: query },
            rows.rows.map((r) => r.id),
          );
      });
    } finally {
      await lease.close();
    }
  });
  // KB-local failures of this pass, by KB. Later loops skip a failed KB
  // rather than fail (and log) it again; the next sweep retries it.
  const failures = new Map<string, unknown>();
  const recoverOnce = async (
    kbId: string,
    settleIntent?: (query: LockQuery) => Promise<void>,
    casOnly = false,
  ) => {
    if (failures.has(kbId)) return;
    const result = await recoverKbUnderFence(
      connectionString,
      reposDir,
      kbId,
      assertFence,
      settleIntent,
      casOnly,
    );
    if ("failure" in result) failures.set(kbId, result.failure);
    else loggedStillFailing.delete(kbId);
  };
  let afterKbId = "";
  for (;;) {
    const pending = await db.$queryRaw<{ kbId: string }[]>`
      SELECT DISTINCT "kbId" FROM "cas_publication"
       WHERE state = 'PENDING'::"CasPublicationState" AND "kbId" > ${afterKbId}
       ORDER BY "kbId" LIMIT 100`;
    if (pending.length === 0) break;
    for (const row of pending) {
      await recoverOnce(row.kbId, undefined, true);
    }
    afterKbId = pending[pending.length - 1]!.kbId;
  }
  const kbs = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "knowledge_base"
     WHERE state IN ('ACTIVE'::"KnowledgeBaseState", 'CREATING'::"KnowledgeBaseState", 'REPAIR_REQUIRED'::"KnowledgeBaseState")`;
  for (const kb of kbs) {
    await recoverOnce(kb.id);
  }
  const orphans = await db.$queryRaw<
    {
      kbId: string | null;
      opId: string;
      operation: string;
      reservedKbId: string | null;
    }[]
  >`SELECT "kbId", "opId", operation, "reservedKbId" FROM "operation_intent"
     WHERE phase IN ('PREPARED'::"OperationIntentPhase", 'COMMITTING'::"OperationIntentPhase")`;
  assertFence();
  for (const intent of orphans) {
    if (!intent.kbId) {
      if (intent.operation !== KB_CREATE_OPERATION) continue;
      if (intent.reservedKbId) {
        // Serialize on the persisted reservation: the in-flight create holds
        // this same per-KB gate from reservation insert through COMMITTING,
        // so an orphan can only be settled after that attempt drained.
        await recoverOnce(intent.reservedKbId, (query) =>
          settleOrphanKbCreateIntent(query, intent.opId),
        );
        continue;
      }
      const lease = await checkoutPinnedSession({
        connectionString,
        opId: `recovery-orphan-${randomUUID()}`,
      });
      try {
        await lease.transaction(async (query) => {
          await settleOrphanKbCreateIntent(query, intent.opId);
        });
      } finally {
        await lease.close();
      }
      continue;
    }
    await recoverOnce(intent.kbId);
  }
  await settleRecoveryFailures(db, connectionString, failures, assertFence);
  // Settle every pending journal before allowing staging expiry/reclaim.
  assertFence();
  await sweepExpiredStagedUploads(connectionString, assetsDir);
  assertFence();
}

export function startJournalRecoverySweep(
  db: PrismaClient,
  reposDir: string,
  assetsDir: string,
  connectionString: string,
  assertFence: () => void,
  recoverAssetCache?: () => Promise<void>,
): { stop(): Promise<void> } {
  let stopped = false;
  // A stuck sweep (bounded per-row progress, see sweepExpiredStagedUploads —
  // but a single sweep can still take a while under load) must not cause
  // every subsequent 60s tick to launch another overlapping invocation on
  // top of it: this guard skips a tick while the previous one is still
  // in flight rather than letting concurrent sweeps accumulate.
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    sweepInFlight = (async () => {
      await recoverAssetCache?.();
      await runJournalRecoverySweep(db, reposDir, assetsDir, connectionString, assertFence);
    })()
      .catch((error: unknown) => {
        logInternalError("kb.recovery-sweep", error);
      })
      .finally(() => {
        running = false;
      });
  }, RECOVERY_SWEEP_MS);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await sweepInFlight;
    },
  };
}
