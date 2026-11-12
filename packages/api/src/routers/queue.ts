import {
  checkBackupFreshnessQueue,
  downloadModelQueue,
  durableProbeQueue,
  echoJobSchema,
  echoQueue,
  indexKbQueue,
  kbEmailQueue,
  kbGitRollupQueue,
  kbRetentionQueue,
  notifyDataDeletionsQueue,
  providerProbeQueue,
  pushMirrorQueue,
  QUEUE_NAMES,
  queryEmbeddingQueue,
  reapExpiredAuthTokensQueue,
  redisConnection,
  seedQueue,
} from "@knowledge-base/queue";
import { z } from "zod";
import { adminOr404Procedure, liveAdminOr404Procedure } from "../index";
import {
  backupFreshnessEnabled,
  misconfiguredBackupFreshness,
  readBackupFreshness,
  setupMissingBackupFreshness,
} from "../lib/backup-freshness";
import { listAuditEventsForExport } from "../lib/kb/retention";
import { cursorPageInput } from "../lib/pagination";

const queuesByName = {
  [QUEUE_NAMES.echo]: echoQueue,
  [QUEUE_NAMES.seed]: seedQueue,
  [QUEUE_NAMES.reapExpiredAuthTokens]: reapExpiredAuthTokensQueue,
  [QUEUE_NAMES.checkBackupFreshness]: checkBackupFreshnessQueue,
  [QUEUE_NAMES.notifyDataDeletions]: notifyDataDeletionsQueue,
  [QUEUE_NAMES.durableProbe]: durableProbeQueue,
  [QUEUE_NAMES.providerProbe]: providerProbeQueue,
  [QUEUE_NAMES.indexKb]: indexKbQueue,
  [QUEUE_NAMES.queryEmbedding]: queryEmbeddingQueue,
  [QUEUE_NAMES.pushMirror]: pushMirrorQueue,
  [QUEUE_NAMES.downloadModel]: downloadModelQueue,
  [QUEUE_NAMES.kbEmail]: kbEmailQueue,
  [QUEUE_NAMES.kbRetention]: kbRetentionQueue,
  [QUEUE_NAMES.kbGitRollup]: kbGitRollupQueue,
} as const;

const queueNameSchema = z.enum([
  QUEUE_NAMES.echo,
  QUEUE_NAMES.seed,
  QUEUE_NAMES.reapExpiredAuthTokens,
  QUEUE_NAMES.checkBackupFreshness,
  QUEUE_NAMES.notifyDataDeletions,
  QUEUE_NAMES.durableProbe,
  QUEUE_NAMES.providerProbe,
  QUEUE_NAMES.indexKb,
  QUEUE_NAMES.queryEmbedding,
  QUEUE_NAMES.pushMirror,
  QUEUE_NAMES.downloadModel,
  QUEUE_NAMES.kbEmail,
  QUEUE_NAMES.kbRetention,
  QUEUE_NAMES.kbGitRollup,
]);

export const queueRouter = {
  /**
   * Last backup-freshness verdict for the admin dashboard. `configured: false`
   * means logical backups are off (provider-only profile) and there is nothing
   * to show. A bucket that is set but unusable is NOT that case: it reports
   * `configured: true` with a `misconfigured` verdict, because a backup that
   * can never run has to be louder than one that is merely late, not quieter.
   * `status: null` with `configured: true` means the worker has not recorded a
   * verdict within its TTL — treat as unknown, not healthy.
   */
  backupStatus: adminOr404Procedure.handler(async () => {
    if (!backupFreshnessEnabled()) return { configured: false as const, status: null };
    const setupMissing = setupMissingBackupFreshness();
    if (setupMissing) return { configured: true as const, status: setupMissing };
    const misconfigured = misconfiguredBackupFreshness();
    if (misconfigured) return { configured: true as const, status: misconfigured };
    return { configured: true as const, status: await readBackupFreshness(redisConnection) };
  }),

  /**
   * Administrative export of the retained (90-day) KB audit trail, oldest first.
   * Event metadata is the fixed allowlist: no source bodies, queries or credentials.
   */
  auditExport: liveAdminOr404Procedure
    .input(cursorPageInput.extend({ limit: z.number().int().min(1).max(100).default(100) }))
    .handler(async ({ input, context }) => listAuditEventsForExport(context.authorityTx, input)),

  enqueueEcho: adminOr404Procedure.input(echoJobSchema).handler(async ({ input }) => {
    const job = await echoQueue.add("echo", input);
    return { jobId: job.id };
  }),

  getJob: adminOr404Procedure
    .input(
      z.object({
        jobId: z.string(),
        queue: queueNameSchema.default(QUEUE_NAMES.echo),
      }),
    )
    .handler(async ({ input }) => {
      const queue = queuesByName[input.queue];
      const job = await queue.getJob(input.jobId);
      if (!job) return null;
      const state = await job.getState();
      return {
        id: job.id,
        data: job.data,
        state,
        returnValue: job.returnvalue,
        failedReason: job.failedReason,
      };
    }),

  listFailed: adminOr404Procedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const limit = input?.limit ?? 20;
      const entries = await Promise.all(
        Object.entries(queuesByName).map(async ([queueName, queue]) => {
          const jobs = await queue.getJobs(["failed"], 0, limit - 1, false);
          return Promise.all(
            jobs.map(async (job) => ({
              queue: queueName,
              id: job.id ?? null,
              name: job.name,
              failedReason: job.failedReason ?? null,
              attemptsMade: job.attemptsMade,
              timestamp: job.timestamp,
              finishedOn: job.finishedOn ?? null,
            })),
          );
        }),
      );
      const items = entries
        .flat()
        .sort((a, b) => (b.finishedOn ?? b.timestamp) - (a.finishedOn ?? a.timestamp))
        .slice(0, limit);
      return { items };
    }),
};
