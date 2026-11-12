import { randomUUID } from "node:crypto";

import type { DurableJob, DurableJobKind, Prisma, PrismaClient } from "@knowledge-base/db/client";
import { logInternalError } from "@knowledge-base/env/log";
import { z } from "zod";

import {
  failDeadBuildGeneration,
  prismaTransactionQuery,
  UNFINISHED_GENERATION_STATES_SQL,
} from "./build-liveness";
import type { LockQuery } from "./lock";

export const DISPATCH_CLAIM_MS = 30_000;
export const DISPATCH_BATCH_SIZE = 50;
export const DISPATCH_INTERVAL_MS = 2_000;
/**
 * R3-W4: Postgres NOTIFY channel a durable enqueue signals on commit; the worker's dispatcher
 * LISTENs and runs a cycle at once, so the 2 s poll is only the fallback.
 */
export const DURABLE_DISPATCH_CHANNEL = "kb_durable_dispatch";
export const WORKER_LEASE_MS = 30_000;
export const WORKER_HEARTBEAT_MS = 5_000;
export const MAX_DURABLE_RETRY_ATTEMPTS = 5;
export const DURABLE_RETRY_DELAYS_SEC = [1, 2, 4, 8, 16] as const;

export const durableJobStates = [
  "PENDING",
  "PUBLISHED",
  "RUNNING",
  "RETRY",
  "COMPLETE",
  "FAILED",
  "CANCELLED",
] as const;

export type DurableJobState = (typeof durableJobStates)[number];

export const durableProbeDesiredSchema = z.object({
  marker: z.string().min(1).max(200),
});

export type DurableProbeDesired = z.infer<typeof durableProbeDesiredSchema>;

export const durableQueuePayloadSchema = z.object({
  durableJobId: z.string().uuid(),
});

export class DurableJobFenceError extends Error {
  constructor(message = "Durable job attempt fence rejected the operation.") {
    super(message);
    this.name = "DurableJobFenceError";
  }
}

export class DurableJobCancelledError extends Error {
  constructor(message = "Durable job was cancelled.") {
    super(message);
    this.name = "DurableJobCancelledError";
  }
}

type Db = Pick<
  PrismaClient,
  "$queryRaw" | "$executeRaw" | "durableJob" | "durableJobProbeEffect" | "$transaction"
>;

export function durableBullmqJobId(jobId: string, attemptEpoch: number): string {
  return `${jobId}_e${attemptEpoch}`;
}

export function retryDelayMs(attemptCount: number, nowMs: number): number {
  const index = Math.min(Math.max(attemptCount, 1), DURABLE_RETRY_DELAYS_SEC.length) - 1;
  return nowMs + DURABLE_RETRY_DELAYS_SEC[index]! * 1000;
}

export function parseDesiredForKind(kind: DurableJobKind, desired: unknown): DurableProbeDesired {
  if (kind !== "PROBE") {
    throw new Error(`Unsupported durable job kind ${kind}`);
  }
  return durableProbeDesiredSchema.parse(desired);
}

export async function enqueueDurableJob(
  db: Db,
  input: {
    dedupKey: string;
    kind: DurableJobKind;
    desired: Prisma.InputJsonValue;
    now?: Date;
  },
): Promise<DurableJob> {
  const now = input.now ?? new Date();
  return db.durableJob.upsert({
    where: { dedupKey: input.dedupKey },
    create: {
      dedupKey: input.dedupKey,
      kind: input.kind,
      desired: input.desired,
      state: "PENDING",
      attemptEpoch: 1,
      attemptCount: 0,
      nextRunAt: now,
    },
    update: {},
  });
}

/** Enqueue through a pinned mutation transaction so finalize stays atomic with the journal. */
export async function enqueueDurableJobOnQuery(
  query: LockQuery,
  input: {
    dedupKey: string;
    kind: DurableJobKind;
    desired: Prisma.InputJsonValue;
    jobId?: string;
  },
): Promise<void> {
  const jobId = input.jobId ?? randomUUID();
  await query(
    `INSERT INTO "durable_job"
      ("id", "createdAt", "updatedAt", "dedupKey", kind, desired, state, "attemptEpoch", "attemptCount", "nextRunAt")
     VALUES ($1, now(), now(), $2, $3::"DurableJobKind", $4::jsonb, 'PENDING'::"DurableJobState", 1, 0, now())
     ON CONFLICT ("dedupKey") DO NOTHING`,
    [jobId, input.dedupKey, input.kind, JSON.stringify(input.desired)],
  );
  // Delivered when (and only if) the enqueuing transaction commits. The row
  // carries a plain integer, not pg_notify's void result, which not every
  // query port can decode (Prisma's raw queries reject a void column).
  await query("SELECT 1 AS notified FROM pg_notify($1, '')", [DURABLE_DISPATCH_CHANNEL]);
}

export async function retryDurableJob(
  db: Db,
  jobId: string,
  now = new Date(),
): Promise<DurableJob | null> {
  const updated = await db.durableJob.updateMany({
    where: { id: jobId, state: "FAILED" },
    data: {
      state: "PENDING",
      attemptEpoch: { increment: 1 },
      attemptCount: 0,
      nextRunAt: now,
      cancelledAt: null,
      completedAt: null,
      lastError: null,
      dispatchOwner: null,
      dispatchClaimUntil: null,
      workerOwner: null,
      leaseUntil: null,
      lastHeartbeatAt: null,
    },
  });
  if (updated.count === 0) return null;
  return db.durableJob.findUnique({ where: { id: jobId } });
}

export async function cancelDurableJob(db: Db, jobId: string, now = new Date()): Promise<boolean> {
  const updated = await db.durableJob.updateMany({
    where: { id: jobId, state: { notIn: ["COMPLETE", "CANCELLED"] } },
    data: {
      state: "CANCELLED",
      cancelledAt: now,
      dispatchOwner: null,
      dispatchClaimUntil: null,
      workerOwner: null,
      leaseUntil: null,
    },
  });
  return updated.count === 1;
}

export type DispatchRow = {
  id: string;
  kind: DurableJobKind;
  attemptEpoch: number;
  state: DurableJobState;
  attemptCount: number;
};

export const EXPIRED_LEASE_ERROR = "worker lease expired";

type AttemptFailurePlan =
  | { state: "FAILED"; attemptCount: number }
  | { state: "RETRY"; attemptCount: number; nextRunAt: Date };

/**
 * One initial attempt plus at most five retries (1,2,4,8,16s backoff), then
 * FAILED. Shared by worker-attributed failures and dispatcher recovery of
 * expired leases so both consume the same budget.
 */
function planAttemptFailure(attemptCount: number, nowMs: number): AttemptFailurePlan {
  const nextAttemptCount = attemptCount + 1;
  if (nextAttemptCount > MAX_DURABLE_RETRY_ATTEMPTS) {
    return { state: "FAILED", attemptCount: nextAttemptCount };
  }
  return {
    state: "RETRY",
    attemptCount: nextAttemptCount,
    nextRunAt: new Date(retryDelayMs(nextAttemptCount, nowMs)),
  };
}

/**
 * An expired worker attempt is a fenced failure of that execution, never an
 * in-place republish: consume one retry, invalidate the stale worker fence
 * with a fresh monotonic attemptEpoch, and persist the literal backoff
 * deadline. The replacement delivery is published only once the RETRY row is
 * due again, under the deterministic BullMQ id of the new epoch.
 */
async function recoverExpiredAttempt(
  tx: Pick<PrismaClient, "durableJob" | "$queryRawUnsafe" | "$executeRawUnsafe">,
  row: Pick<DispatchRow, "id" | "kind" | "attemptCount">,
  now: Date,
): Promise<boolean> {
  const plan = planAttemptFailure(row.attemptCount, now.getTime());
  let settlesGeneration = false;
  // An exhausted index build fails together with its generation (R5): the
  // job never turns terminal while its generation still reads as building.
  // When that generation can't be settled without waiting (its fence or a
  // volume account is busy), the row stays RUNNING, deferred one claim window.
  if (plan.state === "FAILED" && row.kind === "INDEX_KB") {
    const query = prismaTransactionQuery(tx);
    const generation = (
      await query<{ id: string }>(
        `SELECT id FROM index_generation WHERE "jobId" = $1 AND state IN ${UNFINISHED_GENERATION_STATES_SQL}`,
        [row.id],
      )
    ).rows[0];
    if (
      generation &&
      !(await failDeadBuildGeneration(query, generation.id, {
        errorCode: "INDEX_BUILD_FAILED",
        requireDeadJob: false,
      }))
    )
      return false;
    settlesGeneration = generation !== undefined;
  }
  const recovered = await tx.durableJob.updateMany({
    where: { id: row.id, state: "RUNNING", leaseUntil: { lt: now } },
    data: {
      state: plan.state,
      attemptCount: plan.attemptCount,
      ...(plan.state === "RETRY"
        ? { attemptEpoch: { increment: 1 } as const, nextRunAt: plan.nextRunAt }
        : {}),
      lastError: EXPIRED_LEASE_ERROR,
      workerOwner: null,
      leaseUntil: null,
      lastHeartbeatAt: null,
      dispatchOwner: null,
      dispatchClaimUntil: null,
    },
  });
  // The claim locked this RUNNING row; never commit its generation's failure alone.
  if (settlesGeneration && recovered.count !== 1) throw new DurableJobFenceError();
  return recovered.count === 1;
}

export async function claimDispatchBatch(
  db: Db,
  input: { owner: string; now: Date; limit?: number },
): Promise<DispatchRow[]> {
  const limit = input.limit ?? DISPATCH_BATCH_SIZE;
  const claimUntil = new Date(input.now.getTime() + DISPATCH_CLAIM_MS);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<DispatchRow[]>`
      SELECT id, kind, "attemptEpoch", state, "attemptCount"
        FROM durable_job
       WHERE (
          (state IN ('PENDING', 'RETRY') AND "nextRunAt" <= ${input.now}
            AND ("dispatchClaimUntil" IS NULL OR "dispatchClaimUntil" < ${input.now}))
          OR (state = 'PUBLISHED'
            AND ("dispatchClaimUntil" IS NULL OR "dispatchClaimUntil" < ${input.now}))
          OR (state = 'RUNNING'
            AND "leaseUntil" < ${input.now}
            AND ("dispatchClaimUntil" IS NULL OR "dispatchClaimUntil" < ${input.now}))
        )
        ORDER BY CASE WHEN state = 'PUBLISHED' THEN 1 ELSE 0 END, "nextRunAt", id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return [];
    const publishable: DispatchRow[] = [];
    // Expired RUNNING rows this pass leaves RUNNING: claimed for one window,
    // so a row that can't be recovered yet never heads every later batch.
    const deferred: string[] = [];
    for (const row of rows) {
      if (row.state !== "RUNNING") {
        publishable.push(row);
        continue;
      }
      // Each recovery is its own unit: one that fails (an inconsistent
      // reservation its generation's release trips on) rolls back alone and
      // stays RUNNING, deferred one claim window; the rest of the batch
      // still recovers and dispatches.
      await tx.$executeRaw`SAVEPOINT dispatch_recover_lease`;
      try {
        if (!(await recoverExpiredAttempt(tx, row, input.now))) deferred.push(row.id);
        await tx.$executeRaw`RELEASE SAVEPOINT dispatch_recover_lease`;
      } catch (error) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT dispatch_recover_lease`;
        deferred.push(row.id);
        logInternalError("kb.dispatch-recovery", error, { jobId: row.id, kind: row.kind });
      }
    }
    if (deferred.length > 0)
      await tx.durableJob.updateMany({
        where: { id: { in: deferred }, state: "RUNNING" },
        data: { dispatchClaimUntil: claimUntil },
      });
    if (publishable.length === 0) return [];
    await tx.durableJob.updateMany({
      where: { id: { in: publishable.map((row) => row.id) } },
      data: {
        dispatchOwner: input.owner,
        dispatchClaimUntil: claimUntil,
      },
    });
    return publishable;
  });
}

/**
 * Acknowledge a publication and release the dispatch claim. The
 * acknowledgment is fenced to states a dispatcher may legitimately move to
 * PUBLISHED: a fresh PENDING/RETRY publish, or an idempotent re-ack of an
 * already-PUBLISHED row that still has no worker. A RUNNING row is never
 * accepted — a worker that claimed the delivery between the dispatcher's
 * claim and this acknowledgment owns the lease, and `claimJobAttempt` has
 * already cleared `dispatchOwner`, so this update cannot match and revoke it.
 */
export async function markDispatchPublished(
  db: Db,
  input: { jobId: string; owner: string; now: Date },
): Promise<boolean> {
  const updated = await db.durableJob.updateMany({
    where: {
      id: input.jobId,
      dispatchOwner: input.owner,
      cancelledAt: null,
      OR: [
        { state: { in: ["PENDING", "RETRY"] } },
        { state: "PUBLISHED", workerOwner: null, leaseUntil: null },
      ],
    },
    data: {
      state: "PUBLISHED",
      dispatchOwner: null,
      dispatchClaimUntil: null,
      workerOwner: null,
      leaseUntil: null,
      lastHeartbeatAt: null,
    },
  });
  return updated.count === 1;
}

export async function releaseDispatchClaim(
  db: Db,
  input: { jobId: string; owner: string },
): Promise<void> {
  await db.durableJob.updateMany({
    where: { id: input.jobId, dispatchOwner: input.owner },
    data: {
      dispatchOwner: null,
      dispatchClaimUntil: null,
    },
  });
}

/**
 * A worker claims exactly one delivery of a PUBLISHED row and receives the
 * acquired fence atomically: the row returned by `UPDATE … RETURNING` is the
 * row as this claim wrote it, read under the row lock inside the same
 * statement. A separate follow-up read could observe a later state — lease
 * expiry, recovery, and a replacement worker (even one sharing this worker
 * id) advancing the epoch — and hand the caller a fence it never acquired.
 * Expired RUNNING attempts are never stolen in place: recovery (see
 * `claimDispatchBatch`) converts them to fenced RETRY failures with backoff,
 * and only the republished row — carrying a fresh attemptEpoch — becomes
 * claimable again. Clearing the dispatch claim here invalidates any
 * publication acknowledgment a dispatcher might still be holding for this
 * row, so a late ack cannot reset the lease this worker just acquired.
 */
export async function claimJobAttempt(
  db: Db,
  input: { jobId: string; workerId: string; now: Date },
): Promise<DurableJob | null> {
  const leaseUntil = new Date(input.now.getTime() + WORKER_LEASE_MS);
  const rows = await db.$queryRaw<DurableJob[]>`
    UPDATE durable_job
       SET state = 'RUNNING',
           "updatedAt" = ${input.now},
           "workerOwner" = ${input.workerId},
           "leaseUntil" = ${leaseUntil},
           "lastHeartbeatAt" = ${input.now},
           "dispatchOwner" = NULL,
           "dispatchClaimUntil" = NULL
     WHERE id = ${input.jobId}
       AND state = 'PUBLISHED'
       AND "cancelledAt" IS NULL
       AND ("leaseUntil" IS NULL OR "leaseUntil" < ${input.now})
    RETURNING *`;
  return rows[0] ?? null;
}

export async function heartbeatJobAttempt(
  db: Db,
  input: { jobId: string; workerId: string; attemptEpoch: number; now: Date },
): Promise<boolean> {
  const leaseUntil = new Date(input.now.getTime() + WORKER_LEASE_MS);
  const updated = await db.durableJob.updateMany({
    where: {
      id: input.jobId,
      workerOwner: input.workerId,
      attemptEpoch: input.attemptEpoch,
      state: "RUNNING",
      cancelledAt: null,
      leaseUntil: { gt: input.now },
    },
    data: {
      leaseUntil,
      lastHeartbeatAt: input.now,
    },
  });
  return updated.count === 1;
}

function terminalGuard(state: DurableJobState, cancelledAt: Date | null): void {
  if (state === "CANCELLED" || cancelledAt) {
    throw new DurableJobCancelledError();
  }
}

export async function completeJobAttempt(
  db: Db,
  input: { jobId: string; workerId: string; attemptEpoch: number; now: Date },
): Promise<boolean> {
  const row = await db.durableJob.findUnique({
    where: { id: input.jobId },
    select: {
      state: true,
      cancelledAt: true,
      workerOwner: true,
      attemptEpoch: true,
    } satisfies Prisma.DurableJobSelect,
  });
  if (!row) return false;
  terminalGuard(row.state, row.cancelledAt);
  if (row.workerOwner !== input.workerId || row.attemptEpoch !== input.attemptEpoch) {
    throw new DurableJobFenceError();
  }
  if (row.state !== "RUNNING") {
    throw new DurableJobFenceError();
  }
  const updated = await db.durableJob.updateMany({
    where: {
      id: input.jobId,
      workerOwner: input.workerId,
      attemptEpoch: input.attemptEpoch,
      state: "RUNNING",
      cancelledAt: null,
    },
    data: {
      state: "COMPLETE",
      completedAt: input.now,
      workerOwner: null,
      leaseUntil: null,
      lastHeartbeatAt: null,
      dispatchOwner: null,
      dispatchClaimUntil: null,
    },
  });
  return updated.count === 1;
}

export async function failJobAttempt(
  db: Db,
  input: { jobId: string; workerId: string; attemptEpoch: number; now: Date; error: string },
): Promise<{ state: "RETRY" | "FAILED"; attemptCount: number } | null> {
  const row = await db.durableJob.findUnique({
    where: { id: input.jobId },
    select: {
      state: true,
      cancelledAt: true,
      workerOwner: true,
      attemptEpoch: true,
      attemptCount: true,
    } satisfies Prisma.DurableJobSelect,
  });
  if (!row) return null;
  if (row.cancelledAt || row.state === "CANCELLED") {
    throw new DurableJobCancelledError();
  }
  if (row.workerOwner !== input.workerId || row.attemptEpoch !== input.attemptEpoch) {
    throw new DurableJobFenceError();
  }
  if (row.state !== "RUNNING") {
    throw new DurableJobFenceError();
  }
  const plan = planAttemptFailure(row.attemptCount, input.now.getTime());
  const fence = {
    id: input.jobId,
    workerOwner: input.workerId,
    attemptEpoch: input.attemptEpoch,
    state: "RUNNING" as const,
    cancelledAt: null,
  };
  const updated = await db.durableJob.updateMany({
    where: fence,
    data: {
      state: plan.state,
      attemptCount: plan.attemptCount,
      ...(plan.state === "RETRY"
        ? { attemptEpoch: { increment: 1 } as const, nextRunAt: plan.nextRunAt }
        : {}),
      lastError: input.error.slice(0, 500),
      ...(plan.state === "RETRY" ? { dispatchOwner: null, dispatchClaimUntil: null } : {}),
      workerOwner: null,
      leaseUntil: null,
      lastHeartbeatAt: null,
    },
  });
  if (updated.count !== 1) {
    // The lease was stolen or cancelled between the guard read and this fenced
    // write: nothing transitioned, so report the fence rather than a retry
    // that was not persisted.
    throw new DurableJobFenceError();
  }
  return { state: plan.state, attemptCount: plan.attemptCount };
}

/** Settle on the caller's pinned transaction, after its domain row lock.
 * Dispatcher/heartbeat transactions take only the job lock and never enter a
 * domain transaction, so domain -> job -> quota has no reverse acquisition.
 */
export async function settleJobAttemptOnQuery(
  query: LockQuery,
  input: {
    jobId: string;
    workerId: string;
    attemptEpoch: number;
    now: Date;
    outcome: { state: "COMPLETE" } | { state: "FAILED"; error: string; retryable: boolean };
  },
): Promise<"COMPLETE" | "RETRY" | "FAILED"> {
  const { rows } = await query<
    Pick<DurableJob, "state" | "cancelledAt" | "workerOwner" | "attemptEpoch" | "attemptCount">
  >(
    `SELECT state, "cancelledAt", "workerOwner", "attemptEpoch", "attemptCount"
       FROM durable_job WHERE id = $1 FOR UPDATE`,
    [input.jobId],
  );
  const row = rows[0];
  if (!row) throw new DurableJobFenceError();
  assertRunningFence(row, input.workerId, input.attemptEpoch);
  const plan =
    input.outcome.state === "COMPLETE"
      ? { state: "COMPLETE" as const, attemptCount: row.attemptCount }
      : input.outcome.retryable
        ? planAttemptFailure(row.attemptCount, input.now.getTime())
        : { state: "FAILED" as const, attemptCount: row.attemptCount + 1 };
  await query(
    `UPDATE durable_job
        SET state = $2::"DurableJobState", "attemptCount" = $3,
            "attemptEpoch" = "attemptEpoch" + $4, "nextRunAt" = COALESCE($5, "nextRunAt"),
            "completedAt" = $6, "lastError" = $7, "updatedAt" = $8,
            "workerOwner" = NULL, "leaseUntil" = NULL, "lastHeartbeatAt" = NULL,
            "dispatchOwner" = NULL, "dispatchClaimUntil" = NULL
      WHERE id = $1`,
    [
      input.jobId,
      plan.state,
      plan.attemptCount,
      plan.state === "RETRY" ? 1 : 0,
      plan.state === "RETRY" ? plan.nextRunAt : null,
      plan.state === "COMPLETE" ? input.now : null,
      input.outcome.state === "FAILED" ? input.outcome.error.slice(0, 500) : null,
      input.now,
    ],
  );
  return plan.state;
}

function assertRunningFence(
  row: Pick<DurableJob, "state" | "cancelledAt" | "workerOwner" | "attemptEpoch">,
  workerId: string,
  attemptEpoch: number,
): void {
  terminalGuard(row.state, row.cancelledAt);
  if (row.workerOwner !== workerId || row.attemptEpoch !== attemptEpoch) {
    throw new DurableJobFenceError();
  }
  if (row.state !== "RUNNING") {
    throw new DurableJobFenceError();
  }
}

export async function recordProbeEffect(
  db: Db,
  input: { jobId: string; workerId: string; attemptEpoch: number; marker: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<Pick<DurableJob, "state" | "cancelledAt" | "workerOwner" | "attemptEpoch">>
    >`
      SELECT state, "cancelledAt", "workerOwner", "attemptEpoch"
        FROM durable_job
       WHERE id = ${input.jobId}
       FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new DurableJobFenceError();
    assertRunningFence(row, input.workerId, input.attemptEpoch);
    const inserted = await tx.$executeRaw`
      INSERT INTO durable_job_probe_effect ("jobId", "attemptEpoch", marker)
      SELECT ${input.jobId}, ${input.attemptEpoch}, ${input.marker}
        FROM durable_job
       WHERE id = ${input.jobId}
         AND "workerOwner" = ${input.workerId}
         AND "attemptEpoch" = ${input.attemptEpoch}
         AND state = 'RUNNING'
         AND "cancelledAt" IS NULL
      ON CONFLICT ("jobId") DO NOTHING`;
    if (inserted === 0) {
      const effect = await tx.durableJobProbeEffect.findUnique({ where: { jobId: input.jobId } });
      if (!effect || effect.attemptEpoch !== input.attemptEpoch || effect.marker !== input.marker) {
        throw new DurableJobFenceError();
      }
    }
  });
}

export async function commitProbeAttempt(
  db: Db,
  input: {
    jobId: string;
    workerId: string;
    attemptEpoch: number;
    marker: string;
    now: Date;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<Pick<DurableJob, "state" | "cancelledAt" | "workerOwner" | "attemptEpoch">>
    >`
      SELECT state, "cancelledAt", "workerOwner", "attemptEpoch"
        FROM durable_job
       WHERE id = ${input.jobId}
       FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new DurableJobFenceError();
    assertRunningFence(row, input.workerId, input.attemptEpoch);

    const inserted = await tx.$executeRaw`
      INSERT INTO durable_job_probe_effect ("jobId", "attemptEpoch", marker)
      SELECT ${input.jobId}, ${input.attemptEpoch}, ${input.marker}
        FROM durable_job
       WHERE id = ${input.jobId}
         AND "workerOwner" = ${input.workerId}
         AND "attemptEpoch" = ${input.attemptEpoch}
         AND state = 'RUNNING'
         AND "cancelledAt" IS NULL
      ON CONFLICT ("jobId") DO NOTHING`;
    if (inserted === 0) {
      const effect = await tx.durableJobProbeEffect.findUnique({ where: { jobId: input.jobId } });
      if (!effect || effect.attemptEpoch !== input.attemptEpoch || effect.marker !== input.marker) {
        throw new DurableJobFenceError();
      }
    }

    const updated = await tx.durableJob.updateMany({
      where: {
        id: input.jobId,
        workerOwner: input.workerId,
        attemptEpoch: input.attemptEpoch,
        state: "RUNNING",
        cancelledAt: null,
      },
      data: {
        state: "COMPLETE",
        completedAt: input.now,
        workerOwner: null,
        leaseUntil: null,
        lastHeartbeatAt: null,
        dispatchOwner: null,
        dispatchClaimUntil: null,
      },
    });
    if (updated.count !== 1) {
      throw new DurableJobFenceError();
    }
  });
}

export async function countReadyDispatchRows(db: Db, now: Date): Promise<number> {
  const result = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
      FROM durable_job
     WHERE (
       (state IN ('PENDING', 'RETRY') AND "nextRunAt" <= ${now}
         AND ("dispatchClaimUntil" IS NULL OR "dispatchClaimUntil" < ${now}))
       OR (state = 'PUBLISHED'
         AND ("dispatchClaimUntil" IS NULL OR "dispatchClaimUntil" < ${now}))
       OR (state = 'RUNNING'
         AND "leaseUntil" < ${now}
         AND ("dispatchClaimUntil" IS NULL OR "dispatchClaimUntil" < ${now}))
     )`;
  return Number(result[0]?.count ?? 0n);
}

export function queueNameForDurableKind(kind: DurableJobKind): string {
  switch (kind) {
    case "PUSH_MIRROR":
      return "push-mirror";
    case "DOWNLOAD_MODEL":
      return "download-model";
    case "KB_EMAIL":
      return "kb-email";
    case "PROBE":
      return "durable-probe";
    case "QUERY_EMBEDDING":
      return "query-embedding";
    case "INDEX_KB":
      return "index-kb";
    case "PROVIDER_PROBE":
      return "provider-probe";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function bullmqNameForDurableKind(kind: DurableJobKind): string {
  return queueNameForDurableKind(kind);
}
