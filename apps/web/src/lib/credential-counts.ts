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
 * Whether an AI client can reach this user's knowledge bases over MCP (the
 * home's "Connect an AI client" step): a live personal access token, an MCP
 * token minted by an API key (a child may outlive its key, so it counts too),
 * or a connected OAuth app. An API key alone is the REST control plane, not
 * an MCP client, so it does not count.
 */
export function hasConnectedClient(counts: ActiveCredentialCounts): boolean {
  return counts.tokens + counts.childTokens + counts.apps > 0;
}
