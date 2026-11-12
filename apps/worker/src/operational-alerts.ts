import { createHash, randomUUID } from "node:crypto";
import { isAdminRole } from "@knowledge-base/auth/roles";
import prisma, { type Prisma } from "@knowledge-base/db";
import type { DataDeletionNotice } from "@knowledge-base/db/data-deletion-notices";
import { logInternalError } from "@knowledge-base/env/log";
import { isEmailConfigured, renderDataDeletion, sendEmail } from "@knowledge-base/mailer";
import { createRedisConnection } from "@knowledge-base/queue";

type AlertArgs = {
  queue: string;
  jobId: string | number | undefined;
  message: string;
  identity?: string;
  count?: number;
};

const ALERT_COOLDOWN_SECONDS = 60 * 60;
const RESERVE_TIMEOUT_MS = 2_000;
const REDIS_COMMAND_TIMEOUT_MS = 1_500;
const RESERVATION_MS = 120_000;
const FAILURE_BACKOFF_MS = 10 * 60_000;
const ADMIN_PAGE_SIZE = 50;
const EMAIL_CONCURRENCY = 8;
const alertConnection = createRedisConnection({
  maxRetriesPerRequest: 1,
  commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
});
// This dedicated connection must discard disconnected commands. Set before
// its asynchronous connection can flush any commands; queue consumers retain
// their normal reconnect policy.
alertConnection.options.enableOfflineQueue = false;
alertConnection.options.autoResendUnfulfilledCommands = false;

// The SMTP deadline is local; Redis owns relative lease/cooldown TTLs. Keep
// settlement headroom so a send aborted at its deadline can still commit sent.
const RESERVE_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 end
return 0`;
const SETTLE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[2] ~= 'sent' and current ~= ARGV[1] then return 0 end
local ttl = math.max(tonumber(ARGV[3]), redis.call('PTTL', KEYS[1]))
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1`;

const operationalAlertRecipientWhere = {
  emailVerified: true,
  operationalAlerts: true,
};

export async function sendOperationalFailureAlert(args: AlertArgs): Promise<void> {
  const jobLabel = args.jobId === undefined ? "unknown" : String(args.jobId);
  await sendOperationalAlert({
    source: args.queue,
    message: args.message,
    identity: args.identity,
    subject: `[${args.queue}] background job failed`,
    html: `
    <p>A background job failed permanently.</p>
    <dl>
      <dt>Queue</dt><dd>${escapeHtml(args.queue)}</dd>
      <dt>Job</dt><dd>${escapeHtml(jobLabel)}</dd>
      <dt>Failures in this batch</dt><dd>${args.count ?? 1}</dd>
      <dt>Error</dt><dd>${escapeHtml(args.message)}</dd>
    </dl>
  `,
  });
}

type OperationalAlert = {
  /** Cooldown namespace — one alert per (source, normalized message) per window. */
  source: string;
  /** Normalized into the cooldown fingerprint; numbers and ids are masked. */
  message: string;
  identity?: string;
  cooldownSeconds?: number;
} & (
  | { subject: string; html: string; render?: never }
  | { render: (locale: string) => { subject: string; html: string }; subject?: never; html?: never }
);

/**
 * Email every admin who opted into operational alerts. Deduplicated in Redis
 * so a failure that repeats every minute produces one email per cooldown
 * window. Safe to call when SMTP is unconfigured (no-op).
 */
export async function sendOperationalAlert(alert: OperationalAlert): Promise<number> {
  if (!isEmailConfigured()) return 0;
  const reservation = await reserveAlertSlot(alert);
  if (!reservation) return 0;
  let delivered = 0;
  try {
    let afterId: string | undefined;
    for (;;) {
      if (Date.now() >= reservation.deadline) break;
      const admins = await prisma.user.findMany({
        where: {
          ...operationalAlertRecipientWhere,
          ...(afterId ? { id: { gt: afterId } } : {}),
        },
        select: { id: true, email: true, role: true, locale: true } satisfies Prisma.UserSelect,
        orderBy: { id: "asc" },
        take: ADMIN_PAGE_SIZE,
      });
      if (admins.length === 0) break;
      afterId = admins[admins.length - 1]?.id;
      const recipients = admins.filter((admin) => isAdminRole(admin.role));
      for (let i = 0; i < recipients.length; i += EMAIL_CONCURRENCY) {
        if (Date.now() >= reservation.deadline) break;
        const results = await Promise.allSettled(
          recipients.slice(i, i + EMAIL_CONCURRENCY).map(async (admin) => {
            const content = alert.render
              ? alert.render(admin.locale)
              : {
                  subject: alert.subject,
                  html: alert.html,
                };
            await sendEmail({
              to: admin.email,
              ...content,
              // Bound the actual SMTP effect by this owner's reservation;
              // cancel the socket, rather than leaving a detached send alive.
              authorizeSend: async (send) => {
                const remaining = reservation.deadline - Date.now();
                if (remaining <= 0) throw new Error("Alert reservation expired.");
                await send(AbortSignal.timeout(remaining));
              },
            });
          }),
        );
        delivered += results.filter((result) => result.status === "fulfilled").length;
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
          logInternalError("worker.alert-send", failures[0]?.reason, {
            queue: alert.source,
            failures: failures.length,
            count: results.length,
          });
        }
      }
      if (admins.length < ADMIN_PAGE_SIZE || !afterId) break;
    }
    return delivered;
  } finally {
    // A failure after an earlier page was delivered still earns the sent
    // cooldown, even if the lease expired while the final send aborted.
    const duration =
      delivered > 0
        ? (alert.cooldownSeconds ?? ALERT_COOLDOWN_SECONDS) * 1000
        : Math.min(FAILURE_BACKOFF_MS, (alert.cooldownSeconds ?? ALERT_COOLDOWN_SECONDS) * 1000);
    try {
      await withTimeout(
        alertConnection.eval(
          SETTLE_SCRIPT,
          1,
          reservation.key,
          reservation.token,
          delivered > 0 ? "sent" : "failed",
          duration,
        ),
        RESERVE_TIMEOUT_MS,
        "Redis timed out settling the alert cooldown",
      );
    } catch (error) {
      logInternalError("worker.alert-cooldown", error, { queue: alert.source });
    }
  }
}

/** Never mark a deletion notified unless at least one admin received it. */
export async function sendDataDeletedAlert(notice: DataDeletionNotice): Promise<void> {
  const delivered = await sendOperationalAlert({
    source: "data-deletion",
    identity: notice.name,
    message: notice.name,
    render: (locale) =>
      renderDataDeletion({ ...notice, backup: backupLabel(notice.backup), locale }),
  });
  if (delivered === 0) throw new Error("No data-deletion notice was delivered.");
}

function backupLabel(value: string | null): string | null {
  if (!value) return null;
  try {
    const result: unknown = JSON.parse(value);
    if (
      result &&
      typeof result === "object" &&
      "bundlePath" in result &&
      typeof result.bundlePath === "string"
    )
      return result.bundlePath;
  } catch {
    /* Older display-only labels are harmless text. */
  }
  return value;
}

export function closeOperationalAlertConnection(): void {
  alertConnection.disconnect();
}

async function reserveAlertSlot(
  args: OperationalAlert,
): Promise<{ key: string; token: string; deadline: number } | null> {
  const fingerprint = createHash("sha256")
    .update(args.source)
    .update("\0")
    .update(args.identity ?? normalizeError(args.message))
    .digest("hex")
    .slice(0, 32);
  const key = `operational-alert:${args.source}:${fingerprint}`;
  const token = randomUUID();
  const startedAt = Date.now();
  const deadline = startedAt + RESERVATION_MS;
  const requestDeadline = startedAt + REDIS_COMMAND_TIMEOUT_MS;
  try {
    const result = await withTimeout(
      alertConnection.eval(RESERVE_SCRIPT, 1, key, token, RESERVATION_MS + 30_000),
      RESERVE_TIMEOUT_MS,
      "Redis timed out reserving the alert cooldown",
    );
    return result === 1 && Date.now() < requestDeadline ? { key, token, deadline } : null;
  } catch (err) {
    logInternalError("worker.alert-cooldown", err, { queue: args.source });
    return null;
  }
}

/** Reject after `timeoutMs` rather than waiting on a promise that may never settle. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

function normalizeError(message: string): string {
  return message
    .replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replaceAll(/\b\d+\b/g, "<number>")
    .trim()
    .slice(0, 500);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
