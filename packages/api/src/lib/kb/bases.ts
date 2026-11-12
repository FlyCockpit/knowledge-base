import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@knowledge-base/db/client";
import { runAccountTeardown } from "./account-removal";
import { prismaAssetQuery } from "./asset-authz";
import { buildKbAttachment, buildKbViewerAttachment } from "./attachment";
import { recordAuditEvent } from "./audit";
import { cursorExpiry, KB_PAGE_DEFAULT, KB_PAGE_MAX, stableFilterHash } from "./cursor";
import { fromAdmissionError, fromOperationIntentError, KbDomainError } from "./errors";
import { generateKnowledgeBaseId } from "./id";
import {
  assertGrantMayCreate,
  ConcurrentKbCreateReservationError,
  createKbCreatePublication,
  KB_DELETE_OPERATION,
  KB_UPDATE_OPERATION,
  liveKbCreateReceiptBody,
} from "./kb-lifecycle-intent";
import { KbLockError, type LockQuery } from "./lock";
import {
  abortIntent,
  abortPreparedIntentsForKb,
  canonicalRequestHash,
  findOperationIntent,
  OperationIntentError,
} from "./operation-intent";
import { validateMarkdownBytes } from "./parse-markdown";
import {
  assertLiveBrowserIdentity,
  authorize,
  expandBits,
  intersectBits,
  type Permission,
  prismaAuthorityStore,
  recheckRead,
  sqlAuthorityStore,
} from "./permissions";
import {
  actorKeyFor,
  assertTokenAdmissible,
  type BrowserPrincipal,
  type CredentialVerifier,
  decideOnElevationSnapshot,
  KbAdmissionError,
  type Principal,
  type TokenPrincipal,
} from "./principal";
import { kbDescriptionSchema, kbNameSchema } from "./protocol/common";
import { releaseCommittedCharge, releaseQuota } from "./quota";
import { assertKbRecoveryComplete, recoverCreatingKnowledgeBase } from "./recovery";
import type { KbRuntimeConfig } from "./runtime";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateKbName(name: string): void {
  if (!kbNameSchema.safeParse(name).success) {
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid name");
  }
}

export function validateKbSlug(slug: string): void {
  if (slug.length < 1 || slug.length > 63 || !SLUG.test(slug)) {
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid slug");
  }
}

export function validateKbDescription(description: string): void {
  // Shared metadata policy plus the generated-Markdown control check
  // (description is embedded verbatim in the initial index.md).
  if (
    !kbDescriptionSchema.safeParse(description).success ||
    validateMarkdownBytes(Buffer.from(description, "utf8"))
  ) {
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid description");
  }
}

function browserPrincipal(userId: string): BrowserPrincipal {
  return { kind: "browser", userId };
}

type KbCreateIntentSummary = {
  opId: string;
  requestHash: string;
  phase: string;
  reservedKbId: string | null;
  responseBody: unknown;
};

/**
 * Resolve the durable KB_CREATE reservation before allocating a fresh KB id,
 * so a retry of an interrupted create resumes the same persisted identity
 * instead of republishing under a second id.
 */
async function lookupKbCreateIntent(
  prisma: PrismaClient,
  actorKey: string,
  idempotencyKey: string,
): Promise<KbCreateIntentSummary | null> {
  const rows = await prisma.$queryRaw<KbCreateIntentSummary[]>`
    SELECT "opId", "requestHash", phase::text AS phase, "reservedKbId", "responseBody"
      FROM "operation_intent"
     WHERE "actorKey" = ${actorKey}
       AND operation = 'KB_CREATE'
       AND "idempotencyKey" = ${idempotencyKey}
     LIMIT 1`;
  return rows[0] ?? null;
}

type KbCreateInput = { name: string; slug: string; description: string; idempotencyKey: string };

export async function createKnowledgeBase(
  runtime: KbRuntimeConfig,
  userId: string,
  input: KbCreateInput,
): Promise<Record<string, unknown>> {
  return createKnowledgeBaseFor(runtime, browserPrincipal(userId), undefined, input);
}

/**
 * `knowledge_bases_create` for a token: requires literal mcp:write
 * and a live grant with allowCreate + read-bearing createdKbBits, checked
 * before any intent or CREATING row. Journal finalization appends ONLY the new
 * KB with the approved ceiling to the creating grant; the owner is the user,
 * but ownership never widens the token beyond that ceiling.
 */
export async function createKnowledgeBaseAsGrant(
  runtime: KbRuntimeConfig,
  principal: TokenPrincipal,
  verifier: CredentialVerifier,
  input: KbCreateInput,
): Promise<Record<string, unknown>> {
  return createKnowledgeBaseFor(runtime, principal, verifier, input);
}

async function createKnowledgeBaseFor(
  runtime: KbRuntimeConfig,
  principal: BrowserPrincipal | TokenPrincipal,
  verifier: CredentialVerifier | undefined,
  input: KbCreateInput,
): Promise<Record<string, unknown>> {
  assertKbRecoveryComplete();
  const userId = principal.userId;
  const store = prismaAuthorityStore(runtime.prisma);
  const requestHash = canonicalRequestHash(input);
  const actorKey = actorKeyFor(principal);
  try {
    if (principal.kind === "token") {
      if (!verifier) throw new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
      // Unlocked pre-check with the caller's verifier; repeated under locks.
      await assertTokenAdmissible(principal, verifier);
      await assertGrantMayCreate(prismaAssetQuery(runtime.prisma), principal);
    } else {
      await assertLiveBrowserIdentity(store, userId);
    }
    for (let attempt = 0; ; attempt += 1) {
      const existing = await lookupKbCreateIntent(runtime.prisma, actorKey, input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
        }
        if (existing.phase === "FINALIZED" && existing.responseBody) {
          if (!existing.reservedKbId) {
            throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
          }
          // Live per-KB reauthorization (same level as the in-lock
          // create replay) with a live-derived attachment — the stored
          // receipt body is never returned to a creator who lost the KB.
          if (principal.kind === "token") {
            return liveKbCreateReceiptBody(
              prismaAssetQuery(runtime.prisma),
              principal,
              existing.reservedKbId,
              existing.opId,
              runtime.canonicalOrigin,
            );
          }
          return replayKbAttachmentReceipt(runtime, userId, {
            kbId: existing.reservedKbId,
            operation: "write",
            operationId: existing.opId,
          });
        }
      }
      validateKbName(input.name);
      validateKbSlug(input.slug);
      validateKbDescription(input.description);
      const reservedKbId = existing?.reservedKbId ?? generateKnowledgeBaseId();
      const publication = createKbCreatePublication({
        store,
        principal,
        reposDir: runtime.reposDir,
        canonicalOrigin: runtime.canonicalOrigin,
        reservedKbId,
        request: input,
        ratePort: runtime.ratePort,
        diskMeter: runtime.diskMeter,
      });
      const opId = randomUUID();
      try {
        return await runtime.coordinator.run({
          opId,
          kind: "git-write",
          kbIds: [reservedKbId],
          barrier: publication.barrier,
          run: async (ctx) => {
            const executor = runtime.createGitExecutor?.(ctx, reservedKbId);
            if (!executor) {
              throw new Error("KB create requires a supervised Git executor");
            }
            return publication.publish(ctx.lease, executor);
          },
        });
      } catch (error) {
        // A same-key racer reserved a different id between our lookup and the
        // lock: resolve the persisted reservation on the next attempt.
        if (error instanceof ConcurrentKbCreateReservationError && attempt < 2) continue;
        throw error;
      }
    }
  } catch (error) {
    const mapped = fromAdmissionError(error) ?? fromOperationIntentError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

type KbRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  headSha: string | null;
  metadataVersion: number;
  state: string;
  ownerId: string | null;
  activeGenerationId: string | null;
};

async function loadKbRow(prisma: PrismaClient, kbId: string): Promise<KbRow | null> {
  return prisma.knowledgeBase.findUnique({
    where: { id: kbId },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      headSha: true,
      metadataVersion: true,
      state: true,
      ownerId: true,
      activeGenerationId: true,
    },
  });
}

async function loadKbRowViaQuery(query: LockQuery, kbId: string): Promise<KbRow | null> {
  const result = await query<KbRow>(
    `SELECT id, name, slug, description, "headSha", "metadataVersion",
            state::text AS state, "ownerId", "activeGenerationId"
       FROM "knowledge_base" WHERE id = $1`,
    [kbId],
  );
  return result.rows[0] ?? null;
}

/**
 * Receipt replay for an already-committed create or update. A retry
 * rechecks live mutation authority before returning a private response, so the
 * replay reauthorizes against the KB — NOT_FOUND/FORBIDDEN once the actor lost
 * the authority the mutation required — and the returned attachment
 * (capabilities included) is re-derived from the live row instead of the
 * stored receipt. Identity-only replay stays reserved for the minimal
 * {operationId, tombstoned:true} deletion receipt.
 */
async function replayKbAttachmentReceipt(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  input: { kbId: string; operation: "manage" | "write"; operationId: unknown },
  verifier?: CredentialVerifier,
): Promise<Record<string, unknown>> {
  if (typeof input.operationId !== "string" || input.operationId.length === 0) {
    throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  }
  const principal = typeof actor === "string" ? browserPrincipal(actor) : actor;
  const store = prismaAuthorityStore(runtime.prisma);
  const admission = {
    store,
    principal,
    verifier,
    kbId: input.kbId,
    operation: input.operation,
  };
  await authorize(admission);
  const row = await loadKbRow(runtime.prisma, input.kbId);
  if (!row) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  // Metadata assembly may yield to revocation or a permission downgrade.
  // Recheck the mutation's required bit and readiness at delivery; the earlier
  // metadata snapshot must not override a newly observed repair state.
  const auth = await authorize(admission);
  return {
    operationId: input.operationId,
    kb: buildKbAttachment({ ...row, state: auth.state }, auth.bits, runtime.canonicalOrigin),
  };
}

function parseKbListCursor(lastKey: string | null): { name: string; id: string } | null {
  if (!lastKey) return null;
  const split = lastKey.indexOf("\0");
  if (split <= 0) return null;
  return { name: lastKey.slice(0, split), id: lastKey.slice(split + 1) };
}

function kbListCursorKey(name: string, id: string): string {
  return `${name}\0${id}`;
}

/**
 * Which of the caller's KBs a list returns: `all` (owned or shared — the MCP
 * and consent listing), `owned` (the caller is the owner) or `shared` (a live
 * share on a KB someone else owns). `owned` and `shared` partition `all`.
 */
export type KbListRelation = "all" | "owned" | "shared";

async function listKbRowsKeyset(
  prisma: PrismaClient,
  userId: string,
  after: { name: string; id: string } | null,
  take: number,
  grantId: string | null = null,
  relation: KbListRelation = "all",
  usableOnly = false,
  /** The admission's elevation snapshot: only these elevations contribute KBs. */
  elevationIds: readonly string[] = [],
): Promise<KbRow[]> {
  const owned = relation !== "shared";
  const shared = relation !== "owned";
  if (!after) {
    return prisma.$queryRaw<KbRow[]>`
      SELECT kb.id, kb.name, kb.slug, kb.description, kb."headSha", kb."metadataVersion",
             kb.state::text AS state, kb."ownerId", kb."activeGenerationId"
        FROM "knowledge_base" kb
       WHERE (${grantId}::uuid IS NULL OR EXISTS (SELECT 1 FROM "grant_kb_acl" a WHERE a."grantId" = ${grantId}::uuid AND a."kbId" = kb.id) OR EXISTS (SELECT 1 FROM "grant_elevation_kb_acl" ea JOIN "mcp_grant_elevation" e ON e.id = ea."elevationId" WHERE e."grantId" = ${grantId}::uuid AND ea."kbId" = kb.id AND e.id = ANY(${elevationIds}::uuid[]) AND e."revokedAt" IS NULL))
         AND kb.state IN ('ACTIVE'::"KnowledgeBaseState", 'REPAIR_REQUIRED'::"KnowledgeBaseState")
         AND (NOT ${usableOnly}::boolean OR (kb.state = 'ACTIVE'::"KnowledgeBaseState" AND kb."headSha" IS NOT NULL))
         AND (
           (${owned}::boolean AND kb."ownerId" = ${userId})
           OR (
             ${shared}::boolean
             AND kb."ownerId" IS DISTINCT FROM ${userId}
             AND EXISTS (
               SELECT 1 FROM "kb_share" s
                WHERE s."kbId" = kb.id AND s."userId" = ${userId} AND s."revokedAt" IS NULL
             )
           )
         )
       ORDER BY kb.name COLLATE "C" ASC, kb.id COLLATE "C" ASC
       LIMIT ${take}`;
  }
  return prisma.$queryRaw<KbRow[]>`
    SELECT kb.id, kb.name, kb.slug, kb.description, kb."headSha", kb."metadataVersion",
           kb.state::text AS state, kb."ownerId", kb."activeGenerationId"
      FROM "knowledge_base" kb
     WHERE (${grantId}::uuid IS NULL OR EXISTS (SELECT 1 FROM "grant_kb_acl" a WHERE a."grantId" = ${grantId}::uuid AND a."kbId" = kb.id) OR EXISTS (SELECT 1 FROM "grant_elevation_kb_acl" ea JOIN "mcp_grant_elevation" e ON e.id = ea."elevationId" WHERE e."grantId" = ${grantId}::uuid AND ea."kbId" = kb.id AND e.id = ANY(${elevationIds}::uuid[]) AND e."revokedAt" IS NULL))
         AND kb.state IN ('ACTIVE'::"KnowledgeBaseState", 'REPAIR_REQUIRED'::"KnowledgeBaseState")
         AND (NOT ${usableOnly}::boolean OR (kb.state = 'ACTIVE'::"KnowledgeBaseState" AND kb."headSha" IS NOT NULL))
       AND (
         (${owned}::boolean AND kb."ownerId" = ${userId})
         OR (
           ${shared}::boolean
           AND kb."ownerId" IS DISTINCT FROM ${userId}
           AND EXISTS (
             SELECT 1 FROM "kb_share" s
              WHERE s."kbId" = kb.id AND s."userId" = ${userId} AND s."revokedAt" IS NULL
           )
         )
       )
       AND (kb.name COLLATE "C", kb.id COLLATE "C") > (${after.name} COLLATE "C", ${after.id} COLLATE "C")
     ORDER BY kb.name COLLATE "C" ASC, kb.id COLLATE "C" ASC
     LIMIT ${take}`;
}

export async function getKnowledgeBaseAttachment(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  kbId: string,
  verifier?: CredentialVerifier,
): Promise<ReturnType<typeof buildKbAttachment>> {
  const { row, bits } = await readKbEntry(runtime, actor, kbId, verifier);
  return buildKbAttachment(row, bits, runtime.canonicalOrigin);
}

/**
 * Browser view of one KB: metadata (including unreadied repair rows) plus whether the
 * signed-in caller is its owner, so owner-only controls (delete, transfer,
 * sealed) render only for the owner. The server still enforces ownership on
 * every owner-only action; this flag only drives what is shown.
 */
export async function getKnowledgeBaseForViewer(
  runtime: KbRuntimeConfig,
  userId: string,
  kbId: string,
): Promise<ReturnType<typeof buildKbViewerAttachment> & { isOwner: boolean }> {
  const { row, bits } = await readKbEntry(runtime, userId, kbId);
  return {
    ...buildKbViewerAttachment(row, bits, runtime.canonicalOrigin),
    isOwner: row.ownerId === userId,
  };
}

async function readKbEntry(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  kbId: string,
  verifier?: CredentialVerifier,
): Promise<{ row: KbRow; bits: Permission[] }> {
  const principal = typeof actor === "string" ? browserPrincipal(actor) : actor;
  assertKbRecoveryComplete();
  const store = prismaAuthorityStore(runtime.prisma);
  await authorize({
    store,
    principal,
    verifier,
    kbId,
    operation: "read",
  });
  const row = await loadKbRow(runtime.prisma, kbId);
  if (!row) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  const auth = await recheckRead({
    store,
    principal,
    verifier,
    kbId,
    operation: "read",
  });
  // Use final readiness alongside the assembled metadata snapshot.
  return { row: { ...row, state: auth.state }, bits: auth.bits };
}

export async function listKnowledgeBases(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  input: { limit?: number; cursor?: string | null },
  verifier?: CredentialVerifier,
  /** Test seam: runs after a token page is built, before its final recheck. */
  hooks: { beforeDecision?: () => Promise<void> } = {},
): Promise<{ items: ReturnType<typeof buildKbAttachment>[]; nextCursor: string | null }> {
  const page = await listKbEntries(
    runtime,
    actor,
    { ...input, relation: "all", usableOnly: true },
    verifier,
    hooks,
  );
  return {
    items: page.items.map(({ row, bits }) => buildKbAttachment(row, bits, runtime.canonicalOrigin)),
    nextCursor: page.nextCursor,
  };
}

/**
 * Browser KB list: `owned` and `shared` pages paginate independently
 * (each has its own cursor binding) and every item says whether the caller
 * owns it.
 */
export async function listKnowledgeBasesForViewer(
  runtime: KbRuntimeConfig,
  userId: string,
  input: { limit?: number; cursor?: string | null; relation?: KbListRelation },
): Promise<{
  items: (ReturnType<typeof buildKbViewerAttachment> & { isOwner: boolean })[];
  nextCursor: string | null;
}> {
  const page = await listKbEntries(runtime, userId, {
    ...input,
    relation: input.relation ?? "all",
    usableOnly: false,
  });
  return {
    items: page.items.map(({ row, bits }) => ({
      ...buildKbViewerAttachment(row, bits, runtime.canonicalOrigin),
      isOwner: row.ownerId === userId,
    })),
    nextCursor: page.nextCursor,
  };
}

/** The KB list's scan found nothing returnable mid-race: temporary, so retryable. */
export const kbListRetryError = () =>
  new KbDomainError("STORAGE_UNAVAILABLE", "Knowledge base list changed; retry");

/** Rows one call may examine; rejections only come from races, so this is never reached in practice. */
const KB_LIST_SCAN_BATCHES = 4;

async function listKbEntries(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  input: { limit?: number; cursor?: string | null; relation: KbListRelation; usableOnly: boolean },
  verifier?: CredentialVerifier,
  hooks: { beforeDecision?: () => Promise<void> } = {},
): Promise<{
  items: { row: KbRow; bits: Permission[] }[];
  nextCursor: string | null;
}> {
  const principal = typeof actor === "string" ? browserPrincipal(actor) : actor;
  assertKbRecoveryComplete();
  if (principal.kind !== "token") {
    return listKbPage(runtime, principal, input, undefined, []);
  }
  if (!verifier) throw new KbAdmissionError("UNAUTHORIZED", "Credential unavailable");
  // Temporary access: the page is built from one admission's elevation
  // snapshot and delivered only while that snapshot still holds.
  return decideOnElevationSnapshot({
    load: async (baseOnly) => {
      const admission = await assertTokenAdmissible(principal, verifier);
      return {
        elevations: baseOnly ? { ids: [], validUntil: null } : admission.elevations,
      };
    },
    publish: (snapshot) =>
      listKbPage(runtime, principal, input, verifier, snapshot.elevations?.ids ?? []),
    recheck: () => assertTokenAdmissible(principal, verifier),
    beforeDecision: hooks.beforeDecision,
  });
}

/**
 * The stored ceiling of each listed KB under one elevation snapshot: the base
 * GrantKbAcl united with exactly the snapshot's elevations (expanded). Bounded
 * by the page's candidates.
 */
async function snapshotCeilings(
  prisma: PrismaClient,
  grantId: string,
  rows: readonly KbRow[],
  elevationIds: readonly string[],
): Promise<Map<string, Permission[]>> {
  const ceilings = new Map<string, Permission[]>();
  if (rows.length === 0) return ceilings;
  const kbIds = rows.map((row) => row.id);
  const found = await prisma.$queryRaw<{ kbId: string; bits: string[] }[]>`
    SELECT x."kbId", array_agg(DISTINCT x.b) AS bits FROM (
      SELECT a."kbId", unnest(a.bits) AS b FROM "grant_kb_acl" a
       WHERE a."grantId" = ${grantId}::uuid AND a."kbId" = ANY(${kbIds}::text[])
      UNION ALL
      SELECT ea."kbId", unnest(ea.bits) FROM "grant_elevation_kb_acl" ea
        JOIN "mcp_grant_elevation" e ON e.id = ea."elevationId"
       WHERE e."grantId" = ${grantId}::uuid AND ea."kbId" = ANY(${kbIds}::text[])
         AND e.id = ANY(${elevationIds}::uuid[]) AND e."revokedAt" IS NULL
    ) x GROUP BY x."kbId"`;
  for (const row of found) ceilings.set(row.kbId, expandBits(row.bits));
  return ceilings;
}

/**
 * One keyset page. Rows are examined in order and each is authorized, then
 * re-authorized at the return boundary. The cursor is built from the last row
 * actually returned, never from a rejected one, so it can carry no name or id
 * the caller may not read; rejected rows after it are examined again next
 * time (no returned row is skipped or repeated). Rejected rows never end a
 * page early: scanning continues (bounded) to fill it.
 */
async function listKbPage(
  runtime: KbRuntimeConfig,
  principal: Principal,
  input: { limit?: number; cursor?: string | null; relation: KbListRelation; usableOnly: boolean },
  verifier: CredentialVerifier | undefined,
  elevationIds: readonly string[],
): Promise<{
  items: { row: KbRow; bits: Permission[] }[];
  nextCursor: string | null;
}> {
  const userId = principal.userId;
  const limit = Math.min(Math.max(input.limit ?? KB_PAGE_DEFAULT, 1), KB_PAGE_MAX);
  const actorKey = actorKeyFor(principal);
  const filterHash = stableFilterHash({
    list: input.relation === "all" ? "owned-and-shared" : input.relation,
    grant: principal.kind === "token" ? principal.grantGeneration : null,
  });
  const sortKey = "name:asc";
  let after = input.cursor
    ? parseKbListCursor(
        runtime.cursorSigner.verify(input.cursor, {
          actorKey,
          kbId: "*",
          filterHash,
          sortKey,
          revision: "*",
        }).lastKey,
      )
    : null;
  const store = prismaAuthorityStore(runtime.prisma);
  const candidates: KbRow[] = [];
  let more = false;
  for (let batch = 0; batch < KB_LIST_SCAN_BATCHES; batch += 1) {
    const rows = await listKbRowsKeyset(
      runtime.prisma,
      userId,
      after,
      limit + 1,
      principal.kind === "token" ? principal.grantId : null,
      input.relation,
      input.usableOnly,
      elevationIds,
    );
    for (const row of rows) {
      if (candidates.length === limit) {
        more = true;
        break;
      }
      after = { name: row.name, id: row.id };
      try {
        await authorize({ store, principal, verifier, kbId: row.id, operation: "read" });
        candidates.push(row);
      } catch (error) {
        // Unreadable entries are omitted; infrastructure failures propagate.
        if (error instanceof KbAdmissionError && error.code === "NOT_FOUND") continue;
        throw error;
      }
    }
    if (more || rows.length <= limit) break;
    // A full batch with room left: rejected rows; the scan budget is bounded.
    more = batch === KB_LIST_SCAN_BATCHES - 1;
  }
  // A token's capabilities never exceed the snapshot the page was built from:
  // live authorization (below) stays the gate, but its bits union every
  // elevation in force at that instant, including ones outside this snapshot
  // (or any, in the base-only fallback). Intersecting can only narrow.
  const ceiling =
    principal.kind === "token"
      ? await snapshotCeilings(runtime.prisma, principal.grantId, candidates, elevationIds)
      : null;
  // Final live authorization over the assembled page, at the return boundary:
  // entries revoked while later entries were processed are removed here, and
  // capabilities derive from this last check rather than the earlier one.
  const items: { row: KbRow; bits: Permission[] }[] = [];
  for (const row of candidates) {
    try {
      const auth = await recheckRead({
        store,
        principal,
        verifier,
        kbId: row.id,
        operation: "read",
      });
      // A concurrent repair transition must not become a common attachment.
      if (input.usableOnly && auth.state !== "ACTIVE") continue;
      const bits = ceiling ? intersectBits(auth.bits, ceiling.get(row.id) ?? []) : auth.bits;
      if (!bits.includes("read")) continue;
      items.push({ row: { ...row, state: auth.state }, bits });
    } catch (error) {
      if (error instanceof KbAdmissionError && error.code === "NOT_FOUND") continue;
      throw error;
    }
  }
  if (!more) return { items, nextCursor: null };
  const last = items.at(-1)?.row;
  // Nothing returnable in the whole scan budget: a race in progress. A
  // retryable failure rather than a position naming a row the caller cannot read.
  if (!last) throw kbListRetryError();
  const nextCursor = runtime.cursorSigner.sign({
    v: 1,
    actorKey,
    kbId: "*",
    filterHash,
    sortKey,
    revision: "*",
    lastKey: kbListCursorKey(last.name, last.id),
    exp: cursorExpiry(),
  });
  return { items, nextCursor };
}

async function replayOrCheckIdempotency(
  prisma: PrismaClient,
  lookup: { actorKey: string; kbId: string; operation: string; idempotencyKey: string },
  requestHash: string,
): Promise<Record<string, unknown> | null> {
  const existing = await prisma.operationIntent.findFirst({
    where: {
      actorKey: lookup.actorKey,
      kbId: lookup.kbId,
      operation: lookup.operation,
      idempotencyKey: lookup.idempotencyKey,
    },
    select: { requestHash: true, phase: true, responseBody: true },
  });
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
  }
  if (existing.phase === "FINALIZED" && existing.responseBody) {
    return existing.responseBody as Record<string, unknown>;
  }
  return null;
}

export async function updateKnowledgeBase(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  input: {
    kbId: string;
    metadataVersion: number;
    idempotencyKey: string;
    name?: string;
    description?: string;
  },
  verifier?: CredentialVerifier,
): Promise<Record<string, unknown>> {
  const principal = typeof actor === "string" ? browserPrincipal(actor) : actor;
  const userId = principal.userId;
  assertKbRecoveryComplete();

  if (input.name === undefined && input.description === undefined) {
    throw new KbDomainError("INVALID_ARGUMENT", "No fields to update");
  }
  const requestHash = canonicalRequestHash(input);
  const actorKey = actorKeyFor(principal);
  // Live manage admission precedes any key/hash disclosure. Fresh-only
  // domain validation follows replay so changed invalid metadata mismatches.
  await authorize({
    store: prismaAuthorityStore(runtime.prisma),
    principal,
    verifier,
    kbId: input.kbId,
    operation: "manage",
  });
  const replay = await replayOrCheckIdempotency(
    runtime.prisma,
    {
      actorKey,
      kbId: input.kbId,
      operation: KB_UPDATE_OPERATION,
      idempotencyKey: input.idempotencyKey,
    },
    requestHash,
  );
  if (replay) {
    // Receipt replay for an already-committed update: the actor must still
    // hold live manage authority over this KB, and the returned attachment is
    // re-derived from live authority.
    return replayKbAttachmentReceipt(
      runtime,
      principal,
      {
        kbId: input.kbId,
        operation: "manage",
        operationId: replay.operationId,
      },
      verifier,
    );
  }
  if (input.name !== undefined) validateKbName(input.name);
  if (input.description !== undefined) validateKbDescription(input.description);
  const opId = randomUUID();
  let response: Record<string, unknown> | undefined;
  try {
    await runtime.coordinator.run({
      opId,
      kind: "git-write",
      kbIds: [input.kbId],
      barrier: {
        async prepare(lease) {
          lease.assertHeldKb(input.kbId);
          const prior = await findOperationIntent(lease.query, {
            actorKey,
            kbId: input.kbId,
            operation: KB_UPDATE_OPERATION,
            idempotencyKey: input.idempotencyKey,
          });
          if (prior?.phase === "FINALIZED" && prior.responseBody) {
            if (prior.requestHash !== requestHash) {
              throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
            }
            response = prior.responseBody as Record<string, unknown>;
          }
        },
        async reauthorize(ctx) {
          if (response) {
            // Queued receipt replay gets the same live per-KB manage
            // authorization as the outside-lock replay, on the reservation's
            // pinned session; the receipt body is re-derived from live rows.
            const admission = {
              store: sqlAuthorityStore(ctx.query),
              principal,
              verifier,
              kbId: input.kbId,
              operation: "manage" as const,
              query: ctx.query,
            };
            await authorize(admission);
            const row = await loadKbRowViaQuery(ctx.query, input.kbId);
            if (!row) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
            const auth = await authorize(admission);
            response = {
              operationId: response.operationId,
              kb: buildKbAttachment(
                { ...row, state: auth.state },
                auth.bits,
                runtime.canonicalOrigin,
              ),
            };
            return;
          }
          await authorize({
            store: sqlAuthorityStore(ctx.query),
            principal,
            verifier,
            kbId: input.kbId,
            operation: "manage",
            query: ctx.query,
          });
        },
        async reservePublication(ctx) {
          if (response) return;
          const name = input.name;
          const description = input.description;
          const updated = await ctx.query<{
            id: string;
            name: string;
            slug: string;
            description: string;
            headSha: string | null;
            metadataVersion: number;
            state: string;
            ownerId: string | null;
            activeGenerationId: string | null;
          }>(
            `UPDATE "knowledge_base"
                SET name = COALESCE($3, name),
                    description = COALESCE($4, description),
                    "metadataVersion" = "metadataVersion" + 1,
                    "updatedAt" = now()
              WHERE id = $1
                AND state <> 'TOMBSTONED'::"KnowledgeBaseState"
                AND "metadataVersion" = $2
            RETURNING id, name, slug, description, "headSha", "metadataVersion", state::text AS state, "ownerId", "activeGenerationId"`,
            [input.kbId, input.metadataVersion, name ?? null, description ?? null],
          );
          const row = updated.rows[0];
          if (!row) {
            throw new KbDomainError("CONFLICT", "Metadata version conflict");
          }
          const auth = await authorize({
            store: sqlAuthorityStore(ctx.query),
            principal,
            verifier,
            kbId: input.kbId,
            operation: "manage",
            query: ctx.query,
          });
          const kb = buildKbAttachment(
            { ...row, state: auth.state },
            auth.bits,
            runtime.canonicalOrigin,
          );
          response = { operationId: opId, kb };
          await ctx.query(
            `INSERT INTO "operation_intent"
              ("opId", "kbId", "actorKey", "actorUserIdSnapshot", "actorUserId", operation,
               "idempotencyKey", "requestHash", phase, "preparedDelta", "responseBody",
               "resultRevision", "resultStatus", "publishNonce", "finishedAt", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'FINALIZED'::"OperationIntentPhase",
                     $9::jsonb, $10::jsonb, $11, 'SUCCESS', $12, now(), now(), now())`,
            [
              opId,
              input.kbId,
              actorKey,
              userId,
              userId,
              KB_UPDATE_OPERATION,
              input.idempotencyKey,
              requestHash,
              JSON.stringify({ kind: "kb_update", metadataVersion: row.metadataVersion }),
              JSON.stringify(response),
              row.headSha,
              randomUUID(),
            ],
          );
          // The logical update event commits with its metadata delta
          // and opId; the (opId, action, outcome) unique key keeps replay from
          // duplicating it.
          await recordAuditEvent(ctx.query, {
            opId,
            action: "kb_update",
            outcome: "SUCCESS",
            actorKey,
            actorUserIdSnapshot: userId,
            actorUserId: userId,
            kbId: input.kbId,
            revision: row.headSha,
            metadata: { metadataVersion: String(row.metadataVersion) },
          });
        },
      },
      run: async () => {
        if (!response) throw new KbDomainError("CONFLICT", "Metadata version conflict");
        return response;
      },
    });
    return response!;
  } catch (error) {
    const mapped = fromAdmissionError(error) ?? fromOperationIntentError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

export async function deleteKnowledgeBase(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  input: { kbId: string; metadataVersion: number; idempotencyKey: string; confirm: string },
  verifier?: CredentialVerifier,
): Promise<{ operationId: string; tombstoned: true }> {
  const principal = typeof actor === "string" ? browserPrincipal(actor) : actor;
  const userId = principal.userId;
  assertKbRecoveryComplete();
  if (input.confirm !== "DELETE") {
    throw new KbDomainError("INVALID_ARGUMENT", "Confirm DELETE required");
  }
  const requestHash = canonicalRequestHash(input);
  const actorKey = actorKeyFor(principal);
  const replay = await replayOrCheckIdempotency(
    runtime.prisma,
    {
      actorKey,
      kbId: input.kbId,
      operation: KB_DELETE_OPERATION,
      idempotencyKey: input.idempotencyKey,
    },
    requestHash,
  );
  if (replay) {
    // The KB is already TOMBSTONED with ownerId NULL: per-KB authorize() can
    // only throw NOT_FOUND. The actor-bound, hash-verified receipt carries
    // nothing beyond {operationId, tombstoned:true}; live identity is still
    // required before it is returned.
    if (principal.kind === "token") {
      if (!verifier) throw new KbAdmissionError("UNAUTHORIZED", "Credential unavailable");
      await assertTokenAdmissible(principal, verifier);
    } else await assertLiveBrowserIdentity(prismaAuthorityStore(runtime.prisma), userId);
    return replay as { operationId: string; tombstoned: true };
  }
  const opId = randomUUID();
  let response: { operationId: string; tombstoned: true } | undefined;
  try {
    await runtime.coordinator.run({
      opId,
      kind: "git-write",
      kbIds: [input.kbId],
      barrier: {
        async prepare(lease) {
          lease.assertHeldKb(input.kbId);
          const prior = await findOperationIntent(lease.query, {
            actorKey,
            kbId: input.kbId,
            operation: KB_DELETE_OPERATION,
            idempotencyKey: input.idempotencyKey,
          });
          if (prior?.phase === "FINALIZED" && prior.responseBody) {
            if (prior.requestHash !== requestHash) {
              throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
            }
            response = prior.responseBody as { operationId: string; tombstoned: true };
          }
        },
        async reauthorize(ctx) {
          if (response) {
            if (principal.kind === "token") {
              if (!verifier) throw new KbAdmissionError("UNAUTHORIZED", "Credential unavailable");
              await assertTokenAdmissible(principal, verifier.forQuery?.(ctx.query) ?? verifier);
            } else await assertLiveBrowserIdentity(sqlAuthorityStore(ctx.query), userId, ctx.query);
            return;
          }
          await authorize({
            store: sqlAuthorityStore(ctx.query),
            principal,
            verifier,
            kbId: input.kbId,
            operation: "delete",
            query: ctx.query,
          });
        },
        async reservePublication(ctx) {
          if (response) return;
          const current = await ctx.query<{ ownerId: string | null; metadataVersion: number }>(
            `SELECT "ownerId", "metadataVersion"
               FROM "knowledge_base"
              WHERE id = $1 AND state <> 'TOMBSTONED'::"KnowledgeBaseState"
              FOR UPDATE`,
            [input.kbId],
          );
          const row = current.rows[0];
          if (!row) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
          if (row.ownerId !== userId) throw new KbDomainError("FORBIDDEN", "Forbidden");
          if (row.metadataVersion !== input.metadataVersion) {
            throw new KbDomainError("CONFLICT", "Metadata version conflict");
          }
          const ownerId = row.ownerId;
          // The previous writer has drained under our KB lock, but its create
          // publication may still need finalization or quarantine. Settle it
          // in this transaction before releasing the live-count charge.
          await recoverCreatingKnowledgeBase(ctx.query, runtime.reposDir, input.kbId);
          const createCharge = await ctx.query<{
            opId: string;
            reservationId: string;
            outcome: string;
          }>(
            `SELECT i."opId", r.id AS "reservationId", r.outcome::text AS outcome
               FROM "operation_intent" i
               JOIN "quota_reservation" r ON r.id::text = i."preparedDelta"->>'quotaReservationId'
              WHERE i.operation = 'KB_CREATE' AND i."kbId" = $1
              ORDER BY i."createdAt" DESC LIMIT 1`,
            [input.kbId],
          );
          const charge = createCharge.rows[0];
          if (charge) {
            // Diagnostic aborts retain refs/delta; FINALIZED receipts stay final.
            await abortIntent(ctx.query, charge.opId, "kb tombstoned");
            if (charge.outcome === "RESERVED") {
              await releaseQuota({ transactionQuery: ctx.query }, [charge.reservationId]);
            } else if (charge.outcome === "COMMITTED") {
              await releaseCommittedCharge(
                { transactionQuery: ctx.query },
                { dimension: "OWNER_LIVE_KB", subjectId: ownerId, amount: 1n, opId },
              );
            }
          }
          await ctx.query(
            `UPDATE "knowledge_base"
                SET state = 'TOMBSTONED'::"KnowledgeBaseState",
                    "ownerId" = NULL,
                    "metadataVersion" = "metadataVersion" + 1,
                    "updatedAt" = now()
              WHERE id = $1`,
            [input.kbId],
          );
          // Abort unpublished intents, retaining charges for objects kept on disk.
          await abortPreparedIntentsForKb(ctx.query, input.kbId, "kb tombstoned");
          await runAccountTeardown(ctx.query, input.kbId, userId, opId);
          response = { operationId: opId, tombstoned: true };
          await ctx.query(
            `INSERT INTO "operation_intent"
              ("opId", "kbId", "actorKey", "actorUserIdSnapshot", "actorUserId", operation,
               "idempotencyKey", "requestHash", phase, "preparedDelta", "responseBody",
               "resultStatus", "publishNonce", "finishedAt", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'FINALIZED'::"OperationIntentPhase",
                     $9::jsonb, $10::jsonb, 'SUCCESS', $11, now(), now(), now())`,
            [
              opId,
              input.kbId,
              actorKey,
              userId,
              userId,
              KB_DELETE_OPERATION,
              input.idempotencyKey,
              requestHash,
              JSON.stringify({ kind: "kb_delete", metadataVersion: input.metadataVersion }),
              JSON.stringify(response),
              randomUUID(),
            ],
          );
          // The tombstone's logical audit event commits in the same
          // transaction as the state delta; replay cannot duplicate it.
          await recordAuditEvent(ctx.query, {
            opId,
            action: "kb_tombstone",
            outcome: "SUCCESS",
            actorKey,
            actorUserIdSnapshot: userId,
            actorUserId: userId,
            kbId: input.kbId,
            metadata: { metadataVersion: String(input.metadataVersion) },
          });
        },
      },
      run: async () => {
        if (!response) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
        return response;
      },
    });
    return response!;
  } catch (error) {
    const mapped = fromAdmissionError(error) ?? fromOperationIntentError(error);
    if (mapped) throw mapped;
    throw error;
  }
}

export function mapKbDomainError(error: unknown): KbDomainError | null {
  if (error instanceof KbDomainError) return error;
  if (error instanceof KbAdmissionError) {
    return fromAdmissionError(error);
  }
  if (error instanceof OperationIntentError) {
    return fromOperationIntentError(error);
  }
  if (error instanceof KbLockError) {
    const code = error.code;
    switch (code) {
      case "LOCK_TIMEOUT":
      case "CONNECTION_LOST":
      case "ADMISSION_CLOSED":
        return new KbDomainError("STORAGE_UNAVAILABLE", "Storage unavailable");
      case "DEADLINE_EXCEEDED":
        return new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded");
      case "REVOKED":
        return new KbDomainError("CANCELLED", "Cancelled");
      case "LOCK_ORDER":
      case "AUTHORITY_HELD":
      case "NOT_HELD":
        return new KbDomainError("INTERNAL", "Internal error");
      default: {
        const exhaustive: never = code;
        return exhaustive;
      }
    }
  }
  return null;
}
