import {
  FORCE_2FA_SETTING_KEYS,
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
  type TwoFactorPolicyUser,
} from "@knowledge-base/auth/two-factor-policy";
import prisma, { type Prisma } from "@knowledge-base/db";

// The keys, the absent-row defaults, and the grace window live in
// `@knowledge-base/auth/two-factor-policy` so the browser mirror
// (`apps/web/src/utils/two-factor-policy.ts`) reads the same literals. This
// module adds only the database read and its cache.
export { FORCE_2FA_SETTING_KEYS } from "@knowledge-base/auth/two-factor-policy";

// In-process TTL cache for the force-2FA settings. `requireAdmin` /
// `requireRequiredTwoFactor` consult this on nearly every protected call, so
// hitting Postgres each time is pure overhead for a value that changes only
// when an admin flips the setting. The settings write path calls
// `invalidateForceTwoFactorSettingsCache()` for same-process immediacy; other
// processes converge within the TTL.
const FORCE_2FA_CACHE_TTL_MS = 60_000;

let forceTwoFactorCache: { byKey: Map<string, string>; expiresAt: number } | null = null;

async function loadForceTwoFactorSettings(): Promise<Map<string, string>> {
  const now = Date.now();
  if (forceTwoFactorCache && forceTwoFactorCache.expiresAt > now) {
    return forceTwoFactorCache.byKey;
  }
  const settings = await prisma.appSetting.findMany({
    where: {
      key: {
        in: [...FORCE_2FA_SETTING_KEYS],
      },
    },
    select: { key: true, value: true },
    // pagination:audited — bounded by the compile-time settings key list
    take: FORCE_2FA_SETTING_KEYS.length,
  });
  const byKey = new Map(settings.map((setting) => [setting.key, setting.value]));
  forceTwoFactorCache = { byKey, expiresAt: now + FORCE_2FA_CACHE_TTL_MS };
  return byKey;
}

/** Drop the cached settings — call after any AppSetting write to these keys (and from test setup). */
export function invalidateForceTwoFactorSettingsCache(): void {
  forceTwoFactorCache = null;
}

/**
 * Is forced 2FA on for this role? An absent AppSetting row resolves to
 * `FORCE_2FA_DEFAULTS` — which means **on** for internal (admin) users.
 */
export async function isForcedTwoFactorEnabledForRole(role: unknown): Promise<boolean> {
  const targetKey = forcedTwoFactorSettingKeyForRole(role);
  const byKey = await loadForceTwoFactorSettings();

  return isForcedTwoFactorEnabled(targetKey, byKey.get(targetKey));
}

/**
 * The gate every server-side caller uses. Pass the whole session user — the
 * `createdAt` and `twoFactorGraceStartedAt` fields are load-bearing, because
 * an unenrolled user inside the enrollment grace window still satisfies the
 * policy. A missing or unreadable basis means no grace (fail closed).
 */
export async function isTwoFactorPolicySatisfied(
  user: TwoFactorPolicyUser & { role?: unknown; id?: unknown },
): Promise<boolean> {
  if (user.twoFactorEnabled) return true;
  const forced = await isForcedTwoFactorEnabledForRole(user.role);
  if (isTwoFactorRequirementSatisfied(user, forced)) return true;
  // The signed session cookie cache can carry a user snapshot up to its
  // maxAge old — e.g. from before a policy activation or promotion started
  // this user's grace (`twoFactorGraceStartedAt`), or before they enrolled.
  // Re-read the live row before refusing; the live row is the authority, and
  // this path can only turn a stale refusal into the current answer for the
  // same role (one consistent snapshot: role, enrollment and grace).
  if (typeof user.id !== "string") return false;
  const live = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      role: true,
      twoFactorEnabled: true,
      createdAt: true,
      twoFactorGraceStartedAt: true,
    } satisfies Prisma.UserSelect,
  });
  if (!live) return false;
  // Callers authorize the cached session's role (e.g. `requireAdmin`). A live
  // role that differs — a demotion inside the cache window — must not lend
  // the cached role its looser live policy: refuse until the session catches up.
  if ((live.role ?? null) !== (user.role ?? null)) return false;
  if (live.twoFactorEnabled) return true;
  return isTwoFactorRequirementSatisfied(live, await isForcedTwoFactorEnabledForRole(live.role));
}
