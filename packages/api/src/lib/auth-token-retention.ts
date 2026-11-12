import { settleLapsedTwoFactorMcpGrants } from "@knowledge-base/auth/ban";
import prisma from "@knowledge-base/db";
import type { PrismaClient } from "@knowledge-base/db/client";

const AUTH_TOKEN_SWEEP_PAGE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** DPoP replay reservations (Better Auth verification rows) already store verifier expiry + 1s. */
const DPOP_PROOF_PREFIX = "dpop-proof:";

export type ReapedAuthTokens = {
  sessions: number;
  verifications: number;
  deviceCodes: number;
  deviceApprovals: number;
  oauthAccessTokens: number;
  oauthRefreshTokens: number;
  clientAssertions: number;
  consentIntents: number;
};

type RetentionDb = Pick<
  PrismaClient,
  | "session"
  | "verification"
  | "deviceCode"
  | "deviceApproval"
  | "oauthAccessToken"
  | "oauthRefreshToken"
  | "oauthClientAssertion"
  | "consentIntent"
  | "$queryRaw"
  | "$transaction"
>;

/**
 * Delete matching rows a bounded id page at a time. `deleteMany` has no `take`, so a page of
 * ids is selected (ordered by id) and deleted by `id IN (…)` until a short page.
 */
async function sweep(
  find: (take: number) => Promise<Array<{ id: string }>>,
  remove: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await find(AUTH_TOKEN_SWEEP_PAGE);
    if (rows.length === 0) break;
    const result = await remove(rows.map((row) => row.id));
    if (result.count === 0) break;
    deleted += result.count;
    if (rows.length < AUTH_TOKEN_SWEEP_PAGE) break;
  }
  return deleted;
}

const page = { select: { id: true }, orderBy: { id: "asc" } } as const;
const ids = (list: string[]) => ({ where: { id: { in: list } } });

/**
 * A rotated refresh token is kept until its whole family (same client, user and approval
 * reference) is past expiry + 24h, so reuse of a rotated token stays detectable while any
 * member lives. Deleting a refresh token cascades its access tokens.
 */
async function sweepRefreshFamilies(db: RetentionDb, cutoff: Date): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM oauth_refresh_token t
       WHERE t."expiresAt" < ${cutoff}
         AND NOT EXISTS (
           SELECT 1 FROM oauth_refresh_token f
            WHERE f."clientId" = t."clientId" AND f."userId" = t."userId"
              AND f."referenceId" IS NOT DISTINCT FROM t."referenceId"
              AND t."referenceId" IS NOT NULL
              AND f."expiresAt" >= ${cutoff})
       ORDER BY t.id LIMIT ${AUTH_TOKEN_SWEEP_PAGE}`;
    if (rows.length === 0) break;
    const result = await db.oauthRefreshToken.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    if (result.count === 0) break;
    deleted += result.count;
    if (rows.length < AUTH_TOKEN_SWEEP_PAGE) break;
  }
  return deleted;
}

/**
 * Credential artifact retention. Sessions die at expiry; codes, device artifacts
 * and OAuth tokens 24h after expiry (replay/reuse evidence window); DPoP replay rows at
 * their stored expiry (verifier expiry + 1s). Grant tombstones, approved consent receipts
 * and JWKS are never deleted here.
 */
export async function reapExpiredAuthTokens(
  now: Date = new Date(),
  db: RetentionDb = prisma,
): Promise<{ deleted: ReapedAuthTokens }> {
  // Production daily scheduler settles quiet holders; transition writers close
  // the deadline-to-enrollment/policy race independently of this cadence.
  await settleLapsedTwoFactorMcpGrants(db);
  const grace = new Date(now.getTime() - DAY_MS);
  const sessions = await sweep(
    (take) => db.session.findMany({ ...page, take, where: { expiresAt: { lt: now } } }),
    (list) => db.session.deleteMany(ids(list)),
  );
  const verifications = await sweep(
    (take) =>
      db.verification.findMany({
        ...page,
        take,
        where: {
          OR: [
            { identifier: { startsWith: DPOP_PROOF_PREFIX }, expiresAt: { lt: now } },
            { NOT: { identifier: { startsWith: DPOP_PROOF_PREFIX } }, expiresAt: { lt: grace } },
          ],
        },
      }),
    (list) => db.verification.deleteMany(ids(list)),
  );
  const deviceCodes = await sweep(
    (take) => db.deviceCode.findMany({ ...page, take, where: { expiresAt: { lt: grace } } }),
    (list) => db.deviceCode.deleteMany(ids(list)),
  );
  const deviceApprovals = await sweep(
    (take) => db.deviceApproval.findMany({ ...page, take, where: { expiresAt: { lt: grace } } }),
    (list) => db.deviceApproval.deleteMany(ids(list)),
  );
  const oauthRefreshTokens = await sweepRefreshFamilies(db, grace);
  const oauthAccessTokens = await sweep(
    (take) => db.oauthAccessToken.findMany({ ...page, take, where: { expiresAt: { lt: grace } } }),
    (list) => db.oauthAccessToken.deleteMany(ids(list)),
  );
  const clientAssertions = await sweep(
    (take) =>
      db.oauthClientAssertion.findMany({ ...page, take, where: { expiresAt: { lt: grace } } }),
    (list) => db.oauthClientAssertion.deleteMany(ids(list)),
  );
  // Only abandoned consent transactions: an approved intent is the grant's immutable receipt.
  const consentIntents = await sweep(
    (take) =>
      db.consentIntent.findMany({
        ...page,
        take,
        where: { approvedAt: null, grantId: null, expiresAt: { lt: grace } },
      }),
    (list) => db.consentIntent.deleteMany(ids(list)),
  );
  return {
    deleted: {
      sessions,
      verifications,
      deviceCodes,
      deviceApprovals,
      oauthAccessTokens,
      oauthRefreshTokens,
      clientAssertions,
      consentIntents,
    },
  };
}
