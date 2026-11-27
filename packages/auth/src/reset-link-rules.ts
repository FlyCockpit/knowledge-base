import { createHash } from "node:crypto";
import type { Prisma } from "@knowledge-base/db";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";

/**
 * The reset-link rules that run on a caller's transaction (no Prisma client of
 * their own, so the bootstrap adapter can call them inside Better Auth's
 * spending transaction). The flows around them are in password-reset-links.ts.
 */

/** Better Auth's verification identifier prefix for password-reset tokens. */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/** Better Auth's endpoint that spends a reset token (`POST /api/auth/reset-password`). */
export const RESET_PASSWORD_PATH = "/reset-password";

/**
 * The proof row: identifier `reset-password-proof:<sha256(token)>` (the token
 * itself is never stored a second time), value the user id, the address and
 * the proof kind (JSON), `expiresAt` the link's own. Not a `reset-password:`
 * prefix, so nothing that lists or deletes reset tokens mistakes it for one.
 */
const PROOF_IDENTIFIER_PREFIX = "reset-password-proof:";

export type ResetLinkProof = "mailbox" | "no-smtp-invite";

export function proofIdentifier(token: string): string {
  return `${PROOF_IDENTIFIER_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/** Better Auth's id for an email/password account (`Account.providerId`). */
export const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * What decides whether a user is still an unfinished invite. Bounded: two
 * account rows are enough to tell "at most one" from "more", and one live
 * session is enough to tell "never signed in" from "signed in".
 */
export function inviteStateSelect(now: Date) {
  return {
    emailVerified: true,
    accounts: { select: { providerId: true }, take: 2 },
    sessions: { where: { expiresAt: { gt: now } }, select: { id: true }, take: 1 },
  } satisfies Prisma.UserSelect;
}

/**
 * Pending invite = an account nobody has started using: email not verified,
 * no account row other than at most one email/password ("credential") one
 * (an invite is created with none; the invitee's first set-password adds it),
 * and no live session.
 *
 * `emailVerified === false` alone is NOT enough. Better Auth's genericOAuth
 * copies the IdP's `email_verified ?? false`, so an active SSO user can be
 * unverified; a set-password link for them would let whoever holds it add a
 * password next to the SSO identity: an account takeover that also skips the
 * IdP's MFA. The non-credential account rule covers that, and the live-session
 * rule covers an account in use by any other route.
 */
export function isInvitePending(row: {
  emailVerified: boolean;
  accounts: { providerId: string }[];
  sessions: { id: string }[];
}): boolean {
  return (
    !row.emailVerified &&
    row.accounts.length <= 1 &&
    row.accounts.every((account) => account.providerId === CREDENTIAL_PROVIDER_ID) &&
    row.sessions.length === 0
  );
}

/**
 * The per-user lock everything that mints a reset link, records its proof,
 * spends it or deletes it takes, held until the calling transaction ends.
 * Minting ({@link mintSetPasswordLink}) re-checks under it that the invite is
 * still pending; a spend ({@link admitResetSpend}) and an activation delete
 * every other reset link of the user under it. Taken before the identity
 * authority lock wherever both are held, never after it.
 */
export function lockCredentialSetup(
  db: Pick<Prisma.TransactionClient, "$executeRaw">,
  userId: string,
): Prisma.PrismaPromise<number> {
  return db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`set-password-link:${userId}`}))`;
}

/** Every reset link of the user, spent or not. Run under {@link lockCredentialSetup}. */
export function deleteResetLinks(
  db: Pick<Prisma.TransactionClient, "verification">,
  userId: string,
) {
  return db.verification.deleteMany({
    where: { value: userId, identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX } },
  });
}

export function proofRow(
  token: string,
  userId: string,
  email: string,
  proof: ResetLinkProof,
  expiresAt: Date,
) {
  return {
    identifier: proofIdentifier(token),
    value: JSON.stringify({ userId, email: email.toLowerCase(), proof }),
    expiresAt,
  };
}

export function parseProof(
  value: string,
): { userId: string; email: string; proof: ResetLinkProof } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { userId, email, proof } = parsed as Record<string, unknown>;
    if (typeof userId !== "string" || typeof email !== "string") return null;
    if (proof !== "mailbox" && proof !== "no-smtp-invite") return null;
    return { userId, email, proof };
  } catch {
    return null;
  }
}

/** The Prisma delegates {@link admitResetSpend} needs on the spending transaction. */
export type ResetSpendTx = Pick<Prisma.TransactionClient, "$executeRaw" | "verification" | "user">;

/**
 * The guarantee behind every reset: runs INSIDE Better Auth's own
 * `/reset-password` transaction, just before it consumes the token
 * `reset-password:<token>` (the bootstrap adapter's `consumeOne`,
 * bootstrap.ts), in the same transaction as the password write that follows.
 *
 * Under the user's credential-setup lock and then the identity authority lock
 * (the one order used everywhere), both held until that transaction commits:
 *
 * - the spend is refused (false: Better Auth's `INVALID_TOKEN`) unless the
 *   link was mailed to the account's address, or the account is still a
 *   pending invite ({@link isInvitePending}), read now, after any
 *   activation that held the authority lock has committed;
 * - every OTHER reset link of the user is deleted;
 * - if the link has a proof record ({@link recordResetLinkProof}), it is
 *   consumed and the email is verified, only while it is still the address
 *   the proof is for.
 *
 * So verification commits together with the password this very link sets, or
 * not at all; and while this transaction runs, no other reset of the user can
 * consume its token (it waits on the setup lock), and once it committed, an
 * unproved link of a now-verified account is refused. No verified account
 * ever carries a password set through an unproved link, and an activation
 * (verify-email, an IdP link) racing a shown-link spend either commits first
 * (the spend is refused) or waits for it.
 *
 * Returns true for an unknown or expired token too: Better Auth's own consume
 * then refuses it.
 */
export async function admitResetSpend(
  tx: ResetSpendTx,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const identifier = `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`;
  const first = await tx.verification.findFirst({ where: { identifier }, select: { value: true } });
  if (!first) return true;
  const userId = first.value;
  await lockCredentialSetup(tx, userId);
  await lockIdentityAuthority(tx);
  // Again under the locks: a mint, an activation or another reset may have
  // deleted it while this waited.
  const link = await tx.verification.findFirst({
    where: { identifier, value: userId, expiresAt: { gt: now } },
    select: { id: true },
  });
  if (!link) return true;
  const proofRow = await tx.verification.findFirst({
    where: { identifier: proofIdentifier(token), expiresAt: { gt: now } },
    select: { value: true },
  });
  const parsed = proofRow ? parseProof(proofRow.value) : null;
  const proof = parsed?.userId === userId ? parsed : null;
  if (proof?.proof !== "mailbox") {
    const state = await tx.user.findUnique({
      where: { id: userId },
      select: inviteStateSelect(now),
    });
    if (!state || !isInvitePending(state)) return false;
  }
  await tx.verification.deleteMany({
    where: {
      value: userId,
      identifier: { startsWith: RESET_PASSWORD_IDENTIFIER_PREFIX, not: identifier },
    },
  });
  if (proof) {
    await tx.verification.deleteMany({ where: { identifier: proofIdentifier(token) } });
    // Prisma, not Better Auth: this transaction already holds the authority
    // lock, and the other links are gone already (the activation tidy-up would
    // only repeat it). The `user_authority_version` trigger invalidates
    // cached sessions.
    await tx.user.updateMany({
      where: { id: userId, email: proof.email, emailVerified: false },
      data: { emailVerified: true },
    });
  }
  return true;
}
