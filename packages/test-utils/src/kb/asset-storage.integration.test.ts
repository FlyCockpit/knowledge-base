import { type ChildProcess, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { assetCacheBinding, createAssetCache } from "@knowledge-base/api/lib/kb/asset-cache";
import {
  createAssetCacheTouch,
  createAssetStorageLifecycle,
} from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import {
  drainOfflineAssetCache,
  initializeOfflineAssetCache,
} from "@knowledge-base/api/lib/kb/asset-storage-offline";
import {
  attachRuntimeAssetCache,
  createRuntimeAssetStore,
} from "@knowledge-base/api/lib/kb/asset-storage-runtime";
import {
  type AssetCacheTransactions,
  type CacheEntry,
  createAssetCacheTransactions,
} from "@knowledge-base/api/lib/kb/asset-storage-state";
import { createS3BlobStore } from "@knowledge-base/api/lib/kb/blob-store-s3";
import { assetCacheConfiguration, assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initKbVolumes } from "../../../../scripts/init-kb-volumes.mjs";
import { openKbPostgresClusterFromEnv } from "./index.js";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const limit = 26214400n;
const meter = { freeBytes: async () => 100n * 1024n * 1024n * 1024n };
const deadline = () => Date.now() + 15000;
const noop = () => {};
const roots: string[] = [];
const lives: ReturnType<typeof createAssetStorageLifecycle>[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  children.clear();
  await Promise.allSettled(lives.splice(0).map((l) => l.stop()));
});
afterAll(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await db.close();
  await cluster.close();
});
function life(role: "SERVER" | "WORKER" = "SERVER") {
  const l = createAssetStorageLifecycle(role);
  lives.push(l);
  return l;
}
function digest(bytes: Buffer) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
async function fixture(
  options: {
    limit?: bigint;
    barrier?: (name: string) => Promise<void>;
    transactions?: AssetCacheTransactions;
    configuration?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "kb-asset-cache-"));
  roots.push(root);
  initKbVolumes({ KB_DATA_ROOT: root });
  const assetsDir = join(root, "assets");
  const binding = await assetCacheBinding({
    assetsDir,
    storageGeneration: randomUUID(),
    configuration: options.configuration ?? `s3:fixture:${randomUUID()}`,
    limit: options.limit ?? limit,
  });
  const lifecycle = life();
  const transactions = options.transactions ?? createAssetCacheTransactions(db.urls.applier);
  const cache = createAssetCache({
    assetsDir,
    binding,
    lifecycle,
    transactions,
    meter,
    ...options,
  });
  await cache.initializeEmpty(noop);
  await cache.registerOwner(noop, deadline());
  return { root, assetsDir, binding, lifecycle, transactions, cache };
}
async function rows(f: Awaited<ReturnType<typeof fixture>>) {
  return f.transactions(
    deadline(),
    async (q) =>
      (
        await q<CacheEntry>(`SELECT * FROM asset_cache_entry WHERE "cacheId"=$1 ORDER BY hash`, [
          f.binding.cacheId,
        ])
      ).rows,
  );
}
async function charged(f: Awaited<ReturnType<typeof fixture>>) {
  const r = await db.query("applier", `SELECT "chargedBytes" FROM asset_cache_state WHERE id=$1`, [
    f.binding.cacheId,
  ]);
  return BigInt(String(r.rows[0]?.chargedBytes));
}
function payload(root: string): bigint {
  const inodes = new Set<string>();
  let sum = 0n;
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const p = join(path, name);
      const st = lstatSync(p, { bigint: true });
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const key = `${st.dev}:${st.ino}`;
        if (!inodes.has(key)) {
          inodes.add(key);
          sum += st.size;
        }
      }
    }
  };
  walk(root);
  return sum;
}
async function fill(f: Awaited<ReturnType<typeof fixture>>, bytes: Buffer) {
  const hash = digest(bytes);
  const writer = await f.cache.beginFill(hash, bytes.length, deadline());
  expect(writer).toBeDefined();
  for (let i = 0; i < bytes.length; i += 256 * 1024)
    writer!.write(bytes.subarray(i, i + 256 * 1024));
  await writer!.complete();
  await writer!.close();
  return hash;
}
function objectPath(f: Awaited<ReturnType<typeof fixture>>, hash: string) {
  const hex = hash.slice(7);
  return join(f.assetsDir, "objects", hex.slice(0, 2), hex.slice(2));
}
async function child(
  f: Awaited<ReturnType<typeof fixture>>,
  action: "partial" | "fill" | "pin" | "cleanup",
  hash: string,
  size: number,
  phase: string,
  role: "SERVER" | "WORKER" = "WORKER",
  stopAt?: string,
) {
  const proc = fork(join(import.meta.dirname, "asset-storage.child.ts"), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "advanced",
  });
  children.add(proc);
  let stderr = "";
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    const exited = () => reject(new Error(`Cache child exited before ${phase}: ${stderr}`));
    proc.once("exit", exited);
    proc.on("message", (message) => {
      if (typeof message === "object" && message && "phase" in message) {
        if (message.phase === "error") reject(new Error(JSON.stringify(message)));
        if (message.phase === phase) {
          proc.removeListener("exit", exited);
          resolve();
        }
      }
    });
  });
  proc.send({
    connectionString: db.urls.applier,
    assetsDir: f.assetsDir,
    binding: f.binding,
    role,
    action,
    hash,
    size,
    stopAt,
  });
  await ready;
  return proc;
}
async function kill(proc: ChildProcess) {
  const exited = once(proc, "exit");
  proc.kill("SIGKILL");
  await exited;
  children.delete(proc);
}
async function replace(f: Awaited<ReturnType<typeof fixture>>, role: "SERVER" | "WORKER") {
  const lifecycle = life(role);
  const cache = createAssetCache({ ...f, lifecycle, meter });
  await cache.registerOwner(noop, deadline());
  await cache.recover();
  if (role === f.lifecycle.role) {
    f.cache = cache;
    f.lifecycle = lifecycle;
  }
  return cache;
}

describe("shared asset cache byte accounting", () => {
  it("makes a short write followed by EIO terminal, retaining its full reservation until close", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(8, 7);
    const w = (await f.cache.beginFill(digest(bytes), bytes.length, deadline()))!;
    const realWrite = fs.writeSync;
    const fault = vi.spyOn(fs, "writeSync");
    const shortWrite: typeof fs.writeSync = (
      fd: number,
      data: NodeJS.ArrayBufferView | string,
      offset?: number | null,
      _length?: number | BufferEncoding | null,
      position?: number | null,
    ) => {
      if (typeof data === "string" || typeof offset !== "number")
        throw new Error("Expected a cache buffer write");
      return realWrite(fd, data, offset, 4, position);
    };
    fault.mockImplementationOnce(shortWrite);
    fault.mockImplementationOnce(() => {
      throw Object.assign(new Error("Injected write EIO"), { code: "EIO" });
    });
    syncBuiltinESMExports();
    expect(() => w.write(bytes)).toThrow("Injected write EIO");
    expect(payload(f.assetsDir)).toBe(4n);
    expect(await charged(f)).toBe(8n);
    expect(() => w.write(bytes)).toThrow("Asset cache unavailable");
    expect(() => w.complete()).toThrow("Asset cache unavailable");
    expect(fault).toHaveBeenCalledTimes(2);
    expect(payload(f.assetsDir)).toBe(4n);
    fault.mockRestore();
    syncBuiltinESMExports();
    await w.close();
    await f.cache.recover();
    expect(payload(f.assetsDir)).toBe(0n);
    expect(await charged(f)).toBe(0n);
    await fill(f, bytes);
    expect(payload(f.assetsDir)).toBe(8n);
  });
  it.each(["fill-after-link", "fill-before-ready"])(
    "makes partially successful promotion terminal at %s",
    async (phase) => {
      let armed = true;
      const f = await fixture({
        barrier: async (name) => {
          if (armed && name === phase) {
            armed = false;
            throw new Error("Injected promotion EIO");
          }
        },
      });
      const bytes = Buffer.alloc(8, 7);
      const w = (await f.cache.beginFill(digest(bytes), bytes.length, deadline()))!;
      w.write(bytes);
      await expect(w.complete()).rejects.toThrow("Injected promotion EIO");
      expect(() => w.write(bytes)).toThrow("Asset cache unavailable");
      expect(() => w.complete()).toThrow("Asset cache unavailable");
      expect(payload(f.assetsDir)).toBe(8n);
      expect(await charged(f)).toBe(8n);
      await w.close();
      await f.cache.recover();
      expect(await charged(f)).toBe(0n);
      expect(payload(f.assetsDir)).toBe(0n);
      await fill(f, bytes);
    },
  );
  it("reserves whole sizes across simultaneous admissions without speculative bytes", async () => {
    const f = await fixture();
    const a = Buffer.alloc(16 * 1024 * 1024, 1),
      b = Buffer.alloc(16 * 1024 * 1024, 2);
    const writers = await Promise.all([
      f.cache.beginFill(digest(a), a.length, deadline()),
      f.cache.beginFill(digest(b), b.length, deadline()),
    ]);
    expect(writers.filter(Boolean)).toHaveLength(1);
    expect(await charged(f)).toBe(BigInt(a.length));
    expect(payload(f.assetsDir)).toBe(0n);
    await Promise.all(writers.map((w) => w?.close()));
    await f.cache.recover();
    expect(await charged(f)).toBe(0n);
  });
  it("serializes reservations across independent processes sharing the volume", async () => {
    const f = await fixture();
    const size = 16 * 1024 * 1024;
    const hash = digest(Buffer.alloc(size, 7));
    const first = await f.cache.beginFill(digest(Buffer.alloc(size, 1)), size, deadline());
    expect(first).toBeDefined();
    const p = await child(f, "partial", hash, size, "busy");
    expect(await charged(f)).toBe(BigInt(size));
    expect(payload(f.assetsDir)).toBe(0n);
    await kill(p);
    await first!.close();
    await f.cache.recover();
    expect(await charged(f)).toBe(0n);
  });
  it("allows exactly one same-hash fill; followers cannot pin partial bytes", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(1024, 7),
      hash = digest(bytes);
    const w = await f.cache.beginFill(hash, bytes.length, deadline());
    expect(w).toBeDefined();
    expect(await f.cache.beginFill(hash, bytes.length, deadline())).toBeUndefined();
    expect(
      await f.cache.open(hash, bytes.length, deadline(), new AbortController().signal),
    ).toBeUndefined();
    w!.write(bytes);
    await w!.complete();
    await w!.close();
    const reader = await f.cache.open(hash, bytes.length, deadline(), new AbortController().signal);
    await reader!.preflight();
    expect(Buffer.from(await reader!.readFrame(0, 1024))).toEqual(bytes);
    await reader!.close();
    expect(await charged(f)).toBe(1024n);
    expect(payload(f.assetsDir)).toBe(1024n);
  });
  it("holds a cross-process reader pin against eviction and never reaps it on server restart", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(1024, 7),
      hash = await fill(f, bytes);
    const p = await child(f, "pin", hash, bytes.length, "pinned");
    await replace(f, "SERVER");
    expect(await f.cache.repair(deadline(), hash, true)).toBe(false);
    expect(payload(f.assetsDir)).toBe(1024n);
    await kill(p);
    await replace(f, "WORKER");
    expect(await f.cache.repair(deadline(), hash, true)).toBe(true);
    expect(await charged(f)).toBe(0n);
  });
  it("recovers more than one keyset page of dead pins without a deleted cursor", async () => {
    const f = await fixture();
    const hash = await fill(f, Buffer.alloc(128, 7));
    for (let n = 0; n < 101; n++)
      expect(await f.cache.state.acquire(hash, 128, deadline())).toBeDefined();
    await f.lifecycle.stop();
    await replace(f, "SERVER");
    expect(await f.cache.repair(deadline(), hash, true)).toBe(true);
    expect(await charged(f)).toBe(0n);
  });
  it("does not steal same-generation siblings or expire pins by wall clock", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(512, 3),
      hash = await fill(f, bytes);
    const reader = await f.cache.open(hash, 512, deadline(), new AbortController().signal);
    await f.cache.registerOwner(noop, deadline());
    expect(await f.cache.repair(deadline(), hash, true)).toBe(false);
    await reader!.close();
    expect(await f.cache.repair(deadline(), hash, true)).toBe(true);
  });
  it("recovers a killed writer only after its own role fence and retains full reservation until removal", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7),
      hash = digest(bytes);
    const p = await child(f, "partial", hash, bytes.length, "written");
    expect(await charged(f)).toBe(BigInt(bytes.length));
    expect(payload(f.assetsDir)).toBe(BigInt(bytes.length));
    await kill(p);
    await replace(f, "SERVER");
    expect(await charged(f)).toBe(BigInt(bytes.length));
    await replace(f, "WORKER");
    expect(await charged(f)).toBe(0n);
    expect(payload(f.assetsDir)).toBe(0n);
  });
  it.each(["fill-after-link", "fill-before-ready"])(
    "recovers all aliases after SIGKILL at %s",
    async (stopAt) => {
      const f = await fixture();
      const bytes = Buffer.alloc(4096, 7),
        hash = digest(bytes);
      const p = await child(f, "fill", hash, bytes.length, stopAt, "WORKER", stopAt);
      expect(payload(f.assetsDir)).toBe(BigInt(bytes.length));
      await kill(p);
      await replace(f, "WORKER");
      expect(await charged(f)).toBe(0n);
      expect(payload(f.assetsDir)).toBe(0n);
    },
  );
  it("retains uncertainty after a crash between exclusive create and identity recording", async () => {
    const f = await fixture();
    const hash = digest(Buffer.alloc(1024, 7));
    const p = await child(f, "fill", hash, 1024, "fill-created", "WORKER", "fill-created");
    await kill(p);
    await expect(replace(f, "WORKER")).rejects.toThrow();
    expect(await charged(f)).toBe(1024n);
    expect((await rows(f))[0]!.state).toBe("EVICTING");
  });
  it("keeps unconfirmed eviction charged after unlink and retries directory fsync after SIGKILL", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(4096, 7),
      hash = await fill(f, bytes);
    const p = await child(
      f,
      "cleanup",
      hash,
      bytes.length,
      "cleanup-after-unlink",
      "WORKER",
      "cleanup-after-unlink",
    );
    expect(payload(f.assetsDir)).toBe(0n);
    expect(await charged(f)).toBe(4096n);
    await kill(p);
    await replace(f, "WORKER");
    expect(await charged(f)).toBe(0n);
  });
  it("repairs corrupt owned bytes after the last reader drains and permits a new incarnation", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(1024, 7),
      hash = await fill(f, bytes);
    const old = (await rows(f))[0]!;
    const reader = await f.cache.open(hash, 1024, deadline(), new AbortController().signal);
    await reader!.preflight();
    writeFileSync(objectPath(f, hash), Buffer.alloc(1024, 8));
    await expect(reader!.readFrame(0, 128)).rejects.toThrow();
    expect((await rows(f))[0]?.state).toBe("INVALID");
    expect(await f.cache.repair(deadline(), hash)).toBe(false);
    expect(await charged(f)).toBe(1024n);
    await reader!.close();
    await f.cache.recover();
    expect(await charged(f)).toBe(0n);
    await fill(f, bytes);
    expect((await rows(f))[0]!.incarnation).not.toBe(old.incarnation);
    await f.cache.state.invalidate(old, deadline());
    expect((await rows(f))[0]!.state).toBe("READY");
  });
  it("does not lose the last-pin wakeup while a sibling recovery pass is in flight", async () => {
    const real = createAssetCacheTransactions(db.urls.applier);
    let arm = false;
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((r) => {
      reached = r;
    });
    const released = new Promise<void>((r) => {
      resume = r;
    });
    const transactions: AssetCacheTransactions = async (d, work) => {
      let matched = false;
      const result = await real(d, (q) =>
        work(async (sql, values) => {
          if (arm && sql.includes("NOT EXISTS (SELECT 1 FROM asset_cache_pin")) matched = true;
          return q(sql, values);
        }),
      );
      if (arm && matched) {
        arm = false;
        reached();
        await released;
      }
      return result;
    };
    const f = await fixture({ transactions });
    const bytes = Buffer.alloc(128, 7),
      hash = await fill(f, bytes);
    await f.cache.recover();
    const reader = await f.cache.open(hash, 128, deadline(), new AbortController().signal);
    await reader!.preflight();
    writeFileSync(objectPath(f, hash), Buffer.alloc(128, 9));
    await expect(reader!.readFrame(0, 128)).rejects.toThrow();
    arm = true;
    const recovering = f.cache.recover();
    await paused;
    await reader!.close();
    resume();
    await recovering;
    expect(await charged(f)).toBe(0n);
  });
  it("retries EIO without early or duplicate credit", async () => {
    let fail = false;
    const f = await fixture({
      barrier: async (name) => {
        if (fail && name === "cleanup-after-unlink") throw new Error("EIO");
      },
    });
    const hash = await fill(f, Buffer.alloc(2048, 3));
    fail = true;
    await expect(f.cache.repair(deadline(), hash, true)).rejects.toThrow("EIO");
    expect(await charged(f)).toBe(2048n);
    expect(payload(f.assetsDir)).toBe(0n);
    fail = false;
    await Promise.all([f.cache.recover(), f.cache.recover()]);
    expect(await charged(f)).toBe(0n);
    await f.cache.recover();
    expect(await charged(f)).toBe(0n);
  });
  it("refuses changed volume/configuration and unknown directory replacement without credit", async () => {
    const f = await fixture();
    const hash = await fill(f, Buffer.alloc(128, 3));
    const wrong = createAssetCache({
      ...f,
      binding: { ...f.binding, configuration: "changed" },
      meter,
    });
    await expect(wrong.registerOwner(noop, deadline())).rejects.toThrow();
    const shard = join(f.assetsDir, "objects", hash.slice(7, 9));
    renameSync(shard, `${shard}-moved`);
    mkdirSync(shard);
    await expect(f.cache.repair(deadline(), hash, true)).rejects.toThrow();
    expect(await charged(f)).toBe(128n);
  });
  it("blocks startup over untracked payload and repairs ordinary owned corruption", async () => {
    const f = await fixture();
    const hash = await fill(f, Buffer.alloc(128, 3));
    writeFileSync(objectPath(f, hash), Buffer.alloc(128, 4));
    await f.cache.registerOwner(noop, deadline());
    expect(await charged(f)).toBe(0n);
    const hex = hash.slice(7);
    writeFileSync(
      join(f.assetsDir, "objects", hex.slice(0, 2), "f".repeat(62)),
      Buffer.alloc(128, 4),
    );
    await expect(f.cache.registerOwner(noop, deadline())).rejects.toThrow();
    expect(payload(f.assetsDir)).toBe(128n);
  });
  it("has no cache writes/reservations for an oversized asset and no frame beyond declared size", async () => {
    const f = await fixture();
    expect(
      await f.cache.beginFill(digest(Buffer.from("x")), Number(limit) + 1, deadline()),
    ).toBeUndefined();
    expect(await charged(f)).toBe(0n);
    const w = await f.cache.beginFill(digest(Buffer.from("x")), 1, deadline());
    expect(() => w!.write(Buffer.from("xx"))).toThrow();
    expect(payload(f.assetsDir)).toBe(0n);
    await w!.close();
  });
  it("refuses missing metadata over an existing authoritative disk namespace", async () => {
    const f = await fixture();
    await fill(f, Buffer.alloc(128, 5));
    await expect(f.cache.initializeEmpty(noop)).rejects.toThrow();
    const absent = createAssetCache({
      ...f,
      binding: { ...f.binding, cacheId: f.binding.cacheId + "-wrong" },
      meter,
    });
    await expect(absent.registerOwner(noop, deadline())).rejects.toThrow();
  });
  it("installs a smaller limit only after offline recovery and durable trim", async () => {
    const f = await fixture({ limit: 2n * limit });
    await fill(f, Buffer.alloc(16 * 1024 * 1024, 1));
    await fill(f, Buffer.alloc(16 * 1024 * 1024, 2));
    expect(await charged(f)).toBe(32n * 1024n * 1024n);
    await expect(f.cache.state.installLimit(limit, "next", noop, deadline())).rejects.toThrow();
    await f.lifecycle.stop();
    const offline = await replace(f, "SERVER");
    await offline.repair(deadline(), undefined, true);
    expect(await charged(f)).toBe(16n * 1024n * 1024n);
    await offline.state.retireOffline(noop, deadline());
    await offline.state.installLimit(limit, "next", noop, deadline());
    await expect(offline.registerOwner(noop, deadline())).rejects.toThrow();
  });
});

describe("advisory recency does not own bytes", () => {
  it("uses recorded successful touches and stable hash ties for eviction", async () => {
    const f = await fixture();
    const a = await fill(f, Buffer.alloc(128, 1)),
      b = await fill(f, Buffer.alloc(128, 2));
    const entries = await rows(f);
    const touched = entries[0]!;
    await f.cache.state.touch(touched, deadline());
    const victim = await f.cache.state.claimCleanup(deadline(), undefined, true);
    expect(victim?.hash).toBe(entries[1]!.hash);
    await f.cache.state.relinquishCleanup(victim!, deadline());
    await f.cache.recover();
    expect((await rows(f)).map((e) => e.hash)).toEqual([touched.hash]);
    expect([a, b]).toContain(touched.hash);
  });
  it("drops an unresolved late touch after pin release/removal/refill without changing the new incarnation", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(128, 7),
      hash = await fill(f, bytes);
    const old = (await rows(f))[0]!;
    let resume!: () => void;
    const pending = new Promise<void>((r) => {
      resume = r;
    });
    const touch = createAssetCacheTouch(f.lifecycle, async () => {
      await pending;
      await f.cache.state.touch(old, deadline());
    });
    touch.sample();
    const reader = await f.cache.open(hash, 128, deadline(), new AbortController().signal);
    await reader!.close();
    await f.cache.repair(deadline(), hash, true);
    await fill(f, bytes);
    resume();
    await f.lifecycle.stop();
    const next = (await rows(f))[0]!;
    expect(next.incarnation).not.toBe(old.incarnation);
    expect(BigInt(next.lastFetchSequence)).toBe(0n);
  });
  it("preserves a touch recorded while FILLING through READY promotion", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(128, 7),
      hash = digest(bytes);
    const w = await f.cache.beginFill(hash, 128, deadline());
    await f.cache.state.touch((await rows(f))[0]!, deadline());
    w!.write(bytes);
    await w!.complete();
    await w!.close();
    expect(BigInt((await rows(f))[0]!.lastFetchSequence)).toBeGreaterThan(0n);
  });
});

describe("concurrent cache startup observation", () => {
  it("refuses a replaced inode whose ownership did not advance", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(128, 7),
      hash = await fill(f, bytes);
    const original = (await rows(f))[0]!;
    const path = objectPath(f, hash);
    renameSync(path, join(f.root, "displaced-payload"));
    writeFileSync(path, bytes);
    const startup = createAssetCache({ ...f, lifecycle: life("WORKER"), meter });
    await expect(startup.registerOwner(noop, deadline())).rejects.toThrow(
      "Asset cache unavailable",
    );
    expect(await charged(f)).toBe(BigInt(bytes.length));
    expect((await rows(f))[0]!.incarnation).toBe(original.incarnation);
    expect(readFileSync(path)).toEqual(bytes);
  });
  it.each(["identity", "writing", "promotion", "refill"])(
    "accepts a live sibling advancing through %s across the SQL acknowledgement",
    async (phase) => {
      let resume = () => {};
      let created = () => {};
      const createdFile = new Promise<void>((resolve) => {
        created = resolve;
      });
      const continueCreation = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const f = await fixture({
        barrier: async (name) => {
          if (phase === "identity" && name === "fill-created") {
            created();
            await continueCreation;
          }
        },
      });
      const bytes = Buffer.alloc(1024, 7),
        hash = digest(bytes);
      const filling = f.cache.beginFill(hash, bytes.length, deadline());
      let writer: Awaited<typeof filling>;
      if (phase === "identity") await createdFile;
      else writer = await filling;
      if (phase === "promotion" || phase === "refill") writer!.write(bytes);
      if (phase === "refill") {
        await writer!.complete();
        await writer!.close();
      }
      const original = (await rows(f))[0]!;
      let advanced = false;
      const transactions: AssetCacheTransactions = async (d, work) => {
        let observed = false;
        const result = await f.transactions(d, (q) =>
          work(async (sql, values) => {
            if (sql.includes(`AND "${phase === "refill" ? "hash" : "tempName"}"=a.value LIMIT 1`))
              observed = true;
            return q(sql, values);
          }),
        );
        if (observed && !advanced) {
          advanced = true;
          // A live role may commit between a SQL transaction and its caller's
          // continuation. Reconciliation must already have observed ownership.
          if (phase === "identity") {
            resume();
            writer = await filling;
          }
          if (phase === "identity" || phase === "writing") writer!.write(bytes);
          else if (phase === "promotion") await writer!.complete();
          else {
            expect(await f.cache.repair(deadline(), hash, true)).toBe(true);
            await fill(f, bytes);
          }
        }
        return result;
      };
      const startup = createAssetCache({ ...f, transactions, lifecycle: life("WORKER"), meter });
      await startup.registerOwner(noop, deadline());
      expect(advanced).toBe(true);
      const entry = (await rows(f))[0]!;
      if (phase === "refill") expect(entry.incarnation).not.toBe(original.incarnation);
      else expect(entry.incarnation).toBe(original.incarnation);
      expect(entry.inode).not.toBeNull();
      expect(entry.state).toBe(phase === "identity" || phase === "writing" ? "FILLING" : "READY");
      expect(await charged(f)).toBe(BigInt(bytes.length));
      expect(payload(f.assetsDir)).toBe(BigInt(bytes.length));
      if (phase !== "refill") {
        if (phase !== "promotion") await writer!.complete();
        await writer!.close();
      }
      const reader = await startup.open(
        hash,
        bytes.length,
        deadline(),
        new AbortController().signal,
      );
      await reader!.preflight();
      expect(Buffer.from(await reader!.readFrame(0, bytes.length))).toEqual(bytes);
      await reader!.close();
    },
  );
});

describe("ordered cache lookups under quota/state locks", () => {
  it.each([1000, 100000])("uses bounded ordered index probes with %i entries", async (count) => {
    const f = await fixture();
    // Metadata-only entries in this disposable cache exercise the production
    // queries without writing 100,000 tiny files or relying on timing.
    await db.query(
      "applier",
      `WITH entries AS (
      SELECT i, gen_random_uuid() AS incarnation FROM generate_series(1,$3::int) i
    ) INSERT INTO asset_cache_entry (
      "cacheId",hash,incarnation,size,state,"fillOwner","tempName",device,inode,
      "mtimeNs","ctimeNs","tempDirectory","finalDirectory","finalAlias","cleanupAttempt","quotaReservations","lastFetchSequence")
      SELECT $1,'sha256:'||lpad(i::text,64,'0'),incarnation,1,
        CASE i WHEN 1 THEN 'INVALID' WHEN 2 THEN 'EVICTING' ELSE 'READY' END::"AssetCacheStatus",
        $2::uuid,'cache-'||incarnation::text,'1',i::text,'1','1','fixture','fixture',true,
        CASE WHEN i=2 THEN gen_random_uuid() END,'{}'::text[],
        CASE i WHEN 1 THEN 2 WHEN 2 THEN 1 ELSE 3 END FROM entries`,
      [f.binding.cacheId, f.lifecycle.epoch, count],
    );
    await db.query("applier", `UPDATE asset_cache_state SET "chargedBytes"=$2 WHERE id=$1`, [
      f.binding.cacheId,
      count,
    ]);
    // The sparse INVALID/EVICTING heads must be represented exactly rather
    // than depending on ANALYZE's random sample of the accumulated fixtures.
    // This target covers the entire <=101k-entry fixture and all join inputs.
    await db.query(
      "applier",
      "ALTER TABLE asset_cache_entry ALTER COLUMN state SET STATISTICS 1000",
    );
    await db.query(
      "applier",
      'ALTER TABLE asset_cache_entry ALTER COLUMN "cacheId" SET STATISTICS 1000',
    );
    await db.query("applier", "ANALYZE asset_cache_entry");
    await db.query("applier", "ANALYZE asset_cache_pin");
    await db.query("applier", "ANALYZE asset_cache_owner");
    type Plan = {
      "Node Type": string;
      "Index Name"?: string;
      "Relation Name"?: string;
      "Actual Rows": number;
      "Actual Loops": number;
      "Rows Removed by Filter"?: number;
      Plans?: Plan[];
    };
    const plans: { sql: string; plan: Plan }[] = [];
    const inspected = createAssetCache({
      ...f,
      meter,
      transactions: async (d, work) =>
        f.transactions(d, (q) =>
          work(async (sql, values) => {
            if (
              sql.includes("ORDER BY e.") ||
              sql.includes("ORDER BY hash LIMIT 100") ||
              sql.includes("e.hash=$2\n")
            ) {
              const result = await q<{ "QUERY PLAN": { Plan: Plan }[] }>(
                `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
                values,
              );
              plans.push({ sql, plan: result.rows[0]!["QUERY PLAN"][0]!.Plan });
            }
            return q(sql, values);
          }),
        ),
    });
    const first = await inspected.state.claimCleanup(deadline(), undefined, true);
    expect(first!.hash).toBe(`sha256:${"2".padStart(64, "0")}`);
    await inspected.state.claimCleanup(deadline(), undefined, false);
    await inspected.state.claimCleanup(deadline(), `sha256:${"3".padStart(64, "0")}`, true);
    await inspected.state.repairPage("", deadline());
    expect(plans).toHaveLength(7); // three eviction heads, two repair heads, exact hash, keyset
    const evidence: { index: string | undefined; rows: number; loops: number }[] = [];
    for (const { sql, plan } of plans) {
      const nodes: Plan[] = [];
      const walk = (p: Plan) => {
        nodes.push(p);
        p.Plans?.forEach(walk);
      };
      walk(plan);
      // Only ancestors of the entry scan determine whether the ordered probe
      // sorts cache entries. A planner may independently sort the pin side of
      // an anti-join without changing the bounded cache lookup.
      const entryPath = (p: Plan): Plan[] | undefined => {
        if (p["Relation Name"] === "asset_cache_entry") return [p];
        for (const child of p.Plans ?? []) {
          const found = entryPath(child);
          if (found) return [p, ...found];
        }
      };
      const path = entryPath(plan)!;
      expect(
        path.some((p) => p["Node Type"].includes("Sort")),
        JSON.stringify({ sql, plan }),
      ).toBe(false);
      const entryScans = nodes.filter((p) => p["Relation Name"] === "asset_cache_entry");
      expect(entryScans).toHaveLength(1);
      const scan = entryScans[0]!;
      const keyset = sql.includes("ORDER BY hash LIMIT 100");
      expect(scan["Index Name"]).toBe(
        keyset
          ? "asset_cache_entry_repair_idx"
          : sql.includes("ORDER BY e.")
            ? "asset_cache_entry_victim_idx"
            : "asset_cache_entry_pkey",
      );
      const visited =
        (scan["Actual Rows"] + (scan["Rows Removed by Filter"] ?? 0)) * scan["Actual Loops"];
      expect(visited).toBeLessThanOrEqual(keyset ? 100 : 2);
      evidence.push({ index: scan["Index Name"], rows: visited, loops: scan["Actual Loops"] });
    }
    console.info(
      "Ordered cache lookup evidence",
      JSON.stringify({ entries: count, probes: evidence }),
    );
    // Folded migration definitions stay explicit so this test does not need
    // the removed standalone SQL catalog manifest.
    const expected = {
      asset_cache_entry_victim_idx:
        'CREATE INDEX asset_cache_entry_victim_idx ON public.asset_cache_entry USING btree ("cacheId", state, "lastFetchSequence", hash COLLATE "C") WHERE ("cleanupOwner" IS NULL)',
      asset_cache_entry_repair_idx: `CREATE INDEX asset_cache_entry_repair_idx ON public.asset_cache_entry USING btree ("cacheId", hash) WHERE (state = ANY (ARRAY['INVALID'::"AssetCacheStatus", 'EVICTING'::"AssetCacheStatus"]))`,
    };
    for (const [name, definition] of Object.entries(expected)) {
      const result = await db.query(
        "applier",
        "SELECT pg_get_indexdef($1::regclass) AS definition",
        [name],
      );
      expect(result.rows[0]!.definition).toBe(definition);
    }
  });
});

describe("cache SQL acknowledgement failures", () => {
  it("stale relinquishment cannot displace a reacquired cleanup while its inode is open", async () => {
    const real = createAssetCacheTransactions(db.urls.applier);
    let loseRelinquish = false;
    const transactions: AssetCacheTransactions = async (d, work) => {
      let relinquished = false;
      const result = await real(d, (q) =>
        work(async (sql, values) => {
          if (loseRelinquish && sql.includes('SET "cleanupOwner"=NULL')) relinquished = true;
          return q(sql, values);
        }),
      );
      if (relinquished) {
        loseRelinquish = false;
        throw new Error("Lost relinquishment acknowledgement");
      }
      return result;
    };
    const opened = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const f = await fixture({
      transactions,
      barrier: async (name) => {
        if (name === "cleanup-before-unlink") {
          opened.resolve();
          await resume.promise;
        }
      },
    });
    const bytes = Buffer.alloc(1024, 21);
    const hash = await fill(f, bytes);
    await f.cache.recover(); // join the initial pin-release sweep before the fault
    const old = (await f.cache.state.claimCleanup(deadline(), hash, true))!;
    loseRelinquish = true;
    await expect(f.cache.state.relinquishCleanup(old, deadline())).rejects.toThrow(/Lost/);
    const cleaning = f.cache.repair(deadline(), hash);
    try {
      await opened.promise; // cleaner owns an open payload inode
      const newer = (await rows(f))[0]!;
      expect(newer.cleanupAttempt).not.toBe(old.cleanupAttempt);
      await f.cache.state.relinquishDrainedCleanups(); // replay stale acknowledgement
      expect((await rows(f))[0]!.cleanupOwner).toBe(f.lifecycle.epoch);
      expect(await f.cache.state.claimCleanup(deadline(), hash)).toBeUndefined();
      expect(await charged(f)).toBe(BigInt(bytes.length));
      expect(payload(f.assetsDir)).toBe(BigInt(bytes.length));
    } finally {
      resume.resolve();
      await cleaning;
    }
    expect(await charged(f)).toBe(0n);
  });
  it("retries a drained ambiguous claim after its immediate relinquishment also fails", async () => {
    const real = createAssetCacheTransactions(db.urls.applier);
    let loseClaim = false;
    let denyRelinquish = false;
    const transactions: AssetCacheTransactions = async (d, work) => {
      let claimed = false;
      const result = await real(d, (q) =>
        work(async (sql, values) => {
          if (denyRelinquish && sql.includes('SET "cleanupOwner"=NULL'))
            throw new Error("DB unavailable during relinquishment");
          if (loseClaim && sql.includes("SET state='EVICTING'")) claimed = true;
          return q(sql, values);
        }),
      );
      if (claimed) {
        loseClaim = false;
        throw new Error("Lost claim acknowledgement");
      }
      return result;
    };
    const f = await fixture({ transactions });
    const bytes = Buffer.alloc(1024, 22);
    const hash = await fill(f, bytes);
    loseClaim = denyRelinquish = true;
    await expect(f.cache.repair(deadline(), hash, true)).rejects.toThrow(/Lost claim/);
    expect((await rows(f))[0]!.cleanupOwner).toBe(f.lifecycle.epoch);
    expect(payload(f.assetsDir)).toBe(BigInt(bytes.length));
    denyRelinquish = false;
    await f.cache.recover(); // same role generation; no restart/fence recovery
    expect(await rows(f)).toEqual([]);
    expect(await charged(f)).toBe(0n);
    expect(payload(f.assetsDir)).toBe(0n);
    await fill(f, bytes); // capacity/unique-hash admission is usable again
  });
  it.each(["reserve", "identity", "link", "ready", "claim", "credit"])(
    "retains conservative byte state after lost %s acknowledgement",
    async (transition) => {
      const real = createAssetCacheTransactions(db.urls.applier);
      let armed = false;
      let fired = false;
      const transactions: AssetCacheTransactions = async (d, work) => {
        let matched = false;
        const result = await real(d, (q) =>
          work(async (sql, values) => {
            if (
              armed &&
              !fired &&
              ((transition === "reserve" && sql.includes("INSERT INTO asset_cache_entry")) ||
                (transition === "identity" && sql.includes("SET device=")) ||
                (transition === "link" && sql.includes('SET "finalAlias"=true')) ||
                (transition === "ready" && sql.includes("SET state='READY'")) ||
                (transition === "claim" && sql.includes("SET state='EVICTING'")) ||
                (transition === "credit" &&
                  sql.startsWith("DELETE") &&
                  sql.includes("asset_cache_entry")))
            )
              matched = true;
            return q(sql, values);
          }),
        );
        if (matched) {
          fired = true;
          throw new Error("Lost SQL acknowledgement");
        }
        return result;
      };
      const f = await fixture({ transactions });
      const bytes = Buffer.alloc(1024, 7),
        hash = digest(bytes);
      if (transition === "credit" || transition === "claim") {
        await fill(f, bytes);
        armed = true;
        await expect(f.cache.repair(deadline(), hash, true)).rejects.toThrow();
      } else {
        armed = true;
        if (transition === "reserve" || transition === "identity")
          await expect(f.cache.beginFill(hash, 1024, deadline())).rejects.toThrow();
        else {
          const w = await f.cache.beginFill(hash, 1024, deadline());
          w!.write(bytes);
          await expect(w!.complete()).rejects.toThrow();
          await w!.close();
        }
      }
      expect(fired).toBe(true);
      if (transition === "claim") {
        await f.cache.recover();
        expect(await charged(f)).toBe(0n);
      }
      expect(await charged(f)).toBeLessThanOrEqual(limit);
      expect(payload(f.assetsDir)).toBeLessThanOrEqual(await charged(f));
      await f.lifecycle.stop();
      await replace(f, "SERVER");
      expect(await charged(f)).toBe(0n);
      expect(payload(f.assetsDir)).toBe(0n);
    },
  );
  it("orders delayed touches without decreasing recency and uses hash ties", async () => {
    const f = await fixture();
    await fill(f, Buffer.alloc(256, 1));
    await fill(f, Buffer.alloc(256, 2));
    const [a, b] = await rows(f);
    const tied = await f.cache.state.claimCleanup(deadline(), undefined, true);
    expect(tied!.hash).toBe(a!.hash);
    await f.cache.state.relinquishCleanup(tied!, deadline());
    await f.cache.recover();
    await fill(f, Buffer.alloc(256, 1));
    const current = (await rows(f)).find((e) => e.hash === a!.hash)!;
    await Promise.all([
      f.cache.state.touch(current, deadline()),
      f.cache.state.touch(current, deadline()),
    ]);
    const first = BigInt((await rows(f)).find((e) => e.hash === current.hash)!.lastFetchSequence);
    await f.cache.state.touch(b!, deadline());
    await f.cache.state.touch(current, deadline());
    expect(
      BigInt((await rows(f)).find((e) => e.hash === current.hash)!.lastFetchSequence),
    ).toBeGreaterThan(first);
  });
});

describe("real SQL transport and deadline failures", () => {
  it("keeps the reservation after a database disconnect during file identity recording", async () => {
    const real = createAssetCacheTransactions(db.urls.applier);
    let arm = false;
    const transactions: AssetCacheTransactions = (d, work) =>
      real(d, (q) =>
        work(async (sql, values) => {
          if (arm && sql.includes("SET device=")) {
            arm = false;
            await q("SELECT pg_terminate_backend(pg_backend_pid())");
          }
          return q(sql, values);
        }),
      );
    const f = await fixture({ transactions });
    arm = true;
    await expect(
      f.cache.beginFill(digest(Buffer.alloc(128, 7)), 128, deadline()),
    ).rejects.toThrow();
    await f.cache.recover();
    expect(await charged(f)).toBe(128n);
    expect((await rows(f))[0]!.state).toBe("EVICTING");
    expect(payload(f.assetsDir)).toBe(0n); // The retained charge represents uncertain ownership of the empty file.
  });
  it("drops a timed-out touch while serving bytes and releases its pin normally", async () => {
    const real = createAssetCacheTransactions(db.urls.applier);
    let arm = false;
    const transactions: AssetCacheTransactions = (d, work) =>
      real(d, (q) =>
        work(async (sql, values) => {
          if (arm && sql.includes('SET "lastFetchSequence"')) await q("SELECT pg_sleep(1)");
          return q(sql, values);
        }),
      );
    const f = await fixture({ transactions });
    const bytes = Buffer.alloc(256, 7),
      hash = await fill(f, bytes);
    const reader = await f.cache.open(hash, 256, deadline(), new AbortController().signal);
    await reader!.preflight();
    arm = true;
    reader!.sampleDownload();
    expect(Buffer.from(await reader!.readFrame(0, 256))).toEqual(bytes);
    await reader!.close();
    await f.lifecycle.stop();
    const pending = await db.query(
      "applier",
      `SELECT id FROM asset_cache_pin WHERE incarnation=$1::uuid`,
      [(await rows(f))[0]!.incarnation],
    );
    expect(pending.rows).toHaveLength(0);
  });
});

describe("nested S3 reader ownership", () => {
  it("keeps the real cache fill pin until delayed GET destruction completes", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(1024, 31);
    const hash = digest(bytes);
    const destroying = Promise.withResolvers<void>();
    const destroyed = Promise.withResolvers<void>();
    let finishDestroy = () => {};
    const body = new Readable({
      read() {},
      destroy(error, callback) {
        finishDestroy = () => {
          callback(error);
          destroyed.resolve();
        };
        destroying.resolve();
      },
    });
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => ({
      ContentLength: bytes.length,
      Body: body,
    }));
    const config = {
      bucket: "assets",
      region: "us-east-1",
      prefix: "fixture",
      forcePathStyle: true,
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    };
    const store = createS3BlobStore({
      assetsDir: f.assetsDir,
      cache: f.cache,
      lifecycle: f.lifecycle,
      config,
      publication: {
        scope: "active",
        binding: {
          storageGeneration: f.binding.storageGeneration,
          locator: assetS3Locator(config),
        },
        pending: async () => {},
        durable: async () => {},
      },
    });
    const reader = await store.open({
      hash,
      size: bytes.length,
      purpose: "download",
      signal: new AbortController().signal,
    });
    await reader.preflight();
    const reading = expect(reader.readFrame(0, 1)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    const stopping = f.lifecycle.stop();
    try {
      await destroying.promise;
      expect(body.destroyed).toBe(true); // destroy requested, but source IO has NOT drained
      expect((await rows(f))[0]!.state).toBe("FILLING");
      const pins = await db.query(
        "applier",
        `SELECT count(*)::int AS n FROM asset_cache_pin WHERE incarnation=$1::uuid`,
        [(await rows(f))[0]!.incarnation],
      );
      expect(pins.rows[0]!.n).toBe(1);
      expect(await f.cache.state.claimCleanup(deadline(), hash, true)).toBeUndefined();
      expect(await charged(f)).toBe(BigInt(bytes.length));
    } finally {
      finishDestroy();
      await destroyed.promise;
      await stopping;
      await reading;
    }
    expect((await rows(f))[0]!.state).toBe("INVALID");
    const pins = await db.query(
      "applier",
      `SELECT count(*)::int AS n FROM asset_cache_pin WHERE incarnation=$1::uuid`,
      [(await rows(f))[0]!.incarnation],
    );
    expect(pins.rows[0]!.n).toBe(0);
  });
});

describe("populated runtime cache attachment", () => {
  it("cancels offline initialization while scanning a populated private namespace and closes its directory", async () => {
    const locator = assetS3Locator({
      bucket: "assets",
      region: "us-east-1",
      prefix: "",
      forcePathStyle: false,
    });
    const f = await fixture({ configuration: assetCacheConfiguration(locator, limit) });
    for (let i = 0; i < 250; i++)
      writeFileSync(join(f.assetsDir, ".private/tmp", `other-${i}`), "");
    const parent = new AbortController();
    const realOpen = fs.opendirSync;
    let openDirectories = 0;
    let inspected = 0;
    vi.spyOn(fs, "opendirSync").mockImplementation((...args) => {
      const dir = realOpen(...args);
      openDirectories++;
      const close = dir.closeSync.bind(dir);
      vi.spyOn(dir, "closeSync").mockImplementation(() => {
        close();
        openDirectories--;
      });
      const read = dir.readSync.bind(dir);
      vi.spyOn(dir, "readSync").mockImplementation(() => {
        const child = read();
        if (child && ++inspected === 1) parent.abort(new Error("Cancelled initialization"));
        return child;
      });
      return dir;
    });
    syncBuiltinESMExports();
    await expect(
      initializeOfflineAssetCache({
        assetsDir: f.assetsDir,
        connectionString: db.urls.applier,
        generation: f.binding.storageGeneration,
        locator,
        limit,
        assertOfflineFences: noop,
        signal: parent.signal,
      }),
    ).rejects.toThrow("Cancelled initialization");
    expect(inspected).toBe(1);
    expect(openDirectories).toBe(0);
    expect(await charged(f)).toBe(0n);
  });
  describe("20,000 READY files", () => {
    const config = {
      bucket: "assets",
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      prefix: "fixture",
      forcePathStyle: true,
    };
    const locator = assetS3Locator(config);
    let f: Awaited<ReturnType<typeof fixture>>;
    let bytesTotal = 0;
    beforeAll(async () => {
      f = await fixture({ configuration: assetCacheConfiguration(locator, limit) });
      await f.cache.recover();
      const assetsStat = lstatSync(f.assetsDir, { bigint: true });
      mkdirSync(join(f.assetsDir, "objects"), { recursive: true });
      const objectsStat = lstatSync(join(f.assetsDir, "objects"), { bigint: true });
      const privateStat = lstatSync(join(f.assetsDir, ".private"), { bigint: true });
      const tmpStat = lstatSync(join(f.assetsDir, ".private", "tmp"), { bigint: true });
      const tempDirectory = `${assetsStat.dev}:${assetsStat.ino}/${privateStat.dev}:${privateStat.ino}/${tmpStat.dev}:${tmpStat.ino}`;
      let entries: CacheEntry[] = [];
      const insert = async () => {
        await db.query(
          "applier",
          `INSERT INTO asset_cache_entry SELECT * FROM jsonb_populate_recordset(NULL::asset_cache_entry,$1::jsonb)`,
          [JSON.stringify(entries)],
        );
        entries = [];
      };
      for (let i = 0; i < 20000; i++) {
        const bytes = Buffer.from(`populated-${i}`);
        const hash = digest(bytes);
        const path = objectPath(f, hash);
        const shard = join(f.assetsDir, "objects", hash.slice(7, 9));
        mkdirSync(shard, { recursive: true });
        writeFileSync(path, bytes);
        const st = lstatSync(path, { bigint: true });
        const dir = lstatSync(shard, { bigint: true });
        const incarnation = randomUUID();
        entries.push({
          cacheId: f.binding.cacheId,
          hash,
          incarnation,
          size: bytes.length,
          state: "READY",
          fillOwner: f.lifecycle.epoch,
          tempName: `cache-${incarnation}`,
          device: String(st.dev),
          inode: String(st.ino),
          mtimeNs: String(st.mtimeNs),
          ctimeNs: String(st.ctimeNs),
          finalAlias: true,
          tempDirectory,
          finalDirectory: `${assetsStat.dev}:${assetsStat.ino}/${objectsStat.dev}:${objectsStat.ino}/${dir.dev}:${dir.ino}`,
          cleanupAttempt: null,
          cleanupOwner: null,
          quotaReservations: [],
          lastFetchSequence: "0",
        });
        bytesTotal += bytes.length;
        if (entries.length === 1000) await insert();
      }
      await db.query("applier", 'UPDATE asset_cache_state SET "chargedBytes"=$2 WHERE id=$1', [
        f.binding.cacheId,
        bytesTotal,
      ]);
      // The preceding plan fixture analyzed a different cacheId. Keep these
      // 20k new rows absent from MCV statistics, as with offline cache seeding.
      // Check the actual production batch query before exercising both roles.
      const keys = await db.query(
        "applier",
        'SELECT hash FROM asset_cache_entry WHERE "cacheId"=$1 LIMIT 100',
        [f.binding.cacheId],
      );
      const inspected = createAssetCache({
        ...f,
        meter,
        transactions: (d, work) =>
          f.transactions(d, (q) =>
            work(async (sql, values) => {
              if (sql.includes("CROSS JOIN LATERAL")) {
                type Plan = {
                  "Relation Name"?: string;
                  "Index Name"?: string;
                  "Index Cond"?: string;
                  "Rows Removed by Filter"?: number;
                  Plans?: Plan[];
                };
                const result = await q<{ "QUERY PLAN": { Plan: Plan }[] }>(
                  `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,
                  values,
                );
                const scans: Plan[] = [];
                const walk = (plan: Plan) => {
                  if (plan["Relation Name"] === "asset_cache_entry") scans.push(plan);
                  plan.Plans?.forEach(walk);
                };
                walk(result.rows[0]!["QUERY PLAN"][0]!.Plan);
                expect(scans, JSON.stringify(result.rows)).toHaveLength(1);
                expect(scans[0]!["Index Name"], JSON.stringify(result.rows)).toBe(
                  "asset_cache_entry_pkey",
                );
                expect(scans[0]!["Index Cond"]).toContain("hash = a.value");
                expect(scans[0]!["Rows Removed by Filter"] ?? 0).toBe(0);
              }
              return q(sql, values);
            }),
          ),
      });
      await inspected.state.inspectAliases(
        "hash",
        keys.rows.map((row) => String(row.hash)),
        deadline(),
        () => undefined,
      );
      await f.lifecycle.stop();
    });
    it.each(["SERVER", "WORKER"] as const)(
      "restarts %s during a bucket outage using bounded batches",
      async (role) => {
        const remote = vi
          .spyOn(S3Client.prototype, "send")
          .mockRejectedValue(new Error("Bucket unavailable"));
        const lifecycle = life(role);
        const startedAt = Date.now();
        const attached = await attachRuntimeAssetCache({
          env: {
            KB_ASSET_S3_ENABLED: true,
            KB_ASSET_S3_BUCKET: config.bucket,
            KB_ASSET_S3_ENDPOINT: config.endpoint,
            KB_ASSET_S3_REGION: config.region,
            KB_ASSET_S3_PREFIX: config.prefix,
            KB_ASSET_S3_FORCE_PATH_STYLE: "true",
            KB_ASSET_CACHE_MAX_BYTES: String(limit),
          },
          assetsDir: f.assetsDir,
          connectionString: db.urls.applier,
          marker: {
            version: 1,
            mode: "s3",
            locator,
            activeGeneration: f.binding.storageGeneration,
          },
          lifecycle,
          assertRoleFence: noop,
        });
        console.info(
          "Populated cache restart evidence",
          JSON.stringify({ entries: 20000, role, elapsedMs: Date.now() - startedAt }),
        );
        expect(attached).toBeDefined();
        expect(await charged(f)).toBe(BigInt(bytesTotal));
        await lifecycle.stop();
        expect(remote).not.toHaveBeenCalled();
      },
    );
    it.each(["SERVER", "WORKER", "migration", "restore", "migration-worker"] as const)(
      "cancels %s through its production cache entry point mid-scan without leaking ownership",
      async (entry) => {
        const parent = new AbortController();
        const lifecycle = createAssetStorageLifecycle(
          entry === "WORKER" ? "WORKER" : "SERVER",
          parent.signal,
        );
        lives.push(lifecycle);
        const realOpen = fs.opendirSync;
        let inspected = 0;
        const cancelAt = entry === "migration-worker" ? 20001 : 1;
        const opening = vi.spyOn(fs, "opendirSync").mockImplementation((...args) => {
          const dir = realOpen(...args);
          const read = dir.readSync.bind(dir);
          vi.spyOn(dir, "readSync").mockImplementation(() => {
            const child = read();
            if (child && /^[a-f0-9]{62}$/.test(child.name)) {
              if (++inspected === cancelAt) parent.abort(new Error("Parent cancelled scan"));
            }
            return child;
          });
          return dir;
        });
        syncBuiltinESMExports();
        const input = {
          env: {
            KB_ASSET_S3_ENABLED: true,
            KB_ASSET_S3_BUCKET: config.bucket,
            KB_ASSET_S3_ENDPOINT: config.endpoint,
            KB_ASSET_S3_REGION: config.region,
            KB_ASSET_S3_PREFIX: config.prefix,
            KB_ASSET_S3_FORCE_PATH_STYLE: "true",
            KB_ASSET_CACHE_MAX_BYTES: String(limit),
          },
          assetsDir: f.assetsDir,
          connectionString: db.urls.applier,
          marker: {
            version: 1 as const,
            mode: "s3" as const,
            locator,
            activeGeneration: f.binding.storageGeneration,
          },
          lifecycle,
          assertRoleFence: noop,
        };
        let cancelledAt = 0;
        parent.signal.addEventListener(
          "abort",
          () => {
            cancelledAt = Date.now();
          },
          { once: true },
        );
        try {
          const starting =
            entry === "SERVER"
              ? createRuntimeAssetStore({
                  ...input,
                  env: {
                    ...input.env,
                    KB_ASSET_S3_ACCESS_KEY_ID: "fixture",
                    KB_ASSET_S3_SECRET_ACCESS_KEY: { reveal: () => "fixture" },
                  },
                })
              : entry === "WORKER"
                ? attachRuntimeAssetCache(input)
                : drainOfflineAssetCache({
                    assetsDir: f.assetsDir,
                    connectionString: db.urls.applier,
                    assertOfflineFences: noop,
                    discardReady: entry === "restore",
                    signal: parent.signal,
                  });
          await expect(starting).rejects.toThrow("Parent cancelled scan");
          await lifecycle.stop();
          expect(inspected).toBeGreaterThanOrEqual(cancelAt);
          expect(inspected).toBeLessThanOrEqual(cancelAt + 100);
          expect(Date.now() - cancelledAt).toBeLessThan(2000);
          expect(await charged(f)).toBe(BigInt(bytesTotal));
          const ownership = await db.query(
            "applier",
            `SELECT
            (SELECT count(*)::int FROM asset_cache_pin p JOIN asset_cache_owner o ON o.epoch=p."ownerEpoch" WHERE o."cacheId"=$1) AS pins,
            count(*) FILTER (WHERE "cleanupOwner" IS NOT NULL OR "cleanupAttempt" IS NOT NULL)::int AS claims,
            count(*) FILTER (WHERE cardinality("quotaReservations")>0)::int AS reservations,
            count(*) FILTER (WHERE state<>'READY')::int AS incomplete
            FROM asset_cache_entry WHERE "cacheId"=$1`,
            [f.binding.cacheId],
          );
          expect(ownership.rows[0]).toEqual({ pins: 0, claims: 0, reservations: 0, incomplete: 0 });
          console.info(
            "Populated cache cancellation evidence",
            JSON.stringify({
              entry,
              entries: 20000,
              inspected,
              cancellationMs: Date.now() - cancelledAt,
            }),
          );
        } finally {
          opening.mockRestore();
          syncBuiltinESMExports();
          await lifecycle.stop();
        }
      },
    );
  });
  it("cancels between reconciliation batches and can restart afterwards", async () => {
    const f = await fixture();
    await fill(f, Buffer.alloc(32, 41));
    await f.cache.recover();
    const observed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const lifecycle = life("WORKER");
    let inspections = 0;
    const transactions: AssetCacheTransactions = async (d, work) => {
      let batch = false;
      const result = await f.transactions(d, (q) =>
        work(async (sql, values) => {
          if (sql.includes('"hash"=a.value LIMIT 1')) {
            batch = true;
            inspections++;
          }
          return q(sql, values);
        }),
      );
      if (batch) {
        observed.resolve();
        await resume.promise;
      }
      return result;
    };
    const cache = createAssetCache({ ...f, transactions, lifecycle, meter });
    const starting = expect(cache.registerOwner(noop)).rejects.toThrow();
    await observed.promise;
    const stopping = lifecycle.stop();
    resume.resolve();
    await starting;
    await stopping;
    expect(inspections).toBe(1);
    await replace(f, "WORKER");
    expect(await charged(f)).toBe(32n);
  });
});
