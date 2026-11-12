import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { revokeUserMcpGrants } from "@knowledge-base/auth/ban";
import {
  canonicalMcpResource,
  MCP_PAT_CLIENT_ID_PREFIX,
  MCP_PAT_GRANT_REFERENCE,
  MCP_PAT_MAX_ACTIVE_PER_USER,
  MCP_PAT_SCOPES,
  McpPatExpiryError,
  patDisplayName,
  resolvePatMintExpiry,
} from "@knowledge-base/auth/mcp-config";
import {
  MCP_GRANT_MAX_ACL_ENTRIES,
  McpGrantSelectionError,
  newMcpGrantGeneration,
  normalizeGrantCeiling,
} from "@knowledge-base/auth/mcp-grant";
import {
  MCP_TOOL_GROUPS,
  type McpToolGroup,
  parseStoredToolGroups,
} from "@knowledge-base/auth/mcp-tool-groups";
import { z } from "zod";
import { recordAuditEvent } from "./kb/audit";
import { KbDomainError } from "./kb/errors";
import type { LockQuery } from "./kb/lock";
import {
  expandBits,
  type LiveAuthorityStore,
  liveBitsFor,
  PERMISSIONS,
  type Permission,
  sqlAuthorityStore,
} from "./kb/permissions";
import {
  assertLiveIdentity,
  type CredentialVerifier,
  KbAdmissionError,
  type TokenAdmission,
  type TokenPrincipal,
} from "./kb/principal";
import type { KbRuntimeConfig } from "./kb/runtime";
import { cursorPageInput, forEachPage, pageTake } from "./pagination";

/**
 * Durable grant ceilings and personal access tokens.
 *
 * - `GrantKbAcl` is the ONLY stored per-KB ACL; a PAT row carries only its
 *   lookup prefix, secret digest, grant reference, scope snapshot and expiry.
 * - Mint/list/revoke are human-session control operations. They serialize on
 *   the global authority lock and the user row lock; every requested expanded
 *   bit must be held live or the whole mint is rejected (never clipped).
 * - `authenticatePersonalToken` only IDENTIFIES a presented secret. Admission
 *   is `authorize()` with `createGrantCredentialVerifier`, which re-reads the
 *   exact grant generation, PAT tombstone, live user and stored ACL.
 * - Tombstones are permanent; no path clears `revokedAt`.
 * - PAT expiry is a date or NULL (= never expires, an explicit human choice).
 * - A temporary ban suspends (admission refuses on the live identity) and
 *   never writes a tombstone; forced 2FA revokes once the enrollment grace
 *   has ended.
 */

const PAT_PREFIX = "kbp_";
const PAT_PATTERN = /^kbp_([a-z0-9]{16})_([A-Za-z0-9_-]{43})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_DOMAIN = "kb-pat-digest-v1\0";
const LIST_MAX = 50;
const LIST_DEFAULT = 20;

export type PatSecret = { secret: string; lookupPrefix: string };

export function generatePatSecret(): PatSecret {
  const lookupPrefix = randomBytes(8).toString("hex");
  const body = randomBytes(32).toString("base64url");
  return { secret: `${PAT_PREFIX}${lookupPrefix}_${body}`, lookupPrefix };
}

export function patLookupPrefix(raw: string): string | null {
  return PAT_PATTERN.exec(raw)?.[1] ?? null;
}

export function digestPatSecret(raw: string): string {
  return createHash("sha256").update(DIGEST_DOMAIN).update(raw, "utf8").digest("hex");
}

function digestMatches(raw: string, stored: string): boolean {
  const presented = Buffer.from(digestPatSecret(raw), "hex");
  const expected = Buffer.from(stored, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Identification only: the returned principal still needs verifier-backed authorize(). */
export async function authenticatePersonalToken(
  query: LockQuery,
  raw: string,
  now: Date,
): Promise<TokenPrincipal | null> {
  const lookupPrefix = patLookupPrefix(raw);
  if (!lookupPrefix) return null;
  const result = await query<{
    id: string;
    resource: string;
    userId: string | null;
    grantId: string;
    secretDigest: string;
    scopes: string[];
    expiresAt: Date | string | null;
    revokedAt: Date | string | null;
  }>(
    `SELECT id, resource, "userId", "grantId"::text AS "grantId", "secretDigest", scopes, "expiresAt", "revokedAt"
       FROM "mcp_personal_token" WHERE "lookupPrefix" = $1`,
    [lookupPrefix],
  );
  const row = result.rows[0];
  if (!row || !digestMatches(raw, row.secretDigest)) return null;
  // NULL expiry = never expires. A present but unreadable value fails closed.
  const expiresAt = row.expiresAt === null ? null : toDate(row.expiresAt);
  if (row.revokedAt || !row.userId) return null;
  if (row.expiresAt !== null && (!expiresAt || expiresAt <= now)) return null;
  return {
    kind: "token",
    userId: row.userId,
    grantId: row.grantId,
    grantGeneration: row.grantId,
    scopes: [...row.scopes],
    expiresAt,
    storedAcl: new Map(),
    credential: {
      kind: "PAT",
      clientId: `${MCP_PAT_CLIENT_ID_PREFIX}${row.id}`,
      tokenId: row.id,
      resource: row.resource,
    },
  };
}

/**
 * SQL predicate for an elevation (alias `e`) that is in force right now: not
 * ended and not yet expired by the database clock. `clock_timestamp()`, not
 * `now()`, so a long lock-held transaction never keeps an elevation alive past
 * its expiry. Every effective-authority read shares this predicate.
 */
export const ACTIVE_ELEVATION_SQL = `e."revokedAt" IS NULL AND e."expiresAt" > clock_timestamp()`;

/**
 * The base groups united with live elevation groups, in canonical order.
 * Unknown elevation entries are ignored (fail closed), and an OAuth grant
 * never gains `sealed` through an elevation.
 */
function effectiveToolGroups(
  base: readonly McpToolGroup[],
  elevated: unknown,
  consumerKind: "pat" | "oauth",
): McpToolGroup[] {
  if (base.length === 0) return [];
  const extra = Array.isArray(elevated) ? elevated : [];
  return MCP_TOOL_GROUPS.filter(
    (group) =>
      base.includes(group) ||
      (extra.includes(group) && !(consumerKind === "oauth" && group === "sealed")),
  );
}

/** Active elevation rows as `inspect` reads them; malformed entries are dropped (fail closed). */
function parseElevations(value: unknown): { id: string; toolGroups: string[]; expiresAt: Date }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, toolGroups, expiresAt } = entry as Record<string, unknown>;
    const at = toDate(expiresAt);
    if (typeof id !== "string" || !UUID.test(id) || !at || !Array.isArray(toolGroups)) return [];
    return [
      {
        id,
        toolGroups: toolGroups.filter((g): g is string => typeof g === "string"),
        expiresAt: at,
      },
    ];
  });
}

export type GrantAdmission = TokenAdmission & {
  consumerKind: "pat" | "oauth";
  /** Live tool groups of an active generation; empty whenever inactive. */
  toolGroups: readonly string[];
};

/**
 * Production CredentialVerifier: the full grant validity callback. It checks
 * the exact grant generation (never a sibling), its tombstone, the PAT
 * tombstone/expiry, the live user (ban / forced 2FA) and reads the stored
 * GrantKbAcl ceiling live. Pass a lock-session query to recheck under locks.
 *
 * `revokeLapsedTwoFactor` (bearer admission only) tombstones the user's grants
 * when the live identity fails forced 2FA after the enrollment grace. It is
 * The callback must hold the authority lock on the same transaction as this
 * live identity read and both tombstones. It is dropped by `forQuery`: a
 * lock-session recheck never writes on the side.
 */
export function createGrantCredentialVerifier(
  query: LockQuery,
  now: () => Date = () => new Date(),
  policy: {
    resource?: string;
    assertOpen?: () => void;
    revokeLapsedTwoFactor?: (userId: string) => Promise<void>;
  } = {},
): CredentialVerifier & { inspect(principal: TokenPrincipal): Promise<GrantAdmission> } {
  const guarded: LockQuery = async <R>(sql: string, params?: unknown[]) => {
    policy.assertOpen?.();
    const result = await query<R>(sql, params);
    policy.assertOpen?.();
    return result;
  };
  return {
    forQuery: (next) =>
      createGrantCredentialVerifier(next, now, { ...policy, revokeLapsedTwoFactor: undefined }),
    async inspect(principal) {
      const at = now();
      const inactive: GrantAdmission = {
        generationActive: false,
        instanceEnabled: false,
        expired:
          principal.expiresAt !== null &&
          (!Number.isFinite(principal.expiresAt.getTime()) || principal.expiresAt <= at),
        banned: true,
        twoFactorSatisfied: false,
        consumerKind: "pat",
        toolGroups: [],
      };
      if (!UUID.test(principal.grantId) || principal.grantGeneration !== principal.grantId) {
        return inactive;
      }
      const result = await guarded<{
        id: string;
        userId: string | null;
        kind: string;
        scopes: string[];
        toolGroups: unknown;
        revokedAt: Date | string | null;
        tokenRevokedAt: Date | string | null;
        tokenExpiresAt: Date | string | null;
        clientId: string;
        tokenId: string | null;
        resource: string | null;
        elevations?: unknown;
      }>(
        `SELECT g.id::text AS id, g."userId", g.kind::text AS kind, g.scopes, g."toolGroups", g."revokedAt",
                g."clientId", t.id AS "tokenId", t.resource,
                t."revokedAt" AS "tokenRevokedAt", t."expiresAt" AS "tokenExpiresAt",
                (SELECT jsonb_agg(jsonb_build_object(
                          'id', e.id::text, 'toolGroups', e."toolGroups", 'expiresAt', e."expiresAt")
                          ORDER BY e.id)
                   FROM "mcp_grant_elevation" e
                  WHERE e."grantId" = g.id AND ${ACTIVE_ELEVATION_SQL}) AS elevations
           FROM "mcp_grant" g
           LEFT JOIN "mcp_personal_token" t ON t."grantId" = g.id
          WHERE g.id = $1::uuid`,
        [principal.grantId],
      );
      const row = result.rows[0];
      const consumerKind = row?.kind === "OAUTH" ? "oauth" : "pat";
      // A row whose group set is empty, unknown or non-canonical fails closed.
      const toolGroups = row ? parseStoredToolGroups(row.toolGroups) : null;
      let generationActive =
        !!row &&
        toolGroups !== null &&
        !row.revokedAt &&
        row.userId === principal.userId &&
        row.id === principal.grantId &&
        (row.kind === "OAUTH" || row.kind === "PAT") &&
        principal.scopes.every((scope) => row.scopes.includes(scope));
      const binding = principal.credential;
      if (binding)
        generationActive &&=
          !!row &&
          row.kind === binding.kind &&
          row.clientId === binding.clientId &&
          (policy.resource === undefined || binding.resource === policy.resource) &&
          (binding.kind !== "PAT" ||
            (row.tokenId === binding.tokenId && row.resource === binding.resource));
      if (row && row.kind === "PAT") {
        // NULL token expiry = never expires; a present unreadable value fails closed.
        const tokenExpiry = toDate(row.tokenExpiresAt);
        generationActive &&=
          row.tokenId !== null &&
          !row.tokenRevokedAt &&
          (row.tokenExpiresAt === null || (!!tokenExpiry && tokenExpiry > at));
      }
      if (!generationActive) return { ...inactive, consumerKind };
      // One read of the elevations in force: groups, ids and expiry all come from it.
      const elevations = parseElevations(row?.elevations);
      const identity = await sqlAuthorityStore(guarded).loadIdentity(principal.userId);
      if (identity && !identity.banned && !identity.twoFactorSatisfied)
        await policy.revokeLapsedTwoFactor?.(principal.userId);
      return {
        generationActive: true,
        instanceEnabled: identity?.instanceEnabled ?? false,
        expired: inactive.expired,
        banned: identity ? identity.banned : true,
        twoFactorSatisfied: identity?.twoFactorSatisfied ?? false,
        consumerKind,
        // Effective groups: the base grant united with every active elevation
        // (read live on this same statement, by the database clock).
        toolGroups: effectiveToolGroups(
          toolGroups ?? [],
          elevations.flatMap((elevation) => elevation.toolGroups),
          consumerKind,
        ),
        elevations: {
          ids: elevations.map((elevation) => elevation.id),
          validUntil: elevations.reduce<Date | null>(
            (min, elevation) => (!min || elevation.expiresAt < min ? elevation.expiresAt : min),
            null,
          ),
        },
      };
    },
    async grantBits(principal, kbId) {
      if (!UUID.test(principal.grantId)) return [];
      // The base GrantKbAcl united with every active elevation's bits for this KB.
      const result = await guarded<{ bits: string[] | null }>(
        `SELECT ARRAY(SELECT DISTINCT x.b FROM (
                  SELECT unnest(a.bits) AS b FROM "grant_kb_acl" a
                   WHERE a."grantId" = $1::uuid AND a."kbId" = $2
                  UNION ALL
                  SELECT unnest(ea.bits) FROM "grant_elevation_kb_acl" ea
                    JOIN "mcp_grant_elevation" e ON e.id = ea."elevationId"
                   WHERE e."grantId" = $1::uuid AND ea."kbId" = $2 AND ${ACTIVE_ELEVATION_SQL}
                ) x) AS bits`,
        [principal.grantId, kbId],
      );
      const bits = result.rows[0]?.bits ?? [];
      return PERMISSIONS.filter((bit) => bits.includes(bit));
    },
  };
}

const invalidSelection = () => new KbDomainError("INVALID_ARGUMENT", "Invalid grant selection");

/**
 * Every requested bit is expanded, then must be held live on that KB by the
 * minting user; otherwise the selection is rejected (never clipped). Unknown,
 * tombstoned and unreadable KBs share the same rejection.
 */
export async function validateAclAgainstLive(
  store: LiveAuthorityStore,
  userId: string,
  acl: readonly { kbId: string; bits: readonly string[] }[],
): Promise<{ kbId: string; bits: Permission[] }[]> {
  const out: { kbId: string; bits: Permission[] }[] = [];
  for (const entry of acl) {
    const kb = await store.loadKb(entry.kbId);
    if (kb?.state !== "ACTIVE") throw invalidSelection();
    const live = await liveBitsFor(store, kb, userId);
    const requested = expandBits(entry.bits);
    if (requested.length === 0 || !requested.every((bit) => live.includes(bit))) {
      throw invalidSelection();
    }
    out.push({ kbId: entry.kbId, bits: requested });
  }
  return out;
}

const kbIdSchema = z.string().regex(/^[a-z0-9]{24,32}$/);
const permissionSchema = z.enum(PERMISSIONS);

export const patMintInput = z.strictObject({
  name: patDisplayName,
  scopes: z.array(z.enum(MCP_PAT_SCOPES)).min(1).max(MCP_PAT_SCOPES.length),
  toolGroups: z.array(z.enum(MCP_TOOL_GROUPS)).min(1).max(MCP_TOOL_GROUPS.length),
  acl: z
    .array(z.strictObject({ kbId: kbIdSchema, bits: z.array(permissionSchema).min(1).max(5) }))
    .max(MCP_GRANT_MAX_ACL_ENTRIES),
  allowCreate: z.boolean().optional(),
  createdKbBits: z.array(permissionSchema).max(5).optional(),
  // Omitted = now+90d; a date must be future and <= 365d; null = never expires.
  expiresAt: z.coerce.date().nullable().optional(),
});
export type PatMintInput = z.input<typeof patMintInput>;

export const pageInput = z.strictObject({
  limit: z.number().int().min(1).max(LIST_MAX).optional(),
  cursor: z.string().min(1).max(128).nullable().optional(),
});

/** Optional kind filter is applied before cursor pagination; omitted keeps tombstones of both kinds. */
export const grantPageInput = pageInput.extend({ kind: z.enum(["PAT", "OAUTH"]).optional() });
export const grantAclPageInput = cursorPageInput
  .extend({
    grantId: z.uuid(),
    // This relation has a fixed grant and a single KB-id keyset, not a dated row cursor.
    cursor: kbIdSchema.nullable().optional(),
    limit: pageInput.shape.limit,
  })
  .strict();

export type MintedPersonalToken = {
  token: { id: string; name: string; expiresAt: Date | null; lookupPrefix: string };
  secret: string;
};

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function asDomainError(error: unknown): unknown {
  if (error instanceof KbDomainError) return error;
  if (error instanceof KbAdmissionError) {
    return new KbDomainError(
      error.code === "RATE_LIMITED" || error.code === "STORAGE_UNAVAILABLE"
        ? error.code
        : "FORBIDDEN",
      "Forbidden",
    );
  }
  if (isUniqueViolation(error)) return new KbDomainError("CONFLICT", "Credential conflict");
  return error;
}

type Runtime = Pick<KbRuntimeConfig, "coordinator" | "canonicalOrigin">;

async function inAuthorityTransaction<T>(
  runtime: Runtime,
  run: (query: LockQuery, opId: string) => Promise<T>,
): Promise<T> {
  const opId = randomUUID();
  try {
    return await runtime.coordinator.run({
      opId,
      kind: "authority",
      run: ({ lease }) => lease.transaction((query) => run(query, opId)),
    });
  } catch (error) {
    throw asDomainError(error);
  }
}

async function lockLiveUser(query: LockQuery, userId: string): Promise<void> {
  const locked = await query(`SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, [userId]);
  if (locked.rows.length !== 1) throw new KbDomainError("FORBIDDEN", "Forbidden");
  assertLiveIdentity(await sqlAuthorityStore(query).loadIdentity(userId));
}

/**
 * Human mint. One transaction under authority + user row lock: live identity,
 * live-rights validation of every requested bit, the live-token cap, then one
 * fresh random grant generation, its ACL rows, and the digest-only PAT row.
 * The raw secret exists only in the return value of the committing call.
 */
export async function mintPersonalToken(
  runtime: Runtime,
  userId: string,
  raw: PatMintInput,
  deps: { generateSecret?: () => PatSecret; now?: () => Date } = {},
): Promise<MintedPersonalToken> {
  return inAuthorityTransaction(runtime, async (query, opId) => {
    const { token, secret } = await mintPersonalTokenInTransaction(
      query,
      opId,
      runtime.canonicalOrigin,
      userId,
      raw,
      deps,
    );
    return { token, secret };
  });
}

/** Internal mint boundary; caller owns authority lock and committing transaction. */
export async function mintPersonalTokenInTransaction(
  query: LockQuery,
  opId: string,
  canonicalOrigin: string,
  userId: string,
  raw: PatMintInput,
  deps: { generateSecret?: () => PatSecret; now?: () => Date } = {},
): Promise<MintedPersonalToken & { grantId: string }> {
  const parsed = patMintInput.safeParse(raw);
  if (!parsed.success) throw invalidSelection();
  const input = parsed.data;
  let ceiling: ReturnType<typeof normalizeGrantCeiling>;
  let expiresAt: Date | null;
  try {
    ceiling = normalizeGrantCeiling(input);
    expiresAt = resolvePatMintExpiry(input.expiresAt, (deps.now ?? (() => new Date()))());
  } catch (error) {
    if (error instanceof McpGrantSelectionError || error instanceof McpPatExpiryError) {
      throw invalidSelection();
    }
    throw error;
  }
  const { secret, lookupPrefix } = (deps.generateSecret ?? generatePatSecret)();
  const tokenId = randomBytes(12).toString("hex");
  const grantId = newMcpGrantGeneration();
  const resource = canonicalMcpResource(canonicalOrigin);
  const createdKbBits = expandBits(ceiling.createdKbBits);

  await lockLiveUser(query, userId);
  const acl = await validateAclAgainstLive(sqlAuthorityStore(query), userId, ceiling.acl);
  const live = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
         FROM "mcp_personal_token" t JOIN "mcp_grant" g ON g.id = t."grantId"
        WHERE t."userId" = $1 AND t."revokedAt" IS NULL AND g."revokedAt" IS NULL
          AND (t."expiresAt" IS NULL OR t."expiresAt" > now())`,
    [userId],
  );
  if ((live.rows[0]?.count ?? 0) >= MCP_PAT_MAX_ACTIVE_PER_USER) {
    throw new KbDomainError("QUOTA_EXCEEDED", "Active token limit reached");
  }
  await query(
    `INSERT INTO "mcp_grant"
         (id, "actorUserIdSnapshot", "userId", kind, "clientId", "referenceId", scopes,
          "toolGroups", "allowCreate", "createdKbBits", "createdAt")
       VALUES ($1::uuid, $2, $2, 'PAT'::"McpGrantKind", $3, $4, $5::text[], $6::text[], $7,
               $8::text[], now())`,
    [
      grantId,
      userId,
      `${MCP_PAT_CLIENT_ID_PREFIX}${tokenId}`,
      MCP_PAT_GRANT_REFERENCE,
      ceiling.scopes,
      ceiling.toolGroups,
      ceiling.allowCreate,
      createdKbBits,
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
    `INSERT INTO "mcp_personal_token"
         (id, "userIdSnapshot", "userId", name, "lookupPrefix", "secretDigest", "grantId",
          scopes, resource, "expiresAt", "createdAt")
       VALUES ($1, $2, $2, $3, $4, $5, $6::uuid, $7::text[], $8, $9, now())`,
    [
      tokenId,
      userId,
      input.name,
      lookupPrefix,
      digestPatSecret(secret),
      grantId,
      ceiling.scopes,
      resource,
      expiresAt,
    ],
  );
  await recordAuditEvent(query, {
    opId,
    action: "pat_mint",
    outcome: "SUCCESS",
    actorKey: `user:${userId}`,
    actorUserIdSnapshot: userId,
    actorUserId: userId,
    grantIdSnapshot: grantId,
    metadata: { requestId: tokenId },
  });
  return { token: { id: tokenId, name: input.name, expiresAt, lookupPrefix }, secret, grantId };
}

async function tombstoneGrant(
  query: LockQuery,
  input: { userId: string; grantId: string; opId: string; action: string },
): Promise<void> {
  await query(
    `UPDATE "mcp_personal_token" SET "revokedAt" = COALESCE("revokedAt", now())
      WHERE "grantId" = $1::uuid AND "revokedAt" IS NULL`,
    [input.grantId],
  );
  await query(
    `UPDATE "mcp_grant" SET "revokedAt" = COALESCE("revokedAt", now()), "revokeReason" = 'user_revoke'
      WHERE id = $1::uuid AND "revokedAt" IS NULL`,
    [input.grantId],
  );
  await recordAuditEvent(query, {
    opId: input.opId,
    action: input.action,
    outcome: "SUCCESS",
    actorKey: `user:${input.userId}`,
    actorUserIdSnapshot: input.userId,
    actorUserId: input.userId,
    grantIdSnapshot: input.grantId,
  });
}

const tokenNotFound = () => new KbDomainError("NOT_FOUND", "Token not found");

/** Idempotent owner revoke of one PAT and its grant generation (permanent tombstone). */
export async function revokePersonalToken(
  runtime: Runtime,
  userId: string,
  tokenId: string,
): Promise<{ id: string; revoked: true }> {
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await lockLiveUser(query, userId);
    const found = await query<{ userId: string | null; grantId: string }>(
      `SELECT "userId", "grantId"::text AS "grantId" FROM "mcp_personal_token" WHERE id = $1 FOR UPDATE`,
      [tokenId],
    );
    const row = found.rows[0];
    if (!row || row.userId !== userId) throw tokenNotFound();
    await tombstoneGrant(query, { userId, grantId: row.grantId, opId, action: "pat_revoke" });
    return { id: tokenId, revoked: true as const };
  });
}

/** Idempotent owner revoke of any grant generation (PAT or OAuth). */
export async function revokeGrant(
  runtime: Runtime,
  userId: string,
  grantId: string,
): Promise<{ id: string; revoked: true }> {
  if (!UUID.test(grantId)) throw tokenNotFound();
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await lockLiveUser(query, userId);
    const found = await query<{ userId: string | null }>(
      `SELECT "userId" FROM "mcp_grant" WHERE id = $1::uuid FOR UPDATE`,
      [grantId],
    );
    if (found.rows[0]?.userId !== userId) throw tokenNotFound();
    await tombstoneGrant(query, { userId, grantId, opId, action: "grant_revoke" });
    return { id: grantId, revoked: true as const };
  });
}

/** Rows tombstoned per authority transaction by {@link revokeAllCredentials}. */
const REVOKE_ALL_BATCH = 100;

/**
 * The user's currently usable credentials: live (unrevoked, unexpired) PATs
 * and unrevoked OAuth grants. Aggregates only, independent of the paged
 * history lists, which also carry revoked rows (review after a reset).
 */
export async function countActiveCredentials(
  runtime: Runtime,
  userId: string,
): Promise<{ tokens: number; apps: number }> {
  return inAuthorityTransaction(runtime, async (query) => {
    await lockLiveUser(query, userId);
    const { rows } = await query<{ tokens: number; apps: number }>(
      `SELECT
         (SELECT count(*)::int FROM mcp_personal_token t
           WHERE t."userId" = $1 AND t."revokedAt" IS NULL
             AND (t."expiresAt" IS NULL OR t."expiresAt" > now())) AS tokens,
         (SELECT count(*)::int FROM mcp_grant g
           WHERE g."userId" = $1 AND g.kind::text = 'OAUTH' AND g."revokedAt" IS NULL) AS apps`,
      [userId],
    );
    return { tokens: rows[0]?.tokens ?? 0, apps: rows[0]?.apps ?? 0 };
  });
}

/**
 * "Revoke all" for the signed-in user: tombstone every unrevoked grant
 * generation (PAT and OAuth) with the same per-grant tombstone and audit as
 * {@link revokeGrant}, in bounded keyset batches (`id > lastSeen`, one
 * authority transaction each). Returns only after the last batch, with counts.
 */
export async function revokeAllCredentials(
  runtime: Runtime,
  userId: string,
): Promise<{ tokens: number; apps: number }> {
  const revoked = { tokens: 0, apps: 0 };
  await forEachPage<{ id: string; kind: "PAT" | "OAUTH" }>(
    ({ take, afterId }) =>
      inAuthorityTransaction(runtime, async (query) => {
        const { rows } = await query<{ id: string; kind: "PAT" | "OAUTH" }>(
          `SELECT g.id::text AS id, g.kind::text AS kind FROM mcp_grant g
            WHERE g."userId" = $1 AND g."revokedAt" IS NULL
              AND ($2::uuid IS NULL OR g.id > $2::uuid)
            ORDER BY g.id LIMIT $3`,
          [userId, afterId ?? null, take],
        );
        return rows;
      }),
    REVOKE_ALL_BATCH,
    (rows) =>
      inAuthorityTransaction(runtime, async (query, opId) => {
        await lockLiveUser(query, userId);
        for (const row of rows) {
          // Re-check inside the locked transaction: a row revoked meanwhile
          // is skipped (not counted twice), never resurrected.
          const live = await query(
            `SELECT 1 FROM mcp_grant WHERE id = $1::uuid AND "userId" = $2
               AND "revokedAt" IS NULL FOR UPDATE`,
            [row.id, userId],
          );
          if (live.rows.length === 0) continue;
          // One audit identity per credential: audit rows are unique on
          // (opId, action, outcome), so a shared batch opId would record only
          // the first revocation (same scheme as account-removal tombstones).
          await tombstoneGrant(query, {
            userId,
            grantId: row.id,
            opId: `${opId}:${row.id}`,
            action: "grant_revoke",
          });
          if (row.kind === "OAUTH") revoked.apps++;
          else revoked.tokens++;
        }
      }),
  );
  return revoked;
}

/**
 * Owner edit of one live grant. Every field is
 * optional; `acl` is a patch: each entry replaces that KB's stored bits, and
 * an empty `bits` removes the KB. KBs not named keep their stored ceiling, so
 * creator-appended entries beyond any one page are never clipped. `aclCap`
 * narrows every stored entry (and the patched ones) to those bits in the same
 * transaction, with no per-entry payload, so a preset change applies to any
 * number of stored KBs atomically.
 */
/** Temporary access durations (§5a); 7 days is the maximum. */
export const MCP_ELEVATION_DURATIONS = ["1h", "1d", "7d"] as const;
export type McpElevationDuration = (typeof MCP_ELEVATION_DURATIONS)[number];
const ELEVATION_SECONDS: Record<McpElevationDuration, number> = {
  "1h": 3600,
  "1d": 86_400,
  "7d": 7 * 86_400,
};
/** At most this many elevations may be in force on one grant at once. */
export const MCP_ELEVATION_MAX_ACTIVE = 5;

export const grantUpdateInput = z
  .strictObject({
    id: z.uuid(),
    /** PAT only; an OAuth grant's scopes are fixed by its issued tokens. */
    scopes: patMintInput.shape.scopes.optional(),
    toolGroups: patMintInput.shape.toolGroups.optional(),
    acl: z
      .array(z.strictObject({ kbId: kbIdSchema, bits: z.array(permissionSchema).max(5) }))
      .min(1)
      .max(MCP_GRANT_MAX_ACL_ENTRIES)
      .optional(),
    aclCap: z.array(permissionSchema).min(1).max(5).optional(),
    allowCreate: z.boolean().optional(),
    createdKbBits: patMintInput.shape.createdKbBits,
    /**
     * Absent = a permanent edit. Present = temporary access (§5a): the input
     * describes the elevated ceiling, which may only add to the stored one,
     * and lapses on its own after this long.
     */
    duration: z.enum(MCP_ELEVATION_DURATIONS).optional(),
  })
  .refine(
    (input) =>
      input.scopes !== undefined ||
      input.toolGroups !== undefined ||
      input.acl !== undefined ||
      input.aclCap !== undefined ||
      input.allowCreate !== undefined ||
      input.createdKbBits !== undefined,
  )
  // Temporary access never changes scopes and never narrows.
  .refine(
    (input) =>
      input.duration === undefined || (input.scopes === undefined && input.aclCap === undefined),
  );
export type GrantUpdateInput = z.input<typeof grantUpdateInput>;

export type GrantUpdateResult = {
  id: string;
  widened: boolean;
  narrowed: boolean;
  /** Set when the update created temporary access. */
  elevation?: { id: string; expiresAt: Date };
};

/** Above this many changed KBs, audit metadata records counts instead of each entry. */
const AUDIT_ACL_DETAIL_MAX = 25;
const grantInactive = () => new KbDomainError("CONFLICT", "Credential is no longer active");
const setDiff = (a: readonly string[], b: readonly string[]) => a.filter((v) => !b.includes(v));

/**
 * Widen or narrow the caller's own live grant in place, keeping its
 * generation. One authority-lock transaction: live identity, the grant row
 * and the named ACL rows locked, every added KB bit validated against the caller's
 * live rights exactly as at mint (rejected, never clipped), then the update
 * and its `MCP_GRANT_WIDENED` / `MCP_GRANT_NARROWED` audit events. Admission
 * and the lock-held rechecks read the grant live, so the edit applies to the
 * next call and to any work still waiting on the authority lock.
 *
 * - Foreign grants are NOT_FOUND; revoked or expired ones are CONFLICT.
 * - PAT scopes change on the grant and the token snapshot together, so the
 *   issued-scope check keeps the token valid in both directions.
 * - OAuth scopes are not editable, and an OAuth grant never holds `sealed`.
 */
export async function updateGrant(
  runtime: Runtime,
  userId: string,
  raw: GrantUpdateInput,
  deps: { now?: () => Date } = {},
): Promise<GrantUpdateResult> {
  const parsed = grantUpdateInput.safeParse(raw);
  if (!parsed.success) throw invalidSelection();
  const input = parsed.data;
  const patch = input.acl ?? [];
  if (new Set(patch.map((entry) => entry.kbId)).size !== patch.length) throw invalidSelection();
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await lockLiveUser(query, userId);
    const found = await query<{
      userId: string | null;
      kind: string;
      scopes: string[];
      toolGroups: unknown;
      allowCreate: boolean;
      createdKbBits: string[];
      revokedAt: Date | string | null;
      tokenId: string | null;
      tokenRevokedAt: Date | string | null;
      tokenExpiresAt: Date | string | null;
    }>(
      `SELECT g."userId", g.kind::text AS kind, g.scopes, g."toolGroups", g."allowCreate",
              g."createdKbBits", g."revokedAt", t.id AS "tokenId",
              t."revokedAt" AS "tokenRevokedAt", t."expiresAt" AS "tokenExpiresAt"
         FROM "mcp_grant" g
         LEFT JOIN "mcp_personal_token" t ON t."grantId" = g.id
        WHERE g.id = $1::uuid
          FOR UPDATE OF g`,
      [input.id],
    );
    const row = found.rows[0];
    if (!row || row.userId !== userId) throw tokenNotFound();
    const at = (deps.now ?? (() => new Date()))();
    const storedGroups = parseStoredToolGroups(row.toolGroups);
    const tokenExpiry = toDate(row.tokenExpiresAt);
    const live =
      row.kind === "OAUTH" ||
      (row.kind === "PAT" &&
        row.tokenId !== null &&
        !row.tokenRevokedAt &&
        (row.tokenExpiresAt === null || (!!tokenExpiry && tokenExpiry > at)));
    if (row.revokedAt || !storedGroups || !live) throw grantInactive();
    const oauth = row.kind === "OAUTH";
    if (oauth && input.scopes !== undefined) throw invalidSelection();
    if (input.duration) {
      return createElevation(query, opId, userId, input, input.duration, {
        ...row,
        storedGroups,
        oauth,
      });
    }

    // Shape rules shared with minting, applied to the complete next ceiling.
    const allowCreate = input.allowCreate ?? row.allowCreate;
    let ceiling: ReturnType<typeof normalizeGrantCeiling>;
    try {
      ceiling = normalizeGrantCeiling({
        scopes: (input.scopes ?? row.scopes).filter((scope) =>
          (MCP_PAT_SCOPES as readonly string[]).includes(scope),
        ),
        toolGroups: input.toolGroups ?? storedGroups,
        acl: patch.filter((entry) => entry.bits.length > 0),
        allowCreate,
        createdKbBits: input.createdKbBits ?? (allowCreate ? row.createdKbBits : []),
      });
    } catch (error) {
      if (error instanceof McpGrantSelectionError) throw invalidSelection();
      throw error;
    }
    if (oauth && ceiling.toolGroups.includes("sealed")) throw invalidSelection();
    const nextScopes = oauth ? row.scopes : ceiling.scopes;
    const nextCreated = expandBits(ceiling.createdKbBits);

    // ACL patch against the stored rows of the named KBs, locked for this transaction.
    const stored = new Map<string, Permission[]>();
    if (patch.length > 0) {
      const current = await query<{ kbId: string; bits: string[] }>(
        `SELECT "kbId", bits FROM "grant_kb_acl"
          WHERE "grantId" = $1::uuid AND "kbId" = ANY($2::text[])
          ORDER BY "kbId" FOR UPDATE`,
        [input.id, patch.map((entry) => entry.kbId)],
      );
      for (const entry of current.rows) stored.set(entry.kbId, expandBits(entry.bits));
    }
    const cap = input.aclCap ? expandBits(input.aclCap) : null;
    const store = sqlAuthorityStore(query);
    const aclChanges: { kbId: string; before: Permission[]; after: Permission[] }[] = [];
    for (const entry of patch) {
      const before = stored.get(entry.kbId) ?? [];
      const requested = expandBits(entry.bits);
      const after = cap ? requested.filter((bit) => cap.includes(bit)) : requested;
      const added = setDiff(after, before);
      if (added.length === 0 && setDiff(before, after).length === 0) continue;
      // An entry that adds any bit is validated whole against live rights, as at mint.
      if (added.length > 0) {
        await validateAclAgainstLive(store, userId, [{ kbId: entry.kbId, bits: after }]);
      }
      aclChanges.push({ kbId: entry.kbId, before, after });
    }
    const inserted = aclChanges.filter((change) => change.before.length === 0).length;
    if (inserted > 0) {
      const count = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "grant_kb_acl" WHERE "grantId" = $1::uuid`,
        [input.id],
      );
      const removed = aclChanges.filter((change) => change.after.length === 0).length;
      if ((count.rows[0]?.count ?? 0) + inserted - removed > MCP_GRANT_MAX_ACL_ENTRIES) {
        throw invalidSelection();
      }
    }
    // The cap only ever removes bits, so it needs no live-rights check. Count (and
    // lock) the other stored entries it narrows; the patched ones are handled above.
    let capped = 0;
    if (cap) {
      const over = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM (
           SELECT 1 FROM "grant_kb_acl"
            WHERE "grantId" = $1::uuid AND NOT (bits <@ $2::text[])
              AND NOT ("kbId" = ANY($3::text[]))
              FOR UPDATE) locked`,
        [input.id, cap, patch.map((entry) => entry.kbId)],
      );
      capped = over.rows[0]?.count ?? 0;
    }

    // Classify every changed field; audit records exactly the changed values.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    let widened = false;
    let narrowed = false;
    const compare = (
      field: string,
      from: readonly string[],
      to: readonly string[],
      gained = setDiff(to, from).length > 0,
    ) => {
      const lost = setDiff(from, to).length > 0;
      if (setDiff(to, from).length === 0 && !lost) return;
      before[field] = from;
      after[field] = to;
      widened ||= gained;
      narrowed ||= lost;
    };
    // A removed scope always narrows: credentials issued with it stop being admissible.
    // An added scope widens when it adds a capability (mcp:write implies reads), or when
    // nothing was removed (adding mcp:read beside mcp:write is still recorded).
    const scopeCapabilities = (scopes: readonly string[]) => [
      ...(scopes.includes("mcp:read") || scopes.includes("mcp:write") ? ["read"] : []),
      ...(scopes.includes("mcp:write") ? ["write"] : []),
    ];
    compare(
      "scopes",
      row.scopes,
      nextScopes,
      setDiff(scopeCapabilities(nextScopes), scopeCapabilities(row.scopes)).length > 0 ||
        (setDiff(nextScopes, row.scopes).length > 0 &&
          setDiff(row.scopes, nextScopes).length === 0),
    );
    compare("toolGroups", storedGroups, ceiling.toolGroups);
    compare("allowCreate", row.allowCreate ? ["on"] : [], allowCreate ? ["on"] : []);
    if ("allowCreate" in after) {
      before.allowCreate = row.allowCreate;
      after.allowCreate = allowCreate;
    }
    compare("createdKbBits", expandBits(row.createdKbBits), nextCreated);
    if (aclChanges.length > 0) {
      // Bounded: a large patch is summarized by counts, never dumped entry by entry.
      if (aclChanges.length <= AUDIT_ACL_DETAIL_MAX) {
        before.acl = Object.fromEntries(aclChanges.map((change) => [change.kbId, change.before]));
        after.acl = Object.fromEntries(aclChanges.map((change) => [change.kbId, change.after]));
      } else {
        before.aclEntriesChanged = aclChanges.length;
        after.aclEntriesChanged = aclChanges.length;
      }
      widened ||= aclChanges.some((change) => setDiff(change.after, change.before).length > 0);
      narrowed ||= aclChanges.some((change) => setDiff(change.before, change.after).length > 0);
    }
    if (capped > 0) {
      before.aclCapped = capped;
      after.aclCapped = capped;
      after.aclCap = cap;
      narrowed = true;
    }
    if (!widened && !narrowed) return { id: input.id, widened, narrowed };

    await query(
      `UPDATE "mcp_grant"
          SET scopes = $2::text[], "toolGroups" = $3::text[], "allowCreate" = $4,
              "createdKbBits" = $5::text[],
              "widenedAt" = CASE WHEN $6::boolean THEN now() ELSE "widenedAt" END
        WHERE id = $1::uuid AND "revokedAt" IS NULL`,
      [input.id, nextScopes, ceiling.toolGroups, ceiling.allowCreate, nextCreated, widened],
    );
    if (!oauth) {
      // The token's scope snapshot moves with the grant, so the issued-scope check holds.
      await query(
        `UPDATE "mcp_personal_token" SET scopes = $3::text[]
          WHERE "grantId" = $1::uuid AND id = $2 AND "revokedAt" IS NULL`,
        [input.id, row.tokenId, nextScopes],
      );
    }
    if (capped > 0 && cap) {
      await query(
        `UPDATE "grant_kb_acl"
            SET bits = ARRAY(SELECT u.b FROM unnest(bits) WITH ORDINALITY AS u(b, n)
                              WHERE u.b = ANY($2::text[]) ORDER BY u.n)
          WHERE "grantId" = $1::uuid AND NOT (bits <@ $2::text[])
            AND NOT ("kbId" = ANY($3::text[]))`,
        [input.id, cap, patch.map((entry) => entry.kbId)],
      );
    }
    for (const change of aclChanges) {
      if (change.after.length === 0) {
        await query(`DELETE FROM "grant_kb_acl" WHERE "grantId" = $1::uuid AND "kbId" = $2`, [
          input.id,
          change.kbId,
        ]);
      } else if (change.before.length === 0) {
        await query(
          `INSERT INTO "grant_kb_acl" ("grantId", "kbId", bits, "createdAt")
             VALUES ($1::uuid, $2, $3::text[], now())`,
          [input.id, change.kbId, change.after],
        );
      } else {
        await query(
          `UPDATE "grant_kb_acl" SET bits = $3::text[] WHERE "grantId" = $1::uuid AND "kbId" = $2`,
          [input.id, change.kbId, change.after],
        );
      }
    }
    const audit = {
      opId,
      outcome: "SUCCESS" as const,
      actorKey: `user:${userId}`,
      actorUserIdSnapshot: userId,
      actorUserId: userId,
      grantIdSnapshot: input.id,
      metadata: { before: JSON.stringify(before), after: JSON.stringify(after) },
    };
    if (widened) await recordAuditEvent(query, { ...audit, action: "MCP_GRANT_WIDENED" });
    if (narrowed) {
      await recordAuditEvent(query, { ...audit, action: "MCP_GRANT_NARROWED" });
      // A narrowing is never masked by temporary access: it ends every active elevation.
      await endActiveElevations(query, { opId, userId, grantId: input.id });
    }
    return { id: input.id, widened, narrowed };
  });
}

/** Bounded audit JSON of what an elevation adds; a large ACL is recorded as a count. */
const elevationAudit = (elevation: {
  toolGroups: readonly string[];
  allowCreate: boolean;
  createdKbBits: readonly string[];
  acl: readonly { kbId: string; bits: readonly string[] }[];
}) =>
  JSON.stringify({
    ...(elevation.toolGroups.length ? { toolGroups: elevation.toolGroups } : {}),
    ...(elevation.allowCreate ? { allowCreate: true, createdKbBits: elevation.createdKbBits } : {}),
    ...(elevation.acl.length === 0
      ? {}
      : elevation.acl.length <= AUDIT_ACL_DETAIL_MAX
        ? { acl: Object.fromEntries(elevation.acl.map((entry) => [entry.kbId, entry.bits])) }
        : { aclEntries: elevation.acl.length }),
  });

/**
 * Temporary access, inside `updateGrant`'s authority-lock
 * transaction with the grant row locked. The input is the elevated ceiling: it
 * may only add to the stored one (any removal is rejected), every added KB bit
 * is validated against the caller's live rights exactly as a widening, and
 * only the additions are stored as one `McpGrantElevation` that lapses at
 * `expiresAt` (database clock). Effective authority is read live, so the
 * elevation applies to the next call and to work waiting on the lock, and
 * stops applying the moment it expires or is ended. Never adds scopes.
 */
async function createElevation(
  query: LockQuery,
  opId: string,
  userId: string,
  input: z.output<typeof grantUpdateInput>,
  duration: McpElevationDuration,
  row: {
    scopes: string[];
    storedGroups: McpToolGroup[];
    allowCreate: boolean;
    createdKbBits: string[];
    oauth: boolean;
  },
): Promise<GrantUpdateResult> {
  const grantId = input.id;
  const patch = input.acl ?? [];
  const allowCreate = input.allowCreate ?? row.allowCreate;
  let ceiling: ReturnType<typeof normalizeGrantCeiling>;
  try {
    // Shape rules shared with minting; an empty `bits` (a removal) is rejected here.
    ceiling = normalizeGrantCeiling({
      scopes: row.scopes.filter((scope) => (MCP_PAT_SCOPES as readonly string[]).includes(scope)),
      toolGroups: input.toolGroups ?? row.storedGroups,
      acl: patch,
      allowCreate,
      createdKbBits: input.createdKbBits ?? (allowCreate ? row.createdKbBits : []),
    });
  } catch (error) {
    if (error instanceof McpGrantSelectionError) throw invalidSelection();
    throw error;
  }
  if (row.oauth && ceiling.toolGroups.includes("sealed")) throw invalidSelection();
  // Additions only: temporary access never removes anything from the stored ceiling.
  const baseCreated = row.allowCreate ? expandBits(row.createdKbBits) : [];
  const nextCreated = ceiling.allowCreate ? expandBits(ceiling.createdKbBits) : [];
  if (
    setDiff(row.storedGroups, ceiling.toolGroups).length > 0 ||
    (row.allowCreate && !ceiling.allowCreate) ||
    setDiff(baseCreated, nextCreated).length > 0
  ) {
    throw invalidSelection();
  }
  const addedGroups = setDiff(ceiling.toolGroups, row.storedGroups);
  const elevatesCreate = setDiff(nextCreated, baseCreated).length > 0;

  const stored = new Map<string, Permission[]>();
  if (patch.length > 0) {
    const current = await query<{ kbId: string; bits: string[] }>(
      `SELECT "kbId", bits FROM "grant_kb_acl"
        WHERE "grantId" = $1::uuid AND "kbId" = ANY($2::text[])
        ORDER BY "kbId" FOR SHARE`,
      [grantId, patch.map((entry) => entry.kbId)],
    );
    for (const entry of current.rows) stored.set(entry.kbId, expandBits(entry.bits));
  }
  const store = sqlAuthorityStore(query);
  const acl: { kbId: string; bits: Permission[] }[] = [];
  for (const entry of ceiling.acl) {
    const before = stored.get(entry.kbId) ?? [];
    const requested = expandBits(entry.bits);
    if (setDiff(before, requested).length > 0) throw invalidSelection();
    const gained = setDiff(requested, before);
    if (gained.length === 0) continue;
    // The added bits (with what they imply) must be held live, exactly as a widening.
    const [validated] = await validateAclAgainstLive(store, userId, [
      { kbId: entry.kbId, bits: gained },
    ]);
    if (validated) acl.push(validated);
  }
  if (addedGroups.length === 0 && !elevatesCreate && acl.length === 0) {
    return { id: grantId, widened: false, narrowed: false };
  }

  // Bounded: at most MCP_ELEVATION_MAX_ACTIVE in force, each selecting at most
  // MCP_GRANT_MAX_ACL_ENTRIES KBs (input schema). The base ACL is not capped:
  // creator appends legitimately grow it past that.
  const active = await query<{ active: number }>(
    `SELECT COUNT(*)::int AS active FROM "mcp_grant_elevation" e
      WHERE e."grantId" = $1::uuid AND ${ACTIVE_ELEVATION_SQL}`,
    [grantId],
  );
  if ((active.rows[0]?.active ?? 0) >= MCP_ELEVATION_MAX_ACTIVE) {
    throw new KbDomainError("QUOTA_EXCEEDED", "Too many active temporary access grants");
  }
  if (acl.length > MCP_GRANT_MAX_ACL_ENTRIES) throw invalidSelection();

  const elevationId = randomUUID();
  const created = await query<{ expiresAt: Date | string }>(
    `INSERT INTO "mcp_grant_elevation"
       (id, "grantId", "createdAt", "expiresAt", "toolGroups", "allowCreate", "createdKbBits",
        "createdByUserIdSnapshot")
     VALUES ($1::uuid, $2::uuid, clock_timestamp(), clock_timestamp() + ($3 * interval '1 second'),
             $4::text[], $5, $6::text[], $7)
     RETURNING "expiresAt"`,
    [
      elevationId,
      grantId,
      ELEVATION_SECONDS[duration],
      addedGroups,
      elevatesCreate,
      elevatesCreate ? nextCreated : [],
      userId,
    ],
  );
  for (const entry of acl) {
    await query(
      `INSERT INTO "grant_elevation_kb_acl" ("elevationId", "kbId", bits)
         VALUES ($1::uuid, $2, $3::text[])`,
      [elevationId, entry.kbId, entry.bits],
    );
  }
  const expiresAt = toDate(created.rows[0]?.expiresAt);
  if (!expiresAt) throw new KbDomainError("INTERNAL", "Elevation was not recorded");
  await recordAuditEvent(query, {
    opId,
    action: "MCP_GRANT_ELEVATED",
    outcome: "SUCCESS",
    actorKey: `user:${userId}`,
    actorUserIdSnapshot: userId,
    actorUserId: userId,
    grantIdSnapshot: grantId,
    metadata: {
      elevationId,
      expiresAt: expiresAt.toISOString(),
      after: elevationAudit({
        toolGroups: addedGroups,
        allowCreate: elevatesCreate,
        createdKbBits: elevatesCreate ? nextCreated : [],
        acl,
      }),
    },
  });
  return {
    id: grantId,
    widened: true,
    narrowed: false,
    elevation: { id: elevationId, expiresAt },
  };
}

/**
 * Ends every elevation of one grant that is in force now, inside the caller's
 * authority-lock transaction, and records one `MCP_GRANT_ELEVATION_ENDED`
 * event under the caller's opId listing the ended ids (bounded by
 * MCP_ELEVATION_MAX_ACTIVE). Used when a permanent edit narrows the grant.
 */
async function endActiveElevations(
  query: LockQuery,
  input: { opId: string; userId: string; grantId: string },
): Promise<string[]> {
  const ended = await query<{ id: string }>(
    `UPDATE "mcp_grant_elevation" e SET "revokedAt" = clock_timestamp()
      WHERE e."grantId" = $1::uuid AND ${ACTIVE_ELEVATION_SQL}
      RETURNING e.id::text AS id`,
    [input.grantId],
  );
  const ids = ended.rows.map((row) => row.id).sort();
  if (ids.length > 0) {
    await recordAuditEvent(query, {
      opId: input.opId,
      action: "MCP_GRANT_ELEVATION_ENDED",
      outcome: "SUCCESS",
      actorKey: `user:${input.userId}`,
      actorUserIdSnapshot: input.userId,
      actorUserId: input.userId,
      grantIdSnapshot: input.grantId,
      metadata: { elevationIds: JSON.stringify(ids), reasonCode: "narrowed" },
    });
  }
  return ids;
}

/**
 * End now: permanently ends one of the caller's own elevations.
 * Under the authority lock, so the next admission and any work waiting on the
 * lock no longer see it. Foreign or unknown elevations are NOT_FOUND; one that
 * already ended or expired is a no-op (`ended: false`, no audit event).
 */
export async function endGrantElevation(
  runtime: Runtime,
  userId: string,
  elevationId: string,
): Promise<{ id: string; ended: boolean }> {
  if (!UUID.test(elevationId)) throw tokenNotFound();
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await lockLiveUser(query, userId);
    const found = await query<{ grantId: string; userId: string | null; active: boolean }>(
      `SELECT e."grantId"::text AS "grantId", g."userId", (${ACTIVE_ELEVATION_SQL}) AS active
         FROM "mcp_grant_elevation" e JOIN "mcp_grant" g ON g.id = e."grantId"
        WHERE e.id = $1::uuid
          FOR UPDATE OF e`,
      [elevationId],
    );
    const row = found.rows[0];
    if (!row || row.userId !== userId) throw tokenNotFound();
    if (!row.active) return { id: elevationId, ended: false };
    await query(
      `UPDATE "mcp_grant_elevation" SET "revokedAt" = clock_timestamp()
        WHERE id = $1::uuid AND "revokedAt" IS NULL`,
      [elevationId],
    );
    await recordAuditEvent(query, {
      opId,
      action: "MCP_GRANT_ELEVATION_ENDED",
      outcome: "SUCCESS",
      actorKey: `user:${userId}`,
      actorUserIdSnapshot: userId,
      actorUserId: userId,
      grantIdSnapshot: row.grantId,
      metadata: { elevationId },
    });
    return { id: elevationId, ended: true };
  });
}

/** Account teardown: tombstone every grant before the user row is deleted (FK SET NULL). */
export function revokeUserGrantsForRemoval(query: LockQuery, userId: string): Promise<void> {
  return revokeUserMcpGrants((sql, params) => query(sql, params), userId, "account_removal");
}

/** Shown per elevation in the lists; the rest is counted (`kbCount`). */
const ELEVATION_LIST_ACL_MAX = 25;

/** One active elevation as the credential lists return it. */
export type GrantElevationRow = {
  id: string;
  expiresAt: string;
  /** Whole seconds left by the database clock when the list was read. */
  remainingSeconds: number;
  toolGroups: string[];
  allowCreate: boolean;
  createdKbBits: string[];
  acl: { kbId: string; bits: string[] }[];
  kbCount: number;
};

/**
 * A live grant's (alias `g`) elevations in force, soonest expiry first: at most
 * MCP_ELEVATION_MAX_ACTIVE rows, each with a bounded ACL preview.
 */
const ACTIVE_ELEVATIONS_JSON_SQL = `COALESCE((
  SELECT jsonb_agg(x ORDER BY x."expiresAt", x.id) FROM (
    SELECT e.id::text AS id, e."expiresAt",
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM e."expiresAt" - clock_timestamp())))::int AS "remainingSeconds",
           e."toolGroups", e."allowCreate", e."createdKbBits",
           COALESCE((SELECT jsonb_agg(ea ORDER BY ea."kbId") FROM (
             SELECT "kbId", bits FROM grant_elevation_kb_acl WHERE "elevationId" = e.id
              ORDER BY "kbId" LIMIT ${ELEVATION_LIST_ACL_MAX}) ea), '[]'::jsonb) AS acl,
           (SELECT COUNT(*)::int FROM grant_elevation_kb_acl WHERE "elevationId" = e.id) AS "kbCount"
      FROM mcp_grant_elevation e
     WHERE e."grantId" = g.id AND g."revokedAt" IS NULL AND ${ACTIVE_ELEVATION_SQL}
     ORDER BY e."expiresAt", e.id LIMIT ${MCP_ELEVATION_MAX_ACTIVE}) x), '[]'::jsonb)`;

function page(input: z.input<typeof pageInput>) {
  const parsed = pageInput.parse(input);
  return { take: parsed.limit ?? LIST_DEFAULT, cursor: parsed.cursor ?? null };
}

export async function listPersonalTokens(
  runtime: Runtime,
  userId: string,
  input: z.input<typeof pageInput>,
) {
  const { take, cursor } = page(input);
  return inAuthorityTransaction(runtime, async (query) => {
    await lockLiveUser(query, userId);
    const { rows } = await query<{
      id: string;
      name: string;
      lookupPrefix: string;
      scopes: string[];
      toolGroups: string[];
      allowCreate: boolean;
      createdKbBits: string[];
      grantId: string;
      createdAt: Date;
      expiresAt: Date | null;
      revokedAt: Date | null;
      widenedAt: Date | null;
      elevations: GrantElevationRow[];
    }>(
      `SELECT t.id, t.name, t."lookupPrefix", t.scopes, g."toolGroups", g."allowCreate",
              g."createdKbBits", t."grantId"::text AS "grantId", t."createdAt", t."expiresAt",
              t."revokedAt", g."widenedAt", ${ACTIVE_ELEVATIONS_JSON_SQL} AS elevations
         FROM mcp_personal_token t JOIN mcp_grant g ON g.id = t."grantId"
        WHERE t."userId" = $1 AND ($2::text IS NULL OR t.id > $2)
        ORDER BY t.id LIMIT $3`,
      [userId, cursor, take + 1],
    );
    const items = rows.slice(0, take);
    return { items, nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null };
  });
}

type GrantAclEntry = { kbId: string; bits: string[]; name: string | null };
/**
 * The KB's name for a grant ACL row `x`, only while the viewer (the `viewer`
 * bind parameter) can still read that KB (ACTIVE, owned or live-shared);
 * otherwise null and the UI shows the id. A revoked share never discloses
 * later renames.
 */
const aclKbNameSql = (viewer: "$1" | "$4") => `(SELECT kb.name FROM knowledge_base kb
    WHERE kb.id = x."kbId" AND kb.state = 'ACTIVE'::"KnowledgeBaseState"
      AND (kb."ownerId" = ${viewer} OR EXISTS (SELECT 1 FROM kb_share s
            WHERE s."kbId" = kb.id AND s."userId" = ${viewer} AND s."revokedAt" IS NULL)))`;

export async function listGrants(
  runtime: Runtime,
  userId: string,
  input: z.input<typeof grantPageInput>,
) {
  const parsed = grantPageInput.parse(input);
  const { kind } = parsed;
  const { take, cursor } = page({ limit: parsed.limit, cursor: parsed.cursor });
  if (cursor && !UUID.test(cursor)) throw invalidSelection();
  return inAuthorityTransaction(runtime, async (query, opId) => {
    await lockLiveUser(query, userId);
    const { rows } = await query<{
      id: string;
      kind: "PAT" | "OAUTH";
      clientId: string;
      clientName: string | null;
      scopes: string[];
      toolGroups: string[];
      allowCreate: boolean;
      createdKbBits: string[];
      createdAt: Date;
      revokedAt: Date | null;
      widenedAt: Date | null;
      acl: GrantAclEntry[];
      elevations: GrantElevationRow[];
    }>(
      `SELECT g.id::text AS id, g.kind::text AS kind, g."clientId",
              (SELECT c.name FROM oauth_client c WHERE c."clientId" = g."clientId") AS "clientName",
              g.scopes, g."toolGroups",
              g."allowCreate", g."createdKbBits", g."createdAt", g."revokedAt", g."widenedAt",
              ${ACTIVE_ELEVATIONS_JSON_SQL} AS elevations,
              COALESCE((SELECT jsonb_agg(a ORDER BY a."kbId") FROM (
                SELECT x."kbId", x.bits, ${aclKbNameSql("$1")} AS name FROM grant_kb_acl x
                 WHERE x."grantId" = g.id
                 ORDER BY x."kbId" LIMIT $4) a), '[]'::jsonb) AS acl
         FROM mcp_grant g WHERE g."userId" = $1 AND ($2::uuid IS NULL OR g.id > $2::uuid)
          AND ($5::text IS NULL OR g.kind::text = $5)
         ORDER BY g.id LIMIT $3`,
      [userId, cursor, take + 1, MCP_GRANT_MAX_ACL_ENTRIES + 1, kind ?? null],
    );
    const items = rows.slice(0, take).map((row) => {
      const acl = row.acl.slice(0, MCP_GRANT_MAX_ACL_ENTRIES);
      return {
        ...row,
        acl,
        // A new inspection must discard previously loaded tails, even when
        // several writes leave the preview and cardinality unchanged.
        aclSnapshot: opId,
        aclNextCursor: row.acl.length > acl.length ? (acl.at(-1)?.kbId ?? null) : null,
      };
    });
    return { items, nextCursor: rows.length > take ? (items.at(-1)?.id ?? null) : null };
  });
}

/** Stored ceilings can grow through authorized creator appends. Inspect all pages without clipping authority. */
export async function listGrantAcl(
  runtime: Runtime,
  userId: string,
  input: z.input<typeof grantAclPageInput>,
) {
  const parsed = grantAclPageInput.parse(input);
  const { grantId } = parsed;
  const { take, cursor } = page({ limit: parsed.limit, cursor: parsed.cursor });
  return inAuthorityTransaction(runtime, async (query) => {
    await lockLiveUser(query, userId);
    const owner = await query<{ userId: string | null }>(
      `SELECT "userId" FROM mcp_grant WHERE id = $1::uuid`,
      [grantId],
    );
    if (owner.rows[0]?.userId !== userId) throw tokenNotFound();
    const { rows } = await query<GrantAclEntry>(
      `SELECT x."kbId", x.bits, ${aclKbNameSql("$4")} AS name
         FROM grant_kb_acl x
        WHERE x."grantId" = $1::uuid AND ($2::text IS NULL OR x."kbId" > $2)
        ORDER BY x."kbId" LIMIT $3`,
      [grantId, cursor, pageTake(take), userId],
    );
    const items = rows.slice(0, take);
    return { items, nextCursor: rows.length > take ? (items.at(-1)?.kbId ?? null) : null };
  });
}
