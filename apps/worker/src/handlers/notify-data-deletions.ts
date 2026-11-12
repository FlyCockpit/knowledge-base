import {
  listUnnotifiedDataDeletions,
  markDataDeletionNotified,
} from "@knowledge-base/db/data-deletion-notices";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import { isEmailConfigured } from "@knowledge-base/mailer";
import type { NotifyDataDeletionsJobData } from "@knowledge-base/queue";
import { notifyDataDeletionsJobSchema } from "@knowledge-base/queue";
import type { Job } from "bullmq";
import { sendDataDeletedAlert } from "../operational-alerts.js";

/**
 * Email admins once per scheduled data deletion the migration runner carried
 * out (docs/schema-migrations.md § Getting told when data is deleted).
 *
 * Read, send, then mark — at least once. A notice is marked only after an
 * admin was actually emailed; a send that reached nobody (or threw) leaves it
 * unmarked for the next firing, and a crash between send and mark re-sends it
 * (a rare duplicate rather than a lost notice). Only deletions from the last
 * `DATA_DELETION_NOTICE_WINDOW_DAYS` are considered. Without email configured
 * nothing is read, so the notices wait until it is. Every notice is logged
 * before its send, so the log has a record whether or not an admin opted in.
 */
export async function handleNotifyDataDeletionsJob(
  job: Job<NotifyDataDeletionsJobData>,
): Promise<{ reason: "cron"; notified: number; retried: number }> {
  const { reason } = notifyDataDeletionsJobSchema.parse(job.data);
  if (!isEmailConfigured()) return { reason, notified: 0, retried: 0 };

  const notices = await listUnnotifiedDataDeletions();
  let notified = 0;
  let retried = 0;
  for (const notice of notices) {
    logEvent("worker.data-deletion", { rowId: notice.name });
    try {
      await sendDataDeletedAlert(notice);
    } catch (error) {
      retried++;
      logInternalError("worker.data-deletion-send", error, { rowId: notice.name });
      continue;
    }
    notified++;
    try {
      await markDataDeletionNotified(notice.name);
    } catch (error) {
      logInternalError("worker.data-deletion-record", error, { rowId: notice.name });
    }
  }
  if (notices.length > 0)
    logEvent("worker.data-deletions", { jobId: job.id, reason, count: notices.length });
  return { reason, notified, retried };
}
