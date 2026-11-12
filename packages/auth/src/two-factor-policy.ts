import { isAdminRole } from "./roles";

/**
 * The shared, dependency-free core of the forced-2FA policy.
 *
 * Both enforcement sides import from here so they cannot drift:
 *  - server: `packages/api/src/lib/two-factor-policy.ts` (adds the DB read +
 *    TTL cache, and is what `requireAdmin` / `requireRequiredTwoFactor` /
 *    `requireVerifiedAdminSession` consult).
 *  - client: `apps/web/src/utils/two-factor-policy.ts` (adds the
 *    `settings.getAll` map, and is what the `_auth` route guard, the admin
 *    2FA nudge, and the admin settings toggle consult).
 *
 * Nothing here touches Prisma or the network — it is pure so both sides can
 * unit-test the same rules.
 */

export const FORCE_2FA_PUBLIC_USERS_SETTING_KEY = "force2faPublicUsers";
export const FORCE_2FA_INTERNAL_USERS_SETTING_KEY = "force2faInternalUsers";

export const FORCE_2FA_SETTING_KEYS = [
  FORCE_2FA_PUBLIC_USERS_SETTING_KEY,
  FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
] as const;

export type ForceTwoFactorSettingKey = (typeof FORCE_2FA_SETTING_KEYS)[number];

/**
 * Effective value when the AppSetting row is ABSENT — the single source of
 * truth for "what does a freshly deployed app do".
 *
 * Internal (admin) users default to **required**: in this template the admin
 * account is the whole security boundary, so a phishable password alone must
 * not own the deployment. Public users default to unforced; requiring a second
 * factor of every visitor is a product decision, not a safe default.
 *
 * Writing the row explicitly always wins — `"false"` turns enforcement off.
 * Do not weaken the internal default without an explicit user request (see
 * AGENTS.md § Agent Safety Rules).
 */
export const FORCE_2FA_DEFAULTS = {
  [FORCE_2FA_PUBLIC_USERS_SETTING_KEY]: false,
  [FORCE_2FA_INTERNAL_USERS_SETTING_KEY]: true,
} as const satisfies Record<ForceTwoFactorSettingKey, boolean>;

/**
 * Enrollment grace window, measured from when the requirement first applied
 * to the user: `User.twoFactorGraceStartedAt` (promotion to admin, or the
 * policy turned on for their population), or `User.createdAt` when that is
 * NULL (covered since creation). See {@link twoFactorGraceStartedAt}.
 *
 * Because the internal default is "required", the very first admin to sign up
 * would otherwise be locked out of the dashboard before they ever saw the
 * enrollment screen. Inside this window an admin without a second factor still
 * passes the forced-2FA check (and is nudged, loudly, with the deadline);
 * outside it the ordinary rejection applies.
 *
 * The grace covers the forced-2FA check ONLY. Email verification and role
 * checks are never graced.
 */
export const TWO_FACTOR_ENROLLMENT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Permit an authenticated account with no credential password (for example,
 * an SSO-only account) to enroll in TOTP. Better Auth still requires a valid
 * password whenever a credential account exists.
 */
export const TWO_FACTOR_ALLOW_PASSWORDLESS_ENROLLMENT = true;

export function forcedTwoFactorSettingKeyForRole(role: unknown): ForceTwoFactorSettingKey {
  return isAdminRole(role)
    ? FORCE_2FA_INTERNAL_USERS_SETTING_KEY
    : FORCE_2FA_PUBLIC_USERS_SETTING_KEY;
}

/** Resolve a stored AppSetting value, falling back to {@link FORCE_2FA_DEFAULTS}. */
export function isForcedTwoFactorEnabled(
  key: ForceTwoFactorSettingKey,
  storedValue: string | undefined | null,
): boolean {
  if (storedValue === undefined || storedValue === null) return FORCE_2FA_DEFAULTS[key];
  return storedValue === "true";
}

export type TwoFactorPolicyUser = {
  twoFactorEnabled?: boolean | null;
  /** `User.createdAt` — a Date, an ISO string, or epoch milliseconds. */
  createdAt?: Date | string | number | null;
  /** `User.twoFactorGraceStartedAt`, same encodings; NULL/absent → `createdAt`. */
  twoFactorGraceStartedAt?: Date | string | number | null;
};

/**
 * The instant the enrollment grace is measured from: the recorded start when
 * present, else `createdAt`. A recorded but unreadable start is NOT replaced
 * by `createdAt` — it yields no grace (fail closed).
 */
export function twoFactorGraceStartedAt(
  user: TwoFactorPolicyUser,
): Date | string | number | null | undefined {
  const recorded = user.twoFactorGraceStartedAt;
  return recorded === null || recorded === undefined ? user.createdAt : recorded;
}

function toEpochMs(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * End of the enrollment grace window that began at `graceStartedAt` (see
 * {@link twoFactorGraceStartedAt}), or `null` when it is missing or
 * unreadable. A null result is treated as "no grace" everywhere — the
 * fail-closed direction.
 */
export function twoFactorEnrollmentGraceEndsAt(
  graceStartedAt: Date | string | number | null | undefined,
): number | null {
  const startedAtMs = toEpochMs(graceStartedAt);
  return startedAtMs === null ? null : startedAtMs + TWO_FACTOR_ENROLLMENT_GRACE_MS;
}

export function isWithinTwoFactorEnrollmentGrace(
  graceStartedAt: Date | string | number | null | undefined,
  now: number = Date.now(),
): boolean {
  const endsAt = twoFactorEnrollmentGraceEndsAt(graceStartedAt);
  return endsAt !== null && now < endsAt;
}

/**
 * The rule itself: an enrolled user always passes; an unenrolled one passes
 * only when the policy does not apply to them, or while they are still inside
 * the enrollment grace window.
 */
export function isTwoFactorRequirementSatisfied(
  user: TwoFactorPolicyUser,
  forced: boolean,
  now: number = Date.now(),
): boolean {
  if (user.twoFactorEnabled) return true;
  if (!forced) return true;
  return isWithinTwoFactorEnrollmentGrace(twoFactorGraceStartedAt(user), now);
}

/**
 * True when a policy write turns enforcement ON for its population (effective
 * value, defaults included). On this transition standing MCP grants of that
 * population's unenrolled users whose enrollment grace has ENDED are
 * tombstoned; users still inside the grace keep theirs until it ends,
 * when locked bearer admission or the auth cleanup sweep settles them. Identity and
 * policy writers also settle due lapses before changing their evidence. Tombstones are permanent, so turning
 * enforcement off again can never reactivate an old grant generation.
 */
export function isForcedTwoFactorActivation(
  key: ForceTwoFactorSettingKey,
  before: string | undefined | null,
  after: string,
): boolean {
  return !isForcedTwoFactorEnabled(key, before) && isForcedTwoFactorEnabled(key, after);
}
