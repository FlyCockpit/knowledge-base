import { Queue } from "bullmq";
import { redisConnection } from "./connection.js";
import { BULL_PAYLOAD_RETENTION, QUEUE_NAMES } from "./jobs.js";
import { observeRedis } from "./observe.js";
import { cleanQueuePayloads } from "./retention.js";

export { FlowProducer, Job, Queue, QueueEvents, Worker } from "bullmq";
export { createRedisConnection, redisConnection } from "./connection.js";
export { ensureRunnableJob } from "./ensure-job.js";
export {
  BULL_PAYLOAD_RETENTION,
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
  type CheckBackupFreshnessJobData,
  checkBackupFreshnessJobSchema,
  type DownloadModelJobData,
  type DurableProbeJobData,
  downloadModelJobSchema,
  durableProbeJobSchema,
  type EchoJobData,
  echoJobSchema,
  type IndexKbJobData,
  indexKbJobSchema,
  KB_GIT_ROLLUP_CRON_PATTERN,
  KB_GIT_ROLLUP_SCHEDULER_ID,
  KB_RETENTION_HOURLY_CRON_PATTERN,
  KB_RETENTION_HOURLY_JOB_SCHEDULER_ID,
  KB_RETENTION_MINUTE_CRON_PATTERN,
  KB_RETENTION_MINUTE_JOB_SCHEDULER_ID,
  type KbEmailJobData,
  type KbGitRollupJobData,
  type KbRetentionJobData,
  kbEmailJobSchema,
  kbGitRollupJobSchema,
  kbRetentionJobSchema,
  NOTIFY_DATA_DELETIONS_CRON_PATTERN,
  NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
  type NotifyDataDeletionsJobData,
  notifyDataDeletionsJobSchema,
  type ProviderProbeJobData,
  type PushMirrorJobData,
  providerProbeJobSchema,
  pushMirrorJobSchema,
  QUEUE_NAMES,
  type QueryEmbeddingJobData,
  queryEmbeddingJobSchema,
  REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN,
  REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
  type ReapExpiredAuthTokensJobData,
  reapExpiredAuthTokensJobSchema,
  type SeedJobData,
  seedJobSchema,
} from "./jobs.js";

/**
 * Completed BullMQ payloads are kept 24h, failed ones 7d (payloads are IDs only;
 * the Postgres durable job receipt persists). The count caps bound Redis memory.
 */
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { age: BULL_PAYLOAD_RETENTION.completedAgeSeconds, count: 1000 },
  removeOnFail: { age: BULL_PAYLOAD_RETENTION.failedAgeSeconds, count: 5000 },
};

/** Pre-configured echo queue. Add more queues here as needed. */
export const echoQueue = new Queue(QUEUE_NAMES.echo, {
  connection: redisConnection,
  defaultJobOptions,
});

/**
 * Runs the database seed on demand from the admin "Run seed" button. Single-
 * attempt — an author-written seed is not guaranteed safe to auto-retry, so a
 * failure surfaces to the admin instead of silently re-running. Concurrency is
 * pinned to 1 in the worker so two seed runs never overlap.
 */
export const seedQueue = new Queue(QUEUE_NAMES.seed, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Deletes expired short-lived credentials (sessions, verifications, device
 * codes, preview tokens). Cron-only and unconditional: a bounded Postgres delete
 * every install owes its users.
 * `attempts: 1` — the next daily firing is the retry.
 */
export const reapExpiredAuthTokensQueue = new Queue(QUEUE_NAMES.reapExpiredAuthTokens, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/**
 * Backup freshness check. `attempts: 1` like the other sweeps: a listing error
 * is itself a verdict the handler records and alerts on, and the next firing
 * (6 hours later) is the retry.
 */
export const checkBackupFreshnessQueue = new Queue(QUEUE_NAMES.checkBackupFreshness, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/** Next scheduled firing retries notices that reached nobody. */
export const notifyDataDeletionsQueue = new Queue(QUEUE_NAMES.notifyDataDeletions, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Durable probe jobs — Redis carries durableJobId only. */
export const durableProbeQueue = new Queue(QUEUE_NAMES.durableProbe, {
  connection: redisConnection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 1,
  },
});

/** Durable provider probe; Postgres owns retries. */
export const providerProbeQueue = new Queue(QUEUE_NAMES.providerProbe, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Durable pinned index build; Postgres owns retries. */
export const indexKbQueue = new Queue(QUEUE_NAMES.indexKb, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Query capacity is independent of index builds. Postgres owns payloads and retries. */
export const queryEmbeddingQueue = new Queue(QUEUE_NAMES.queryEmbedding, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Admin-enabled model download; Postgres owns the epoch, retries and lease. */
export const downloadModelQueue = new Queue(QUEUE_NAMES.downloadModel, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Invitation/transfer email; Postgres owns the recipient, links and retries. */
export const kbEmailQueue = new Queue(QUEUE_NAMES.kbEmail, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Explicit human mirror request; Postgres owns pins and retries. */
export const pushMirrorQueue = new Queue(QUEUE_NAMES.pushMirror, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Retention sweeps (minute + hourly schedulers). Cron-only; next firing retries. */
export const kbRetentionQueue = new Queue(QUEUE_NAMES.kbRetention, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Bounded scheduled Git maintenance; each subsequent firing is the retry. */
export const kbGitRollupQueue = new Queue(QUEUE_NAMES.kbGitRollup, {
  connection: redisConnection,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

/** Exhaustive queue registry: an added queue must also receive idle TTL cleanup. */
const retentionQueues = {
  [QUEUE_NAMES.echo]: echoQueue,
  [QUEUE_NAMES.seed]: seedQueue,
  [QUEUE_NAMES.reapExpiredAuthTokens]: reapExpiredAuthTokensQueue,
  [QUEUE_NAMES.checkBackupFreshness]: checkBackupFreshnessQueue,
  [QUEUE_NAMES.notifyDataDeletions]: notifyDataDeletionsQueue,
  [QUEUE_NAMES.durableProbe]: durableProbeQueue,
  [QUEUE_NAMES.providerProbe]: providerProbeQueue,
  [QUEUE_NAMES.indexKb]: indexKbQueue,
  [QUEUE_NAMES.queryEmbedding]: queryEmbeddingQueue,
  [QUEUE_NAMES.downloadModel]: downloadModelQueue,
  [QUEUE_NAMES.kbEmail]: kbEmailQueue,
  [QUEUE_NAMES.pushMirror]: pushMirrorQueue,
  [QUEUE_NAMES.kbRetention]: kbRetentionQueue,
  [QUEUE_NAMES.kbGitRollup]: kbGitRollupQueue,
} satisfies Record<(typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES], Queue>;

// Each queue re-emits its connection's errors; without a listener the emit
// would throw. The record names the queue and the error's class/code only.
for (const [name, queue] of Object.entries(retentionQueues)) observeRedis(queue, `queue:${name}`);

export function cleanExpiredQueuePayloads(): Promise<number> {
  return cleanQueuePayloads(Object.values(retentionQueues));
}
