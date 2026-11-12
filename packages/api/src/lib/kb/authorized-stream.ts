import { type ChildProcess, execFile } from "node:child_process";
import { RateLimiterRes } from "rate-limiter-flexible";
import { isCasSniffMime } from "../sniff-mime";
import { assetValidationContext } from "./asset-authz";
import {
  BLOB_FRAME_BYTES,
  type BlobReader,
  type BlobReadPurpose,
  type BlobStore,
} from "./blob-store";
import { authorizeDocumentRead, isCommitReachable } from "./documents-read";
import { KbDomainError } from "./errors";
import { hardenedGitEnv, kbBareRepoPath } from "./git-read";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import type { LockQuery } from "./lock";
import { parseAssetManifest, validateManifestDocument } from "./manifest";
import type { AuthorizeInput } from "./permissions";

export const ASSET_FRAME_BYTES = BLOB_FRAME_BYTES;
const ASSET_DEADLINE_MS = 120_000;
/** One middleware point per request; remainder is available for disk work. */
export const KB_ASSET_HTTP_WORK_BUDGET = 119;

/** Whole-file verification frames plus response bytes (HEAD delivers none). */
export function assetStreamWorkPoints(
  assetSize: number,
  rangeStart: number,
  rangeEnd: number,
  head = false,
) {
  const verify = Math.ceil(assetSize / ASSET_FRAME_BYTES);
  const deliver = head ? 0 : Math.ceil((rangeEnd - rangeStart + 1) / ASSET_FRAME_BYTES);
  return Math.max(verify, deliver);
}
const unavailable = () => new KbDomainError("STORAGE_UNAVAILABLE", "Asset unavailable");

export class AssetRangeError extends Error {
  constructor(readonly size: number) {
    super("Range not satisfiable");
  }
}

/** No multipart, unsafe integers, empty suffixes or unbounded representation. */
export function assetByteRange(header: string | null, size: number) {
  if (header === null) return { start: 0, end: size - 1, partial: false };
  const match = header.length <= 64 && /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new AssetRangeError(size);
  const left = Number(match[1]);
  const right = Number(match[2]);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new AssetRangeError(size);
  const start = match[1] ? left : Math.max(0, size - right);
  const end = match[1] && match[2] ? Math.min(right, size - 1) : size - 1;
  if ((!match[1] && right === 0) || start >= size || end < start) throw new AssetRangeError(size);
  return { start, end, partial: true };
}

type AssetStreamInput = AuthorizeInput & {
  query: LockQuery;
  reposDir: string;
  blobStore: BlobStore;
  purpose: BlobReadPurpose;
  rev: string;
  hash: string;
  range: string | null;
  head?: boolean;
  signal: AbortSignal;
  isShuttingDown?: () => boolean;
  /** Tests may shorten the deadline; callers cannot extend it. */
  deadlineMs?: number;
  /** Optional extra limiter charge once size/range are known and before CAS I/O. */
  chargeWork?: (points: number) => Promise<void>;
};

/** Bounded, cancellable Git reads avoid the synchronous whole-tree manifest walker.
 * Hardened environment, no hooks/shell/client-selected arguments or config.
 */
async function readAsset(input: AssetStreamInput, signal: AbortSignal) {
  await authorizeDocumentRead(input);
  if (!/^[0-9a-f]{40}$/.test(input.rev))
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid revision");
  const git = (args: string[], maxBuffer = 2 * 1024 * 1024) => {
    signal.throwIfAborted();
    return new Promise<{ stdout: Buffer }>((resolve, reject) => {
      let child: ChildProcess | undefined;
      // execFile's AbortSignal uses SIGTERM on Node 25 even with killSignal set.
      // Own the kill explicitly, and remove the listener only when I/O drains.
      const cancel = () => child?.kill("SIGKILL");
      signal.addEventListener("abort", cancel, { once: true });
      child = execFile(
        "git",
        args,
        {
          cwd: kbBareRepoPath(input.reposDir, input.kbId),
          env: hardenedGitEnv(),
          encoding: "buffer",
          maxBuffer,
        },
        (error, stdout) => {
          signal.removeEventListener("abort", cancel);
          if (error) reject(signal.aborted ? signal.reason : error);
          else resolve({ stdout });
        },
      );
    });
  };
  const reachable = await isCommitReachable(kbBareRepoPath(input.reposDir, input.kbId), input.rev, {
    signal,
  });
  if (!reachable) throw new KbDomainError("NOT_FOUND", "Asset not found");
  const manifestBytes = (await git(["cat-file", "blob", `${input.rev}:.assets/manifest.json`]))
    .stdout;
  const parsed = parseAssetManifest(manifestBytes);
  if ("code" in parsed) throw new KbDomainError("NOT_FOUND", "Asset not found");
  const context = await assetValidationContext(
    input.query,
    input.kbId,
    parsed.entries.map((entry) => entry.hash),
  );
  signal.throwIfAborted();
  if (validateManifestDocument(manifestBytes, { ...context, treePaths: new Map() }))
    throw new KbDomainError("NOT_FOUND", "Asset not found");
  const asset = parsed.entries.find((entry) => entry.hash === input.hash);
  if (!asset) throw new KbDomainError("NOT_FOUND", "Asset not found");
  await authorizeDocumentRead(input);
  return asset;
}

/**
 * Each request owns its inode; verification/delivery use <=256 KiB, no write locks.
 * Zero queued frames; FileHandle.close drains pending I/O, cancellation fences late enqueues.
 */
export async function authorizedAssetStream(input: AssetStreamInput) {
  const abort = new AbortController();
  let file: BlobReader | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  let closing: Promise<void> | undefined;
  const stop = () => abort.abort(new DOMException("Asset request cancelled", "AbortError"));
  const deadlineAt =
    Date.now() + Math.min(input.deadlineMs ?? ASSET_DEADLINE_MS, ASSET_DEADLINE_MS);
  const timer = setTimeout(
    () => abort.abort(new DOMException("Asset deadline exceeded", "TimeoutError")),
    Math.min(input.deadlineMs ?? ASSET_DEADLINE_MS, ASSET_DEADLINE_MS),
  );
  timer.unref();
  const cleanup = () => {
    finished = true;
    clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    abort.signal.removeEventListener("abort", onAbort);
    closing ??= file?.close().catch(() => undefined) ?? Promise.resolve();
    return closing;
  };
  const onAbort = () => {
    controller?.error(abort.signal.reason);
    void cleanup();
  };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  input.signal.addEventListener("abort", stop, { once: true });
  if (input.signal.aborted) stop();
  const check = () => {
    abort.signal.throwIfAborted();
    if (finished || input.isShuttingDown?.()) throw new DOMException("Stream closed", "AbortError");
  };
  const admitted = async <T>(work: () => Promise<T>): Promise<T> => {
    check();
    let rejectAbort: () => void = () => {};
    let workPromise: Promise<T> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      workPromise = work();
      const result = await Promise.race([workPromise, cancelled]);
      check();
      return result;
    } finally {
      abort.signal.removeEventListener("abort", rejectAbort);
      if (abort.signal.aborted) {
        const closing = cleanup();
        if (workPromise && file) {
          await Promise.all([workPromise.catch(() => undefined), closing]);
        }
      }
    }
  };
  try {
    const asset = await admitted(() => readAsset(input, abort.signal));
    if (!isCasSniffMime(asset.mime) || asset.size < 1 || asset.size > CAS_BLOB_MAX_BYTES)
      throw unavailable();
    const range = assetByteRange(input.range, asset.size);
    try {
      await admitted(async () => {
        await input.chargeWork?.(
          assetStreamWorkPoints(asset.size, range.start, range.end, input.head),
        );
      });
      file = await admitted(async () => {
        const handle = await input.blobStore.open({
          hash: input.hash,
          size: asset.size,
          purpose: input.head ? "internal" : input.purpose,
          deadlineAt,
          signal: abort.signal,
        });
        if (finished) {
          await handle.close().catch(() => undefined);
          abort.signal.throwIfAborted();
        }
        return handle;
      });
      check();
      await admitted(() => authorizeDocumentRead(input));
      await admitted(() => file!.preflight(check));
      if (input.head) await admitted(() => file!.complete());
      await admitted(() => authorizeDocumentRead(input));
      let position = range.start;
      const handle = file;
      const body = input.head
        ? null
        : new ReadableStream<Uint8Array>(
            {
              start(value) {
                controller = value;
              },
              async pull(value) {
                try {
                  await admitted(() => authorizeDocumentRead(input));
                  const bytes = await admitted(() =>
                    handle.readFrame(
                      position,
                      Math.min(ASSET_FRAME_BYTES, range.end - position + 1),
                    ),
                  );
                  check();
                  if (bytes.length === 0) throw unavailable();
                  if (position + bytes.length > range.end) await admitted(() => handle.complete());
                  // Final authority check is the last await before emission.
                  await admitted(() => authorizeDocumentRead(input));
                  check();
                  value.enqueue(bytes);
                  if (input.purpose === "download") {
                    try {
                      handle.sampleDownload?.();
                    } catch {
                      // Advisory recency must never affect binary delivery.
                    }
                  }
                  position += bytes.length;
                  if (position > range.end) {
                    value.close();
                    await cleanup();
                  }
                } catch (error) {
                  if (!finished) value.error(error);
                  await cleanup();
                }
              },
              async cancel() {
                stop();
                await cleanup();
              },
            },
            { highWaterMark: 0 },
          );
      if (input.head) await cleanup();
      return { body, asset, range };
    } catch (error) {
      if (error instanceof RateLimiterRes) throw error;
      if (
        error instanceof KbDomainError ||
        (error instanceof Error &&
          "code" in error &&
          ["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN"].includes(String(error.code)))
      )
        throw error;
      if (abort.signal.aborted) throw abort.signal.reason;
      throw unavailable();
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Artifact frames share the zero-prefetch, authorization-before-emission stream boundary.
 * Cancellation joins the current read before reclaiming its private file/quota. */
export type AuthorizedFrame = { bytesBase64: string; nextOffset: number; eof: boolean };

export function authorizedFrameStream(input: {
  signal: AbortSignal;
  isShuttingDown?: () => boolean;
  /** Delivery runs synchronously after the final authority check, inside the EOF transaction. */
  read(offset: number, deliver: (frame: AuthorizedFrame) => void): Promise<unknown>;
  discard(): Promise<void>;
}) {
  let offset = 0;
  let ended = false;
  let eofDelivered = false;
  let pending: Promise<unknown> = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  let failure: Promise<void> | undefined;
  const settled = Promise.withResolvers<void>();
  // Consumers own this result; observe early failures before lifecycle registration.
  void settled.promise.catch(() => undefined);
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = (discard: boolean) => {
    ended = true;
    clearTimeout(timer);
    input.signal.removeEventListener("abort", cancel);
    // Always join the read: its EOF transaction may still be committing after delivery.
    cleanup ??= pending.catch(() => undefined).then(() => (discard ? input.discard() : undefined));
    void cleanup.then(settled.resolve, settled.reject);
    return cleanup;
  };
  const fail = (error: unknown) => {
    failure ??= (async () => {
      try {
        await finish(true);
      } catch (cleanupError) {
        error = cleanupError;
      }
      // No terminal error is visible until read settlement and reclamation finish.
      controller.error(error);
    })();
    return failure;
  };
  const cancel = () => {
    if (!ended) void fail(new DOMException("Transfer cancelled", "AbortError"));
  };
  const timer = setTimeout(cancel, ASSET_DEADLINE_MS);
  timer.unref();
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        input.signal.addEventListener("abort", cancel, { once: true });
        if (input.signal.aborted) cancel();
      },
      async pull(value) {
        try {
          if (ended || input.isShuttingDown?.())
            throw new DOMException("Transfer closed", "AbortError");
          const read = input.read(offset, (frame) => {
            if (ended || input.signal.aborted || input.isShuttingDown?.())
              throw new DOMException("Transfer closed", "AbortError");
            value.enqueue(Buffer.from(frame.bytesBase64, "base64"));
            offset = frame.nextOffset;
            eofDelivered = frame.eof;
          });
          // Track settlement only, never retain a frame's base64 string between pulls.
          pending = read.then(
            () => undefined,
            () => undefined,
          );
          await read;
          if (ended) return;
          if (eofDelivered) {
            await finish(false);
            value.close();
          }
        } catch (error) {
          await fail(error);
        }
      },
      cancel() {
        return finish(true);
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    done: settled.promise,
    stop: () =>
      ended
        ? (cleanup ?? Promise.resolve())
        : fail(new DOMException("Transfer closed", "AbortError")),
  };
}
