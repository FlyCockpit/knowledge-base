import { Socket } from "node:net";
import { mailboxSchema, smtpFromSchema } from "@knowledge-base/env/mailbox";
import { env } from "@knowledge-base/env/shared";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import SMTPConnection from "nodemailer/lib/smtp-connection";

import { senderHeader, senderName } from "./sender.js";

export type AuthorizeEmailSend = (send: (signal: AbortSignal) => Promise<void>) => Promise<void>;

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  authorizeSend?: AuthorizeEmailSend;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = env;

  if (!SMTP_HOST) {
    throw new Error(
      "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM in your .env file. " +
        "For local dev, run: docker run -d -p 1025:1025 -p 8025:8025 axllent/mailpit",
    );
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT ?? 587,
    ...(SMTP_USER && SMTP_PASS ? { auth: { user: SMTP_USER, pass: SMTP_PASS.reveal() } } : {}),
  });

  return transporter;
}

/**
 * Send an email using the SMTP transport configured via env vars.
 *
 * The nodemailer transport is created lazily on the first call so the
 * application boots cleanly even when SMTP is not configured.
 */
export async function sendEmail({
  to,
  subject,
  html,
  authorizeSend,
}: SendEmailOptions): Promise<void> {
  const transport = getTransporter();
  const from = env.SMTP_FROM;
  if (!from) {
    throw new Error(
      "SMTP_FROM is not set. Outgoing email needs an explicit From: address — " +
        'set SMTP_FROM in your .env (e.g. "App Name <no-reply@yourdomain.com>").',
    );
  }

  smtpFromSchema.parse(from);
  if (authorizeSend) mailboxSchema.parse(to);
  const sender = senderHeader(from, senderName());
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (authorizeSend) await sendAuthorized({ from: sender, to, subject, html }, authorizeSend);
      else await transport.sendMail({ from: sender, to, subject, html });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

/** SMTP setup never holds authority. Only the bounded MAIL/RCPT/DATA effect
 * runs in the caller's reservation, with a real socket close on cancellation. */
async function sendAuthorized(
  message: { from: string; to: string; subject: string; html: string },
  authorizeSend: AuthorizeEmailSend,
): Promise<void> {
  const host = env.SMTP_HOST;
  if (!host) throw new Error("SMTP is not configured");
  const compiled = await nodemailer
    .createTransport({ streamTransport: true, buffer: true })
    .sendMail(message);
  const socket = new Socket();
  const drained = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const connection = new SMTPConnection({
    connection: socket,
    host,
    port: env.SMTP_PORT ?? 587,
    secure: (env.SMTP_PORT ?? 587) === 465,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 5_000,
  });
  let rejectPending: ((error: Error) => void) | undefined;
  const failed = (error: Error) => rejectPending?.(error);
  connection.on("error", failed);
  const close = () => {
    connection.close();
    socket.destroy();
  };
  socket.on("error", failed);
  const prepareTimer = setTimeout(() => {
    close();
    failed(new Error("SMTP setup deadline"));
  }, 10_000);
  const callbackOperation = (start: (done: (error?: Error | null) => void) => void) =>
    new Promise<void>((resolve, reject) => {
      rejectPending = reject;
      start((error) => {
        rejectPending = undefined;
        if (error) reject(error);
        else resolve();
      });
    });
  try {
    await callbackOperation((done) => socket.connect(env.SMTP_PORT ?? 587, host, () => done()));
    await callbackOperation((done) => connection.connect(done));
    const user = env.SMTP_USER;
    const pass = env.SMTP_PASS;
    if (user && pass)
      await callbackOperation((done) => connection.login({ user, pass: pass.reveal() }, done));
    clearTimeout(prepareTimer);
    await authorizeSend(async (signal) => {
      const abort = () => {
        close();
        failed(new Error("SMTP send cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        await callbackOperation((done) =>
          connection.send(compiled.envelope, compiled.message, done),
        );
      } finally {
        close();
        await drained;
        signal.removeEventListener("abort", abort);
      }
    });
  } finally {
    clearTimeout(prepareTimer);
    close();
    await drained;
    socket.removeListener("error", failed);
    connection.removeListener("error", failed);
  }
}

/**
 * Whether SMTP is configured at all (env-level check, no network I/O). Drives
 * the `emailEnabled` app-config flag that gates email-dependent UI.
 */
export function isEmailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

/**
 * Best-effort SMTP reachability check (connect + auth handshake via nodemailer's
 * `verify()`). Returns a boolean and NEVER throws: `false` when SMTP is
 * unconfigured or the handshake fails, `true` otherwise.
 *
 * Used as a delivery-aware preflight: Better-Auth's email-OTP `send-otp`
 * endpoint swallows `sendOTP` failures and always returns success, so callers
 * verify the transport is actually reachable before telling a user a code is on
 * the way. This catches the common breakage (wrong host/port/credentials, server
 * down); it cannot guarantee a specific recipient won't bounce after a good
 * handshake — that is inherent to asynchronous email delivery.
 */
export async function verifyTransport(): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  try {
    return await getTransporter().verify();
  } catch {
    return false;
  }
}

// Locale machinery + per-template renderers. The mailer owns email rendering
// (subject + HTML) so callers don't have to think about i18n bundles, just
// pass the recipient's locale and the template-specific data.
export {
  DEFAULT_MAILER_LOCALE,
  isMailerLocale,
  MAILER_LOCALES,
  type MailerLocale,
  resolveMailerLocale,
} from "./locales/index.js";
export {
  type RenderDataDeletionArgs,
  type RenderDataDeletionResult,
  renderDataDeletion,
} from "./templates/data-deletion.js";
export {
  type RenderInviteUserArgs,
  type RenderInviteUserResult,
  renderInviteUser,
} from "./templates/invite-user.js";
export {
  type RenderKbInvitationResult,
  type RenderKbShareInviteArgs,
  type RenderKbTransferOfferArgs,
  renderKbShareInvite,
  renderKbTransferOffer,
} from "./templates/kb-invitation.js";
export {
  type RenderResetPasswordArgs,
  type RenderResetPasswordResult,
  renderResetPassword,
} from "./templates/reset-password.js";
export {
  type RenderTwoFactorOtpArgs,
  type RenderTwoFactorOtpResult,
  renderTwoFactorOtp,
} from "./templates/two-factor-otp.js";
export {
  type RenderVerifyEmailArgs,
  type RenderVerifyEmailResult,
  renderVerifyEmail,
} from "./templates/verify-email.js";
