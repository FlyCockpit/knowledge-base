import {
  getCurrentDBAdapterAsyncLocalStorage,
  queueAfterTransactionHook,
} from "@better-auth/core/context";
import { logEvent, logInternalError } from "@knowledge-base/env/log";

export const VERIFICATION_MAIL_LOG_SITE = "auth.verification-email";
export const VERIFICATION_MAIL_SKIPPED_LOG_SITE = "auth.verification-email-skipped";

/**
 * Detached sends in flight at once, process-wide. Each is bounded by the
 * mailer's own timeouts and retries; during an SMTP outage sign-ups past this
 * get no mail now (logged) and keep their account: sign-in and the
 * verify-email page send it again.
 */
export const MAX_DETACHED_VERIFICATION_MAILS = 64;

const detached = new Set<Promise<void>>();

async function inTransaction(): Promise<boolean> {
  try {
    const storage = await getCurrentDBAdapterAsyncLocalStorage();
    return storage.getStore()?.isTransactionActive === true;
  } catch {
    return false;
  }
}

function startDetached(send: () => Promise<void>): void {
  if (detached.size >= MAX_DETACHED_VERIFICATION_MAILS) {
    logEvent(VERIFICATION_MAIL_SKIPPED_LOG_SITE, { count: detached.size });
    return;
  }
  const task: Promise<void> = send()
    .catch((error: unknown) => logInternalError(VERIFICATION_MAIL_LOG_SITE, error))
    .finally(() => detached.delete(task));
  detached.add(task);
}

/**
 * Shutdown: wait at most `timeoutMs` for the detached sends in flight,
 * including ones started while waiting (requests the HTTP drain still answers),
 * so a deploy does not cut a mail being delivered. Resolves with how many were
 * still running at the bound.
 */
export async function drainVerificationMail(timeoutMs: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve();
    }, timeoutMs);
  });
  while (detached.size > 0 && !expired) {
    await Promise.race([Promise.allSettled([...detached]), bound]);
  }
  clearTimeout(timer);
  return detached.size;
}

/**
 * Deliver a verification mail outside any open auth transaction.
 *
 * Better Auth runs `/sign-up/email` inside one adapter transaction and awaits
 * `sendVerificationEmail` before it commits. Mailing from there read the user's
 * locale outside the transaction (so the new row was invisible and the mail fell
 * back to en-US), held the transaction open for the SMTP timeouts, and turned an
 * SMTP failure into a rolled-back user and a slow 500 that only a free address
 * got, while a registered one got the neutral 200 at once.
 *
 * Inside a transaction the send is queued for after the commit and detached from
 * the request (at most `MAX_DETACHED_VERIFICATION_MAILS` at once), so the
 * response is the same whatever SMTP does; a failure is logged and the account
 * stays, and the mail is re-sent on the next sign-in or from the verify-email
 * page. A rollback queues nothing. Outside a transaction (the re-send endpoint,
 * sign-in) the send is awaited as before.
 *
 * Not the durable job outbox: the link is a JWT signed with the server-only
 * BETTER_AUTH_SECRET, which the worker does not hold, and storing a signed link
 * in Postgres would put a live credential in every backup.
 */
export async function sendVerificationMailAfterCommit(send: () => Promise<void>): Promise<void> {
  if (!(await inTransaction())) return send();
  await queueAfterTransactionHook(async () => startDetached(send));
}
