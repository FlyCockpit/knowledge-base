import { createHmac, randomUUID } from "node:crypto";

import { MCP_PAT_SCOPES } from "./mcp-config";
import { isMcpToolGroup, MCP_TOOL_GROUPS, type McpToolGroup } from "./mcp-tool-groups";

/**
 * Application-owned MCP grant generation rules (pure; no Better Auth plugin
 * dependency — the OAuth provider wiring lands in a later chunk).
 *
 * A grant generation is a random UUID. Revocation writes a permanent tombstone;
 * a tombstoned generation is never reused, re-created under the same
 * reference, or reactivated by unban/unarchive. Re-consent always mints a new
 * random generation.
 */

/** Per-KB permission bits, in canonical order. Mirrors the API permission model. */
export const MCP_KB_PERMISSIONS = ["read", "propose", "write", "review", "manage"] as const;
export type McpKbPermission = (typeof MCP_KB_PERMISSIONS)[number];

/** Upper bound on per-grant ACL rows accepted from one human selection. */
export const MCP_GRANT_MAX_ACL_ENTRIES = 256;

export const MCP_CONSENT_REFERENCE_LENGTH = 64;
const CONSENT_REFERENCE_DOMAIN = "kb-mcp-consent-reference-v1";

export function newMcpGrantGeneration(): string {
  return randomUUID();
}

/** HMAC(session, client, nonce-bearing input) reference; never decodable to the session id. */
export function deriveMcpConsentReferenceId(input: {
  secret: string;
  sessionId: string;
  clientId: string;
  nonce: string;
}): string {
  if (!input.nonce) throw new McpGrantSelectionError("missing consent nonce");
  return createHmac("sha256", input.secret)
    .update(
      JSON.stringify([CONSENT_REFERENCE_DOMAIN, input.sessionId, input.clientId, input.nonce]),
    )
    .digest("hex");
}

export type McpGrantRecord = {
  id: string;
  userId: string;
  clientId: string;
  referenceId: string;
  revokedAt: Date | null;
};

export type McpGrantRejectReason =
  | "missing-user"
  | "missing-session"
  | "tombstone"
  | "inactive-on-refresh"
  | "missing-consent";

export type McpGrantDecision =
  | { action: "reuse"; grant: McpGrantRecord }
  | { action: "reject"; reason: McpGrantRejectReason };

/** Exact-reference decision: a tombstone always rejects; refresh never creates. */
export function resolveMcpGrantDecision(input: {
  grantType: "authorization_code" | "refresh_token";
  userId: string | undefined;
  referenceId: string | undefined;
  existing: McpGrantRecord | null;
}): McpGrantDecision {
  if (!input.userId) return { action: "reject", reason: "missing-user" };
  if (!input.referenceId) return { action: "reject", reason: "missing-session" };
  const existing = input.existing;
  if (existing?.revokedAt) return { action: "reject", reason: "tombstone" };
  if (input.grantType === "authorization_code") {
    return existing
      ? { action: "reuse", grant: existing }
      : { action: "reject", reason: "missing-consent" };
  }
  return existing
    ? { action: "reuse", grant: existing }
    : { action: "reject", reason: "inactive-on-refresh" };
}

export class McpGrantSelectionError extends Error {
  readonly name = "McpGrantSelectionError";
}

export type McpGrantSelection = {
  scopes: readonly string[];
  toolGroups: readonly string[];
  acl: readonly { kbId: string; bits: readonly string[] }[];
  allowCreate?: boolean;
  createdKbBits?: readonly string[];
};

export type McpGrantCeiling = {
  scopes: string[];
  toolGroups: McpToolGroup[];
  acl: { kbId: string; bits: McpKbPermission[] }[];
  allowCreate: boolean;
  createdKbBits: McpKbPermission[];
};

function isPermission(value: string): value is McpKbPermission {
  return (MCP_KB_PERMISSIONS as readonly string[]).includes(value);
}

function canonicalBits(bits: readonly string[], allowEmpty: boolean): McpKbPermission[] {
  if (!allowEmpty && bits.length === 0) throw new McpGrantSelectionError("empty permission set");
  if (new Set(bits).size !== bits.length) throw new McpGrantSelectionError("duplicate bit");
  for (const bit of bits) {
    if (!isPermission(bit)) throw new McpGrantSelectionError("unknown permission");
  }
  return MCP_KB_PERMISSIONS.filter((bit) => bits.includes(bit));
}

/** Non-empty, duplicate-free known groups, returned in canonical order. */
export function canonicalToolGroups(groups: readonly string[]): McpToolGroup[] {
  if (groups.length === 0) throw new McpGrantSelectionError("empty tool groups");
  if (new Set(groups).size !== groups.length) throw new McpGrantSelectionError("duplicate group");
  for (const group of groups) {
    if (!isMcpToolGroup(group)) throw new McpGrantSelectionError("unknown tool group");
  }
  return MCP_TOOL_GROUPS.filter((group) => groups.includes(group));
}

/**
 * Shape rules for a human grant selection (live-rights validation is the API's
 * job). Rejects instead of broadening or clipping:
 * - scopes: non-empty, unique, subset of mcp:read/mcp:write (no offline_access);
 * - toolGroups: non-empty, unique, known groups (stored in canonical order);
 * - allowCreate defaults false; createdKbBits must be empty unless allowCreate;
 * - allowCreate requires literal mcp:write and createdKbBits containing read;
 * - allowCreate requires the kb_admin tool group, which holds knowledge_bases_create
 *   (e2e decision 7);
 * - ACL: unique KB ids, non-empty known bits, bounded entry count.
 */
export function normalizeGrantCeiling(selection: McpGrantSelection): McpGrantCeiling {
  const scopes = selection.scopes;
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) {
    throw new McpGrantSelectionError("invalid scopes");
  }
  for (const scope of scopes) {
    if (!(MCP_PAT_SCOPES as readonly string[]).includes(scope)) {
      throw new McpGrantSelectionError("invalid scopes");
    }
  }
  const toolGroups = canonicalToolGroups(selection.toolGroups);
  const allowCreate = selection.allowCreate ?? false;
  const createdKbBits = canonicalBits(selection.createdKbBits ?? [], true);
  if (!allowCreate && createdKbBits.length > 0) {
    throw new McpGrantSelectionError("created KB bits require allowCreate");
  }
  if (allowCreate) {
    if (!scopes.includes("mcp:write")) throw new McpGrantSelectionError("create needs mcp:write");
    if (!createdKbBits.includes("read")) throw new McpGrantSelectionError("created bits need read");
    if (!toolGroups.includes("kb_admin"))
      throw new McpGrantSelectionError("create needs the kb_admin tool group");
  }
  if (selection.acl.length > MCP_GRANT_MAX_ACL_ENTRIES) {
    throw new McpGrantSelectionError("too many ACL entries");
  }
  const seen = new Set<string>();
  const acl = selection.acl.map((entry) => {
    if (seen.has(entry.kbId)) throw new McpGrantSelectionError("duplicate KB");
    seen.add(entry.kbId);
    return { kbId: entry.kbId, bits: canonicalBits(entry.bits, false) };
  });
  return {
    scopes: MCP_PAT_SCOPES.filter((scope) => scopes.includes(scope)),
    toolGroups,
    acl,
    allowCreate,
    createdKbBits,
  };
}

/** Canonical transitive KB bits shared by consent and live API authorization. */
export function expandMcpBits(bits: readonly string[]): McpKbPermission[] {
  const implied: Record<McpKbPermission, readonly McpKbPermission[]> = {
    read: ["read"],
    propose: ["read", "propose"],
    write: ["read", "propose", "write"],
    review: ["read", "review"],
    manage: MCP_KB_PERMISSIONS,
  };
  const expanded = new Set(bits.filter(isPermission).flatMap((bit) => implied[bit]));
  return MCP_KB_PERMISSIONS.filter((bit) => expanded.has(bit));
}
