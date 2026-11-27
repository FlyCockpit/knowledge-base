import { AsyncLocalStorage } from "node:async_hooks";
import type { Locale } from "@knowledge-base/config/locales";
import { APIError } from "better-auth/api";
import { ADMIN_CREATE_USER_PATH } from "./user-columns.js";

export type UserCreationMode = "admin-bootstrap" | "admin-invite";

// One grant per wrapped call. `locale` is the language the server chose for
// the new account (an admin invite picks the invitee's); the user.create hook
// seeds `User.locale` from it instead of the request.
type UserCreationGrant = { mode: UserCreationMode; locale?: Locale };

const userCreationModeStorage = new AsyncLocalStorage<UserCreationGrant>();

// Single source of truth for the signup-disabled rejection message. The
// Better-Auth database hook throws it, the admin-invite error translation in
// packages/api matches on it — keep the wording stable.
export const SIGNUP_DISABLED_MESSAGE =
  "Sign-up is currently disabled. Contact an admin if you need access.";

// Pure signup-disabled decision: returns the rejection message when user
// creation is blocked, null when it is allowed. Takes its inputs as params
// (instead of reading env) so it is unit-testable without env mocking; the
// Better-Auth hook and the server signup gate both delegate to it.
export function getUserCreationBlockReason(opts: { signupEnabled: boolean }): string | null {
  if (!opts.signupEnabled && !getAllowedUserCreationMode()) {
    return SIGNUP_DISABLED_MESSAGE;
  }
  return null;
}

export function getAllowedUserCreationMode(): UserCreationMode | undefined {
  return userCreationModeStorage.getStore()?.mode;
}

export function runWithAllowedUserCreation<T>(
  mode: UserCreationMode,
  fn: () => T | Promise<T>,
  options: { locale?: Locale } = {},
): T | Promise<T> {
  return userCreationModeStorage.run({ mode, locale: options.locale }, fn);
}

/**
 * The locale the current grant chose for the account being created, if any.
 * Server-chosen (an admin invite's language field), so it beats the request's
 * locale header, which on a server-side `auth.api.createUser` call is absent.
 */
export function getGrantedUserLocale(): Locale | undefined {
  return userCreationModeStorage.getStore()?.locale;
}

/**
 * Better Auth's `/admin/create-user` runs only under the `admin-invite` grant,
 * that is only from `users.invite` (packages/api) on the server, which never
 * lets anyone choose the password or the verification state. An HTTP call to
 * Better Auth's own route (an admin session reaches `/api/auth/admin/*`) is
 * refused, sign-up enabled or not: it would let an admin create an account
 * with a password they chose, for an address someone else owns. Runs first in
 * `databaseHooks.user.create.before`; an HTTP request can never carry the
 * grant, which lives in this process's AsyncLocalStorage.
 */
export function refuseUngrantedAdminCreateUser(
  context: { path?: string } | null | undefined,
): void {
  if (context?.path === ADMIN_CREATE_USER_PATH && getAllowedUserCreationMode() !== "admin-invite") {
    throw new APIError("FORBIDDEN", {
      message: "Invite users from the admin dashboard.",
      code: "ADMIN_CREATE_USER_UNSUPPORTED",
    });
  }
}
