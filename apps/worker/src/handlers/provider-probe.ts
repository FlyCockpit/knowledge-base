import { randomUUID } from "node:crypto";
import { runProviderProbeDelivery } from "@knowledge-base/api/lib/kb/embedder";
import prisma from "@knowledge-base/db";
import { env } from "@knowledge-base/env/shared";
import { type ProviderProbeJobData, providerProbeJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";

const workerId = `provider-probe:${randomUUID()}`;
export async function handleProviderProbeJob(job: Job<ProviderProbeJobData>) {
  const { durableJobId } = providerProbeJobSchema.parse(job.data);
  return runProviderProbeDelivery(prisma, {
    durableJobId,
    workerId,
    connectionString: env.DATABASE_URL.reveal(),
    masterKey: env.KB_MASTER_KEY?.reveal(),
  });
}
