import { logInternalError } from "@knowledge-base/env/log";
import type { Context, MiddlewareHandler, Next } from "hono";
import { RateLimiterRes } from "rate-limiter-flexible";
import { emailRateLimitKey, emailRecipientLimiter } from "./rate-limit.js";

/**
 * Anonymous Better-Auth endpoints that mail a caller-supplied address.
 *
 * Both take `{ email }` in the POST body and are reachable with no
 * session, which is what makes them usable as a mail cannon aimed at someone
 * else's inbox. `/change-email` also sends mail but requires a session and
 * mails the address the *authenticated user* nominated, so it is covered by
 * the per-user auth limiter instead and is deliberately absent here.
 *
 * Matched as exact paths rather than a prefix so a future endpoint doesn't get
 * silently swept in with an `email` field that means something else.
 */
export const EMAIL_RECIPIENT_PATHS = [
  "/api/auth/send-verification-email",
  "/api/auth/request-password-reset",
] as const;

/**
 * Enabling a Better-Auth plugin that mails a caller-supplied address means
 * adding its path above. The list is exact-match, so a plugin route is
 * unprotected until it is named here — and the plugin's own rate limiting is
 * IP-keyed, which is the control rotating IPs defeat.
 *
 * The one to know about is `emailOTP` (not enabled here — see
 * `packages/auth/src/index.ts` for the plugins that are). It adds FOUR
 * anonymous recipient-controlled mailers, none of which match anything above:
 *
 *   /api/auth/sign-in/email-otp
 *   /api/auth/forget-password/email-otp
 *   /api/auth/email-otp/send-verification-otp
 *   /api/auth/email-otp/request-password-reset
 *
 * Its `/email-otp/request-email-change` is NOT one of them: like `/change-email`
 * it requires a session, so the per-user auth limiter covers it.
 *
 * Two enabled paths mail without appearing in any list here, and both are
 * metered elsewhere rather than by this middleware, because neither takes its
 * recipient from the request body:
 *
 *   - `/sign-in/email` mails only because `requireEmailVerification` and
 *     `sendOnSignIn` are both on — a config flag, not a plugin. It IS metered
 *     here, in deferred mode; see `SIGNIN_RECIPIENT_PATH` below.
 *   - `/two-factor/send-otp` mails to the address on the challenge, so this
 *     middleware cannot see the recipient at all. It gets its own
 *     challenge-keyed limiter in `two-factor-otp-limit.ts`.
 *
 * When auditing this set, read `packages/auth/src/index.ts` for flags and
 * callbacks that turn an ordinary endpoint into a mailer, not just the plugin
 * array — and remember a recipient does not have to arrive in the body.
 */

/**
 * Signup is the third recipient-controlled mail path, held separately because
 * it gets its own (higher) budget — see `signupRecipientLimiter`. It is NOT in
 * the list above: sharing one bucket would let a signup flood consume the
 * budget a legitimate user needs to reset their own password.
 */
export const SIGNUP_RECIPIENT_PATH = "/api/auth/sign-up/email";

/**
 * Sign-in is the fourth, and the least obvious — it is a mailer only because of
 * two settings in `packages/auth/src/index.ts`: `requireEmailVerification: true`
 * makes a correct password on an unverified account fail, and `sendOnSignIn:
 * true` makes that failure re-send the verification link to the address in the
 * body. Turn either off and this path stops mailing.
 *
 * Its own bucket (`signinRecipientLimiter`), and metered in DEFERRED mode via
 * `signinSentMail` below — see `ConsumeWhen` for why charging every sign-in
 * would be a targeted-lockout bug rather than a rate limit.
 */
export const SIGNIN_RECIPIENT_PATH = "/api/auth/sign-in/email";

/**
 * True when a `/sign-in/email` response indicates Better-Auth just sent a
 * verification mail.
 *
 * `sign-in.mjs:222-242` verifies the password FIRST, then — if
 * `requireEmailVerification` is on and the user is unverified — sends the mail
 * (when `sendOnSignIn` is on) and throws `FORBIDDEN` / `EMAIL_NOT_VERIFIED`.
 *
 * It matches on the error CODE, not on the 403 status alone, and that is a
 * security requirement rather than precision for its own sake. Status alone is
 * WRONG here, and expensively so:
 *
 *   - `/sign-in/email` declares `use: [formCsrfMiddleware]` (`sign-in.mjs:146`).
 *   - `validateFormCsrf` → `validateOrigin` throws `FORBIDDEN` /
 *     `MISSING_OR_NULL_ORIGIN` for any request that carries a `Cookie` header
 *     with no (or a `null`) `Origin`, `INVALID_ORIGIN` for one that is present
 *     but untrusted, and `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED` for
 *     `Sec-Fetch-Site: cross-site` + `Sec-Fetch-Mode: navigate`
 *     (`api/middlewares/origin-check.mjs:107,112,144`). Neither `skipCSRFCheck` nor
 *     `advanced.disableOriginCheck` is set in `packages/auth/src/index.ts`, so
 *     the check is live.
 *   - That 403 fires BEFORE the password is read. So a bare
 *     `status === 403` predicate charges a point for a request that needs no
 *     password, no existing account, and no mail — handing anyone who knows an
 *     address an unauthenticated way to fill that address's bucket and 429 the
 *     victim out of their own login. That is exactly the lockout the deferred
 *     mode exists to prevent, reintroduced through the predicate.
 *
 * `APIError.from()` puts `{ message, code }` in the body
 * (`@better-auth/core/dist/error/index.mjs`) and better-call serializes it as
 * the JSON response body (`to-response.mjs:127`), so the code is readable off a
 * clone without disturbing the response the client gets.
 *
 * The other 403 on this route — the admin plugin's `BANNED_USER`, thrown from
 * `session.create.before` — is likewise excluded, correctly: it sends no mail.
 *
 * Unparseable or non-JSON body → `false`, i.e. refund. On this predicate the
 * two error directions are not symmetric: failing to charge a real mail leaves
 * a mailer bounded by `credentialLimiter` and by the attacker needing a correct
 * password for an unverified account, whereas charging a non-mail response is
 * the lockout above. Refund is the safe direction.
 *
 * Re-check this function when bumping better-auth: a new code that DOES mail
 * would silently stop being metered.
 */
export async function signinSentMail(c: Context): Promise<boolean> {
  if (c.res.status !== 403) return false;
  try {
    // `clone()` tees the stream — the original `c.res` is still sent intact.
    const body = (await c.res.clone().json()) as { code?: unknown };
    return body?.code === "EMAIL_NOT_VERIFIED";
  } catch {
    return false;
  }
}

/**
 * Rate limit the anonymous send-mail endpoints by RECIPIENT, not by caller.
 *
 * Mount this *after* the IP-keyed `authLimiter` — that one is the fail-closed
 * security control; this is the anti-abuse layer on top. See the
 * `emailRecipientLimiter` doc comment for why the two limiters key differently
 * and why only one of them fails closed.
 *
 * Why a 429 here does NOT leak account existence: the counter is driven purely
 * by how many times *someone asked* for this address, never by whether an
 * account exists or is already verified. Probing an unregistered address and a
 * real unverified one produces byte-identical responses until the shared cap is
 * hit. That is the same property Better-Auth's constant-time floor gives the
 * success path, and it is why the 429 can carry an honest "wait and retry"
 * message instead of a fake success — the alternative would strand a legitimate
 * user waiting for a password-reset mail that is never coming.
 */
/**
 * The middleware needs only these two members, so it asks for only these two —
 * `emailRecipientLimiter`, `signupRecipientLimiter`, and `signinRecipientLimiter`
 * all satisfy it, and a test can supply a plain object without casting through
 * `unknown`.
 */
type RecipientLimiter = {
  readonly points: number;
  consume(key: string): Promise<unknown>;
  /** Only needed by the deferred mode below; refunds its provisional point. */
  reward?(key: string, points?: number): Promise<unknown>;
};

/**
 * Deferred mode additionally needs the REFUND half of the pair, and the overloads
 * on `emailRecipientLimit` require it rather than leaving it optional.
 *
 * Not pedantry. A limiter with `consume` but no `reward`, passed alongside a
 * `consumeWhen`, reserves a point on every request and can never give one back —
 * which silently converts deferred mode into charge-every-attempt, i.e. exactly
 * the unauthenticated login-lockout this mode exists to prevent. There is no
 * runtime symptom until a real user is 429'd out of their own sign-in, so the
 * type is the only place to catch it.
 */
type RefundableLimiter = RecipientLimiter & {
  reward(key: string, points?: number): Promise<unknown>;
};

/**
 * Decides, AFTER the handler has run, whether this request actually sent mail.
 *
 * Supplying one switches the middleware from "charge every request that names a
 * recipient" to "charge only the requests that mailed". That distinction does
 * not matter on the resend/reset/signup paths — there, naming a recipient IS
 * the request — but it is the whole ballgame on `/sign-in/email`.
 *
 * Why: the bucket is keyed on an address the CALLER supplies, and exhausting it
 * returns 429. On a path where every request costs a point, that hands anyone
 * who knows your email address an unauthenticated lever to lock you out of the
 * surface — and on sign-in the surface is *logging in*. Ten junk POSTs an hour
 * with a wrong password would have denied a verified user their own login, from
 * rotating IPs that the IP-keyed `credentialLimiter` cannot bound. That is a
 * strictly worse bug than the unmetered-mailer one this limiter exists to fix,
 * and it is the hazard the EMAIL family's code-fixed 0-second block already
 * warns about (see `emailRecipientLimiter`'s doc comment in rate-limit.ts),
 * applied to the worst possible endpoint.
 *
 * With a predicate, a verified user's sign-in leaves no LASTING charge: the
 * point is refunded as the response goes out, so only a mail-sending outcome
 * accumulates, and the only account that can be blocked long-term is one that is
 * unverified AND whose password the caller already has — an account that cannot
 * complete a sign-in anyway.
 *
 * "No lasting charge" is the accurate claim; "cannot be affected at all" is not.
 * The reservation below is held for the duration of the handler, and
 * `/sign-in/email` deliberately spends real time hashing the password. An
 * attacker holding `points` requests in flight against one address keeps that
 * bucket at its cap for as long as they sustain the concurrency, and a
 * legitimate sign-in arriving inside that window gets a 429. Each request
 * refunds on completion, so this decays the moment the flood stops — but it is a
 * live window, not a theoretical one, and rotating IPs evade the IP-keyed
 * `credentialLimiter` that would otherwise bound it. It is accepted because the
 * alternative (consume only after the handler) cannot bound concurrent sends
 * across replicas at all; see the reservation comment in the middleware.
 *
 * If you ever raise the recipient family's block above its code-fixed 0, note
 * it is shared with this limiter: the first overshoot calls `_block`, which
 * rewrites the key's TTL to the block duration, and a refund decrements the
 * counter without restoring the original window. That turns the transient
 * window above into a long one. Prefer 0 here.
 */
type ConsumeWhen = (c: Context) => boolean | Promise<boolean>;

/**
 * Media types Better-Auth accepts on a given path, which this middleware must
 * match EXACTLY — see `readEmail` for why both directions of a mismatch hurt.
 *
 * better-call resolves `handler.options.metadata?.allowedMediaTypes ||
 * config?.allowedMediaTypes` (`better-call/dist/router.mjs:61`). Better-Auth
 * sets a global `allowedMediaTypes: ["application/json"]`
 * (`better-auth/dist/api/index.mjs:161`), so JSON-only is the default for most
 * routes. TWO routes widen it to also accept form-urlencoded, and both are
 * metered here: `/sign-up/email` (`sign-up.mjs:28`) and `/sign-in/email`
 * (`sign-in.mjs:155`). Getting this wrong in the restrictive direction is not
 * cosmetic — this middleware returns its own 415 for a media type it does not
 * expect, so under-declaring turns a legitimate form post into a hard failure
 * before Better-Auth ever sees it.
 *
 * Note multipart is accepted by NO route here, which is why we never parse it.
 */
const JSON_ONLY = ["application/json"] as const;
export const FORM_OR_JSON_MEDIA_TYPES = [
  "application/x-www-form-urlencoded",
  "application/json",
] as const;

/** Immediate mode: a point per request that names a recipient. No refunds. */
export function emailRecipientLimit(
  limiter?: RecipientLimiter,
  allowedMediaTypes?: readonly string[],
): MiddlewareHandler;
/** Deferred mode: reserve then refund — requires a limiter that can refund. */
export function emailRecipientLimit(
  limiter: RefundableLimiter,
  allowedMediaTypes: readonly string[],
  consumeWhen: ConsumeWhen,
): MiddlewareHandler;
export function emailRecipientLimit(
  limiter: RecipientLimiter = emailRecipientLimiter,
  allowedMediaTypes: readonly string[] = JSON_ONLY,
  consumeWhen?: ConsumeWhen,
) {
  return async (c: Context, next: Next) => {
    // Disabled → no Redis round-trip at all.
    if (limiter.points <= 0) return next();

    // No body at all: better-call returns early before it ever looks at the
    // media type, so Better-Auth answers with its own 400 validation error.
    // Mirror that — a bodyless POST names no recipient and must not 415.
    if (!c.req.raw.body) return next();

    const parsed = await readEmail(c, allowedMediaTypes);
    // A media type Better-Auth would refuse. It answers 415 here itself
    // (`better-call/dist/utils.mjs:19`), so returning 415 changes nothing the
    // caller sees — it just means we never consume a point for a request that
    // was never going to send mail.
    if (parsed.kind === "unsupported") {
      return c.json({ error: "Unsupported content type." }, 415);
    }
    // Parsed fine but carries no usable `email`: let Better-Auth return its own
    // validation error. Consuming a point for a well-formed request that names
    // no recipient would let a malformed-request flood burn a real address's
    // budget without ever mailing anyone.
    if (!parsed.email) return next();
    const email = parsed.email;
    const key = emailRateLimitKey(email);

    const tooMany = () =>
      c.json({ error: "Too many emails requested for this address. Please try again later." }, 429);

    // Deferred mode: reserve a point BEFORE the handler sends mail, then refund
    // it unless the handler actually did. This must be an atomic `consume`, not
    // a `get` followed by a post-hoc consume: concurrent requests can all see a
    // spare point, all send mail, and only then discover the cap. A reservation
    // is the only way to bound sends across replicas.
    //
    // A verified or failed sign-in leaves no lasting charge. It does hold the
    // reservation for the length of the handler, which on a password check is
    // not free — see `ConsumeWhen` for the concurrency window that opens and why
    // it is accepted rather than traded for a post-hoc consume.
    if (consumeWhen) {
      let reserved = false;
      try {
        await limiter.consume(key);
        reserved = true;
      } catch (result: unknown) {
        if (result instanceof RateLimiterRes) {
          c.header("Retry-After", String(Math.ceil(result.msBeforeNext / 1000)));
          return tooMany();
        }
        // Same fail-OPEN reasoning as below. Do not attempt a refund when the
        // reservation never succeeded.
        logInternalError("rate-limit.store", result, {
          limiter: "email-recipient",
          mode: "fail-open",
        });
      }

      // `finally`, so a throw from downstream cannot strand the reservation.
      // Hono's outer `onError` turns such a throw into a response without ever
      // returning here, and the point would then sit in a real user's bucket
      // until the window lapsed. On a throw there is no response to inspect, so
      // `consumeWhen` is not consulted and the point is simply refunded.
      let mailed = false;
      try {
        await next();
        mailed = await consumeWhen(c);
      } finally {
        if (reserved && !mailed) {
          // `reward` is the paired atomic operation from rate-limiter-flexible.
          // If Redis fails here the point expires with the normal window, the
          // safe direction for a limiter guarding a mailer.
          //
          // try/catch rather than `.catch()` alone: this runs in a `finally`, so
          // a SYNCHRONOUS throw from `reward` would replace the exception
          // `next()` raised — turning a real downstream error into a confusing
          // rate-limiter one. `.catch()` only covers the rejection case.
          try {
            await limiter.reward?.(key);
          } catch (err: unknown) {
            logInternalError("rate-limit.refund", err, { limiter: "email-recipient" });
          }
        }
      }
      return;
    }

    try {
      await limiter.consume(key);
    } catch (result: unknown) {
      if (result instanceof RateLimiterRes) {
        const retryAfter = Math.ceil(result.msBeforeNext / 1000);
        c.header("Retry-After", String(retryAfter));
        return tooMany();
      }
      // Redis unavailable → fail OPEN. The fail-closed IP limiter still guards
      // this route, so the endpoint is never left completely unthrottled, and
      // 503ing here would block legitimate password resets during a blip.
      logInternalError("rate-limit.store", result, {
        limiter: "email-recipient",
        mode: "fail-open",
      });
    }

    return next();
  };
}

type ParsedRecipient =
  /** Body understood; `email` is the recipient if the body named a usable one. */
  | { kind: "parsed"; email: string | null }
  /** Body in a format we do not decode — cannot be rate limited, so refuse it. */
  | { kind: "unsupported" };

/** better-call's JSON test, verbatim (`better-call/dist/utils.mjs:4`). */
const JSON_CONTENT_TYPE_RE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * Pull `email` out of the request body without consuming the request stream.
 *
 * `.clone()` is load-bearing: the auth handler is invoked as
 * `auth.handler(c.req.raw)` further down the chain, and reading the original
 * body here would hand it a spent stream. Same pattern as the ADMIN_EMAIL
 * bootstrap middleware in index.ts.
 *
 * This MUST classify a request exactly as better-call does, because BOTH
 * directions of a mismatch are bugs:
 *
 *   - Too permissive → we consume a point for a request Better-Auth then
 *     rejects. No mail is sent, but the victim's budget is spent anyway: an
 *     attacker could exhaust a real user's password-reset allowance without
 *     ever delivering a message.
 *   - Too restrictive → we skip a request Better-Auth goes on to honour. That
 *     is a full bypass of this limiter, i.e. the rotating-IP mail cannon.
 *
 * The second is how the earlier JSON-only version failed on `/sign-up/email`.
 *
 * The subtlety is that better-call applies THREE different tests, and mixing
 * them up reopens the bypass in one direction or the other:
 *
 *   - The 415 ACCEPTANCE gate matches on the media type's BASE
 *     (`normalizedContentType.split(";")[0].trim()`, `utils.mjs:11`).
 *   - The JSON test runs an ANCHORED regex over the FULL header (`utils.mjs:25`).
 *   - The urlencoded test runs `includes()` over the FULL header (`utils.mjs:34`).
 *
 * Anchoring is what makes the full-header JSON test safe. A loose `includes()`
 * there would reopen the bypass through a parameter:
 *
 *     Content-Type: application/x-www-form-urlencoded; charset="application/json"
 *
 * — a substring check sees "application/json", tries `.json()`, fails, and waves
 * the request through, while Better-Auth parses the form body and sends the mail.
 * The anchored regex correctly declines to match that header, and the urlencoded
 * branch below then handles it, exactly as better-call does.
 *
 * The urlencoded branch uses `includes()` on the full header purely to mirror
 * better-call. It is NOT load-bearing for security. The asymmetry between the two
 * branches reads like a bypass, so the reasoning is recorded here:
 *
 *     Content-Type: application/x-www-form-urlencodedx
 *
 * — this passes the acceptance gate (whose own `includes()` is on the base), fails
 * the anchored JSON regex, and reaches the urlencoded branch. A strict
 * `base === "application/x-www-form-urlencoded"` would NOT match it, so the request
 * would fall through to "no recipient" and consume no point. That looks like a free
 * signup flood — but it isn't, because `Request.formData()` rejects any body whose
 * MIME *essence* is not exactly `application/x-www-form-urlencoded` or
 * `multipart/form-data`. Better-call calls the very same `request.formData()`, and
 * its urlencoded branch has no try/catch, so that header throws there too and no
 * mail is ever sent. Every header that CLEARS THE ACCEPTANCE GATE and on which
 * strict-base and loose-full disagree is a header `formData()` refuses; every such
 * header `formData()` accepts has an essence the strict check already matched. The
 * two are therefore equivalent in outcome.
 *
 * The acceptance-gate qualifier is load-bearing, not throat-clearing. Without it
 * the claim is false — `multipart/form-data; boundary=application/x-www-form-urlencoded`
 * has a base of `multipart/form-data` (strict fails), contains the urlencoded
 * substring (loose matches), and `formData()` parses it happily. It is harmless
 * only because the gate 415s it first: the base contains neither allowed media
 * type. So the equivalence holds for the paths this middleware is mounted on, and
 * would NOT survive someone widening `allowedMediaTypes` to include multipart.
 * If that ever happens, parse multipart here too rather than reasoning again.
 *
 * Mirroring better-call exactly is still the right call — it removes a class of
 * divergence that only stays harmless as long as `formData()` keeps refusing those
 * essences — but do not read this branch as the thing standing between you and a
 * mail cannon. The acceptance gate and `signupRecipientLimiter` are.
 *
 * So: split for the acceptance gate, but match the FULL header for both parse
 * branches, with better-call's own anchored regex and `includes()`, in its order.
 *
 * Exported because `signin-failure-limit.ts` needs the SAME exact
 * classification on `/sign-in/email` (which accepts form-urlencoded as well as
 * JSON): the failure counter must see every encoding Better-Auth will, or an
 * attacker switches encoding and the per-account ceiling evaporates.
 */
export async function readEmail(
  c: Context,
  allowedMediaTypes: readonly string[],
): Promise<ParsedRecipient> {
  const header = c.req.header("content-type")?.toLowerCase() ?? "";
  const base = header.split(";")[0]?.trim() ?? "";

  // Same acceptance test better-call applies before it parses anything.
  const allowed = allowedMediaTypes.some((type) => {
    const normalized = type.toLowerCase().trim();
    return base === normalized || base.includes(normalized);
  });
  if (!allowed) return { kind: "unsupported" };

  const pick = (value: unknown): ParsedRecipient => ({
    kind: "parsed",
    email: typeof value === "string" && value.trim() !== "" ? value : null,
  });

  try {
    // Both tests run against the FULL normalized header, not `base` — see the
    // doc comment above. `utils.mjs:25` and `utils.mjs:34`, in better-call's order.
    if (JSON_CONTENT_TYPE_RE.test(header)) {
      const body = (await c.req.raw.clone().json()) as { email?: unknown };
      return pick(body?.email);
    }
    if (header.includes("application/x-www-form-urlencoded")) {
      const form = await c.req.raw.clone().formData();
      return pick(form.get("email")?.toString());
    }
  } catch {
    // Allowed media type, unparseable payload. Better-Auth rejects this too
    // (better-call raises 400 on invalid JSON), so treat it as a request that
    // named no recipient and let Better-Auth produce the error message.
    return { kind: "parsed", email: null };
  }

  // Allowed by config but not a shape we decode. Unreachable today; treat it as
  // "no recipient" rather than 415, since Better-Auth WILL process it and a
  // 415 here would break a route the config deliberately opened up.
  return { kind: "parsed", email: null };
}
