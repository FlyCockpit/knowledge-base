import { type ChildProcess, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, fsyncSync } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { logInternalError } from "@knowledge-base/env/log";
import { assetValidationContext, prismaAssetQuery } from "./asset-authz";
import { recordAuditEvent } from "./audit";
import { runLockedOperation } from "./authority-lock";
import { authorizedAssetStream } from "./authorized-stream";
import { closePrivateTmpChain, openPrivateTmpDir, procChild } from "./cas-fd";
import { authorizeDocumentRead } from "./documents-read";
import { KbDomainError } from "./errors";
import { hardenedGitEnv, kbBareRepoPath, readBlobsAsync } from "./git-read";

/** Archive blobs read per batched Git process. */
const EXPORT_BLOB_BATCH = 256;

import { chargeKbMutation } from "./limits";
import { parseAssetManifest, validateManifestDocument } from "./manifest";
import { canonicalRequestHash } from "./operation-intent";
import { normalizeKbPath, registerPathWithPrefixes, type SeenPathEntry } from "./paths";
import { prismaAuthorityStore, sqlAuthorityStore } from "./permissions";
import { actorKeyFor, type CredentialVerifier, type Principal } from "./principal";
import { kbReadToolSchemas } from "./protocol/reads";
import { releaseQuota, reserveQuota, statfsDiskMeter } from "./quota";
import type { KbRuntimeConfig } from "./runtime";

export const EXPORT_LIMITS = {
  entries: 8192,
  bytes: 256 * 1024 * 1024,
  deadlineMs: 120_000,
  ttlMs: 900_000,
  /** After the last frame is first served, frames stay readable this long. */
  graceMs: 600_000,
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
  input: ExportInput & { rev: string },
  signal: AbortSignal,
) {
  const repo = kbBareRepoPath(runtime.reposDir, input.kbId);
  const tips = (
    await git(repo, ["for-each-ref", "--format=%(objectname)", "refs/heads"], signal, 64 * 1024)
  )
    .toString()
    .trim()
    .split("\n");
  let reachable = false;
  for (const tip of tips) {
    if (!/^[0-9a-f]{40}$/.test(tip)) continue;
    try {
      await git(repo, ["merge-base", "--is-ancestor", input.rev, tip], signal);
      reachable = true;
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && [1, 128].includes(Number(error.code))))
        throw error;
    }
  }
  if (!reachable) throw new KbDomainError("NOT_FOUND", "Revision not found");
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

export function exportDescriptor(row: {
  id: string;
  rev: string;
  size: number | null;
  contentHash: string | null;
  expiresAt: Date;
}) {
  if (row.size === null || row.contentHash === null) throw unavailable();
  return {
    operationId: row.id,
    transferId: row.id,
    rev: row.rev,
    size: row.size,
    contentHash: row.contentHash,
    expiresAt: row.expiresAt.toISOString(),
    mime: "application/zip" as const,
  };
}

/** Short authority transaction is the single admission/receipt/quota serialization point.
 * Generation has one owner; no SQL lock is held across Git or ZIP I/O. */
export async function prepareExport(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  raw: ExportInput,
  options: { signal?: AbortSignal; deadlineMs?: number } = {},
) {
  const input = kbReadToolSchemas.knowledge_export_prepare.input.parse(raw);
  const actorKey = actorKeyFor(actor.principal);
  const auth = exportAuthority(runtime, actor, input.kbId);
  const id = randomUUID();
  const abort = new AbortController();
  const cancel = () => abort.abort(new KbDomainError("CANCELLED", "Export cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(
    () => abort.abort(new KbDomainError("DEADLINE_EXCEEDED", "Export deadline exceeded")),
    Math.min(options.deadlineMs ?? EXPORT_LIMITS.deadlineMs, EXPORT_LIMITS.deadlineMs),
  );
  timer.unref();
  const work = async () => {
    let owned = false;
    try {
      await authorizeDocumentRead(auth);
      abort.signal.throwIfAborted();
      await reclaimExports(runtime);
      const row = await runtime.coordinator.run({
        opId: id,
        kind: "authority",
        run: ({ lease }) =>
          lease.transaction(async (query) => {
            abort.signal.throwIfAborted();
            await authorizeDocumentRead({ ...auth, store: sqlAuthorityStore(query) });
            const requestHash = canonicalRequestHash(input);
            const prior = await runtime.prisma.exportArtifact.findUnique({
              where: {
                actorKey_kbId_idempotencyKey: {
                  actorKey,
                  kbId: input.kbId,
                  idempotencyKey: input.idempotencyKey,
                },
              },
            });
            if (prior) {
              if (prior.requestHash !== requestHash)
                throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
              if (prior.state !== "READY" || prior.expiresAt.getTime() <= Date.now())
                throw new KbDomainError("CONFLICT", "Export is not available");
              return prior;
            }
            const counts = await query<{ total: number; mine: number }>(
              `SELECT count(*)::int AS total, count(*) FILTER (WHERE "actorUserIdSnapshot" = $1)::int AS mine FROM "export_artifact" WHERE state IN ('WRITING', 'READY')`,
              [actor.principal.userId],
            );
            if (counts.rows[0]!.total >= 2 || counts.rows[0]!.mine >= 1)
              throw new KbDomainError("RATE_LIMITED", "Export capacity reached");
            const kb = await runtime.prisma.knowledgeBase.findUniqueOrThrow({
              where: { id: input.kbId },
              select: { headSha: true },
            });
            const rev = input.rev ?? kb.headSha;
            if (!rev) throw unavailable();
            await chargeKbMutation(runtime.ratePort, actorKey, input.kbId);
            const expiresAt = new Date(Date.now() + EXPORT_LIMITS.ttlMs);
            const quota = await reserveQuota(
              { transactionQuery: query },
              {
                opId: id,
                charges: [],
                expiresAt,
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
            await query(
              `INSERT INTO "export_artifact" (id, "kbId", "actorKey", "actorUserIdSnapshot", kind, "idempotencyKey", "requestHash", rev, "reservationIds", "expiresAt", "deadlineAt", state, "createdAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'WRITING',now())`,
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
                expiresAt.toISOString(),
                new Date(Date.now() + EXPORT_LIMITS.deadlineMs).toISOString(),
              ],
            );
            return { id, rev };
          }),
      });
      if (row.id !== id) {
        abort.signal.throwIfAborted();
        await authorizeDocumentRead(auth);
        const receipt = await runtime.prisma.exportArtifact.findUniqueOrThrow({
          where: { id: row.id },
        });
        await authorizeDocumentRead(auth);
        if (receipt.state !== "READY" || receipt.expiresAt.getTime() <= Date.now())
          throw new KbDomainError("CONFLICT", "Export is not available");
        return exportDescriptor(receipt);
      }
      owned = true;
      const entries = await inventory(runtime, { ...input, rev: row.rev }, abort.signal);
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
            kbBareRepoPath(runtime.reposDir, input.kbId),
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
      const source = async function* (entry: Entry) {
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
          rev: row.rev,
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
            const result = await query(
              `UPDATE "export_artifact" SET state='READY', size=$2, "contentHash"=$3, "fileIdentity"=$4, "frameHashes"=$5 WHERE id=$1::uuid AND state='WRITING' AND "expiresAt">now() AND "deadlineAt">now() RETURNING "reservationIds"`,
              [id, sealed.size, sealed.contentHash, sealed.fileIdentity, sealed.frameHashes],
            );
            if (result.rowCount !== 1) throw unavailable();
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
              kbId: input.kbId,
              revision: row.rev,
            });
          }),
      });
      abort.signal.throwIfAborted();
      await authorizeDocumentRead(auth);
      return exportDescriptor(
        await runtime.prisma.exportArtifact.findUniqueOrThrow({ where: { id } }),
      );
    } catch (error) {
      if (owned)
        await runtime.prisma.exportArtifact.updateMany({
          // A replay may already have delivered EOF or acknowledged this READY
          // receipt while its original producer's final return was in flight.
          where: { id, state: { in: ["WRITING", "READY"] }, downloadCompletedAt: null },
          data: { state: "ABORTED" },
        });
      if (
        error instanceof KbDomainError ||
        (error instanceof Error &&
          "code" in error &&
          ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "RATE_LIMITED", "QUOTA_EXCEEDED"].includes(
            String(error.code),
          ))
      )
        throw error;
      throw unavailable();
    } finally {
      // Retain shutdown ownership through reclamation. The reaper may reclaim
      // this artifact once preparation has left its file/publication phase.
      const entry = active.get(id);
      if (entry) entry.preparing = false;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      try {
        if (owned) await reclaimExports(runtime);
      } finally {
        active.delete(id);
      }
    }
  };
  const done = work();
  active.set(id, { abort, done, preparing: true });
  // Return cancellation promptly even if an underlying database read is slow.
  // The owned work remains registered until its I/O joins and cleanup completes;
  // every subsequent file/publication boundary checks this same abort signal.
  const cancelled = new Promise<never>((_, reject) => {
    if (abort.signal.aborted) reject(abort.signal.reason);
    else abort.signal.addEventListener("abort", () => reject(abort.signal.reason), { once: true });
  });
  return Promise.race([done, cancelled]);
}

/**
 * Startup runs before admission; periodic reclamation is keyset bounded and retries failed unlinks.
 * An unacknowledged completed download is reclaimed when its grace window
 * (stored as `expiresAt`) passes; it ends DOWNLOADED, never ABORTED. `now` is
 * injectable for tests only; production always sweeps at the wall clock.
 */
export async function reclaimExports(
  runtime: KbRuntimeConfig,
  options: { restart?: boolean; now?: Date } = {},
) {
  if (options.restart)
    await runtime.prisma.exportArtifact.updateMany({
      where: { state: "WRITING" },
      data: { state: "ABORTED" },
    });
  let cursor = "";
  const cutoff = options.now ?? new Date();
  for (;;) {
    const rows = await runtime.prisma.exportArtifact.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        reclaimedAt: null,
        OR: [
          { state: "ABORTED" },
          { state: "DOWNLOADED" },
          { expiresAt: { lte: cutoff } },
          { state: "WRITING", deadlineAt: { lte: cutoff } },
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
                `UPDATE "export_artifact" SET state=CASE WHEN state='DOWNLOADED' OR (state='READY' AND "downloadCompletedAt" IS NOT NULL) THEN 'DOWNLOADED'::"ExportArtifactState" ELSE 'ABORTED'::"ExportArtifactState" END WHERE id=$1::uuid AND "reclaimedAt" IS NULL AND (state IN ('ABORTED','DOWNLOADED') OR "expiresAt"<=$2 OR (state='WRITING' AND "deadlineAt"<=$2))`,
                [row.id, cutoff],
              );
              return rowCount === 1;
            });
            if (!reserved) return;
            const preparing = active.get(row.id);
            if (preparing?.preparing) {
              preparing.abort.abort(new KbDomainError("CANCELLED", "Export expired"));
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
                `SELECT "reservationIds" FROM "export_artifact" WHERE id=$1::uuid AND state IN ('ABORTED','DOWNLOADED') AND "reclaimedAt" IS NULL FOR UPDATE`,
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
  }, 60_000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      for (const entry of active.values())
        entry.abort.abort(new KbDomainError("CANCELLED", "Server stopping"));
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
