import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { assertPathInside, stagingRoot } from "@knowledge-base/env/topology";
import { CAS_SNIFF_MIME_TYPES, validateCasMediaBytes } from "../sniff-mime";
import { invalidArgument, markdownIssueReason, reasonedConflict } from "./argument-reasons";
import { prismaAssetQuery } from "./asset-authz";
import { recordAuditEvent } from "./audit";
import { parseCasHash } from "./cas";
import {
  closeStagingDirChain,
  fsyncStagingDirChain,
  openStagedUploadFd,
  openStagingDir,
  type StagingDirChain,
  unlinkStagedUploadFd,
} from "./cas-fd";
import { fromAdmissionError, KbDomainError } from "./errors";
import {
  CAS_BLOB_MAX_BYTES,
  chargeKbMutation,
  chargeKbUpload,
  STAGED_MARKDOWN_UPLOAD_MAX_BYTES,
} from "./limits";
import { checkoutPinnedSession, type LockQuery } from "./lock";
import {
  canonicalRequestHash,
  findFinalizedReceiptForUpdate,
  recordFinalizedReceipt,
} from "./operation-intent";
import { validateMarkdownBytes } from "./parse-markdown";
import { authorize, sqlAuthorityStore } from "./permissions";
import {
  actorKeyFor,
  type CredentialVerifier,
  demandToolGroups,
  KbAdmissionError,
  type Principal,
} from "./principal";
import { releaseQuota, reserveQuota, statfsDiskMeter } from "./quota";
import type { KbRuntimeConfig } from "./runtime";

export const UPLOAD_BEGIN_OPERATION = "UPLOAD_BEGIN";
export const UPLOAD_MAX_CHUNK_BYTES = 196_608;
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
const EMPTY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type UploadKind = "markdown" | "asset";

export type UploadBeginInput = {
  kbId: string;
  idempotencyKey: string;
  kind: UploadKind;
  size: number;
  contentHash: string;
  mime: string;
};

export type UploadBeginResult = {
  operationId: string;
  uploadId: string;
  offset: 0;
  expiresAt: string;
  maxChunkBytes: 196608;
};

export type UploadWriteInput = {
  kbId: string;
  uploadId: string;
  offset: number;
  bytesBase64: string;
};

export type UploadWriteResult = {
  uploadId: string;
  offset: number;
};

export type UploadFinishInput = {
  kbId: string;
  uploadId: string;
};

export type UploadFinishResult = {
  uploadId: string;
  contentHash: string;
  size: number;
  mime: string;
  state: "READY";
  expiresAt: string;
};

type StagedRow = {
  id: string;
  kbId: string;
  actorKey: string;
  kind: string;
  declaredSize: number;
  declaredHash: string;
  declaredMime: string;
  offset: number;
  rollingHashHex: string;
  reservationIds: string[];
  expiresAt: Date;
  readyExpiresAt: Date | null;
  state: string;
  finishResponse: unknown;
  stagingReclaimedAt: Date | null;
  reservedByOpId: string | null;
  consumedByOpId: string | null;
};

type UploadActor = { principal: Principal; verifier?: CredentialVerifier; signal?: AbortSignal };
function uploadActor(actor: string | UploadActor): UploadActor {
  return typeof actor === "string" ? { principal: { kind: "browser", userId: actor } } : actor;
}

/** Markdown uploads belong to the `edit` tool group, asset uploads to `assets`. */
function uploadKindGroup(kind: string): "edit" | "assets" {
  return kind.toLowerCase() === "markdown" ? "edit" : "assets";
}

function withKindDemand(actor: UploadActor, kind: string): UploadActor {
  return { ...actor, principal: demandToolGroups(actor.principal, [uploadKindGroup(kind)]) };
}

/**
 * A token actor demands the group of the staged upload's kind for the whole
 * write/finish call, lock-held reauthorization included. The kind of an
 * existing row never changes, so an unlocked lookup is exact; an unknown row
 * fails later as NOT_FOUND under the lock.
 */
async function withStagedKindDemand(
  runtime: KbRuntimeConfig,
  actor: UploadActor,
  input: { kbId: string; uploadId: string },
): Promise<UploadActor> {
  if (actor.principal.kind !== "token") return actor;
  const rows = await prismaAssetQuery(runtime.prisma)<{ kind: string }>(
    `SELECT kind::text AS kind FROM "staged_upload" WHERE id = $1 AND "kbId" = $2 AND "actorKey" = $3`,
    [input.uploadId, input.kbId, actorKeyFor(actor.principal)],
  );
  const kind = rows.rows[0]?.kind;
  return kind ? withKindDemand(actor, kind) : actor;
}

function iso(date: Date): string {
  return date.toISOString();
}

function hashPrefix(hex: string): string {
  return `sha256:${hex}`;
}

function decodeUploadChunk(bytesBase64: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(bytesBase64, "base64");
  } catch {
    throw invalidArgument("Invalid base64 chunk", "SCHEMA", "/bytesBase64");
  }
  if (decoded.length < 1 || decoded.length > UPLOAD_MAX_CHUNK_BYTES) {
    throw invalidArgument(
      "Upload chunk size out of bounds",
      decoded.length < 1 ? "SCHEMA" : "TOO_LARGE",
      "/bytesBase64",
    );
  }
  if (decoded.toString("base64") !== bytesBase64) {
    throw invalidArgument("Upload chunk must use canonical base64", "SCHEMA", "/bytesBase64");
  }
  return decoded;
}

function assertDeclaredHash(contentHash: string): void {
  try {
    parseCasHash(contentHash);
  } catch {
    throw invalidArgument("Invalid content hash", "SCHEMA", "/contentHash");
  }
}

export function assertBeginLimits(input: UploadBeginInput): void {
  assertDeclaredHash(input.contentHash);
  if (!Number.isInteger(input.size) || input.size < 1) {
    throw invalidArgument("Invalid upload size", "SCHEMA", "/size");
  }
  if (input.kind === "markdown") {
    if (input.mime !== "text/markdown") {
      throw invalidArgument("Markdown uploads require text/markdown", "SCHEMA", "/mime");
    }
    if (input.size > STAGED_MARKDOWN_UPLOAD_MAX_BYTES) {
      throw invalidArgument("Markdown upload exceeds size limit", "TOO_LARGE", "/size");
    }
  } else {
    if (input.mime === "text/markdown") {
      throw invalidArgument("Asset uploads cannot use text/markdown", "SCHEMA", "/mime");
    }
    if (!(CAS_SNIFF_MIME_TYPES as readonly string[]).includes(input.mime)) {
      throw invalidArgument("Unsupported asset MIME type", "SCHEMA", "/mime");
    }
    if (input.size > CAS_BLOB_MAX_BYTES) {
      throw invalidArgument("Asset upload exceeds size limit", "TOO_LARGE", "/size");
    }
  }
}

export function stagedUploadPath(assetsDir: string, uploadId: string): string {
  const root = stagingRoot(assetsDir);
  const path = join(root, uploadId);
  return assertPathInside(root, path);
}

function withStagingFd<T>(assetsDir: string, fn: (stagingFd: number) => T): T {
  const chain = openStagingDir(assetsDir);
  try {
    return fn(chain.stagingFd);
  } finally {
    closeStagingDirChain(chain);
  }
}

/** Caller owns the live row lock; only an unacknowledged WRITING upload can create. */
function ensureStagedUploadFile(assetsDir: string, row: StagedRow): void {
  const chain = openStagingDir(assetsDir);
  try {
    let fd: number;
    if (row.state === "WRITING" && row.offset === 0 && row.stagingReclaimedAt === null) {
      try {
        fd = openStagedUploadFd(
          chain.stagingFd,
          row.id,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        fd = openStagedUploadFd(chain.stagingFd, row.id, constants.O_RDWR | constants.O_NOFOLLOW);
      }
    } else {
      fd = openStagedUploadFd(chain.stagingFd, row.id, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    try {
      if (fstatSync(fd).size < row.offset) {
        throw new KbDomainError("STORAGE_UNAVAILABLE", "Acknowledged upload bytes are missing");
      }
      // An earlier create may have crashed before either durability barrier.
      // EEXIST is not proof of durability: sync existing leaves too.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // fsync(2): a file's own fsync never persists its containing directory
    // entry — a crash right after create can lose the name while keeping the
    // (already-committed) DB row, stranding a resumed write with ENOENT.
    fsyncStagingDirChain(chain);
  } finally {
    closeStagingDirChain(chain);
  }
}

function unlinkStagedUploadFile(assetsDir: string, uploadId: string): void {
  try {
    withStagingFd(assetsDir, (stagingFd) => {
      unlinkStagedUploadFd(stagingFd, uploadId);
    });
  } catch {
    /* best-effort */
  }
}

function readFileRangeFd(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const read = readSync(fd, buf, 0, length, offset);
  if (read !== length) {
    throw new KbDomainError("UPLOAD_INCOMPLETE", "Upload staging file is incomplete");
  }
  return buf;
}

function readFileRange(
  assetsDir: string,
  uploadId: string,
  offset: number,
  length: number,
): Buffer {
  return withStagingFd(assetsDir, (stagingFd) => {
    const fd = openStagedUploadFd(stagingFd, uploadId, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return readFileRangeFd(fd, offset, length);
    } finally {
      closeSync(fd);
    }
  });
}

function writeChunkAt(assetsDir: string, uploadId: string, offset: number, chunk: Buffer): void {
  withStagingFd(assetsDir, (stagingFd) => {
    const fd = openStagedUploadFd(stagingFd, uploadId, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      let written = 0;
      while (written < chunk.length) {
        const n = writeSync(fd, chunk, written, chunk.length - written, offset + written);
        if (n <= 0) throw new KbDomainError("STORAGE_UNAVAILABLE", "Upload write failed");
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}

function assertExactStagedFileSize(
  assetsDir: string,
  uploadId: string,
  declaredSize: number,
): void {
  withStagingFd(assetsDir, (stagingFd) => {
    const fd = openStagedUploadFd(stagingFd, uploadId, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size;
      if (size !== declaredSize) {
        throw new KbDomainError("CONFLICT", "Upload staging file size mismatch");
      }
    } finally {
      closeSync(fd);
    }
  });
}

function hashFile(assetsDir: string, uploadId: string, size: number): string {
  return withStagingFd(assetsDir, (stagingFd) => {
    const fd = openStagedUploadFd(stagingFd, uploadId, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      let remaining = size;
      let position = 0;
      const buf = Buffer.alloc(Math.min(UPLOAD_MAX_CHUNK_BYTES, size));
      while (remaining > 0) {
        const toRead = Math.min(buf.length, remaining);
        const n = readSync(fd, buf, 0, toRead, position);
        if (n <= 0) {
          throw new KbDomainError("UPLOAD_INCOMPLETE", "Upload staging file is incomplete");
        }
        hash.update(buf.subarray(0, n));
        remaining -= n;
        position += n;
      }
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  });
}

async function authorizePropose(query: LockQuery, actor: UploadActor, kbId: string): Promise<void> {
  actor.signal?.throwIfAborted();
  try {
    await authorize({
      store: sqlAuthorityStore(query),
      principal: actor.principal,
      verifier: actor.verifier?.forQuery?.(query) ?? actor.verifier,
      kbId,
      operation: "propose",
      query,
    });
  } catch (error) {
    const mapped = fromAdmissionError(error);
    if (mapped) throw mapped;
    if (error instanceof KbAdmissionError) throw error;
    throw error;
  }
}

async function loadUploadForUpdate(query: LockQuery, uploadId: string): Promise<StagedRow | null> {
  const rows = await query<StagedRow>(
    `SELECT id, "kbId", "actorKey", kind::text AS kind, "declaredSize", "declaredHash",
            "declaredMime", "offset", "rollingHashHex", "reservationIds", "expiresAt",
            "readyExpiresAt", state::text AS state, "finishResponse", "stagingReclaimedAt", "reservedByOpId", "consumedByOpId"
       FROM "staged_upload"
      WHERE id = $1
      FOR UPDATE`,
    [uploadId],
  );
  return rows.rows[0]
    ? {
        ...rows.rows[0],
        declaredSize: Number(rows.rows[0].declaredSize),
        offset: Number(rows.rows[0].offset),
      }
    : null;
}

function assertUploadActor(row: StagedRow, kbId: string, actorKey: string): void {
  if (row.kbId !== kbId || row.actorKey !== actorKey) {
    throw new KbDomainError("NOT_FOUND", "Upload not found");
  }
}

function uploadClockExpired(row: StagedRow, now = Date.now()): boolean {
  if (row.reservedByOpId) return false;
  const writingExpired = row.state === "WRITING" && now >= row.expiresAt.getTime();
  const readyExpired =
    row.state === "READY" && row.readyExpiresAt !== null && now >= row.readyExpiresAt.getTime();
  return writingExpired || readyExpired;
}

async function expireUploadRow(query: LockQuery, row: StagedRow): Promise<void> {
  if (row.state === "EXPIRED" || row.state === "ABORTED") return;
  await query(
    `UPDATE "staged_upload"
        SET state = 'EXPIRED'::"StagedUploadState", "updatedAt" = now()
      WHERE id = $1 AND "reservedByOpId" IS NULL AND state IN ('WRITING'::"StagedUploadState", 'READY'::"StagedUploadState")`,
    [row.id],
  );
  if (row.reservationIds.length > 0) {
    await releaseQuota({ transactionQuery: query }, row.reservationIds);
  }
}

/**
 * DB-only expiry for the worker retention pass: locks the
 * row, and only a still-due, unreserved WRITING/READY row becomes EXPIRED with its quota
 * released in this same transaction. A row another sweeper already expired is a no-op, so
 * the quota is released exactly once. File reclaim stays with the server's fenced sweep.
 */
export async function expireStagedUploadIfDue(
  query: LockQuery,
  uploadId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await loadUploadForUpdate(query, uploadId);
  if (!row || (row.state !== "WRITING" && row.state !== "READY")) return false;
  if (!uploadClockExpired(row, now)) return false;
  await expireUploadRow(query, row);
  return true;
}

async function markStagingReclaimed(query: LockQuery, uploadId: string): Promise<void> {
  await query(
    `UPDATE "staged_upload" SET "stagingReclaimedAt" = now() WHERE id = $1 AND "stagingReclaimedAt" IS NULL`,
    [uploadId],
  );
}

/**
 * Unlike the request-path's fire-and-forget unlink, this reports success so the
 * caller can durably record reclaim — a failure (not ENOENT) must stay retryable.
 *
 * fsync(2): removing a directory entry is only durable once its directory is
 * fsynced (mirrors ensureStagedUploadFile's own leaf+directory discipline).
 * That fsync is retried on every call, including when unlink itself reports
 * ENOENT: a prior unlink may have removed the entry without ever durably
 * persisting that removal, and a live-process ENOENT proves nothing about
 * post-crash durability. Only a call whose unlink (or ENOENT) *and* whose
 * follow-up directory fsync both succeed returns true; any other failure
 * — unlink for a real reason, or the fsync itself — stays retryable.
 */
function tryUnlinkStagedUploadFile(assetsDir: string, uploadId: string): boolean {
  let chain: StagingDirChain;
  try {
    chain = openStagingDir(assetsDir);
  } catch {
    return false;
  }
  try {
    try {
      unlinkStagedUploadFd(chain.stagingFd, uploadId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
    }
    fsyncStagingDirChain(chain);
    return true;
  } catch {
    return false;
  } finally {
    closeStagingDirChain(chain);
  }
}

/**
 * Idempotent expire-and-reclaim for one row: expires a clock-elapsed WRITING/READY
 * row, then (for any row already terminal) retries the staging-file unlink and
 * durably marks it reclaimed only once the unlink actually succeeds or the file is
 * already gone. A prior EIO/crash between the EXPIRED commit and the unlink leaves
 * `stagingReclaimedAt` null, so the next sweep pass — which selects on exactly that
 * column, not just the expiry clock — retries the file removal instead of leaking it.
 *
 * Returns whether this call made durable progress (expired the row, and/or durably
 * reclaimed its staging file) — never merely "a row was selected". A row that was
 * already terminal, whose unlink keeps failing for a persistent reason (EIO,
 * EACCES, a directory in the file's place), returns false: the caller must not
 * treat that as work still remaining in *this* pass, only as a candidate for the
 * next one.
 */
export async function commitStagedUploadExpiry(
  connectionString: string,
  assetsDir: string,
  uploadId: string,
): Promise<boolean> {
  const lease = await checkoutPinnedSession({
    connectionString,
    opId: randomUUID(),
  });
  try {
    let needsReclaim = false;
    let expiredNow = false;
    await lease.transaction(async (query) => {
      const row = await loadUploadForUpdate(query, uploadId);
      if (!row) return;
      if (row.stagingReclaimedAt !== null || row.reservedByOpId) return;
      if (row.state === "WRITING" || row.state === "READY") {
        if (!uploadClockExpired(row)) return;
        await expireUploadRow(query, row);
        needsReclaim = true;
        expiredNow = true;
        return;
      }
      needsReclaim = true;
    });
    if (!needsReclaim) return false;
    if (tryUnlinkStagedUploadFile(assetsDir, uploadId)) {
      await lease.transaction((query) => markStagingReclaimed(query, uploadId));
      return true;
    }
    return expiredNow;
  } finally {
    await lease.close();
  }
}

type LiveUploadLookup =
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "live"; row: StagedRow };

/**
 * Loads the row FOR UPDATE inside the caller's own transaction/lock and, if the
 * TTL clock has elapsed, expires it and releases quota in that SAME transaction
 * — never by checking out a second pinned session. `checkoutPinnedSession`
 * refuses to nest inside an operation already holding one (see lock.ts's
 * AsyncLocalStorage guard), and even without that guard a second session's
 * `SELECT ... FOR UPDATE` on the row the caller is already holding would
 * deadlock. The caller commits this transaction normally on the "expired"
 * branch and throws UPLOAD_EXPIRED only after it lands durably.
 */
async function loadLiveUploadOrExpired(
  query: LockQuery,
  input: { kbId: string; uploadId: string; actorKey: string },
): Promise<LiveUploadLookup> {
  const row = await loadUploadForUpdate(query, input.uploadId);
  if (!row) return { status: "not_found" };
  assertUploadActor(row, input.kbId, input.actorKey);
  if (row.state === "EXPIRED" || row.state === "ABORTED") {
    return { status: "expired" };
  }
  if (row.reservedByOpId || row.state === "CONSUMED")
    throw reasonedConflict("Upload is claimed or consumed", "UPLOAD_NOT_WRITABLE");
  if (uploadClockExpired(row)) {
    await expireUploadRow(query, row);
    return { status: "expired" };
  }
  return { status: "live", row };
}

function parseFinishResponse(body: unknown): UploadFinishResult {
  if (!body || typeof body !== "object") {
    throw new KbDomainError("INTERNAL", "Upload finish receipt is unreadable");
  }
  return body as UploadFinishResult;
}

function parseBeginResponse(body: unknown): UploadBeginResult {
  if (!body || typeof body !== "object") {
    throw new KbDomainError("INTERNAL", "Upload begin receipt is unreadable");
  }
  return body as UploadBeginResult;
}

export async function uploadBegin(
  runtime: KbRuntimeConfig,
  actorInput: string | UploadActor,
  assetsDir: string,
  input: UploadBeginInput,
): Promise<UploadBeginResult> {
  assertBeginLimits(input);
  const actor = withKindDemand(uploadActor(actorInput), input.kind);
  actor.signal?.throwIfAborted();
  const userId = actor.principal.userId;
  const actorKey = actorKeyFor(actor.principal);
  const requestHash = canonicalRequestHash({
    kbId: input.kbId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    size: input.size,
    contentHash: input.contentHash,
    mime: input.mime,
  });

  const opId = randomUUID();
  const uploadId = randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
  const assetsMeter = statfsDiskMeter(assetsDir);
  let result: UploadBeginResult | undefined;

  const outcome = await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: {
      async reauthorize(ctx) {
        await authorizePropose(ctx.query, actor, input.kbId);
      },
      async reservePublication(ctx) {
        const receipt = await findFinalizedReceiptForUpdate(ctx.query, {
          actorKey,
          kbId: input.kbId,
          operation: UPLOAD_BEGIN_OPERATION,
          idempotencyKey: input.idempotencyKey,
        });
        if (receipt) {
          if (receipt.requestHash !== requestHash) {
            throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
          }
          if (receipt.phase === "FINALIZED" && receipt.responseBody) {
            result = parseBeginResponse(receipt.responseBody);
            return;
          }
          throw new KbDomainError("CONFLICT", "Upload begin already in progress");
        }
        await chargeKbMutation(runtime.ratePort, actorKey, input.kbId);
        const quota = await reserveQuota(
          { transactionQuery: ctx.query },
          {
            opId,
            charges: [],
            expiresAt,
            disks: [{ path: assetsDir, bytes: BigInt(input.size), meter: assetsMeter }],
          },
        );
        await ctx.query(
          `INSERT INTO "staged_upload" (
             id, "kbId", "actorKey", "actorUserIdSnapshot", "actorUserId", kind,
             "declaredSize", "declaredHash", "declaredMime", "offset", "rollingHashHex",
             "reservationIds", "expiresAt", state, "createdAt", "updatedAt"
           ) VALUES (
             $1, $2, $3, $4, $5, $6::"StagedUploadKind", $7, $8, $9, 0, $10, $11, $12,
             'WRITING'::"StagedUploadState", now(), now()
           )`,
          [
            uploadId,
            input.kbId,
            actorKey,
            userId,
            userId,
            input.kind.toUpperCase(),
            input.size,
            input.contentHash,
            input.mime,
            EMPTY_SHA256_HEX,
            quota.reservationIds,
            expiresAt.toISOString(),
          ],
        );
        const body: UploadBeginResult = {
          operationId: opId,
          uploadId,
          offset: 0,
          expiresAt: iso(expiresAt),
          maxChunkBytes: UPLOAD_MAX_CHUNK_BYTES,
        };
        const finalized = await recordFinalizedReceipt(ctx.query, {
          kbId: input.kbId,
          actorUserId: userId,
          actorKey,
          operation: UPLOAD_BEGIN_OPERATION,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          opId,
          responseBody: body,
        });
        // Staging audit: one logical event per receipt, never per retry.
        await recordAuditEvent(ctx.query, {
          opId: finalized.opId,
          action: "upload_begin",
          outcome: "SUCCESS",
          actorKey,
          actorUserIdSnapshot: userId,
          actorUserId: userId,
          kbId: input.kbId,
        });
        result = parseBeginResponse(finalized.responseBody);
      },
    },
    run: async (ctx) => {
      if (!result) throw new KbDomainError("INTERNAL", "Upload begin did not produce a result");
      const committedUploadId = result.uploadId;
      // The barrier committed the reservation before any filesystem effect.
      // Keep the row locked from lifecycle lookup through materialization so a
      // sweep cannot expire/reclaim it between those steps. Terminal rows never
      // create files, including a replay after a failed initial creation.
      const outcome = await ctx.lease.transaction(async (query) => {
        const loaded = await loadLiveUploadOrExpired(query, {
          kbId: input.kbId,
          uploadId: committedUploadId,
          actorKey,
        });
        if (loaded.status === "not_found") {
          throw new KbDomainError("NOT_FOUND", "Upload not found");
        }
        if (loaded.status === "expired") return { status: "expired" as const };
        try {
          ensureStagedUploadFile(assetsDir, loaded.row);
          return { status: "ok" as const };
        } catch {
          // Commit terminal intent and quota release before cleanup. A failed
          // sync may already have created the leaf; never infer file absence.
          await expireUploadRow(query, loaded.row);
          return { status: "failed" as const };
        }
      });
      if (outcome.status !== "ok") {
        if (tryUnlinkStagedUploadFile(assetsDir, committedUploadId)) {
          await ctx.lease.transaction((query) => markStagingReclaimed(query, committedUploadId));
        }
        throw new KbDomainError(
          outcome.status === "expired" ? "UPLOAD_EXPIRED" : "STORAGE_UNAVAILABLE",
          outcome.status === "expired" ? "Upload expired" : "Upload staging file is unavailable",
        );
      }
      return result;
    },
  });
  if (actor.principal.kind === "token")
    await authorizePropose(prismaAssetQuery(runtime.prisma), actor, input.kbId);
  return outcome;
}

async function persistUploadProgress(
  query: LockQuery,
  uploadId: string,
  nextOffset: number,
): Promise<void> {
  await query(
    `UPDATE "staged_upload"
        SET "offset" = $2, "updatedAt" = now()
      WHERE id = $1`,
    [uploadId, nextOffset],
  );
}

export async function uploadWrite(
  runtime: KbRuntimeConfig,
  actorInput: string | UploadActor,
  assetsDir: string,
  input: UploadWriteInput,
): Promise<UploadWriteResult> {
  const chunk = decodeUploadChunk(input.bytesBase64);
  const actor = await withStagedKindDemand(runtime, uploadActor(actorInput), input);
  actor.signal?.throwIfAborted();
  const actorKey = actorKeyFor(actor.principal);
  const opId = randomUUID();

  let settled: { status: "expired" } | { status: "ok"; value: UploadWriteResult } | undefined;
  const outcome = await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [input.kbId],
    // Authority -> KB -> upload row -> quota (expiry). Holding authority
    // through COMMIT orders bans/revocations against the entire bounded effect,
    // including duplicate responses, SQL awaits and limiter waits.
    barrier: {
      reauthorize: ({ query }) => authorizePropose(query, actor, input.kbId),
      async reservePublication({ query }) {
        actor.signal?.throwIfAborted();
        const loaded = await loadLiveUploadOrExpired(query, {
          kbId: input.kbId,
          uploadId: input.uploadId,
          actorKey,
        });
        if (loaded.status === "not_found") {
          throw new KbDomainError("NOT_FOUND", "Upload not found");
        }
        if (loaded.status === "expired") {
          settled = { status: "expired" };
          return;
        }
        const row = loaded.row;
        if (row.state !== "WRITING") {
          throw reasonedConflict("Upload is not accepting writes", "UPLOAD_NOT_WRITABLE");
        }
        if (input.offset !== row.offset) {
          if (input.offset > row.offset) {
            throw new KbDomainError("UPLOAD_INCOMPLETE", "Upload has a gap");
          }
          if (input.offset + chunk.length > row.offset) {
            throw reasonedConflict("Upload offset mismatch", "UPLOAD_BYTES_MISMATCH", "/offset");
          }
          let existing: Buffer;
          try {
            existing = readFileRange(assetsDir, row.id, input.offset, chunk.length);
          } catch {
            // An acknowledged range must still be readable in full. Storage
            // failure is retriable; it is not evidence that the client changed bytes.
            throw new KbDomainError("STORAGE_UNAVAILABLE", "Acknowledged upload bytes unavailable");
          }
          if (!existing.equals(chunk)) {
            throw reasonedConflict("Upload offset mismatch", "UPLOAD_BYTES_MISMATCH", "/offset");
          }
          settled = { status: "ok", value: { uploadId: row.id, offset: row.offset } };
          return;
        }
        if (row.offset + chunk.length > row.declaredSize) {
          throw invalidArgument("Upload chunk exceeds declared size", "TOO_LARGE", "/bytesBase64");
        }
        let existing: Buffer | undefined;
        try {
          existing = readFileRange(assetsDir, row.id, row.offset, chunk.length);
        } catch (error) {
          // Only an unacknowledged tail can legitimately be incomplete.
          if (!(error instanceof KbDomainError && error.code === "UPLOAD_INCOMPLETE")) {
            throw new KbDomainError("STORAGE_UNAVAILABLE", "Upload staging bytes unavailable");
          }
        }
        if (existing && !existing.equals(chunk)) {
          throw reasonedConflict("Upload offset mismatch", "UPLOAD_BYTES_MISMATCH", "/offset");
        }
        if (!existing) await chargeKbUpload(runtime.ratePort, actor.principal.userId, chunk.length);
        writeChunkAt(assetsDir, row.id, row.offset, chunk);
        const nextOffset = row.offset + chunk.length;
        await persistUploadProgress(query, row.id, nextOffset);
        settled = { status: "ok", value: { uploadId: row.id, offset: nextOffset } };
      },
    },
    run: async () => {
      if (!settled) throw new KbDomainError("INTERNAL", "Upload did not produce a result");
      return settled;
    },
  });

  if (outcome.status === "expired") {
    unlinkStagedUploadFile(assetsDir, input.uploadId);
    throw new KbDomainError("UPLOAD_EXPIRED", "Upload expired");
  }
  if (actor.principal.kind === "token")
    await authorizePropose(prismaAssetQuery(runtime.prisma), actor, input.kbId);
  return outcome.value;
}

export async function uploadFinish(
  runtime: KbRuntimeConfig,
  actorInput: string | UploadActor,
  assetsDir: string,
  input: UploadFinishInput,
): Promise<UploadFinishResult> {
  const actor = await withStagedKindDemand(runtime, uploadActor(actorInput), input);
  actor.signal?.throwIfAborted();
  const actorKey = actorKeyFor(actor.principal);
  const opId = randomUUID();

  let settled: { status: "expired" } | { status: "ok"; value: UploadFinishResult } | undefined;
  const outcome = await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [input.kbId],
    // Authority -> KB -> upload row -> quota (expiry). Holding authority
    // through COMMIT orders bans/revocations against the entire bounded effect,
    // including duplicate responses, SQL awaits and limiter waits.
    barrier: {
      reauthorize: ({ query }) => authorizePropose(query, actor, input.kbId),
      async reservePublication({ query }) {
        await chargeKbMutation(runtime.ratePort, actorKey, input.kbId);
        const loaded = await loadLiveUploadOrExpired(query, {
          kbId: input.kbId,
          uploadId: input.uploadId,
          actorKey,
        });
        if (loaded.status === "not_found") {
          throw new KbDomainError("NOT_FOUND", "Upload not found");
        }
        if (loaded.status === "expired") {
          settled = { status: "expired" };
          return;
        }
        const row = loaded.row;
        if (row.state === "READY" && row.finishResponse) {
          settled = { status: "ok", value: parseFinishResponse(row.finishResponse) };
          return;
        }
        if (row.state !== "WRITING") {
          throw reasonedConflict("Upload cannot be finished", "UPLOAD_NOT_WRITABLE");
        }
        if (row.offset !== row.declaredSize) {
          throw new KbDomainError("UPLOAD_INCOMPLETE", "Upload is incomplete");
        }
        assertExactStagedFileSize(assetsDir, row.id, row.declaredSize);
        const digestHex = hashFile(assetsDir, row.id, row.declaredSize);
        if (hashPrefix(digestHex) !== row.declaredHash) {
          throw reasonedConflict("Upload hash mismatch", "CONTENT_HASH_MISMATCH");
        }
        const bytes = readFileRange(assetsDir, row.id, 0, row.declaredSize);
        if (row.kind === "MARKDOWN") {
          const issue = validateMarkdownBytes(bytes);
          // The typed cause, as a write of the same bytes would report it.
          if (issue) throw invalidArgument(issue.message, markdownIssueReason(issue.code));
        } else {
          const trusted = validateCasMediaBytes(bytes, row.declaredMime);
          if (!trusted.ok) {
            const reason =
              "reason" in trusted && typeof trusted.reason === "string"
                ? trusted.reason
                : "Invalid asset bytes";
            throw new KbDomainError("INVALID_ARGUMENT", reason);
          }
        }
        const readyExpiresAt = row.expiresAt;
        const body: UploadFinishResult = {
          uploadId: row.id,
          contentHash: row.declaredHash,
          size: row.declaredSize,
          mime: row.declaredMime,
          state: "READY",
          expiresAt: iso(readyExpiresAt),
        };
        await query(
          `UPDATE "staged_upload"
              SET state = 'READY'::"StagedUploadState",
                  "readyExpiresAt" = $2,
                  "finishResponse" = $3::jsonb,
                  "updatedAt" = now()
            WHERE id = $1`,
          [row.id, readyExpiresAt.toISOString(), JSON.stringify(body)],
        );
        // The upload id is the logical operation: a replayed finish returns above.
        await recordAuditEvent(query, {
          opId: row.id,
          action: "upload_finish",
          outcome: "SUCCESS",
          actorKey,
          actorUserIdSnapshot: actor.principal.userId,
          actorUserId: actor.principal.userId,
          kbId: input.kbId,
        });
        settled = { status: "ok", value: body };
      },
    },
    run: async () => {
      if (!settled) throw new KbDomainError("INTERNAL", "Upload did not produce a result");
      return settled;
    },
  });

  if (outcome.status === "expired") {
    unlinkStagedUploadFile(assetsDir, input.uploadId);
    throw new KbDomainError("UPLOAD_EXPIRED", "Upload expired");
  }
  if (actor.principal.kind === "token")
    await authorizePropose(prismaAssetQuery(runtime.prisma), actor, input.kbId);
  return outcome.value;
}

/** Caller holds the KB lease and this transaction's upload row lock. */
export async function readPublicationUpload(
  query: LockQuery,
  assetsDir: string,
  input: {
    uploadId: string;
    kbId: string;
    actorKey: string;
    kind: "MARKDOWN" | "ASSET";
    opId: string;
  },
) {
  const row = await loadUploadForUpdate(query, input.uploadId);
  if (
    !row ||
    row.kbId !== input.kbId ||
    row.actorKey !== input.actorKey ||
    row.kind !== input.kind
  ) {
    throw new KbDomainError("NOT_FOUND", "Upload not found");
  }
  if (row.consumedByOpId || (row.reservedByOpId && row.reservedByOpId !== input.opId)) {
    throw new KbDomainError("CONFLICT", "Upload already used");
  }
  if (row.state === "EXPIRED" || row.state === "ABORTED" || uploadClockExpired(row)) {
    throw new KbDomainError("UPLOAD_EXPIRED", "Upload expired");
  }
  if (row.state !== "READY") throw new KbDomainError("UPLOAD_INCOMPLETE", "Upload is not ready");
  try {
    assertExactStagedFileSize(assetsDir, row.id, row.declaredSize);
    const bytes = readFileRange(assetsDir, row.id, 0, row.declaredSize);
    if (hashPrefix(createHash("sha256").update(bytes).digest("hex")) !== row.declaredHash)
      throw new Error("hash");
    if (
      row.kind === "MARKDOWN"
        ? validateMarkdownBytes(bytes)
        : !validateCasMediaBytes(bytes, row.declaredMime).ok
    )
      throw new Error("content");
    return { row, bytes };
  } catch {
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Staged bytes unavailable");
  }
}

/**
 * Visit the eligible inventory once in bounded keyset pages. A failed reclaim
 * stays eligible for the next sweep, but cannot hide later IDs in this one.
 * Fix the cutoff at sweep entry so ongoing admission cannot extend this pass.
 */
export async function sweepExpiredStagedUploads(
  connectionString: string,
  assetsDir: string,
): Promise<number> {
  let cutoff: Date | undefined;
  let afterId: string | null = null;
  let progressed = 0;
  for (;;) {
    const lease = await checkoutPinnedSession({ connectionString, opId: randomUUID() });
    let ids: string[];
    try {
      if (!cutoff) {
        const clock = await lease.query<{ cutoff: Date }>("SELECT clock_timestamp() AS cutoff");
        cutoff = clock.rows[0]!.cutoff;
      }
      const rows = await lease.query<{ id: string }>(
        `SELECT id FROM "staged_upload"
          WHERE ($2::uuid IS NULL OR id > $2::uuid) AND "createdAt" <= $1 AND "reservedByOpId" IS NULL AND (
               (state = 'WRITING'::"StagedUploadState" AND "expiresAt" <= $1)
            OR (state = 'READY'::"StagedUploadState" AND "readyExpiresAt" <= $1)
            OR (state IN ('EXPIRED'::"StagedUploadState", 'ABORTED'::"StagedUploadState", 'CONSUMED'::"StagedUploadState")
                AND "stagingReclaimedAt" IS NULL))
          ORDER BY id ASC LIMIT 100`,
        [cutoff.toISOString(), afterId],
      );
      ids = rows.rows.map((row) => row.id);
    } finally {
      await lease.close();
    }
    if (ids.length === 0) return progressed;
    for (const id of ids) {
      if (await commitStagedUploadExpiry(connectionString, assetsDir, id)) progressed += 1;
    }
    // Advance by selected IDs, regardless of whether their unlink succeeded.
    afterId = ids[ids.length - 1]!;
  }
}
