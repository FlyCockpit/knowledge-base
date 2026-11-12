import { type JobAttemptOptions, withJobAttempt } from "./job-attempt.js";
import { claimJobAttempt, commitProbeAttempt, parseDesiredForKind } from "./jobs.js";

type ProbeDb = Parameters<typeof claimJobAttempt>[0] & JobAttemptOptions["db"];

export type DurableProbeDeliveryResult = { skipped: true } | { marker: string };

/**
 * The production durable-probe consumer path, shared verbatim by the worker
 * handler and the PG/Redis integration suite: claim the delivery, run under
 * the attempt fence with heartbeats, and commit effect + COMPLETE atomically.
 * A delivery that cannot claim a current attempt (cancelled, superseded by a
 * fenced retry, or already complete) is skipped, never an error.
 */
export async function runDurableProbeDelivery(
  db: ProbeDb,
  input: { workerId: string; durableJobId: string; now?: () => Date },
): Promise<DurableProbeDeliveryResult> {
  const now = input.now ?? (() => new Date());
  const claimed = await claimJobAttempt(db, {
    jobId: input.durableJobId,
    workerId: input.workerId,
    now: now(),
  });
  if (!claimed) {
    return { skipped: true };
  }
  return withJobAttempt(claimed, { db, workerId: input.workerId, now }, async (ctx) => {
    const desired = parseDesiredForKind(claimed.kind, claimed.desired);
    await commitProbeAttempt(db, {
      jobId: input.durableJobId,
      workerId: input.workerId,
      attemptEpoch: claimed.attemptEpoch,
      marker: desired.marker,
      now: ctx.now(),
    });
    return { marker: desired.marker };
  });
}
