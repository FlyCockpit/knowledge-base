import { describe, expect, it } from "vitest";

import {
  decideAdminRouteAccess,
  decideAnonymousOnlyRouteAccess,
  decideProtectedRouteAccess,
  failedRouteSessionResolution,
  type RouteSession,
  resolvedRouteSession,
} from "./route-session-access";

const baseSession: RouteSession = {
  user: {
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    emailVerified: true,
    role: "user",
    twoFactorEnabled: false,
    createdAt: Date.UTC(2026, 0, 1),
  },
};

function sessionWith(overrides: Partial<RouteSession["user"]>): RouteSession {
  return { user: { ...baseSession.user, ...overrides } };
}

describe("route session access decisions", () => {
  it("allows protected routes for authenticated sessions", () => {
    expect(decideProtectedRouteAccess(resolvedRouteSession(baseSession))).toEqual({
      kind: "allow",
      session: baseSession,
    });
  });

  // Pins the asymmetry documented on `decideProtectedRouteAccess`: the ordinary
  // app admits unverified sessions, the privileged surface below does not. This
  // is not an oversight to tidy up — SSO users arrive unverified whenever their
  // IdP omits `email_verified`, and it mirrors `protectedProcedure`, which has
  // no verification check either. Making this fail means changing a product
  // decision (and needing a verify-email interstitial to avoid a redirect
  // loop), so change the guard and this test together, deliberately.
  it("admits unverified sessions to the ordinary app, unlike the privileged guard", () => {
    const unverified = sessionWith({ emailVerified: false });

    expect(decideProtectedRouteAccess(resolvedRouteSession(unverified))).toEqual({
      kind: "allow",
      session: unverified,
    });
    expect(decideAdminRouteAccess(resolvedRouteSession(unverified))).toEqual({
      kind: "not-found",
    });
  });

  it("redirects confirmed anonymous protected users to login", () => {
    expect(decideProtectedRouteAccess(resolvedRouteSession(null))).toEqual({
      kind: "redirect-to-login",
    });
  });

  it("keeps route-session resolution failures distinct from anonymous users", () => {
    expect(decideProtectedRouteAccess(failedRouteSessionResolution())).toEqual({ kind: "error" });
    expect(decideAdminRouteAccess(failedRouteSessionResolution())).toEqual({ kind: "error" });
    expect(decideAnonymousOnlyRouteAccess(failedRouteSessionResolution())).toEqual({
      kind: "error",
    });
  });

  it("keeps logged-out-only routes available only to confirmed anonymous users", () => {
    expect(decideAnonymousOnlyRouteAccess(resolvedRouteSession(null))).toEqual({ kind: "allow" });
    expect(decideAnonymousOnlyRouteAccess(resolvedRouteSession(baseSession))).toEqual({
      kind: "redirect-authenticated",
      session: baseSession,
    });
  });

  it("allows verified admin sessions through the admin tree", () => {
    const admin = sessionWith({ role: "admin", emailVerified: true });

    expect(decideAdminRouteAccess(resolvedRouteSession(admin))).toEqual({
      kind: "allow",
      session: admin,
    });
  });

  it("404-hides confirmed anonymous, unverified, and non-admin admin attempts", () => {
    expect(decideAdminRouteAccess(resolvedRouteSession(null))).toEqual({ kind: "not-found" });
    expect(
      decideAdminRouteAccess(
        resolvedRouteSession(sessionWith({ role: "admin", emailVerified: false })),
      ),
    ).toEqual({ kind: "not-found" });
    expect(decideAdminRouteAccess(resolvedRouteSession(baseSession))).toEqual({
      kind: "not-found",
    });
  });
});
