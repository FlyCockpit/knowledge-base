import type { Job } from "bullmq";

const LIVE_STATES = new Set<string>([
  "active",
  "delayed",
  "prioritized",
  "waiting",
  "waiting-children",
]);
const MAX_STATE_CLASSIFICATION_ATTEMPTS = 4;

type RunnableJob = Pick<Job, "getState" | "retry" | "id" | "updateData">;

type EnsureQueue<Data> = {
  add(name: string, data: Data, options: { jobId: string }): Promise<RunnableJob>;
  getJob(jobId: string): Promise<RunnableJob | null | undefined>;
};

/**
 * Ensure one deterministic BullMQ job is runnable.
 *
 * BullMQ deduplicates by job id even while a completed/failed job is retained,
 * so Queue.add alone is not a publication guarantee. Terminal jobs are moved
 * back to waiting with Job.retry(); live jobs are left untouched. A bounded
 * retry loop resolves races where a job changes state or retention removes it
 * between getState() and retry(). Unknown/ambiguous states fail closed instead
 * of risking removal of a live, locked job.
 *
 * A requeued terminal job is re-stamped with THIS caller's `data` before it is
 * retried. `retry()` on its own re-runs the payload the FIRST publisher wrote,
 * which for a deduplicated job like `seed` (jobId is a constant) meant every
 * later run was attributed to whoever ran it first — the handler logged a
 * `requestedBy` that had nothing to do with the admin who pressed the button.
 * A live job is deliberately NOT re-stamped: it is already on its way with a
 * payload a worker may be reading, and dedupe means the caller asked for that
 * work to happen, not for it to happen twice with different arguments.
 */
export async function ensureRunnableJob<Data>(
  queue: EnsureQueue<Data>,
  name: string,
  data: Data,
  jobId: string,
): Promise<RunnableJob> {
  let lastState = "missing";

  for (let attempt = 0; attempt < MAX_STATE_CLASSIFICATION_ATTEMPTS; attempt++) {
    // Queue.add can return a retained job when another publisher or BullMQ's
    // retention bookkeeping wins the race after getJob(). Classify that job in
    // the same loop instead of assuming an add result is newly waiting.
    const existing = await queue.getJob(jobId);
    const candidate = existing ?? (await queue.add(name, data, { jobId }));
    const state = await candidate.getState();
    lastState = state;

    if (LIVE_STATES.has(state)) return candidate;
    if (state !== "completed" && state !== "failed") {
      // `unknown` commonly means retention removed this particular Job handle.
      // Re-read by deterministic id before deciding publication failed. Other
      // ambiguous states are also preserved and reclassified boundedly: they
      // are not evidence that mutating the job is safe.
      continue;
    }

    try {
      // Before the retry, never after: a job moved back to waiting can be
      // picked up by a worker on the next tick, and updating its data then
      // would race the very handler that is reading it.
      await candidate.updateData(data);
      await candidate.retry(state);
      return candidate;
    } catch {}
  }

  throw new Error(`Could not prove deterministic job ${jobId} runnable (state=${lastState})`);
}
