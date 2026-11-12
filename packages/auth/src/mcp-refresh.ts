import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import type { PrismaClient } from "@knowledge-base/db/client";
import { assertConsentIdentity, consentSelection, McpConsentError } from "./mcp-consent";

export const MCP_ACCESS_TOKEN_LIFETIME_SECONDS = 600;
export const MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS = 72 * 60 * 60;
export const MCP_REFRESH_RETRY_WINDOW_SECONDS = 30;
export const refreshExpiry = (now: Date) =>
  new Date(now.getTime() + MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS * 1000);

/** Provider claims hook seam, not a token issuer. Never inserts grants/artifacts.
 * Input token scopes/expiry must come from the provider-verified refresh row.
 * Reference resolves the immutable approval, never an active sibling grant.
 * An upstream cached response may skip this hook; admission MUST still use
 * createGrantCredentialVerifier on each use, including cached token pairs.
 */
export async function issueMcpGenerationClaims(
  db: PrismaClient,
  input: {
    referenceId: string;
    grantId?: string;
    userId: string;
    clientId: string;
    resource: string;
    scopes: readonly string[];
    grantType: string;
    tokenScopes?: readonly string[];
    tokenExpiresAt?: Date;
  },
  clock: () => Date = () => new Date(),
) {
  const fail = (): never => {
    throw new McpConsentError();
  };
  return db.$transaction(
    async (tx) => {
      await lockIdentityAuthority(tx);
      const now = clock();
      await assertConsentIdentity(tx, input.userId);
      const intent = await tx.consentIntent.findUnique({
        where: { referenceId: input.referenceId },
        include: { grant: true },
      });
      const grant = intent?.grant;
      if (
        !intent?.approvedAt ||
        !grant ||
        grant.revokedAt ||
        grant.kind !== "OAUTH" ||
        grant.userId !== input.userId ||
        intent.userId !== input.userId ||
        intent.clientId !== input.clientId ||
        intent.resource !== input.resource ||
        grant.clientId !== input.clientId ||
        (input.grantId !== undefined && grant.id !== input.grantId)
      )
        return fail();
      if (input.grantType === "authorization_code") {
        if (intent.expiresAt <= now) return fail();
      } else if (input.grantType === "refresh_token") {
        if (
          !input.tokenExpiresAt ||
          !Number.isFinite(input.tokenExpiresAt.getTime()) ||
          input.tokenExpiresAt <= now ||
          !input.tokenScopes?.includes("offline_access") ||
          !intent.scopes.includes("offline_access") ||
          !grant.scopes.includes("offline_access") ||
          !input.scopes.every((s) => input.tokenScopes?.includes(s))
        )
          return fail();
      } else return fail();
      const approved = consentSelection.parse(intent.selection);
      if (
        input.scopes.length === 0 ||
        !input.scopes.some((s) => s === "mcp:read" || s === "mcp:write") ||
        !input.scopes.every(
          (s) =>
            approved.scopes.some((approvedScope) => approvedScope === s) &&
            grant.scopes.includes(s),
        )
      )
        return fail();
      return { mcp_grant_id: grant.id };
    },
    { timeout: 10000 },
  );
}

/** The transport supplies atomic SET NX with this absolute expiration. No cap. */
export async function reserveDpopProof(
  digest: string,
  verifierExpiry: Date,
  reserve: (digest: string, expiresAt: Date) => Promise<boolean>,
  now = new Date(),
): Promise<void> {
  if (
    !digest ||
    !Number.isFinite(verifierExpiry.getTime()) ||
    verifierExpiry <= now ||
    !(await reserve(digest, new Date(verifierExpiry.getTime() + 1000)))
  )
    throw new McpConsentError();
}
