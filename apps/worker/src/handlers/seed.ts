import { runSeed } from "@knowledge-base/db/seed";
import { logEvent } from "@knowledge-base/env/log";
import type { SeedJobData } from "@knowledge-base/queue";
import { seedJobSchema } from "@knowledge-base/queue";
import type { Job } from "bullmq";

/**
 * Run the database seed (`packages/db/prisma/seed.ts → runSeed()`) off the
 * request path. The same `runSeed()` is what `prisma db seed` and the inline
 * (no-queue) admin path call. The returned
 * SeedResult becomes the BullMQ job returnValue so the admin "Run seed" page
 * can render the per-step summary by polling `queue.getJob`.
 */
export async function handleSeedJob(job: Job<SeedJobData>) {
  // Parsed rather than destructured: the payload crosses a queue boundary, so
  // payload drift must fail loudly instead of logging an unattributable run.
  const { requestedBy } = seedJobSchema.parse(job.data);
  const start = Date.now();
  logEvent("worker.seed", { jobId: job.id, userId: requestedBy, stage: "start" });
  const outcome = await runSeed();
  const durationMs = Date.now() - start;
  logEvent("worker.seed", {
    jobId: job.id,
    stage: "finished",
    durationMs,
    steps: outcome.summary.length,
  });
  return { ...outcome, durationMs };
}
