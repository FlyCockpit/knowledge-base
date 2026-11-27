import { deleteResetLinksOnActivation } from "./password-reset-links.js";
import { CREDENTIAL_PROVIDER_ID } from "./reset-link-rules.js";

/**
 * Commit-only defense-in-depth cleanup. Bootstrap's bound adapter now locks
 * activation and deletes links in the SAME transaction as the verifying write
 * or IdP insert. Reset admission remains authoritative in its password transaction.
 * These hooks retry cleanup only; they never establish proof or undo passwords.
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
