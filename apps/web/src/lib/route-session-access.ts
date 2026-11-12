import { isAdminRole } from "@knowledge-base/auth/roles";

type RouteSessionUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role?: string | null;
  twoFactorEnabled?: boolean | null;
  /**
   * `User.createdAt` as epoch milliseconds (`null` when unreadable). Carried
   * as a number, not a `Date`, because this projection crosses the
   * `createServerFn` serialization boundary. The forced-2FA enrollment grace
   * window is measured from it — see `apps/web/src/utils/two-factor-policy.ts`.
   */
  createdAt: number | null;
  /**
   * `User.twoFactorGraceStartedAt` as epoch milliseconds: when forced 2FA
   * first applied (promotion, policy turned on). `null` → grace from `createdAt`.
   */
  twoFactorGraceStartedAt?: number | null;
};

export type RouteSession = {
  user: RouteSessionUser;
};

export type RouteSessionResolution =
  | { status: "resolved"; session: RouteSession | null }
  | { status: "error" };

export type ProtectedRouteDecision =
  | { kind: "allow"; session: RouteSession }
  | { kind: "redirect-to-login" }
  | { kind: "error" };

export type AnonymousOnlyRouteDecision =
  | { kind: "allow" }
  | { kind: "redirect-authenticated"; session: RouteSession }
  | { kind: "error" };

export type AdminRouteDecision =
  | { kind: "allow"; session: RouteSession }
  | { kind: "not-found" }
  | { kind: "error" };

export function resolvedRouteSession(session: RouteSession | null): RouteSessionResolution {
  return { status: "resolved", session };
}

export function failedRouteSessionResolution(): RouteSessionResolution {
  return { status: "error" };
}

/**
 * Gate for the ordinary authenticated app (`_auth`: dashboard, settings).
 *
 * Deliberately checks only "is there a session" — NOT `emailVerified`, which
 * the admin guard below does check. That asymmetry is the template's
 * stance, not an oversight: **verification gates privilege escalation, not
 * basic use.** It mirrors the server, which is where the real boundary lives —
 * `protectedProcedure` has no verification check either, only `requireAdmin` /
 * `requireAdminOr404` does (`packages/api/src/index.ts`).
 * A guard here is UX; adding a check the procedures don't enforce would be
 * theater.
 *
 * Unverified sessions are reachable in practice, so this is load-bearing:
 * `requireEmailVerification` only governs email/password sign-in. SSO users are
 * created with whatever their IdP asserts in `email_verified`, defaulting to
 * `false` when the provider omits the claim (Entra ID, notably — Google, Okta,
 * and Keycloak do send it). Requiring verification here would lock every SSO
 * user out of the whole app on those providers.
 *
 * If your product genuinely requires verification for all access, do NOT just
 * add the check — returning `redirect-to-login` for an unverified session
 * bounces off `decideAnonymousOnlyRouteAccess` (which redirects any
 * authenticated visitor back) and loops forever.
 */
export function decideProtectedRouteAccess(
  resolution: RouteSessionResolution,
): ProtectedRouteDecision {
  if (resolution.status === "error") return { kind: "error" };
  if (!resolution.session) return { kind: "redirect-to-login" };
  return { kind: "allow", session: resolution.session };
}

export function decideAnonymousOnlyRouteAccess(
  resolution: RouteSessionResolution,
): AnonymousOnlyRouteDecision {
  if (resolution.status === "error") return { kind: "error" };
  if (!resolution.session) return { kind: "allow" };
  return { kind: "redirect-authenticated", session: resolution.session };
}

export function decideAdminRouteAccess(resolution: RouteSessionResolution): AdminRouteDecision {
  if (resolution.status === "error") return { kind: "error" };
  const user = resolution.session?.user;
  if (!resolution.session || !user?.emailVerified || !isAdminRole(user.role)) {
    return { kind: "not-found" };
  }
  return { kind: "allow", session: resolution.session };
}
