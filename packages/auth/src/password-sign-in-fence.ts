import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import prisma from "@knowledge-base/db";
import { logEvent } from "@knowledge-base/env/log";
import * as z from "zod";
import { assertPasswordWriteLocked, passwordWriteLockHeld } from "./password-write-lock.js";
import { readBodyFields } from "./request-body-field.js";

/**
 * A session that a password proved must not outlive a change of that
 * password.
 *
 * Better-Auth's `/sign-in/email` reads the credential hash, awaits the (slow,
 * deliberately) hash verification and only then inserts the session. A
 * password reset that completes inside that window deletes the user's
 * sessions, writes the new hash and runs our revocation, all before the
 * sign-in's insert lands, so an attacker who knew the old password would end
 * up with a live browser session minted after the reset. The two-factor
 * challenge has the same shape one step later: the password step leaves a
 * pending `2fa-…` challenge, and the code step turns it into a session.
 *
 * The fence is a snapshot of the credential (a fingerprint of the stored
 * hash, which every password write changes: each hash has a fresh salt),
 * taken BEFORE Better-Auth reads it, and compared again AFTER the session (or
 * challenge) row is committed. No lock and no clock: if the re-read still sees
 * the old hash, the password write has not committed yet, so the revocation
 * that runs after it (credential-revocation.ts, which deletes every session
 * and every two-factor challenge of the user) sees the new row and deletes
 * it; if the re-read sees a new hash, the row is deleted here.
 *
 * - `withPasswordSignInFence` (apps/server mounts it on `POST
 *   /api/auth/sign-in/email`) takes the snapshot, runs the handler, re-reads
 *   and, if the credential changed, deletes what the request created and
 *   answers like a wrong password (no cookies).
 * - `fencePasswordSessionBefore` (session-create hook) refuses a sign-in
 *   session without a matching snapshot, so a sign-in that reaches
 *   Better-Auth any other way fails closed.
 * - `recordTwoFactorChallenge` (verification-create hook) stores the
 *   snapshot next to each two-factor challenge the sign-in opens, and
 *   `fencePasswordSessionBefore`/`fencePasswordSessionAfter` require it to
 *   still match when the code step mints the session.
 *
 * The same two hooks hold every OTHER session Better-Auth mints to one rule,
 * so no endpoint can slip a session past a reset (see
 * {@link fencePasswordSessionBefore}): a session minted for a request that
 * is already signed in (two-factor enable/disable, enrolment, impersonation)
 * needs that parent session row to still exist, before the insert and again
 * after it. A reset deletes every session (Better-Auth before its password
 * write, the revocation again after it), so a rotation racing a reset either
 * finds its parent gone or is deleted by the revocation. A session with no
 * parent is minted only on the paths listed there; anything else is refused.
 */

/** Better-Auth's email/password sign-in endpoint (as database hooks see it). */
const PASSWORD_SIGN_IN_PATH = "/sign-in/email";

/** The two-factor endpoints that turn a pending sign-in challenge into a session. */
const TWO_FACTOR_VERIFY_PATHS = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-otp",
  "/two-factor/verify-backup-code",
]);

/** A password change with "sign out other devices" (password-write-lock.ts). */
const CHANGE_PASSWORD_PATH = "/change-password";

/**
 * Sign-ins proved by the identity provider (SSO), the only sessions minted
 * with no signed-in parent besides the fenced paths above. The router passes
 * the concrete path (`/callback/sso`), a server-side call the route pattern.
 */
function isIdentityProviderSignIn(path: string): boolean {
  return path.startsWith("/callback/") || path === "/sign-in/social";
}

/** Better-Auth's own password-length ceiling (`maxPasswordLength` default). */
const MAX_PASSWORD_LENGTH = 128;

/** Better-Auth's two-factor cookie (`plugins/two-factor/constant`), holding the challenge id. */
const TWO_FACTOR_COOKIE = "two_factor";

/**
 * A sign-in challenge identifier (`2fa-<random>`), not its attempt counter
 * (`2fa-attempts-…`) and not one of our fence rows (they contain ":").
 */
const TWO_FACTOR_CHALLENGE = /^2fa-(?!attempts-)[A-Za-z0-9_-]+$/;

/**
 * The fence row stored next to a challenge: same `value` (the user id) and
 * expiry, so the revocation's `2fa-` delete removes both, and the credential
 * fingerprint in the identifier, so "still the same password" is one equality
 * lookup.
 */
function challengeFenceIdentifier(challenge: string, credential: string): string {
  return `${challenge}:credential:${credential}`;
}

function fingerprint(password: string | null | undefined): string {
  return createHash("sha256")
    .update(password ?? "")
    .digest("base64url");
}

/**
 * A fingerprint of the user's credential password hash ("" hashed when there
 * is none). Stored in the database next to a challenge, so it is a digest,
 * never the hash itself.
 */
async function credentialFingerprint(userId: string): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true },
  });
  return fingerprint(account?.password);
}

/**
 * The sign-in's snapshot: the credential account of the email's user, in ONE
 * query whose shape does not depend on whether the account exists, so a
 * missing and an existing account cost the same database work.
 */
async function credentialSnapshot(
  email: string,
): Promise<{ userId: string; credential: string } | null> {
  const account = await prisma.account.findFirst({
    where: { providerId: "credential", user: { email } },
    select: { userId: true, password: true },
  });
  return account ? { userId: account.userId, credential: fingerprint(account.password) } : null;
}

type Fence = {
  /** The user whose credential the body's email named when the request arrived, if any. */
  userId: string | null;
  credential: string;
  /** What the request created, for removal if the credential changed. */
  sessionIds: string[];
  verificationIdentifiers: string[];
  /** The session hook refused the mint (Better-Auth then answers 500). */
  refused: boolean;
};
const fenceFor = new AsyncLocalStorage<Fence>();

/** Better-Auth's answer to a wrong password; a raced sign-in gets the same. */
function invalidCredentials(): Response {
  return Response.json(
    { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
    { status: 401 },
  );
}

/**
 * Run a password sign-in (`run` calls the Better-Auth handler) inside a
 * credential fence. The email and password are read from a clone of the body
 * (JSON or form, as Better-Auth reads it); the original is left for the
 * handler.
 *
 * Only a body Better-Auth would check a password for (a valid email and a
 * password string within its length limit) costs a read, and that read is
 * the same single query for an existing and a missing account; a refused
 * body costs none. A re-read follows only a request that created something.
 * No lock and no transaction, so the fence adds nothing to the pool and
 * cannot deadlock with the password-write, identity-authority or
 * bootstrap/setup locks.
 */
export async function withPasswordSignInFence(
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  const { email, password } = await readBodyFields(request.clone(), {
    email: 320,
    password: MAX_PASSWORD_LENGTH,
  });
  const snapshot =
    email && password && z.email().safeParse(email).success
      ? await credentialSnapshot(email.toLowerCase())
      : null;
  const fence: Fence = {
    userId: snapshot?.userId ?? null,
    credential: snapshot?.credential ?? "",
    sessionIds: [],
    verificationIdentifiers: [],
    refused: false,
  };
  const response = await fenceFor.run(fence, run);
  // Refused before the insert: nothing was minted, answer like a wrong password.
  if (fence.refused) return invalidCredentials();
  if (!fence.userId) return response;
  if (fence.sessionIds.length === 0 && fence.verificationIdentifiers.length === 0) return response;
  if ((await credentialFingerprint(fence.userId)) === fence.credential) return response;
  await prisma.session.deleteMany({ where: { id: { in: fence.sessionIds } } });
  if (fence.verificationIdentifiers.length > 0) {
    await prisma.verification.deleteMany({
      where: { value: fence.userId, identifier: { in: fence.verificationIdentifiers } },
    });
  }
  logEvent("auth.password-sign-in-stale");
  return invalidCredentials();
}

/** The parts of Better-Auth's endpoint context the hooks read. */
type HookContext =
  | {
      path?: string;
      context?: {
        secret?: string;
        session?: { session?: { id: string; userId: string } | null } | null;
        createAuthCookie?: (name: string) => { name: string };
      };
      getSignedCookie?: (name: string, secret: string) => Promise<string | null | false>;
    }
  | null
  | undefined;

/** The signed-in session the request came with, if any (Better-Auth's session middleware). */
function parentSession(context: HookContext): { id: string } | null {
  return context?.context?.session?.session ?? null;
}

/**
 * A session derived from a signed-in one is valid only while that parent row
 * exists: a reset deletes every session before it writes the new hash.
 */
async function parentStillLive(parent: { id: string }): Promise<boolean> {
  const live = await prisma.session.findFirst({ where: { id: parent.id }, select: { id: true } });
  return live !== null;
}

/**
 * The sign-in's code step: the challenge in the signed two-factor cookie must
 * have a fence row with the CURRENT credential fingerprint.
 */
async function challengeStillValid(userId: string, context: HookContext): Promise<boolean> {
  const challenge = await twoFactorChallenge(context);
  if (!challenge) return false;
  const fence = await prisma.verification.findFirst({
    where: {
      identifier: challengeFenceIdentifier(challenge, await credentialFingerprint(userId)),
      value: userId,
    },
    select: { id: true },
  });
  return fence !== null;
}

async function twoFactorChallenge(context: HookContext): Promise<string | null> {
  const secret = context?.context?.secret;
  const cookie = context?.context?.createAuthCookie?.(TWO_FACTOR_COOKIE);
  if (!secret || !cookie || !context?.getSignedCookie) return null;
  const challenge = await context.getSignedCookie(cookie.name, secret);
  return typeof challenge === "string" && TWO_FACTOR_CHALLENGE.test(challenge) ? challenge : null;
}

function refused(): Error {
  return new Error(
    "Session refused: the password that proved it changed, its credential fence is missing, or the session it derives from is gone (see password-sign-in-fence.ts).",
  );
}

/**
 * Session-create BEFORE hook: how each session Better-Auth mints must be
 * proved, checked before the insert. In order:
 *
 * 1. `/sign-in/email`: this request's credential fence, same user, credential
 *    unchanged.
 * 2. Device login never mints a Better Auth session here: the app exchanges
 *    its approved code for a PAT under the identity-authority lock.
 * 3. `/change-password` ("sign out other devices"; Better-Auth has just
 *    deleted the parent itself): the password-write lock, inside which the
 *    parent was re-checked (password-write-lock.ts).
 * 4. Any request with a signed-in parent session (two-factor enable/disable
 *    and enrolment, impersonation, …): that parent row still exists.
 * 5. `/two-factor/verify-*` without a parent (the sign-in's code step): its
 *    challenge's credential fence row still matches.
 * 6. An identity-provider sign-in (`/callback/*`, `/sign-in/social`).
 *
 * Anything else (an unknown path, no endpoint context) is refused.
 */
export async function fencePasswordSessionBefore(
  session: { userId: string },
  context: HookContext,
): Promise<void> {
  const path = context?.path ?? "";
  if (path === PASSWORD_SIGN_IN_PATH) {
    const fence = fenceFor.getStore();
    if (!fence) throw refused();
    if (
      fence.userId !== session.userId ||
      (await credentialFingerprint(session.userId)) !== fence.credential
    ) {
      fence.refused = true;
      throw refused();
    }
    return;
  }

  if (path === CHANGE_PASSWORD_PATH) {
    assertPasswordWriteLocked();
    return;
  }
  const parent = parentSession(context);
  if (parent) {
    if (!(await parentStillLive(parent))) throw refused();
    return;
  }
  if (TWO_FACTOR_VERIFY_PATHS.has(path)) {
    if (!(await challengeStillValid(session.userId, context))) throw refused();
    return;
  }
  if (isIdentityProviderSignIn(path)) return;
  throw refused();
}

/**
 * Session-create AFTER hook: the same proof re-checked now that the row is
 * committed. A sign-in session is recorded for the wrapper's final re-check.
 * Otherwise, if the proof no longer holds (the parent session was deleted, the
 * password-write lock lapsed, the challenge's credential changed), the session
 * is deleted and the request fails, so no cookie is set. A code step's
 * challenge fence rows are spent either way.
 */
export async function fencePasswordSessionAfter(
  session: { id: string; userId: string },
  context: HookContext,
): Promise<void> {
  const path = context?.path ?? "";
  if (path === PASSWORD_SIGN_IN_PATH) {
    fenceFor.getStore()?.sessionIds.push(session.id);
    return;
  }

  let valid = true;
  const parent = parentSession(context);
  if (path === CHANGE_PASSWORD_PATH) valid = passwordWriteLockHeld();
  else if (parent) valid = await parentStillLive(parent);
  else if (TWO_FACTOR_VERIFY_PATHS.has(path)) {
    valid = await challengeStillValid(session.userId, context);
    const challenge = await twoFactorChallenge(context);
    if (challenge) {
      await prisma.verification.deleteMany({
        where: { value: session.userId, identifier: { startsWith: `${challenge}:credential:` } },
      });
    }
  }
  if (valid) return;
  await prisma.session.deleteMany({ where: { id: session.id } });
  throw refused();
}

/**
 * Verification-create AFTER hook: bind a password sign-in challenge to its
 * credential snapshot; bind a verified SSO challenge to the current credential
 * (same user/expiry). A challenge without one can never be completed.
 */
export async function recordTwoFactorChallenge(
  verification: {
    identifier: string;
    value: string;
    expiresAt: Date;
  },
  context?: HookContext,
): Promise<void> {
  if (!TWO_FACTOR_CHALLENGE.test(verification.identifier)) return;
  const fence = fenceFor.getStore();
  if (fence?.userId && verification.value === fence.userId) {
    const identifier = challengeFenceIdentifier(verification.identifier, fence.credential);
    await prisma.verification.create({
      data: { identifier, value: fence.userId, expiresAt: verification.expiresAt },
      select: { id: true },
    });
    fence.verificationIdentifiers.push(verification.identifier, identifier);
    return;
  }
  // KB also runs the 2FA plugin after a verified SSO callback (index.ts).
  // That challenge has IdP proof rather than a password request snapshot;
  // bind it to the current credential so reset invalidates it in the same way.
  if (!isIdentityProviderSignIn(context?.path ?? "")) return;
  await prisma.verification.create({
    data: {
      identifier: challengeFenceIdentifier(
        verification.identifier,
        await credentialFingerprint(verification.value),
      ),
      value: verification.value,
      expiresAt: verification.expiresAt,
    },
    select: { id: true },
  });
}
