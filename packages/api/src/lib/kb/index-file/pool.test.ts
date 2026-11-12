import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IndexFileMissingError, KbDomainError } from "../errors";
import { KB_LIMITS } from "../limits";
import {
  configureIndexReader,
  createIndexReaderPool,
  getIndexReader,
  HANDLE_CONFIRM_MS,
  type IndexReaderPool,
  type IndexReaderPoolOptions,
  resetIndexReaderForTests,
} from "./pool";
import type { ExpectedIndexMeta } from "./reader";
import type { IndexReadTask } from "./reader-thread";
import { type BuiltIndex, buildTestIndex } from "./testing";

const ENTRY = new URL("./reader-thread.ts", import.meta.url);
const KB_A = "kbaaaaaaaaaaaaaaaaaaaaaa";
const KB_B = "kbbbbbbbbbbbbbbbbbbbbbbb";
const GEN_A1 = "genaaaaaaaaaaaaaaaaaaaa1";
const GEN_A2 = "genaaaaaaaaaaaaaaaaaaaa2";
const GEN_B1 = "genbbbbbbbbbbbbbbbbbbbb1";
const GEN_BIG = "genbigbigbigbigbigbigbig";

let indexDir: string;
let a1: BuiltIndex;
let a2: BuiltIndex;
let b1: BuiltIndex;
let big: BuiltIndex;
const pools: IndexReaderPool[] = [];

beforeAll(async () => {
  indexDir = mkdtempSync(join(tmpdir(), "kb-index-pool-"));
  const small = [
    { path: "a.md", chunks: ["alpha bravo", "charlie"] },
    { path: "b.md", chunks: ["alpha delta"] },
  ];
  a1 = await buildTestIndex({ indexDir, documents: small, kbId: KB_A, generationId: GEN_A1 });
  a2 = await buildTestIndex({ indexDir, documents: small, kbId: KB_A, generationId: GEN_A2 });
  b1 = await buildTestIndex({ indexDir, documents: small, kbId: KB_B, generationId: GEN_B1 });
  // Large enough that a filtered task spends hundreds of ms building eligibility.
  big = await buildTestIndex({
    indexDir,
    kbId: KB_B,
    generationId: GEN_BIG,
    vectorBatch: 10_000,
    documents: Array.from({ length: 100 }, (_, d) => ({
      path: `d/${String(d).padStart(3, "0")}.md`,
      chunks: Array.from({ length: 1000 }, (_, c) => `w${c % 7} t${d}`),
    })),
  });
}, 120_000);

afterAll(() => {
  rmSync(indexDir, { recursive: true, force: true });
});

afterEach(async () => {
  resetIndexReaderForTests();
  await Promise.all(pools.splice(0).map((pool) => pool.stop()));
});

async function startPool(extra: Partial<IndexReaderPoolOptions> = {}) {
  const pool = createIndexReaderPool({
    entry: ENTRY,
    execArgv: ["--import", "tsx"],
    indexDir,
    ...extra,
  });
  pools.push(pool);
  await pool.start();
  return pool;
}

const hybrid = (pathPrefix: string | null = null): IndexReadTask => ({
  kind: "hybrid",
  input: {
    text: "alpha",
    vector: [1, 2, 3, 4, 5, 6, 7, 8],
    pathPrefix,
    documentId: null,
    filters: null,
  },
});
const slow: IndexReadTask = {
  kind: "queryless",
  input: { pathPrefix: null, documentId: null, filters: {}, after: null, limit: 5 },
};
const read = (
  pool: IndexReaderPool,
  expected: ExpectedIndexMeta,
  options: {
    task?: IndexReadTask;
    active?: boolean;
    signal?: AbortSignal;
    deadlineAt?: number;
  } = {},
) =>
  pool.read({
    task: options.task ?? hybrid(),
    expected,
    active: options.active ?? true,
    deadlineAt: options.deadlineAt ?? Date.now() + 60_000,
    signal: options.signal,
  });

const sideFiles = () =>
  [KB_A, KB_B].flatMap((kb) =>
    readdirSync(join(indexDir, kb)).filter((name) => /-(journal|wal|shm)$/.test(name)),
  );

/** Open file descriptors of this process (threads share them) that point at `path`. */
const fdsOn = (path: string) =>
  readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === path;
    } catch {
      return false;
    }
  }).length;

describe("index reader pool (real thread entry)", () => {
  it("starts after every thread's probe and reads read-only with no side files", async () => {
    const pool = await startPool();
    expect(pool.stats().threads).toBe(KB_LIMITS.serverIndexReaders);
    const outcome = await read(pool, a1.expected);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.fts.map((hit) => hit.path)).toEqual(["a.md", "b.md"]);
    expect(outcome.result.rows.length).toBeGreaterThan(0);
    const filtered = await read(pool, a1.expected, { task: hybrid("b") });
    expect(
      filtered.status === "ok" && filtered.result.rows.every((row) => row.path === "b.md"),
    ).toBe(true);
    expect(sideFiles()).toEqual([]);
    await pool.stop();
    expect(sideFiles()).toEqual([]);
  });

  it("rejects start() when a thread's probe fails", async () => {
    const pool = createIndexReaderPool({
      entry: ENTRY,
      execArgv: ["--import", "tsx"],
      indexDir,
      probeDir: join(indexDir, "no-such-dir"),
    });
    pools.push(pool);
    await expect(pool.start()).rejects.toThrow(/KB index reader probe failed: ENOENT/);
    expect(pool.stats().threads).toBe(0);
    await expect(read(pool, a1.expected)).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
  });

  it("reports a missing file as IndexFileMissingError (a KbDomainError)", async () => {
    const pool = await startPool();
    const error = await read(pool, {
      ...a1.expected,
      generationId: "genmissingmissingmissing",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IndexFileMissingError);
    expect(error).toBeInstanceOf(KbDomainError);
    expect(error).toMatchObject({ code: "INDEX_UNAVAILABLE" });
    const mismatch = await read(pool, { ...a1.expected, chunkCount: 99 }).catch(
      (caught: unknown) => caught,
    );
    expect(mismatch).toBeInstanceOf(KbDomainError);
    expect(mismatch).not.toBeInstanceOf(IndexFileMissingError);
  });

  it("an abort mid-task settles only after the thread acknowledges", async () => {
    const pool = await startPool();
    const controller = new AbortController();
    let settled = false;
    const pending = read(pool, big.expected, { task: slow, signal: controller.signal }).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
    );
    expect(pool.stats().busy).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(pool.stats().busy).toBe(1);
    await expect(pending).resolves.toEqual({ status: "aborted" });
    expect(pool.stats().busy).toBe(0);
  });

  it("stop() settles a dispatched read only after its thread has terminated", async () => {
    const pool = await startPool();
    let stopped = false;
    let fdsAtSettle = -1;
    const pending = read(pool, big.expected, { task: slow }).then(
      () => "resolved",
      (error: unknown) => {
        fdsAtSettle = fdsOn(big.path);
        expect(stopped).toBe(false);
        return error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.stats().busy).toBe(1);
    const stopping = pool.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    const outcome = await pending;
    await stopping;
    expect(outcome).toMatchObject({ code: "INDEX_UNAVAILABLE" });
    // The thread (and its handle on the file) was gone before the caller saw the settlement.
    expect(fdsAtSettle).toBe(0);
  });

  it("concurrent stop() callers all wait for termination and the dispatched read", async () => {
    const pool = await startPool();
    let settled = false;
    const pending = read(pool, big.expected, { task: slow }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.stats().busy).toBe(1);
    const first = pool.stop();
    const second = pool.stop();
    await second;
    expect(settled).toBe(true);
    expect(pool.stats().threads).toBe(0);
    await first;
    await pending;
  });

  it("stop() during start() rejects start instead of hanging", async () => {
    const pool = createIndexReaderPool({ entry: ENTRY, execArgv: ["--import", "tsx"], indexDir });
    pools.push(pool);
    const starting = pool.start();
    const stopping = pool.stop();
    const outcome = await Promise.race([
      starting.then(
        () => "started",
        (error: Error) => error.message,
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 20_000)),
    ]);
    expect(outcome).toBe("KB index reader pool stopped while starting");
    await stopping;
    expect(pool.stats().threads).toBe(0);
    await expect(read(pool, a1.expected)).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
  });

  it("never runs more than serverIndexReaders threads; queued tasks wait", async () => {
    const pool = await startPool();
    const all = Array.from({ length: 6 }, () => read(pool, big.expected, { task: slow }));
    expect(pool.stats()).toMatchObject({ threads: 2, busy: 2, queued: 4, posted: 2 });
    const outcomes = await Promise.all(all);
    expect(outcomes.every((outcome) => outcome.status === "ok")).toBe(true);
    expect(pool.stats()).toMatchObject({ threads: 2, busy: 0, queued: 0, posted: 6 });
  });

  it("the large lane leaves one thread for small tasks", async () => {
    // Treat the 100k-chunk file as large and the 3-chunk files as small.
    const pool = await startPool({ largeChunkThreshold: 1000 });
    const larges = [1, 2, 3].map(() => read(pool, big.expected, { task: slow }));
    expect(pool.stats()).toMatchObject({ busy: 1, largeRunning: 1, queued: 2 });
    const smallRead = read(pool, a1.expected);
    expect(pool.stats()).toMatchObject({ busy: 2, largeRunning: 1, queued: 2 });
    await expect(smallRead).resolves.toMatchObject({ status: "ok" });
    await Promise.all(larges);
  });

  it("a new active generation evicts the superseded handle in every thread", async () => {
    const pool = await startPool();
    await Promise.all([read(pool, a1.expected), read(pool, a1.expected)]);
    expect((await pool.threadStats()).flatMap((stats) => stats.handles)).toContain(GEN_A1);
    expect(fdsOn(a1.path)).toBeGreaterThan(0);
    await read(pool, a2.expected);
    const handles = (await pool.threadStats()).flatMap((stats) => stats.handles);
    expect(handles).not.toContain(GEN_A1);
    expect(handles).toContain(GEN_A2);
    expect(fdsOn(a1.path)).toBe(0);
    // A pinned (non-active) read closes its handle at task end.
    await read(pool, a1.expected, { active: false });
    expect((await pool.threadStats()).flatMap((stats) => stats.handles)).not.toContain(GEN_A1);
    expect(fdsOn(a1.path)).toBe(0);
  });

  it("closes a handle not confirmed for HANDLE_CONFIRM_MS on the next task (fake clock)", async () => {
    let now = 1_000_000;
    const pool = await startPool({ now: () => now });
    await read(pool, a1.expected);
    expect(fdsOn(a1.path)).toBe(1);
    now += HANDLE_CONFIRM_MS + 1;
    await read(pool, b1.expected);
    // The dispatched thread swept before its task; idle threads received the sweep broadcast.
    await pool.threadStats();
    expect(fdsOn(a1.path)).toBe(0);
    expect(fdsOn(b1.path)).toBe(1);
  });

  it("a queued task aborted while both threads are busy settles without being posted", async () => {
    const pool = await startPool();
    const busy = [
      read(pool, big.expected, { task: slow }),
      read(pool, big.expected, { task: slow }),
    ];
    const controller = new AbortController();
    const queued = read(pool, a1.expected, { signal: controller.signal });
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 1, posted: 2 });
    controller.abort();
    await expect(queued).resolves.toEqual({ status: "aborted" });
    expect(pool.stats()).toMatchObject({ queued: 0, posted: 2 });
    await Promise.all(busy);
    expect(pool.stats().posted).toBe(2);
  });

  it("a queued task past deadlineAt settles deadline at dequeue without being posted", async () => {
    const pool = await startPool();
    const busy = [
      read(pool, big.expected, { task: slow }),
      read(pool, big.expected, { task: slow }),
    ];
    const late = read(pool, a1.expected, { deadlineAt: Date.now() + 5 });
    await expect(late).resolves.toEqual({ status: "deadline" });
    await Promise.all(busy);
    expect(pool.stats().posted).toBe(2);
  });

  it("a thread receiving an already-aborted task opens nothing", async () => {
    const pool = await startPool({
      testHooks: { beforePost: (flag) => Atomics.store(flag, 0, 1) },
    });
    await expect(read(pool, a1.expected)).resolves.toEqual({ status: "aborted" });
    const stats = await pool.threadStats();
    expect(stats.reduce((sum, thread) => sum + thread.opens, 0)).toBe(0);
    expect(pool.stats().posted).toBe(1);
  });

  it("registers one pool for the server runtime", async () => {
    expect(() => getIndexReader()).toThrow("KB index reader is not configured");
    const pool = await startPool();
    configureIndexReader(pool);
    expect(getIndexReader()).toBe(pool);
    expect(dirname(a1.path)).toBe(join(indexDir, KB_A));
  });
});
