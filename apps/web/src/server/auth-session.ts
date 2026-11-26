import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import {
  failedRouteSessionResolution,
  type RouteSession,
  type RouteSessionResolution,
  resolvedRouteSession,
} from "@/lib/route-session-access";

type BetterAuthRouteSession = {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    role?: string | null;
    twoFactorEnabled?: boolean | null;
    createdAt?: Date | string | number | null;
    twoFactorGraceStartedAt?: Date | string | number | null;
  };
};

type GetBetterAuthSession = (context: {
  headers: Headers;
}) => Promise<BetterAuthRouteSession | null>;

/**
 * Server-backed session probe for TanStack route guards.
 *
 * The app branch remains client-rendered, but route access decisions call this
 * server function so navigation uses the canonical Better Auth instance and
 * request cookies instead of browser-side session probes. It resolves to a
 * {@link RouteSessionResolution} — a lookup failure becomes an `error`
 * resolution the pure access decisions turn into a retryable route error,
 * never a silent logout or fake 404. The returned projection omits
 * token-bearing session fields; operations still authorize independently at
 * the oRPC/Hono boundary.
 */
export const getRouteSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<RouteSessionResolution> => {
    const { auth } = await import("@knowledge-base/auth");
    return resolveRouteSessionFromAuth(getRequestHeaders(), auth.api.getSession);
  },
);

/**
 * Better-Auth's session cookie names: `PREFIX.session_token`, with
 * `__Secure-` added when cookies are secure. The prefix is Better-Auth's
 * default because this app sets no `advanced.cookiePrefix`
 * (packages/auth/src/index.ts) — if you set one, update this list along with
 * `apps/server/src/ssr-cache.ts` and `apps/server/src/two-factor-otp-limit.ts`.
 */
const SESSION_TOKEN_COOKIES = new Set([
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
]);

/**
 * True when the Cookie header carries a non-empty Better-Auth session token.
 * Presence only — the token is never read for meaning or validated here.
 */
export function hasSessionTokenCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((pair) => {
    const eq = pair.indexOf("=");
    if (eq === -1) return false;
    return SESSION_TOKEN_COOKIES.has(pair.slice(0, eq).trim()) && pair.slice(eq + 1).trim() !== "";
  });
}

/**
 * Cheap "is this visitor probably signed in?" hint for public pages.
 *
 * It checks only whether the session cookie exists: no database lookup, and
 * no Better-Auth import on the public render path. That makes it a hint for
 * where to send someone, and **never** an access check. A stale or forged
 * cookie just sends the visitor to the signed-in home, whose `_auth` gate does
 * the real check and sends them to login. Do not use this to show or hide
 * data; use {@link getRouteSession} or a procedure for that.
 *
 * Cache safety: `apps/server/src/ssr-cache.ts` never caches a request that
 * carries a Better-Auth cookie, and only stores 200 responses without
 * Set-Cookie, so a redirect based on this hint is never replayed to an
 * anonymous visitor.
 */
export const getSessionCookieHint = createServerFn({ method: "GET" }).handler(
  async (): Promise<boolean> => hasSessionTokenCookie(getRequestHeaders().get("cookie")),
);

export async function resolveRouteSessionFromAuth(
  headers: Headers,
  getSession: GetBetterAuthSession,
): Promise<RouteSessionResolution> {
  try {
    const session = await getSession({ headers });
    return resolvedRouteSession(toRouteSession(session));
  } catch {
    return failedRouteSessionResolution();
  }
}

export function toRouteSession(session: BetterAuthRouteSession | null): RouteSession | null {
  if (!session) return null;

  return {
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      role: session.user.role,
      twoFactorEnabled: session.user.twoFactorEnabled,
      createdAt: toEpochMs(session.user.createdAt),
      twoFactorGraceStartedAt: toEpochMs(session.user.twoFactorGraceStartedAt),
    },
  };
}

/**
 * Normalize `User.createdAt` to epoch milliseconds so the projection survives
 * `createServerFn` serialization. An unreadable value becomes `null`, which
 * the forced-2FA grace window treats as "no grace" (fail closed).
 */
function toEpochMs(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
