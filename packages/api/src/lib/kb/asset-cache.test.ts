import { createHash, randomUUID } from "node:crypto";
import { fstatSync, readSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetCache } from "./asset-cache";
import { createAssetStorageLifecycle } from "./asset-storage-lifecycle";
import type { AssetCacheTransactions, CacheEntry } from "./asset-storage-state";
import { BLOB_FRAME_BYTES } from "./blob-store";

const reads = vi.hoisted(() => ({
  pause: undefined as (() => Promise<void>) | undefined,
  calls: 0,
  fd: -1,
  fault: undefined as "hash" | "fingerprint" | "truncated" | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readSync: vi.fn(fs.readSync),
    fstatSync(fd: number, options?: { bigint?: boolean }) {
      if (!options?.bigint) return fs.fstatSync(fd);
      const stats = fs.fstatSync(fd, { bigint: true });
      if (reads.fault === "fingerprint") stats.mtimeNs += 1n;
      return stats;
    },
    read<T extends NodeJS.ArrayBufferView>(
      fd: number,
      buffer: T,
      offset: number,
      length: number,
      position: number | null,
      callback: (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: T) => void,
    ) {
      reads.calls++;
      reads.fd = fd;
      void (reads.pause?.() ?? Promise.resolve()).then(() => {
        fs.read(fd, buffer, offset, length, position, (error, bytesRead, result) => {
          // Inject reader faults without modifying the immutable cache payload.
          if (!error && position !== null && position > 0) {
            if (reads.fault === "truncated") bytesRead = 0;
            if (reads.fault === "hash" && bytesRead > 0) {
              const bytes = Buffer.from(result.buffer, result.byteOffset, result.byteLength);
              bytes[offset + bytesRead - 1] ^= 1;
            }
          }
          callback(error, bytesRead, result);
        });
      });
    },
  };
});

describe("cache reader async preflight", () => {
  let fixture: Awaited<ReturnType<typeof setup>> | undefined;

  async function setup() {
    const assetsDir = await mkdtemp(join(tmpdir(), "kb-cache-preflight-"));
    const life = createAssetStorageLifecycle("SERVER");
    const bytes = Buffer.alloc(BLOB_FRAME_BYTES + 17, 42);
    const hex = createHash("sha256").update(bytes).digest("hex");
    const hash = `sha256:${hex}`;
    const root = await stat(assetsDir, { bigint: true });
    const binding = {
      cacheId: `volume:${root.dev}:${root.ino}`,
      volumeId: "volume",
      storageGeneration: randomUUID(),
      configuration: "fixture",
      limit: 26214400n,
    };
    const incarnation = randomUUID();
    const entry: CacheEntry = {
      cacheId: binding.cacheId,
      hash,
      incarnation,
      size: bytes.length,
      state: "FILLING",
      fillOwner: "fixture",
      tempName: `cache-${incarnation}`,
      device: null,
      inode: null,
      mtimeNs: null,
      ctimeNs: null,
      finalAlias: false,
      tempDirectory: null,
      finalDirectory: null,
      cleanupAttempt: null,
      cleanupOwner: null,
      quotaReservations: [],
      lastFetchSequence: "0",
    };
    const transactions: AssetCacheTransactions = vi.fn(async () => {
      throw new Error("Unexpected database IO");
    });
    const cache = createAssetCache({
      assetsDir,
      binding,
      transactions,
      lifecycle: life,
      meter: { freeBytes: async () => 100000000000n },
    });
    const pin = { id: randomUUID(), entry };
    vi.spyOn(cache.state, "reserve").mockResolvedValue(pin);
    vi.spyOn(cache.state, "recordFile").mockImplementation(async (_, identity, directory) => {
      Object.assign(entry, identity, { tempDirectory: directory });
    });
    vi.spyOn(cache.state, "beforeLink").mockImplementation(async (_, directory) => {
      Object.assign(entry, { finalAlias: true, finalDirectory: directory });
    });
    vi.spyOn(cache.state, "ready").mockImplementation(async (_, identity) => {
      Object.assign(entry, identity, { state: "READY" });
    });
    vi.spyOn(cache.state, "acquire").mockResolvedValue(pin);
    vi.spyOn(cache.state, "isReady").mockResolvedValue(true);
    vi.spyOn(cache.state, "invalidate").mockResolvedValue(undefined);
    vi.spyOn(cache.state, "release").mockResolvedValue(undefined);
    vi.spyOn(cache.state, "relinquishDrainedCleanups").mockResolvedValue(undefined);
    vi.spyOn(cache.state, "repairPage").mockResolvedValue([]);
    const writer = await cache.beginFill(hash, bytes.length, Date.now() + 60_000);
    if (!writer) throw new Error("Expected cache fill");
    for (let offset = 0; offset < bytes.length; offset += BLOB_FRAME_BYTES) {
      writer.write(bytes.subarray(offset, offset + BLOB_FRAME_BYTES));
    }
    await writer.complete();
    await writer.close();
    vi.mocked(cache.state.release).mockClear();
    vi.mocked(readSync).mockClear();
    const controller = new AbortController();
    const reader = await cache.open(hash, bytes.length, Date.now() + 60_000, controller.signal);
    if (!reader) throw new Error("Expected cache hit");
    return { assetsDir, life, bytes, cache, reader, controller, pin };
  }

  afterEach(async () => {
    reads.pause = undefined;
    reads.calls = 0;
    reads.fault = undefined;
    if (fixture) {
      await fixture.life.stop();
      await rm(fixture.assetsDir, { recursive: true, force: true });
      fixture = undefined;
    }
    vi.restoreAllMocks();
  });

  it("hashes every frame asynchronously and preserves frame reads", async () => {
    fixture = await setup();
    const { reader, bytes } = fixture;
    expect(reader.verified).toBe(false);
    let yielded = false;
    const turn = setImmediate().then(() => {
      yielded = true;
    });
    await reader.preflight();
    expect(yielded).toBe(true);
    await turn;
    expect(reads.calls).toBe(2);
    expect(readSync).not.toHaveBeenCalled();
    expect(reader.verified).toBe(true);
    expect(await reader.readFrame(BLOB_FRAME_BYTES, 17)).toEqual(bytes.subarray(BLOB_FRAME_BYTES));
    await reader.complete();
    await reader.close();
  });

  it.each(["hash", "fingerprint", "truncated"] as const)(
    "rejects %s changes and retains the pin until close",
    async (change) => {
      fixture = await setup();
      const { reader, cache, pin } = fixture;
      reads.fault = change;
      await expect(reader.preflight()).rejects.toThrow();
      expect(reads.calls).toBe(2);
      expect(readSync).not.toHaveBeenCalled();
      expect(reader.verified).toBe(false);
      expect(cache.state.invalidate).toHaveBeenCalledWith(pin.entry, expect.any(Number));
      expect(cache.state.release).not.toHaveBeenCalled();
      await reader.close();
      expect(cache.state.release).toHaveBeenCalledWith(pin, expect.any(Number));
    },
  );

  it.each(["close", "signal", "lifecycle"] as const)(
    "drains an asynchronous read before closing during %s cancellation",
    async (cancel) => {
      fixture = await setup();
      const { reader, cache, controller, life } = fixture;
      let resume = () => {};
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let started = () => {};
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      reads.pause = () => {
        started();
        return blocked;
      };
      const preflight = expect(reader.preflight()).rejects.toThrow();
      await entered;
      if (cancel === "signal") controller.abort(new Error("Request cancelled"));
      let closed = false;
      const closing = (cancel === "lifecycle" ? life.stop() : reader.close()).then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(cache.state.release).not.toHaveBeenCalled();
      expect(fstatSync(reads.fd).isFile()).toBe(true);
      resume();
      await preflight;
      await closing;
      expect(reads.calls).toBe(1);
      expect(cache.state.release).toHaveBeenCalledTimes(1);
      expect(reader.verified).toBe(false);
      expect(() => fstatSync(reads.fd)).toThrow();
    },
  );
});

describe("cache attachment and unavailable bookkeeping", () => {
  it("performs no IO or recovery on construction and never writes after failed reservation", async () => {
    const life = createAssetStorageLifecycle("SERVER");
    const fail = vi.fn(async () => {
      throw new Error("DB unavailable");
    });
    const transactions: AssetCacheTransactions = fail;
    const cache = createAssetCache({
      assetsDir: "/nonexistent-cache-fixture",
      binding: {
        cacheId: "fixture",
        volumeId: "volume",
        storageGeneration: randomUUID(),
        configuration: "fixture",
        limit: 26214400n,
      },
      transactions,
      lifecycle: life,
      meter: { freeBytes: async () => 100000000000n },
    });
    expect(fail).not.toHaveBeenCalled();
    await expect(
      cache.state.reserve(`sha256:${"a".repeat(64)}`, 1024, Date.now() + 1000, "unused"),
    ).rejects.toThrow("DB unavailable");
    expect(fail).toHaveBeenCalledTimes(1);
    await life.stop();
  });
});
