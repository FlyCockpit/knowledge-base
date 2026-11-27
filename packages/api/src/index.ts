import { isUserBanned } from "@knowledge-base/auth/ban";
import { isAdminRole, isImpersonatedSession } from "@knowledge-base/auth/roles";
import { readLiveAdminPolicy } from "@knowledge-base/auth/session-authority";
import prisma from "@knowledge-base/db";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { ORPCError, os } from "@orpc/server";
import type { Context } from "./context";
import { mapUserChangeConflict } from "./lib/admin-presence";
import {
  invalidateForceTwoFactorSettingsCache,
  isTwoFactorPolicySatisfied,
} from "./lib/two-factor-policy";

export {
  invalidateForceTwoFactorSettingsCache,
  isForcedTwoFactorEnabledForRole,
  isTwoFactorPolicySatisfied,
} from "./lib/two-factor-policy";

const o = os.$context<Context>();

export const publicProcedure = o;

const requireAuth = o.middleware(async ({ context, next }) => {
  if (
    !context.session?.user ||
    isImpersonatedSession(context.session) ||
    isUserBanned(context.session.user)
  ) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const authenticatedProcedure = publicProcedure.use(requireAuth);

const requireRequiredTwoFactor = o.middleware(async ({ context, next }) => {
  if (!context.session?.user || isImpersonatedSession(context.session)) {
    throw new ORPCError("UNAUTHORIZED");
  }
  if (!(await isTwoFactorPolicySatisfied(context.session.user))) {
    throw new ORPCError("FORBIDDEN", {
      message: "Two-factor authentication setup is required.",
    });
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const protectedProcedure = authenticatedProcedure.use(requireRequiredTwoFactor);

export type AdminAuthorityFailure =
  | "unauthenticated"
  | "banned"
  | "unverified"
  | "not-admin"
  | "two-factor";

/**
 * The admin authority rule, defined once and checked in this order: a signed-in
 * user on a session that is not an impersonation, not banned, with a verified
 * email, an admin role and the forced second factor. `requireAdmin`,
 * `requireAdminOr404` and the server's cookie-only `requireVerifiedAdminSession`
 * (apps/server/src/admin-session-gate.ts) all call this and only map the
 * failure to their own response. Do not re-derive the rule elsewhere. The
 * live-row re-check (`requireLiveAdminOr404`) runs after this, not instead.
 */
export async function checkAdminAuthority<S extends NonNullable<Context["session"]>>(
  session: S | null | undefined,
): Promise<{ ok: true; session: S } | { ok: false; reason: AdminAuthorityFailure }> {
  if (!session?.user || isImpersonatedSession(session)) {
    return { ok: false, reason: "unauthenticated" };
  }
  if (isUserBanned(session.user)) return { ok: false, reason: "banned" };
  if (!session.user.emailVerified) return { ok: false, reason: "unverified" };
  if (!isAdminRole(session.user.role)) return { ok: false, reason: "not-admin" };
  if (!(await isTwoFactorPolicySatisfied(session.user))) return { ok: false, reason: "two-factor" };
  return { ok: true, session };
}

const ADMIN_FORBIDDEN_MESSAGES: Record<
  Exclude<AdminAuthorityFailure, "unauthenticated" | "banned">,
  string
> = {
  unverified: "Email verification required for admin access.",
  "not-admin": "Admin access required.",
  "two-factor": "Two-factor authentication setup is required.",
};

const requireAdmin = o.middleware(async ({ context, next }) => {
  // `requireAuth` is always chained before this middleware (and already
  // refuses a missing, impersonated or banned session with UNAUTHORIZED); the
  // rule repeats those checks anyway, which also narrows the type, and maps
  // them to the same UNAUTHORIZED.
  const authority = await checkAdminAuthority(context.session);
  if (!authority.ok) {
    if (authority.reason === "unauthenticated" || authority.reason === "banned") {
      throw new ORPCError("UNAUTHORIZED");
    }
    throw new ORPCError("FORBIDDEN", { message: ADMIN_FORBIDDEN_MESSAGES[authority.reason] });
  }
  return next({
    context: {
      session: authority.session,
    },
  });
});

export const adminProcedure = publicProcedure.use(requireAuth).use(requireAdmin);

// `adminOr404Procedure` applies the same rule as `requireAdmin`
// (checkAdminAuthority) but throws NOT_FOUND for every failure mode (missing
// or impersonated session, ban, unverified email, non-admin role, missing 2FA).
// Mount it on procedures that back a 404-hidden surface (e.g. the /admin route
// group) so existence of the endpoint is not leaked to non-admins.
const requireAdminOr404 = o.middleware(async ({ context, next }) => {
  const authority = await checkAdminAuthority(context.session);
  if (!authority.ok) throw new ORPCError("NOT_FOUND", { message: "Not found" });
  return next({
    context: {
      session: authority.session,
    },
  });
});

export const adminOr404Procedure = publicProcedure.use(requireAdminOr404);

/** Committing policy/identity writers share a live gate on their owning transaction.
 * Keep the outer registered snapshot gate, then reauthorize after acquiring
 * authority. READ COMMITTED reads the actor after any authority-lock wait,
 * rather than reusing a snapshot from before it. The outgoing policy is checked
 * again after any effect/row waits,
 * so relaxing the policy cannot authorize an actor whose grace just ended.
 */
const requireLiveAdminOr404 = o.middleware(async ({ context, next }) => {
  const result = await prisma
    .$transaction(
      async (tx) => {
        await lockIdentityAuthority(tx);
        const { actor, check } = await readLiveAdminPolicy(
          tx,
          context.session!.user.id,
          () => new ORPCError("NOT_FOUND", { message: "Not found" }),
        );
        const response = await next({ context: { authorityTx: tx, liveAdmin: actor } });
        check();
        return response;
      },
      { isolationLevel: "ReadCommitted" },
    )
    .catch((error: unknown) => {
      mapUserChangeConflict(error);
      throw error;
    });
  invalidateForceTwoFactorSettingsCache();
  return result;
});

export const liveAdminOr404Procedure = adminOr404Procedure.use(requireLiveAdminOr404);

// -- authorization registry --------------------------------------------------
//
// `pnpm policy:access-matrix` reads these two objects statically (it parses
// this file; it never imports it) and FAILS on any router procedure whose
// chain starts at a builder, or passes `.use()` a middleware, that is not
// listed here. That is deliberate: an authorization check that exists only
// inline in one router is invisible to the gate and to the next agent, and
// two hand-written copies of the same check drift. So the rule for auth is
// "register at two, not extract at three" — the second router that needs a
// role check gets an entry here (and a builder above), not a local helper.
// See AGENTS.md § Scope discipline.
//
// The level is the *minimum* a caller must hold to get past the gate. The
// access matrix in docs/access-matrix.md is checked against it.

export type ProcedureAccessLevel = "public" | "authenticated" | "admin";

/** Builders a router procedure chain may start from. Keep in sync with the exports above. */
export const procedureAccessLevels = {
  publicProcedure: "public",
  authenticatedProcedure: "authenticated",
  protectedProcedure: "authenticated",
  adminProcedure: "admin",
  adminOr404Procedure: "admin",
  liveAdminOr404Procedure: "admin",
} as const satisfies Record<string, ProcedureAccessLevel>;

/** Middleware a router procedure may pass to `.use()`. Custom role helpers register here. */
export const middlewareAccessLevels = {
  requireAuth: "authenticated",
  requireRequiredTwoFactor: "authenticated",
  requireAdmin: "admin",
  requireAdminOr404: "admin",
  requireLiveAdminOr404: "admin",
} as const satisfies Record<string, ProcedureAccessLevel>;
