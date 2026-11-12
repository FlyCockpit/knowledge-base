import { createHash } from "node:crypto";
import { logInternalError } from "@knowledge-base/env/log";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { twoFactorOtpLimiter } from "./rate-limit.js";

/**
 * The one endpoint this guards. Exact match, same reasoning as
 * `EMAIL_RECIPIENT_PATHS` — a prefix would sweep in `/two-factor/verify-otp`,
 * `/enable`, `/disable`, none of which mail.
 */
export const TWO_FACTOR_OTP_PATH = "/api/auth/two-factor/send-otp";

/**
 * Cookie names Better-Auth may carry a challenge.
 *
 * `verifyTwoFactor` (`better-auth/dist/plugins/two-factor/verify-two-factor.mjs`)
 * has two branches, and both can reach the mailer, so both need a key:
 *
 *   - No session → the `two_factor` cookie IS the challenge. This is the login
 *     flow, and the branch an attacker replays.
 *   - Session present → the challenge is the session itself (the plugin keys it
 *     `${user.id}!${session.id}`). This is an already-signed-in user enabling or
 *     re-verifying 2FA.
 *
 * Names are `<prefix>.<name>` with `__Secure-` added when cookies are secure
 * (`better-auth/dist/cookies/index.mjs:26,221`). The prefix is Better-Auth's
 * default because this app sets no `advanced.cookiePrefix`; if you ever set one,
 * this list and `ssr-cache.ts`'s `hasAuthSessionCookie` both need updating.
 */
const CHALLENGE_COOKIES = [
  "__Secure-better-auth.two_factor",
  "better-auth.two_factor",
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

/**
 * Rate-limit two-factor OTP *resends* per challenge.
 *
 * See `twoFactorOtpLimiter` for why this exists and why it keys on the challenge
 * rather than the recipient. The short version: Better-Auth puts no cap on
 * resends for a given challenge cookie, and the cookie is only consumed on a
 * successful verification — so one cookie can mail its owner's inbox forever.
 *
 * No challenge cookie at all → pass through. `verifyTwoFactor` will reject the
 * request with a 401 before reaching `sendOTP`, so there is nothing to bound,
 * and consuming a point would only let a cookie-less flood burn a bucket.
 */
export function twoFactorOtpLimit(limiter = twoFactorOtpLimiter) {
  return async (c: Context, next: Next) => {
    // Disabled → no Redis round-trip at all.
    if (limiter.points <= 0) return next();

    // Charge EVERY supplied challenge cookie, rather than guessing which branch
    // `verifyTwoFactor` will take. A valid session makes Better-Auth use the
    // session-backed challenge even if a `two_factor` cookie is also present;
    // preferring the latter here would let a caller mint arbitrary cookie values
    // and bypass the session bucket. The reverse preference has the symmetric
    // bug for a no-session login carrying a junk session cookie. Charging both
    // closes both bypasses, and the normal one-cookie flows still use one point.
    //
    // The cost of that choice, stated so it is not mistaken for a bug later: a
    // caller presenting BOTH cookies spends two points on a single send, so with
    // the default budget of 3 the first resend 429s. That needs an ALREADY VALID
    // session plus a live `two_factor` challenge in one browser — signing into a
    // second account while signed into a first. (A signed-out or expired session
    // cookie does not do it: Better-Auth deletes the cookie on sign-out and
    // matches its max-age to the session's expiry, so the browser stops sending
    // it.) Deliberately not "fixed" by charging one point for the whole request:
    // whichever cookie you picked to charge, the other becomes a free bucket, and
    // that is the bypass this loop exists to close. If the case ever shows up in
    // practice, raise the AUTH budget (`RATE_LIMIT_AUTH_POINTS`, which scales
    // this limiter as a family member) — do not make the key selective.
    const challenges = [
      ...new Set(
        CHALLENGE_COOKIES.map((name) => getCookie(c, name)).filter(
          (value): value is string => value !== undefined,
        ),
      ),
    ];
    if (challenges.length === 0) return next();

    for (const challenge of challenges) {
      // Hash the cookie value: it is a signed bearer credential, and the raw
      // string would otherwise sit in a Redis key (and in any key-space dump or
      // slow-log) for the life of the window.
      const key = createHash("sha256").update(challenge).digest("base64url").slice(0, 32);

      try {
        await limiter.consume(key);
      } catch (result: unknown) {
        // `consume` rejects with a RateLimiterRes on budget exhaustion and with an
        // Error on a Redis fault. Distinguishing them by shape rather than by
        // `instanceof` keeps this working when a caller injects a fake limiter.
        if (result && typeof result === "object" && "msBeforeNext" in result) {
          const msBeforeNext = Number((result as { msBeforeNext: number }).msBeforeNext);
          c.header("Retry-After", String(Math.ceil(msBeforeNext / 1000)));
          return c.json(
            { error: "Too many codes requested. Use the last code sent, or sign in again." },
            429,
          );
        }
        // Redis unavailable → fail OPEN, matching the other mail limiters. The
        // fail-closed IP-keyed credential limiters still guard this route, so it is
        // never left completely unthrottled, and failing closed here would block a
        // legitimate user's second factor — i.e. their login — during a blip.
        logInternalError("rate-limit.store", result, {
          limiter: "two-factor-otp",
          mode: "fail-open",
        });
      }
    }

    return next();
  };
}
