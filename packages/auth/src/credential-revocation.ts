import prisma from "@knowledge-base/db";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import { revokeUserMcpGrants } from "./ban.js";

/** Reset sweeps retire pending 2FA logins and every browser session as well. */
export async function revokeCredentialsAfterPasswordReset(userId: string): Promise<void> {
  await revokeCredentials(userId, "password_reset");
}

/** Better Auth owns session rotation/revocation for a successful password change. */
export async function revokeCredentialsAfterPasswordChange(userId: string): Promise<void> {
  await revokeCredentials(userId, "password_change");
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
): Promise<void> {
  // Each retry gets a fresh transaction; partial tombstones roll back together.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await prisma.$transaction(
        async (tx) => {
          await lockIdentityAuthority(tx);
          await revokeUserMcpGrants(
            (sql, params) => tx.$executeRawUnsafe(sql, ...params),
            userId,
            reason,
          );
          await tx.deviceCode.deleteMany({ where: { userId } });
          if (reason !== "password_reset") return;
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
      );
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}
