import {
  type BackupFreshness,
  backupFreshnessNeedsAttention,
  checkBackupFreshness,
  writeBackupFreshness,
} from "@knowledge-base/api/lib/backup-freshness";
import { logEvent } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/shared";
import type { CheckBackupFreshnessJobData } from "@knowledge-base/queue";
import { checkBackupFreshnessJobSchema, redisConnection } from "@knowledge-base/queue";
import type { Job } from "bullmq";

import { escapeHtml, sendOperationalAlert } from "../operational-alerts.js";

/**
 * A stale-backup alert repeats once a day while the condition persists — often
 * enough that it cannot be missed, rare enough that admins do not filter it.
 */
const STALE_ALERT_COOLDOWN_SECONDS = 24 * 60 * 60;

/**
 * Is the newest dump in the backup bucket recent enough?
 *
 * Every other alert in this worker fires when something *fails*. Backups are
 * different: the failure mode that loses data is the cron that quietly stopped
 * running, and that produces no error at all. So this job measures the outcome
 * (age of the newest object under BACKUP_S3_PREFIX) rather than watching the
 * process. The verdict is written to Redis for the admin dashboard and, when
 * it needs attention, emailed to admins with operational alerts enabled.
 *
 * Only scheduled when BACKUP_ENABLED=true (see apps/worker/src/index.ts). When
 * a bucket is configured but unusable the verdict is `misconfigured`, which
 * alerts like any other attention state. Enabled backups without a bucket yet
 * report `setup-missing`.
 */
export async function handleCheckBackupFreshnessJob(
  job: Job<CheckBackupFreshnessJobData>,
): Promise<BackupFreshness | null> {
  if (!env.BACKUP_ENABLED) {
    logEvent("worker.backup-freshness", { jobId: job.id, reason: "BACKUP_DISABLED" });
    return null;
  }

  const { reason } = checkBackupFreshnessJobSchema.parse(job.data);
  const status = await checkBackupFreshness();
  await writeBackupFreshness(redisConnection, status);

  logEvent("worker.backup-freshness", { jobId: job.id, reason, status: status.state });

  if (backupFreshnessNeedsAttention(status)) {
    await sendOperationalAlert({
      source: "check-backup-freshness",
      message: status.state,
      cooldownSeconds: STALE_ALERT_COOLDOWN_SECONDS,
      subject: "[backups] database backups need attention",
      html: `
    <p>${escapeHtml(describe(status))}</p>
    <dl>
      <dt>Bucket</dt><dd>${escapeHtml(env.BACKUP_S3_BUCKET ?? "")}</dd>
      <dt>Prefix</dt><dd>${escapeHtml(env.BACKUP_S3_PREFIX)}</dd>
      <dt>Threshold</dt><dd>${status.maxAgeHours} hours</dd>
      <dt>Checked</dt><dd>${escapeHtml(status.checkedAt)}</dd>
    </dl>
    <p>Check the db-backup cron job's logs, then run one backup by hand and confirm it
    uploads. See docs/backup-restore.md.</p>
  `,
    });
  }

  return status;
}

function describe(status: BackupFreshness): string {
  switch (status.state) {
    case "fresh":
      return `newest backup ${status.latestKey} is ${status.ageHours}h old (limit ${status.maxAgeHours}h).`;
    case "stale":
      return `newest backup ${status.latestKey} is ${status.ageHours}h old — older than the ${status.maxAgeHours}h limit. The backup cron is not producing dumps.`;
    case "empty":
      return "no backups found in the bucket. The backup cron has never produced a dump.";
    case "misconfigured":
      return `backups cannot run: ${status.reason}`;
    case "setup-missing":
      return `backups are enabled but not set up: ${status.reason}`;
    case "error":
      return `could not list the backup bucket: ${status.message}`;
  }
}
