import { SUPPORTED_LOCALES } from "@knowledge-base/config/locales";
import prisma from "@knowledge-base/db";
import { FORCE_SSO } from "@knowledge-base/env/server";
import { verifyTransport } from "@knowledge-base/mailer";
import { z } from "zod";

import { protectedProcedure, publicProcedure } from "../index";
import { createProcedureBudget } from "../lib/procedure-budget";

export function passwordCapabilities({
  forceSso,
  hasPasswordCredential,
}: {
  forceSso: boolean;
  hasPasswordCredential: boolean;
}) {
  return {
    canChangePassword: !forceSso && hasPasswordCredential,
  };
}

/**
 * One "email me a code" click is one point. 5 / 600 s covers that click, a
 * couple of retries when SMTP is flaky (the reason the preflight exists), and
 * a colleague or two behind shared egress — while cutting what one anonymous
 * IP can extract from the shared `/rpc` limiter's 100/min (~6,000 SMTP
 * handshakes per hour) to 30.
 *
 * Fail-CLOSED, per the procedure-budget contract: fail-open is "never for
 * spend, mail, or unbounded writes", and each point here opens a real
 * outbound SMTP connection and confirms to an anonymous caller that email is
 * configured. Apply the doc's ten-minute test: losing this bucket for ten
 * minutes during a Redis blip would hand an anonymous client exactly the
 * unbounded SMTP-probe surface this budget exists to close. The availability
 * cost is contained — both callers (web login, native sign-in) catch any
 * thrown error and degrade to `{ ok: false }`, the user is told the code
 * could not be sent, and TOTP verification keeps working for the outage.
 * Like the other strict limiters it carries no insurance backstop: a
 * per-process ceiling is not a real bound across a scaled fleet, and here it
 * would be precisely the thing letting SMTP probes through.
 */
const consumeVerifyEmailTransportBudget = createProcedureBudget({
  keyPrefix: "rl:auth-verify-email-transport",
  points: 5,
  durationSeconds: 600,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many email code requests. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage:
    "Email delivery check is temporarily unavailable. Please try again in a moment.",
  unavailableLog: "[auth] verifyEmailTransport limiter unavailable, failing closed:",
});

/**
 * Keyed on the resolved client IP. `resolveClientIp` never returns undefined —
 * when it cannot identify a caller it returns the literal string `"unknown"`,
 * which is truthy — so compare against the sentinel, not truthiness. There
 * is no client input to fall back on, so unidentifiable callers share one
 * `ip:unknown` bucket. For an outbound-mail budget that is the safe direction: they are
 * metered together instead of each getting a fresh bucket, and the coarser
 * IP-keyed `rpcLimiter` on `/rpc/*` is in front of them either way.
 */
export function verifyEmailTransportBudgetKey(clientIp: string | undefined): string {
  if (clientIp && clientIp !== "unknown") return `ip:${clientIp}`;
  return "ip:unknown";
}

export const authRouter = {
  /**
   * Whether the signed-in user may change a password-bearing credential.
   * Selects only an existence signal — never the password hash — and hides
   * the form for force-SSO deployments and SSO-only accounts.
   */
  passwordCapabilities: protectedProcedure.handler(async ({ context }) => {
    const passwordCredential = await prisma.account.findFirst({
      where: {
        userId: context.session.user.id,
        providerId: "credential",
        password: { not: null },
      },
      select: { id: true },
    });

    return passwordCapabilities({
      forceSso: FORCE_SSO,
      hasPasswordCredential: passwordCredential !== null,
    });
  }),

  /**
   * Delivery-aware preflight for the email-OTP second factor. The login
   * challenge calls this BEFORE `authClient.twoFactor.sendOtp()` because
   * Better-Auth's send-otp endpoint swallows `sendOTP` failures and always
   * returns success — so without this check a user could be told "code sent"
   * when SMTP is unreachable.
   *
   * Public: the caller is mid-2FA (password verified, but no full session yet),
   * so a protected procedure can't be used. Each call makes the server open a
   * real SMTP connection against the app's OWN configured host — and tells an
   * anonymous caller whether email is configured — so it carries its own
   * procedure budget (see {@link consumeVerifyEmailTransportBudget}) rather
   * than relying on the shared `/rpc` limiter. Returns `{ ok }` rather than
   * throwing so the client can branch cleanly.
   */
  verifyEmailTransport: publicProcedure.handler(async ({ context }) => {
    await consumeVerifyEmailTransportBudget(verifyEmailTransportBudgetKey(context.clientIp));
    return { ok: await verifyTransport() };
  }),
  /**
   * Persist the signed-in user's preferred UI locale. Called silently from
   * the LanguageSwitcher when an authenticated user picks a language so the
   * choice follows them across devices.
   *
   * Authenticated only. The session-derived `user.locale` is consumed by
   * `useUserLocaleSync()` on the next session refresh.
   */
  updateLocale: protectedProcedure
    .input(z.object({ locale: z.enum(SUPPORTED_LOCALES) }))
    .handler(async ({ input, context }) => {
      await prisma.user.update({
        where: { id: context.session.user.id },
        data: { locale: input.locale },
      });
      return { success: true };
    }),
};
