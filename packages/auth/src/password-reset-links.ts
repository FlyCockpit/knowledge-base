import { randomBytes } from "node:crypto";
import prisma, { type Prisma } from "@knowledge-base/db";
import { logInternalError } from "@knowledge-base/env/log";
import {
  deleteResetLinks,
  inviteStateSelect,
  isInvitePending,
  lockCredentialSetup,
  parseProof,
  proofIdentifier,
  proofRow,
  RESET_PASSWORD_IDENTIFIER_PREFIX,
  RESET_PASSWORD_PATH,
  type ResetLinkProof,
} from "./reset-link-rules.js";

/**
 * Password-reset links: forgot-password mails and admin-invite set-password
 * links. Both are Better Auth `reset-password:<token>` verification rows
 * (value = user id), spent by Better Auth's `POST /reset-password`.
 *
 * Spending one sets the password. It verifies the email only when that very
 * token carries a proof record ({@link recordResetLinkProof}):
 *
 * - `"mailbox"`: the link was mailed to the address (forgot-password, a
 *   mailed invite). The mail is the proof.
 * - `"no-smtp-invite"`: an invite on a server with no SMTP configured at all,
 *   where the admin hands the link over themselves (docs/access-matrix.md:
 *   private no-SMTP invitation links). No mailbox proof can exist on such a
 *   server, so the admin's invite is what vouches for the address, as it
 *   always has there.
 *
 * A link without a record (the invite mail failed on a server that HAS SMTP,
 * so the admin was shown the link) proves nothing about the mailbox: spending
 * it sets the password and leaves the account unverified; sign-in then mails
 * the invitee a verification link (`sendOnSignIn`). Otherwise an admin, or
 * anyone the link was passed to, could make an address nobody controls
 * "verified" on a server that can prove it.
 *
 * The record also decides who may spend a link: a mailed link works for any
 * account; any other link works only while the account is still a pending
 * invite ({@link isInvitePending}). So a link left over after the invitee
 * activated the account (an SSO sign-in linked it, the address was verified)
 * is dead, whether or not the activation's tidy-up deleted it. That decision,
 * the verification and the deletion of the user's other links are made inside
 * Better Auth's own spending transaction ({@link admitResetSpend}); the
 * `/reset-password` before-hook ({@link isResetLinkRedeemable}) refuses and
 * deletes a dead link early.
 *
 * The record is a verification row next to the token: no schema change, and
 * it expires with the link (`reapExpiredAuthTokens` drops both).
 */

/**
 * The user is not (or no longer) a pending invite ({@link isInvitePending}):
 * they verified their address, signed in, or sign in through another
 * provider. A set-password link for them would be a working way into an
 * account in use, so none is minted.
 */
export class SetPasswordLinkRefusedError extends Error {
  constructor() {
    super("This user is not a pending invite; no set-password link was created.");
    this.name = "SetPasswordLinkRefusedError";
  }
}

/**
 * Mint a one-time set-password token for an admin-invited user: a Better Auth
 * `reset-password:<token>` row (exactly what `requestPasswordReset` stores),
 * written directly because Better Auth's internal adapter cannot join this
 * transaction. Under the user's credential-setup lock it re-checks that the
 * user is still a pending invite (refusing with
 * {@link SetPasswordLinkRefusedError}) and deletes every earlier reset link,
 * so one invite leaves exactly one working link.
 *
 * Minting verifies nothing: the caller records a proof
 * ({@link recordResetLinkProof}) only once it is known (the mail was accepted,
 * or the server has no SMTP).
 */
export async function mintSetPasswordLink({
  userId,
  ttlMs,
  noSmtpInviteFor,
  now = new Date(),
}: {
  userId: string;
  ttlMs: number;
  /**
   * On a server with no SMTP at all: the invitee's address. The
   * `"no-smtp-invite"` proof is then written in the same transaction as the
   * link, so the private invitation can never lose its proof (there is no
   * mail to fall back on).
   */
  noSmtpInviteFor?: string;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  // URL-safe: the token rides in a URL path segment.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlMs);
  await prisma.$transaction(async (tx) => {
    await lockCredentialSetup(tx, userId);
    const state = await tx.user.findUnique({
      where: { id: userId },
      select: inviteStateSelect(now),
    });
    if (!state || !isInvitePending(state)) throw new SetPasswordLinkRefusedError();
    await deleteResetLinks(tx, userId);
    await tx.verification.create({
      data: { identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`, value: userId, expiresAt },
      select: { id: true },
    });
    if (noSmtpInviteFor !== undefined) {
      await tx.verification.create({
        data: proofRow(token, userId, noSmtpInviteFor, "no-smtp-invite", expiresAt),
        select: { id: true },
      });
    }
  });
  return { token, expiresAt };
}

/**
 * Records why spending the reset link `token` proves `email` (see the module
 * comment): call it with `"mailbox"` only after the mail was accepted for
 * delivery. Returns false, and records nothing, when the link is already gone
 * (spent, replaced, expired): a late record must never outlive its link. The
 * check and the insert are one transaction under the user's credential-setup
 * lock, which every delete of the user's links also takes.
 */
export async function recordResetLinkProof(input: {
  token: string;
  userId: string;
  email: string;
  proof: ResetLinkProof;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockCredentialSetup(tx, input.userId);
    const link = await tx.verification.findFirst({
      where: {
        identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${input.token}`,
        value: input.userId,
        expiresAt: { gt: now },
      },
      select: { expiresAt: true },
    });
    if (!link) return false;
    await tx.verification.create({
      data: proofRow(input.token, input.userId, input.email, input.proof, link.expiresAt),
      select: { id: true },
    });
    return true;
  });
}

/**
 * Whether Better Auth may spend the reset link `token` (checked by the
 * `/reset-password` before-hook). A mailed link always may: the mail went to
 * the account's own address. Any other link may only while the user is still
 * a pending invite ({@link isInvitePending}); once the account is active
 * (verified, signed in, an IdP linked) it is refused and deleted. An unknown
 * or expired token is left to Better Auth, which refuses it itself.
 *
 * The invite state is read under the credential-setup lock, the lock minting,
 * proof records and activation tidy-up take, so it sees their committed
 * result. (A mailed link needs no lock: it is spendable in every state. A
 * record written while this waited is checked again under the lock.) Better
 * Auth spends the token after this returns, outside the lock; the same rule
 * is applied again in that spending transaction ({@link admitResetSpend}),
 * which is the guarantee. This early check deletes the dead link, which the
 * spending transaction (rolled back on refusal) cannot.
 *
 * A forgot-password link whose proof record failed to write (sendResetPassword
 * logs it) is refused for an active account: fail closed; the user requests
 * another one.
 */
export async function isResetLinkRedeemable(token: string, now = new Date()): Promise<boolean> {
  const identifier = `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}`;
  type Reader = Pick<Prisma.TransactionClient, "verification">;
  const mailedFor = async (db: Reader, userId: string) => {
    const row = await db.verification.findFirst({
      where: { identifier: proofIdentifier(token), expiresAt: { gt: now } },
      select: { value: true },
    });
    const proof = row ? parseProof(row.value) : null;
    return proof?.userId === userId && proof.proof === "mailbox";
  };
  // Unknown, expired and mailed links need no lock (and no transaction).
  const link = await prisma.verification.findFirst({
    where: { identifier, expiresAt: { gt: now } },
    select: { value: true },
  });
  if (!link) return true;
  const userId = link.value;
  if (await mailedFor(prisma, userId)) return true;
  return prisma.$transaction(async (tx) => {
    await lockCredentialSetup(tx, userId);
    // Again under the lock: a record whose writer held the lock while we
    // waited has committed now, and must not be refused as unproved.
    if (await mailedFor(tx, userId)) return true;
    const state = await tx.user.findUnique({
      where: { id: userId },
      select: inviteStateSelect(now),
    });
    if (state && isInvitePending(state)) return true;
    await tx.verification.deleteMany({ where: { identifier, value: userId } });
    return false;
  });
}

/** Attempts, and the pause before each retry (ms). */
const ATTEMPTS = 3;
const BACKOFF_MS = [100, 400] as const;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Under the credential-setup lock, delete every reset link of `userId` once
 * the account became active (account-activation.ts). Idempotent, so it is
 * retried; a final failure is logged (user id and error class only) and
 * swallowed: the activation is already committed, the leftover links are
 * refused when spent ({@link admitResetSpend}) unless mailed to the account's
 * own address, and they expire on their own.
 */
export async function deleteResetLinksOnActivation(
  userId: string,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 400);
    try {
      await prisma.$transaction([
        lockCredentialSetup(prisma, userId),
        deleteResetLinks(prisma, userId),
      ]);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  logInternalError("auth.reset-link-cleanup", lastError, { userId });
}

/**
 * The reset token a `POST /reset-password` request carries, or null. Better
 * Auth reads it from the body or the query, so this does too.
 */
export function resetTokenOf(ctx: {
  path?: string;
  body?: unknown;
  query?: unknown;
}): string | null {
  if (ctx.path !== RESET_PASSWORD_PATH) return null;
  const token =
    (isRecord(ctx.body) ? ctx.body.token : undefined) ||
    (isRecord(ctx.query) ? ctx.query.token : undefined);
  return typeof token === "string" && token.length > 0 ? token : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
