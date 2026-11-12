/**
 * Which user columns a Better Auth write may carry into the database.
 *
 * Better Auth's `input: false` only guards its sign-up/update-user body
 * parsers. Other routes pass caller data straight to `internalAdapter`:
 * `/admin/create-user` spreads its free-form `data` into the new row, so an
 * admin could create an account with a 2099 `twoFactorGraceStartedAt` or
 * `createdAt` (an endless forced-2FA grace), `twoFactorEnabled: true` without
 * any second factor, or a chosen `id`. The adapter wrapper in `bootstrap.ts`
 * is the one boundary every user create and update crosses, so it applies
 * these rules there:
 *
 * - create: an allowlist. Only identity/profile fields Better Auth core and
 *   its admin plugin legitimately set survive; timestamps are server time;
 *   `twoFactorEnabled` starts false (the 2FA plugin turns it on after a real
 *   enrollment); the grace start is derived after the insert from the policy.
 * - update: server-owned columns (`id`, `createdAt`, `twoFactorGraceStartedAt`,
 *   `authorityVersion`) are never written through Better Auth; the grace start
 *   is owned by the SQL writers in `ban.ts`, the version by a DB trigger.
 */
const CREATE_ALLOWED = new Set([
  "name",
  "email",
  "emailVerified",
  "image",
  "role",
  // Better Auth's admin plugin gates these behind the `ban` permission.
  "banned",
  "banReason",
  "banExpires",
  // Set by our own `user.create.before` hook from the request locale.
  "locale",
]);

const UPDATE_DENIED = new Set([
  "id",
  "createdAt",
  "twoFactorGraceStartedAt",
  // Owned by the user_authority_version trigger.
  "authorityVersion",
]);

export function sanitizeUserCreateData(
  data: Record<string, unknown>,
  now: Date = new Date(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (CREATE_ALLOWED.has(key)) out[key] = value;
  }
  out.createdAt = now;
  out.updatedAt = now;
  out.twoFactorEnabled = false;
  return out;
}

export function sanitizeUserUpdateData(update: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (!UPDATE_DENIED.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Accounts made through the admin create-user route (our invite, or a direct
 * admin call) start unverified: only redeeming the emailed link proves the
 * mailbox, so an admin cannot assert it through `data`.
 */
export const ADMIN_CREATE_USER_PATH = "/admin/create-user";
