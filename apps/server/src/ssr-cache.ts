import { SUPPORTED_LOCALES } from "@knowledge-base/config/locales";
import { env } from "@knowledge-base/env/server";
import { PUBLIC_PATHS } from "./seo.js";

/**
 * Bounded in-memory LRU cache of server-rendered HTML for public pages.
 *
 * Public SSR output (the `$lang/_public/**` branch) is a pure function of
 * (pathname, locale-in-path): the public nav always renders logged-out, theme
 * is applied client-side. So an
 * anonymous GET of a public page can be replayed verbatim to the next anonymous
 * visitor — except the CSP nonce, which secureHeaders mints fresh per request.
 * We store the nonce that was live at render time and swap it for the current
 * request's nonce on every hit so the cached inline hydration scripts match the
 * live `script-src 'nonce-…'` header.
 *
 * Invalidation is TTL-only (SSR_CACHE_TTL_SECONDS, default 60s; 0 disables).
 * A mutation that changes public content could call `clear()` to drop the
 * cache immediately instead of waiting out the TTL — that hook is
 * intentionally not wired up here.
 */

type CacheEntry = {
  html: string;
  /** The CSP nonce that was current when this HTML was rendered. */
  nonce: string;
  /** Response Content-Type to replay. */
  contentType: string;
  /** Response Content-Language to replay, if the render set one. */
  contentLanguage: string | null;
  /** Absolute epoch-ms after which this entry is stale. */
  expiresAt: number;
};

const MAX_ENTRIES = 200;

// Insertion order is recency order: Map preserves insertion order, so the first
// key is the least-recently-used. `get` re-inserts on hit; `set` evicts the
// oldest on overflow.
const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Pure LRU primitives (unit-testable without booting the server)
// ---------------------------------------------------------------------------

export function get(key: string, now: number = Date.now()): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  // Bump recency: delete + re-insert moves the key to the newest position.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function set(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clear(): void {
  cache.clear();
}

/** Current entry count — for tests/observability. */
export function size(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// Cacheability helpers
// ---------------------------------------------------------------------------

// The full set of eligible pathnames: locale × PUBLIC_PATHS. PUBLIC_PATHS
// entries are locale-less templates (`""` is the locale root, matching how
// seo.ts expands them), so the home path for locale `en-US` is `/en-US`.
const PUBLIC_SSR_PATHS: Set<string> = new Set(
  SUPPORTED_LOCALES.flatMap((locale) => PUBLIC_PATHS.map((p) => `/${locale}${p.path}`)),
);

/** Drop a single trailing slash (but never reduce the root to ""). */
function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

/** True when the pathname corresponds to some (locale × PUBLIC_PATHS) page. */
export function isPublicSsrPath(pathname: string): boolean {
  return PUBLIC_SSR_PATHS.has(normalizePathname(pathname));
}

/**
 * True when the Cookie header carries anything that looks like a Better-Auth
 * session cookie. Substring match on the whole header — deliberately
 * over-matching (e.g. `__Secure-better-auth.session_token`), because a false
 * positive only bypasses the cache (the safe direction), never leaks a session.
 */
export function hasAuthSessionCookie(cookieHeader: string | null): boolean {
  return cookieHeader?.includes("better-auth") ?? false;
}

/**
 * A request is cache-eligible only if ALL hold: TTL > 0, method GET, empty
 * querystring, no auth-session cookie, and the pathname is a public SSR page.
 */
export function isCacheableRequest(request: Request, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) return false;
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.search !== "") return false;
  if (hasAuthSessionCookie(request.headers.get("cookie"))) return false;
  return isPublicSsrPath(url.pathname);
}

// ---------------------------------------------------------------------------
// Integration wrapper (kept thin so the index.ts glue is obviously correct)
// ---------------------------------------------------------------------------

export type SsrCacheDeps = {
  /** The incoming request (already carrying the x-csp-nonce header, if any). */
  request: Request;
  /** The per-request CSP nonce minted by secureHeaders, or undefined. */
  nonce: string | undefined;
  /** The underlying SSR renderer (TanStack Start's `startHandler.fetch`). */
  render: (request: Request) => Promise<Response>;
  /** Clock injection point for tests. */
  now?: () => number;
};

/**
 * Serve an eligible public SSR request from cache when possible, otherwise
 * render and (conditionally) populate the cache. Ineligible requests flow
 * straight through to `render` with no added headers.
 */
export async function handleSsrRequest({
  request,
  nonce,
  render,
  now = Date.now,
}: SsrCacheDeps): Promise<Response> {
  if (!isCacheableRequest(request, env.SSR_CACHE_TTL_SECONDS)) {
    return render(request);
  }

  const key = normalizePathname(new URL(request.url).pathname);
  const currentTime = now();

  const hit = get(key, currentTime);
  if (hit) {
    // Swap the render-time nonce for this request's nonce so the cached inline
    // hydration scripts match the freshly-minted CSP header. Guard against an
    // empty stored nonce (replaceAll("", …) would corrupt the body).
    const html = nonce && hit.nonce ? hit.html.replaceAll(hit.nonce, nonce) : hit.html;
    // Deliberate header WHITELIST: a hit replays only Content-Type and
    // Content-Language. Anything else the renderer might set (Link preloads,
    // Vary, …) is dropped — replaying arbitrary stored headers risks leaking
    // per-request state, and the public shell sets none we care about today.
    // Revisit the whitelist if the renderer starts emitting perf headers.
    const headers = new Headers({ "Content-Type": hit.contentType, "X-SSR-Cache": "hit" });
    if (hit.contentLanguage) headers.set("Content-Language", hit.contentLanguage);
    // Deliberately no Cache-Control and no CSP here: the outer secureHeaders
    // middleware applies the per-request CSP as this response flows back out.
    return new Response(html, { status: 200, headers });
  }

  const res = await render(request);
  const contentType = res.headers.get("content-type") ?? "";
  // The body is a one-shot stream; read it now and rebuild the Response below.
  const html = await res.text();

  // Only cache a clean, anonymous, fully-rendered HTML page. A Set-Cookie means
  // the render leaked per-user state — never replay that to another visitor.
  const storeable =
    res.status === 200 && contentType.includes("text/html") && !res.headers.has("set-cookie");
  if (storeable) {
    set(key, {
      html,
      nonce: nonce ?? "",
      contentType,
      contentLanguage: res.headers.get("content-language"),
      expiresAt: currentTime + env.SSR_CACHE_TTL_SECONDS * 1000,
    });
  }

  const headers = new Headers(res.headers);
  headers.set("X-SSR-Cache", "miss");
  return new Response(html, { status: res.status, headers });
}
