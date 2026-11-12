import { z } from "zod";

/**
 * Pure MCP credential configuration (no env reads, no IO).
 *
 * Token lifetimes and budgets are named code constants, not operator tuning
 * The canonical resource is `<origin>/mcp`; the issuer is
 * `<origin>/api/auth`. OAuth-only knobs (access/refresh lifetimes) land with
 * the OAuth provider chunk.
 */

/** Scopes a personal access token may carry. PATs never carry offline_access. */
export const MCP_PAT_SCOPES = ["mcp:read", "mcp:write"] as const;
export type McpPatScope = (typeof MCP_PAT_SCOPES)[number];

/** Live (unrevoked, unexpired, live-grant) PATs per user; enforced under the user row lock. */
export const MCP_PAT_MAX_ACTIVE_PER_USER = 10;
export const MCP_PAT_DEFAULT_TTL_DAYS = 90;
export const MCP_PAT_MAX_TTL_DAYS = 365;
export const MCP_PAT_NAME_MAX_LENGTH = 120;

/** Single-line Unicode display text. C0, DEL and C1 controls are unsupported,
 * including tab/CR/LF at either end; reject before trimming for all PAT mints. */
export const patDisplayName = z
  .string()
  .refine((value) =>
    [...value].every((c) => {
      const code = c.codePointAt(0)!;
      return code >= 32 && (code < 127 || code > 159);
    }),
  )
  .trim()
  .min(1)
  .max(MCP_PAT_NAME_MAX_LENGTH);

/** Synthetic grant client id for one PAT generation; reference is fixed. */
export const MCP_PAT_CLIENT_ID_PREFIX = "pat:";
export const MCP_PAT_GRANT_REFERENCE = "pat";

const DAY_MS = 86_400_000;

export class McpPatExpiryError extends Error {
  readonly name = "McpPatExpiryError";
}

/**
 * Resolve a requested DATED PAT expiry (the device flow and every dated human
 * mint). Omission is exactly now+90d. A present value must be a valid instant
 * strictly in the future and at most now+365d; null/invalid values are rejected
 * rather than coerced. A never-expiring PAT exists only through
 * {@link resolvePatMintExpiry}'s explicit null.
 */
export function resolvePatExpiry(requested: Date | undefined, now: Date): Date {
  if (requested === undefined) return new Date(now.getTime() + MCP_PAT_DEFAULT_TTL_DAYS * DAY_MS);
  if (!(requested instanceof Date) || Number.isNaN(requested.getTime())) {
    throw new McpPatExpiryError("PAT expiry must be a valid timestamp");
  }
  if (requested.getTime() <= now.getTime()) {
    throw new McpPatExpiryError("PAT expiry must be in the future");
  }
  if (requested.getTime() > now.getTime() + MCP_PAT_MAX_TTL_DAYS * DAY_MS) {
    throw new McpPatExpiryError("PAT expiry exceeds the maximum lifetime");
  }
  return requested;
}

/**
 * Human PAT mint expiry (mirrors ws-model-proxy): omitted = now+90d, a
 * dated expiry is bounded by {@link resolvePatExpiry}, and an explicit `null`
 * is the user's "No expiry" choice — the token then never expires and stays
 * valid until revoked (bans, forced 2FA and account removal still apply).
 */
export function resolvePatMintExpiry(requested: Date | null | undefined, now: Date): Date | null {
  return requested === null ? null : resolvePatExpiry(requested, now);
}

/** RFC 8707 resource identifier for this MCP server. */
export function canonicalMcpResource(baseUrl: string): string {
  return new URL("/mcp", baseUrl).toString();
}

/**
 * Split an OAuth scope claim on ASCII space only. Tokens are literal (no
 * trimming, no case folding); a padded string grants nothing.
 */
export function parseMcpScopes(scope: string | readonly string[] | null | undefined): string[] {
  if (typeof scope === "string") {
    if (scope !== scope.trim()) return [];
    return [...new Set(scope.split(" ").filter((entry) => entry.length > 0))];
  }
  return [...new Set(scope ?? [])];
}

/** Read needs mcp:read OR mcp:write; mutation needs the literal mcp:write. */
export function mcpScopesAllow(
  scope: string | readonly string[] | null | undefined,
  requirement: "read" | "write",
): boolean {
  const granted = new Set(parseMcpScopes(scope));
  if (requirement === "write") return granted.has("mcp:write");
  return granted.has("mcp:read") || granted.has("mcp:write");
}
