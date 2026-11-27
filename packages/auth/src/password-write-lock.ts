import { AsyncLocalStorage } from "node:async_hooks";
import prisma from "@knowledge-base/db";
import { logEvent } from "@knowledge-base/env/log";
import { APIError } from "better-auth/api";
import { quarantineUntrustedPasswordWrite } from "./credential-revocation.js";
import { LockSlotTimeoutError, withLockSlot } from "./lock-slots.js";
import { readBodyFields } from "./request-body-field.js";
import { ADMIN_CREATE_USER_PATH } from "./user-columns.js";
import { getAllowedUserCreationMode } from "./user-creation-policy.js";

const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/**
 * Password writes for one user happen one at a time.
 *
 * Better-Auth's `/change-password` reads the credential, spends a slow hash
 * verification, then writes its new hash. A password reset that completes in
 * between (sessions deleted, new hash written, credentials revoked) would be
 * overwritten a moment later: whoever knew the OLD password, and still had a
 * session when the change started, would own the account again, with a fresh
 * session the reset's revocation never saw.
 *
 * Every endpoint that writes a password therefore runs its whole Better-Auth
 * handler holding the user's `password-write:<userId>` advisory lock
 * (`withPasswordWriteLock`, mounted by apps/server on
 * {@link PASSWORD_WRITE_PATHS}):
 *
 * - a change that gets the lock after a reset re-checks, inside the lock,
 *   that the session it came from still exists; the reset deleted it, so the
 *   change answers 401 and writes nothing;
 * - a reset that waits for an in-flight change runs after it, so the reset's
 *   password is the last write and its revocation deletes every session the
 *   change minted.
 *
 * The account hooks refuse a password write outside the lock (or after it
 * lapsed), so a write that reaches Better-Auth any other way fails closed,
 * and the session-create hook does the same for the session a change with
 * "sign out other devices" mints (password-sign-in-fence.ts).
 *
 * The write itself runs on another pooled connection, after the before hook's
 * check, so it can be delayed past the lock (the lock transaction times out,
 * a reset elsewhere completes, then the delayed UPDATE lands). The account
 * AFTER hooks therefore confirm the lock is still held once the write has
 * committed: the lock transaction is probed (it can only answer if it is
 * still open, and an open transaction has held its advisory lock without a
 * break since it took it), and the held flag must not have lapsed. If either
 * fails, the write is untrusted: the credential is scrambled to an unusable
 * hash, every session and pending two-factor challenge and CLI credential is
 * revoked, and the request fails (`PASSWORD_WRITE_UNCONFIRMED`, no cookie).
 * The account owner recovers with Forgot password.
 *
 * Password-write comes first in the lock order; see docs/access-matrix.md.
 * Reserve this transaction's slot and one nested slot up front (lock-slots.ts).
 */

/** The Better-Auth endpoints that write a password (paths below `/api/auth`). */
export const PASSWORD_WRITE_PATHS: ReadonlySet<string> = new Set([
  "/change-password",
  "/reset-password",
  "/admin/set-user-password",
]);
const CHANGE_PASSWORD_PATH = "/change-password";
const RESET_PASSWORD_PATH = "/reset-password";

export function passwordWriteLockKey(userId: string): string {
  return `password-write:${userId}`;
}

/**
 * Transaction bound and lapse margin: the lock stops counting as held
 * 5 s before Prisma would roll it back.
 */
const LOCK_TIMEOUT_MS = 30_000;
const HELD_FOR_MS = LOCK_TIMEOUT_MS - 5_000;
/** How long a write waits for another write of the same user to finish. */
const PASSWORD_WRITE_WAIT_MS = 10_000;
const POLL_MS = 50;

type HeldLock = {
  userId: string;
  held: boolean;
  expiresAt: number;
  /** Answers true only while the lock transaction is still open (and so still holds the lock). */
  probe: () => Promise<boolean>;
  /** A password write passed the before hook and its after hook has not confirmed it yet. */
  unconfirmedWrites: number;
  /** Set once a write was quarantined: the request's answer must survive the expired transaction. */
  quarantined: boolean;
};
const heldFor = new AsyncLocalStorage<HeldLock>();

type SessionLookup = (
  headers: Headers,
) => Promise<{ user: { id: string }; session: { id: string } } | null>;

/** Whose password the request would write, and (for a change) the session it came from. */
async function passwordWriteTarget(
  path: string,
  request: Request,
  getSession: SessionLookup,
): Promise<{ userId: string; sessionId?: string } | null> {
  if (path === CHANGE_PASSWORD_PATH) {
    const session = await getSession(request.headers);
    return session ? { userId: session.user.id, sessionId: session.session.id } : null;
  }
  if (path === RESET_PASSWORD_PATH) {
    // Better-Auth reads `body.token || query.token`.
    const { token: bodyToken } = await readBodyFields(request.clone(), { token: 512 });
    const token = bodyToken ?? new URL(request.url).searchParams.get("token");
    if (!token) return null;
    const row = await prisma.verification.findFirst({
      where: { identifier: `${RESET_PASSWORD_IDENTIFIER_PREFIX}${token}` },
      select: { value: true },
    });
    return row ? { userId: row.value } : null;
  }
  const { userId } = await readBodyFields(request.clone(), { userId: 256 });
  return userId ? { userId } : null;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

function busy(): Response {
  return errorResponse(
    503,
    "PASSWORD_WRITE_BUSY",
    "Another password change for this account is still finishing; try again.",
  );
}

/**
 * Run a password-writing request (`run` calls the Better-Auth handler for
 * `path`, one of {@link PASSWORD_WRITE_PATHS}) holding the target user's
 * password-write lock. A request with no resolvable target (no session, an
 * unknown reset token) runs unlocked: Better-Auth refuses it, and the account
 * hook refuses any password write it attempted anyway.
 *
 * The lock is waited for (polled, in its own transaction) for at most
 * `waitMs`; a write still blocked then answers 503 `PASSWORD_WRITE_BUSY`.
 */
export async function withPasswordWriteLock(
  path: string,
  request: Request,
  run: () => Promise<Response>,
  { getSession, waitMs = PASSWORD_WRITE_WAIT_MS }: { getSession: SessionLookup; waitMs?: number },
): Promise<Response> {
  const target = await passwordWriteTarget(path, request, getSession);
  if (!target) return run();
  const key = passwordWriteLockKey(target.userId);
  // One deadline for the whole wait: a lock slot, then the advisory lock.
  const deadline = performance.now() + waitMs;
  // Two slots: this lock transaction and the credential revocation the
  // handler runs inside it (lock-slots.ts).
  return withLockSlot(
    async () => {
      const lock: HeldLock = {
        userId: target.userId,
        held: false,
        expiresAt: performance.now() + HELD_FOR_MS,
        probe: async () => false,
        unconfirmedWrites: 0,
        quarantined: false,
      };
      let lapse: NodeJS.Timeout | undefined;
      // The handler's answer. A quarantined write usually means the lock
      // transaction expired, so its commit rejects; the quarantine already
      // committed on its own connection, and the user must still get its
      // "use Forgot password" answer rather than a 500.
      let answer: Response | undefined;
      try {
        return await prisma.$transaction(
          async (tx) => {
            for (;;) {
              const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
                SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
              if (row?.locked) break;
              if (performance.now() >= deadline) return busy();
              await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
            if (target.sessionId) {
              const live = await tx.session.findFirst({
                where: {
                  id: target.sessionId,
                  userId: target.userId,
                  expiresAt: { gt: new Date() },
                },
                select: { id: true },
              });
              if (!live) return errorResponse(401, "UNAUTHORIZED", "Unauthorized");
            }
            const remaining = lock.expiresAt - performance.now();
            if (remaining <= 0) return busy();
            lock.probe = async () => {
              // Re-entrant: true while this transaction holds the lock; a
              // closed (timed-out) transaction rejects instead.
              const [again] = await tx.$queryRaw<{ locked: boolean }[]>`
                SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
              return again?.locked === true;
            };
            lock.held = true;
            lapse = setTimeout(() => {
              lock.held = false;
            }, remaining);
            answer = await heldFor.run(lock, run);
            return answer;
          },
          { timeout: LOCK_TIMEOUT_MS },
        );
      } catch (error) {
        if (lock.quarantined && answer) return answer;
        throw error;
      } finally {
        clearTimeout(lapse);
        lock.held = false;
      }
    },
    { nested: 1, deadline },
  ).catch((error: unknown) => {
    if (error instanceof LockSlotTimeoutError) return busy();
    throw error;
  });
}

/** Whether the current request holds a password-write lock that has not lapsed. */
export function passwordWriteLockHeld(): boolean {
  const lock = heldFor.getStore();
  return lock?.held === true && performance.now() < lock.expiresAt;
}

/**
 * Throw unless the current request holds its password-write lock. Called by
 * the account hooks before every password write and by the session hook for
 * the session a password change mints.
 */
export function assertPasswordWriteLocked(): void {
  if (!passwordWriteLockHeld()) {
    throw new Error(
      "Password write refused: the request does not hold the user's password-write lock (see password-write-lock.ts).",
    );
  }
}

/**
 * Account-create BEFORE hook: every password-bearing create needs the lock,
 * including server-only calls with no endpoint path (such as setPassword).
 * Only a NEW user's first credential needs none: sign-up, or admin create-user
 * under the server's invite grant. Neither flow can target an existing user.
 */
export function guardPasswordAccountCreate(
  account: { password?: string | null },
  context: { path?: string } | null | undefined,
): void {
  if (!account.password) return;
  if (context?.path === "/sign-up/email") return;
  if (context?.path === ADMIN_CREATE_USER_PATH && getAllowedUserCreationMode() === "admin-invite")
    return;
  assertPasswordWriteLocked();
  markUnconfirmedWrite();
}

/** Account-update BEFORE hook: any update that sets `password` needs the lock. */
export function guardPasswordAccountUpdate(data: Record<string, unknown>): void {
  if (!("password" in data) || data.password === undefined) return;
  assertPasswordWriteLocked();
  markUnconfirmedWrite();
}

function markUnconfirmedWrite(): void {
  const lock = heldFor.getStore();
  if (lock) lock.unconfirmedWrites += 1;
}

/**
 * Account-create/update AFTER hook: confirm that a password write the before
 * hook let through committed while the lock was still held. If the lock
 * lapsed or its transaction closed (so a reset may have run in between), the
 * write is quarantined ({@link quarantineUntrustedPasswordWrite}: unusable
 * hash, every session, challenge and CLI credential revoked) and the request
 * fails. The quarantine takes no password-write lock: this request may still
 * hold it, and nothing that holds the identity-authority lock it takes waits for
 * this one.
 */
export async function confirmPasswordWriteLocked({
  hash,
}: {
  /** The app's password hash for the scrambled value (index.ts: the pepper's). */
  hash?: (password: string) => Promise<string>;
} = {}): Promise<void> {
  const lock = heldFor.getStore();
  if (!lock || lock.unconfirmedWrites === 0) return;
  lock.unconfirmedWrites -= 1;
  const confirmed =
    passwordWriteLockHeld() && (await lock.probe().catch(() => false)) && passwordWriteLockHeld();
  if (confirmed) return;
  logEvent("auth.password-write-unconfirmed");
  await quarantineUntrustedPasswordWrite(lock.userId, { hash });
  lock.quarantined = true;
  throw new APIError("CONFLICT", {
    code: "PASSWORD_WRITE_UNCONFIRMED",
    message:
      "This password change could not be confirmed, so the account's password was disabled for safety. Use Forgot password to set a new one.",
  });
}
