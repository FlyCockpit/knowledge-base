import { deleteResetLinksOnActivation } from "./password-reset-links.js";
import { CREDENTIAL_PROVIDER_ID } from "./reset-link-rules.js";

/**
 * An invited account becomes active when its email is verified or an IdP
 * identity is linked to it. Set-password links minted while it was a pending
 * invite (one an admin was shown) must die at that moment, by whatever route
 * it happened: ordinary `/verify-email`, an SSO sign-in that links the account
 * and copies the IdP's verified claim. (A proved reset link verifies and
 * deletes the others itself, password-reset-links.ts `admitResetSpend`.)
 *
 * This is tidy-up, not the guarantee. What stops the holder of a leftover link
 * from replacing the active account's password is the spending transaction's
 * own check (password-reset-links.ts `admitResetSpend`): a link that was not
 * mailed is spendable only while the account is a pending invite. So
 * a failed cleanup is logged, never surfaced: the activation is already
 * committed.
 *
 * These run as Better Auth database after-hooks, which Better Auth queues
 * until the write's transaction committed. Each takes the per-user
 * credential-setup lock that minting takes and deletes every reset link of
 * the user, so a mint racing the activation either re-reads the user under the
 * lock after the activation committed and refuses, or committed its link
 * before this took the lock, and this deletes it.
 *
 * A forgot-password link the user has out also goes when an IdP identity is
 * linked to an already-verified account; they can request another.
 */

/** Endpoint contexts whose user update set `emailVerified: true`. */
const verificationWrites = new WeakSet<object>();

/** `databaseHooks.user.update.before`: note a write that verifies the email. */
export function noteVerificationWrite(data: Record<string, unknown>, context: unknown): void {
  if (data.emailVerified === true && typeof context === "object" && context !== null) {
    verificationWrites.add(context);
  }
}

/**
 * `databaseHooks.user.update.after`: if this update verified the email, the
 * account is active, so its reset links go. With no endpoint context (a
 * server-side internal write) it cannot tell, so it cleans up whenever the row
 * is verified: fail safe.
 */
export async function afterUserUpdate(
  user: { id?: unknown; emailVerified?: unknown } | null | undefined,
  context: unknown,
): Promise<void> {
  if (user?.emailVerified !== true || typeof user.id !== "string") return;
  const known = typeof context === "object" && context !== null;
  if (known && !verificationWrites.has(context)) return;
  await deleteResetLinksOnActivation(user.id);
}

/**
 * `databaseHooks.account.create.after`: an IdP identity linked to the user
 * (SSO sign-in, implicit linking by verified email) makes the account active;
 * its reset links go. A credential account (the invitee setting a password)
 * changes nothing.
 */
export async function afterAccountCreate(
  account: { userId?: unknown; providerId?: unknown } | null | undefined,
): Promise<void> {
  if (!account || account.providerId === CREDENTIAL_PROVIDER_ID) return;
  if (typeof account.userId !== "string") return;
  await deleteResetLinksOnActivation(account.userId);
}
