import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Prisma } from "@knowledge-base/db/client";
import { type AuthorizedFrame, authorizedFrameStream } from "./authorized-stream";
import { authorizeDocumentRead } from "./documents-read";
import { KbDomainError } from "./errors";
import {
  EXPORT_LIMITS,
  type ExportActor,
  exportAuthority,
  fileIdentity,
  reclaimExports,
  trackExportDownload,
  withExportFile,
} from "./exports";
import type { LockQuery } from "./lock";
import { sqlAuthorityStore } from "./permissions";
import { actorKeyFor } from "./principal";
import { kbReadToolSchemas } from "./protocol/reads";
import type { KbRuntimeConfig } from "./runtime";

const notFound = () => new KbDomainError("NOT_FOUND", "Transfer not found");
type TransferInput = { kbId: string; transferId: string; offset: number; maxBytes?: number };

/**
 * Admission never loads `frameHashes`: that array grows with the artifact
 * (one hash per 192 KiB frame), and loading it on every frame made each read
 * O(artifact size) and churned the heap. A read fetches only its own slice.
 */
const admissionSelect = {
  id: true,
  kbId: true,
  actorKey: true,
  state: true,
  expiresAt: true,
  size: true,
  contentHash: true,
  fileIdentity: true,
} satisfies Prisma.ExportArtifactSelect;

async function admitted(runtime: KbRuntimeConfig, actor: ExportActor, kbId: string, id: string) {
  await authorizeDocumentRead(exportAuthority(runtime, actor, kbId));
  const row = await runtime.prisma.exportArtifact.findUnique({
    where: { id },
    select: admissionSelect,
  });
  if (
    !row ||
    row.kbId !== kbId ||
    row.actorKey !== actorKeyFor(actor.principal) ||
    row.state !== "READY" ||
    row.expiresAt.getTime() <= Date.now()
  )
    throw notFound();
  if (row.size === null || row.contentHash === null || row.fileIdentity === null) throw notFound();
  return { ...row, size: row.size, contentHash: row.contentHash, fileIdentity: row.fileIdentity };
}

/**
 * The frame carrying EOF starts the grace window, once: the artifact
 * stays READY (slot held, frames readable, so a lost last reply is retryable)
 * and its expiry becomes EOF-time + `graceMs`. It is never deleted here; the
 * client's acknowledgement (`completeExport`) or the expiry sweep releases it.
 * Fenced on READY and unexpired; CASE preserves an existing grace on retries.
 */
async function startDownloadGrace(query: LockQuery, id: string): Promise<void> {
  const { rowCount: changed } = await query(
    `UPDATE "export_artifact" SET "downloadCompletedAt"=COALESCE("downloadCompletedAt",now()), "expiresAt"=CASE WHEN "downloadCompletedAt" IS NULL THEN now() + ($2::int * interval '1 millisecond') ELSE "expiresAt" END WHERE id=$1::uuid AND state='READY' AND "expiresAt">now()`,
    [id, EXPORT_LIMITS.graceMs],
  );
  if (changed !== 1) throw notFound();
}

/** A failed read owns only unfinished artifacts; a sibling's delivered EOF keeps grace. */
async function discardUnfinishedExport(runtime: KbRuntimeConfig, id: string) {
  await runtime.prisma.exportArtifact.updateMany({
    where: { id, state: "READY", downloadCompletedAt: null },
    data: { state: "ABORTED" },
  });
  await reclaimExports(runtime);
}

/** Random-access frames allow identical retries until the export is released; persisted offset is the high-water mark only.
 * EOF is attached to the final nonempty frame (offset==size is outside the artifact). */
export async function readTransfer(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  raw: TransferInput,
  delivery?: {
    signal?: AbortSignal;
    emit?: (frame: AuthorizedFrame) => void;
    finalize?: (
      frame: AuthorizedFrame & { transferId: string; offset: number; contentHash: string },
    ) => Promise<void>;
  },
) {
  const input = kbReadToolSchemas.knowledge_transfer_read.input.parse(raw);
  const row = await admitted(runtime, actor, input.kbId, input.transferId);
  if (input.offset >= row.size)
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid transfer offset");
  const start = Math.floor(input.offset / 196608) * 196608;
  const end = Math.min(input.offset + (input.maxBytes ?? 196608), row.size);
  const length = Math.min(Math.ceil(end / 196608) * 196608, row.size) - start;
  // Postgres arrays are 1-based; the slice is exactly this read's sealed frames.
  const [slice] = await runtime.prisma.$queryRawUnsafe<{ hashes: string[] | null }[]>(
    `SELECT "frameHashes"[$2::int:$3::int] AS hashes FROM "export_artifact" WHERE id=$1::uuid`,
    row.id,
    start / 196608 + 1,
    Math.ceil((start + length) / 196608),
  );
  const frameHashes = slice?.hashes ?? [];
  const bytes = await withExportFile(runtime.assetsDir, row.id, async (path) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const check = async () => {
        const stat = await file.stat({ bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || fileIdentity(stat) !== row.fileIdentity)
          throw new KbDomainError("STORAGE_UNAVAILABLE", "Export unavailable");
      };
      await check();
      if (frameHashes.length !== Math.ceil(length / 196608))
        throw new KbDomainError("STORAGE_UNAVAILABLE", "Export unavailable");
      const buffer = Buffer.alloc(length);
      let at = 0;
      while (at < buffer.length) {
        const { bytesRead } = await file.read(buffer, at, buffer.length - at, start + at);
        if (!bytesRead) throw new KbDomainError("STORAGE_UNAVAILABLE", "Export unavailable");
        at += bytesRead;
      }
      await check();
      for (let at = 0; at < buffer.length; at += 196608) {
        const digest = createHash("sha256")
          .update(buffer.subarray(at, at + 196608))
          .digest("hex");
        if (digest !== frameHashes[at / 196608])
          throw new KbDomainError("STORAGE_UNAVAILABLE", "Export unavailable");
      }
      return buffer.subarray(input.offset - start, end - start);
    } finally {
      await file.close();
    }
  }).catch(async () => {
    await runtime.prisma.exportArtifact.updateMany({
      where: { id: row.id, state: "READY" },
      data: { state: "ABORTED" },
    });
    await reclaimExports(runtime);
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Export unavailable");
  });
  const nextOffset = input.offset + bytes.length;
  // State/expiry predicate also fences a concurrent cancel. Reads never update expiresAt.
  const changed = await runtime.prisma.$executeRawUnsafe(
    `UPDATE "export_artifact" SET "offset"=GREATEST("offset",$2::int) WHERE id=$1::uuid AND state='READY' AND "expiresAt">now()`,
    row.id,
    nextOffset,
  );
  if (changed !== 1) throw notFound();
  const frame = {
    transferId: row.id,
    offset: input.offset,
    nextOffset,
    bytesBase64: bytes.toString("base64"),
    eof: nextOffset === row.size,
    contentHash: row.contentHash,
  };
  if (frame.eof) {
    // Lock order: authority -> artifact row, held through final transport checks
    // and synchronous ZIP emission. The lease also rebinds PAT/OAuth verification
    // to this SQL connection; no nested authority acquisition can deadlock cleanup.
    return runtime.coordinator
      .run({
        opId: randomUUID(),
        kind: "authority",
        run: ({ lease }) =>
          lease.transaction(async (query) => {
            delivery?.signal?.throwIfAborted();
            await startDownloadGrace(query, row.id);
            await authorizeDocumentRead({
              ...exportAuthority(runtime, actor, input.kbId),
              store: sqlAuthorityStore(query),
              query,
            });
            await delivery?.finalize?.(frame);
            delivery?.signal?.throwIfAborted();
            delivery?.emit?.(frame);
            return frame;
          }),
      })
      .catch(async (error: unknown) => {
        await discardUnfinishedExport(runtime, row.id);
        throw error;
      });
  }
  const final = await admitted(runtime, actor, input.kbId, row.id);
  await authorizeDocumentRead(exportAuthority(runtime, actor, input.kbId));
  if (final.expiresAt.getTime() <= Date.now()) throw notFound();
  await delivery?.finalize?.(frame);
  delivery?.signal?.throwIfAborted();
  delivery?.emit?.(frame);
  return frame;
}

export async function downloadExport(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  input: { kbId: string; transferId: string; signal: AbortSignal; isShuttingDown?: () => boolean },
) {
  if (input.isShuttingDown?.()) throw new DOMException("Transfer closed", "AbortError");
  const abort = new AbortController();
  const settled = Promise.withResolvers<void>();
  // Register before admission's first await: shutdown also owns downloads still
  // waiting for authority/row I/O, rather than only already-created response bodies.
  trackExportDownload({
    done: settled.promise,
    stop() {
      abort.abort();
      return settled.promise;
    },
  });
  try {
    const row = await admitted(runtime, actor, input.kbId, input.transferId);
    const download = authorizedFrameStream({
      signal: AbortSignal.any([input.signal, abort.signal]),
      isShuttingDown: input.isShuttingDown,
      read: (offset, deliver) =>
        readTransfer(
          runtime,
          actor,
          { kbId: input.kbId, transferId: input.transferId, offset },
          { emit: deliver, signal: AbortSignal.any([input.signal, abort.signal]) },
        ),
      async discard() {
        await discardUnfinishedExport(runtime, row.id);
      },
    });
    void download.done.then(settled.resolve, settled.reject);
    return { body: download.body, size: row.size };
  } catch (error) {
    settled.resolve();
    throw error;
  }
}

/**
 * The client's "download complete" acknowledgement. Only the actor
 * that prepared the export (same actor key, same KB, still authorized to read
 * it) can acknowledge; anyone else gets NOT_FOUND and nothing changes. A READY
 * artifact ends DOWNLOADED when its last frame was served, else ABORTED (the
 * client gave up); either way the slot is released and the file deleted before
 * this returns. Acknowledging an already released export is an idempotent
 * success; a still-writing one is a CONFLICT.
 */
export async function completeExport(
  runtime: KbRuntimeConfig,
  actor: ExportActor,
  raw: { kbId: string; transferId: string },
) {
  const input = kbReadToolSchemas.knowledge_export_complete.input.parse(raw);
  // Lock order: authority -> artifact row. All identity/share/credential writers
  // use this authority key; reclamation happens only after the terminal commit.
  const id = await runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        await authorizeDocumentRead({
          ...exportAuthority(runtime, actor, input.kbId),
          store: sqlAuthorityStore(query),
          query,
        });
        const {
          rows: [row],
        } = await query<{ id: string; kbId: string; actorKey: string; state: string }>(
          `SELECT id, "kbId", "actorKey", state FROM "export_artifact" WHERE id=$1::uuid`,
          [input.transferId],
        );
        if (!row || row.kbId !== input.kbId || row.actorKey !== actorKeyFor(actor.principal))
          throw notFound();
        if (row.state === "WRITING") throw new KbDomainError("CONFLICT", "Export is not ready");
        await query(
          `UPDATE "export_artifact" SET state=CASE WHEN "downloadCompletedAt" IS NOT NULL THEN 'DOWNLOADED'::"ExportArtifactState" ELSE 'ABORTED'::"ExportArtifactState" END WHERE id=$1::uuid AND state='READY'`,
          [row.id],
        );
        return row.id;
      }),
  });
  await reclaimExports(runtime);
  return { transferId: id, released: true as const };
}
