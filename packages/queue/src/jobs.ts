import { z } from "zod";

/**
 * Job schemas — define the shape of each job's payload here.
 * Both producers and workers import from this file so the contract is shared.
 */

export const echoJobSchema = z.object({
  message: z.string(),
});

export type EchoJobData = z.infer<typeof echoJobSchema>;

/**
 * Run the database seed (`packages/db/prisma/seed.ts → runSeed()`). Admin-only,
 * on-demand — there is no cron for this. `requestedBy` is the admin user id,
 * logged by the worker so a seed run is attributable.
 *
 * The handler is single-attempt (`attempts: 1`): a seed is author-written and
 * may not be safe to auto-retry, so a failure surfaces to the admin who then
 * decides whether to re-run.
 */
export const seedJobSchema = z.object({
  requestedBy: z.string().min(1),
});

export type SeedJobData = z.infer<typeof seedJobSchema>;

/**
 * Backup freshness check — lists the backup bucket, records the age of the
 * newest dump in Redis, and alerts admins when it exceeds BACKUP_MAX_AGE_HOURS.
 * Cron-only.
 */
export const checkBackupFreshnessJobSchema = z.object({
  reason: z.enum(["cron"]),
});

export type CheckBackupFreshnessJobData = z.infer<typeof checkBackupFreshnessJobSchema>;

/**
 * Delete expired credential artifacts (`packages/api/src/lib/auth-token-retention.ts`):
 * sessions at expiry; verification codes, device codes/approvals and OAuth tokens
 * 24h after expiry; rotated refresh families 24h after family expiry; DPoP replay
 * rows at verifier expiry + 1s. Grant/consent tombstones and JWKS are never deleted.
 *
 * Nothing else prunes those tables: expiry was only ever enforced by rejecting
 * the credential at read time, so expired rows accumulated forever. This is a bounded Postgres delete that owes nothing to
 * object storage, so its scheduler is registered unconditionally.
 *
 * Cron-only; `attempts: 1` like the other sweeps, because the next daily
 * firing is the retry and the delete is idempotent by construction.
 */
export const reapExpiredAuthTokensJobSchema = z.object({
  reason: z.enum(["cron"]),
});

export type ReapExpiredAuthTokensJobData = z.infer<typeof reapExpiredAuthTokensJobSchema>;

/**
 * Bounded retention (`packages/api/src/lib/kb/retention.ts`). Two cron
 * schedules on one queue: `minute` (query-data deadline, staging expiry) and
 * `hourly` (generations, operation receipts, audit, idle Redis payloads, plus the minute classes).
 * Database-only: the server's fenced sweeper owns every staging/export unlink. `attempts: 1`: the next firing retries.
 */
export const kbRetentionJobSchema = z.strictObject({
  schedule: z.enum(["minute", "hourly"]),
});

export type KbRetentionJobData = z.infer<typeof kbRetentionJobSchema>;

/**
 * Queue names — use these constants instead of string literals.
 */
/**
 * Durable outbox delivery for integration and future KB jobs. BullMQ payload is
 * IDs-only; desired state lives in Postgres.
 */
export const durableProbeJobSchema = z.object({
  durableJobId: z.string().uuid(),
});

export type DurableProbeJobData = z.infer<typeof durableProbeJobSchema>;

/** Provider credentials and configuration remain in Postgres. */
export const providerProbeJobSchema = z.strictObject({ durableJobId: z.string().uuid() });
export type ProviderProbeJobData = z.infer<typeof providerProbeJobSchema>;

export const indexKbJobSchema = z.strictObject({ durableJobId: z.string().uuid() });
export type IndexKbJobData = z.infer<typeof indexKbJobSchema>;

export const queryEmbeddingJobSchema = z.strictObject({ durableJobId: z.string().uuid() });
export type QueryEmbeddingJobData = z.infer<typeof queryEmbeddingJobSchema>;

export const pushMirrorJobSchema = z.strictObject({ durableJobId: z.string().uuid() });
export type PushMirrorJobData = z.infer<typeof pushMirrorJobSchema>;

/** Admin-enabled model download; artifact identity and URL are server constants. */
export const downloadModelJobSchema = z.strictObject({ durableJobId: z.string().uuid() });
export type DownloadModelJobData = z.infer<typeof downloadModelJobSchema>;

/** KB invitation / transfer email. Recipient and links are resolved from Postgres. */
export const kbEmailJobSchema = z.strictObject({ durableJobId: z.string().uuid() });
export type KbEmailJobData = z.infer<typeof kbEmailJobSchema>;

/** Bounded scheduled object rollup. No document content in Redis. */
export const kbGitRollupJobSchema = z.strictObject({ reason: z.literal("cron") });
export type KbGitRollupJobData = z.infer<typeof kbGitRollupJobSchema>;
export const KB_GIT_ROLLUP_SCHEDULER_ID = "kb-git-rollup";
export const KB_GIT_ROLLUP_CRON_PATTERN = "*/5 * * * *";

export const QUEUE_NAMES = {
  kbEmail: "kb-email",
  pushMirror: "push-mirror",
  downloadModel: "download-model",
  echo: "echo",
  seed: "seed",
  reapExpiredAuthTokens: "reap-expired-auth-tokens",
  checkBackupFreshness: "check-backup-freshness",
  notifyDataDeletions: "notify-data-deletions",
  durableProbe: "durable-probe",
  providerProbe: "provider-probe",
  indexKb: "index-kb",
  queryEmbedding: "query-embedding",
  kbRetention: "kb-retention",
  kbGitRollup: "kb-git-rollup",
} as const;

/** BullMQ payload retention, applied as every queue's removeOnComplete/removeOnFail age. */
export const BULL_PAYLOAD_RETENTION = {
  completedAgeSeconds: 24 * 3600,
  failedAgeSeconds: 7 * 24 * 3600,
} as const;

/** Stable BullMQ Job Scheduler IDs and patterns for the two retention schedules. */
export const KB_RETENTION_MINUTE_JOB_SCHEDULER_ID = "kb-retention-minute";
export const KB_RETENTION_MINUTE_CRON_PATTERN = "* * * * *";
export const KB_RETENTION_HOURLY_JOB_SCHEDULER_ID = "kb-retention-hourly";
/** :37 past each hour, off the other sweeps' marks. */
export const KB_RETENTION_HOURLY_CRON_PATTERN = "37 * * * *";

/** Stable BullMQ Job Scheduler ID for the expired-auth-token sweep. */
export const REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID = "reap-expired-auth-tokens";

/**
 * Once a day at 04:17 UTC — deliberately off the 03:15 / 03:45 / 04:30 marks
 * the other daily sweeps fire on, so four bounded-delete loops never share a
 * window. Daily is the right cadence for rows whose only cost is existing:
 * an expired credential is dead the moment it ages out, and sweeping more
 * often would re-scan the same indexed range for nothing.
 */
export const REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN = "17 4 * * *";

/** Stable BullMQ Job Scheduler ID for the backup freshness check. */
export const CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID = "check-backup-freshness";

/**
 * Every 6 hours at :20. Nightly dumps land at 03:00 and BACKUP_MAX_AGE_HOURS
 * defaults to 36, so a missed run is noticed within a quarter-day of crossing
 * the threshold; more often would only re-list the bucket for the same answer.
 */
export const CHECK_BACKUP_FRESHNESS_CRON_PATTERN = "20 */6 * * *";

/** Reports recent committed contract deletions to opted-in admins. */
export const notifyDataDeletionsJobSchema = z.strictObject({ reason: z.literal("cron") });
export type NotifyDataDeletionsJobData = z.infer<typeof notifyDataDeletionsJobSchema>;
export const NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID = "notify-data-deletions";
export const NOTIFY_DATA_DELETIONS_CRON_PATTERN = "*/15 * * * *";
