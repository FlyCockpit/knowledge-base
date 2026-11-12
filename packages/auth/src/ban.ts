import { randomUUID } from "node:crypto";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import type { PrismaClient } from "@knowledge-base/db/client";
import {
  FORCE_2FA_DEFAULTS,
  FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
  FORCE_2FA_PUBLIC_USERS_SETTING_KEY,
  type ForceTwoFactorSettingKey,
  TWO_FACTOR_ENROLLMENT_GRACE_MS,
} from "./two-factor-policy";

/**
 * Ban-state predicate, shared by every surface that authenticates without going
 * through Better-Auth's own session-creation path.
 *
 * It lives here, dependency-free, so that every surface which re-implements the
 * admin rules for its own credential type applies an identical check. The
 * Better-Auth plugin gate (`apps/server/src/admin-session-gate.ts`) is the
 * current caller; keep new credential-resolving surfaces on this predicate
 * rather than re-deriving the ban rule.
 *
 * Why any of them need it: the admin plugin only rejects a banned user when a
 * session is CREATED (`session.create.before`). It never re-checks on
 * `getSession`, and with the 60s cookie cache an already-issued session keeps
 * working for up to a minute after a ban. Credentials that are not sessions at
 * all — an API key row, a device token — are never re-checked by the plugin on
 * any request. `users.archive` therefore sets `banned` AND deletes sessions AND
 * disables API keys, and these gates close the remaining windows.
 */
export function isUserBanned(user: {
  banned?: boolean | null;
  banExpires?: Date | string | null;
}): boolean {
  if (!user.banned) return false;
  // A lapsed temporary ban is not a ban. `banExpires: null` on a banned user
  // means permanent — that is what `users.archive` writes.
  //
  // `banExpires` is accepted as a string as well as a Date, and that is not
  // defensive padding: on a Better-Auth cookie-cache HIT the session user is
  // revived from base64(JSON) and only `createdAt`/`updatedAt` are re-hydrated
  // into Dates (`better-auth/dist/api/routes/session.mjs:110-114`), so
  // `banExpires` arrives as an ISO string. Calling `.getTime()` on it throws a
  // TypeError, which — for a LAPSED ban, where the correct answer is "allow" —
  // turned a legitimate admin's request into a 500 until the cache expired.
  const expiresAt = user.banExpires ? new Date(user.banExpires).getTime() : null;
  // An unparseable value is treated as "no expiry", i.e. still banned. Failing
  // closed is right: this predicate only ever gates access.
  if (expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt <= Date.now()) return false;
  return true;
}

/**
 * Does this user write impose a PERMANENT ban? Only a permanent ban
 * revokes standing MCP grants; a temporary (dated) ban merely SUSPENDS them —
 * admission refuses while `isUserBanned` holds and admits the same credential
 * again once the ban lapses or is lifted. Suspension is therefore never stored
 * on a credential, so lifting a ban cannot resurrect a credential that was
 * revoked for any other reason (its tombstone is untouched).
 *
 * A ban write without a readable expiry is permanent (fail closed). Better
 * Auth's admin `banUser` always writes `banExpires` (a Date or null) alongside
 * `banned: true`, and `users.archive` writes `banExpires: null`.
 */
export function isPermanentBanWrite(update: { banned?: unknown; banExpires?: unknown }): boolean {
  if (update.banned !== true) return false;
  const expires = update.banExpires;
  if (expires === null || expires === undefined) return true;
  const at = expires instanceof Date || typeof expires === "string" ? new Date(expires) : null;
  return !at || Number.isNaN(at.getTime());
}

/** Executes one parameterized statement on the caller's authority-locked transaction. */
export type AuthorityStatementExecutor = (sql: string, params: unknown[]) => Promise<unknown>;

// Match String.trim() in roles.ts, including non-ASCII whitespace. An ASCII
// case pattern below matches JS's admin token without locale-dependent folding.
const roleTrimCharacters =
  "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/**
 * Tombstone every live MCP grant generation (and its PAT) of a user. The
 * caller holds the identity authority lock on the SAME transaction that
 * applies the permanent ban / removal. Tombstones are permanent: unban and
 * unarchive never clear `revokedAt`, so no old generation is ever reactivated —
 * the user must mint or consent to a fresh random generation.
 */
export async function revokeUserMcpGrants(
  exec: AuthorityStatementExecutor,
  userId: string,
  reason: "ban" | "account_removal" | "forced_2fa",
): Promise<void> {
  await exec(
    `UPDATE "mcp_personal_token" SET "revokedAt" = COALESCE("revokedAt", now())
      WHERE "userId" = $1 AND "revokedAt" IS NULL`,
    [userId],
  );
  await exec(
    `UPDATE "mcp_grant" SET "revokedAt" = COALESCE("revokedAt", now()), "revokeReason" = $2
      WHERE "userId" = $1 AND "revokedAt" IS NULL`,
    [userId, reason],
  );
}

/**
 * Forced-2FA revocation. Settle the due lapse using LIVE role, policy,
 * grace and enrollment on the caller's authority-locked transaction: the caller
 * MUST hold the authority lock on the SAME transaction as this statement (and,
 * for bearer admission, as its live identity read). The grant tombstone is
 * durable lapse evidence. Identity/policy writers use
 * withOutgoingTwoFactorMcpSettlement to retain evidence through the write and
 * settle again after imposing a new requirement. The paired PAT update
 * uses exactly the revoked grant IDs, in one statement/snapshot; never a sampled
 * user-wide callback that can destroy a generation issued after policy
 * relaxation. Null userId settles all populations without materializing a
 * holder list.
 */
export async function revokeLapsedTwoFactorMcpGrants(
  exec: AuthorityStatementExecutor,
  userId: string | null = null,
): Promise<void> {
  await exec(
    `WITH revoked AS (
       UPDATE "mcp_grant" g SET "revokedAt" = now(), "revokeReason" = 'forced_2fa'
        FROM "user" u
       WHERE g."userId" = u.id AND ($1::text IS NULL OR u.id = $1)
         AND g."revokedAt" IS NULL AND u."twoFactorEnabled" IS NOT TRUE
         AND COALESCE(u."twoFactorGraceStartedAt", u."createdAt") + ($2 * interval '1 millisecond')
             <= clock_timestamp()
         AND CASE WHEN EXISTS (
           SELECT 1 FROM regexp_split_to_table(u.role, ',') role
            WHERE btrim(role, $7::text) ~ '^[aA][dD][mM][iI][nN]$')
           THEN COALESCE((SELECT value = 'true' FROM app_setting WHERE key = $3), $5)
           ELSE COALESCE((SELECT value = 'true' FROM app_setting WHERE key = $4), $6)
         END
       RETURNING g.id
     )
     UPDATE "mcp_personal_token" t SET "revokedAt" = COALESCE(t."revokedAt", now())
      WHERE t."grantId" IN (SELECT id FROM revoked) AND t."revokedAt" IS NULL`,
    [
      userId,
      TWO_FACTOR_ENROLLMENT_GRACE_MS,
      FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
      FORCE_2FA_PUBLIC_USERS_SETTING_KEY,
      FORCE_2FA_DEFAULTS[FORCE_2FA_INTERNAL_USERS_SETTING_KEY],
      FORCE_2FA_DEFAULTS[FORCE_2FA_PUBLIC_USERS_SETTING_KEY],
      roleTrimCharacters,
    ],
  );
}

/**
 * Preserve outgoing lapse evidence while a policy/identity write waits on a row.
 * Authority is held by the caller through commit. The transaction-local witness
 * pins exact existing generations and their outgoing deadlines, without taking
 * user row locks or materializing an unbounded holder list in application memory.
 * Settle after the write and at the outer adapter callback's exit: row waits
 * and callback delays cannot hide a due lapse. Future witnesses survive only
 * within this uncommitted transaction; ON COMMIT DROP discards them before any
 * later enrolled/relaxed transaction. Rollback discards paired tombstones too.
 */
export async function withOutgoingTwoFactorMcpSettlement<R>(
  exec: AuthorityStatementExecutor,
  userId: string | null,
  write: () => Promise<R>,
): Promise<R> {
  const settlementId = randomUUID();
  await materializeCoveredTwoFactorGraceStarts(exec, userId);
  await exec(
    `CREATE TEMP TABLE IF NOT EXISTS kb_outgoing_2fa_grants (
       "settlementId" uuid NOT NULL, "grantId" uuid NOT NULL, "dueAt" timestamptz NOT NULL,
       PRIMARY KEY ("settlementId", "grantId")
     ) ON COMMIT DROP`,
    [],
  );
  await exec(
    `INSERT INTO pg_temp.kb_outgoing_2fa_grants ("settlementId", "grantId", "dueAt")
     SELECT $1::uuid, g.id,
            COALESCE(u."twoFactorGraceStartedAt", u."createdAt") + ($3 * interval '1 millisecond')
       FROM "mcp_grant" g JOIN "user" u ON g."userId" = u.id
      WHERE ($2::text IS NULL OR u.id = $2)
        AND g."revokedAt" IS NULL AND u."twoFactorEnabled" IS NOT TRUE
        AND CASE WHEN EXISTS (
          SELECT 1 FROM regexp_split_to_table(u.role, ',') role
           WHERE btrim(role, $8::text) ~ '^[aA][dD][mM][iI][nN]$')
          THEN COALESCE((SELECT value = 'true' FROM app_setting WHERE key = $4), $6)
          ELSE COALESCE((SELECT value = 'true' FROM app_setting WHERE key = $5), $7)
        END`,
    [
      settlementId,
      userId,
      TWO_FACTOR_ENROLLMENT_GRACE_MS,
      FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
      FORCE_2FA_PUBLIC_USERS_SETTING_KEY,
      FORCE_2FA_DEFAULTS[FORCE_2FA_INTERNAL_USERS_SETTING_KEY],
      FORCE_2FA_DEFAULTS[FORCE_2FA_PUBLIC_USERS_SETTING_KEY],
      roleTrimCharacters,
    ],
  );
  await revokeLapsedTwoFactorMcpGrants(exec, userId);
  const result = await write();
  await settleOutgoingTwoFactorMcpGrants(exec);
  await revokeLapsedTwoFactorMcpGrants(exec, userId);
  await settleOutgoingTwoFactorMcpGrants(exec);
  return result;
}

/** Caller owns the same authority transaction and its temporary witness table.
 * Re-run before returning an outer adapter callback; callbacks can delay commit
 * after an otherwise on-time UPDATE. This flag-free SQL consumes only due
 * generations, so future witnesses remain available until COMMIT/ROLLBACK.
 */
export async function settleOutgoingTwoFactorMcpGrants(
  exec: AuthorityStatementExecutor,
): Promise<void> {
  await exec(
    `WITH outgoing AS (
       DELETE FROM pg_temp.kb_outgoing_2fa_grants WHERE "dueAt" <= clock_timestamp()
       RETURNING "grantId"
     ), revoked AS (
       UPDATE "mcp_grant" g SET "revokedAt" = now(), "revokeReason" = 'forced_2fa'
        FROM outgoing o
       WHERE g.id = o."grantId" AND g."revokedAt" IS NULL
       RETURNING g.id
     )
     UPDATE "mcp_personal_token" t SET "revokedAt" = COALESCE(t."revokedAt", now())
      WHERE t."grantId" IN (SELECT id FROM revoked) AND t."revokedAt" IS NULL`,
    [],
  );
}

/**
 * SQL for "forced 2FA applies to a user with role `roleExpr`" under the live
 * AppSetting rows and {@link FORCE_2FA_DEFAULTS}. `$1`..`$5` are bound by
 * {@link forcedPolicyParams}; callers number their own parameters after them.
 */
function forcedForRoleSql(roleExpr: string): string {
  return `CASE WHEN EXISTS (
      SELECT 1 FROM regexp_split_to_table(${roleExpr}, ',') role
       WHERE btrim(role, $5::text) ~ '^[aA][dD][mM][iI][nN]$')
      THEN COALESCE((SELECT value = 'true' FROM app_setting WHERE key = $1), $3)
      ELSE COALESCE((SELECT value = 'true' FROM app_setting WHERE key = $2), $4)
    END`;
}

function forcedPolicyParams(): unknown[] {
  return [
    FORCE_2FA_INTERNAL_USERS_SETTING_KEY,
    FORCE_2FA_PUBLIC_USERS_SETTING_KEY,
    FORCE_2FA_DEFAULTS[FORCE_2FA_INTERNAL_USERS_SETTING_KEY],
    FORCE_2FA_DEFAULTS[FORCE_2FA_PUBLIC_USERS_SETTING_KEY],
    roleTrimCharacters,
  ];
}

/**
 * The enrollment grace starts when forced 2FA FIRST applies to a user.
 * `User.twoFactorGraceStartedAt` records that moment; NULL means the
 * requirement applied from account creation (or never yet), and the grace is
 * measured from `createdAt` — so a NULL never makes the grace endless. These
 * writers only ever fill a NULL: a recorded start is never moved later, so no
 * write can lengthen a grace that already began.
 *
 * Creation: a user the policy covers when created starts at `createdAt`.
 */
export async function recordTwoFactorGraceStartAtCreation(
  exec: AuthorityStatementExecutor,
  userId: string,
): Promise<void> {
  await exec(
    `UPDATE "user" u SET "twoFactorGraceStartedAt" = u."createdAt"
      WHERE u.id = $6 AND u."twoFactorGraceStartedAt" IS NULL
        AND ${forcedForRoleSql("u.role")}`,
    [...forcedPolicyParams(), userId],
  );
}

/**
 * Role change (promotion to admin, or any role write): when the policy did not
 * cover the user's current role but covers `nextRole`, the grace starts now.
 * Run on the caller's authority-locked transaction BEFORE the role write, inside
 * {@link withOutgoingTwoFactorMcpSettlement} (which has already written down
 * the start of a user the policy covers today, so a legacy NULL is never read
 * as "never covered").
 */
export async function recordTwoFactorGraceStartForRoleChange(
  exec: AuthorityStatementExecutor,
  userId: string,
  nextRole: string,
): Promise<void> {
  await exec(
    `UPDATE "user" u SET "twoFactorGraceStartedAt" = clock_timestamp()
      WHERE u.id = $6 AND u."twoFactorGraceStartedAt" IS NULL
        AND ${forcedForRoleSql("$7::text")}
        AND NOT ${forcedForRoleSql("u.role")}`,
    [...forcedPolicyParams(), userId, nextRole],
  );
}

const populationSql = `EXISTS (
          SELECT 1 FROM regexp_split_to_table(u.role, ',') role
           WHERE btrim(role, $2::text) ~ '^[aA][dD][mM][iI][nN]$') = $1`;

/**
 * NULL `twoFactorGraceStartedAt` is ambiguous: "covered since creation"
 * (measured from `createdAt`) or "never covered". Every identity and policy
 * write first writes down the effective start of each user the policy covers
 * RIGHT NOW (NULL → `createdAt`), for one user or (null) all users. That never
 * changes a current decision — the basis is `createdAt` either way — but it
 * means that after any later loss of coverage (demotion, policy off, any role
 * write) a NULL can only mean "never covered", so regaining coverage cannot
 * hand an already-covered user a second grace. Called by
 * {@link withOutgoingTwoFactorMcpSettlement}, the chokepoint every identity
 * and policy writer already goes through.
 */
export async function materializeCoveredTwoFactorGraceStarts(
  exec: AuthorityStatementExecutor,
  userId: string | null,
): Promise<void> {
  await exec(
    `UPDATE "user" u SET "twoFactorGraceStartedAt" = u."createdAt"
      WHERE ($6::text IS NULL OR u.id = $6) AND u."twoFactorGraceStartedAt" IS NULL
        AND ${forcedForRoleSql("u.role")}`,
    [...forcedPolicyParams(), userId],
  );
}

/**
 * Policy turned on (or widened to another population): every user of that
 * population whose grace never started begins it now. Run on the settings
 * write's authority-locked transaction, after the AppSetting write and before
 * its lapse settlement.
 */
export async function recordTwoFactorGraceStartForPolicyActivation(
  exec: AuthorityStatementExecutor,
  key: ForceTwoFactorSettingKey,
): Promise<void> {
  await exec(
    `UPDATE "user" u SET "twoFactorGraceStartedAt" = clock_timestamp()
      WHERE u."twoFactorGraceStartedAt" IS NULL AND ${populationSql}`,
    [key === FORCE_2FA_INTERNAL_USERS_SETTING_KEY, roleTrimCharacters],
  );
}

/** Bearer/scheduled entry: own the same authority lock and transaction as writers. */
export async function settleLapsedTwoFactorMcpGrants(
  db: Pick<PrismaClient, "$transaction">,
  userId: string | null = null,
): Promise<void> {
  await db.$transaction(
    async (tx) => {
      await lockIdentityAuthority(tx);
      await revokeLapsedTwoFactorMcpGrants(
        (sql, params) => tx.$executeRawUnsafe(sql, ...params),
        userId,
      );
    },
    { timeout: 10000, maxWait: 5000 },
  );
}
