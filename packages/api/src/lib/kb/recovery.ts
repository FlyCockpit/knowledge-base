import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@knowledge-base/db/client";
import { logInternalError } from "@knowledge-base/env/log";
import { recoverCasPublications } from "./asset-lineage";
import { kbBareRepoPath, readHeadSha, runGit } from "./git-read";
import { fsyncPublishedRef, objectExists } from "./git-write";
import type { KbCreatePreparedDelta } from "./kb-lifecycle-intent";
import {
  checkoutPinnedSession,
  enqueueKbOperation,
  KB_LOCK_CLASSID,
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
  const actual = readHeadSha(repoPath);
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

async function recoverKbUnderFence(
  connectionString: string,
  reposDir: string,
  kbId: string,
  assertFence: () => void,
  settleIntent?: (query: LockQuery) => Promise<void>,
  casOnly = false,
): Promise<void> {
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
    } finally {
      await lease.close();
    }
  });
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
  let afterKbId = "";
  for (;;) {
    const pending = await db.$queryRaw<{ kbId: string }[]>`
      SELECT DISTINCT "kbId" FROM "cas_publication"
       WHERE state = 'PENDING'::"CasPublicationState" AND "kbId" > ${afterKbId}
       ORDER BY "kbId" LIMIT 100`;
    if (pending.length === 0) break;
    for (const row of pending) {
      await recoverKbUnderFence(connectionString, reposDir, row.kbId, assertFence, undefined, true);
    }
    afterKbId = pending[pending.length - 1]!.kbId;
  }
  const kbs = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "knowledge_base"
     WHERE state IN ('ACTIVE'::"KnowledgeBaseState", 'CREATING'::"KnowledgeBaseState", 'REPAIR_REQUIRED'::"KnowledgeBaseState")`;
  for (const kb of kbs) {
    await recoverKbUnderFence(connectionString, reposDir, kb.id, assertFence);
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
        await recoverKbUnderFence(
          connectionString,
          reposDir,
          intent.reservedKbId,
          assertFence,
          (query) => settleOrphanKbCreateIntent(query, intent.opId),
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
    await recoverKbUnderFence(connectionString, reposDir, intent.kbId, assertFence);
  }
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
