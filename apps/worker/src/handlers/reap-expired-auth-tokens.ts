import type { ReapedAuthTokens } from "@knowledge-base/api/lib/auth-token-retention";
import { reapExpiredAuthTokens } from "@knowledge-base/api/lib/auth-token-retention";
import { logEvent } from "@knowledge-base/env/log";
import type { ReapExpiredAuthTokensJobData } from "@knowledge-base/queue";
import { reapExpiredAuthTokensJobSchema } from "@knowledge-base/queue";
import type { Job } from "bullmq";

export async function handleReapExpiredAuthTokensJob(
  job: Job<ReapExpiredAuthTokensJobData>,
): Promise<{ reason: "cron"; deleted: ReapedAuthTokens }> {
  const { reason } = reapExpiredAuthTokensJobSchema.parse(job.data);
  const start = Date.now();
  const { deleted } = await reapExpiredAuthTokens();
  logEvent("worker.reap-auth-tokens", {
    jobId: job.id,
    reason,
    deleted: Object.values(deleted).reduce<number>((sum, n) => sum + Number(n), 0),
    durationMs: Date.now() - start,
  });
  return { reason, deleted };
}
