import { randomUUID } from "node:crypto";
import type { Embedder } from "@knowledge-base/api/lib/kb/embedder";
import { runIndexBuildDelivery } from "@knowledge-base/api/lib/kb/index-build";
import prisma from "@knowledge-base/db";
import { env } from "@knowledge-base/env/shared";
import { kbDataPaths } from "@knowledge-base/env/topology";
import { type IndexKbJobData, indexKbJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";

const workerId = `index-kb:${randomUUID()}`;
/** `qwenEmbedder` is the worker's forked-child adapter; SYSTEM_BUILTIN builds need it. */
export function handleIndexKbJob(job: Job<IndexKbJobData>, qwenEmbedder?: Embedder) {
  const { durableJobId } = indexKbJobSchema.parse(job.data);
  return runIndexBuildDelivery(prisma, {
    durableJobId,
    workerId,
    connectionString: env.DATABASE_URL.reveal(),
    reposDir: kbDataPaths(env.KB_DATA_ROOT).reposDir,
    indexDir: kbDataPaths(env.KB_DATA_ROOT).indexDir,
    masterKey: env.KB_MASTER_KEY?.reveal(),
    qwenEmbedder,
  });
}
