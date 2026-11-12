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
