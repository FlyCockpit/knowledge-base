import type { DurableJob, PrismaClient } from "@knowledge-base/db/client";
import {
  completeJobAttempt,
  DurableJobCancelledError,
  DurableJobFenceError,
  failJobAttempt,
  heartbeatJobAttempt,
  WORKER_HEARTBEAT_MS,
} from "./jobs.js";

type AttemptDb = Pick<PrismaClient, "durableJob" | "durableJobProbeEffect"> &
  Parameters<typeof completeJobAttempt>[0];

export type JobAttemptContext = {
  job: DurableJob;
  workerId: string;
  now: () => Date;
  db: AttemptDb;
  heartbeat(): Promise<boolean>;
  complete(): Promise<boolean>;
  fail(error: string): Promise<{ state: "RETRY" | "FAILED"; attemptCount: number } | null>;
};

export type JobAttemptOptions = {
  db: AttemptDb;
  workerId: string;
  now?: () => Date;
  onHeartbeat?: (ctx: JobAttemptContext) => void | Promise<void>;
};

export async function withJobAttempt<T>(
  job: Pick<DurableJob, "id" | "attemptEpoch" | "workerOwner" | "state" | "cancelledAt">,
  options: JobAttemptOptions,
  run: (ctx: JobAttemptContext) => Promise<T>,
): Promise<T> {
  const now = options.now ?? (() => new Date());
  if (job.cancelledAt || job.state === "CANCELLED") {
    throw new DurableJobCancelledError();
  }
  if (job.workerOwner !== options.workerId) {
    throw new DurableJobFenceError();
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatChain = Promise.resolve();
  let heartbeatStopped = false;
  let heartbeatPending = false;
  let heartbeatFailure: unknown;

  const ctx: JobAttemptContext = {
    job: job as DurableJob,
    workerId: options.workerId,
    now,
    db: options.db,
    heartbeat: async () =>
      heartbeatJobAttempt(options.db, {
        jobId: job.id,
        workerId: options.workerId,
        attemptEpoch: job.attemptEpoch,
        now: now(),
      }),
    complete: async () =>
      completeJobAttempt(options.db, {
        jobId: job.id,
        workerId: options.workerId,
        attemptEpoch: job.attemptEpoch,
        now: now(),
      }),
    fail: async (error: string) =>
      failJobAttempt(options.db, {
        jobId: job.id,
        workerId: options.workerId,
        attemptEpoch: job.attemptEpoch,
        now: now(),
        error,
      }),
  };

  const scheduleHeartbeat = () => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    heartbeatChain = Promise.resolve()
      .then(async () => {
        if (heartbeatStopped) return;
        const ok = await ctx.heartbeat();
        if (!ok) {
          throw new DurableJobFenceError("Heartbeat lost durable job lease.");
        }
        await options.onHeartbeat?.(ctx);
      })
      .catch((error: unknown) => {
        heartbeatFailure = error;
        heartbeatStopped = true;
        clearInterval(heartbeatTimer);
      })
      .finally(() => {
        heartbeatPending = false;
      });
  };

  heartbeatTimer = setInterval(() => {
    void scheduleHeartbeat();
  }, WORKER_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  try {
    const result = await run(ctx);
    if (heartbeatFailure) {
      throw heartbeatFailure;
    }
    return result;
  } catch (error) {
    if (error instanceof DurableJobCancelledError || error instanceof DurableJobFenceError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await ctx.fail(message);
    } catch (failError) {
      if (
        failError instanceof DurableJobCancelledError ||
        failError instanceof DurableJobFenceError
      ) {
        throw failError;
      }
      throw error;
    }
    throw error;
  } finally {
    heartbeatStopped = true;
    clearInterval(heartbeatTimer);
    await heartbeatChain.catch(() => {});
  }
}
