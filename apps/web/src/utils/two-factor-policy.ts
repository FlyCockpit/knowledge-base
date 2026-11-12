import {
  type ForceTwoFactorSettingKey,
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
  type TwoFactorPolicyUser,
  twoFactorEnrollmentGraceEndsAt,
  twoFactorGraceStartedAt,
} from "@knowledge-base/auth/two-factor-policy";

/**
 * Browser mirror of the forced-2FA policy. The keys, the absent-row defaults
 * (internal users: required) and the grace window come from
 * `@knowledge-base/auth/two-factor-policy`, the same module the server gates read —
 * so the guard below and `requireAdmin` can't disagree about who is locked out.
 *
 * This is UX, not the security boundary: the oRPC procedures and the Hono
 * admin gates re-check independently.
 */

export type ForcedTwoFactorSettings = Partial<Record<ForceTwoFactorSettingKey, string | undefined>>;

export type TwoFactorPolicySessionUser = TwoFactorPolicyUser & { role?: unknown };

export function isForcedTwoFactorEnabledForRole(
  settings: ForcedTwoFactorSettings | undefined,
  role: unknown,
): boolean {
  const key = forcedTwoFactorSettingKeyForRole(role);
  return isForcedTwoFactorEnabled(key, settings?.[key]);
}

export type TwoFactorEnrollmentState =
  | { status: "enrolled" }
  /** The policy does not apply to this user's role. */
  | { status: "not-required" }
  /** Required, not yet enrolled, still inside the grace window. */
  | { status: "grace"; deadlineMs: number }
  /** Required, not enrolled, grace window spent — the gates now reject them. */
  | { status: "blocked" };

export function twoFactorEnrollmentState(
  settings: ForcedTwoFactorSettings | undefined,
  user: TwoFactorPolicySessionUser,
  now: number = Date.now(),
): TwoFactorEnrollmentState {
  if (user.twoFactorEnabled) return { status: "enrolled" };
  if (!isForcedTwoFactorEnabledForRole(settings, user.role)) return { status: "not-required" };
  if (!isTwoFactorRequirementSatisfied(user, true, now)) return { status: "blocked" };
  const deadlineMs = twoFactorEnrollmentGraceEndsAt(twoFactorGraceStartedAt(user));
  // A satisfied-by-grace user always has a readable grace start; the null branch
  // is unreachable defence so an undated session fails closed rather than
  // rendering a deadline-less "you have time" banner.
  return deadlineMs === null ? { status: "blocked" } : { status: "grace", deadlineMs };
}
