import { runKbRetention } from "@knowledge-base/api/lib/kb/retention";
import { logEvent } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/shared";
import { kbDataPaths } from "@knowledge-base/env/topology";
import { cleanExpiredQueuePayloads } from "@knowledge-base/queue";
import { type KbRetentionJobData, kbRetentionJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";

/**
 * Retention pass. Postgres + Redis, plus the index directory of the data volume: the
 * generations class unlinks purged and orphaned index files there. Repos and assets are never
 * handed to retention; the server's fenced sweeper unlinks expired upload/export staging.
 */
export async function handleKbRetentionJob(job: Job<KbRetentionJobData>) {
  const { schedule } = kbRetentionJobSchema.parse(job.data);
  const start = Date.now();
  // Start Redis maintenance independently: a failed/hung generation class cannot
  // prevent idle payload expiry, and a Redis failure cannot skip Postgres classes.
  const results = await Promise.allSettled([
    runKbRetention(schedule, {
      connectionString: env.DATABASE_URL.reveal(),
      indexDir: kbDataPaths(env.KB_DATA_ROOT).indexDir,
    }),
    schedule === "hourly" ? cleanExpiredQueuePayloads() : Promise.resolve(0),
  ]);
  const failures = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  if (failures.length) throw new AggregateError(failures, "KB retention failed");
  const counts = results[0].status === "fulfilled" ? results[0].value : {};
  const queuePayloads = results[1].status === "fulfilled" ? results[1].value : 0;
  logEvent("worker.kb-retention", {
    jobId: job.id,
    stage: schedule,
    count: queuePayloads,
    durationMs: Date.now() - start,
  });
  return { schedule, counts, queuePayloads };
}
