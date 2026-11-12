import { createHash, randomUUID } from "node:crypto";

import type { OperationIntentPhase } from "@knowledge-base/db/client";

import { admitSecurityEvent, recordAuditEvent } from "./audit";
import {
  type AuthorityBarrier,
  type AuthorityBarrierContext,
  assertAuthorityReservation,
} from "./authority-lock";
import {
  assertGitReadActive,
  type GitReadOptions,
  kbBareRepoPath,
  readCommitBlobs,
  readHeadSha,
  readRefSha,
  readRefShaAsync,
  runGitAsync,
} from "./git-read";
import {
  bindValidatedTreeForPublication,
  createTreeReuseCommit,
  fsyncPublishedRef,
  fsyncPublishedRefAsync,
  fsyncRefUpdate,
  type GitMutatingExecutor,
  objectExists,
  removeAbandonedPublicationLocks,
  removeAbandonedPublicationLocksAsync,
  validateProposedCommitTree,
} from "./git-write";
import { enqueueDurableJobOnQuery } from "./jobs";
import type { HeldLockLease, LockQuery } from "./lock";
import { authorize, type KbOperation, type LiveAuthorityStore } from "./permissions";
import type { BrowserPrincipal, CredentialVerifier, Principal } from "./principal";
import { KbAdmissionError } from "./principal";
import {
  type PushObjectFile,
  parsePushObjectFiles,
  retainedPushObjectBytes,
} from "./push-validation";
import { commitQuota, releaseCommittedCharge, releaseQuota } from "./quota";
export const KB_CREATE_OPERATION = "KB_CREATE";
export const JOURNAL_TEST_PUBLISH_OPERATION = "JOURNAL_TEST_PUBLISH";

const ACTOR_KEY = /^(user|grant):[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export type OperationIntentErrorCode =
  | "IDEMPOTENCY_MISMATCH"
  | "INTENT_CONFLICT"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "REPAIR_REQUIRED";

export class OperationIntentError extends Error {
  readonly code: OperationIntentErrorCode;
  constructor(code: OperationIntentErrorCode, message: string) {
    super(message);
    this.name = "OperationIntentError";
    this.code = code;
  }
}

import type { ChangesApplyPreparedDelta } from "./changes";
import type { PrMergeDelta } from "./pull-requests";

export type JournalPreparedDelta =
  | {
      kind: "journal_test_publish";
      headSha: string;
      marker: string;
      jobDedupKey: string;
    }
  | {
      kind: "git_push";
      headSha: string;
      refName: string;
      newBranch: boolean;
      /** The logical writes of a branch update (they resolve recorded conflicts). */
      touched?: { kind: "document" | "asset"; path: string }[];
      quotaReservationIds: string[];
      /** Always present, including empty inventories on uncharged PREPARED drafts. */
      objectFiles: PushObjectFile[];
    }
  | ChangesApplyPreparedDelta
  | PrMergeDelta;

export type JournalTestPublishRequest = {
  marker: string;
};

export type PublicationBarrier = {
  afterPrepared?: () => void | Promise<void>;
  afterCommitting?: () => void | Promise<void>;
  afterRefUpdate?: () => void | Promise<void>;
  afterDbFinalize?: () => void | Promise<void>;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

export function canonicalRequestHash(body: unknown): string {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export function actorKeyForUser(userId: string): string {
  return `user:${userId}`;
}

function assertActorKey(actorKey: string): void {
  if (!ACTOR_KEY.test(actorKey))
    throw new OperationIntentError("UNAUTHORIZED", "invalid actor key");
}

function assertIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "invalid idempotency key");
  }
}

export type IntentRow = {
  opId: string;
  kbId: string | null;
  reservedKbId: string | null;
  actorKey: string;
  actorUserIdSnapshot: string;
  actorUserId: string | null;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  phase: OperationIntentPhase;
  refName: string | null;
  oldRef: string | null;
  newRef: string | null;
  preparedDelta: unknown;
  responseBody: unknown;
  resultRevision: string | null;
  resultStatus: string | null;
  publishNonce: string;
  abortReason: string | null;
};

export async function findOperationIntent(
  query: LockQuery,
  where: { actorKey: string; kbId: string | null; operation: string; idempotencyKey: string },
): Promise<IntentRow | null> {
  return loadIntent(query, where);
}

async function loadIntent(
  query: LockQuery,
  where: { actorKey: string; kbId: string | null; operation: string; idempotencyKey: string },
  options?: { forUpdate?: boolean },
): Promise<IntentRow | null> {
  const rows = await query<IntentRow>(
    `SELECT "opId", "kbId", "reservedKbId", "actorKey", "actorUserIdSnapshot", "actorUserId",
            operation, "idempotencyKey", "requestHash", phase::text AS phase,
            "refName", "oldRef", "newRef", "preparedDelta", "responseBody",
            "resultRevision", "resultStatus", "publishNonce", "abortReason"
       FROM "operation_intent"
      WHERE "actorKey" = $1
        AND "kbId" IS NOT DISTINCT FROM $2
        AND operation = $3
        AND "idempotencyKey" = $4
        ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    [where.actorKey, where.kbId, where.operation, where.idempotencyKey],
  );
  return rows.rows[0] ?? null;
}

/**
 * Durable idempotency receipt for an immediately-finalized control-plane
 * mutation (no publication phases, e.g. share invitations). The receipt is
 * immutable once written: a retry replays `responseBody` without re-running
 * the mutation, so superseding the live invitation row can never retroactively
 * change what an earlier request did.
 */
export async function recordFinalizedReceipt(
  query: LockQuery,
  input: {
    kbId: string;
    actorUserId: string;
    actorKey?: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    opId?: string;
    responseBody: unknown;
  },
): Promise<IntentRow> {
  const actorKey = input.actorKey ?? actorKeyForUser(input.actorUserId);
  assertActorKey(actorKey);
  assertIdempotencyKey(input.idempotencyKey);
  const opId = input.opId ?? randomUUID();
  // Conflict-tolerant for the same transaction-safety rationale as
  // reserveKbCreateIntent: a losing racer reloads the winner instead of
  // aborting the surrounding transaction with SQLSTATE 25P02.
  await query(
    `INSERT INTO "operation_intent"
       ("opId", "createdAt", "updatedAt", "finishedAt", "kbId", "actorKey",
        "actorUserIdSnapshot", "actorUserId", operation, "idempotencyKey",
        "requestHash", phase, "responseBody", "resultStatus", "publishNonce")
     VALUES ($1, now(), now(), now(), $2, $3, $4, $5, $6, $7, $8,
             'FINALIZED'::"OperationIntentPhase", $9::jsonb, 'SUCCESS', $10)
     ON CONFLICT ("actorKey", "kbId", operation, "idempotencyKey") DO NOTHING`,
    [
      opId,
      input.kbId,
      actorKey,
      input.actorUserId,
      input.actorUserId,
      input.operation,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(input.responseBody),
      randomUUID(),
    ],
  );
  const row = await loadIntent(
    query,
    {
      actorKey,
      kbId: input.kbId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
    },
    { forUpdate: true },
  );
  if (!row) throw new OperationIntentError("INVALID_STATE", "receipt missing after insert");
  if (row.requestHash !== input.requestHash) {
    throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "request body mismatch");
  }
  return row;
}

export async function findFinalizedReceiptForUpdate(
  query: LockQuery,
  where: { actorKey: string; kbId: string; operation: string; idempotencyKey: string },
): Promise<IntentRow | null> {
  return loadIntent(query, where, { forUpdate: true });
}

async function loadKbCreateIntent(
  query: LockQuery,
  actorKey: string,
  idempotencyKey: string,
): Promise<IntentRow | null> {
  const rows = await query<IntentRow>(
    `SELECT "opId", "kbId", "reservedKbId", "actorKey", "actorUserIdSnapshot", "actorUserId",
            operation, "idempotencyKey", "requestHash", phase::text AS phase,
            "refName", "oldRef", "newRef", "preparedDelta", "responseBody",
            "resultRevision", "resultStatus", "publishNonce", "abortReason"
       FROM "operation_intent"
      WHERE "actorKey" = $1 AND operation = $2 AND "idempotencyKey" = $3`,
    [actorKey, KB_CREATE_OPERATION, idempotencyKey],
  );
  return rows.rows[0] ?? null;
}

export async function reserveKbCreateIntent(
  query: LockQuery,
  input: {
    actorKey: string;
    actorUserIdSnapshot: string;
    actorUserId: string;
    idempotencyKey: string;
    requestHash: string;
    reservedKbId: string;
  },
): Promise<IntentRow> {
  assertActorKey(input.actorKey);
  assertIdempotencyKey(input.idempotencyKey);
  // ON CONFLICT DO NOTHING keeps the surrounding transaction usable when a
  // concurrent same-key reservation wins: reloading inside a transaction that
  // just failed an INSERT would abort with SQLSTATE 25P02.
  await query(
    `INSERT INTO "operation_intent"
      ("opId", "createdAt", "updatedAt", "actorKey", "actorUserIdSnapshot", "actorUserId", operation, "idempotencyKey",
       "requestHash", phase, "reservedKbId", "publishNonce")
     VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, 'PREPARED'::"OperationIntentPhase", $8, $9)
     ON CONFLICT ("actorKey", operation, "idempotencyKey") WHERE operation = 'KB_CREATE' DO NOTHING`,
    [
      randomUUID(),
      input.actorKey,
      input.actorUserIdSnapshot,
      input.actorUserId,
      KB_CREATE_OPERATION,
      input.idempotencyKey,
      input.requestHash,
      input.reservedKbId,
      randomUUID(),
    ],
  );
  const row = await loadKbCreateIntent(query, input.actorKey, input.idempotencyKey);
  if (!row) throw new Error("failed to reserve kb create intent");
  if (row.requestHash !== input.requestHash) {
    throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "kb create body mismatch");
  }
  return row;
}

export async function reservePublicationIntent(
  query: LockQuery,
  input: {
    opId: string;
    kbId: string;
    actorKey: string;
    actorUserIdSnapshot: string;
    actorUserId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    refName: string;
    oldRef: string;
    newRef: string;
    preparedDelta: JournalPreparedDelta;
  },
): Promise<IntentRow> {
  assertActorKey(input.actorKey);
  assertIdempotencyKey(input.idempotencyKey);
  if (input.newRef === input.oldRef) {
    throw new OperationIntentError("INVALID_STATE", "publication intent requires distinct refs");
  }
  // Same transaction-safety rationale as reserveKbCreateIntent: the insert is
  // conflict-tolerant so a losing racer reloads the winner inside the same
  // still-valid transaction.
  await query(
    `INSERT INTO "operation_intent"
      ("opId", "createdAt", "updatedAt", "kbId", "actorKey", "actorUserIdSnapshot", "actorUserId", operation,
       "idempotencyKey", "requestHash", phase, "refName", "oldRef", "newRef",
       "preparedDelta", "publishNonce")
     VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, $8, 'PREPARED'::"OperationIntentPhase",
             $9, $10, $11, $12::jsonb, $13)
     ON CONFLICT ("actorKey", "kbId", operation, "idempotencyKey") DO NOTHING`,
    [
      input.opId,
      input.kbId,
      input.actorKey,
      input.actorUserIdSnapshot,
      input.actorUserId,
      input.operation,
      input.idempotencyKey,
      input.requestHash,
      input.refName,
      input.oldRef,
      input.newRef,
      JSON.stringify(input.preparedDelta),
      randomUUID(),
    ],
  );
  const row = await loadIntent(query, {
    actorKey: input.actorKey,
    kbId: input.kbId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
  });
  if (!row) throw new Error("failed to reserve publication intent");
  if (row.requestHash !== input.requestHash) {
    throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "request body mismatch");
  }
  return row;
}

async function authorizeWrite(
  store: LiveAuthorityStore,
  principal: BrowserPrincipal,
  kbId: string,
  query: LockQuery,
): Promise<void> {
  try {
    const authorization = await authorize({ store, principal, kbId, operation: "write", query });
    // Ordinary publication is admitted only on an ACTIVE knowledge base: a
    // REPAIR_REQUIRED quarantine means the Git authority and the index
    // disagree, and publishing on top of an unexplained ref would manufacture
    // history. Creation and explicit repair keep their own transitions.
    if (authorization.state !== "ACTIVE") {
      throw new OperationIntentError(
        "REPAIR_REQUIRED",
        `knowledge base state ${authorization.state} does not admit publication`,
      );
    }
  } catch (error) {
    if (
      error instanceof KbAdmissionError &&
      (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
    ) {
      throw new OperationIntentError("UNAUTHORIZED", "actor cannot publish");
    }
    throw error;
  }
}

export async function markIntentCommitting(
  context: AuthorityBarrierContext,
  store: LiveAuthorityStore,
  principal: BrowserPrincipal,
  kbId: string,
  opId: string,
): Promise<void> {
  assertAuthorityReservation(context, kbId);
  const { query } = context;
  await authorizeWrite(store, principal, kbId, query);
  const updated = await query(
    `UPDATE "operation_intent"
        SET phase = 'COMMITTING'::"OperationIntentPhase", "updatedAt" = now()
      WHERE "opId" = $1 AND phase = 'PREPARED'::"OperationIntentPhase"`,
    [opId],
  );
  if (updated.rowCount === 1) return;
  const current = await query<{ phase: string }>(
    `SELECT phase::text AS phase FROM "operation_intent" WHERE "opId" = $1`,
    [opId],
  );
  if (current.rows[0]?.phase === "COMMITTING") return;
  throw new OperationIntentError("INVALID_STATE", "intent is not prepared");
}

export async function applyJournalTestPublishDelta(
  query: LockQuery,
  intent: IntentRow,
): Promise<{ responseBody: Record<string, unknown>; resultRevision: string }> {
  const delta = intent.preparedDelta as JournalPreparedDelta;
  if (delta?.kind !== "journal_test_publish") {
    throw new OperationIntentError("INVALID_STATE", "unexpected prepared delta");
  }
  await query(
    `UPDATE "knowledge_base"
        SET "headSha" = $2, "updatedAt" = now()
      WHERE id = $1`,
    [intent.kbId, delta.headSha],
  );
  await enqueueDurableJobOnQuery(query, {
    dedupKey: delta.jobDedupKey,
    kind: "PROBE",
    desired: { marker: delta.marker },
  });
  await recordAuditEvent(query, {
    opId: intent.opId,
    action: "journal_test_publish",
    outcome: "SUCCESS",
    actorKey: intent.actorKey,
    actorUserIdSnapshot: intent.actorUserIdSnapshot,
    actorUserId: intent.actorUserId,
    kbId: intent.kbId,
    revision: delta.headSha,
    metadata: { headSha: delta.headSha, reasonCode: "journal_test" },
  });
  const responseBody = {
    operationId: intent.opId,
    headSha: delta.headSha,
    marker: delta.marker,
  };
  return { responseBody, resultRevision: delta.headSha };
}

export async function finalizeIntent(query: LockQuery, opId: string): Promise<IntentRow> {
  const rows = await query<IntentRow>(
    `SELECT "opId", "kbId", "reservedKbId", "actorKey", "actorUserIdSnapshot", "actorUserId",
            operation, "idempotencyKey", "requestHash", phase::text AS phase,
            "refName", "oldRef", "newRef", "preparedDelta", "responseBody",
            "resultRevision", "resultStatus", "publishNonce", "abortReason"
       FROM "operation_intent" WHERE "opId" = $1 FOR UPDATE`,
    [opId],
  );
  const intent = rows.rows[0];
  if (!intent) throw new OperationIntentError("NOT_FOUND", "intent missing");
  if (intent.phase === "FINALIZED") return intent;
  if (intent.phase !== "COMMITTING") {
    throw new OperationIntentError("INVALID_STATE", `cannot finalize from ${intent.phase}`);
  }
  const { applyPreparedPublicationDelta } = await import("./kb-lifecycle-intent.js");
  const { responseBody, resultRevision } = await applyPreparedPublicationDelta(query, intent);
  await query(
    `UPDATE "operation_intent"
        SET phase = 'FINALIZED'::"OperationIntentPhase",
            "responseBody" = $2::jsonb,
            "resultRevision" = $3,
            "resultStatus" = 'SUCCESS',
            "finishedAt" = now(),
            "updatedAt" = now()
      WHERE "opId" = $1`,
    [opId, JSON.stringify(responseBody), resultRevision],
  );
  const finalized = await query<IntentRow>(
    `SELECT "opId", "kbId", "reservedKbId", "actorKey", "actorUserIdSnapshot", "actorUserId",
            operation, "idempotencyKey", "requestHash", phase::text AS phase,
            "refName", "oldRef", "newRef", "preparedDelta", "responseBody",
            "resultRevision", "resultStatus", "publishNonce", "abortReason"
       FROM "operation_intent" WHERE "opId" = $1`,
    [opId],
  );
  return finalized.rows[0]!;
}

export async function abortIntent(query: LockQuery, opId: string, reason: string): Promise<void> {
  const rows = await query<AbortedPushAuditRow>(
    `UPDATE "operation_intent"
         SET phase = 'ABORTED'::"OperationIntentPhase",
             "abortReason" = $2,
             "resultStatus" = 'ABORTED',
             "finishedAt" = now(),
             "updatedAt" = now()
       WHERE "opId" = $1 AND phase IN ('PREPARED'::"OperationIntentPhase", 'COMMITTING'::"OperationIntentPhase")
       RETURNING "opId", operation, "actorKey", "actorUserIdSnapshot"`,
    [opId, reason],
  );
  for (const row of rows.rows) await auditAbortedPush(query, row);
}

type AbortedPushAuditRow = {
  opId: string;
  operation: string;
  actorKey: string;
  actorUserIdSnapshot: string;
};

/** Recovery can resolve an interrupted COMMITTING push to rejection later. Its
 * terminal audit uses the same request/opId as HTTP, so repeated recovery or an
 * already-recorded request rejection never adds a second logical event.
 */
async function auditAbortedPush(query: LockQuery, row: AbortedPushAuditRow) {
  if (row.operation !== "GIT_PUSH" || !admitSecurityEvent(row.actorKey)) return;
  await recordAuditEvent(query, {
    opId: row.opId,
    action: "git_push",
    outcome: "FAILURE",
    actorKey: row.actorKey,
    actorUserIdSnapshot: row.actorUserIdSnapshot,
    metadata: { reasonCode: "PUSH_REJECTED", requestId: row.opId },
  });
}

/** Quota reservations a prepared delta still holds, in both delta shapes (single id, id list). */
export function quotaReservationIdsInDelta(delta: unknown): string[] {
  if (!delta || typeof delta !== "object") return [];
  const record = delta as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof record.quotaReservationId === "string" && record.quotaReservationId) {
    ids.push(record.quotaReservationId);
  }
  if (Array.isArray(record.quotaReservationIds)) {
    for (const id of record.quotaReservationIds) {
      if (typeof id === "string" && id) ids.push(id);
    }
  }
  return ids;
}

function parseGitPushDelta(delta: unknown): Extract<JournalPreparedDelta, { kind: "git_push" }> {
  if (!delta || typeof delta !== "object")
    throw new OperationIntentError("REPAIR_REQUIRED", "Invalid push delta");
  const push = delta as Record<string, unknown>;
  if (
    push.kind !== "git_push" ||
    typeof push.headSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(push.headSha) ||
    typeof push.refName !== "string" ||
    !push.refName.startsWith("refs/heads/") ||
    typeof push.newBranch !== "boolean" ||
    !Array.isArray(push.quotaReservationIds) ||
    !push.quotaReservationIds.every((id) => typeof id === "string" && id.length > 0) ||
    (push.touched !== undefined &&
      (!Array.isArray(push.touched) ||
        !push.touched.every(
          (entry) =>
            entry &&
            (entry.kind === "document" || entry.kind === "asset") &&
            typeof entry.path === "string",
        )))
  )
    throw new OperationIntentError("REPAIR_REQUIRED", "Invalid push delta");
  let objectFiles: PushObjectFile[];
  try {
    objectFiles = parsePushObjectFiles(push.objectFiles);
  } catch {
    throw new OperationIntentError("REPAIR_REQUIRED", "Invalid push object inventory");
  }
  return { ...push, objectFiles } as Extract<JournalPreparedDelta, { kind: "git_push" }>;
}

/**
 * Settle an unpublished intent without forgiving retained physical history.
 * PREPARED changes have already materialized their measured objects; aborting
 * the ref update does not remove those bytes. Pushes instead retain only their
 * inventoried canonical files after quarantine migration. Commit that allocation
 * and release unused branch/owner slots and disk admission reservations (the
 * disk meter now sees the retained files). Reservation outcomes make retries
 * exactly-once. Repair paths keep their reservations held for operator review.
 */
export async function settleAbortedIntentQuota(
  query: LockQuery,
  delta: unknown,
  repoPath?: string,
): Promise<void> {
  const push =
    (delta as { kind?: unknown } | null)?.kind === "git_push" ? parseGitPushDelta(delta) : null;
  const assets = (delta as ChangesApplyPreparedDelta | null)?.assets;
  if (assets?.uploads.length) {
    // Only proven unpublished settlement releases ownership. Divergence keeps
    // claims quarantined so expiry cannot destroy publication evidence.
    await query(
      `UPDATE "staged_upload" SET "reservedByOpId" = NULL
      WHERE id = ANY($1::uuid[]) AND state = 'READY'::"StagedUploadState"`,
      [assets.uploads.map((upload) => upload.id)],
    );
  }
  const ids = quotaReservationIdsInDelta(delta);
  if (ids.length === 0) return;
  const history = await query<{ id: string; amount: string; subjectId: string }>(
    `SELECT r.id, r.amount::text AS amount, a."subjectId" FROM "quota_reservation" r
       JOIN "quota_account" a ON a.id = r."accountId"
      WHERE r.id = ANY($1::text[]) AND a.dimension = 'KB_HISTORY_BYTES'::"QuotaDimension"`,
    [ids],
  );
  // Charged pushes persist a validated inventory before COMMITTING. Without a
  // repo path (tombstoning), retain the full history charge conservatively.
  const retained =
    push && repoPath ? BigInt(retainedPushObjectBytes(repoPath, push.objectFiles)) : undefined;
  if (retained !== undefined && history.rows.length > 1)
    throw new Error("Invalid push history reservation");
  if (
    retained !== undefined &&
    history.rows[0] &&
    BigInt(history.rows[0].amount) !==
      BigInt(push!.objectFiles.reduce((sum, file) => sum + file.bytes, 0))
  )
    throw new Error("Invalid push history inventory");
  const retainedIds = new Set(history.rows.map((row) => row.id));
  // Acquire the disk-volume locks before logical history locks. Both quota
  // transitions and the intent abort belong to the caller's one transaction.
  await releaseQuota(
    { transactionQuery: query },
    ids.filter((id) => !retainedIds.has(id) || retained === 0n),
  );
  if (retained === 0n) return;
  await commitQuota({ transactionQuery: query }, [...retainedIds]);
  if (retained !== undefined) {
    for (const row of history.rows) {
      const discarded = BigInt(row.amount) - retained;
      if (discarded > 0n)
        await releaseCommittedCharge(
          { transactionQuery: query },
          {
            dimension: "KB_HISTORY_BYTES",
            subjectId: row.subjectId,
            amount: discarded,
            opId: `${row.id}:discarded-quarantine`,
          },
        );
    }
  }
}

/** Abort PREPARED intents on tombstone, retaining charges for objects kept on disk. */
export async function abortPreparedIntentsForKb(
  query: LockQuery,
  kbId: string,
  reason: string,
): Promise<void> {
  const rows = await query<AbortedPushAuditRow & { preparedDelta: unknown }>(
    `UPDATE "operation_intent"
         SET phase = 'ABORTED'::"OperationIntentPhase",
             "abortReason" = $2,
             "resultStatus" = 'ABORTED',
             "finishedAt" = now(),
             "updatedAt" = now()
       WHERE "kbId" = $1 AND phase = 'PREPARED'::"OperationIntentPhase"
       RETURNING "preparedDelta", "opId", operation, "actorKey", "actorUserIdSnapshot"`,
    [kbId, reason],
  );
  for (const row of rows.rows) {
    await settleAbortedIntentQuota(query, row.preparedDelta);
    await auditAbortedPush(query, row);
  }
}

type PendingIntent = {
  opId: string;
  kbId: string | null;
  phase: string;
  refName: string | null;
  oldRef: string | null;
  newRef: string | null;
  operation: string;
  preparedDelta: unknown;
};

async function listPendingIntents(query: LockQuery, kbId: string): Promise<PendingIntent[]> {
  const rows = await query<PendingIntent>(
    `SELECT "opId", "kbId", phase::text AS phase, "refName", "oldRef", "newRef", operation, "preparedDelta"
         FROM "operation_intent"
         WHERE "kbId" = $1 AND phase IN ('PREPARED'::"OperationIntentPhase", 'COMMITTING'::"OperationIntentPhase")
         ORDER BY "createdAt" ASC`,
    [kbId],
  );
  return rows.rows;
}

async function verifyIndexedHead(
  query: LockQuery,
  reposDir: string,
  kbId: string,
  readOptions?: GitReadOptions,
): Promise<boolean> {
  const actual = readOptions
    ? await readRefShaAsync(kbBareRepoPath(reposDir, kbId), "refs/heads/main", readOptions)
    : readHeadSha(kbBareRepoPath(reposDir, kbId));
  const rows = await query<{ headSha: string | null; state: string }>(
    `SELECT "headSha", state::text AS state FROM "knowledge_base" WHERE id = $1`,
    [kbId],
  );
  const row = rows.rows[0];
  // Only settled, published KBs are verified here: CREATING is owned by the
  // create recovery, and TOMBSTONED KBs owe no canonical ref.
  if (!row || (row.state !== "ACTIVE" && row.state !== "REPAIR_REQUIRED")) return false;
  if (actual === row.headSha) return false;
  // After pending-intent reconciliation there is no in-flight explanation
  // left: a deleted/unreadable canonical ref on a KB with a persisted head,
  // a ref with no indexed head, or a third SHA all mean the Git authority and
  // the index disagree and the KB stays unavailable until repaired.
  if (actual === null && row.headSha === null) return false;
  await query(
    `UPDATE "knowledge_base"
        SET state = 'REPAIR_REQUIRED'::"KnowledgeBaseState", "updatedAt" = now()
      WHERE id = $1 AND state <> 'TOMBSTONED'::"KnowledgeBaseState"`,
    [kbId],
  );
  return true;
}

/** Caller holds the volume fence and per-KB operation/advisory locks, with prior children drained. */
export async function reconcileKbIntents(
  query: LockQuery,
  reposDir: string,
  kbId: string,
  readOptions?: GitReadOptions,
): Promise<"ok" | "repair_required"> {
  const repoPath = kbBareRepoPath(reposDir, kbId);
  const intents = await listPendingIntents(query, kbId);
  const locks = {
    reposDir,
    kbId,
    refNames: intents.flatMap((intent) => (intent.refName ? [intent.refName] : [])),
  };
  if (readOptions) await removeAbandonedPublicationLocksAsync(locks, readOptions);
  else removeAbandonedPublicationLocks(locks);
  let repair = false;
  for (const intent of intents) {
    const publicationOps = new Set([
      JOURNAL_TEST_PUBLISH_OPERATION,
      KB_CREATE_OPERATION,
      "CHANGES_APPLY",
      "DOCUMENT_CREATE",
      "DOCUMENT_UPDATE",
      "DOCUMENT_DELETE",
      "ASSET_PUT",
      "ASSET_IMPORT",
      "PR_MERGE",
      "GIT_PUSH",
    ]);
    if (!publicationOps.has(intent.operation)) {
      continue;
    }
    if (intent.operation === "GIT_PUSH") {
      try {
        parseGitPushDelta(intent.preparedDelta);
      } catch {
        // Malformed journals are repair evidence, never permission to settle quota.
        repair = true;
        await abortIntent(query, intent.opId, "invalid push delta");
        continue;
      }
    }
    if (!intent.oldRef || !intent.newRef || intent.newRef === intent.oldRef) {
      await abortIntent(query, intent.opId, "incomplete publication intent");
      await settleAbortedIntentQuota(query, intent.preparedDelta, repoPath);
      continue;
    }
    const refName = intent.refName ?? "refs/heads/main";
    const zeroRef = "0".repeat(40);
    const rawActual = readOptions
      ? await readRefShaAsync(repoPath, refName, readOptions)
      : refName === "refs/heads/main"
        ? readHeadSha(repoPath)
        : readRefSha(repoPath, refName);
    const actual = rawActual ?? (refName === "refs/heads/main" ? null : zeroRef);
    if (actual === intent.newRef && intent.phase === "COMMITTING") {
      let exists: boolean;
      if (readOptions) {
        try {
          await runGitAsync(repoPath, ["cat-file", "-e", `${intent.newRef}^{commit}`], readOptions);
          exists = true;
        } catch {
          assertGitReadActive(readOptions);
          exists = false;
        }
      } else exists = objectExists({ reposDir, kbId }, intent.newRef);
      if (exists) {
        if (readOptions) await fsyncPublishedRefAsync({ reposDir, kbId }, refName, readOptions);
        else fsyncPublishedRef({ reposDir, kbId }, refName);
        await finalizeIntent(query, intent.opId);
      } else {
        repair = true;
        await abortIntent(query, intent.opId, "new ref points at unreachable objects");
      }
      continue;
    }
    if (actual === intent.oldRef) {
      // Direct publishers retain loose objects; pushes may instead discard
      // their quarantine or migrate only part of it. Charge the retained files.
      await abortIntent(query, intent.opId, "unpublished intent");
      await settleAbortedIntentQuota(query, intent.preparedDelta, repoPath);
      continue;
    }
    if (actual === intent.newRef && intent.phase === "PREPARED") {
      await abortIntent(query, intent.opId, "unpublished intent");
      continue;
    }
    repair = true;
    await abortIntent(query, intent.opId, "ref diverged from journal");
  }
  if (await verifyIndexedHead(query, reposDir, kbId, readOptions)) {
    repair = true;
  }
  if (repair) {
    await query(
      `UPDATE "knowledge_base"
          SET state = 'REPAIR_REQUIRED'::"KnowledgeBaseState", "updatedAt" = now()
        WHERE id = $1 AND state <> 'TOMBSTONED'::"KnowledgeBaseState"`,
      [kbId],
    );
    return "repair_required";
  }
  return "ok";
}

export async function reauthorizeReplay(
  store: LiveAuthorityStore,
  principal: Principal,
  kbId: string,
  operation: KbOperation,
  query?: LockQuery,
  verifier?: CredentialVerifier,
): Promise<void> {
  try {
    await authorize({ store, principal, kbId, operation, query, verifier });
  } catch (error) {
    if (
      error instanceof KbAdmissionError &&
      (error.code === "NOT_FOUND" || error.code === "FORBIDDEN")
    ) {
      throw new OperationIntentError("UNAUTHORIZED", "actor cannot replay receipt");
    }
    throw error;
  }
}

/** A changes-family receipt replays for an actor who can still write or at least propose. */
export async function reauthorizeChangesReplay(
  store: LiveAuthorityStore,
  principal: Principal,
  kbId: string,
  query?: LockQuery,
  verifier?: CredentialVerifier,
): Promise<void> {
  try {
    await authorize({ store, principal, kbId, operation: "write", query, verifier });
  } catch (error) {
    if (error instanceof KbAdmissionError && error.code === "NOT_FOUND")
      throw new OperationIntentError("UNAUTHORIZED", "actor cannot replay receipt");
    if (!(error instanceof KbAdmissionError) || error.code !== "FORBIDDEN") throw error;
    await reauthorizeReplay(store, principal, kbId, "propose", query, verifier);
  }
}

export async function replayFinalizedIntent(
  store: LiveAuthorityStore,
  principal: Principal,
  intent: IntentRow,
  query?: LockQuery,
  verifier?: CredentialVerifier,
): Promise<Record<string, unknown>> {
  if (intent.phase !== "FINALIZED" || !intent.responseBody) {
    throw new OperationIntentError("INVALID_STATE", "intent is not finalized");
  }
  if (intent.kbId) {
    const changesOp =
      intent.operation === "CHANGES_APPLY" ||
      intent.operation.startsWith("DOCUMENT_") ||
      intent.operation.startsWith("ASSET_");
    if (changesOp) {
      await reauthorizeChangesReplay(store, principal, intent.kbId, query, verifier);
    } else {
      await reauthorizeReplay(store, principal, intent.kbId, "write", query, verifier);
    }
  }
  return intent.responseBody as Record<string, unknown>;
}

function preparedDeltaFor(opId: string, marker: string, headSha: string): JournalPreparedDelta {
  return {
    kind: "journal_test_publish",
    headSha,
    marker,
    // Scoped to the unique intent: two actors may share an idempotency key,
    // and each logical publication must keep its own durable job.
    jobDedupKey: `journal:${opId}`,
  };
}

export type JournalTestPublicationInput = {
  store: LiveAuthorityStore;
  principal: BrowserPrincipal;
  reposDir: string;
  kbId: string;
  idempotencyKey: string;
  request: JournalTestPublishRequest;
  barrier?: PublicationBarrier;
};

/**
 * Pass barrier to the coordinator, then call publish in its run callback.
 * Preparation and COMMITTING share its authority-before-KB lock stack; the
 * authority lock is released only after the reservation commits, before CAS.
 */
export function createJournalTestPublication(input: JournalTestPublicationInput): {
  barrier: AuthorityBarrier;
  publish(lease: HeldLockLease, gitExecutor: GitMutatingExecutor): Promise<Record<string, unknown>>;
} {
  let prepared: { intent: IntentRow; fresh: boolean; lease: HeldLockLease } | undefined;
  let reservationMade = false;
  return {
    barrier: {
      async prepare(lease) {
        lease.assertHeldKb(input.kbId);
        const result = await prepareJournalTestPublish(input, lease);
        prepared = { ...result, lease };
      },
      async reauthorize() {
        // markIntentCommitting performs the live recheck in the same
        // authority-locked transaction as the durable phase transition.
      },
      async reservePublication(context) {
        if (!prepared) throw new OperationIntentError("INVALID_STATE", "publication not prepared");
        if (prepared.fresh) {
          await markIntentCommitting(
            context,
            input.store,
            input.principal,
            input.kbId,
            prepared.intent.opId,
          );
          reservationMade = true;
        }
      },
    },
    async publish(lease, gitExecutor) {
      if (!prepared || prepared.lease !== lease) {
        throw new OperationIntentError(
          "INVALID_STATE",
          "publication requires its reservation lease",
        );
      }
      lease.assertHeldKb(input.kbId);
      lease.assertCanReceiveNetworkBody("publish a Git ref");
      const { intent, fresh } = prepared;
      if (!fresh) return replayFinalizedIntent(input.store, input.principal, intent, lease.query);
      if (!reservationMade) {
        throw new OperationIntentError("INVALID_STATE", "publication was not reserved");
      }
      await input.barrier?.afterCommitting?.();
      const repoPath = kbBareRepoPath(input.reposDir, input.kbId);
      const treeOptions = {
        baseBlobs: intent.oldRef ? readCommitBlobs(repoPath, intent.oldRef) : undefined,
      };
      const validation = validateProposedCommitTree(repoPath, intent.newRef!, treeOptions);
      const binding = bindValidatedTreeForPublication(validation, intent.newRef!);
      await fsyncRefUpdate(
        { reposDir: input.reposDir, kbId: input.kbId, executor: gitExecutor },
        {
          refName: intent.refName!,
          newSha: intent.newRef!,
          oldSha: intent.oldRef,
          binding,
          validation: treeOptions,
        },
      );
      await input.barrier?.afterRefUpdate?.();
      const finalized = await lease.transaction((query) => finalizeIntent(query, intent.opId));
      await input.barrier?.afterDbFinalize?.();
      return replayFinalizedIntent(input.store, input.principal, finalized, lease.query);
    },
  };
}

async function prepareJournalTestPublish(
  input: JournalTestPublicationInput,
  lease: HeldLockLease,
): Promise<{ intent: IntentRow; fresh: boolean }> {
  const requestHash = canonicalRequestHash(input.request);
  const actorKey = actorKeyForUser(input.principal.userId);
  const lookup = {
    actorKey,
    kbId: input.kbId,
    operation: JOURNAL_TEST_PUBLISH_OPERATION,
    idempotencyKey: input.idempotencyKey,
  };
  const intent = await loadIntent(lease.query, lookup);
  if (intent && intent.requestHash !== requestHash) {
    throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "request body mismatch");
  }
  if (intent?.phase === "FINALIZED" && intent.responseBody) return { intent, fresh: false };
  if (intent?.phase === "ABORTED") {
    throw new OperationIntentError("INTENT_CONFLICT", intent.abortReason ?? "aborted");
  }
  if (intent) {
    // Retrying never resumes a pending publication. Use the sweep's exact
    // reconciliation, including durable ref resync and immediate quarantine.
    await lease.transaction((query) => reconcileKbIntents(query, input.reposDir, input.kbId));
    const settled = await loadIntent(lease.query, lookup);
    if (settled?.phase === "FINALIZED") {
      await input.barrier?.afterDbFinalize?.();
      return { intent: settled, fresh: false };
    }
    throw new OperationIntentError("INTENT_CONFLICT", settled?.abortReason ?? "aborted");
  }

  await authorizeWrite(input.store, input.principal, input.kbId, lease.query);
  // Settle earlier publications before selecting the next base; a fresh key
  // must not overtake an already-published but unfinalized receipt.
  const reconciliation = await lease.transaction((query) =>
    reconcileKbIntents(query, input.reposDir, input.kbId),
  );
  if (reconciliation === "repair_required") {
    throw new OperationIntentError(
      "REPAIR_REQUIRED",
      "knowledge base requires repair before publication",
    );
  }
  const head = readHeadSha(kbBareRepoPath(input.reposDir, input.kbId));
  if (!head) throw new OperationIntentError("NOT_FOUND", "missing git head");
  const indexedHead = await lease.query<{ headSha: string | null }>(
    `SELECT "headSha" FROM "knowledge_base" WHERE id = $1`,
    [input.kbId],
  );
  if (indexedHead.rows[0]?.headSha !== head) {
    throw new OperationIntentError(
      "REPAIR_REQUIRED",
      "canonical head does not match the reconciled index",
    );
  }
  const opId = randomUUID();
  const newSha = await createTreeReuseCommit(input, {
    parentSha: head,
    message: input.request.marker,
  });
  const reserved = await lease.transaction((query) =>
    reservePublicationIntent(query, {
      opId,
      kbId: input.kbId,
      actorKey,
      actorUserIdSnapshot: input.principal.userId,
      actorUserId: input.principal.userId,
      operation: JOURNAL_TEST_PUBLISH_OPERATION,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      refName: "refs/heads/main",
      oldRef: head,
      newRef: newSha,
      preparedDelta: preparedDeltaFor(opId, input.request.marker, newSha),
    }),
  );
  if (reserved.opId !== opId || reserved.phase !== "PREPARED") {
    throw new OperationIntentError("INTENT_CONFLICT", "publication reservation changed");
  }
  // PREPARED is durable but does not reserve publication or outlive cancellation.
  await input.barrier?.afterPrepared?.();
  return { intent: reserved, fresh: true };
}

export type { DreamMergeGuardResult } from "./dream";
