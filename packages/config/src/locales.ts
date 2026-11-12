/**
 * Shared locale constants. Imported by both the web app's i18n config and the
 * API package's auth router so the two stay in lockstep. Adding a locale is a
 * single edit here.
 *
 * Adding a locale:
 *   1. Append the BCP 47 tag to `SUPPORTED_LOCALES`.
 *   2. Drop matching translation JSON files into `packages/locales/src/<tag>/`.
 *
 * No DB migration is required — `User.locale` is a free-form String column,
 * validated at the API boundary by this list.
 */
export const SUPPORTED_LOCALES = ["en-US", "es-MX"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en-US";

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Request header carrying the locale the client is actually rendering.
 *
 * Set by the Better-Auth client (`apps/web/src/lib/auth-client.ts`) on every
 * auth request, read by the user-create hook in `packages/auth/src/index.ts` to
 * seed `User.locale`, and — the part that is easy to forget — listed in the
 * server's CORS `allowHeaders` (`apps/server/src/index.ts`).
 *
 * It lives here as a constant because that third site is invisible in local
 * development: the CORS middleware only mounts when `CORS_ORIGIN` is set, and
 * `pnpm dev` proxies the API same-origin through Vite. A custom header missing
 * from `allowHeaders` fails preflight and blocks *every* auth request, but only
 * on a split-origin production deploy. Adding another client-set header means
 * adding it to `allowHeaders` too — see security-headers.test.ts.
 */
export const APP_LOCALE_HEADER = "x-app-locale";

/**
 * Internal request header carrying the configured canonical app origin
 * (`BETTER_AUTH_URL`) from the API server to the SSR renderer, for the public
 * home page's localized canonical/hreflang/og URLs. Set only by the server
 * (client-supplied values are stripped, apps/server/src/index.ts) so those
 * URLs never reflect a spoofed Host or X-Forwarded-* header.
 */
export const CANONICAL_ORIGIN_HEADER = "x-canonical-origin";

/**
 * Chunk-name prefix for a non-default locale's grouped UI bundle.
 *
 * Two places consume this and they must agree, so neither hardcodes the string:
 *   - `apps/web/vite.config.ts` names the `manualChunks` group
 *     `${LOCALE_CHUNK_PREFIX}${locale}`, collapsing every namespace JSON for one
 *     locale into a single chunk (one request per locale, not one per
 *     namespace).
 *   - `apps/server/src/locale-modulepreload.ts` finds that chunk in the client
 *     Vite manifest to emit the SSR `<link rel="modulepreload">`.
 *
 * Vite keys manual chunks by emitted filename, not source path, so the server
 * has nothing but this name to match on. A drift here doesn't break the page —
 * it silently drops the preload hint — which is exactly why the constant is
 * shared rather than repeated.
 */
export const LOCALE_CHUNK_PREFIX = "locale-";

/**
 * True only for a same-origin, hashed `/assets/….js` path.
 *
 * The locale modulepreload URL travels from the client Vite manifest, through
 * an internal request header, into an SSR `<link rel="modulepreload">` in the
 * HTML head. Both ends validate it — `apps/server/src/locale-modulepreload.ts`
 * when reading the manifest, `apps/web/src/router.tsx` when reading the header —
 * so a corrupted manifest or a header that somehow bypassed the strip/set path
 * can never put an off-origin (or non-script) URL in the head. Two checks, one
 * definition: the halves live in different packages and would otherwise drift.
 *
 * Rejects protocol-relative (`//host/x.js`), absolute (`https://…`), traversal
 * (`/assets/../x`), empty-segment, and non-`.js` values.
 */
export function isSafeAssetScriptPath(href: string): boolean {
  // Each segment: alphanumeric start, then content-hash-safe punctuation. Note
  // rolldown hashes use a base64url alphabet, so `-` and `_` are expected here.
  return /^\/assets(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+\.js$/.test(href);
}
