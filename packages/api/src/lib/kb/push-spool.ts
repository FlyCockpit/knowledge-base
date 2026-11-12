import { randomUUID } from "node:crypto";
import { constants, readdirSync, unlinkSync } from "node:fs";
import { type FileHandle, lstat, open, opendir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { closePrivateTmpChain, openPrivateTmpDir, procChild } from "./cas-fd";

export const PUSH_MAX_BYTES = 50 * 1024 * 1024;
// Shared by every spooler in this server. Register before async creation and keep
// ownership until disposal finishes; a sweep must never race an open or reader.
const liveSpools = new Map<string, Set<string>>();
// Exactly the names createPushSpooler generates (`git-${randomUUID()}`, UUIDv4).
const SPOOL_NAME = /^git-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Startup only, before HTTP admission. The native server volume fence excludes
 * a live predecessor (and its inherited children), so every generated spool is
 * abandoned. Periodic recovery must use sweepAbandonedPushSpools, which excludes
 * this process's live uploads through the in-memory ownership registry. */
export async function recoverPushSpools(root: string, assertFence: () => void): Promise<void> {
  assertFence();
  const chain = openPrivateTmpDir(root);
  try {
    const entries = await opendir(`/proc/self/fd/${chain.tmpFd}`);
    for await (const entry of entries) {
      if (!SPOOL_NAME.test(entry.name)) continue;
      const path = procChild(chain.tmpFd, entry.name);
      const stat = await lstat(path);
      if (!stat.isFile()) throw new Error("Git spool recovery requires a regular file");
      assertFence();
      // unlink is relative to the pinned no-follow chain and never follows a leaf.
      await unlink(path);
    }
  } finally {
    closePrivateTmpChain(chain);
  }
}

/** Server-only startup/periodic recovery, after acquiring the drained volume fence.
 * Synchronous inventory and unlink cannot interleave with spool registration.
 * Unlink only our exact filenames through the pinned no-follow directory chain. */
export function sweepAbandonedPushSpools(root: string, assertFence: () => void): void {
  assertFence();
  const chain = openPrivateTmpDir(root);
  try {
    const live = liveSpools.get(resolve(root));
    for (const name of readdirSync(`/proc/self/fd/${chain.tmpFd}`)) {
      if (SPOOL_NAME.test(name) && !live?.has(name)) unlinkSync(procChild(chain.tmpFd, name));
    }
  } finally {
    closePrivateTmpChain(chain);
  }
}
export class PushSpoolError extends Error {
  constructor(
    readonly status: 400 | 408 | 413 | 429,
    message: string,
  ) {
    super(message);
  }
}
/** Process-local ownership is sufficient under the single-server volume fence.
 * No authority/KB lock is acquired here. The permit lasts through disposal, including
 * failure and pending file I/O; consumers must dispose in their final drain path. */
export function createPushSpooler(options: {
  root: string;
  maxBytes?: number;
  totalMs?: number;
  idleMs?: number;
}) {
  let total = 0;
  const users = new Map<string, number>();
  const root = resolve(options.root);
  return {
    get outstanding() {
      return total;
    },
    async spool(request: Request, userId: string) {
      const count = users.get(userId) ?? 0;
      if (count >= 2 || total >= 4) throw new PushSpoolError(429, "UPLOAD_QUOTA_EXCEEDED");
      users.set(userId, count + 1);
      total++;
      let chain: ReturnType<typeof openPrivateTmpDir> | undefined;
      let file: FileHandle | undefined;
      let path: string | undefined;
      let spoolName: string | undefined;
      let disposal: Promise<void> | undefined;
      const dispose = () =>
        (disposal ??= (async () => {
          try {
            await file?.close();
            if (path) await unlink(path);
          } finally {
            if (spoolName) {
              const live = liveSpools.get(root);
              live?.delete(spoolName);
              if (!live?.size) liveSpools.delete(root);
            }
            if (chain) closePrivateTmpChain(chain);
            total--;
            const left = (users.get(userId) ?? 1) - 1;
            if (left) users.set(userId, left);
            else users.delete(userId);
          }
        })());
      const abort = new AbortController();
      const cancel = () => abort.abort(new PushSpoolError(408, "UPLOAD_CANCELLED"));
      const timeout = () => abort.abort(new PushSpoolError(408, "UPLOAD_TIMEOUT"));
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) cancel();
      const timer = setTimeout(timeout, Math.min(options.totalMs ?? 120000, 120000));
      let idle = setTimeout(timeout, Math.min(options.idleMs ?? 10000, 10000));
      const reader = request.body?.getReader();
      let rejectAbort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => {
          void reader?.cancel().catch(() => {});
          reject(abort.signal.reason);
        };
        abort.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      void cancelled.catch(() => {});
      try {
        abort.signal.throwIfAborted();
        chain = openPrivateTmpDir(options.root);
        const candidate = `git-${randomUUID()}`;
        let live = liveSpools.get(root);
        if (!live) {
          live = new Set();
          liveSpools.set(root, live);
        }
        // A rejected duplicate must not release the first request's ownership.
        if (live.has(candidate)) throw new Error("SPOOL_NAME_CONFLICT");
        spoolName = candidate;
        live.add(spoolName);
        const name = procChild(chain.tmpFd, spoolName);
        file = await open(
          name,
          constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR,
          0o600,
        );
        path = name;
        const max = Math.min(options.maxBytes ?? PUSH_MAX_BYTES, PUSH_MAX_BYTES);
        const declared = request.headers.get("content-length");
        if (declared !== null && !/^\d{1,16}$/.test(declared))
          throw new PushSpoolError(400, "INVALID_LENGTH");
        if (declared !== null && Number(declared) > max)
          throw new PushSpoolError(413, "UPLOAD_TOO_LARGE");
        let size = 0;
        while (reader) {
          abort.signal.throwIfAborted();
          const chunk = await Promise.race([reader.read(), cancelled]);
          abort.signal.throwIfAborted();
          if (chunk.done) break;
          if (!chunk.value.byteLength) continue;
          if (size + chunk.value.byteLength > max)
            throw new PushSpoolError(413, "UPLOAD_TOO_LARGE");
          clearTimeout(idle);
          idle = setTimeout(timeout, Math.min(options.idleMs ?? 10000, 10000));
          for (let offset = 0; offset < chunk.value.byteLength; ) {
            const { bytesWritten } = await file.write(
              chunk.value,
              offset,
              chunk.value.byteLength - offset,
              size,
            );
            abort.signal.throwIfAborted();
            if (!bytesWritten) throw new Error("Spool write failed");
            offset += bytesWritten;
            size += bytesWritten;
          }
        }
        if (declared !== null && Number(declared) !== size)
          throw new PushSpoolError(400, "INVALID_LENGTH");
        return { file, size, dispose };
      } catch (error) {
        void reader?.cancel().catch(() => {});
        await dispose();
        throw error;
      } finally {
        clearTimeout(timer);
        clearTimeout(idle);
        request.signal.removeEventListener("abort", cancel);
        abort.signal.removeEventListener("abort", rejectAbort);
      }
    },
  };
}
