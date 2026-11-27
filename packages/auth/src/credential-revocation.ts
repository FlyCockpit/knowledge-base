import { randomBytes } from "node:crypto";
import prisma from "@knowledge-base/db";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { hashPassword } from "better-auth/crypto";
import { revokeUserMcpGrants } from "./ban.js";
import { withLockSlot } from "./lock-slots.js";

/** Reset sweeps retire pending 2FA logins and every browser session as well. */
export async function revokeCredentialsAfterPasswordReset(userId: string): Promise<void> {
  await revokeCredentials(userId, "password_reset");
}

/** Keep only the session returned by the successful change. */
export async function revokeCredentialsAfterPasswordChange({
  userId,
  keepSessionToken,
}: PasswordChangeRevocationTarget): Promise<void> {
  await revokeCredentials(userId, "password_change", keepSessionToken);
}

/**
 * Reuse the user-wide tombstones for PATs (including CLI/API-key children),
 * OAuth grants and REST API keys. Bearer admission reads these live.
 * Device exchange holds this same authority lock through PAT mint/commit:
 * an earlier exchange's PAT is revoked here; a later one finds no code.
 * Keep durable approval history, but discard every code bound to the user.
 */
async function revokeCredentials(
  userId: string,
  reason: "password_reset" | "password_change",
  keepSessionToken?: string,
): Promise<void> {
  // Each retry gets a fresh transaction; partial tombstones roll back together.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await withLockSlot(() =>
        prisma.$transaction(
          async (tx) => {
            await lockIdentityAuthority(tx);
            await revokeUserMcpGrants(
              (sql, params) => tx.$executeRawUnsafe(sql, ...params),
              userId,
              reason,
            );
            await tx.deviceCode.deleteMany({ where: { userId } });
            if (reason !== "password_reset") {
              await tx.session.deleteMany({ where: { userId, token: { not: keepSessionToken } } });
              return;
            }
            // Better Auth 1.7.18 two-factor: the challenge/trust rows hold the
            // user id, but OTPs and attempt counters hold a hash/count instead.
            // Capture the challenge identifiers in this statement before deleting
            // their dependent records. Also clear OTPs bound to existing sessions.
            // No secondary verification storage or identifier hashing is configured.
            await tx.$executeRawUnsafe(
              `WITH challenges AS (
               SELECT identifier FROM "verification"
               WHERE value = $1 AND starts_with(identifier, '2fa-')
             )
             DELETE FROM "verification" v
             WHERE (v.value = $1 AND (
               starts_with(v.identifier, '2fa-') OR starts_with(v.identifier, 'trust-device-')
             ))
             OR v.identifier IN (
               SELECT '2fa-attempts-' || identifier FROM challenges
               UNION ALL SELECT '2fa-otp-' || identifier FROM challenges
             )
             OR starts_with(v.identifier, '2fa-otp-' || $1 || '!')`,
              userId,
            );
            // No secondary session storage is configured. The signed cookie
            // cache checks the live session row, so deleting it invalidates it too.
            await tx.session.deleteMany({ where: { userId } });
          },
          { timeout: 10000, maxWait: 5000 },
        ),
      );
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

/** Who a finished password change revokes, and the session it keeps. */
export type PasswordChangeRevocationTarget = { userId: string; keepSessionToken: string };

const CHANGE_PASSWORD_PATH = "/change-password";

/**
 * The user whose CLI credentials (and other sessions) a finished Better-Auth
 * request should revoke, with the session token the change issued to keep, or
 * `null`. Only a *successful* `/change-password` that asked to sign out
 * other sessions (`revokeOtherSessions: true`, which the web settings form
 * always sends) qualifies: a change that keeps other sessions alive is the
 * user saying the old password did not leak.
 *
 * `returned` is the endpoint's result as an after-hook sees it: the JSON body
 * (`{ token, user }`) on success, an `APIError` on failure — which has no
 * `user`, so a rejected change never revokes anything. A success with
 * `revokeOtherSessions` always carries the new session's token.
 */
export function passwordChangeRevocationTarget(ctx: {
  path?: string;
  body?: unknown;
  returned?: unknown;
}): PasswordChangeRevocationTarget | null {
  if (ctx.path !== CHANGE_PASSWORD_PATH) return null;
  if (!isRecord(ctx.body) || ctx.body.revokeOtherSessions !== true) return null;
  if (!isRecord(ctx.returned) || !isRecord(ctx.returned.user)) return null;
  const id = ctx.returned.user.id;
  const token = ctx.returned.token;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof token !== "string" || token.length === 0) return null;
  return { userId: id, keepSessionToken: token };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A committed password write lost its lock proof: disable that credential first,
 * then revoke every session/challenge and standing credential. Never reacquire
 * password-write here: the request may still own it. */
export async function quarantineUntrustedPasswordWrite(
  userId: string,
  { hash = hashPassword }: { hash?: (password: string) => Promise<string> } = {},
): Promise<void> {
  const unusable = await hash(randomBytes(32).toString("base64url"));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await withLockSlot(() =>
        prisma.$transaction(
          async (tx) => {
            await lockIdentityAuthority(tx);
            await tx.account.updateMany({
              where: { userId, providerId: "credential" },
              data: { password: unusable },
            });
          },
          { timeout: 10000, maxWait: 5000 },
        ),
      );
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
  await revokeCredentialsAfterPasswordReset(userId);
}
