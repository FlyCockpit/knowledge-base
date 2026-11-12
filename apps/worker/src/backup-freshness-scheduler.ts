import { backupFreshnessEnabled } from "@knowledge-base/api/lib/backup-freshness";
import {
  CHECK_BACKUP_FRESHNESS_CRON_PATTERN,
  CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
} from "@knowledge-base/queue";

export type BackupFreshnessSchedulerQueue = {
  upsertJobScheduler: (
    id: string,
    repeat: { pattern: string },
    template: { name: string; data: { reason: "cron" } },
  ) => Promise<unknown>;
  removeJobScheduler: (id: string) => Promise<unknown>;
};

/** Register or remove the durable backup-freshness cron scheduler on worker startup. */
export async function syncBackupFreshnessScheduler(
  queue: BackupFreshnessSchedulerQueue,
): Promise<"upserted" | "removed"> {
  if (backupFreshnessEnabled()) {
    await queue.upsertJobScheduler(
      CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID,
      { pattern: CHECK_BACKUP_FRESHNESS_CRON_PATTERN },
      { name: "check-backup-freshness", data: { reason: "cron" } },
    );
    return "upserted";
  }
  await queue.removeJobScheduler(CHECK_BACKUP_FRESHNESS_JOB_SCHEDULER_ID);
  return "removed";
}
