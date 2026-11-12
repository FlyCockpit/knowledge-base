import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@knowledge-base/db/client";
import { z } from "zod";
import { isUserBanned } from "./ban";
import { isAdminRole } from "./roles";
import {
  FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
} from "./two-factor-policy";

const adminMutationActor = new AsyncLocalStorage<string>();

/** Only the authenticated HTTP gate and the admitted invitation path set this scope. */
export function runWithAdminMutationActor<T>(userId: string, run: () => T): T {
  return adminMutationActor.run(userId, run);
}

export function getAdminMutationActor(): string | undefined {
  return adminMutationActor.getStore();
}

const liveAdminSchema = z.object({
  role: z.string().nullable(),
  emailVerified: z.boolean(),
  banned: z.boolean().nullable(),
  banExpires: z.date().nullable(),
  twoFactorEnabled: z.boolean().nullable(),
  createdAt: z.date(),
  twoFactorGraceStartedAt: z.date().nullish(),
  forcedTwoFactorValue: z.string().nullish(),
});

/** Caller owns the identity-authority lock on this committing transaction.
 * Capture outgoing policy, then recheck time-based requirements before commit.
 */
export async function readLiveAdminPolicy(
  tx: { $queryRaw: (sql: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> },
  userId: string,
  denied: () => Error,
) {
  const rows = await tx.$queryRaw`SELECT role, "emailVerified", banned, "banExpires",
      "twoFactorEnabled", "createdAt", "twoFactorGraceStartedAt",
      (SELECT value FROM app_setting WHERE key = 'force2faInternalUsers') AS "forcedTwoFactorValue"
    FROM "user" WHERE id = ${userId}`;
  const parsed = z.array(liveAdminSchema).safeParse(rows);
  const actor = parsed.success ? parsed.data[0] : undefined;
  if (!actor?.emailVerified || !isAdminRole(actor.role) || isUserBanned(actor)) throw denied();
  const forced = isForcedTwoFactorEnabled(
    FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
    actor.forcedTwoFactorValue,
  );
  const check = () => {
    if (isUserBanned(actor) || !isTwoFactorRequirementSatisfied(actor, forced)) throw denied();
  };
  check();
  return { actor, check };
}

type SessionSnapshot = { token?: unknown; userId?: unknown } | null | undefined;
type UserSnapshot = { id?: unknown; authorityVersion?: unknown } | null | undefined;

/**
 * Version of Better Auth's signed session cookie cache, bound to the cached
 * snapshot itself.
 *
 * Better Auth calls this with the session and user it is about to cache (when
 * writing) or has cached (when reading), and reuses the cache only while the
 * two answers are equal. The answer depends on whether THIS snapshot is still
 * the live state, read in one indexed query:
 *   - the session row (by token, for this user) still exists and is unexpired;
 *   - the snapshot's `authorityVersion` equals the live user's. A database
 *     trigger bumps it on every change to an authority-relevant column (role,
 *     email and verification, ban, 2FA, grace start) and on credential changes,
 *     whatever wrote it (Better Auth, Prisma or raw SQL).
 * A current snapshot yields the durable restore epoch (so a restore still
 * invalidates every cache). A stale or revoked snapshot yields a fresh random
 * nonce that never matches anything: a snapshot loaded before a concurrent
 * reset or demotion can be written to the cookie, but never reused. Unchanged
 * sessions keep the cache and skip Better Auth's full session/user load.
 */
export function createSessionCacheVersion(db: Pick<PrismaClient, "$queryRaw">) {
  return async (session?: SessionSnapshot, user?: UserSnapshot): Promise<string> => {
    const token = typeof session?.token === "string" ? session.token : null;
    const userId = typeof user?.id === "string" ? user.id : null;
    const rows = await db.$queryRaw<
      Array<{ identity: string | null; authorityVersion: number | null }>
    >`SELECT
        (SELECT value FROM app_setting WHERE key = 'kb.instance.identity') AS identity,
        (SELECT u."authorityVersion" FROM session s JOIN "user" u ON u.id = s."userId"
          WHERE s.token = ${token} AND s."userId" = ${userId}
            AND s."expiresAt" > now()) AS "authorityVersion"`;
    const row = rows[0];
    const epoch = parseEpoch(row?.identity ?? null);
    const live = row?.authorityVersion;
    const snapshot = user?.authorityVersion;
    if (
      typeof live !== "number" ||
      typeof snapshot !== "number" ||
      live !== snapshot ||
      (typeof session?.userId === "string" && session.userId !== userId)
    ) {
      return `stale.${randomUUID()}`;
    }
    return epoch;
  };
}

function parseEpoch(value: string | null): string {
  if (value === null) return "1";
  const identity: unknown = JSON.parse(value);
  if (
    !identity ||
    typeof identity !== "object" ||
    !("authorityEpoch" in identity) ||
    typeof identity.authorityEpoch !== "string" ||
    !/^[1-9][0-9]{0,31}$/.test(identity.authorityEpoch)
  ) {
    throw new Error("Invalid session authority epoch");
  }
  return identity.authorityEpoch;
}
