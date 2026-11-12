import { randomUUID } from "node:crypto";
import { durableQueuePayloadSchema } from "@knowledge-base/api/lib/kb/jobs";
import { runDurableProbeDelivery } from "@knowledge-base/api/lib/kb/probe-consumer";
import prisma from "@knowledge-base/db";
import type { DurableProbeJobData } from "@knowledge-base/queue";
import { durableProbeJobSchema } from "@knowledge-base/queue";
import type { Job } from "bullmq";

const WORKER_ID = `durable-probe:${randomUUID()}`;

export async function handleDurableProbeJob(job: Job<DurableProbeJobData>) {
  const { durableJobId } = durableProbeJobSchema.parse(job.data);
  durableQueuePayloadSchema.parse({ durableJobId });
  return runDurableProbeDelivery(prisma, { workerId: WORKER_ID, durableJobId });
}
