import { randomUUID } from "node:crypto";
import { SUPPORTED_LOCALES } from "@knowledge-base/config/locales";
import type { PrismaClient } from "@knowledge-base/db/client";
import type { AuthorizeEmailSend } from "@knowledge-base/mailer";
// Renderer subpath only: the mailer index validates SMTP env at import.
import { renderKbShareInvite, renderKbTransferOffer } from "@knowledge-base/mailer/kb-invitation";
import { z } from "zod";
import { runLockedOperation } from "./authority-lock";
import { type JobAttemptOptions, withJobAttempt } from "./job-attempt.js";
import { claimJobAttempt, DurableJobFenceError, enqueueDurableJobOnQuery } from "./jobs.js";
import type { LockQuery } from "./lock";
import { authorize, sqlAuthorityStore } from "./permissions";
import { KbAdmissionError } from "./principal";
import { decryptShareInvitationEmail } from "./shares";

/**
 * KB share invitations and ownership-transfer offers are emailed.
 *
 * The request path only enqueues a durable job (same transaction as the
 * invitation/transfer row), whose payload carries ids, the public origin and
 * the inviter's UI locale — never an address. The worker resolves the
 * recipient from Postgres at send time, so the API response and its timing do
 * not depend on whether the address has an account, and a stale job (accepted,
 * revoked or superseded) completes without sending.
 */

const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  });
const kbIdSchema = z.string().min(1).max(64);

export const kbEmailDesiredSchema = z.discriminatedUnion("template", [
  z.strictObject({
    template: z.literal("share_invite"),
    kbId: kbIdSchema,
    requestId: z.uuid(),
    origin,
    locale: z.enum(SUPPORTED_LOCALES),
  }),
  z.strictObject({
    template: z.literal("transfer_offer"),
    kbId: kbIdSchema,
    requestId: z.uuid(),
    origin,
  }),
]);
export type KbEmailDesired = z.infer<typeof kbEmailDesiredSchema>;
export type KbEmailTemplate = KbEmailDesired["template"];

export function kbEmailDedupKey(
  template: KbEmailTemplate,
  requestId: string,
  idempotencyKey: string,
): string {
  return `kb-email:${template}:${requestId}:${idempotencyKey}`;
}

/** Enqueue inside the caller's invitation/transfer transaction (atomic with it). */
export async function enqueueKbEmailOnQuery(
  query: LockQuery,
  desired: KbEmailDesired,
  idempotencyKey: string,
): Promise<void> {
  const parsed = kbEmailDesiredSchema.parse(desired);
  await enqueueDurableJobOnQuery(query, {
    dedupKey: kbEmailDedupKey(parsed.template, parsed.requestId, idempotencyKey),
    kind: "KB_EMAIL",
    desired: parsed,
  });
}

/**
 * Acceptance link on the KB settings page (the same links the web UI shows as
 * a copyable fallback). Share invitations also get a sign-up link that returns
 * to the acceptance page, so an address without an account can accept.
 */
export function kbEmailLinks(
  desired: KbEmailDesired,
  transferLocale?: string,
): { acceptUrl: string; signupUrl: string | null } {
  const base = desired.origin.replace(/\/+$/, "");
  if (desired.template === "share_invite") {
    const lang = encodeURIComponent(desired.locale);
    const path = `/${lang}/kbs/${encodeURIComponent(desired.kbId)}/settings?accept=${encodeURIComponent(desired.requestId)}`;
    return {
      acceptUrl: `${base}${path}`,
      signupUrl: `${base}/${lang}/signup?redirectTo=${encodeURIComponent(path)}`,
    };
  }
  const lang = encodeURIComponent(
    (SUPPORTED_LOCALES as readonly string[]).includes(transferLocale ?? "")
      ? transferLocale!
      : "en-US",
  );
  return {
    acceptUrl: `${base}/${lang}/kbs/${encodeURIComponent(desired.kbId)}/settings?transfer=${encodeURIComponent(desired.requestId)}`,
    signupUrl: null,
  };
}

export type KbEmailMessage = { to: string; subject: string; html: string };
export type KbEmailDeliveryResult =
  | { skipped: "not_claimed" | "stale" | "smtp_unconfigured" }
  | { sent: true };

type EmailDb = Parameters<typeof claimJobAttempt>[0] &
  JobAttemptOptions["db"] &
  Pick<PrismaClient, "shareInvitation" | "kbTransfer" | "user" | "knowledgeBase">;

type Resolved = { message: KbEmailMessage } | null;

async function resolveMessage(
  db: EmailDb,
  query: LockQuery,
  desired: KbEmailDesired,
  masterKey: string | undefined,
): Promise<Resolved> {
  const kb = await db.knowledgeBase.findUnique({
    where: { id: desired.kbId },
    select: { name: true, state: true, ownerId: true, metadataVersion: true },
  });
  if (kb?.state !== "ACTIVE") return null;
  if (desired.template === "share_invite") {
    const invite = await db.shareInvitation.findUnique({
      where: { requestId: desired.requestId },
      select: {
        kbId: true,
        inviterUserId: true,
        emailCiphertext: true,
        acceptedAt: true,
        revokedAt: true,
        inviter: { select: { name: true } },
      },
    });
    if (!invite || invite.kbId !== desired.kbId || invite.acceptedAt || invite.revokedAt)
      return null;
    if (!(await canReadOrManage(query, desired.kbId, invite.inviterUserId, "manage"))) return null;
    let to: string;
    try {
      to = decryptShareInvitationEmail(
        invite.inviterUserId,
        desired.requestId,
        invite.emailCiphertext,
        masterKey,
      );
    } catch {
      throw new Error("Invitation address unavailable");
    }
    const links = kbEmailLinks(desired);
    const { subject, html } = renderKbShareInvite({
      inviterName: invite.inviter.name,
      kbName: kb.name,
      acceptUrl: links.acceptUrl,
      signupUrl: links.signupUrl!,
      locale: desired.locale,
    });
    return { message: { to, subject, html } };
  }
  const transfer = await db.kbTransfer.findUnique({
    where: { requestId: desired.requestId },
    select: {
      kbId: true,
      state: true,
      fromUserId: true,
      toUserId: true,
      metadataVersion: true,
      fromUser: { select: { name: true } },
      toUser: { select: { email: true, locale: true } },
    },
  });
  if (
    !transfer ||
    transfer.kbId !== desired.kbId ||
    transfer.state !== "PENDING" ||
    transfer.fromUserId !== kb.ownerId ||
    transfer.metadataVersion !== kb.metadataVersion ||
    !(await canReadOrManage(query, desired.kbId, transfer.fromUserId, "manage")) ||
    !(await canReadOrManage(query, desired.kbId, transfer.toUserId, "read"))
  )
    return null;
  const links = kbEmailLinks(desired, transfer.toUser.locale);
  const { subject, html } = renderKbTransferOffer({
    inviterName: transfer.fromUser.name,
    kbName: kb.name,
    acceptUrl: links.acceptUrl,
    locale: transfer.toUser.locale,
  });
  return { message: { to: transfer.toUser.email, subject, html } };
}

async function canReadOrManage(
  query: LockQuery,
  kbId: string,
  userId: string,
  operation: "read" | "manage",
): Promise<boolean> {
  try {
    await authorize({
      store: sqlAuthorityStore(query),
      query,
      principal: { kind: "browser", userId },
      kbId,
      operation,
    });
    return true;
  } catch (error) {
    if (error instanceof KbAdmissionError) return false;
    throw error;
  }
}

class StaleKbEmailError extends Error {}

/**
 * The production consumer, shared by the worker handler and the PG suite
 * (which injects a capturing `send`). Delivery is at-least-once: a crash after
 * SMTP accepted the message but before COMPLETE re-sends on retry. Transport
 * errors are replaced by a fixed message so no address reaches `lastError`.
 */
export async function runKbEmailDelivery(
  db: EmailDb,
  input: {
    workerId: string;
    durableJobId: string;
    connectionString: string;
    masterKey: string | undefined;
    /** Transport prepares outside the gate, then MUST invoke the guard at SMTP send. */
    send: (message: KbEmailMessage, authorizeSend: AuthorizeEmailSend) => Promise<void>;
    /** False when SMTP is not configured: complete without sending (link fallback). */
    emailConfigured?: boolean;
    now?: () => Date;
  },
): Promise<KbEmailDeliveryResult> {
  const now = input.now ?? (() => new Date());
  const claimed = await claimJobAttempt(db, {
    jobId: input.durableJobId,
    workerId: input.workerId,
    now: now(),
  });
  if (!claimed) return { skipped: "not_claimed" };
  return withJobAttempt(claimed, { db, workerId: input.workerId, now }, async (ctx) => {
    if (claimed.kind !== "KB_EMAIL") throw new Error("Unexpected durable job kind");
    const desired = kbEmailDesiredSchema.parse(claimed.desired);
    if (input.emailConfigured === false) {
      await ctx.complete();
      return { skipped: "smtp_unconfigured" } as const;
    }
    // The durable RUNNING intent precedes every external effect. Lock order is
    // authority -> job row; cancellation/lease replacement must win that row
    // before another attempt can send. Connect/login/retry sleeps are outside.
    const guarded = async <T>(
      work: (message: KbEmailMessage, signal: AbortSignal) => Promise<T>,
    ): Promise<T> =>
      runLockedOperation({
        connectionString: input.connectionString,
        opId: randomUUID(),
        kind: "authority",
        run: (lease) =>
          lease.transaction(async (query) => {
            const {
              rows: [job],
            } = await query<
              Pick<
                typeof claimed,
                "state" | "cancelledAt" | "workerOwner" | "attemptEpoch" | "leaseUntil"
              >
            >(
              `SELECT state, "cancelledAt", "workerOwner", "attemptEpoch", "leaseUntil" FROM durable_job WHERE id=$1 FOR UPDATE`,
              [claimed.id],
            );
            const assertJob = () => {
              lease.scope.assertActive();
              if (
                job?.state !== "RUNNING" ||
                job.cancelledAt ||
                job.workerOwner !== input.workerId ||
                job.attemptEpoch !== claimed.attemptEpoch ||
                !job.leaseUntil ||
                job.leaseUntil <= now()
              )
                throw new DurableJobFenceError();
            };
            assertJob();
            const current = await resolveMessage(db, query, desired, input.masterKey);
            if (!current) throw new StaleKbEmailError();
            assertJob();
            return work(current.message, lease.scope.signal);
          }),
      });
    let resolved: KbEmailMessage;
    try {
      resolved = await guarded(async (message) => message);
    } catch (error) {
      if (!(error instanceof StaleKbEmailError)) throw error;
      await ctx.complete();
      return { skipped: "stale" } as const;
    }
    const authorizeSend: AuthorizeEmailSend = (send) =>
      guarded(async (current, scopeSignal) => {
        // Recipient changes require fresh transport preparation on the durable retry.
        // Names are an authorized snapshot; a live rename does not cancel an invite.
        if (current.to !== resolved.to) throw new Error("Email recipient changed");
        const abort = new AbortController();
        // Only this bounded final SMTP effect is authority-serialized. The
        // transport closes its connection on abort and joins before unlocking.
        const timer = setTimeout(() => abort.abort(new Error("SMTP send deadline")), 3_000);
        try {
          await send(AbortSignal.any([abort.signal, scopeSignal]));
        } finally {
          clearTimeout(timer);
        }
      });
    try {
      await input.send(resolved, authorizeSend);
    } catch (error) {
      if (error instanceof StaleKbEmailError) {
        await ctx.complete();
        return { skipped: "stale" } as const;
      }
      if (error instanceof DurableJobFenceError) throw error;
      throw new Error("SMTP delivery failed");
    }
    await ctx.complete();
    return { sent: true } as const;
  });
}
