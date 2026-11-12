import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOB_FRAME_BYTES } from "./blob-store";
import { casBlobPath, createDiskBlobStore, offlineDiskBytes } from "./blob-store-disk";
import { publishCasBytes } from "./cas";
import { minimalPng, sha256Buffer } from "./fixtures/media-bytes";

// Disk mode must never construct an S3 client, even when storage is exercised.
vi.mock("@aws-sdk/client-s3", () => {
  throw new Error("Disk storage loaded the S3 SDK");
});

const io = vi.hoisted(() => ({ failSync: "", synced: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync(fd: number) {
      const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
      io.synced.push(path);
      if (path === io.failSync)
        throw Object.assign(new Error("injected fsync EIO"), { code: "EIO" });
      fs.fsyncSync(fd);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  io.failSync = "";
  io.synced = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(bytes = minimalPng()) {
  const assetsDir = mkdtempSync(join(tmpdir(), "kb-blob-store-"));
  roots.push(assetsDir);
  const hash = sha256Buffer(bytes);
  const blobStore = createDiskBlobStore(assetsDir);
  const signal = new AbortController().signal;
  return { assetsDir, bytes, hash, blobStore, signal, size: bytes.length };
}
function seed(f: ReturnType<typeof fixture>) {
  const path = casBlobPath(f.assetsDir, f.hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, f.bytes);
  return path;
}

describe("disk blob-store ownership", () => {
  it("constructs without IO and never materializes paths on a missing read", async () => {
    const f = fixture();
    const missing = join(f.assetsDir, "missing");
    const store = createDiskBlobStore(missing);
    expect(existsSync(missing)).toBe(false);
    await expect(store.open({ ...f, purpose: "download" })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(existsSync(missing)).toBe(false);
  });

  it("publishes through the injected boundary with no public pathname", async () => {
    const f = fixture();
    const publish = vi.spyOn(f.blobStore, "publishVerified");
    const result = await publishCasBytes({
      blobStore: f.blobStore,
      declaredHash: f.hash,
      declaredSize: f.size,
      declaredMime: "image/png",
      bytes: f.bytes,
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hash: f.hash,
      size: f.size,
      mime: "image/png",
      durability: { backend: "disk", newBytes: true },
    });
    expect(result).not.toHaveProperty("path");
    expect(readFileSync(casBlobPath(f.assetsDir, f.hash))).toEqual(f.bytes);
  });

  it.each(["download", "internal"] as const)(
    "owns bounded, fully verified %s reads and idempotent close",
    async (purpose) => {
      const f = fixture(Buffer.alloc(BLOB_FRAME_BYTES + 3, 0x61));
      seed(f);
      const reader = await f.blobStore.open({ ...f, purpose });
      expect(reader.verified).toBe(false);
      expect(reader).not.toHaveProperty("path");
      await expect(reader.readFrame(0, 1)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await expect(reader.complete()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      await reader.preflight();
      expect(reader.verified).toBe(true);
      expect(await reader.readFrame(0, BLOB_FRAME_BYTES)).toEqual(
        f.bytes.subarray(0, BLOB_FRAME_BYTES),
      );
      expect(await reader.readFrame(BLOB_FRAME_BYTES, 3)).toEqual(
        f.bytes.subarray(BLOB_FRAME_BYTES),
      );
      await expect(reader.readFrame(0, BLOB_FRAME_BYTES + 1)).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
      await expect(reader.readFrame(f.size, 1)).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
      await reader.complete();
      const closed = reader.close();
      expect(reader.close()).toBe(closed);
      await closed;
      await expect(reader.readFrame(0, 1)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    },
  );

  it("checks caller admission between verification frames and closes on interruption", async () => {
    const f = fixture(Buffer.alloc(BLOB_FRAME_BYTES * 3, 0x61));
    seed(f);
    const reader = await f.blobStore.open({ ...f, purpose: "download" });
    let checks = 0;
    const shutdown = new DOMException("Shutting down", "AbortError");
    try {
      await expect(
        reader.preflight(() => {
          if (++checks === 3) throw shutdown;
        }),
      ).rejects.toBe(shutdown);
      expect(checks).toBe(3);
      expect(reader.verified).toBe(false);
    } finally {
      await reader.close();
    }
  });

  it("checks all bytes for an internal durability assertion and detects same-size corruption", async () => {
    const f = fixture();
    const path = seed(f);
    await f.blobStore.assertDurable(f);
    writeFileSync(path, Buffer.alloc(f.size));
    await expect(f.blobStore.assertDurable(f)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it.each(["file", "shard", "objects", "assets"])(
    "reestablishes offline publication durability after a hardlink survives failed %s fsync",
    async (failedBarrier) => {
      const f = fixture();
      const path = casBlobPath(f.assetsDir, f.hash);
      const barriers = [path, dirname(path), dirname(dirname(path)), f.assetsDir];
      // Publication created its canonical hardlink, then the shard barrier failed.
      io.failSync = dirname(path);
      await expect(
        f.blobStore.publishVerified({
          declaredHash: f.hash,
          declaredSize: f.size,
          declaredMime: "image/png",
          bytes: f.bytes,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(readFileSync(path)).toEqual(f.bytes);
      const work = vi.fn();
      io.failSync = barriers[["file", "shard", "objects", "assets"].indexOf(failedBarrier)]!;
      await expect(offlineDiskBytes(f.assetsDir, f, work)).rejects.toThrow("injected fsync EIO");
      expect(work).not.toHaveBeenCalled();
      io.failSync = "";
      io.synced = [];
      await offlineDiskBytes(f.assetsDir, f, work);
      expect(io.synced).toEqual(barriers);
      expect(work).toHaveBeenCalledOnce();
    },
  );

  it("rechecks the verified inode at completion and fences canceled reads", async () => {
    const f = fixture();
    const path = seed(f);
    const abort = new AbortController();
    const reader = await f.blobStore.open({ ...f, signal: abort.signal, purpose: "download" });
    try {
      await reader.preflight();
      writeFileSync(path, f.bytes);
      await expect(reader.complete()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      abort.abort();
      await expect(reader.readFrame(0, 1)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await reader.close();
    }
  });
});
