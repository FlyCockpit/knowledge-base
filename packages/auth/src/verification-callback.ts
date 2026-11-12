import { DEFAULT_LOCALE, isSupportedLocale } from "@knowledge-base/config/locales";

/**
 * Where the emailed verification link lands the user after Better-Auth has
 * validated the token server-side.
 *
 * Better-Auth builds the emailed URL as
 * `${baseURL}/verify-email?token=<jwt>&callbackURL=<encoded>` and, in its
 * `/verify-email` handler, 302s to that `callbackURL` — bare on success, or
 * with `?error=<CODE>` appended (`TOKEN_EXPIRED`, `INVALID_TOKEN`,
 * `USER_NOT_FOUND`) when the token doesn't check out. Without a `callbackURL`
 * the caller-supplied default is `/`, which dumps a freshly-verified user on
 * the marketing home page with no confirmation that anything happened.
 *
 * We rewrite it here rather than passing `callbackURL` from each caller so
 * every path that mails a verification link — signup, the resend endpoint, a
 * future admin-triggered re-send — lands on the same page without having to
 * remember to opt in.
 *
 * The destination carries an explicit `?ok=1` marker. Absence of `?error=` is
 * NOT a usable success signal on its own: `/$lang/verify-email` is an
 * unguarded, directly-navigable route, so a bare visit (bookmark, back button,
 * a guard redirect for an unverified user) would otherwise render as
 * "verified". Better-Auth appends its failure code with `&` when the
 * callbackURL already has a query string, so `?ok=1&error=TOKEN_EXPIRED` is
 * the shape of a failed hop — the page treats any `error` as authoritative.
 *
 * A caller-supplied `callbackURL` is preserved *if it is safe*. Better-Auth
 * routes the change-email confirmation chain through this same hook and
 * re-encodes the pending `callbackURL` into a second-hop token URL; clobbering
 * it would strand that flow on the signup confirmation page. But that value is
 * also attacker-reachable — `POST /api/auth/send-verification-email` accepts a
 * `callbackURL` in its body — so anything that isn't a same-origin relative
 * path or an explicitly allowed origin is discarded in favour of the default.
 * Better-Auth applies its own `originCheck` on top of this; the check here is
 * deliberately redundant so a regression upstream, or a wildcard added to
 * `trustedOrigins`, can't turn a verification email into an open redirect.
 *
 * `appOrigin` is where the *web app* lives, which is not always where this API
 * lives. Better-Auth resolves a relative `callbackURL` against the API host, so
 * on a split-origin deploy (`CORS_ORIGIN` set — api.example.com serving
 * example.com) a relative path would land the user on the API hostname: wrong
 * cookie scope, wrong canonical URL, and a route the API doesn't serve. Pass
 * the web origin there and the callback is emitted absolute. Omit it for a
 * same-origin deploy and the callback stays relative, as before.
 *
 * The path is built from a locale we narrow ourselves against
 * `SUPPORTED_LOCALES`, never from user input.
 */
export function withVerificationCallback(url: string, locale: unknown, appOrigin?: string): string {
  const tag = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  try {
    const parsed = new URL(url);
    const fallback = buildCallback(tag, appOrigin);
    const existing = parsed.searchParams.get("callbackURL");
    if (existing && existing !== "/" && isSafeCallback(existing, appOrigin, parsed.origin)) {
      // Preserve it — but resolve a *relative* value against the web origin for
      // the same reason `buildCallback` does. Better-Auth resolves a relative
      // callbackURL against the API host, so on a split-origin deploy leaving
      // it alone strands the user on api.example.com: wrong cookie scope, and a
      // route the API doesn't serve. Absolute values already named an origin
      // `isSafeCallback` vetted, so they pass through untouched.
      parsed.searchParams.set("callbackURL", absolutize(existing, appOrigin));
      return parsed.toString();
    }
    parsed.searchParams.set("callbackURL", fallback);
    return parsed.toString();
  } catch {
    // Better-Auth always hands us an absolute URL built from `baseURL`, so this
    // is unreachable in practice. Returning the original keeps a malformed URL
    // from turning a verification email into a hard send failure.
    return url;
  }
}

function buildCallback(tag: string, appOrigin?: string): string {
  return absolutize(`/${tag}/verify-email?ok=1`, appOrigin);
}

/**
 * Resolve a relative path against the web app's origin, when one is configured.
 * Absolute inputs and same-origin deploys (no `appOrigin`) are returned as-is.
 */
function absolutize(path: string, appOrigin?: string): string {
  if (!appOrigin || !path.startsWith("/")) return path;
  try {
    return new URL(path, appOrigin).toString();
  } catch {
    return path;
  }
}

/**
 * Same shape Better-Auth's `matchesOriginPattern` accepts for a relative
 * callback: a single leading slash, no protocol-relative `//` or `/\` escape,
 * no encoded slash, and no `:` or `#` that could smuggle a scheme or fragment.
 */
const SAFE_RELATIVE_PATH = /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/i;

function isSafeCallback(value: string, appOrigin: string | undefined, apiOrigin: string): boolean {
  if (SAFE_RELATIVE_PATH.test(value)) return true;
  // An absolute URL is only kept when it points at an origin we actually own.
  try {
    const target = new URL(value);
    return (
      target.origin === apiOrigin || (!!appOrigin && target.origin === new URL(appOrigin).origin)
    );
  } catch {
    return false;
  }
}
