import { logInternalError } from "@knowledge-base/env/log";
import type { Context, MiddlewareHandler, Next } from "hono";
import { RateLimiterRes } from "rate-limiter-flexible";
import { FORM_OR_JSON_MEDIA_TYPES, readEmail } from "./email-recipient-limit.js";
import { setRateLimitHeaders, signinFailureKey, signinFailureLimiter } from "./rate-limit.js";

/**
 * The one route this guards: Better-Auth's password sign-in. Exact match, same
 * reasoning as `EMAIL_RECIPIENT_PATHS` — a prefix would sweep in SSO and other
 * passwordless flows whose failures mean something else. Scoped to sign-in
 * ONLY: signup and password reset cannot fail a credential check, so a per-email
 * counter there would be a pure lockout lever with no defensive value.
 */
export const SIGNIN_FAILURE_PATH = "/api/auth/sign-in/email";

/**
 * True when a `/sign-in/email` response is a FAILED CREDENTIAL CHECK.
 *
 * 401 is Better-Auth's `INVALID_EMAIL_OR_PASSWORD` (`UNAUTHORIZED`). The
 * predicate is the security-critical part of this middleware, and 401-only is a
 * requirement, not precision for its own sake — every other plausible status is
 * a response that either fires BEFORE any password is read or means the
 * password was RIGHT:
 *
 *   - The 403 family is the trap. `/sign-in/email` declares
 *     `use: [formCsrfMiddleware]` (`sign-in.mjs:146`), so a `Cookie` with no
 *     (or `null`) `Origin` gets `MISSING_OR_NULL_ORIGIN`, a present-but-untrusted
 *     one gets `INVALID_ORIGIN`, and a cross-site navigation gets
 *     `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` — all BEFORE the password is read.
 *     Charging those hands anyone who knows an address an unauthenticated way to
 *     fill that address's failure bucket and 429 the victim out of their own
 *     login — the exact lever this counter's design exists to avoid; the same
 *     reasoning `signinSentMail` documents for the mail bucket. `EMAIL_NOT_VERIFIED`
 *     (also 403) means the password was CORRECT, and `BANNED_USER` (403) never
 *     checked it.
 *   - 400 is a malformed body — no account was consulted.
 *   - 200 is a success or a 2FA redirect — the credentials were right.
 *   - A 429 from the limiters mounted before this one is not a guess; charging
 *     it would double-count one attempt into two buckets.
 *
 * Re-check when bumping better-auth: a failure code that answers a different
 * status would silently stop being counted.
 */
function signinFailedCredentials(c: Context): boolean {
  return c.res.status === 401;
}

/**
 * The middleware needs only these members, so it asks for only these — the
 * real `signinFailureLimiter` satisfies it, and a test can supply a plain
 * object without casting through `unknown`. `reward` is required rather than
 * optional for the same reason `RefundableLimiter` in
 * `email-recipient-limit.ts` requires it: a limiter that can reserve but never
 * refund silently converts reserve/refund into charge-every-attempt, i.e. the
 * unauthenticated login-lockout this middleware exists to avoid. There is no
 * runtime symptom until a real user is 429'd out of their own sign-in.
 */
type FailureLimiter = {
  readonly points: number;
  consume(key: string): Promise<unknown>;
  reward(key: string): Promise<unknown>;
};

/**
 * Per-EMAIL cap on FAILED password sign-ins — the rotating-IP half of the
 * credential defense. `credentialLimiter`/`credentialBurstLimiter` (IP-keyed,
 * fail-closed) bound one caller; this bounds one ACCOUNT, which is the thing a
 * stuffing campaign actually attacks. See `signinFailureLimiter` in
 * rate-limit.ts for the budget, the anti-lever reasoning, and why it fails
 * open; see `signinFailedCredentials` for why only 401s charge.
 *
 * Charging is RESERVE-then-REFUND, the same deferred mode `emailRecipientLimit`
 * uses on this very route:
 *
 *   - A point is reserved BEFORE the handler, because consuming only after the
 *     response cannot bound concurrent guessing across replicas at all —
 *     N parallel wrong-password requests would all see a spare point.
 *   - The point is refunded unless the response is a 401, so a legitimate
 *     user's successful sign-ins (and every pre-password rejection above)
 *     leave no lasting charge. The reservation itself is held only for the
 *     length of the handler, and a password check is deliberately slow — an
 *     attacker can transiently saturate the bucket with in-flight attempts the
 *     same way they can `signinRecipientLimiter`'s; it decays the instant the
 *     flood stops, and bounding the flood is the point.
 *
 * Mounted AFTER the fail-closed IP-keyed credential pair (and after
 * `signinRecipientLimit`): its key is caller-supplied, so per the
 * one-bucket-per-surface rule in AGENTS.md § Rate limiting — one bucket per surface it must sit behind
 * a coarser, non-attacker-chosen control. A request 429'd by those never
 * reaches a password check, hence is never a 401, hence never charges here.
 */
export function signinFailureLimit(
  limiter: FailureLimiter = signinFailureLimiter,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // Disabled → no Redis round-trip at all.
    if (limiter.points <= 0) return next();
    // Better-Auth serves this route POST-only; anything else is better-call's
    // to answer, and cannot be a credential failure.
    if (c.req.method !== "POST") return next();
    // No body at all: better-call returns early with its own 400 before it
    // ever looks at the media type. Mirror that — a bodyless POST names no
    // account and must not be counted.
    if (!c.req.raw.body) return next();

    const parsed = await readEmail(c, FORM_OR_JSON_MEDIA_TYPES);
    // Unknown media type, unparseable body, or no usable `email`: Better-Auth
    // answers with its own 4xx before any password is checked, and that
    // response is never a 401, so even a reservation would be refunded. Skip
    // the round-trip — and never charge a bucket for a request that named no
    // account. (Passing "unsupported" through rather than 415ing ourselves is
    // the difference from `emailRecipientLimit`: Better-Auth's 415 is not a
    // failure, and we are not this route's media gate.)
    if (parsed.kind !== "parsed" || !parsed.email) return next();
    const key = signinFailureKey(parsed.email);

    let reserved = false;
    try {
      await limiter.consume(key);
      reserved = true;
    } catch (result: unknown) {
      if (result instanceof RateLimiterRes) {
        // Same response shape `createRateLimiterMiddleware` emits, so a client
        // cannot tell which layer refused it — and the Retry-After honestly
        // reports the short block, which is the anti-lever property.
        setRateLimitHeaders(c, limiter, result);
        c.header("Retry-After", String(Math.ceil(result.msBeforeNext / 1000)));
        return c.json({ error: "Too many attempts. Please wait a moment and try again." }, 429);
      }
      // Redis unavailable → fail OPEN. The fail-closed IP-keyed credential
      // limiters still guard this route, so sign-in is never left unthrottled —
      // this layer's absence merely restores the IP-only posture. Do not
      // attempt a refund below: the reservation never succeeded.
      logInternalError("rate-limit.store", result, {
        limiter: "signin-failure",
        mode: "fail-open",
      });
    }

    // `finally`, so a throw from downstream cannot strand the reservation in a
    // real user's bucket: Hono's outer `onError` turns the throw into a
    // response without ever returning here, and on a throw there is no
    // response to inspect, so the point is simply refunded — fail-safe is the
    // safe direction for a failure counter (a refunded guess is bounded by the
    // IP pair; a stranded one locks the victim out).
    let failed = false;
    try {
      await next();
      failed = signinFailedCredentials(c);
    } finally {
      if (reserved && !failed) {
        // If the store fails here the point expires with the window — the safe
        // direction, same reasoning as the reservation catch above.
        //
        // try/catch rather than `.catch()` alone: this runs in a `finally`, so
        // a SYNCHRONOUS throw from `reward` would replace the exception
        // `next()` raised — turning a real downstream error into a confusing
        // rate-limiter one.
        try {
          await limiter.reward(key);
        } catch (err: unknown) {
          logInternalError("rate-limit.refund", err, { limiter: "signin-failure" });
        }
      }
    }
    return;
  };
}
