/**
 * Index reader thread entry (`worker_threads`). Single-flight: one message at a time. Posts only
 * plain data: `{status:'ok', result}` | `{status:'aborted'|'deadline'}` |
 * `{status:'error', code, fileMissing}` (CL-RETRY). Caches read-only handles keyed by generation
 * id with `confirmedAt` (decision 6, CL-READPOOL); no timers.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import type { KbDomainCode } from "../errors";
import { generationFilePath } from "./format";
import { PROBE_EXPECTED, PROBE_FTS_TERM, PROBE_INDEX_GZIP_BASE64 } from "./probe-fixture";
import {
  closeIndexHandle,
  type ExpectedIndexMeta,
  type HybridTaskInput,
  type IndexHandle,
  IndexReadError,
  IndexTaskStopped,
  openIndexReadOnly,
  probeIndexHandle,
  type QuerylessTaskInput,
  readHybridTask,
  readQuerylessTask,
  taskControl,
} from "./reader";

export type IndexReadTask =
  | { kind: "hybrid"; input: HybridTaskInput }
  | { kind: "queryless"; input: QuerylessTaskInput };

export type ReaderThreadData = {
  /** Marks a thread started by the index reader pool (never any other worker). */
  kbIndexReader: true;
  indexDir: string;
  /** Directory for the start probe's private copy of the probe fixture. */
  probeDir: string;
  handleConfirmMs: number;
  maxHandles: number;
  /** Test seam only: sleep this long at every task check point (slow, observable reads). */
  testCheckDelayMs?: number;
};

export type ToThread =
  | {
      type: "task";
      id: number;
      task: IndexReadTask;
      expected: ExpectedIndexMeta;
      /** The task carried this generation as the KB's active id (read in the same PG tx). */
      active: boolean;
      abort: Int32Array;
      deadlineAt: number;
      now: number;
    }
  | { type: "evict"; kbId: string; keep: string; now: number }
  | { type: "sweep"; now: number }
  | { type: "probe" }
  | { type: "stats" };

export type TaskReply =
  | { status: "ok"; result: unknown }
  | { status: "aborted" | "deadline" }
  | { status: "error"; code: KbDomainCode; fileMissing: boolean };

export type FromThread =
  | ({ type: "result"; id: number } & TaskReply)
  | { type: "probe"; ok: true }
  | { type: "probe"; ok: false; message: string }
  | { type: "stats"; opens: number; handles: string[] };

type CacheEntry = { handle: IndexHandle; kbId: string; confirmedAt: number };

function sameExpected(a: ExpectedIndexMeta, b: ExpectedIndexMeta): boolean {
  return (
    a.generationId === b.generationId &&
    a.kbId === b.kbId &&
    a.commitSha === b.commitSha &&
    a.fingerprint === b.fingerprint &&
    a.dimensions === b.dimensions &&
    a.chunkCount === b.chunkCount &&
    a.documentCount === b.documentCount
  );
}

/** The thread's state machine, separated from the port so it can be driven inline. */
export function createReaderThreadState(
  data: ReaderThreadData,
  /** Test seam only: observe each handle the thread opens. */
  hooks: { opened?: (handle: IndexHandle) => void } = {},
) {
  const cache = new Map<string, CacheEntry>();
  let opens = 0;

  const drop = (generationId: string) => {
    const entry = cache.get(generationId);
    if (!entry) return;
    cache.delete(generationId);
    closeIndexHandle(entry.handle);
  };
  const sweep = (now: number) => {
    for (const [id, entry] of cache)
      if (entry.handle.closed || now - entry.confirmedAt > data.handleConfirmMs) drop(id);
  };
  const capCache = () => {
    while (cache.size > data.maxHandles) {
      let oldest: [string, CacheEntry] | null = null;
      for (const item of cache)
        if (!oldest || item[1].confirmedAt < oldest[1].confirmedAt) oldest = item;
      if (!oldest) return;
      drop(oldest[0]);
    }
  };

  const run = (message: Extract<ToThread, { type: "task" }>): TaskReply => {
    sweep(message.now);
    const control = taskControl(message.abort, message.deadlineAt);
    const delay = data.testCheckDelayMs ?? 0;
    const sleeper = delay > 0 ? new Int32Array(new SharedArrayBuffer(4)) : null;
    const ctl = sleeper
      ? {
          check() {
            Atomics.wait(sleeper, 0, 0, delay);
            control.check();
          },
        }
      : control;
    let entry: CacheEntry | undefined;
    try {
      // Re-check before touching the file: an aborted or expired task opens nothing.
      ctl.check();
      entry = cache.get(message.expected.generationId);
      if (entry && (entry.handle.closed || !sameExpected(entry.handle.meta, message.expected))) {
        drop(message.expected.generationId);
        entry = undefined;
      }
      if (!entry) {
        opens += 1;
        entry = {
          handle: openIndexReadOnly(data.indexDir, message.expected),
          kbId: message.expected.kbId,
          confirmedAt: message.now,
        };
        hooks.opened?.(entry.handle);
        cache.set(message.expected.generationId, entry);
        capCache();
      }
      if (message.active) entry.confirmedAt = message.now;
      const result =
        message.task.kind === "hybrid"
          ? readHybridTask(entry.handle, message.task.input, ctl)
          : readQuerylessTask(entry.handle, message.task.input, ctl);
      return { status: "ok", result };
    } catch (error) {
      if (error instanceof IndexTaskStopped) return { status: error.status };
      if (entry) drop(message.expected.generationId);
      if (error instanceof IndexReadError)
        return { status: "error", code: error.code, fileMissing: error.fileMissing };
      return { status: "error", code: "INDEX_UNAVAILABLE", fileMissing: false };
    } finally {
      // Pinned (non-active) handles close at task end; a ROLLBACK failure already closed one.
      const cached = cache.get(message.expected.generationId);
      if (cached && (!message.active || cached.handle.closed)) drop(message.expected.generationId);
    }
  };

  const probe = (): FromThread => {
    let root: string | null = null;
    try {
      root = mkdtempSync(join(data.probeDir, "kb-index-probe-"));
      const path = generationFilePath(root, PROBE_EXPECTED.kbId, PROBE_EXPECTED.generationId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, gunzipSync(Buffer.from(PROBE_INDEX_GZIP_BASE64, "base64")), {
        flag: "wx",
        mode: 0o444,
      });
      chmodSync(path, 0o444);
      const handle = openIndexReadOnly(root, PROBE_EXPECTED);
      try {
        probeIndexHandle(handle, PROBE_FTS_TERM);
      } finally {
        closeIndexHandle(handle);
      }
      return { type: "probe", ok: true };
    } catch (error) {
      return {
        type: "probe",
        ok: false,
        message: error instanceof Error ? error.message : "index probe failed",
      };
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  };

  return {
    handle(message: ToThread): FromThread | null {
      switch (message.type) {
        case "task":
          return { type: "result", id: message.id, ...run(message) };
        case "evict":
          for (const [id, entry] of cache)
            if (entry.kbId === message.kbId && id !== message.keep) drop(id);
          return null;
        case "sweep":
          sweep(message.now);
          return null;
        case "probe":
          return probe();
        case "stats":
          return { type: "stats", opens, handles: [...cache.keys()] };
      }
    },
    close() {
      for (const id of [...cache.keys()]) drop(id);
    },
  };
}

if (
  !isMainThread &&
  parentPort &&
  typeof workerData === "object" &&
  workerData !== null &&
  (workerData as Partial<ReaderThreadData>).kbIndexReader === true
) {
  const port = parentPort;
  const state = createReaderThreadState(workerData as ReaderThreadData);
  port.on("message", (message: ToThread) => {
    const reply = state.handle(message);
    if (reply) port.postMessage(reply);
  });
}
