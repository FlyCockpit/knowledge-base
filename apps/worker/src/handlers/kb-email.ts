import { randomUUID } from "node:crypto";
import { runKbEmailDelivery } from "@knowledge-base/api/lib/kb/kb-email";
import prisma from "@knowledge-base/db";
import { env } from "@knowledge-base/env/shared";
import { isEmailConfigured, sendEmail } from "@knowledge-base/mailer";
import { type KbEmailJobData, kbEmailJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";

const WORKER_ID = `kb-email:${randomUUID()}`;

/** The only place a KB invitation/transfer email reaches SMTP. */
export async function handleKbEmailJob(job: Job<KbEmailJobData>) {
  const { durableJobId } = kbEmailJobSchema.parse(job.data);
  return runKbEmailDelivery(prisma, {
    workerId: WORKER_ID,
    durableJobId,
    connectionString: env.DATABASE_URL.reveal(),
    masterKey: env.KB_MASTER_KEY?.reveal(),
    send: (message, authorizeSend) => sendEmail({ ...message, authorizeSend }),
    // Without SMTP the copyable link in the UI is the delivery path; do not retry.
    emailConfigured: isEmailConfigured(),
  });
}
