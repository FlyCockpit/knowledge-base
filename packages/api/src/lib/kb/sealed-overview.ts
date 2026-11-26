import { z } from "zod";
import { cursorTokenSchema, decodeCursor, encodeCursor } from "../pagination";
import { remoteSealedNamespace } from "./attachment";
import { KbDomainError } from "./errors";
import { kbBareRepoPath, readRefShaAsync, runGitAsync } from "./git-read";
import type { LockQuery } from "./lock";
import { sqlAuthorityStore } from "./permissions";
import { assertLiveIdentity, type Principal } from "./principal";
import { uuidSchema } from "./protocol/common";
import type { KbRuntimeConfig } from "./runtime";
import { asOwner, sealedValuesEligibleSql } from "./sealed-records";
import { sealedReference } from "./sealed-reference";

/**
 * The owner's metadata view of a KB's sealed values: names, dates, approvals,
 * the documents that mention them and the tokens they could approve. Every
 * read runs under the same gate as enroll/grant/revoke (browser identity, live
 * enrolled 2FA, exact current owner). Nothing here ever selects ciphertext, and
 * nothing here is a capability: approvals still name one record and one key.
 */
type Runtime = Pick<KbRuntimeConfig, "coordinator" | "canonicalOrigin" | "reposDir">;

const kbIdSchema = z.string().regex(/^[a-z0-9]{24,32}$/);
export const sealedListInput = z.strictObject({
  kbId: kbIdSchema,
  cursor: cursorTokenSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
/** Values `usage` scans per call: the client asks for the values it shows (one list page). */
export const SEALED_USAGE_MAX_VALUES = 50;
export const sealedUsageInput = z.strictObject({
  kbId: kbIdSchema,
  recordIds: z.array(uuidSchema).min(1).max(SEALED_USAGE_MAX_VALUES),
});

/** Approvals shown per value; a value with more says how many are hidden. */
export const SEALED_LIST_GRANTS_PER_VALUE = 50;
/** Document paths returned per value by `usage`. */
export const SEALED_USAGE_PATHS_PER_VALUE = 20;

export type SealedValueGrant = {
  consumerKind: "pat";
  consumerId: string;
  recipientKeyId: string;
  expiresAt: string;
  createdAt: string;
  /** The token's name, or null once the token row is gone. */
  tokenName: string | null;
  /** "self" for the owner's own tokens, else the member's display name. */
  holder: { kind: "self" } | { kind: "member"; name: string } | { kind: "unknown" };
  /** Whether this approval can still be used today (live token, unexpired approval). */
  active: boolean;
};
export type SealedValueItem = {
  recordId: string;
  reference: string;
  label: string | null;
  createdAt: string;
  grants: SealedValueGrant[];
  moreGrants: number;
};

/**
 * Whether each holder could use a token right now under the same live identity
 * rules admission applies (not banned, 2FA policy satisfied, account enabled).
 * One lookup per distinct holder; callers pass at most a page of rows.
 */
function liveHolders(query: LockQuery) {
  const store = sqlAuthorityStore(query);
  const seen = new Map<string, Promise<boolean>>();
  return (userId: string | null): Promise<boolean> => {
    if (!userId) return Promise.resolve(false);
    let live = seen.get(userId);
    if (!live) {
      live = store.loadIdentity(userId).then(
        (identity) => {
          try {
            assertLiveIdentity(identity);
            return true;
          } catch {
            return false;
          }
        },
        () => false,
      );
      seen.set(userId, live);
    }
    return live;
  };
}

function holderOf(
  ownerId: string,
  userId: string | null,
  name: string | null,
): SealedValueGrant["holder"] {
  if (userId === ownerId) return { kind: "self" };
  if (userId && name !== null) return { kind: "member", name };
  return { kind: "unknown" };
}

export async function listSealedValues(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof sealedListInput>,
): Promise<{ items: SealedValueItem[]; nextCursor: string | null }> {
  const input = sealedListInput.parse(raw);
  const namespace = remoteSealedNamespace(runtime.canonicalOrigin, input.kbId);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  // This list's keyset id is a record UUID; any other decodable token is not one of its cursors.
  if (cursor && !uuidSchema.safeParse(cursor.id).success)
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid cursor");
  return asOwner(runtime, principal, input.kbId, async (query) => {
    const records = await query<{ recordId: string; label: string | null; createdAt: Date }>(
      `SELECT "recordId"::text AS "recordId", label, "createdAt" FROM sealed_record
        WHERE "kbId"=$1 AND namespace=$2::uuid AND "revokedAt" IS NULL AND ciphertext IS NOT NULL
          AND ($3::timestamptz IS NULL OR ("createdAt","recordId") < ($3::timestamptz,$4::uuid))
        ORDER BY "createdAt" DESC, "recordId" DESC LIMIT $5`,
      [
        input.kbId,
        namespace,
        cursor?.sortValue ?? null,
        cursor ? cursor.id : null,
        input.limit + 1,
      ],
    );
    const page = records.rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      records.rows.length > input.limit && last
        ? encodeCursor({ sortValue: last.createdAt, id: last.recordId })
        : null;
    const items: SealedValueItem[] = [];
    for (const row of page) {
      const { grants, total } = await loadGrants(query, {
        kbId: input.kbId,
        ownerId: principal.userId,
        namespace,
        recordId: row.recordId,
      });
      items.push({
        recordId: row.recordId,
        reference: sealedReference(namespace, row.recordId),
        label: row.label,
        createdAt: row.createdAt.toISOString(),
        grants,
        moreGrants: Math.max(0, total - grants.length),
      });
    }
    return { items, nextCursor };
  });
}

async function loadGrants(
  query: LockQuery,
  {
    kbId,
    ownerId,
    namespace,
    recordId,
  }: {
    kbId: string;
    ownerId: string;
    namespace: string;
    recordId: string;
  },
): Promise<{ grants: SealedValueGrant[]; total: number }> {
  // pagination:audited — bounded by SEALED_LIST_GRANTS_PER_VALUE rows; the window count
  // reports how many more exist.
  const rows = await query<{
    consumerId: string;
    recipientKeyId: string;
    expiresAt: Date;
    createdAt: Date;
    tokenName: string | null;
    userId: string | null;
    userName: string | null;
    active: boolean;
    total: string;
  }>(
    // "active" = resolution could use it today: unexpired approval issued by the current
    // owner, live unexpired token, holder sealed-eligible now, and the token (base grant
    // plus active elevations) holds the sealed group, read scope and read on this KB.
    `WITH live_elevation AS (
       SELECT e.id, e."grantId", e."toolGroups" FROM mcp_grant_elevation e
        WHERE e."revokedAt" IS NULL AND e."expiresAt" > clock_timestamp())
     SELECT g."consumerId", g."recipientKeyId"::text AS "recipientKeyId", g."expiresAt", g."createdAt",
            t.name AS "tokenName", m."userId", u.name AS "userName",
            (g."expiresAt" > clock_timestamp() AND m.id IS NOT NULL AND m."revokedAt" IS NULL
              AND g."authorizerId" = $4
              AND t.id IS NOT NULL AND t."revokedAt" IS NULL
              AND (t."expiresAt" IS NULL OR t."expiresAt" > clock_timestamp())
              AND m."userId" IS NOT NULL AND ${sealedValuesEligibleSql("$5", 'm."userId"')}
              AND ('mcp:read'=ANY(m.scopes) OR 'mcp:write'=ANY(m.scopes))
              AND ('sealed'=ANY(m."toolGroups") OR EXISTS (SELECT 1 FROM live_elevation le
                     WHERE le."grantId"=m.id AND 'sealed'=ANY(le."toolGroups")))
              AND ('read'=ANY(m."allKbsBits")
                OR EXISTS (SELECT 1 FROM grant_kb_acl a WHERE a."grantId"=m.id AND a."kbId"=$5
                             AND 'read'=ANY(a.bits))
                OR EXISTS (SELECT 1 FROM grant_elevation_kb_acl ea
                             JOIN live_elevation le ON le.id=ea."elevationId"
                            WHERE le."grantId"=m.id AND ea."kbId"=$5 AND 'read'=ANY(ea.bits)))
            ) AS active,
            count(*) OVER () AS total
       FROM sealed_consumer_grant g
       LEFT JOIN mcp_grant m ON m.id = g."grantId"
       LEFT JOIN mcp_personal_token t ON t."grantId" = g."grantId"
       LEFT JOIN "user" u ON u.id = m."userId"
      WHERE g.namespace=$1::uuid AND g."recordId"=$2::uuid AND g."consumerKind"='pat'
      ORDER BY g."createdAt" DESC, g."consumerId", g."recipientKeyId" LIMIT $3`,
    [namespace, recordId, SEALED_LIST_GRANTS_PER_VALUE, ownerId, kbId],
  );
  const total = Number(rows.rows[0]?.total ?? 0);
  const isLive = liveHolders(query);
  const live = new Map<string | null, boolean>();
  for (const row of rows.rows)
    if (row.active === true && !live.has(row.userId))
      live.set(row.userId, await isLive(row.userId));
  const grants = rows.rows.map(
    (row): SealedValueGrant => ({
      consumerKind: "pat",
      consumerId: row.consumerId,
      recipientKeyId: row.recipientKeyId,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      tokenName: row.tokenName,
      holder: holderOf(ownerId, row.userId, row.userName),
      active: row.active === true && live.get(row.userId) === true,
    }),
  );
  return { grants, total };
}

/**
 * Documents on `main` whose text contains each value's reference. Read-only
 * and informational (the authoritative live-reference check stays in tree
 * validation): a bounded fixed-string `git grep` runs first, outside any lock,
 * and its result is returned only if the caller is still the exact owner.
 */
export async function sealedValueUsage(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof sealedUsageInput>,
  options: { signal?: AbortSignal } = {},
): Promise<{
  /** False when the scan could not finish (timeout, oversized output): absence proves nothing. */
  complete: boolean;
  usage: { recordId: string; paths: string[]; more: boolean }[];
}> {
  const input = sealedUsageInput.parse(raw);
  const namespace = remoteSealedNamespace(runtime.canonicalOrigin, input.kbId);
  const live = await asOwner(runtime, principal, input.kbId, async (query) => {
    // Only the asked-for records that are live on this KB; bounded by the input (≤ 50).
    const rows = await query<{ recordId: string }>(
      `SELECT "recordId"::text AS "recordId" FROM sealed_record
        WHERE "kbId"=$1 AND namespace=$2::uuid AND "recordId" = ANY($3::uuid[])
          AND "revokedAt" IS NULL AND ciphertext IS NOT NULL
        ORDER BY "createdAt" DESC, "recordId" DESC`,
      [input.kbId, namespace, [...new Set(input.recordIds)]],
    );
    return rows.rows.map((row) => row.recordId);
  });
  const found = new Map<string, Set<string>>(live.map((id) => [id, new Set<string>()]));
  let complete = true;
  const repo = kbBareRepoPath(runtime.reposDir, input.kbId);
  const read = { signal: options.signal, deadlineAt: Date.now() + 15_000 };
  try {
    // A KB without `main` yet has no documents. Otherwise scan that exact commit.
    const head = live.length ? await readRefShaAsync(repo, "refs/heads/main", read) : null;
    if (head) {
      const args = ["grep", "-z", "-o", "-i", "-F", "-I", "--no-color"];
      for (const id of live) args.push("-e", `knowledge_base:${namespace}:${id}}}`);
      args.push(head, "--", "*.md");
      const result = await runGitAsync(repo, args, {
        ...read,
        maxBuffer: 4 * 1024 * 1024,
        resultExitCodes: [1],
      });
      // `-z -o` prints `<commit>:<path>\0<match>\n` per occurrence.
      const prefix = `${head}:`;
      for (const line of String(result.stdout).split("\n")) {
        const nul = line.indexOf("\0");
        if (nul < 0 || !line.startsWith(prefix)) continue;
        const path = line.slice(prefix.length, nul);
        const match = line.slice(nul + 1).toLowerCase();
        const id = match.slice(`knowledge_base:${namespace}:`.length, -2);
        found.get(id)?.add(path);
      }
    }
  } catch {
    // Timeout, cancellation, oversized output or unreadable storage: report an incomplete
    // scan rather than fail the page; the list itself does not depend on this.
    complete = false;
    for (const paths of found.values()) paths.clear();
  }
  // The paths are returned only to a caller who is still the exact owner now.
  await asOwner(runtime, principal, input.kbId, async () => undefined);
  return {
    complete,
    usage: live.map((recordId) => {
      const paths = [...(found.get(recordId) ?? [])].sort();
      return {
        recordId,
        paths: paths.slice(0, SEALED_USAGE_PATHS_PER_VALUE),
        more: paths.length > SEALED_USAGE_PATHS_PER_VALUE,
      };
    }),
  };
}

/** Why an approval for this token would do nothing; null when it would work. */
export type SealedConsumerProblem =
  | "missing_sealed_tool_group"
  | "missing_read_scope"
  | "no_read_on_kb"
  | "holder_not_eligible"
  | "holder_inactive";

export type SealedConsumer = {
  consumerKind: "pat";
  consumerId: string;
  name: string;
  holder: { kind: "self" } | { kind: "member"; name: string };
  expiresAt: string | null;
  createdAt: string;
  problems: SealedConsumerProblem[];
  /**
   * The key this token decrypts with: registered by `kb login --recipient-key-file`
   * ("device"), or the key already approved for this token on this KB ("approved").
   */
  recipientKey: {
    recipientKeyId: string;
    recipientPublicKey: string;
    source: "device" | "approved";
  } | null;
};

/**
 * Tokens the owner may approve: the owner's own live, unexpired PATs, and the
 * live, unexpired PATs of members whose live share has `includeSealedValues`
 * and whose token names this KB in its ACL (the member scoped it here).
 * Nobody else's tokens are listed. `problems` mirrors what resolution needs, so
 * the UI can refuse a useless approval before it is created; the server-side
 * grant rules are unchanged.
 */
export async function listSealedConsumers(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof sealedListInput>,
): Promise<{ items: SealedConsumer[]; nextCursor: string | null }> {
  const input = sealedListInput.parse(raw);
  const namespace = remoteSealedNamespace(runtime.canonicalOrigin, input.kbId);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  return asOwner(runtime, principal, input.kbId, async (query) => {
    const rows = await query<{
      id: string;
      grantId: string;
      name: string;
      expiresAt: Date | null;
      createdAt: Date;
      userId: string;
      userName: string;
      sealedGroup: boolean;
      scopes: string[];
      readOnKb: boolean;
      eligible: boolean;
      deviceKeyId: string | null;
      deviceKey: string | null;
      approvedKeyId: string | null;
      approvedKey: string | null;
    }>(
      // Usability mirrors admission: the base grant united with its active temporary
      // elevations (not ended, expiresAt after the database clock).
      `WITH live_elevation AS (
         SELECT e.id, e."grantId", e."toolGroups" FROM mcp_grant_elevation e
          WHERE e."revokedAt" IS NULL AND e."expiresAt" > clock_timestamp())
       SELECT t.id, g.id::text AS "grantId", t.name, t."expiresAt", t."createdAt",
              g."userId", u.name AS "userName", g.scopes,
              ('sealed'=ANY(g."toolGroups") OR EXISTS (SELECT 1 FROM live_elevation le
                 WHERE le."grantId"=g.id AND 'sealed'=ANY(le."toolGroups"))) AS "sealedGroup",
              ('read'=ANY(g."allKbsBits")
                OR EXISTS (SELECT 1 FROM grant_kb_acl a WHERE a."grantId"=g.id AND a."kbId"=$1
                             AND 'read'=ANY(a.bits))
                OR EXISTS (SELECT 1 FROM grant_elevation_kb_acl ea
                             JOIN live_elevation le ON le.id=ea."elevationId"
                            WHERE le."grantId"=g.id AND ea."kbId"=$1 AND 'read'=ANY(ea.bits)))
                AS "readOnKb",
              ${sealedValuesEligibleSql("$1", 'g."userId"')} AS eligible,
              t."recipientKeyId"::text AS "deviceKeyId", t."recipientPublicKey" AS "deviceKey",
              prior."recipientKeyId" AS "approvedKeyId", prior."recipientPublicKey" AS "approvedKey"
         FROM mcp_personal_token t
         JOIN mcp_grant g ON g.id = t."grantId"
         JOIN "user" u ON u.id = g."userId"
         LEFT JOIN LATERAL (
           SELECT s."recipientKeyId"::text AS "recipientKeyId", s."recipientPublicKey"
             FROM sealed_consumer_grant s
            WHERE s."consumerKind"='pat' AND s."consumerId"=g.id::text AND s.namespace=$3::uuid
            ORDER BY s."createdAt" DESC LIMIT 1
         ) prior ON true
        WHERE g.kind='PAT' AND g."revokedAt" IS NULL AND t."revokedAt" IS NULL
          AND (t."expiresAt" IS NULL OR t."expiresAt" > clock_timestamp())
          AND (g."userId"=$2 OR (
                EXISTS (SELECT 1 FROM kb_share s WHERE s."kbId"=$1 AND s."userId"=g."userId"
                          AND s."revokedAt" IS NULL AND s."includeSealedValues")
                AND (EXISTS (SELECT 1 FROM grant_kb_acl a WHERE a."grantId"=g.id AND a."kbId"=$1)
                  OR EXISTS (SELECT 1 FROM grant_elevation_kb_acl ea
                               JOIN live_elevation le ON le.id=ea."elevationId"
                              WHERE le."grantId"=g.id AND ea."kbId"=$1))))
          AND ($4::timestamptz IS NULL OR (t."createdAt", t.id) < ($4::timestamptz, $5))
        ORDER BY t."createdAt" DESC, t.id DESC LIMIT $6`,
      [
        input.kbId,
        principal.userId,
        namespace,
        cursor?.sortValue ?? null,
        cursor ? cursor.id : null,
        input.limit + 1,
      ],
    );
    const page = rows.rows.slice(0, input.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.rows.length > input.limit && last
        ? encodeCursor({ sortValue: last.createdAt, id: last.id })
        : null;
    const isLive = liveHolders(query);
    const liveByUser = new Map<string, boolean>();
    for (const row of page)
      if (!liveByUser.has(row.userId)) liveByUser.set(row.userId, await isLive(row.userId));
    return {
      items: page.map((row): SealedConsumer => {
        const problems: SealedConsumerProblem[] = [];
        if (row.sealedGroup !== true) problems.push("missing_sealed_tool_group");
        if (!row.scopes.includes("mcp:read") && !row.scopes.includes("mcp:write"))
          problems.push("missing_read_scope");
        if (!row.readOnKb) problems.push("no_read_on_kb");
        if (!row.eligible) problems.push("holder_not_eligible");
        if (liveByUser.get(row.userId) !== true) problems.push("holder_inactive");
        const recipientKey =
          row.deviceKeyId && row.deviceKey
            ? {
                recipientKeyId: row.deviceKeyId,
                recipientPublicKey: row.deviceKey,
                source: "device" as const,
              }
            : row.approvedKeyId && row.approvedKey
              ? {
                  recipientKeyId: row.approvedKeyId,
                  recipientPublicKey: row.approvedKey,
                  source: "approved" as const,
                }
              : null;
        return {
          consumerKind: "pat",
          consumerId: row.grantId,
          name: row.name,
          holder:
            row.userId === principal.userId
              ? { kind: "self" }
              : { kind: "member", name: row.userName },
          expiresAt: row.expiresAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          problems,
          recipientKey,
        };
      }),
      nextCursor,
    };
  });
}
