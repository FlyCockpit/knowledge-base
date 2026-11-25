/** The live-credential counts `mcpGrants.countActiveMine` returns. */
export type ActiveCredentialCounts = {
  tokens: number;
  apps: number;
  apiKeys: number;
  /** MCP tokens minted by an API key, including ones that outlived their key. */
  childTokens: number;
};

/**
 * Whether anything still works after a password reset. Every family counts on
 * its own: an independent child token outlives its API key, so a user with
 * only such tokens left must still be offered "Revoke all".
 */
export function hasLiveCredentials(counts: ActiveCredentialCounts | undefined): boolean {
  if (!counts) return false;
  return counts.tokens + counts.apps + counts.apiKeys + counts.childTokens > 0;
}

/**
 * The dashboard's "active access tokens": personal access tokens and MCP
 * tokens minted by API keys (a child may outlive its key, so it counts too).
 */
export function activeTokenCount(counts: ActiveCredentialCounts): number {
  return counts.tokens + counts.childTokens;
}
