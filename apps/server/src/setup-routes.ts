import { createHash, timingSafeEqual } from "node:crypto";
import { issueSetupLink, type SetupLinkResult } from "@knowledge-base/api/lib/setup-admin";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import type { Secret } from "@knowledge-base/env/secret";
import type { Context, Env, Hono, Next } from "hono";
import { z } from "zod";
import { resolveClientIp } from "./client-ip.js";
import { createRateLimiterMiddleware, setupLimiter } from "./rate-limit.js";

/**
 * `SETUP_KEY` first-admin bootstrap: the email-free way to finish KB's
 * existing first-admin bootstrap on a fresh deploy. `pnpm deploy:generate-admin`
 * (scripts/) is its client.
 *
 *   POST /api/setup/admin   { "key": "<SETUP_KEY>", "email": "owner@example.com" }
 *   → 200 { url, expiresAt, email }   a one-time setup link
 *
 * The rules, each enforced here or in `issueSetupLink`
 * (packages/api/src/lib/setup-admin.ts):
 *   - The route exists only while SETUP_KEY is set: unset → 404 for every
 *     method, before the limiter or the key are looked at.
 *   - It works only while `BootstrapState` is incomplete, and only for the
 *     address the bootstrap policy admits (ADMIN_EMAIL in production). It
 *     creates no user: the admin is created when the link is spent.
 *     Re-running issues a fresh link and the earlier one dies.
 *   - The key is compared in constant time (SHA-256 of both sides, then
 *     `timingSafeEqual`, so length differences don't leak either) and checked
 *     FIRST: without it the caller learns nothing about the bootstrap.
 *   - Rate limited per client IP (`setupLimiter`, fail-closed).
 *   - Every attempt that reaches the route (refused by the limiter, wrong key,
 *     bad input, refusal, success, error) writes one fixed
 *     `setup.first-admin` record. Never the key, the email, or the link. The
 *     body cap (4 KiB, body-policy.ts) answers oversized bodies before it.
 *   - No password crosses the wire: the response is a one-time set-password
 *     link. It is not a Better-Auth reset token; only `setup.claimFirstAdmin`
 *     can spend it.
 *   - Mounted before CORS (index.ts), so an unset key 404s even a preflight.
 *   - Bootstrap only. Do not hang any other action off SETUP_KEY: it is a
 *     deploy-time credential that is supposed to be deleted, not an API key.
 */

export const SETUP_ADMIN_PATH = "/api/setup/admin";

/** How long the printed set-password link stays valid. */
export const SETUP_LINK_TTL_SECONDS = 60 * 60;

export type SetupAuditOutcome =
  | "rate_limited"
  | "invalid_key"
  | "invalid_request"
  | "password_signin_disabled"
  | Exclude<SetupLinkResult["kind"], "ready">
  | "link_issued"
  | "error";

type RateLimiter = Parameters<typeof createRateLimiterMiddleware>[0];

export interface SetupRouteOptions {
  /** `env.SETUP_KEY`. Unset = the route does not exist. */
  setupKey: Secret | undefined;
  /** False under FORCE_SSO: a password-only admin could never sign in. */
  passwordSignInEnabled: boolean;
  limiter?: RateLimiter;
  issue?: (email: string) => Promise<SetupLinkResult>;
}

// The key is checked separately (and first).
const requestSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
});

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time key check. Hashing first makes both sides the same length. */
export function setupKeyMatches(provided: unknown, expected: string): boolean {
  const candidate = typeof provided === "string" ? provided : "";
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

function defaultIssue(email: string) {
  return issueSetupLink(email, { ttlSeconds: SETUP_LINK_TTL_SECONDS });
}

export function mountSetupRoutes<E extends Env>(app: Hono<E>, options: SetupRouteOptions) {
  const { setupKey, passwordSignInEnabled, limiter = setupLimiter, issue = defaultIssue } = options;

  if (!setupKey) {
    // Absent, not forbidden: the same 404 an unknown path gets.
    app.all(SETUP_ADMIN_PATH, (c) => c.json({ error: "Not found" }, 404));
    return;
  }

  const record = (c: Context, outcome: SetupAuditOutcome, status: number) => {
    const requestId = c.get("requestId" as never) as string | undefined;
    logEvent("setup.first-admin", { reason: outcome, status, requestId });
  };

  // Answers from the limiter (429, or 503 while Redis is down) are attempts
  // too; they are audited here, after the limiter has answered.
  app.use(SETUP_ADMIN_PATH, async (c: Context, next: Next) => {
    await next();
    c.header("Cache-Control", "no-store");
    if (c.res.status === 429 || c.res.status === 503) record(c, "rate_limited", c.res.status);
  });
  app.use(
    SETUP_ADMIN_PATH,
    createRateLimiterMiddleware(limiter, { failClosed: true, resolveKey: resolveClientIp }),
  );

  app.all(SETUP_ADMIN_PATH, async (c) => {
    if (c.req.method !== "POST") {
      record(c, "invalid_request", 405);
      return c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const providedKey =
      typeof body === "object" && body !== null && "key" in body ? body.key : undefined;
    if (!setupKeyMatches(providedKey, setupKey.reveal())) {
      record(c, "invalid_key", 401);
      return c.json({ error: "invalid_key" }, 401);
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      record(c, "invalid_request", 400);
      return c.json({ error: "invalid_email" }, 400);
    }
    if (!passwordSignInEnabled) {
      record(c, "password_signin_disabled", 409);
      return c.json({ error: "password_signin_disabled" }, 409);
    }

    try {
      const result = await issue(parsed.data.email);
      if (result.kind !== "ready") {
        record(c, result.kind, 409);
        return c.json({ error: result.kind }, 409);
      }
      record(c, "link_issued", 200);
      return c.json({
        url: result.url,
        expiresAt: result.expiresAt.toISOString(),
        email: result.email,
      });
    } catch (err) {
      logInternalError("setup.first-admin.error", err);
      record(c, "error", 500);
      return c.json({ error: "internal_error" }, 500);
    }
  });
}
