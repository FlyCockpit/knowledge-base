import { type ChildProcess, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, fsyncSync } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { crc32 } from "node:zlib";
import type { ExportArtifactState, Prisma } from "@knowledge-base/db/client";
import { logInternalError } from "@knowledge-base/env/log";
import { createGrantCredentialVerifier } from "../mcp-token-access";
import { assetValidationContext, prismaAssetQuery } from "./asset-authz";
import { recordAuditEvent } from "./audit";
import { runLockedOperation } from "./authority-lock";
import { authorizedAssetStream } from "./authorized-stream";
import { closePrivateTmpChain, openPrivateTmpDir, procChild } from "./cas-fd";
import { credentialQuery } from "./credential-query";
import { authorizeDocumentRead } from "./documents-read";
import { KbDomainError } from "./errors";
import { hardenedGitEnv, kbBareRepoPath, readBlobsAsync } from "./git-read";

/** Archive blobs read per batched Git process. */
const EXPORT_BLOB_BATCH = 256;

import { chargeKbMutation } from "./limits";
import { getOperationLease, type LockQuery } from "./lock";
import { parseAssetManifest, validateManifestDocument } from "./manifest";
import { canonicalRequestHash } from "./operation-intent";
import { normalizeKbPath, registerPathWithPrefixes, type SeenPathEntry } from "./paths";
import { prismaAuthorityStore, sqlAuthorityStore } from "./permissions";
import { actorKeyFor, type CredentialVerifier, type Principal } from "./principal";
import { kbBaseInputSchema } from "./protocol/common";
import { EXPORT_FAILURE_CODES, type ExportFailureCode, kbReadToolSchemas } from "./protocol/reads";
import { releaseQuota, reserveQuota, statfsDiskMeter } from "./quota";
import type { KbRuntimeConfig } from "./runtime";

export const EXPORT_LIMITS = {
  entries: 8192,
  bytes: 256 * 1024 * 1024,
  /** A background build's own bound. No request waits on it. */
  buildDeadlineMs: 30 * 60_000,
  /** A READY artifact stays downloadable this long after it became ready. */
  ttlMs: 900_000,
  /** After the last frame is first served, frames stay readable this long. */
  graceMs: 600_000,
  /** A running build renews its lease every `heartbeatMs`; a lapsed lease is swept. */
  leaseMs: 30_000,
  heartbeatMs: 5_000,
  sweepMs: 60_000,
} as const;
const MAX_ARTIFACT_BYTES = EXPORT_LIMITS.bytes + EXPORT_LIMITS.entries * (1024 + 92) + 22;
export type ExportActor = { principal: Principal; verifier?: CredentialVerifier };
export type ExportInput = {
  kbId: string;
  rev?: string;
  kind: "assets" | "whole";
  idempotencyKey: string;
};
type Entry = { path: string; size: number; blob?: string; hash?: string };
const unavailable = () => new KbDomainError("STORAGE_UNAVAILABLE", "Export unavailable");
/** This process's running builds, by export id. */
const active = new Map<
  string,
  { abort: AbortController; done: Promise<unknown>; preparing: boolean }
>();
const downloads = new Set<{ done: Promise<void>; stop(): Promise<void> }>();

/** The export lifecycle owns stream cleanup until the pending read and discard settle. */
export function trackExportDownload(download: { done: Promise<void>; stop(): Promise<void> }) {
  downloads.add(download);
  void download.done.then(
    () => downloads.delete(download),
    () => downloads.delete(download),
  );
}

export function exportAuthority(runtime: KbRuntimeConfig, actor: ExportActor, kbId: string) {
  return {
    ...actor,
    kbId,
    operation: "read" as const,
    store: prismaAuthorityStore(runtime.prisma),
  };
}

/** Every filename comes from a validated UUID, in the existing pinned private directory. */
export async function withExportFile<T>(
  assetsDir: string,
  id: string,
  work: (path: string) => Promise<T>,
) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw unavailable();
  const chain = openPrivateTmpDir(assetsDir);
  try {
    return await work(procChild(chain.tmpFd, `export-${id}`));
  } finally {
    closePrivateTmpChain(chain);
  }
}

/** No local shell, hooks, replacement refs, unbounded Git output, or orphaned child on abort. */
async function git(
  repo: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer = 2 * 1024 * 1024,
): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    const cancel = () => child.kill("SIGKILL");
    child = execFile(
      "git",
      args,
      { cwd: repo, env: hardenedGitEnv(), encoding: "buffer", maxBuffer },
      (error, stdout) => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) reject(signal.reason);
        else if (error) reject(error);
        else resolve(stdout);
      },
    );
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Complete inventory checked before opening an output file, including file/directory collisions. */
export function preflightExportEntries(entries: readonly Entry[]): number {
  if (entries.length > EXPORT_LIMITS.entries)
    throw new KbDomainError("QUOTA_EXCEEDED", "Export entry limit exceeded");
  const seen = new Map<string, SeenPathEntry>();
  let size = 0;
  for (const entry of entries) {
    if (!normalizeKbPath(entry.path).ok || registerPathWithPrefixes(seen, entry.path, "file"))
      throw new KbDomainError("INVALID_ARGUMENT", "Invalid export path");
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw unavailable();
    size += entry.size;
    if (size > EXPORT_LIMITS.bytes)
      throw new KbDomainError("QUOTA_EXCEEDED", "Export byte limit exceeded");
  }
  return size;
}

async function inventory(
  runtime: KbRuntimeConfig,
  input: { kbId: string; kind: "assets" | "whole"; rev: string },
  signal: AbortSignal,
) {
  const repo = kbBareRepoPath(runtime.reposDir, input.kbId);
  try {
    await assertReachable(repo, input.rev, signal);
  } catch (error) {
    if (error instanceof KbDomainError && error.code === "NOT_FOUND")
      throw Object.assign(new Error("Revision not found"), { code: "REVISION_NOT_FOUND" });
    throw error;
  }
  const raw = await git(repo, ["ls-tree", "-r", "-l", "-z", input.rev], signal, 8 * 1024 * 1024);
  const entries: Entry[] = [];
  for (const record of new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0")) {
    if (!record) continue;
    const match = /^100644 blob ([a-f0-9]{40}) +(\d+)\t([\s\S]+)$/.exec(record);
    if (!match) throw unavailable();
    const path = match[3]!;
    if (!(path.endsWith(".md") || path === ".gitignore" || path === ".assets/manifest.json"))
      throw unavailable();
    const size = Number(match[2]);
    if (size > 2 * 1024 * 1024) throw unavailable();
    entries.push({ path, size, blob: match[1]! });
  }
  preflightExportEntries(entries);
  const manifest = entries.find((e) => e.path === ".assets/manifest.json");
  if (!manifest?.blob) throw unavailable();
  const bytes = await git(repo, ["cat-file", "blob", manifest.blob], signal);
  const parsed = parseAssetManifest(bytes);
  if ("code" in parsed) throw unavailable();
  const context = await assetValidationContext(
    prismaAssetQuery(runtime.prisma),
    input.kbId,
    parsed.entries.map((e) => e.hash),
  );
  const treePaths = new Map<string, SeenPathEntry>();
  for (const entry of entries) registerPathWithPrefixes(treePaths, entry.path, "file");
  // Check disjointness even for an assets-only export, but budget only selected entries.
  if (validateManifestDocument(bytes, { ...context, treePaths })) throw unavailable();
  preflightExportEntries(input.kind === "whole" ? [...entries, ...parsed.entries] : parsed.entries);
  return input.kind === "whole" ? [...entries, ...parsed.entries] : parsed.entries;
}

/** ZIP32 STORE with UTF-8 names/data descriptors: bounded metadata plus one source frame.
 * The format caps above keep every offset below 2^32, so ZIP64 is unnecessary. */
export async function writeExportZip(
  file: FileHandle,
  entries: readonly Entry[],
  source: (entry: Entry) => AsyncIterable<Uint8Array>,
  signal: AbortSignal,
) {
  preflightExportEntries(entries);
  let offset = 0;
  const hash = createHash("sha256");
  const frameHashes: string[] = [];
  let frameHash = createHash("sha256");
  let frameBytes = 0;
  const directory: Buffer[] = [];
  const write = async (bytes: Buffer) => {
    signal.throwIfAborted();
    for (let at = 0; at < bytes.length; ) {
      const { bytesWritten } = await file.write(bytes, at, bytes.length - at, offset + at);
      if (!bytesWritten) throw unavailable();
      at += bytesWritten;
    }
    offset += bytes.length;
    if (offset > MAX_ARTIFACT_BYTES) throw unavailable();
    hash.update(bytes);
    for (let at = 0; at < bytes.length; ) {
      const count = Math.min(196608 - frameBytes, bytes.length - at);
      frameHash.update(bytes.subarray(at, at + count));
      at += count;
      frameBytes += count;
      if (frameBytes === 196608) {
        frameHashes.push(frameHash.digest("hex"));
        frameHash = createHash("sha256");
        frameBytes = 0;
      }
    }
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x808, 6);
    local.writeUInt16LE(33, 12);
    local.writeUInt16LE(name.length, 26);
    await write(local);
    await write(name);
    let crc = 0;
    let size = 0;
    const assetHash = entry.hash ? createHash("sha256") : undefined;
    for await (const chunk of source(entry)) {
      size += chunk.byteLength;
      if (size > entry.size) throw unavailable();
      crc = crc32(chunk, crc);
      assetHash?.update(chunk);
      await write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
    if (size !== entry.size || (assetHash && `sha256:${assetHash.digest("hex")}` !== entry.hash))
      throw unavailable();
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(descriptor);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x808, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(start, 42);
    directory.push(central, name);
  }
  const centralStart = offset;
  for (const bytes of directory) await write(bytes);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  await write(end);
  if (frameBytes) frameHashes.push(frameHash.digest("hex"));
  await file.chmod(0o400);
  await file.sync();
  signal.throwIfAborted();
  return {
    frameHashes,
    size: offset,
    contentHash: `sha256:${hash.digest("hex")}`,
    fileIdentity: fileIdentity(await file.stat({ bigint: true })),
  };
}

type ExportRow = {
  id: string;
  kbId: string;
  actorKey: string;
  kind: string;
  rev: string;
  state: ExportArtifactState;
  size: number | null;
  contentHash: string | null;
  expiresAt: Date;
  failureCode: string | null;
  progressBytes: number;
  totalBytes: number | null;
};
const exportRowSelect = {
  id: true,
  kbId: true,
  actorKey: true,
  kind: true,
  rev: true,
  state: true,
  size: true,
  contentHash: true,
  expiresAt: true,
  failureCode: true,
  progressBytes: true,
  totalBytes: true,
} satisfies Prisma.ExportArtifactSelect;

/** Fixed, user-safe text per failure code; the server log carries any cause. */
const FAILURE_MESSAGES: Record<ExportFailureCode, string> = {
  DEADLINE_EXCEEDED: "The export took longer than its time limit.",
  INTERRUPTED: "The server restarted or stopped while preparing the export. Start it again.",
  QUOTA_EXCEEDED: "The export is larger than the export limits allow.",
  ACCESS_DENIED: "Read access to this knowledge base ended while preparing the export.",
  REVISION_NOT_FOUND: "The revision is not available.",
  INVALID_CONTENT: "The revision contains content that cannot be exported.",
  STORAGE_UNAVAILABLE: "Storage was unavailable while preparing the export.",
};

function failureCode(code: string | null): ExportFailureCode {
  return (EXPORT_FAILURE_CODES as readonly string[]).includes(code ?? "")
    ? (code as ExportFailureCode)
    : "STORAGE_UNAVAILABLE";
}

/** The wire job: bytes are described (size, hash, expiry) only while downloadable. */
export function exportDescriptor(row: ExportRow, now = Date.now()) {
  const ready = row.state === "READY" && row.expiresAt.getTime() > now;
  if (ready && (row.size === null || row.contentHash === null)) throw unavailable();
  const state = ready
    ? ("ready" as const)
    : row.state === "PENDING"
      ? ("pending" as const)
      : row.state === "WRITING"
        ? ("building" as const)
        : row.state === "FAILED"
          ? ("failed" as const)
          : row.state === "CANCELLED"
            ? ("cancelled" as const)
            : ("expired" as const);
  const code = state === "failed" ? failureCode(row.failureCode) : null;
  return {
    operationId: row.id,
    transferId: row.id,
    kind: row.kind === "assets" ? ("assets" as const) : ("whole" as const),
    rev: row.rev,
    state,
    progress: {
      doneBytes: ready ? (row.totalBytes ?? row.progressBytes) : row.progressBytes,
      totalBytes: row.totalBytes,
    },
    size: ready ? row.size : null,
    contentHash: ready ? row.contentHash : null,
    expiresAt: ready ? row.expiresAt.toISOString() : null,
    error: code ? { code, message: FAILURE_MESSAGES[code] } : null,
    mime: "application/zip" as const,
  };
}
export type ExportJob = ReturnType<typeof exportDescriptor>;

/** This server process: the owner every running build's lease names. */
const LEASE_OWNER = `${hostname()}:${process.pid}:${randomUUID()}`;

/** Maps a build error to its durable failure code. */
function classifyFailure(error: unknown): ExportFailureCode {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
  if (code === "DEADLINE_EXCEEDED") return "DEADLINE_EXCEEDED";
  if (code === "INTERRUPTED") return "INTERRUPTED";
  if (code === "QUOTA_EXCEEDED") return "QUOTA_EXCEEDED";
  if (code === "INVALID_ARGUMENT") return "INVALID_CONTENT";
  if (code === "REVISION_NOT_FOUND") return "REVISION_NOT_FOUND";
  if (["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"].includes(code)) return "ACCESS_DENIED";
  return "STORAGE_UNAVAILABLE";
}

async function assertReachable(repo: string, rev: string, signal: AbortSignal) {
  const tips = (
    await git(repo, ["for-each-ref", "--format=%(objectname)", "refs/heads"], signal, 64 * 1024)
  )
    .toString()
    .trim()
    .split("\n");
  for (const tip of tips) {
    if (!/^[0-9a-f]{40}$/.test(tip)) continue;
    try {
      await git(repo, ["merge-base", "--is-ancestor", rev, tip], signal);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && [1, 128].includes(Number(error.code))))
        throw error;
    }
  }
  throw new KbDomainError("NOT_FOUND", "Revision not found");
}

/**
 * Starts (or returns) a background export job. The short authority
 * transaction is the single admission/receipt/quota serialization point; the
 * build itself is owned by this server process, never by the request, and
 * no SQL lock is held across Git or ZIP I/O. The request signal only cancels
 * admission: once the receipt commits, the job runs to READY, FAILED or
 * CANCELLED on its own bounded deadline. A repeated start (same key, or the
 * same KB/kind/revision while that job is pending, building or ready) returns
 * the existing job, never a second build.
 */
export async function prepareExport(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  raw: ExportInput,
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    /** Process-owned runtime for the build when `runtime` is bound to the request. */
    buildRuntime?: KbRuntimeConfig;
  } = {},
): Promise<ExportJob> {
  const input = kbReadToolSchemas.knowledge_export_prepare.input.parse(raw);
  // The request signal cancels admission only, as a domain CANCELLED.
  const admission = new AbortController();
  const cancel = () => admission.abort(new KbDomainError("CANCELLED", "Export cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const signal = admission.signal;
  try {
    return await admitAndStart(
      runtime,
      options.buildRuntime ?? runtime,
      actor,
      input,
      signal,
      options.deadlineMs,
    );
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
}

async function admitAndStart(
  runtime: KbRuntimeConfig,
  buildRuntime: KbRuntimeConfig,
  actor: ExportActor,
  input: ExportInput,
  signal: AbortSignal,
  deadlineMs: number | undefined,
): Promise<ExportJob> {
  const actorKey = actorKeyFor(actor.principal);
  const auth = exportAuthority(runtime, actor, input.kbId);
  const id = randomUUID();
  await authorizeDocumentRead(auth);
  signal.throwIfAborted();
  // Reachability is cheap Git metadata: an unknown revision is refused at
  // once instead of becoming a failed job.
  if (input.rev)
    await assertReachable(kbBareRepoPath(runtime.reposDir, input.kbId), input.rev, signal);
  // Never wait for another job's producer to drain: its own cleanup reclaims it.
  await reclaimExports(runtime, { join: false });
  const buildMs = Math.min(
    deadlineMs ?? EXPORT_LIMITS.buildDeadlineMs,
    EXPORT_LIMITS.buildDeadlineMs,
  );
  const admitted = await runtime.coordinator.run({
    opId: id,
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        signal.throwIfAborted();
        await authorizeDocumentRead({ ...auth, store: sqlAuthorityStore(query) });
        const requestHash = canonicalRequestHash(input);
        // A key names the job it started, or the live job it was reused for.
        const {
          rows: [prior],
        } = await query<{ id: string; requestHash: string }>(
          `SELECT id, "requestHash" FROM "export_artifact" WHERE "actorKey"=$1 AND "kbId"=$2 AND "idempotencyKey"=$3 UNION ALL SELECT "exportId" AS id, "requestHash" FROM "export_request_key" WHERE "actorKey"=$1 AND "kbId"=$2 AND "idempotencyKey"=$3 LIMIT 1`,
          [actorKey, input.kbId, input.idempotencyKey],
        );
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
          return { id: prior.id, created: false };
        }
        const kb = await runtime.prisma.knowledgeBase.findUniqueOrThrow({
          where: { id: input.kbId },
          select: { headSha: true },
        });
        const rev = input.rev ?? kb.headSha;
        if (!rev) throw unavailable();
        // The same scope while one is pending, building or still downloadable.
        const {
          rows: [same],
        } = await query<{ id: string }>(
          `SELECT id FROM "export_artifact" WHERE "actorKey"=$1 AND "kbId"=$2 AND kind=$3 AND rev=$4 AND "reclaimedAt" IS NULL AND (state IN ('PENDING','WRITING') OR (state='READY' AND "expiresAt">now())) ORDER BY "createdAt" DESC LIMIT 1`,
          [actorKey, input.kbId, input.kind, rev],
        );
        if (same) {
          // From now on this key replays the reused job, whatever its state.
          await query(
            `INSERT INTO "export_request_key" (id, "actorKey", "kbId", "idempotencyKey", "requestHash", "exportId", "createdAt") VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,now())`,
            [randomUUID(), actorKey, input.kbId, input.idempotencyKey, requestHash, same.id],
          );
          return { id: same.id, created: false };
        }
        const counts = await query<{ total: number; mine: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE "actorUserIdSnapshot" = $1)::int AS mine FROM "export_artifact" WHERE state IN ('PENDING', 'WRITING', 'READY')`,
          [actor.principal.userId],
        );
        if (counts.rows[0]!.total >= 2 || counts.rows[0]!.mine >= 1)
          throw new KbDomainError("RATE_LIMITED", "Export capacity reached");
        await chargeKbMutation(runtime.ratePort, actorKey, input.kbId);
        const deadlineAt = new Date(Date.now() + buildMs);
        const quota = await reserveQuota(
          { transactionQuery: query },
          {
            opId: id,
            charges: [],
            expiresAt: deadlineAt,
            heldForPublication: true,
            disks: [
              {
                path: runtime.assetsDir,
                bytes: BigInt(MAX_ARTIFACT_BYTES),
                meter: statfsDiskMeter(runtime.assetsDir),
              },
            ],
          },
        );
        // Until READY sets the download window, the receipt cannot expire
        // before its build deadline does.
        await query(
          `INSERT INTO "export_artifact" (id, "kbId", "actorKey", "actorUserIdSnapshot", kind, "idempotencyKey", "requestHash", rev, "reservationIds", "expiresAt", "deadlineAt", state, "leaseOwner", "leaseUntil", "createdAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING',$12,now() + ($13::int * interval '1 millisecond'),now())`,
          [
            id,
            input.kbId,
            actorKey,
            actor.principal.userId,
            input.kind,
            input.idempotencyKey,
            requestHash,
            rev,
            quota.reservationIds,
            new Date(deadlineAt.getTime() + EXPORT_LIMITS.ttlMs).toISOString(),
            deadlineAt.toISOString(),
            LEASE_OWNER,
            EXPORT_LIMITS.leaseMs,
          ],
        );
        return { id, created: true, rev, deadlineAt };
      }),
  });
  if (admitted.created)
    startBuild(buildRuntime, actor, {
      id,
      kbId: input.kbId,
      kind: input.kind,
      rev: admitted.rev!,
      deadlineAt: admitted.deadlineAt!,
    });
  return exportStatus(runtime, actor, { kbId: input.kbId, transferId: admitted.id });
}

/** The requester's job (same actor, same KB, live read), else NOT_FOUND. */
export async function exportStatus(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  raw: { kbId: string; transferId: string },
): Promise<ExportJob> {
  const input = kbReadToolSchemas.knowledge_export_status.input.parse(raw);
  await authorizeDocumentRead(exportAuthority(runtime, actor, input.kbId));
  const row = await runtime.prisma.exportArtifact.findUnique({
    where: { id: input.transferId },
    select: exportRowSelect,
  });
  if (!row || row.kbId !== input.kbId || row.actorKey !== actorKeyFor(actor.principal))
    throw new KbDomainError("NOT_FOUND", "Export not found");
  return exportDescriptor(row);
}

/** How long a finished job stays visible to `latestExport`. */
const LATEST_WINDOW_MS =
  EXPORT_LIMITS.buildDeadlineMs + EXPORT_LIMITS.ttlMs + EXPORT_LIMITS.graceMs;

/** The requester's most recent job for this KB, so a reopened page can resume it. */
export async function latestExport(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  raw: { kbId: string },
): Promise<ExportJob | null> {
  const input = kbBaseInputSchema.parse(raw);
  await authorizeDocumentRead(exportAuthority(runtime, actor, input.kbId));
  const row = await runtime.prisma.exportArtifact.findFirst({
    where: {
      actorKey: actorKeyFor(actor.principal),
      kbId: input.kbId,
      createdAt: { gt: new Date(Date.now() - LATEST_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    select: exportRowSelect,
  });
  return row ? exportDescriptor(row) : null;
}

/**
 * Cancels a pending/building job, or discards a ready one. The terminal state
 * commits under authority -> artifact row before the build is stopped and its
 * file reclaimed; a job that already finished is returned unchanged.
 */
export async function cancelExport(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  raw: { kbId: string; transferId: string },
): Promise<ExportJob> {
  const input = kbReadToolSchemas.knowledge_export_cancel.input.parse(raw);
  const auth = exportAuthority(runtime, actor, input.kbId);
  await runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        await authorizeDocumentRead({ ...auth, store: sqlAuthorityStore(query), query });
        const {
          rows: [row],
        } = await query<{ kbId: string; actorKey: string }>(
          `SELECT "kbId", "actorKey" FROM "export_artifact" WHERE id=$1::uuid FOR UPDATE`,
          [input.transferId],
        );
        if (!row || row.kbId !== input.kbId || row.actorKey !== actorKeyFor(actor.principal))
          throw new KbDomainError("NOT_FOUND", "Export not found");
        await query(
          `UPDATE "export_artifact" SET state='CANCELLED', "leaseOwner"=NULL, "leaseUntil"=NULL WHERE id=$1::uuid AND "reclaimedAt" IS NULL AND (state IN ('PENDING','WRITING') OR (state='READY' AND "downloadCompletedAt" IS NULL))`,
          [input.transferId],
        );
      }),
  });
  active.get(input.transferId)?.abort.abort(new KbDomainError("CANCELLED", "Export cancelled"));
  await reclaimExports(runtime);
  return exportStatus(runtime, actor, input);
}

/** Joins this process's build of `id` (tests and shutdown); resolves when it settles. */
export async function awaitExportBuild(id: string): Promise<void> {
  await active.get(id)?.done.catch(() => undefined);
}

function startBuild(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  job: { id: string; kbId: string; kind: "assets" | "whole"; rev: string; deadlineAt: Date },
) {
  const abort = new AbortController();
  const entry = { abort, done: Promise.resolve() as Promise<unknown>, preparing: true };
  // Registered before prepare returns, so a cancel or shutdown always finds it.
  active.set(job.id, entry);
  entry.done = buildExport(runtime, jobActor(runtime, actor, abort.signal), job, abort).catch(
    (error: unknown) => {
      logInternalError("kb.export-build", error, { opId: job.id });
    },
  );
}

/**
 * The build outlives the request, so it never reuses a request-bound
 * credential verifier (that one closes with its HTTP request). A token
 * principal is rechecked against its live grant generation, tombstones, user
 * and stored ACL on every authorization, exactly as a lock-session recheck
 * does; under a held authority lease it reads on that lease's session.
 */
function jobActor(runtime: KbRuntimeConfig, actor: ExportActor, signal: AbortSignal): ExportActor {
  if (actor.principal.kind !== "token") return { principal: actor.principal };
  const sql = credentialQuery(runtime.connectionString);
  const bound = (query: LockQuery) => createGrantCredentialVerifier(query);
  const verifier: CredentialVerifier = {
    inspect: (principal) => {
      const lease = getOperationLease();
      return lease
        ? bound(lease.query).inspect(principal)
        : sql(signal, (query) => bound(query).inspect(principal));
    },
    grantBits: (principal, kbId) => {
      const lease = getOperationLease();
      return lease
        ? bound(lease.query).grantBits!(principal, kbId)
        : sql(signal, (query) => bound(query).grantBits!(principal, kbId));
    },
    forQuery: (query) => (getOperationLease() ? bound(query) : verifier),
  };
  return { principal: actor.principal, verifier };
}

async function buildExport(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  job: { id: string; kbId: string; kind: "assets" | "whole"; rev: string; deadlineAt: Date },
  abort: AbortController,
) {
  const { id } = job;
  const auth = exportAuthority(runtime, actor, job.kbId);
  const actorKey = actorKeyFor(actor.principal);
  let progress = 0;
  const deadline = setTimeout(
    () => abort.abort(new KbDomainError("DEADLINE_EXCEEDED", "Export deadline exceeded")),
    Math.max(0, job.deadlineAt.getTime() - Date.now()),
  );
  deadline.unref();
  // The lease is this process's claim on the job; a heartbeat that finds the
  // row no longer ours (cancelled, swept) stops the build.
  let beat = Promise.resolve();
  const heartbeat = setInterval(() => {
    beat = beat
      .then(async () => {
        const renewed = await runtime.prisma.$executeRawUnsafe(
          `UPDATE "export_artifact" SET "leaseUntil"=now() + ($3::int * interval '1 millisecond'), "progressBytes"=$4 WHERE id=$1::uuid AND "leaseOwner"=$2 AND state IN ('PENDING','WRITING')`,
          id,
          LEASE_OWNER,
          EXPORT_LIMITS.leaseMs,
          progress,
        );
        if (renewed !== 1) abort.abort(new KbDomainError("CANCELLED", "Export no longer owned"));
      })
      .catch((error: unknown) => logInternalError("kb.export-heartbeat", error, { opId: id }));
  }, EXPORT_LIMITS.heartbeatMs);
  heartbeat.unref();
  try {
    const started = await runtime.prisma.$executeRawUnsafe(
      `UPDATE "export_artifact" SET state='WRITING' WHERE id=$1::uuid AND state='PENDING' AND "leaseOwner"=$2`,
      id,
      LEASE_OWNER,
    );
    if (started !== 1) return;
    await authorizeDocumentRead(auth);
    abort.signal.throwIfAborted();
    const entries = await inventory(runtime, job, abort.signal);
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    await runtime.prisma.exportArtifact.updateMany({
      where: { id, leaseOwner: LEASE_OWNER, state: "WRITING" },
      data: { totalBytes },
    });
    // Blobs are read in batches, in archive order (never one process per file).
    const blobEntries = entries.filter(
      (entry): entry is Entry & { blob: string } => "blob" in entry && !!entry.blob,
    );
    const position = new Map<unknown, number>(blobEntries.map((entry, index) => [entry, index]));
    let batch: ReadonlyMap<string, Buffer> = new Map();
    const blobOf = async (entry: Entry): Promise<Buffer> => {
      const cached = batch.get(entry.blob!);
      if (cached) return cached;
      const start =
        position.get(entry) ?? blobEntries.findIndex((next) => next.blob === entry.blob);
      try {
        batch = await readBlobsAsync(
          kbBareRepoPath(runtime.reposDir, job.kbId),
          blobEntries.slice(start, start + EXPORT_BLOB_BATCH).map((next) => next.blob),
          { maxBytes: 2 * 1024 * 1024 },
          { signal: abort.signal },
        );
      } catch (error) {
        abort.signal.throwIfAborted();
        throw error;
      }
      return batch.get(entry.blob!)!;
    };
    const content = async function* (entry: Entry) {
      abort.signal.throwIfAborted();
      await authorizeDocumentRead(auth);
      if (entry.blob) {
        yield await blobOf(entry);
        return;
      }
      const { body } = await authorizedAssetStream({
        ...auth,
        query: prismaAssetQuery(runtime.prisma),
        reposDir: runtime.reposDir,
        blobStore: runtime.blobStore,
        purpose: "internal",
        rev: job.rev,
        hash: entry.hash!,
        range: null,
        signal: abort.signal,
      });
      if (!body) throw unavailable();
      const reader = body.getReader();
      try {
        for (;;) {
          const value = await reader.read();
          if (value.done) break;
          yield value.value;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    };
    const source = async function* (entry: Entry) {
      for await (const chunk of content(entry)) {
        progress += chunk.byteLength;
        yield chunk;
      }
    };
    const sealed = await withExportFile(runtime.assetsDir, id, async (path) => {
      abort.signal.throwIfAborted();
      const file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        return await writeExportZip(file, entries, source, abort.signal);
      } finally {
        await file.close();
      }
    });
    // File contents and containing directory are durable before READY is committed.
    const chain = openPrivateTmpDir(runtime.assetsDir);
    try {
      fsyncSync(chain.tmpFd);
    } finally {
      closePrivateTmpChain(chain);
    }
    await runtime.coordinator.run({
      opId: randomUUID(),
      kind: "authority",
      run: ({ lease }) =>
        lease.transaction(async (query) => {
          await authorizeDocumentRead({ ...auth, store: sqlAuthorityStore(query) });
          abort.signal.throwIfAborted();
          // The download window starts when the bytes are ready.
          const result = await query(
            `UPDATE "export_artifact" SET state='READY', size=$2, "contentHash"=$3, "fileIdentity"=$4, "frameHashes"=$5, "progressBytes"=$6, "expiresAt"=now() + ($8::int * interval '1 millisecond'), "leaseOwner"=NULL, "leaseUntil"=NULL WHERE id=$1::uuid AND state='WRITING' AND "leaseOwner"=$7 AND "deadlineAt">clock_timestamp() RETURNING "reservationIds"`,
            [
              id,
              sealed.size,
              sealed.contentHash,
              sealed.fileIdentity,
              sealed.frameHashes,
              totalBytes,
              LEASE_OWNER,
              EXPORT_LIMITS.ttlMs,
            ],
          );
          if (result.rowCount !== 1) {
            abort.signal.throwIfAborted();
            if (Date.now() >= job.deadlineAt.getTime())
              throw new KbDomainError("DEADLINE_EXCEEDED", "Export deadline exceeded");
            throw unavailable();
          }
          const receipt = await query<{ reservationIds: string[] }>(
            `SELECT "reservationIds" FROM "export_artifact" WHERE id=$1::uuid`,
            [id],
          );
          await releaseQuota({ transactionQuery: query }, receipt.rows[0]!.reservationIds);
          await recordAuditEvent(query, {
            opId: id,
            action: "export_prepare",
            outcome: "SUCCESS",
            actorKey,
            actorUserIdSnapshot: actor.principal.userId,
            kbId: job.kbId,
            revision: job.rev,
          });
          // `now()` is this transaction's start: recheck the deadline (and the
          // build's signal) on the wall clock as the last step before commit,
          // so a publication stalled past the deadline rolls back.
          const { rowCount: inTime } = await query(
            `SELECT 1 FROM "export_artifact" WHERE id=$1::uuid AND "deadlineAt">clock_timestamp()`,
            [id],
          );
          abort.signal.throwIfAborted();
          if (inTime !== 1)
            throw new KbDomainError("DEADLINE_EXCEEDED", "Export deadline exceeded");
        }),
    });
  } catch (error) {
    const reason = abort.signal.aborted ? abort.signal.reason : error;
    const code = classifyFailure(reason);
    // A cancelled or swept job is already terminal; only our own lease fails.
    await runtime.prisma.exportArtifact.updateMany({
      where: { id, leaseOwner: LEASE_OWNER, state: { in: ["PENDING", "WRITING"] } },
      data: { state: "FAILED", failureCode: code, leaseOwner: null, leaseUntil: null },
    });
    if (code === "STORAGE_UNAVAILABLE" && !abort.signal.aborted)
      logInternalError("kb.export-build", error, { opId: id });
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    await beat;
    // Retain shutdown ownership through reclamation. The reaper may reclaim
    // this artifact once preparation has left its file/publication phase.
    const entry = active.get(id);
    if (entry) entry.preparing = false;
    try {
      await reclaimExports(runtime);
    } finally {
      active.delete(id);
    }
  }
}

/**
 * Startup runs before admission; periodic reclamation is keyset bounded and retries failed unlinks.
 * It is also the stale-job sweep: a pending/building job whose lease lapsed
 * (its process died or stopped renewing) or whose deadline passed ends FAILED
 * (`INTERRUPTED` / `DEADLINE_EXCEEDED`), so no job stays building forever.
 * An unacknowledged completed download is reclaimed when its grace window
 * (stored as `expiresAt`) passes; it ends DOWNLOADED, never ABORTED. `now` is
 * injectable for tests only; production always sweeps at the wall clock.
 */
export async function reclaimExports(
  runtime: KbRuntimeConfig,
  /** `join: false` aborts a live producer without waiting for it (admission). */
  options: { restart?: boolean; now?: Date; join?: boolean } = {},
) {
  // The server is the only process that builds exports and its role fence
  // admits one at a time: at startup no earlier process's build is alive.
  if (options.restart)
    await runtime.prisma.exportArtifact.updateMany({
      where: {
        state: { in: ["PENDING", "WRITING"] },
        OR: [{ leaseOwner: null }, { leaseOwner: { not: LEASE_OWNER } }],
      },
      data: { state: "FAILED", failureCode: "INTERRUPTED", leaseOwner: null, leaseUntil: null },
    });
  let cursor = "";
  const cutoff = options.now ?? new Date();
  for (;;) {
    const rows = await runtime.prisma.exportArtifact.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        reclaimedAt: null,
        OR: [
          { state: { in: ["ABORTED", "DOWNLOADED", "FAILED", "CANCELLED"] } },
          { expiresAt: { lte: cutoff } },
          { state: { in: ["PENDING", "WRITING"] }, deadlineAt: { lte: cutoff } },
          { state: { in: ["PENDING", "WRITING"] }, leaseUntil: { lte: cutoff } },
          { state: { in: ["PENDING", "WRITING"] }, leaseUntil: null },
        ],
      },
      orderBy: { id: "asc" },
      take: 50,
    });
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      let preparingOwner: { done: Promise<unknown> } | undefined;
      do {
        // Internal reclamation remains admitted during server shutdown; it needs
        // the authority fence, but never a user Git-write/native capability.
        preparingOwner = await runLockedOperation({
          connectionString: runtime.connectionString,
          opId: randomUUID(),
          kind: "authority",
          run: async (lease) => {
            // The page is only a candidate inventory. EOF and reclamation both
            // take authority before the row; PostgreSQL rechecks this predicate
            // against the current version after any row wait.
            // Commit terminal intent BEFORE unlink, so a crash or failed fsync
            // cannot roll a deleted artifact back to readable READY state.
            const reserved = await lease.transaction(async (query) => {
              const { rowCount } = await query(
                `UPDATE "export_artifact" SET state=CASE WHEN state IN ('PENDING','WRITING') THEN 'FAILED'::"ExportArtifactState" WHEN state IN ('FAILED','CANCELLED') THEN state WHEN state='DOWNLOADED' OR (state='READY' AND "downloadCompletedAt" IS NOT NULL) THEN 'DOWNLOADED'::"ExportArtifactState" ELSE 'ABORTED'::"ExportArtifactState" END, "failureCode"=CASE WHEN state IN ('PENDING','WRITING') THEN CASE WHEN "deadlineAt"<=$2 THEN 'DEADLINE_EXCEEDED' ELSE 'INTERRUPTED' END ELSE "failureCode" END, "leaseOwner"=NULL, "leaseUntil"=NULL WHERE id=$1::uuid AND "reclaimedAt" IS NULL AND (state IN ('ABORTED','DOWNLOADED','FAILED','CANCELLED') OR "expiresAt"<=$2 OR (state IN ('PENDING','WRITING') AND ("deadlineAt"<=$2 OR "leaseUntil" IS NULL OR "leaseUntil"<=$2)))`,
                [row.id, cutoff],
              );
              return rowCount === 1;
            });
            if (!reserved) return;
            const preparing = active.get(row.id);
            if (preparing?.preparing) {
              preparing.abort.abort(new KbDomainError("CANCELLED", "Export reclaimed"));
              // Return the owner, never its promise: joining under this authority
              // lease would deadlock its finally path's own reclamation.
              return { done: preparing.done };
            }
            await lease.transaction(async (query) => {
              // Lock order is authority -> artifact row in both transactions.
              // Read cleanup metadata under that row lock, never from the page.
              const {
                rows: [current],
              } = await query<{ reservationIds: string[] }>(
                `SELECT "reservationIds" FROM "export_artifact" WHERE id=$1::uuid AND state IN ('ABORTED','DOWNLOADED','FAILED','CANCELLED') AND "reclaimedAt" IS NULL FOR UPDATE`,
                [row.id],
              );
              if (!current) return;
              await withExportFile(runtime.assetsDir, row.id, async (path) => {
                try {
                  await unlink(path);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
              });
              const chain = openPrivateTmpDir(runtime.assetsDir);
              try {
                fsyncSync(chain.tmpFd);
              } finally {
                closePrivateTmpChain(chain);
              }
              await releaseQuota({ transactionQuery: query }, current.reservationIds);
              await query(`UPDATE "export_artifact" SET "reclaimedAt"=now() WHERE id=$1::uuid`, [
                row.id,
              ]);
            });
          },
        });
        if (preparingOwner && options.join === false) break;
        if (preparingOwner) await preparingOwner.done.catch(() => undefined);
        // Retry after the owner leaves active: its cleanup may have failed, and
        // a terminal caller must not report reclamation before a successful retry.
        // Each UUID has one producer, removed before done settles: at most two passes.
      } while (preparingOwner);
    }
  }
}

export async function startExportLifecycle(runtime: KbRuntimeConfig) {
  await reclaimExports(runtime, { restart: true });
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => reclaimExports(runtime))
      .catch((error: unknown) => {
        logInternalError("kb.export-reclaim", error);
      });
  }, EXPORT_LIMITS.sweepMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      // A stopping server's builds end FAILED (INTERRUPTED); the user restarts them.
      for (const entry of active.values())
        entry.abort.abort(Object.assign(new Error("Server stopping"), { code: "INTERRUPTED" }));
      const drainingDownloads = [...downloads].map((download) => download.stop());
      await Promise.allSettled([...active.values()].map((e) => e.done));
      const results = await Promise.allSettled(drainingDownloads);
      await pending;
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    },
  };
}

export function fileIdentity(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
