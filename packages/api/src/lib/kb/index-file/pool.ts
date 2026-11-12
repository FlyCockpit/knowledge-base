/**
 * Server index reader pool (§1.6): `KB_LIMITS.serverIndexReaders` worker threads, per-lane FIFO
 * queues (at most n-1 threads run "large" tasks), abort/deadline handling for queued and
 * dispatched tasks, handle eviction and stale-sweep broadcasts, and error reconstruction.
 * A dispatched task settles only on its thread's reply, so callers keep their slot (and their
 * Postgres `FOR KEY SHARE`) until the thread is idle again. `pool.read` is the only entry.
 */

import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { logEvent } from "@knowledge-base/env/log";
import { IndexFileMissingError, type KbDomainCode, KbDomainError } from "../errors";
import { KB_LIMITS } from "../limits";
import type { ExpectedIndexMeta, HybridTaskResult, IndexCitationRow } from "./reader";
import type {
  FromThread,
  IndexReadTask,
  ReaderThreadData,
  TaskReply,
  ToThread,
} from "./reader-thread";

/** A cached handle not confirmed active for this long is closed (≪ 7 d retention). */
export const HANDLE_CONFIRM_MS = 10 * 60_000;
/** Stale-handle sweep broadcast to idle threads at most this often (only when tasks run). */
const HANDLE_SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_HANDLES_PER_THREAD = 16;

const PASSTHROUGH_CODES = new Set<KbDomainCode>([
  "INDEX_UNAVAILABLE",
  "INVALID_CURSOR",
  "DEADLINE_EXCEEDED",
  "CANCELLED",
]);
const CODE_MESSAGES: Partial<Record<KbDomainCode, string>> = {
  INDEX_UNAVAILABLE: "Index unavailable",
  INVALID_CURSOR: "Invalid cursor",
  DEADLINE_EXCEEDED: "Deadline exceeded",
  CANCELLED: "Cancelled",
};

export type IndexReaderPoolOptions = {
  /** Thread entry: `kb-index-reader.mjs` (built) or `.ts` with `--import tsx` (source). */
  entry: URL;
  execArgv: string[];
  indexDir: string;
  /** Where each thread writes its start-probe copy (default: the OS temp dir). */
  probeDir?: string;
  threads?: number;
  /** Tasks on generations above this chunk count use the large lane. */
  largeChunkThreshold?: number;
  /** Clock for handle confirmation and sweeps (tests inject a fake one). */
  now?: () => number;
  log?: (message: string, detail: Record<string, unknown>) => void;
  /** Deterministic test seams only; production passes none. */
  testHooks?: {
    beforePost?: (abortFlag: Int32Array) => void;
    /** Sleep at every check point inside the reader threads (slow, observable reads). */
    checkDelayMs?: number;
  };
};

type ResultOf<T extends IndexReadTask> = T["kind"] extends "hybrid"
  ? HybridTaskResult
  : IndexCitationRow[];

type IndexReadRequest<T extends IndexReadTask = IndexReadTask> = {
  task: T;
  expected: ExpectedIndexMeta;
  /** The generation is the KB's active one in the caller's Postgres snapshot. */
  active: boolean;
  deadlineAt: number;
  signal?: AbortSignal;
};

type IndexReadOutcome<R> = { status: "ok"; result: R } | { status: "aborted" | "deadline" };

export type IndexReaderPool = {
  start(): Promise<void>;
  stop(): Promise<void>;
  read<T extends IndexReadTask>(
    request: IndexReadRequest<T>,
  ): Promise<IndexReadOutcome<ResultOf<T>>>;
  stats(): { threads: number; busy: number; largeRunning: number; queued: number; posted: number };
  threadStats(): Promise<Array<{ opens: number; handles: string[] }>>;
};

type Pending = {
  id: number;
  seq: number;
  request: IndexReadRequest;
  large: boolean;
  abort: Int32Array;
  posted: boolean;
  settle: (reply: TaskReply) => void;
  fail: (error: Error) => void;
  detach: () => void;
};

type Slot = {
  worker: Worker;
  busy: Pending | null;
  probes: Array<(reply: Extract<FromThread, { type: "probe" }>) => void>;
  stats: Array<(reply: Extract<FromThread, { type: "stats" }>) => void>;
};

function rebuildError(
  reply: Extract<TaskReply, { status: "error" }>,
  log: IndexReaderPoolOptions["log"],
) {
  if (reply.fileMissing) return new IndexFileMissingError();
  if (PASSTHROUGH_CODES.has(reply.code))
    return new KbDomainError(reply.code, CODE_MESSAGES[reply.code] ?? "Index unavailable");
  log?.("[kb] index reader returned an unexpected code", { code: reply.code });
  return new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
}

export function createIndexReaderPool(options: IndexReaderPoolOptions): IndexReaderPool {
  const threads = options.threads ?? KB_LIMITS.serverIndexReaders;
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error("Invalid reader thread count");
  const largeThreshold = options.largeChunkThreshold ?? KB_LIMITS.indexChunksDefault;
  const maxLarge = Math.max(1, threads - 1);
  const now = options.now ?? Date.now;
  // Typed fields only (exit code, reply code), never error text.
  const log =
    options.log ??
    ((_message, fields) =>
      logEvent("kb.index-reader", {
        code: typeof fields.code === "string" ? fields.code : undefined,
        exitCode: typeof fields.exitCode === "number" ? fields.exitCode : undefined,
      }));
  const data: ReaderThreadData = {
    kbIndexReader: true,
    indexDir: options.indexDir,
    probeDir: options.probeDir ?? tmpdir(),
    handleConfirmMs: HANDLE_CONFIRM_MS,
    maxHandles: MAX_HANDLES_PER_THREAD,
    ...(options.testHooks?.checkDelayMs
      ? { testCheckDelayMs: options.testHooks.checkDelayMs }
      : {}),
  };
  const slots: Slot[] = [];
  const small: Pending[] = [];
  const large: Pending[] = [];
  const activeByKb = new Map<string, string>();
  let nextId = 1;
  let posted = 0;
  let lastSweep = Number.NEGATIVE_INFINITY;
  let state: "new" | "starting" | "running" | "stopped" = "new";
  let stopping: Promise<void> | null = null;

  const post = (slot: Slot, message: ToThread) => slot.worker.postMessage(message);

  const spawn = (): Slot => {
    const slot: Slot = {
      worker: new Worker(options.entry, { execArgv: options.execArgv, workerData: data }),
      busy: null,
      probes: [],
      stats: [],
    };
    slot.worker.on("message", (message: FromThread) => {
      if (message.type === "probe") slot.probes.shift()?.(message);
      else if (message.type === "stats") slot.stats.shift()?.(message);
      else {
        const pending = slot.busy;
        // While stopping, dispatched reads settle only after their thread terminated.
        if (state === "stopped" || !pending || pending.id !== message.id) return;
        slot.busy = null;
        pending.settle(message);
        pump();
      }
    });
    const lost = (detail: Record<string, unknown>) => {
      const index = slots.indexOf(slot);
      if (index < 0) return;
      for (const waiter of slot.probes.splice(0))
        waiter({ type: "probe", ok: false, message: "reader thread exited" });
      slot.busy?.fail(new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable"));
      slot.busy = null;
      if (state !== "running") return;
      log("[kb] index reader thread lost; replacing it", detail);
      slots[index] = spawn();
      pump();
    };
    slot.worker.on("error", (error: Error) => lost({ error: error.name }));
    slot.worker.on("exit", (code) => lost({ exitCode: code }));
    return slot;
  };

  const settleWith = (pending: Pending, reply: TaskReply) => {
    pending.detach();
    pending.settle(reply);
  };

  const takeNext = (): Pending | undefined => {
    const largeRunning = slots.filter((slot) => slot.busy?.large).length;
    const smallHead = small[0];
    const largeHead = largeRunning < maxLarge ? large[0] : undefined;
    if (smallHead && (!largeHead || smallHead.seq < largeHead.seq)) return small.shift();
    if (largeHead) return large.shift();
    return undefined;
  };

  function pump(): void {
    if (state !== "running") return;
    for (const slot of slots) {
      while (!slot.busy) {
        const pending = takeNext();
        if (!pending) return;
        // Queue wait counts against the deadline: an expired task is never posted.
        if (Date.now() >= pending.request.deadlineAt) {
          settleWith(pending, { status: "deadline" });
          continue;
        }
        dispatch(slot, pending);
      }
    }
  }

  function dispatch(slot: Slot, pending: Pending): void {
    const { request } = pending;
    const at = now();
    if (request.active && activeByKb.get(request.expected.kbId) !== request.expected.generationId) {
      activeByKb.set(request.expected.kbId, request.expected.generationId);
      for (const each of slots)
        post(each, {
          type: "evict",
          kbId: request.expected.kbId,
          keep: request.expected.generationId,
          now: at,
        });
    }
    if (at - lastSweep >= HANDLE_SWEEP_INTERVAL_MS) {
      lastSweep = at;
      for (const each of slots)
        if (!each.busy && each !== slot) post(each, { type: "sweep", now: at });
    }
    slot.busy = pending;
    pending.posted = true;
    options.testHooks?.beforePost?.(pending.abort);
    posted += 1;
    post(slot, {
      type: "task",
      id: pending.id,
      task: request.task,
      expected: request.expected,
      active: request.active,
      abort: pending.abort,
      deadlineAt: request.deadlineAt,
      now: at,
    });
  }

  const pool: IndexReaderPool = {
    async start() {
      if (state !== "new") throw new Error("KB index reader pool already started");
      state = "starting";
      for (let i = 0; i < threads; i++) slots.push(spawn());
      const results = await Promise.all(
        slots.map(
          (slot) =>
            new Promise<Extract<FromThread, { type: "probe" }>>((resolve) => {
              slot.probes.push(resolve);
              post(slot, { type: "probe" });
            }),
        ),
      );
      if (state !== "starting") throw new Error("KB index reader pool stopped while starting");
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) {
        await pool.stop();
        throw new Error(`KB index reader probe failed: ${failed.message}`);
      }
      state = "running";
      pump();
    },

    stop() {
      // Every caller waits for the same, complete shutdown.
      stopping ??= (async () => {
        state = "stopped";
        for (const pending of [...small.splice(0), ...large.splice(0)])
          settleWith(pending, { status: "aborted" });
        const stopped = slots.splice(0);
        // A start() still waiting on probes must not hang on threads that are going away.
        for (const slot of stopped)
          for (const waiter of slot.probes.splice(0))
            waiter({ type: "probe", ok: false, message: "reader pool stopped" });
        await Promise.all(
          stopped.map(async (slot) => {
            // A dispatched read settles only once its thread is gone: callers keep their slot
            // and Postgres lock until no native work on the file can still be running (§1.6).
            await slot.worker.terminate();
            slot.busy?.fail(new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable"));
            slot.busy = null;
          }),
        );
      })();
      return stopping;
    },

    read(request) {
      return new Promise((resolve, reject) => {
        if (state !== "running") {
          reject(new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable"));
          return;
        }
        if (request.signal?.aborted) {
          resolve({ status: "aborted" });
          return;
        }
        if (Date.now() >= request.deadlineAt) {
          resolve({ status: "deadline" });
          return;
        }
        const id = nextId++;
        const pending: Pending = {
          id,
          seq: id,
          request,
          large: request.expected.chunkCount > largeThreshold,
          abort: new Int32Array(new SharedArrayBuffer(4)),
          posted: false,
          detach: () => request.signal?.removeEventListener("abort", onAbort),
          settle: (reply) => {
            pending.detach();
            if (reply.status === "error") reject(rebuildError(reply, log));
            else if (reply.status === "ok")
              resolve({ status: "ok", result: reply.result as ResultOf<typeof request.task> });
            else resolve({ status: reply.status });
          },
          fail: (error) => {
            pending.detach();
            reject(error);
          },
        };
        function onAbort() {
          if (pending.posted) {
            // Dispatched: the thread stops at its next check and acknowledges.
            Atomics.store(pending.abort, 0, 1);
            return;
          }
          const queue = pending.large ? large : small;
          const index = queue.indexOf(pending);
          if (index >= 0) queue.splice(index, 1);
          settleWith(pending, { status: "aborted" });
        }
        request.signal?.addEventListener("abort", onAbort, { once: true });
        (pending.large ? large : small).push(pending);
        pump();
      });
    },

    stats() {
      return {
        threads: slots.length,
        busy: slots.filter((slot) => slot.busy).length,
        largeRunning: slots.filter((slot) => slot.busy?.large).length,
        queued: small.length + large.length,
        posted,
      };
    },

    threadStats() {
      return Promise.all(
        slots.map(
          (slot) =>
            new Promise<{ opens: number; handles: string[] }>((resolve) => {
              slot.stats.push(({ opens, handles }) => resolve({ opens, handles }));
              post(slot, { type: "stats" });
            }),
        ),
      );
    },
  };
  return pool;
}

let configured: IndexReaderPool | null = null;

export function configureIndexReader(pool: IndexReaderPool): void {
  configured = pool;
}

export function getIndexReader(): IndexReaderPool {
  if (!configured) throw new Error("KB index reader is not configured");
  return configured;
}

export function resetIndexReaderForTests(): void {
  configured = null;
}
