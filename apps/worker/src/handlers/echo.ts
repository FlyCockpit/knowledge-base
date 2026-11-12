import prisma from "@knowledge-base/db";
import type { EchoJobData } from "@knowledge-base/queue";
import { echoJobSchema } from "@knowledge-base/queue";
import type { Job } from "bullmq";

/**
 * Process an echo job: log the message and persist it as an AppSetting
 * so downstream systems can read the last echo value. A single fixed key —
 * every run overwrites the same row, so the table never grows with the job
 * count.
 */
export async function handleEchoJob(job: Job<EchoJobData>) {
  // Parsed rather than destructured: the payload crosses a queue boundary, so
  // payload drift must fail loudly instead of persisting garbage.
  const { message } = echoJobSchema.parse(job.data);

  await prisma.appSetting.upsert({
    where: { key: "echo:last" },
    update: { value: message },
    create: { key: "echo:last", value: message },
  });

  return { echoed: message };
}
