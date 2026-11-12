import { isUserBanned } from "@knowledge-base/auth/ban";
import { isAdminRole, isImpersonatedSession } from "@knowledge-base/auth/roles";
import { readLiveAdminPolicy } from "@knowledge-base/auth/session-authority";
import prisma from "@knowledge-base/db";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { ORPCError, os } from "@orpc/server";

import type { Context } from "./context";
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

const requireAdmin = o.middleware(async ({ context, next }) => {
  // `requireAuth` is always chained before this middleware, so session is
  // non-null at runtime — but the middleware-chain types don't carry that
  // narrowing through, so repeat the guard for the type checker.
  if (!context.session?.user || isImpersonatedSession(context.session)) {
    throw new ORPCError("UNAUTHORIZED");
  }
  if (!context.session.user.emailVerified) {
    throw new ORPCError("FORBIDDEN", {
      message: "Email verification required for admin access.",
    });
  }
  if (!isAdminRole(context.session.user.role)) {
    throw new ORPCError("FORBIDDEN", {
      message: "Admin access required.",
    });
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

export const adminProcedure = publicProcedure.use(requireAuth).use(requireAdmin);

// `adminOr404Procedure` mirrors the role check in `requireAdmin` but throws
// NOT_FOUND for every failure mode (missing session, unverified email,
// non-admin role). Mount it on procedures that back a 404-hidden surface
// (e.g. the /admin route group) so existence of the endpoint is not leaked
// to non-admins.
const requireAdminOr404 = o.middleware(async ({ context, next }) => {
  const notFound = () => new ORPCError("NOT_FOUND", { message: "Not found" });
  if (
    !context.session?.user ||
    isImpersonatedSession(context.session) ||
    isUserBanned(context.session.user)
  ) {
    throw notFound();
  }
  if (!context.session.user.emailVerified) {
    throw notFound();
  }
  if (!isAdminRole(context.session.user.role)) {
    throw notFound();
  }
  if (!(await isTwoFactorPolicySatisfied(context.session.user))) {
    throw notFound();
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const adminOr404Procedure = publicProcedure.use(requireAdminOr404);

/** Committing policy/identity writers share a live gate on their owning transaction.
 * Keep the outer registered snapshot gate, then reauthorize after acquiring
 * authority. The outgoing policy is checked again after any effect/row waits,
 * so relaxing the policy cannot authorize an actor whose grace just ended.
 */
const requireLiveAdminOr404 = o.middleware(async ({ context, next }) => {
  const result = await prisma.$transaction(async (tx) => {
    await lockIdentityAuthority(tx);
    const { actor, check } = await readLiveAdminPolicy(
      tx,
      context.session!.user.id,
      () => new ORPCError("NOT_FOUND", { message: "Not found" }),
    );
    const response = await next({ context: { authorityTx: tx, liveAdmin: actor } });
    check();
    return response;
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
