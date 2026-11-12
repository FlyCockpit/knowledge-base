import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  read,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { type FileHandle, open, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertPathInside, tempRoot } from "@knowledge-base/env/topology";
import { validateCasMediaBytes } from "../sniff-mime";
import type { BlobPublishInput, BlobReader, BlobStore, PublishedCasBlob } from "./blob-store";
import { BLOB_FRAME_BYTES } from "./blob-store";
import { parseCasHash } from "./cas";
import {
  closeCasDirChain,
  closePrivateTmpChain,
  fsyncCasPublishBarriers,
  openCasShardDir,
  openPrivateTmpDir,
  procChild,
} from "./cas-fd";
import { KbDomainError } from "./errors";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import { KbAdmissionError } from "./principal";

const readFd = promisify(read);

async function nextCasChunk(
  iterator: AsyncIterator<Buffer>,
  signal?: AbortSignal,
): Promise<IteratorResult<Buffer>> {
  signal?.throwIfAborted();
  if (!signal) return iterator.next();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function casObjectsRoot(assetsDir: string): string {
  return join(resolve(assetsDir), "objects");
}

export function casBlobPath(assetsDir: string, hash: string): string {
  const hex = parseCasHash(hash);
  const root = casObjectsRoot(assetsDir);
  const shard = hex.slice(0, 2);
  const leaf = hex.slice(2);
  const path = join(root, shard, leaf);
  assertPathInside(resolve(assetsDir), path);
  return path;
}

export function assertCasTempPath(assetsDir: string, tempPath: string): string {
  const tmpRoot = tempRoot(assetsDir);
  return assertPathInside(tmpRoot, resolve(tempPath));
}

function writeAllSync(fd: number, body: Buffer): void {
  let offset = 0;
  while (offset < body.length) {
    const written = writeSync(fd, body, offset, body.length - offset);
    if (written <= 0) {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS temp write failed");
    }
    offset += written;
  }
}

type BlobFingerprint = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

/** Hashes the actual temp bytes while retaining the descriptor/name fingerprint. */
function verifyTempBlob(
  fd: number,
  path: string | undefined,
  body: Buffer,
  hash: string,
  expected: BlobFingerprint,
): void {
  assertUnchangedBlob(fd, path, expected);
  let offset = 0;
  while (offset < body.length) {
    const read = readSync(fd, body, offset, body.length - offset, offset);
    if (read <= 0) {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS temp read failed");
    }
    offset += read;
  }
  if (`sha256:${createHash("sha256").update(body).digest("hex")}` !== hash) {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS temp hash mismatch");
  }
  assertUnchangedBlob(fd, path, expected);
}

function assertUnchangedBlob(
  fd: number,
  path: string | undefined,
  expected: BlobFingerprint,
): void {
  let stats: BigIntStats[];
  try {
    stats = [fstatSync(fd, { bigint: true })];
    if (path !== undefined) stats.push(lstatSync(path, { bigint: true }));
  } catch {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS blob unavailable");
  }
  for (const stat of stats) {
    if (
      !stat.isFile() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      stat.size !== expected.size ||
      stat.mtimeNs !== expected.mtimeNs ||
      stat.ctimeNs !== expected.ctimeNs
    ) {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS destination changed");
    }
  }
}

async function verifyExistingBlob(fd: number, hash: string, size: number): Promise<BigIntStats> {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.size !== BigInt(size)) {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Existing blob size or type mismatch");
  }
  const hasher = createHash("sha256");
  const buffer = Buffer.alloc(256 * 1024);
  let offset = 0;
  // Read to EOF, including a probe beyond the declared length. An append must
  // fail, rather than silently hashing only a previously checked prefix.
  for (;;) {
    const { bytesRead } = await readFd(fd, buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (offset > size) {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Existing blob grew during verification");
    }
    hasher.update(buffer.subarray(0, bytesRead));
  }
  if (offset !== size || `sha256:${hasher.digest("hex")}` !== hash) {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Existing blob hash mismatch");
  }
  return before;
}

/**
 * Stream, hash, sniff and durably publish immutable CAS bytes. The temp file
 * descriptor and the pinned private-tmp directory chain stay open for the
 * whole operation: sniffing reads through the descriptor, the hard-link
 * source and cleanup resolve through the pinned temp directory with an inode
 * identity check against the written file, and the destination chain is
 * opened inside the same cleanup scope. Catalog is separate.
 */
export async function withVerifiedCasPublication(
  assetsDir: string,
  input: BlobPublishInput,
  publish?: (content: {
    body: Buffer;
    hash: string;
    size: number;
    mime: PublishedCasBlob["mime"];
  }) => Promise<PublishedCasBlob>,
  offlineScratchName?: string,
): Promise<PublishedCasBlob> {
  input.signal?.throwIfAborted();
  if (
    !Number.isInteger(input.declaredSize) ||
    input.declaredSize < 1 ||
    input.declaredSize > CAS_BLOB_MAX_BYTES
  ) {
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid declared size");
  }
  const hex = parseCasHash(input.declaredHash);
  const shard = hex.slice(0, 2);
  const leaf = hex.slice(2);

  const tmpChain = openPrivateTmpDir(assetsDir);
  let tempFd: number | undefined;
  let tempLeaf: string | undefined;
  let created: { ino: bigint; dev: bigint } | undefined;
  // Established right after the O_EXCL create and executed on every exit
  // path after that (rejection, stream failure, crash between file and link):
  // rejected uploads must not leave unaccounted bytes on the assets volume.
  // Cleanup resolves through the pinned temp directory and only removes the
  // exact inode we created; a replaced name is left alone.
  const cleanupTemp = () => {
    if (tempLeaf === undefined || created === undefined) return;
    try {
      const st = lstatSync(tempLeaf, { bigint: true });
      if (st.isFile() && st.ino === created.ino && st.dev === created.dev) {
        unlinkSync(tempLeaf);
      }
    } catch {
      // Best-effort temp cleanup.
    }
  };
  try {
    if (
      offlineScratchName !== undefined &&
      !/^migration-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        offlineScratchName,
      )
    )
      throw diskUnavailable();
    const tempName = offlineScratchName ?? `cas-${randomUUID()}`;
    // Lexical jail for the generated name; all I/O below resolves through pinned fds.
    assertCasTempPath(assetsDir, join(tempRoot(assetsDir), tempName));
    try {
      tempFd = openSync(
        procChild(tmpChain.tmpFd, tempName),
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Temp path collision");
      }
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Temp create failed");
    }
    tempLeaf = procChild(tmpChain.tmpFd, tempName);
    created = fstatSync(tempFd, { bigint: true });

    const hasher = createHash("sha256");
    let size = 0;
    const absorb = (chunk: Buffer) => {
      input.signal?.throwIfAborted();
      if (size + chunk.length > CAS_BLOB_MAX_BYTES) {
        throw new KbDomainError("INVALID_ARGUMENT", "Asset exceeds maximum size");
      }
      if (size + chunk.length > input.declaredSize) {
        throw new KbDomainError("INVALID_ARGUMENT", "Size mismatch");
      }
      const copy = Buffer.from(chunk);
      hasher.update(copy);
      writeAllSync(tempFd!, copy);
      size += copy.length;
    };

    if (Buffer.isBuffer(input.bytes)) {
      absorb(input.bytes);
    } else {
      const iterator = input.bytes[Symbol.asyncIterator]();
      let done = false;
      try {
        for (;;) {
          const next = await nextCasChunk(iterator, input.signal);
          if (next.done) {
            done = true;
            break;
          }
          absorb(next.value);
        }
      } finally {
        // A producer may ignore cancellation forever. Its late result has no
        // writer callback; do not retain our descriptors/gate waiting for it.
        if (!done) void iterator.return?.().catch(() => undefined);
      }
    }

    input.signal?.throwIfAborted();

    if (size !== input.declaredSize) {
      throw new KbDomainError("INVALID_ARGUMENT", "Size mismatch");
    }

    const hash = `sha256:${hasher.digest("hex")}`;
    if (hash !== input.declaredHash) {
      throw new KbDomainError("INVALID_ARGUMENT", "Content hash mismatch");
    }

    fsyncSync(tempFd);
    const tempStat = fstatSync(tempFd, { bigint: true });
    if (tempStat.size !== BigInt(size)) {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS temp verification failed");
    }
    if (tempStat.ino !== created.ino || tempStat.dev !== created.dev) {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS temp identity changed");
    }

    const body = Buffer.alloc(size);
    verifyTempBlob(tempFd, tempLeaf, body, hash, tempStat);
    const sniff = validateCasMediaBytes(body, input.declaredMime);
    if (!sniff.ok) {
      throw new KbDomainError("INVALID_ARGUMENT", "Untrusted media content");
    }

    if (publish) {
      // Remote publication needs verified bytes, never a persistent scratch
      // pathname. Unlink before external IO; the pinned descriptor and caller's
      // disk reservation retain ownership until close. Process death now reclaims
      // scratch automatically instead of leaving an untracked cas-* orphan.
      assertUnchangedBlob(tempFd, tempLeaf, tempStat);
      unlinkSync(tempLeaf);
      fsyncSync(tmpChain.tmpFd);
      fsyncSync(tmpChain.privateFd);
      fsyncSync(tmpChain.assetsFd);
      tempLeaf = undefined;
      created = undefined;
      const unlinked = fstatSync(tempFd, { bigint: true });
      const anonymous = { ...tempStat, ctimeNs: unlinked.ctimeNs };
      if (unlinked.nlink !== 0n)
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS scratch has unexpected aliases");
      // Unlink changes ctime only. Rehash across that transition, preserving
      // the original inode, size and mtime, just as disk hard-link publication does.
      verifyTempBlob(tempFd, undefined, body, hash, anonymous);
      const result = await publish({ body, hash, size, mime: sniff.mime });
      input.signal?.throwIfAborted();
      const after = fstatSync(tempFd, { bigint: true });
      if (after.nlink !== 0n)
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS scratch has unexpected aliases");
      assertUnchangedBlob(tempFd, undefined, anonymous);
      return result;
    }

    const chain = openCasShardDir(assetsDir, shard, leaf);
    let newBytes = false;
    let existingFd: number | undefined;
    try {
      let verified: BlobFingerprint = tempStat;
      assertUnchangedBlob(tempFd, tempLeaf, verified);
      try {
        linkSync(tempLeaf, chain.leafPath);
        newBytes = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          existingFd = openSync(
            chain.leafPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          verified = await verifyExistingBlob(existingFd, hash, size);
        } else {
          throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS publish failed");
        }
      }
      if (newBytes) {
        // Linking changes ctime, but must not re-baseline identity, size or mtime.
        // Rehash across this boundary as well: a concurrent rewrite with restored
        // mtime must not hide behind the link's expected ctime change. Reuse the
        // bounded sniff buffer and keep the descriptor pinned throughout.
        verified = { ...verified, ctimeNs: fstatSync(tempFd, { bigint: true }).ctimeNs };
        verifyTempBlob(tempFd, chain.leafPath, body, hash, verified);
      }
      const verifiedFd = existingFd ?? tempFd;
      assertUnchangedBlob(verifiedFd, chain.leafPath, verified);
      fsyncCasPublishBarriers(chain, verifiedFd);
      if (input.afterDurableBytes) await input.afterDurableBytes();
      input.signal?.throwIfAborted();
      assertUnchangedBlob(verifiedFd, chain.leafPath, verified);
    } catch (error) {
      if (error instanceof KbAdmissionError) throw error;
      if (error instanceof Error && "code" in error) {
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS publication verification failed");
      }
      throw error;
    } finally {
      if (existingFd !== undefined) closeSync(existingFd);
      closeCasDirChain(chain);
    }

    return {
      hash,
      size,
      mime: sniff.mime,
      durability: { backend: "disk", newBytes },
    };
  } finally {
    cleanupTemp();
    if (tempFd !== undefined) {
      closeSync(tempFd);
      tempFd = undefined;
    }
    closePrivateTmpChain(tmpChain);
  }
}

export function casInode(path: string): number {
  return lstatSync(path).ino;
}

const diskUnavailable = () => new KbDomainError("STORAGE_UNAVAILABLE", "Asset unavailable");

/** Existing directories only: asset reads never materialize missing CAS paths. */
async function openBlob(assetsDir: string, hash: string): Promise<FileHandle> {
  const hex = parseCasHash(hash);
  const dirs: FileHandle[] = [];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let dir = await open(resolve(assetsDir), flags);
    dirs.push(dir);
    for (const part of ["objects", hex.slice(0, 2)]) {
      dir = await open(procChild(dir.fd, part), flags);
      dirs.push(dir);
    }
    return await open(
      procChild(dir.fd, hex.slice(2)),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } finally {
    for (const dir of dirs.reverse()) await dir.close();
  }
}

function unchanged(before: BigIntStats, after: BigIntStats): void {
  if (
    !after.isFile() ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw diskUnavailable();
}

/** Disk is authoritative; neither construction nor attachment creates directories. */
export function createDiskBlobStore(assetsDir: string, offlineScratchName?: string): BlobStore {
  const openReader: BlobStore["open"] = async (input) => {
    input.signal.throwIfAborted();
    parseCasHash(input.hash);
    if (!Number.isInteger(input.size) || input.size < 1 || input.size > CAS_BLOB_MAX_BYTES)
      throw diskUnavailable();
    const file = await openBlob(assetsDir, input.hash);
    let closing: Promise<void> | undefined;
    let verified = false;
    const check = () => {
      input.signal.throwIfAborted();
      if (closing) throw diskUnavailable();
    };
    const close = () => (closing ??= file.close());
    try {
      check();
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(input.size)) throw diskUnavailable();
      check();
      const reader: BlobReader = {
        get verified() {
          return verified;
        },
        async preflight(checkActive) {
          check();
          checkActive?.();
          const buffer = Buffer.alloc(Math.min(BLOB_FRAME_BYTES, input.size));
          const hasher = createHash("sha256");
          for (let offset = 0; offset < input.size; ) {
            check();
            checkActive?.();
            const { bytesRead } = await file.read(
              buffer,
              0,
              Math.min(buffer.length, input.size - offset),
              offset,
            );
            check();
            checkActive?.();
            if (bytesRead === 0) throw diskUnavailable();
            hasher.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
          if (`sha256:${hasher.digest("hex")}` !== input.hash) throw diskUnavailable();
          unchanged(before, await file.stat({ bigint: true }));
          check();
          verified = true;
        },
        async readFrame(offset, length) {
          check();
          if (
            !verified ||
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > BLOB_FRAME_BYTES ||
            offset + length > input.size
          )
            throw diskUnavailable();
          const bytes = Buffer.alloc(length);
          const { bytesRead } = await file.read(bytes, 0, length, offset);
          check();
          if (bytesRead === 0) throw diskUnavailable();
          unchanged(before, await file.stat({ bigint: true }));
          check();
          return bytes.subarray(0, bytesRead);
        },
        async complete() {
          check();
          if (!verified) throw diskUnavailable();
          unchanged(before, await file.stat({ bigint: true }));
          check();
        },
        close,
      };
      return reader;
    } catch (error) {
      await close();
      throw error;
    }
  };
  return {
    backend: "disk",
    publishVerified: (input) =>
      withVerifiedCasPublication(assetsDir, input, undefined, offlineScratchName),
    open: openReader,
    async assertDurable(input) {
      const reader = await openReader({ ...input, purpose: "internal" });
      try {
        await reader.preflight();
        await reader.complete();
      } finally {
        await reader.close();
      }
    },
  };
}

/** Bounded directory cursors, including valid catalog-free disk orphans. */
export async function* offlineDiskInventory(
  assetsDir: string,
  signal?: AbortSignal,
): AsyncGenerator<OfflineDiskInventoryRow> {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const assets = await open(assetsDir, flags);
  try {
    let objects: FileHandle;
    try {
      objects = await open(`/proc/self/fd/${assets.fd}/objects`, flags);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    try {
      for await (const shard of await opendir(`/proc/self/fd/${objects.fd}`)) {
        signal?.throwIfAborted();
        if (!/^[a-f0-9]{2}$/.test(shard.name) || !shard.isDirectory()) throw diskUnavailable();
        const dir = await open(`/proc/self/fd/${objects.fd}/${shard.name}`, flags);
        try {
          for await (const leaf of await opendir(`/proc/self/fd/${dir.fd}`)) {
            signal?.throwIfAborted();
            if (!/^[a-f0-9]{62}$/.test(leaf.name) || !leaf.isFile()) throw diskUnavailable();
            const f = await open(
              `/proc/self/fd/${dir.fd}/${leaf.name}`,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            let size: number;
            try {
              size = (await f.stat()).size;
            } finally {
              await f.close();
            }
            const row = checkOfflineDiskInventoryRow({
              hash: `sha256:${shard.name}${leaf.name}`,
              size,
            });
            await offlineDiskBytes(assetsDir, row, () => {}, signal);
            yield row;
          }
        } finally {
          await dir.close();
        }
      }
    } finally {
      await objects.close();
    }
  } finally {
    await assets.close();
  }
}

/** Offline verification is also a publication barrier: a surviving hardlink
 * after an interrupted publish is not proof of durability. Keep the verified
 * inode and full directory chain pinned through fsync and the callback. */
export async function offlineDiskBytes<T>(
  assetsDir: string,
  row: OfflineDiskInventoryRow,
  work: (body: Buffer, remove: () => void) => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  checkOfflineDiskInventoryRow(row);
  const hex = parseCasHash(row.hash);
  const chain = openCasShardDir(assetsDir, hex.slice(0, 2), hex.slice(2));
  let fd: number | undefined;
  try {
    fd = openSync(chain.leafPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(row.size) || before.nlink !== 1n)
      throw diskUnavailable();
    const unchanged = () => {
      for (const st of [
        fstatSync(fd!, { bigint: true }),
        lstatSync(chain.leafPath, { bigint: true }),
      ])
        if (
          !st.isFile() ||
          st.dev !== before.dev ||
          st.ino !== before.ino ||
          st.size !== before.size ||
          st.mtimeNs !== before.mtimeNs ||
          st.ctimeNs !== before.ctimeNs ||
          st.nlink !== 1n
        )
          throw diskUnavailable();
    };
    const body = Buffer.alloc(row.size);
    for (let at = 0; at < body.length; ) {
      signal?.throwIfAborted();
      const n = readSync(fd, body, at, Math.min(BLOB_FRAME_BYTES, body.length - at), at);
      if (!n) throw diskUnavailable();
      at += n;
    }
    if (`sha256:${createHash("sha256").update(body).digest("hex")}` !== row.hash)
      throw diskUnavailable();
    unchanged();
    signal?.throwIfAborted();
    fsyncCasPublishBarriers(chain, fd);
    unchanged();
    return await work(body, () => {
      unchanged();
      unlinkSync(chain.leafPath);
      // A retry after unlink still synchronizes all directories separately.
      fsyncCasPublishBarriers(chain, fd!);
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeCasDirChain(chain);
  }
}

export async function removeOfflineDiskObject(
  assetsDir: string,
  row: OfflineDiskInventoryRow,
  signal?: AbortSignal,
) {
  try {
    await offlineDiskBytes(assetsDir, row, (_body, remove) => remove(), signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const hex = parseCasHash(row.hash),
      chain = openCasShardDir(assetsDir, hex.slice(0, 2), hex.slice(2));
    try {
      fsyncSync(chain.shardFd);
      fsyncSync(chain.objectsFd);
      fsyncSync(chain.assetsFd);
    } finally {
      closeCasDirChain(chain);
    }
  }
}

type OfflineDiskInventoryRow = { hash: string; size: number };
function checkOfflineDiskInventoryRow(row: OfflineDiskInventoryRow): OfflineDiskInventoryRow {
  parseCasHash(row.hash);
  if (!Number.isSafeInteger(row.size) || row.size < 1 || row.size > CAS_BLOB_MAX_BYTES)
    throw diskUnavailable();
  return row;
}
