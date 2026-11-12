import { AsyncLocalStorage } from "node:async_hooks";

export type UserCreationMode = "admin-bootstrap" | "admin-invite";

const userCreationModeStorage = new AsyncLocalStorage<UserCreationMode>();

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
  return userCreationModeStorage.getStore();
}

export function runWithAllowedUserCreation<T>(
  mode: UserCreationMode,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return userCreationModeStorage.run(mode, fn);
}
