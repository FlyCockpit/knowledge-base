import { createHash, randomBytes } from "node:crypto";
import { auth } from "@knowledge-base/auth";
import { recordTwoFactorGraceStartAtCreation } from "@knowledge-base/auth/ban";
import {
  adoptExistingUsers,
  BOOTSTRAP_STATE_ID,
  currentPolicy,
  decideUserCreate,
  FIRST_USER_ROLE,
  lockBootstrapState,
} from "@knowledge-base/auth/bootstrap";
import { DEFAULT_LOCALE } from "@knowledge-base/config/locales";
import prisma, { type Prisma } from "@knowledge-base/db";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { withLockSlot } from "@knowledge-base/db/lock-slots";
import { env } from "@knowledge-base/env/server";

/**
 * SETUP_KEY first-admin bootstrap. `issueSetupLink` (called by
 * apps/server/src/setup-routes.ts) hands out a one-time setup link;
 * `claimSetupLink` (the public `setup.claimFirstAdmin` procedure, spent from
 * the web reset-password page) creates the first admin with its password.
 *
 * This is not a second bootstrap mechanism. The one invariant is the existing
 * `BootstrapState` singleton (packages/auth/src/bootstrap.ts): its row lock
 * serializes every first-user create, and `completedAt` is set exactly once.
 * Both calls take that lock, adopt pre-existing users exactly like the
 * Better-Auth adapter does, and decide with the same `decideUserCreate`, so
 * the production rule ("only the ADMIN_EMAIL identity bootstraps") holds
 * here unchanged. SETUP_KEY replaces only the verification email.
 *
 * No user row exists until the link is spent. Issuing writes only a
 * `setup-admin:<sha256(token)>` verification row whose value is the address;
 * the claim then creates the user, its credential account and the bootstrap
 * completion in one transaction under the identity authority lock and the
 * bootstrap row lock. Nothing Better-Auth does (a reset, an SSO link, the admin
 * plugin) can race it, since all of those need a user row. A Better-Auth
 * sign-up racing the claim serializes on the same bootstrap row, so exactly
 * one of them creates the admin and the other sees bootstrap complete.
 *
 * Only the token's hash is stored, and the prefix is not one Better-Auth
 * reads, so no Better-Auth endpoint can spend it. One live link at a time:
 * issuing a new one replaces it.
 */

/** Verification-row prefix of a setup link: `setup-admin:<sha256(token)>`. */
export const SETUP_TOKEN_PREFIX = "setup-admin:";

/** Better-Auth's id for an email/password account (`Account.providerId`). */
const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * - `bootstrap_complete`: bootstrap is over (an admin was chosen, or users
 *   already exist). SETUP_KEY can never create another admin.
 * - `email_not_allowed`: the bootstrap policy refuses this address (in
 *   production, anything but ADMIN_EMAIL, or ADMIN_EMAIL is unset).
 * - `ready`: `url` is a fresh one-time setup link; every earlier link died.
 */
export type SetupLinkResult =
  | { kind: "bootstrap_complete" }
  | { kind: "email_not_allowed" }
  | { kind: "ready"; url: string; expiresAt: Date; email: string };

export type ClaimSetupLinkResult =
  | { kind: "claimed"; userId: string }
  | { kind: "invalid_token" }
  | { kind: "password_too_short" | "password_too_long" };

type Tx = Prisma.TransactionClient;

/** The display name a bootstrap admin starts with: the address's local part. */
export function bootstrapAdminName(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  return (local || "Admin").slice(0, 100);
}

/** The stored identifier for a raw setup token: only its hash is kept. */
export function setupTokenIdentifier(token: string): string {
  return `${SETUP_TOKEN_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

/**
 * The web reset-password page in setup mode, absolute against the web origin
 * so a split-origin deploy (`CORS_ORIGIN` set) lands on the app.
 */
export function setupLinkUrl(token: string): string {
  const url = new URL(`/${DEFAULT_LOCALE}/reset-password`, env.CORS_ORIGIN || env.BETTER_AUTH_URL);
  url.searchParams.set("setup", "1");
  url.searchParams.set("token", token);
  return url.toString();
}

function deleteSetupLinks(tx: Tx) {
  return tx.verification.deleteMany({ where: { identifier: { startsWith: SETUP_TOKEN_PREFIX } } });
}

/**
 * Lock the bootstrap singleton and decide whether a first admin with `email`
 * may still be created. Returns the canonical address, or the refusal.
 */
async function lockAndDecide(tx: Tx, email: string): Promise<Decision> {
  return decideLocked(tx, await lockBootstrapState(tx), email);
}

type Decision =
  | { kind: "bootstrap_complete" | "email_not_allowed" }
  | { kind: "open"; email: string };

/** The decision itself; `state` must come from `lockBootstrapState(tx)`. */
async function decideLocked(
  tx: Tx,
  state: Awaited<ReturnType<typeof lockBootstrapState>>,
  email: string,
): Promise<Decision> {
  if (state.completedAt != null) return { kind: "bootstrap_complete" };
  const policy = currentPolicy();
  // Users without a completed singleton (restored database): adopt them and
  // stop, exactly as the Better-Auth adapter does.
  if ((await adoptExistingUsers(tx, policy))?.completedAt != null) {
    return { kind: "bootstrap_complete" };
  }
  const decision = decideUserCreate({
    bootstrapComplete: false,
    policy,
    creationMode: undefined,
    email,
  });
  if (
    decision.action === "reject" ||
    decision.role !== FIRST_USER_ROLE ||
    !decision.completeBootstrap
  ) {
    return { kind: "email_not_allowed" };
  }
  return { kind: "open", email: decision.canonicalEmail ?? email };
}

/**
 * Hand out a one-time setup link for `email` (already trimmed, lowercased and
 * validated by the caller), replacing any earlier link. Writes no user.
 */
export async function issueSetupLink(
  email: string,
  { ttlSeconds, now = new Date() }: { ttlSeconds: number; now?: Date },
): Promise<SetupLinkResult> {
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  // 32 random bytes, URL-safe: the token rides in a URL.
  const token = randomBytes(32).toString("base64url");
  const outcome = await withLockSlot(() =>
    prisma.$transaction(async (tx) => {
      const decided = await lockAndDecide(tx, email);
      if (decided.kind !== "open") return decided;
      await deleteSetupLinks(tx);
      await tx.verification.create({
        data: { identifier: setupTokenIdentifier(token), value: decided.email, expiresAt },
        select: { id: true },
      });
      return decided;
    }),
  );
  if (outcome.kind !== "open") return outcome;
  return { kind: "ready", url: setupLinkUrl(token), expiresAt, email: outcome.email };
}

/**
 * Spend a setup link: create the first admin (email verified) with its
 * password and complete bootstrap. Refused (`invalid_token`) for an unknown,
 * expired or replaced link, once bootstrap is complete, and when the policy no
 * longer admits the address.
 *
 * The password is checked against Better-Auth's length policy and hashed with
 * Better-Auth's own hasher, then written as the credential account Better-Auth
 * itself would create (`accountId` = user id), so sign-in, password change and
 * forgot-password work on it as on any other account. The token is looked up
 * before hashing, so a caller without a live link cannot make the server hash
 * anything. Expiry is re-checked with a fresh clock once the locks are held.
 */
export async function claimSetupLink({
  token,
  newPassword,
  clock = () => new Date(),
}: {
  token: string;
  newPassword: string;
  clock?: () => Date;
}): Promise<ClaimSetupLinkResult> {
  const identifier = setupTokenIdentifier(token);
  const live = await prisma.verification.findFirst({
    where: { identifier, expiresAt: { gt: clock() } },
    select: { id: true },
  });
  if (!live) return { kind: "invalid_token" };

  const authContext = await auth.$context;
  const { minPasswordLength, maxPasswordLength } = authContext.password.config;
  if (newPassword.length < minPasswordLength) return { kind: "password_too_short" };
  if (newPassword.length > maxPasswordLength) return { kind: "password_too_long" };
  // Hashed before the transaction: the slow step never holds a lock.
  const passwordHash = await authContext.password.hash(newPassword);

  try {
    return await withLockSlot(() =>
      prisma.$transaction(async (tx): Promise<ClaimSetupLinkResult> => {
        // Same order as every identity write: authority lock, then the singleton.
        await lockIdentityAuthority(tx);
        // The link is read only once the singleton is locked: an issue that
        // replaced it holds that lock until it commits, so a replaced link is
        // never seen as live here.
        const state = await lockBootstrapState(tx);
        const link = await tx.verification.findFirst({
          where: { identifier, expiresAt: { gt: clock() } },
          select: { value: true },
        });
        if (!link) return { kind: "invalid_token" };
        const decided = await decideLocked(tx, state, link.value);
        if (decided.kind !== "open") return { kind: "invalid_token" };
        const user = await tx.user.create({
          data: {
            email: decided.email,
            name: bootstrapAdminName(decided.email),
            emailVerified: true,
            role: FIRST_USER_ROLE,
          },
          select: { id: true },
        });
        // Forced 2FA covers admins: the grace starts at createdAt, as for any
        // user the policy covers at creation (packages/auth/src/ban.ts).
        await recordTwoFactorGraceStartAtCreation(
          (sql, params) => tx.$executeRawUnsafe(sql, ...params),
          user.id,
        );
        await tx.account.create({
          data: {
            userId: user.id,
            providerId: CREDENTIAL_PROVIDER_ID,
            accountId: user.id,
            password: passwordHash,
          },
          select: { id: true },
        });
        await tx.bootstrapState.update({
          where: { id: BOOTSTRAP_STATE_ID },
          data: { completedAt: clock(), userId: user.id },
        });
        await deleteSetupLinks(tx);
        return { kind: "claimed", userId: user.id };
      }),
    );
  } catch (err) {
    // Defense in depth: a user insert that bypassed the bootstrap lock took
    // the address after the checks above. Roll back, never promote.
    if (isUniqueViolation(err)) return { kind: "invalid_token" };
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "P2002" || err.code === "23505")
  );
}
