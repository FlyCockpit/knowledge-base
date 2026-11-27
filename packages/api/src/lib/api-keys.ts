import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  authoringModeFromDb,
  authoringModeToDb,
  MCP_AUTHORING_MODES,
  type McpAuthoringMode,
} from "@knowledge-base/auth/mcp-authoring-mode";
import {
  MCP_PAT_DEFAULT_TTL_DAYS,
  McpPatExpiryError,
  patDisplayName,
  resolvePatExpiry,
} from "@knowledge-base/auth/mcp-config";
import { MCP_GRANT_MAX_ACL_ENTRIES, newMcpGrantGeneration } from "@knowledge-base/auth/mcp-grant";
import { MCP_TOOL_GROUPS, type McpToolGroup } from "@knowledge-base/auth/mcp-tool-groups";
import { z } from "zod";
import { recordAuditEvent } from "./kb/audit";
import { KbDomainError } from "./kb/errors";
import { readInstanceLimit } from "./kb/instance-limits";
import { chargeRate, KB_LIMITS, type RatePort } from "./kb/limits";
import type { LockQuery } from "./kb/lock";
import { canonicalRequestHash } from "./kb/operation-intent";
import { authorize, expandBits, type Permission, sqlAuthorityStore } from "./kb/permissions";
import { assertTokenAdmissible, KbAdmissionError, type TokenPrincipal } from "./kb/principal";
import {
  API_KEY_CHILD_REVOKE_ACTION,
  API_KEY_REVOKE_ACTION,
  aclKbNameSql,
  assertLiveCredentialSession,
  type BrowserCredentialActor,
  createGrantCredentialVerifier,
  inAuthorityTransaction,
  kbIdSchema,
  lockLiveUser,
  type MintedPersonalToken,
  mintPersonalTokenInTransaction,
  pageInput,
  permissionSchema,
  type Runtime,
  toDate,
  tombstoneApiKeyChildren,
  tombstoneGrant,
  validateAclAgainstLive,
} from "./mcp-token-access";

/**
 * REST API keys: the human-minted control-plane credential (`kbk_…`).
 *
 * - A key is one `API_KEY` grant generation plus this row. The grant carries
 *   the key's own KB ceiling (GrantKbAcl for SELECTED and created KBs,
 *   `allKbsBits` for reach ALL) and `allowCreate`; this row carries the
 *   secret digest, expiry, `allowDelete`, `allowMintChildren` and the child
 *   ceilings. Nothing about a key is editable after mint; it is only revoked.
 * - Admission is the shared grant verifier with an API_KEY credential binding
 *   (exact generation, grant and key tombstones, key expiry, live ban and
 *   forced 2FA). Authority is always that ceiling ∩ the owner's live bits.
 * - Child tokens are ordinary PATs whose row names the key
 *   (`parentApiKeyId`); they are live only while the key is, and revoking the
 *   key tombstones them in the same transaction.
 * - Minting a key is human-only (browser session); a key mints only children,
 *   and a child mints nothing.
 */

export const API_KEY_PREFIX = "kbk_";
const API_KEY_PATTERN = /^kbk_([a-z0-9]{16})_([A-Za-z0-9_-]{43})$/;
const DIGEST_DOMAIN = "kb-api-key-digest-v1\0";
export const API_KEY_CLIENT_ID_PREFIX = "apikey:";
const API_KEY_GRANT_REFERENCE = "api_key";
/** The key grant's own scope: list/get read, create/delete/mint mutate. */
const API_KEY_GRANT_SCOPES = ["mcp:write"] as const;
const LIST_DEFAULT = 20;
const DAY_MS = 86_400_000;

export const API_KEY_REACHES = ["all", "selected", "created"] as const;
export type ApiKeyReach = (typeof API_KEY_REACHES)[number];
const REACH_TO_DB = { all: "ALL", selected: "SELECTED", created: "CREATED" } as const;
const REACH_FROM_DB: Record<string, ApiKeyReach> = {
  ALL: "all",
  SELECTED: "selected",
  CREATED: "created",
};

/**
 * Tool groups a child may carry: every PAT group. `sealed` (and child KB
 * creation) are explicit opt-ins at key mint; sealed values still need the
 * owner's exact per-token approval.
 */
export const API_KEY_CHILD_TOOL_GROUPS = MCP_TOOL_GROUPS;
/** A key's default lifetime; a date may be at most 365 days out, or null = never expires. */
const API_KEY_DEFAULT_TTL_DAYS = 365;

/** The REST API's resource identifier, bound into every API-key principal. */
export function canonicalApiResource(baseUrl: string): string {
  return new URL("/api/v1", baseUrl).toString();
}

export function generateApiKeySecret(): { secret: string; lookupPrefix: string } {
  const lookupPrefix = randomBytes(8).toString("hex");
  const body = randomBytes(32).toString("base64url");
  return { secret: `${API_KEY_PREFIX}${lookupPrefix}_${body}`, lookupPrefix };
}

export function apiKeyLookupPrefix(raw: string): string | null {
  return API_KEY_PATTERN.exec(raw)?.[1] ?? null;
}

export function digestApiKeySecret(raw: string): string {
  return createHash("sha256").update(DIGEST_DOMAIN).update(raw, "utf8").digest("hex");
}

function digestMatches(raw: string, stored: string): boolean {
  const presented = Buffer.from(digestApiKeySecret(raw), "hex");
  const expected = Buffer.from(stored, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const invalid = () => new KbDomainError("INVALID_ARGUMENT", "Invalid API key request");
const forbidden = () => new KbDomainError("FORBIDDEN", "Forbidden");
const keyNotFound = () => new KbDomainError("NOT_FOUND", "API key not found");
const tokenNotFound = () => new KbDomainError("NOT_FOUND", "Token not found");

function canonicalGroups(groups: readonly string[]): McpToolGroup[] {
  const set = new Set(groups);
  if (set.size !== groups.length) throw invalid();
  return MCP_TOOL_GROUPS.filter((group) => set.has(group));
}

/** Child write mode `child` within the key's ceiling `max` (null = read-only). */
function authoringWithin(child: McpAuthoringMode | null, max: McpAuthoringMode | null): boolean {
  if (child === null) return true;
  if (max === null) return false;
  return max === "both" || child === max;
}

// --- identification ---------------------------------------------------------

/** Identification only: the returned principal still needs verifier-backed admission. */
export async function authenticateApiKey(
  query: LockQuery,
  raw: string,
  now: Date,
  resource: string,
): Promise<TokenPrincipal | null> {
  const lookupPrefix = apiKeyLookupPrefix(raw);
  if (!lookupPrefix) return null;
  const result = await query<{
    id: string;
    userId: string | null;
    grantId: string;
    secretDigest: string;
    expiresAt: Date | string | null;
    revokedAt: Date | string | null;
  }>(
    `SELECT id, "userId", "grantId"::text AS "grantId", "secretDigest", "expiresAt", "revokedAt"
       FROM "api_key" WHERE "lookupPrefix" = $1`,
    [lookupPrefix],
  );
  const row = result.rows[0];
  if (!row || !digestMatches(raw, row.secretDigest)) return null;
  // NULL = never expires; a present but unreadable value fails closed.
  const expiresAt = row.expiresAt === null ? null : toDate(row.expiresAt);
  if (row.revokedAt || !row.userId) return null;
  if (row.expiresAt !== null && (!expiresAt || expiresAt <= now)) return null;
  return {
    kind: "token",
    userId: row.userId,
    grantId: row.grantId,
    grantGeneration: row.grantId,
    scopes: [...API_KEY_GRANT_SCOPES],
    expiresAt,
    storedAcl: new Map(),
    credential: {
      kind: "API_KEY",
      clientId: `${API_KEY_CLIENT_ID_PREFIX}${row.id}`,
      resource,
      tokenId: row.id,
    },
  };
}

/** The key id of an API-key principal; anything else is refused. */
export function apiKeyIdOf(principal: TokenPrincipal): string {
  const binding = principal.credential;
  if (binding?.kind !== "API_KEY" || !binding.tokenId) {
    throw new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
  }
  return binding.tokenId;
}

/** Record use at most once a minute (never part of admission). */
export async function touchApiKey(query: LockQuery, apiKeyId: string): Promise<void> {
  await query(
    `UPDATE "api_key" SET "lastUsedAt" = now()
      WHERE id = $1 AND ("lastUsedAt" IS NULL OR "lastUsedAt" < now() - interval '1 minute')`,
    [apiKeyId],
  );
}

// --- human control plane: mint, list, revoke --------------------------------

export const apiKeyMintInput = z.strictObject({
  name: patDisplayName,
  reach: z.enum(API_KEY_REACHES),
  /** reach "selected" only: the KBs, each validated against live rights. */
  kbIds: z.array(kbIdSchema).max(MCP_GRANT_MAX_ACL_ENTRIES).optional(),
  /** The key's per-KB ceiling (expanded), for itself and its children. */
  bits: z.array(permissionSchema).min(1).max(5),
  allowCreate: z.boolean().optional(),
  allowDelete: z.boolean().optional(),
  allowMintChildren: z.boolean().optional(),
  childToolGroups: z
    .array(z.enum(API_KEY_CHILD_TOOL_GROUPS))
    .min(1)
    .max(API_KEY_CHILD_TOOL_GROUPS.length)
    .optional(),
  /** The children's write-mode ceiling; null/omitted = read-only children. */
  childAuthoringMode: z.enum(MCP_AUTHORING_MODES).nullable().optional(),
  /** Children may create KBs (an explicit opt-in; off by default). */
  childAllowCreate: z.boolean().optional(),
  /**
   * Children end when this key ends (revoked or expired), and a child's
   * expiry is capped at the key's. Off (the default): children are
   * independent and outlive the key.
   */
  childrenEndWithKey: z.boolean().optional(),
  /** Omitted = now + 365 days; a date must be in the future and at most 365 days out; null = never expires. */
  expiresAt: z.coerce.date().nullable().optional(),
});
export type ApiKeyMintInput = z.input<typeof apiKeyMintInput>;

export type ApiKeyView = {
  id: string;
  name: string;
  lookupPrefix: string;
  grantId: string;
  reach: ApiKeyReach;
  bits: Permission[];
  allowCreate: boolean;
  allowDelete: boolean;
  allowMintChildren: boolean;
  childToolGroups: string[];
  childAuthoringMode: McpAuthoringMode | null;
  childAllowCreate: boolean;
  childrenEndWithKey: boolean;
  createdAt: Date;
  /** null = never expires. */
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** Live (unrevoked, unexpired) children right now. */
  liveChildren: number;
  /** Explicitly chosen and created KBs (GrantKbAcl rows); reach ALL adds every KB. */
  kbCount: number;
};

const KEY_VIEW_SQL = `SELECT k.id, k.name, k."lookupPrefix", k."grantId"::text AS "grantId",
        k.reach::text AS reach, k.bits, g."allowCreate", k."allowDelete", k."allowMintChildren",
        k."childToolGroups", k."childAuthoringMode"::text AS "childAuthoringMode",
        k."childAllowCreate", k."childrenEndWithKey",
        k."createdAt", k."expiresAt", k."lastUsedAt",
        CASE WHEN k."revokedAt" IS NOT NULL THEN k."revokedAt" ELSE g."revokedAt" END AS "revokedAt",
        (SELECT COUNT(*)::int FROM mcp_personal_token t JOIN mcp_grant cg ON cg.id = t."grantId"
          WHERE t."parentApiKeyId" = k.id AND t."revokedAt" IS NULL AND cg."revokedAt" IS NULL
            AND (t."expiresAt" IS NULL OR t."expiresAt" > now())) AS "liveChildren",
        (SELECT COUNT(*)::int FROM grant_kb_acl a WHERE a."grantId" = k."grantId") AS "kbCount"
   FROM api_key k JOIN mcp_grant g ON g.id = k."grantId"`;

type KeyViewRow = Omit<ApiKeyView, "reach" | "childAuthoringMode" | "bits"> & {
  reach: string;
  bits: string[];
  childAuthoringMode: string | null;
};

function toKeyView(row: KeyViewRow): ApiKeyView {
  return {
    ...row,
    reach: REACH_FROM_DB[row.reach] ?? "created",
    bits: expandBits(row.bits ?? []),
    childAuthoringMode: authoringModeFromDb(row.childAuthoringMode),
  };
}

/**
 * Human mint. One authority-lock transaction under the user row lock: live
 * identity, every selected KB's bits held live (rejected, never clipped), the
 * live-key cap, then the API_KEY grant, its ACL rows and the digest-only key
 * row. The raw secret exists only in the return value.
 */
export async function mintBrowserApiKey(
  runtime: Runtime,
  actor: BrowserCredentialActor,
  raw: ApiKeyMintInput,
): Promise<{ key: ApiKeyView; secret: string }> {
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await assertLiveCredentialSession(query, actor);
    return mintApiKeyInTransaction(query, opId, actor.userId, raw);
  });
}

/** Trusted internal mint; browser routes use mintBrowserApiKey. */
export async function mintApiKey(
  runtime: Runtime,
  userId: string,
  raw: ApiKeyMintInput,
  deps: { generateSecret?: typeof generateApiKeySecret; now?: () => Date } = {},
): Promise<{ key: ApiKeyView; secret: string }> {
  return inAuthorityTransaction(runtime, (query, opId) =>
    mintApiKeyInTransaction(query, opId, userId, raw, deps),
  );
}

async function mintApiKeyInTransaction(
  query: LockQuery,
  opId: string,
  userId: string,
  raw: ApiKeyMintInput,
  deps: { generateSecret?: typeof generateApiKeySecret; now?: () => Date } = {},
): Promise<{ key: ApiKeyView; secret: string }> {
  const parsed = apiKeyMintInput.safeParse(raw);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  const bits = expandBits(input.bits);
  if (!bits.includes("read")) throw invalid();
  // Deleting needs live manage; a key whose ceiling lacks it could never delete.
  if (input.allowDelete && !bits.includes("manage")) throw invalid();
  const kbIds = input.kbIds ?? [];
  if (input.reach === "selected" ? kbIds.length === 0 : kbIds.length > 0) throw invalid();
  if (new Set(kbIds).size !== kbIds.length) throw invalid();
  const childToolGroups = canonicalGroups(input.childToolGroups ?? ["read"]);
  const childAuthoringMode = input.childAuthoringMode ?? null;
  let expiresAt: Date | null;
  try {
    const at = (deps.now ?? (() => new Date()))();
    expiresAt =
      input.expiresAt === null
        ? null
        : input.expiresAt === undefined
          ? new Date(at.getTime() + API_KEY_DEFAULT_TTL_DAYS * DAY_MS)
          : resolvePatExpiry(input.expiresAt, at);
  } catch (error) {
    if (error instanceof McpPatExpiryError) throw invalid();
    throw error;
  }
  const { secret, lookupPrefix } = (deps.generateSecret ?? generateApiKeySecret)();
  const keyId = randomBytes(12).toString("hex");
  const grantId = newMcpGrantGeneration();
  const allowCreate = input.allowCreate ?? false;

  await lockLiveUser(query, userId);
  const acl = await validateAclAgainstLive(
    sqlAuthorityStore(query),
    userId,
    kbIds.map((kbId) => ({ kbId, bits })),
  );
  const live = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM api_key k JOIN mcp_grant g ON g.id = k."grantId"
        WHERE k."userId" = $1 AND k."revokedAt" IS NULL AND g."revokedAt" IS NULL
          AND (k."expiresAt" IS NULL OR k."expiresAt" > now())`,
    [userId],
  );
  if ((live.rows[0]?.count ?? 0) >= KB_LIMITS.activeApiKeysPerUser) {
    throw new KbDomainError("QUOTA_EXCEEDED", "Active API key limit reached");
  }
  await query(
    `INSERT INTO "mcp_grant"
         (id, "actorUserIdSnapshot", "userId", kind, "clientId", "referenceId", scopes,
          "toolGroups", "allowCreate", "createdKbBits", "authoringMode", "allKbsBits", "createdAt")
       VALUES ($1::uuid, $2, $2, 'API_KEY'::"McpGrantKind", $3, $4, $5::text[],
               ARRAY['kb_admin']::text[], $6, $7::text[], 'EDIT'::"McpAuthoringMode", $8::text[], now())`,
    [
      grantId,
      userId,
      `${API_KEY_CLIENT_ID_PREFIX}${keyId}`,
      API_KEY_GRANT_REFERENCE,
      [...API_KEY_GRANT_SCOPES],
      allowCreate,
      allowCreate ? bits : [],
      input.reach === "all" ? bits : [],
    ],
  );
  for (const entry of acl) {
    await query(
      `INSERT INTO "grant_kb_acl" ("grantId", "kbId", bits, "createdAt")
         VALUES ($1::uuid, $2, $3::text[], now())`,
      [grantId, entry.kbId, entry.bits],
    );
  }
  await query(
    `INSERT INTO "api_key"
         (id, "userIdSnapshot", "userId", name, "lookupPrefix", "secretDigest", "grantId", reach,
          bits, "allowDelete", "allowMintChildren", "childToolGroups", "childAuthoringMode",
          "childAllowCreate", "childrenEndWithKey", "expiresAt", "createdAt")
       VALUES ($1, $2, $2, $3, $4, $5, $6::uuid, $7::"ApiKeyReach", $8::text[], $9, $10,
               $11::text[], $12::"McpAuthoringMode", $13, $14, $15, now())`,
    [
      keyId,
      userId,
      input.name,
      lookupPrefix,
      digestApiKeySecret(secret),
      grantId,
      REACH_TO_DB[input.reach],
      bits,
      input.allowDelete ?? false,
      input.allowMintChildren ?? false,
      childToolGroups,
      authoringModeToDb(childAuthoringMode),
      input.childAllowCreate ?? false,
      input.childrenEndWithKey ?? false,
      expiresAt,
    ],
  );
  await recordAuditEvent(query, {
    opId,
    action: "api_key_mint",
    outcome: "SUCCESS",
    actorKey: `user:${userId}`,
    actorUserIdSnapshot: userId,
    actorUserId: userId,
    grantIdSnapshot: grantId,
    metadata: {
      apiKeyId: keyId,
      reach: input.reach,
      amount: String(acl.length),
      flags: [
        allowCreate ? "create" : null,
        input.allowDelete ? "delete" : null,
        input.allowMintChildren ? "mint_children" : null,
        input.childAllowCreate ? "child_create" : null,
        childToolGroups.includes("sealed") ? "child_sealed" : null,
        input.childrenEndWithKey ? "children_end_with_key" : null,
      ]
        .filter(Boolean)
        .join(","),
    },
  });
  const view = await query<KeyViewRow>(`${KEY_VIEW_SQL} WHERE k.id = $1`, [keyId]);
  const row = view.rows[0];
  if (!row) throw new Error("minted API key is missing");
  return { key: toKeyView(row), secret };
}

export async function listApiKeys(
  runtime: Runtime,
  userId: string,
  input: z.input<typeof pageInput>,
): Promise<{ items: ApiKeyView[]; nextCursor: string | null }> {
  const page = pageInput.safeParse(input);
  if (!page.success || (page.data.cursor && !/^[0-9a-f]{24}$/.test(page.data.cursor))) {
    throw invalid();
  }
  const parsed = page.data;
  const take = parsed.limit ?? LIST_DEFAULT;
  return inAuthorityTransaction(runtime, async (query) => {
    await lockLiveUser(query, userId);
    const { rows } = await query<KeyViewRow>(
      `${KEY_VIEW_SQL} WHERE k."userId" = $1 AND ($2::text IS NULL OR k.id > $2)
        ORDER BY k.id LIMIT $3`,
      [userId, parsed.cursor ?? null, take + 1],
    );
    const items = rows.slice(0, take).map(toKeyView);
    return { items, nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null };
  });
}

/**
 * Revoke one key on the caller's authority transaction. `revokeChildren`
 * (default: the key's own childrenEndWithKey) decides whether its children
 * are tombstoned with it. Declining it for a key whose children end with it
 * first makes those children independent, so the choice made at revoke time
 * is the one that holds (the verifier would otherwise end them with the key).
 */
async function revokeKeyInTransaction(
  query: LockQuery,
  opId: string,
  input: {
    userId: string;
    apiKeyId: string;
    grantId: string;
    childrenEndWithKey: boolean;
    revokeChildren: boolean | undefined;
    actorKey?: string;
  },
): Promise<{ id: string; revoked: true; children: number }> {
  const revokeChildren = input.revokeChildren ?? input.childrenEndWithKey;
  if (!revokeChildren && input.childrenEndWithKey) {
    await query(`UPDATE api_key SET "childrenEndWithKey" = false WHERE id = $1`, [input.apiKeyId]);
  }
  const { children } = await tombstoneGrant(query, {
    userId: input.userId,
    grantId: input.grantId,
    opId,
    action: API_KEY_REVOKE_ACTION,
    actorKey: input.actorKey,
    children: revokeChildren,
  });
  return { id: input.apiKeyId, revoked: true as const, children };
}

/** Idempotent owner revoke of a key, with or without its children (see above). */
export async function revokeApiKey(
  runtime: Runtime,
  userId: string,
  apiKeyId: string,
  options: { revokeChildren?: boolean } = {},
): Promise<{ id: string; revoked: true; children: number }> {
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await lockLiveUser(query, userId);
    const found = await query<{
      userId: string | null;
      grantId: string;
      childrenEndWithKey: boolean;
    }>(
      `SELECT "userId", "grantId"::text AS "grantId", "childrenEndWithKey"
         FROM "api_key" WHERE id = $1 FOR UPDATE`,
      [apiKeyId],
    );
    const row = found.rows[0];
    if (!row || row.userId !== userId) throw keyNotFound();
    return revokeKeyInTransaction(query, opId, {
      userId,
      apiKeyId,
      grantId: row.grantId,
      childrenEndWithKey: row.childrenEndWithKey,
      revokeChildren: options.revokeChildren,
    });
  });
}

/** Owner bulk revoke of every child of one key (live or revoked key), set-based. */
export async function revokeApiKeyChildrenForOwner(
  runtime: Runtime,
  userId: string,
  apiKeyId: string,
): Promise<{ id: string; children: number }> {
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await lockLiveUser(query, userId);
    const found = await query<{ userId: string | null }>(
      `SELECT "userId" FROM api_key WHERE id = $1 FOR UPDATE`,
      [apiKeyId],
    );
    if (found.rows[0]?.userId !== userId) throw keyNotFound();
    const { children } = await tombstoneApiKeyChildren(query, {
      userId,
      opId,
      actorKey: `user:${userId}`,
      apiKeyId,
    });
    return { id: apiKeyId, children };
  });
}

// --- children ---------------------------------------------------------------

export const apiKeyChildMintInput = z.strictObject({
  name: patDisplayName,
  /** Requested bits on the KB (expanded); must be within the key's live reach there. */
  bits: z.array(permissionSchema).min(1).max(5),
  toolGroups: z
    .array(z.enum(API_KEY_CHILD_TOOL_GROUPS))
    .min(1)
    .max(API_KEY_CHILD_TOOL_GROUPS.length),
  /** The child's write mode; null/omitted = a read-only child. */
  authoringMode: z.enum(MCP_AUTHORING_MODES).nullable().optional(),
  /** The child may create KBs (needs the key's childAllowCreate and a write mode). */
  allowCreate: z.boolean().optional(),
  /** Bits the child gets on a KB it creates; within the key's bits, must include read. */
  createdKbBits: z.array(permissionSchema).max(5).optional(),
  /**
   * Omitted = 90 days (capped at the key's expiry when children end with the
   * key); a date at most 365 days out; null = never expires (only when the
   * child does not end with an expiring key).
   */
  expiresAt: z.coerce.date().nullable().optional(),
});
export type ApiKeyChildMintInput = z.input<typeof apiKeyChildMintInput>;

/** The same key alphabet as the web create/update/delete calls. */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export type ChildTokenView = {
  id: string;
  name: string;
  lookupPrefix: string;
  grantId: string;
  apiKeyId: string;
  kbId: string | null;
  bits: string[];
  scopes: string[];
  toolGroups: string[];
  authoringMode: McpAuthoringMode | null;
  allowCreate: boolean;
  /** Bits the child gets on a KB it creates (empty unless allowCreate). */
  createdKbBits: string[];
  /** KBs in the child's reach: the mint target plus every KB it created. */
  kbCount: number;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

const CHILD_VIEW_SQL = `SELECT t.id, t.name, t."lookupPrefix", t."grantId"::text AS "grantId",
        t."parentApiKeyId" AS "apiKeyId",
        -- The mint target is the child's first ACL row (KBs it creates are appended later).
        (SELECT a."kbId" FROM grant_kb_acl a WHERE a."grantId" = t."grantId"
          ORDER BY a."createdAt", a."kbId" LIMIT 1) AS "kbId",
        COALESCE((SELECT a.bits FROM grant_kb_acl a WHERE a."grantId" = t."grantId"
          ORDER BY a."createdAt", a."kbId" LIMIT 1), ARRAY[]::text[]) AS bits,
        (SELECT COUNT(*)::int FROM grant_kb_acl a WHERE a."grantId" = t."grantId") AS "kbCount",
        g."createdKbBits",
        t.scopes, g."toolGroups", g."authoringMode"::text AS "authoringMode", g."allowCreate",
        t."createdAt", t."expiresAt",
        -- A child tombstoned only because it expired lists as expired, not revoked.
        CASE WHEN g."revokeReason" = 'expired' THEN NULL
             WHEN t."revokedAt" IS NOT NULL THEN t."revokedAt" ELSE g."revokedAt" END AS "revokedAt"
   FROM mcp_personal_token t JOIN mcp_grant g ON g.id = t."grantId"`;

type ChildViewRow = Omit<ChildTokenView, "authoringMode"> & { authoringMode: string | null };

function toChildView(row: ChildViewRow): ChildTokenView {
  return { ...row, authoringMode: authoringModeFromDb(row.authoringMode) };
}

type KeyRow = {
  id: string;
  grantId: string;
  userId: string | null;
  allowDelete: boolean;
  allowMintChildren: boolean;
  childToolGroups: string[];
  childAuthoringMode: string | null;
  childAllowCreate: boolean;
  childrenEndWithKey: boolean;
  bits: string[];
  expiresAt: Date | string | null;
};

/**
 * The presented key is not (or no longer) admissible: revoked, expired, its
 * owner banned or past the forced-2FA grace, or not an API key at all. A
 * domain error, so the authority-transaction wrapper keeps it as it is, and
 * the REST layer answers 401 instead of 403.
 */
export class ApiKeyInadmissibleError extends KbDomainError {
  constructor() {
    super("FORBIDDEN", "API key is not admissible");
  }
}

function inadmissibleUnlessInfrastructure(error: unknown): never {
  if (
    error instanceof KbAdmissionError &&
    (error.code === "STORAGE_UNAVAILABLE" || error.code === "RATE_LIMITED")
  ) {
    throw error;
  }
  if (error instanceof KbAdmissionError || error instanceof KbDomainError) {
    throw new ApiKeyInadmissibleError();
  }
  throw error;
}

/**
 * Admit the presented key on this (authority-locked) transaction and lock its
 * row. Every admission failure is {@link ApiKeyInadmissibleError}.
 */
async function admitKeyOnTransaction(
  query: LockQuery,
  principal: TokenPrincipal,
  resource: string,
  now: () => Date,
): Promise<{ key: KeyRow; verifier: ReturnType<typeof createGrantCredentialVerifier> }> {
  const verifier = createGrantCredentialVerifier(query, now, { resource });
  let apiKeyId: string;
  try {
    apiKeyId = apiKeyIdOf(principal);
    await assertTokenAdmissible(principal, verifier);
    await lockLiveUser(query, principal.userId);
  } catch (error) {
    inadmissibleUnlessInfrastructure(error);
  }
  const found = await query<KeyRow>(
    `SELECT id, "grantId"::text AS "grantId", "userId", "allowDelete", "allowMintChildren",
            "childToolGroups", "childAuthoringMode"::text AS "childAuthoringMode",
            "childAllowCreate", "childrenEndWithKey", bits, "expiresAt"
       FROM api_key WHERE id = $1 AND "grantId" = $2::uuid FOR UPDATE`,
    [apiKeyId, principal.grantId],
  );
  const key = found.rows[0];
  if (!key || key.userId !== principal.userId) throw new ApiKeyInadmissibleError();
  return { key, verifier };
}

export type ApiKeyRuntime = Runtime & { now?: () => Date };
/** Minting charges the per-key hourly budget: the rate port is required. */
export type ApiKeyMintRuntime = ApiKeyRuntime & { ratePort: RatePort };

/** The presented key itself (`GET /api/v1/key`). */
export async function describeApiKey(
  runtime: ApiKeyRuntime,
  principal: TokenPrincipal,
  resource: string,
): Promise<ApiKeyView> {
  const now = runtime.now ?? (() => new Date());
  return inAuthorityTransaction(runtime, async (query) => {
    const { key } = await admitKeyOnTransaction(query, principal, resource, now);
    const view = await query<KeyViewRow>(`${KEY_VIEW_SQL} WHERE k.id = $1`, [key.id]);
    const row = view.rows[0];
    if (!row) throw keyNotFound();
    return toKeyView(row);
  });
}

/**
 * The presented key revokes itself (`DELETE /api/v1/key`). Only that key.
 * It may revoke its independent children too (`revokeChildren`, default the
 * key's setting), but it can never release children the owner bound to it:
 * for a key whose children end with it, they are always revoked with it. Only
 * the owner, in a browser session, may change that at revoke time.
 */
export async function revokeApiKeySelf(
  runtime: ApiKeyRuntime,
  principal: TokenPrincipal,
  resource: string,
  options: { revokeChildren?: boolean } = {},
): Promise<{ id: string; revoked: true; children: number }> {
  const now = runtime.now ?? (() => new Date());
  return inAuthorityTransaction(runtime, async (query, opId) => {
    const { key } = await admitKeyOnTransaction(query, principal, resource, now);
    return revokeKeyInTransaction(query, opId, {
      userId: principal.userId,
      apiKeyId: key.id,
      grantId: key.grantId,
      childrenEndWithKey: key.childrenEndWithKey,
      revokeChildren: key.childrenEndWithKey ? true : options.revokeChildren,
      actorKey: `grant:${principal.grantId}`,
    });
  });
}

/** Whether the presented key may delete KBs; the delete itself rechecks everything live. */
export async function assertApiKeyMayDelete(
  runtime: ApiKeyRuntime,
  principal: TokenPrincipal,
  resource: string,
): Promise<void> {
  const now = runtime.now ?? (() => new Date());
  await inAuthorityTransaction(runtime, async (query) => {
    const { key } = await admitKeyOnTransaction(query, principal, resource, now);
    if (!key.allowDelete) throw forbidden();
  });
}

export type MintedChild = {
  token: ChildTokenView;
  /** Shown once. Null on an idempotent replay: secrets are never stored. */
  secret: string | null;
  replayed: boolean;
};

/**
 * Mint one child MCP token for one KB through an API key. One authority-lock
 * transaction: key admission and row lock, the idempotency lookup, live
 * per-KB authorization of the key (its ceiling ∩ the owner's live bits) and
 * every request field within the key's ceilings, the per-key cap (instance
 * setting), then the shared PAT mint (live rights validated again). A refused
 * mint stores nothing, so the same Idempotency-Key may be retried.
 */
export async function mintApiKeyChild(
  runtime: ApiKeyMintRuntime,
  principal: TokenPrincipal,
  resource: string,
  kbId: string,
  raw: ApiKeyChildMintInput,
  idempotencyKey: string,
  deps: { generateSecret?: () => { secret: string; lookupPrefix: string } } = {},
): Promise<MintedChild> {
  if (!kbIdSchema.safeParse(kbId).success) {
    throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  }
  if (!idempotencyKeySchema.safeParse(idempotencyKey).success) throw invalid();
  const parsed = apiKeyChildMintInput.safeParse(raw);
  if (!parsed.success) throw invalid();
  const input = parsed.data;
  // A Date has no enumerable fields: hash the instant itself, or two expiries
  // would share one request hash.
  const requestHash = canonicalRequestHash({
    kbId,
    ...input,
    expiresAt: input.expiresAt === null ? "never" : (input.expiresAt?.toISOString() ?? null),
  });
  const now = runtime.now ?? (() => new Date());

  return inAuthorityTransaction(runtime, async (query, opId) => {
    const { key, verifier } = await admitKeyOnTransaction(query, principal, resource, now);
    if (!key.allowMintChildren) throw forbidden();
    const prior = await query<ChildViewRow & { requestHash: string | null }>(
      `${CHILD_VIEW_SQL.replace("SELECT t.id,", `SELECT t."requestHash", t.id,`)}
        WHERE t."parentApiKeyId" = $1 AND t."idempotencyKey" = $2`,
      [key.id, idempotencyKey],
    );
    const replay = prior.rows[0];
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
      }
      const { requestHash: _hash, ...view } = replay;
      return { token: toChildView(view), secret: null, replayed: true };
    }
    // The key's live reach on this KB: its stored ceiling ∩ the owner's live bits.
    let auth: Awaited<ReturnType<typeof authorize>>;
    try {
      auth = await authorize({
        store: sqlAuthorityStore(query),
        principal,
        verifier,
        kbId,
        operation: "read",
        query,
      });
    } catch (error) {
      // Unreachable and nonexistent KBs share NOT_FOUND (no existence leak).
      if (error instanceof KbAdmissionError && error.code === "NOT_FOUND") {
        throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
      }
      if (error instanceof KbAdmissionError && error.code === "FORBIDDEN") throw forbidden();
      return inadmissibleUnlessInfrastructure(error);
    }
    const bits = expandBits(input.bits);
    if (!bits.every((bit) => auth.bits.includes(bit))) throw forbidden();
    const toolGroups = canonicalGroups(input.toolGroups);
    if (!toolGroups.every((group) => key.childToolGroups.includes(group))) throw forbidden();
    const authoringMode = input.authoringMode ?? null;
    if (!authoringWithin(authoringMode, authoringModeFromDb(key.childAuthoringMode))) {
      throw forbidden();
    }
    // Creating KBs is an opt-in of the key; the shape rules are the PAT mint's.
    const allowCreate = input.allowCreate ?? false;
    const createdKbBits = expandBits(input.createdKbBits ?? []);
    if (allowCreate) {
      if (!key.childAllowCreate) throw forbidden();
      if (!authoringMode || !toolGroups.includes("kb_admin") || !createdKbBits.includes("read")) {
        throw invalid();
      }
      const keyBits = expandBits(key.bits ?? []);
      if (!createdKbBits.every((bit) => keyBits.includes(bit))) throw forbidden();
    } else if (createdKbBits.length > 0) {
      throw invalid();
    }
    // Expiry: a child that ends with its key never outlives it; an independent
    // child takes any PAT expiry (90-day default, a date within 365 days, or never).
    const keyExpiry = key.expiresAt === null ? null : toDate(key.expiresAt);
    if (key.expiresAt !== null && !keyExpiry) throw forbidden();
    const bound = key.childrenEndWithKey ? keyExpiry : null;
    const at = now();
    let expiresAt: Date | null;
    if (input.expiresAt === undefined) {
      const fallback = at.getTime() + MCP_PAT_DEFAULT_TTL_DAYS * DAY_MS;
      expiresAt = new Date(bound ? Math.min(fallback, bound.getTime()) : fallback);
    } else if (input.expiresAt === null) {
      if (bound) throw invalid();
      expiresAt = null;
    } else {
      // The PAT bounds (future, at most 365 days out) answer INVALID_ARGUMENT
      // here: the shared mint's own refusal is folded into FORBIDDEN below.
      try {
        expiresAt = resolvePatExpiry(input.expiresAt, at);
      } catch (error) {
        if (error instanceof McpPatExpiryError) throw invalid();
        throw error;
      }
      if (bound && expiresAt.getTime() > bound.getTime()) throw invalid();
    }
    if (expiresAt && expiresAt.getTime() <= at.getTime()) throw invalid();
    // Every mint (not a replay) is charged to the key's hourly budget: with
    // the live cap it bounds how fast child rows accumulate.
    await chargeRate(runtime.ratePort, { kind: "childMint", key: `apikey:${key.id}` });
    // Expired children are dead already; tombstone them here, set-based, so a
    // key never holds more untombstoned children than its cap plus this one,
    // and every revocation path stays bounded however long the history is.
    await query(
      `WITH expired AS (
         UPDATE "mcp_personal_token" SET "revokedAt" = "expiresAt"
          WHERE "parentApiKeyId" = $1 AND "revokedAt" IS NULL AND "expiresAt" <= now()
          RETURNING "grantId"
       )
       UPDATE "mcp_grant" g SET "revokedAt" = now(), "revokeReason" = 'expired'
         FROM expired WHERE g.id = expired."grantId" AND g."revokedAt" IS NULL`,
      [key.id],
    );
    const cap = await readInstanceLimit(query, "childTokensPerApiKey");
    const live = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM mcp_personal_token t JOIN mcp_grant g ON g.id = t."grantId"
        WHERE t."parentApiKeyId" = $1 AND t."revokedAt" IS NULL AND g."revokedAt" IS NULL
          AND (t."expiresAt" IS NULL OR t."expiresAt" > now())`,
      [key.id],
    );
    if ((live.rows[0]?.count ?? 0) >= cap) {
      throw new KbDomainError("QUOTA_EXCEEDED", "Child token limit reached");
    }
    let minted: MintedPersonalToken & { grantId: string };
    try {
      minted = await mintPersonalTokenInTransaction(
        query,
        opId,
        runtime.canonicalOrigin,
        principal.userId,
        {
          name: input.name,
          scopes: authoringMode ? ["mcp:read", "mcp:write"] : ["mcp:read"],
          toolGroups,
          acl: [{ kbId, bits }],
          allowCreate,
          createdKbBits,
          authoringMode,
          expiresAt,
        },
        {
          now,
          generateSecret: deps.generateSecret,
          parent: {
            apiKeyId: key.id,
            apiKeyGrantId: principal.grantId,
            idempotencyKey,
            requestHash,
          },
        },
      );
    } catch (error) {
      // The shared mint rejects a selection the owner no longer holds live.
      if (error instanceof KbDomainError && error.code === "INVALID_ARGUMENT") throw forbidden();
      throw error;
    }
    const view = await query<ChildViewRow>(`${CHILD_VIEW_SQL} WHERE t.id = $1`, [minted.token.id]);
    const row = view.rows[0];
    if (!row) throw new Error("minted child token is missing");
    return { token: toChildView(row), secret: minted.secret, replayed: false };
  });
}

export const childPageInput = pageInput.extend({
  kbId: kbIdSchema.optional(),
  /** The last token id of the previous page. */
  cursor: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .nullable()
    .optional(),
});

async function listChildrenOf(
  query: LockQuery,
  apiKeyId: string,
  input: z.input<typeof childPageInput>,
): Promise<{ items: ChildTokenView[]; nextCursor: string | null }> {
  const page = childPageInput.safeParse(input);
  if (!page.success) throw invalid();
  const parsed = page.data;
  const take = parsed.limit ?? LIST_DEFAULT;
  const { rows } = await query<ChildViewRow>(
    `${CHILD_VIEW_SQL}
      WHERE t."parentApiKeyId" = $1 AND ($2::text IS NULL OR t.id > $2)
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM grant_kb_acl a
                                          WHERE a."grantId" = t."grantId" AND a."kbId" = $4))
      ORDER BY t.id LIMIT $3`,
    [apiKeyId, parsed.cursor ?? null, take + 1, parsed.kbId ?? null],
  );
  const items = rows.slice(0, take).map(toChildView);
  return { items, nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null };
}

/** Children of the presented key (REST). */
export async function listApiKeyChildren(
  runtime: ApiKeyRuntime,
  principal: TokenPrincipal,
  resource: string,
  input: z.input<typeof childPageInput>,
) {
  const now = runtime.now ?? (() => new Date());
  return inAuthorityTransaction(runtime, async (query) => {
    const { key } = await admitKeyOnTransaction(query, principal, resource, now);
    return listChildrenOf(query, key.id, input);
  });
}

/** Children of one of the owner's keys (Settings → API keys). */
export async function listApiKeyChildrenForOwner(
  runtime: Runtime,
  userId: string,
  apiKeyId: string,
  input: z.input<typeof childPageInput>,
) {
  return inAuthorityTransaction(runtime, async (query) => {
    await lockLiveUser(query, userId);
    const owner = await query<{ userId: string | null }>(
      `SELECT "userId" FROM api_key WHERE id = $1`,
      [apiKeyId],
    );
    if (owner.rows[0]?.userId !== userId) throw keyNotFound();
    const page = await listChildrenOf(query, apiKeyId, input);
    // Names only in the owner's view, under the grant ACL's visibility rule.
    const kbIds = [...new Set(page.items.flatMap((item) => (item.kbId ? [item.kbId] : [])))];
    const names = new Map<string, string | null>();
    if (kbIds.length > 0) {
      const { rows } = await query<{ kbId: string; name: string | null }>(
        `SELECT x."kbId", ${aclKbNameSql("$2")} AS name FROM unnest($1::text[]) AS x("kbId")`,
        [kbIds, userId],
      );
      for (const row of rows) names.set(row.kbId, row.name);
    }
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        kbName: item.kbId ? (names.get(item.kbId) ?? null) : null,
      })),
    };
  });
}

/**
 * Revoke one child: through its own key (REST, actor = the key) or by the
 * owner (Settings). Idempotent; a token that is not that key's child, or not
 * the owner's, is NOT_FOUND.
 */
export async function revokeApiKeyChild(
  runtime: ApiKeyRuntime,
  actor: { principal: TokenPrincipal; resource: string } | { userId: string; apiKeyId: string },
  tokenId: string,
): Promise<{ id: string; revoked: true }> {
  if (!/^[0-9a-f]{24}$/.test(tokenId)) throw tokenNotFound();
  const now = runtime.now ?? (() => new Date());
  return inAuthorityTransaction(runtime, async (query, opId) => {
    let apiKeyId: string;
    let userId: string;
    let actorKey: string;
    if ("principal" in actor) {
      const { key } = await admitKeyOnTransaction(query, actor.principal, actor.resource, now);
      apiKeyId = key.id;
      userId = actor.principal.userId;
      actorKey = `grant:${actor.principal.grantId}`;
    } else {
      await lockLiveUser(query, actor.userId);
      apiKeyId = actor.apiKeyId;
      userId = actor.userId;
      actorKey = `user:${actor.userId}`;
    }
    const found = await query<{ userId: string | null; grantId: string; parent: string | null }>(
      `SELECT "userId", "grantId"::text AS "grantId", "parentApiKeyId" AS parent
         FROM mcp_personal_token WHERE id = $1 FOR UPDATE`,
      [tokenId],
    );
    const row = found.rows[0];
    if (!row || row.userId !== userId || row.parent !== apiKeyId) throw tokenNotFound();
    await tombstoneGrant(query, {
      userId,
      grantId: row.grantId,
      opId,
      action: API_KEY_CHILD_REVOKE_ACTION,
      actorKey,
    });
    return { id: tokenId, revoked: true as const };
  });
}
