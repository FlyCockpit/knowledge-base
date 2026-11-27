import { APIError } from "better-auth/api";

/** Better Auth's admin route that writes arbitrary user fields. */
const ADMIN_UPDATE_USER_PATH = "/admin/update-user";

/**
 * knowledge-base has no email-change feature, so every user-row update
 * through Better Auth (`/update-user`, `/admin/update-user`, `/change-email`'s
 * verification, an SSO profile sync) that carries `email` is refused. Reset
 * and invite links carry only the user id: if the address could change while
 * one is out, the link mailed to the old address would still set the password
 * of the account now under the new one. KB share invitations are also
 * addressed by email. A future email change needs its own flow that deletes
 * the user's reset links (password-reset-links.ts `deleteResetLinks`) and
 * leaves the new address unverified until it is proved.
 *
 * `/admin/update-user` may not set `emailVerified` either: an admin saying an
 * address is verified proves nothing about the mailbox. (The admin role lacks
 * Better Auth's generic `update` permission already, roles.ts; this holds even
 * if a later role grants it.) Better Auth's own verify-email route still sets
 * it (it does not go through that path).
 *
 * Runs as `databaseHooks.user.update.before`, so it sees every Better Auth
 * write to the user row; Prisma writes from app code do not pass through it.
 */
export function refuseEmailChange(
  data: Record<string, unknown>,
  context: { path?: string } | null | undefined,
): void {
  if (data.email !== undefined) {
    throw new APIError("BAD_REQUEST", {
      message: "This server does not change account email addresses.",
      code: "EMAIL_CHANGE_UNSUPPORTED",
    });
  }
  if (context?.path === ADMIN_UPDATE_USER_PATH && data.emailVerified !== undefined) {
    throw new APIError("BAD_REQUEST", {
      message: "An email address is verified only through the link mailed to it.",
      code: "EMAIL_VERIFICATION_BY_MAIL_ONLY",
    });
  }
}
