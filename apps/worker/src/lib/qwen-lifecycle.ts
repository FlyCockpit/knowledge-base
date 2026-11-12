/**
 * Parent-side supervisor for the selected built-in model child.
 *
 * Invariants:
 * - The parent never imports the native addon; it forks `qwen-child.mjs` through
 *   the native parent-death guard (src/native/child-guard.c) with IPC and a
 *   minimal env (no DB URL, no master key).
 * - At most one child and one execution at a time. Queries have priority, but
 *   after QWEN_QUERY_BURST consecutive query executions one waiting index batch
 *   runs, so neither class starves. Waiting work is bounded per class.
 * - Idle = no running and no admitted waiting work for QWEN_IDLE_MS: the child
 *   is asked to exit, SIGKILLed after a grace, and the parent awaits the OS exit
 *   (Node reaps on `exit`) and confirms the PID is gone before a reload may spawn.
 * - Every execution attempt carries a fresh token; replies are accepted only
 *   from the current child for the current token. A crash retries the same
 *   request once on a new child, then fails visibly.
 * - disable()/close() fence all admitted work, SIGKILL and reap the child.
 * - The model volume lease is held from spawn until the child is reaped; losing
 *   it kills the child.
 * - A child runs exactly one READY runtime: the model epoch plus the admin
 *   runtime config (context, K/V cache types), passed through its env.
 *   A request for another runtime replaces the child before dispatch.
 * - Config load probes run in a separate, never-serving probe child
 *   that is always killed and reaped. Side by side, the serving child keeps
 *   working; stop-then-probe first `suspend()`s serving: the running batch
 *   finishes, the child is stopped, queries fail fast (search degrades to
 *   lexical) and documents wait until `resume()`.
 * - The volume lease is reference-counted: serving child, probe child and a
 *   probe tick's hold share one acquisition; it is released when the last
 *   holder lets go. Acquire/release run strictly in order.
 *
 * Lock/ownership order: supervisor state is single-threaded (event loop); the
 * only cross-process owner is the DB volume lease, acquired before spawn and
 * released after reap.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { builtinModel } from "@knowledge-base/api/lib/kb/builtin-model";
import {
  EmbedderCallError,
  EmbeddingInputTooLongError,
  EmbeddingUnavailableError,
  validateEmbeddings,
} from "@knowledge-base/api/lib/kb/embed-client";
import type { Embedder } from "@knowledge-base/api/lib/kb/embedder";
import { KB_LIMITS } from "@knowledge-base/api/lib/kb/limits";
import type { ModelRuntimeIo } from "@knowledge-base/api/lib/kb/local-model";
import {
  assessBuiltinRuntimeConfig,
  chooseBuiltinProbeMode,
  type QwenRuntimeConfig,
  qwenRuntimeKey,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import {
  prepareEmbeddingDocument,
  prepareEmbeddingQuery,
} from "@knowledge-base/api/lib/kb/redact-for-embed";
import { logEvent } from "@knowledge-base/env/log";
import { detectMemoryBudget } from "./memory-budget";
import type { ParentToChild, QwenPurpose } from "./qwen-child";

export const QWEN_IDLE_MS = 15 * 60 * 1000;
export const QWEN_QUERY_BURST = 4;
export const QWEN_MAX_WAITING = Object.freeze({
  query: KB_LIMITS.workerQueryConcurrency,
  document: KB_LIMITS.workerIndexConcurrency,
});
export const QWEN_TERM_GRACE_MS = 5_000;
export const QWEN_LEASE_RENEW_MS = 10_000;
export const QWEN_LEASE_RENEW_TIMEOUT_MS = 5_000;
/** One budget from queue admission through load, execution and the single retry. */
export const QWEN_SERVING_TIMEOUT_MS = 120_000;
/** Installed by Dockerfile.worker's native stage. */
export const QWEN_CHILD_GUARD_PATH = "/usr/local/bin/kb-child-guard";
const MAX_TEXTS = 32;

export class QwenQueueFullError extends Error {
  override name = "QwenQueueFullError";
}
export class QwenDisabledError extends Error {
  override name = "QwenDisabledError";
}
/** The model child died on (or before answering) a request: a child-boundary failure (tag). */
export class QwenChildCrashedError extends EmbedderCallError {
  override name = "QwenChildCrashedError";
}
export class QwenVolumeBusyError extends Error {
  override name = "QwenVolumeBusyError";
}
export const QWEN_PROBE_ERROR_CODES = [
  "MODEL_CONFIG_PROBE_FAILED",
  "MODEL_CONFIG_PROBE_TIMEOUT",
] as const;
/** A candidate runtime config failed its load probe (fixed code, no native detail). */
export class QwenProbeError extends Error {
  override name = "QwenProbeError";
  constructor(readonly code: (typeof QWEN_PROBE_ERROR_CODES)[number]) {
    super(code);
  }
}
export const QWEN_PROBE_TIMEOUT_MS = 120_000;

/** The subset of ChildProcess the supervisor uses. */
export type QwenChildHandle = {
  pid?: number | undefined;
  stdout?: Readable | null;
  stderr?: Readable | null;
  send(message: ParentToChild): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
};

type Clock = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type QwenVolumeLease = {
  acquire(signal?: AbortSignal): Promise<boolean>;
  renew(signal?: AbortSignal): Promise<boolean>;
  release(): Promise<void>;
};

/** The READY model epoch and the runtime config the child must run under. */
export type QwenReadyRuntime = { modelId: string; epoch: number; config: QwenRuntimeConfig };
const runtimeKey = (runtime: QwenReadyRuntime) =>
  `${runtime.modelId}:${runtime.epoch}:${qwenRuntimeKey(runtime.config)}`;

export type QwenSupervisorOptions = {
  childEntry: string;
  modelPath: string;
  modelsDir?: string;
  guardPath?: string;
  lease: QwenVolumeLease;
  idleMs?: number;
  termGraceMs?: number;
  leaseRenewMs?: number;
  leaseRenewTimeoutMs?: number;
  servingTimeoutMs?: number;
  clock?: Clock;
  /** Re-read on every spawn; production always uses this worker's cgroup detector. */
  budgetBytes?: () => number | null;
  childEnv?: Record<string, string>;
  spawn?: (
    command: string,
    args: string[],
    options: { stdio: Array<"ignore" | "pipe" | "ipc">; env: Record<string, string> },
  ) => QwenChildHandle;
  pidAlive?: (pid: number) => boolean;
  /** Child-reported peak RSS (VmHWM) after an execution, with the runtime it ran. */
  onPeakRss?: (bytes: number, runtime: QwenReadyRuntime) => void;
};

export type QwenEmbedInput = {
  purpose: QwenPurpose;
  texts: string[];
  runtime: QwenReadyRuntime;
  signal?: AbortSignal;
};

type Outcome =
  | { kind: "result"; vectors: unknown; peakRssBytes: unknown }
  | { kind: "counts"; counts: unknown; limit: unknown }
  | { kind: "error"; code: string }
  | { kind: "crashed" };

type Slot = {
  handle: QwenChildHandle;
  pid: number | null;
  runtime: QwenReadyRuntime;
  ready: Promise<boolean>;
  exited: Promise<void>;
  isExited: () => boolean;
  pending: { token: string; settle(outcome: Outcome): void } | null;
  /** Highest VmHWM already reported for this child (VmHWM only grows). */
  reportedPeak: number;
  stopping: Promise<void> | null;
  finalized: Promise<void>;
};

type Request = QwenEmbedInput & {
  op: "embed" | "count";
  fence: number;
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  detach(): void;
  controller: AbortController;
  child: Slot | null;
};

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const realClock: Clock = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createQwenSupervisor(options: QwenSupervisorOptions) {
  const modelFor = (runtime: QwenReadyRuntime) => builtinModel(runtime.modelId);
  const idleMs = options.idleMs ?? QWEN_IDLE_MS;
  const graceMs = options.termGraceMs ?? QWEN_TERM_GRACE_MS;
  const clock = options.clock ?? realClock;
  const spawnChild =
    options.spawn ??
    ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions) as QwenChildHandle);
  const pidAlive = options.pidAlive ?? defaultPidAlive;
  const guardPath = options.guardPath ?? QWEN_CHILD_GUARD_PATH;

  const waiting: Record<QwenPurpose, Request[]> = { query: [], document: [] };
  let consecutiveQueries = 0;
  let running: Request | null = null;
  let slot: Slot | null = null;
  let idleTimer: unknown = null;
  let fence = 0;
  let closed = false;
  let spawns = 0;
  let draining = false;
  let drained: Promise<void> = Promise.resolve();
  let markDrained: () => void = () => {};
  let suspended = false;
  const children = new Set<Slot>();
  const probes = new Map<AbortController, Promise<void>>();
  let disabling: Promise<void> | null = null;
  let leaseHolds = 0;
  let leaseChain: Promise<unknown> = Promise.resolve();
  let leaseLost = false;
  let renewTimer: ReturnType<typeof setInterval> | undefined;
  let renewal: Promise<void> | undefined;
  let renewalController: AbortController | undefined;

  function loseLease() {
    leaseLost = true;
    running?.controller.abort(new EmbeddingUnavailableError());
    for (const controller of probes.keys())
      controller.abort(new QwenProbeError("MODEL_CONFIG_PROBE_FAILED"));
    rejectWaiting(() => new EmbeddingUnavailableError());
    for (const child of children) void stopSlot(child, "kill").catch(() => {});
  }

  function startRenewal() {
    renewTimer = setInterval(() => {
      // A tick never queues behind a blocked renewal, even with two model children.
      if (renewal || leaseLost || leaseHolds === 0) return;
      const controller = new AbortController();
      renewalController = controller;
      const deadline = setTimeout(() => {
        controller.abort();
        if (leaseHolds > 0) loseLease();
      }, options.leaseRenewTimeoutMs ?? QWEN_LEASE_RENEW_TIMEOUT_MS);
      renewal = Promise.resolve()
        .then(() => options.lease.renew(controller.signal))
        .then(
          (ok) => {
            if (leaseHolds > 0 && (!ok || controller.signal.aborted)) loseLease();
          },
          () => {
            if (leaseHolds > 0) loseLease();
          },
        )
        .finally(() => {
          clearTimeout(deadline);
          renewal = undefined;
          renewalController = undefined;
        });
    }, options.leaseRenewMs ?? QWEN_LEASE_RENEW_MS);
    renewTimer.unref?.();
  }

  function serialLease<T>(work: () => Promise<T>): Promise<T> {
    const run = leaseChain.then(work, work);
    leaseChain = run.catch(() => {});
    return run;
  }
  /** One acquisition shared by every holder; false when another worker owns the volume. */
  function holdLease(signal?: AbortSignal): Promise<boolean> {
    const admittedFence = fence;
    return serialLease(async () => {
      if (closed || disabling || admittedFence !== fence || signal?.aborted) return false;
      if (leaseHolds > 0) {
        if (leaseLost) return false;
        leaseHolds += 1;
        return true;
      }
      const ok = await options.lease.acquire(signal);
      // Acquisition is joined, never detached. A late acquisition cannot spawn
      // after cancellation/close, and its permit is returned on this same chain.
      if (!ok) return false;
      if (closed || disabling || admittedFence !== fence || signal?.aborted) {
        await options.lease.release();
        return false;
      }
      leaseHolds = 1;
      leaseLost = false;
      startRenewal();
      return true;
    });
  }
  function dropLease(): Promise<void> {
    return serialLease(async () => {
      if (leaseHolds === 0) return;
      leaseHolds -= 1;
      if (leaseHolds === 0) {
        clearInterval(renewTimer);
        renewTimer = undefined;
        renewalController?.abort();
        // No heartbeat may mutate a successor acquisition after release.
        await renewal;
        await options.lease.release();
      }
    });
  }

  function assertRequest(request: Request) {
    if (request.fence !== fence || closed) throw new QwenDisabledError();
    request.controller.signal.throwIfAborted();
  }

  /** Only waits without external effects may race cancellation. Acquisition and
   * child/SQL finalization are always joined by their owner before settlement. */
  async function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  function clearIdle() {
    if (idleTimer !== null) clock.clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle() {
    clearIdle();
    const current = slot;
    if (!current || running || waiting.query.length || waiting.document.length) return;
    idleTimer = clock.setTimeout(() => {
      idleTimer = null;
      if (slot === current && !running && !waiting.query.length && !waiting.document.length)
        void stopSlot(current, "graceful").catch(() => {});
    }, idleMs);
  }

  function spawnSlot(runtime: QwenReadyRuntime): Slot {
    const budgetBytes = (
      options.budgetBytes ?? (() => detectMemoryBudget()?.budgetBytes ?? null)
    )();
    const admission = assessBuiltinRuntimeConfig(modelFor(runtime), runtime.config, budgetBytes);
    if (admission.level === "block" || admission.level === "unknown")
      throw new EmbeddingUnavailableError();
    if (
      slot &&
      chooseBuiltinProbeMode({
        activeModel: modelFor(slot.runtime),
        candidateModel: modelFor(runtime),
        active: slot.runtime.config,
        activePeakBytes: slot.reportedPeak || null,
        candidate: runtime.config,
        budgetBytes,
      }).mode === "exclusive"
    )
      throw new EmbeddingUnavailableError();
    const descriptor = modelFor(runtime);
    spawns += 1;
    const handle = spawnChild(
      guardPath,
      [String(process.pid), process.execPath, options.childEntry, descriptor.modelId],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // Minimal env: never DATABASE_URL, KB_MASTER_KEY or provider secrets.
        env: {
          ...options.childEnv,
          KB_QWEN_CHILD: "1",
          KB_QWEN_MODEL_PATH: join(
            options.modelsDir ?? dirname(options.modelPath),
            descriptor.fileName,
          ),
          KB_QWEN_CONTEXT_TOKENS: String(runtime.config.contextTokens),
          KB_QWEN_KV_KEY_TYPE: runtime.config.kvKeyType,
          KB_QWEN_KV_VALUE_TYPE: runtime.config.kvValueType,
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        },
      },
    );
    // Native diagnostics never inherit the worker's output capability. Drain
    // both streams even during failures, retaining only counts and closed codes.
    for (const stream of ["stdout", "stderr"] as const) {
      handle[stream]?.on("data", (chunk: Buffer) =>
        logEvent("child.output", { service: "qwen", stream, bytes: chunk.byteLength }),
      );
    }
    handle.once("close", (exitCode, signal) =>
      logEvent("child.closed", { service: "qwen", exitCode, signal }),
    );
    let exited = false;
    let markExited: () => void = () => {};
    const exitedPromise = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    let markReady: (ok: boolean) => void = () => {};
    const ready = new Promise<boolean>((resolve) => {
      markReady = resolve;
    });
    const created: Slot = {
      handle,
      pid: handle.pid ?? null,
      runtime,
      ready,
      exited: exitedPromise,
      isExited: () => exited,
      pending: null,
      reportedPeak: 0,
      stopping: null,
      finalized: Promise.resolve(),
    };
    // One finalizer for OS exit and for spawn failure (which emits no `exit`).
    const finalize = () => {
      if (exited) return;
      exited = true;
      markReady(false);
      const pending = created.pending;
      created.pending = null;
      pending?.settle({ kind: "crashed" });

      if (slot === created) {
        slot = null;
        clearIdle();
      }
      // The next spawn awaits this release so a late release can never drop
      // the successor's lease.
      created.finalized = dropLease().finally(() => children.delete(created));
      // Observe failures even before a stop waiter joins this finalization.
      void created.finalized.catch(() => {});
      markExited();
    };
    handle.once("exit", finalize);
    handle.once("error", () => {
      if (created.pid === null) finalize();
      else markReady(false);
    });
    handle.on("message", (message) => {
      if (exited || typeof message !== "object" || message === null) return;
      const m = message as Record<string, unknown>;
      if (m.t === "library_log") return logEvent("qwen.library");
      if (m.t === "ready") return markReady(true);
      if (m.t === "load_failed") return markReady(false);
      const pending = created.pending;
      // Stale-token or stale-child replies are discarded.
      if (!pending || m.token !== pending.token) return;
      if (m.t === "counts") {
        created.pending = null;
        pending.settle({ kind: "counts", counts: m.counts, limit: m.limit });
      } else if (m.t === "result") {
        created.pending = null;
        pending.settle({ kind: "result", vectors: m.vectors, peakRssBytes: m.peakRssBytes });
      } else if (m.t === "error" && typeof m.code === "string") {
        created.pending = null;
        pending.settle({ kind: "error", code: m.code });
      }
    });
    if (created.pid === null) queueMicrotask(finalize);
    children.add(created);
    return created;
  }

  /** Terminates and reaps; resolves only once the OS exit was observed and the PID is gone. */
  function stopSlot(target: Slot, mode: "graceful" | "kill"): Promise<void> {
    if (target.stopping) {
      if (mode === "kill" && !target.isExited()) target.handle.kill("SIGKILL");
      return target.stopping;
    }
    target.stopping = (async () => {
      if (!target.isExited()) {
        if (mode === "graceful") {
          try {
            target.handle.send({ t: "shutdown" });
          } catch {}
          const graceful = await Promise.race([
            target.exited.then(() => true),
            delay(graceMs).then(() => false),
          ]);
          if (!graceful) target.handle.kill("SIGKILL");
        } else {
          target.handle.kill("SIGKILL");
        }
        await target.exited;
      }
      if (target.pid !== null) {
        const deadline = Date.now() + graceMs;
        while (pidAlive(target.pid) && Date.now() < deadline) await delay(5);
      }
      await target.finalized;
    })();
    return target.stopping;
  }

  async function ensureSlot(request: Request): Promise<Slot> {
    if (slot && (runtimeKey(slot.runtime) !== runtimeKey(request.runtime) || slot.stopping))
      await stopSlot(slot, "kill");
    assertRequest(request);
    if (!slot) {
      if (!(await holdLease(request.controller.signal))) {
        assertRequest(request);
        throw new QwenVolumeBusyError();
      }
      if (request.fence !== fence || request.controller.signal.aborted) {
        await dropLease();
        assertRequest(request);
      }
      try {
        slot = spawnSlot(request.runtime);
      } catch (error) {
        await dropLease();
        throw error;
      }
    }
    const current = slot;
    request.child = current;
    if (!(await cancellable(current.ready, request.controller.signal))) {
      await stopSlot(current, "kill");
      assertRequest(request);
      throw new QwenChildCrashedError();
    }
    assertRequest(request);
    return current;
  }

  function dispatch(current: Slot, message: (token: string) => ParentToChild): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const token = randomUUID();
      current.pending = { token, settle: resolve };
      try {
        current.handle.send(message(token));
      } catch {
        current.pending = null;
        resolve({ kind: "crashed" });
      }
    });
  }

  async function execute(request: Request): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let current: Slot;
      try {
        current = await ensureSlot(request);
      } catch (error) {
        if (error instanceof QwenChildCrashedError && attempt === 0) continue;
        throw error;
      }
      assertRequest(request);
      const outcome = await cancellable(
        dispatch(current, (token) => ({
          t: request.op,
          token,
          purpose: request.purpose,
          texts: request.texts,
        })),
        request.controller.signal,
      );
      assertRequest(request);
      if (outcome.kind === "crashed") {
        await stopSlot(current, "kill");
        continue;
      }
      // Closed classification: the child's own embed reply is the only built-in source of
      // the positive `EmbedderCallError` tag (model error, missing/invalid vectors, the child
      // crashing on the request). Lease acquisition/renewal, admission and spawn are not.
      if (outcome.kind === "error") {
        if (outcome.code === "EMBEDDING_INPUT_TOO_LONG") throw new EmbeddingInputTooLongError();
        throw request.op === "count" ? new EmbeddingUnavailableError() : new EmbedderCallError();
      }
      if (request.op === "count") {
        const { counts, limit } = outcome as { counts?: unknown; limit?: unknown };
        if (
          outcome.kind !== "counts" ||
          !Array.isArray(counts) ||
          counts.length !== request.texts.length ||
          !counts.every((n) => Number.isSafeInteger(n) && n > 0) ||
          limit !== current.runtime.config.contextTokens
        )
          throw new EmbeddingUnavailableError();
        return { counts: counts as number[], limit };
      }
      if (outcome.kind !== "result") throw new EmbedderCallError();
      const vectors = outcome.vectors;
      if (!Array.isArray(vectors)) throw new EmbedderCallError();
      const peak = outcome.peakRssBytes;
      if (typeof peak === "number" && Number.isSafeInteger(peak) && peak > current.reportedPeak) {
        current.reportedPeak = peak;
        try {
          options.onPeakRss?.(peak, current.runtime);
        } catch {}
      }
      try {
        return validateEmbeddings(
          { data: vectors.map((embedding, index) => ({ index, embedding })) },
          request.texts.length,
          modelFor(current.runtime).dimensions,
        );
      } catch {
        // The child's reply itself is invalid.
        throw new EmbedderCallError();
      }
    }
    // The child crashed on this request twice (its embed reply never came).
    throw new QwenChildCrashedError();
  }

  function pick(): Request | null {
    if (suspended) {
      // Stop-then-probe gap: queries fail fast, documents wait for resume().
      for (const request of waiting.query.splice(0)) {
        request.detach();
        request.reject(new EmbeddingUnavailableError());
      }
      return null;
    }
    const preferQuery =
      waiting.query.length > 0 &&
      (waiting.document.length === 0 || consecutiveQueries < QWEN_QUERY_BURST);
    if (preferQuery) {
      consecutiveQueries += 1;
      return waiting.query.shift() ?? null;
    }
    const next = waiting.document.shift() ?? null;
    if (next) consecutiveQueries = 0;
    return next;
  }

  async function drainLoop() {
    try {
      for (let next = pick(); next; next = pick()) {
        running = next;
        try {
          const result = await execute(next);
          assertRequest(next);
          next.resolve(result);
        } catch (error) {
          try {
            if (next.controller.signal.aborted && next.child) await stopSlot(next.child, "kill");
            next.reject(error);
          } catch (cleanupError) {
            next.reject(cleanupError);
          }
        } finally {
          running = null;
        }
      }
    } finally {
      draining = false;
      armIdle();
      markDrained();
    }
  }
  function drain() {
    if (draining) return;
    draining = true;
    drained = new Promise<void>((resolve) => {
      markDrained = resolve;
    });
    void drainLoop();
  }

  function rejectWaiting(error: () => Error) {
    for (const purpose of ["query", "document"] as const)
      for (const request of waiting[purpose].splice(0)) {
        request.detach();
        request.reject(error());
      }
  }

  /** Fences all admitted work, then SIGKILLs and reaps the child. */
  function disable(): Promise<void> {
    if (disabling) return disabling;
    fence += 1;
    clearIdle();
    rejectWaiting(() => new QwenDisabledError());
    running?.controller.abort(new QwenDisabledError());
    for (const controller of probes.keys())
      controller.abort(new QwenProbeError("MODEL_CONFIG_PROBE_FAILED"));
    disabling = (async () => {
      await Promise.all([...children].map((child) => stopSlot(child, "kill")));
      await drained;
      await Promise.all(probes.values());
      await leaseChain;
    })().finally(() => {
      disabling = null;
    });
    return disabling;
  }

  function admit(input: QwenEmbedInput, op: Request["op"]): Promise<unknown> {
    if (closed || disabling) return Promise.reject(new QwenDisabledError());
    if (input.texts.length > MAX_TEXTS || input.signal?.aborted)
      return Promise.reject(new EmbeddingUnavailableError());
    if (suspended && input.purpose === "query")
      return Promise.reject(new EmbeddingUnavailableError());
    if (waiting[input.purpose].length >= QWEN_MAX_WAITING[input.purpose])
      return Promise.reject(new QwenQueueFullError());
    return new Promise<unknown>((resolve, reject) => {
      const controller = new AbortController();
      const cancel = (error: Error) => {
        controller.abort(error);
        const queue = waiting[input.purpose];
        const index = queue.indexOf(request);
        if (index >= 0) queue.splice(index, 1);
        if (index >= 0) request.reject(error);
        armIdle();
      };
      const onAbort = () => cancel(new EmbeddingUnavailableError());
      const timer = setTimeout(onAbort, options.servingTimeoutMs ?? QWEN_SERVING_TIMEOUT_MS);
      timer.unref?.();
      const request: Request = {
        ...input,
        op,
        fence,
        settled: false,
        controller,
        child: null,
        resolve: (value) => {
          if (request.settled) return;
          request.settled = true;
          request.detach();
          resolve(value);
        },
        reject: (error) => {
          if (request.settled) return;
          request.settled = true;
          request.detach();
          reject(error);
        },
        detach: () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
        },
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      clearIdle();
      waiting[input.purpose].push(request);
      drain();
    });
  }

  /**
   * Load probe of a candidate runtime in its own child (never serving):
   * load + one max-context embedding, bounded by a deadline. The probe child
   * is always killed and reaped before this settles.
   */
  async function probe(
    runtime: QwenReadyRuntime,
    probeOptions: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ peakRssBytes: number | null }> {
    if (closed || disabling || probes.size || probeOptions.signal?.aborted)
      throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
    const controller = new AbortController();
    const admittedFence = fence;
    const finished = Promise.withResolvers<void>();
    probes.set(controller, finished.promise);
    const onAbort = () => controller.abort(new QwenProbeError("MODEL_CONFIG_PROBE_FAILED"));
    probeOptions.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new QwenProbeError("MODEL_CONFIG_PROBE_TIMEOUT")),
      probeOptions.timeoutMs ?? QWEN_PROBE_TIMEOUT_MS,
    );
    let probeSlot: Slot | undefined;
    let held = false;
    const assertActive = () => {
      controller.signal.throwIfAborted();
      if (closed || disabling || fence !== admittedFence)
        throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
    };
    try {
      held = await holdLease(controller.signal);
      assertActive();
      if (!held) throw new QwenVolumeBusyError();
      probeSlot = spawnSlot(runtime);
      if (!(await cancellable(probeSlot.ready, controller.signal)))
        throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
      assertActive();
      const outcome = await cancellable(
        dispatch(probeSlot, (token) => ({ t: "probe", token })),
        controller.signal,
      );
      assertActive();
      if (outcome.kind !== "result" || !Array.isArray(outcome.vectors))
        throw new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
      validateEmbeddings(
        { data: outcome.vectors.map((embedding, index) => ({ index, embedding })) },
        1,
        modelFor(runtime).dimensions,
      );
      const peak = outcome.peakRssBytes;
      return {
        peakRssBytes:
          typeof peak === "number" && Number.isSafeInteger(peak) && peak > 0 ? peak : null,
      };
    } catch (error) {
      throw error instanceof QwenProbeError || error instanceof QwenVolumeBusyError
        ? error
        : new QwenProbeError("MODEL_CONFIG_PROBE_FAILED");
    } finally {
      clearTimeout(timer);
      probeOptions.signal?.removeEventListener("abort", onAbort);
      try {
        if (probeSlot) await stopSlot(probeSlot, "kill");
        else if (held) await dropLease();
      } finally {
        probes.delete(controller);
        finished.resolve();
      }
    }
  }

  /** Stop-then-probe: finish the running batch, stop serving, park documents. */
  async function suspend(): Promise<void> {
    suspended = true;
    clearIdle();
    pick(); // fails waiting queries fast
    while (draining) await drained;
    const current = slot;
    if (current) await stopSlot(current, "kill");
  }

  return {
    embed(input: QwenEmbedInput): Promise<number[][]> {
      if (input.texts.length === 0 && !closed) return Promise.resolve([]);
      return admit(input, "embed") as Promise<number[][]>;
    },

    /** Model token counts (prefix/EOS included) and the runtime's input limit. */
    countTokens(input: QwenEmbedInput): Promise<{ counts: number[]; limit: number }> {
      if (input.texts.length === 0 && !closed)
        return Promise.resolve({ counts: [], limit: input.runtime.config.contextTokens });
      return admit(input, "count") as Promise<{ counts: number[]; limit: number }>;
    },

    probe,
    suspend,
    resume() {
      suspended = false;
      drain();
      armIdle();
    },
    /** A probe tick's own hold on the volume lease (false: another worker owns it). */
    tryHoldLease: holdLease,
    releaseLeaseHold: dropLease,

    disable,
    close: async () => {
      closed = true;
      await disable();
    },

    loadedRuntime(): QwenReadyRuntime | null {
      return slot?.runtime ?? null;
    },

    snapshot() {
      return {
        pid: slot && !slot.isExited() ? slot.pid : null,
        running: running !== null,
        queued: { query: waiting.query.length, document: waiting.document.length },
        spawns,
      };
    },
  };
}

export const QWEN_MODEL_WATCH_MS = 30_000;

/**
 * While a child is alive, poll the READY runtime; an admin disable/re-enable or
 * runtime config change (or a read failure) kills and reaps the child promptly
 * instead of waiting for the next job or the idle timeout. An idle parent (no
 * child) never polls.
 */
export function watchQwenModelRuntime(
  supervisor: {
    snapshot(): { pid: number | null };
    loadedRuntime(): QwenReadyRuntime | null;
    disable(): Promise<void>;
  },
  readReadyRuntime: (io: ModelRuntimeIo) => Promise<QwenReadyRuntime | null>,
  intervalMs = QWEN_MODEL_WATCH_MS,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let stopped = false;
  const shutdown = new AbortController();
  const timer = setInterval(() => {
    if (stopped || pending || supervisor.snapshot().pid === null) return;
    pending = readReadyRuntime({ signal: shutdown.signal })
      .then(
        (ready) => {
          const loaded = supervisor.loadedRuntime();
          return ready && loaded && runtimeKey(ready) === runtimeKey(loaded)
            ? undefined
            : supervisor.disable();
        },
        () => supervisor.disable(),
      )
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      });
  }, intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    shutdown.abort();
    await pending;
  };
}

type EmbedPort = {
  embed(input: QwenEmbedInput): Promise<number[][]>;
  countTokens?(input: QwenEmbedInput): Promise<{ counts: number[]; limit: number }>;
};

/**
 * Embedder adapter over the supervisor. The READY runtime (model epoch + admin
 * runtime config) is read before dispatch and again before the result is
 * returned; an enable/disable (which always bumps the epoch) or a config change
 * in between discards the late result, so no result computed under one config
 * is ever returned as another's.
 */
export function createQwenEmbedder(deps: {
  supervisor: EmbedPort;
  readReadyRuntime: (io: ModelRuntimeIo) => Promise<QwenReadyRuntime | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Embedder {
  const countTokens = deps.supervisor.countTokens?.bind(deps.supervisor);
  // One lifetime includes readiness, queue/load/retry, inference and final fence.
  // The worker shutdown signal also reaches index builds before native admission.
  const operation = async <T>(
    signal: AbortSignal | undefined,
    run: (io: ModelRuntimeIo & { signal: AbortSignal; deadlineAt: number }) => Promise<T>,
  ) => {
    const controller = new AbortController();
    const sources = [signal, deps.signal].filter(
      (source): source is AbortSignal => source !== undefined,
    );
    const cancel = () => controller.abort(new EmbeddingUnavailableError());
    const deadlineAt = Date.now() + (deps.timeoutMs ?? QWEN_SERVING_TIMEOUT_MS);
    const timer = setTimeout(cancel, Math.max(0, deadlineAt - Date.now()));
    for (const source of sources) {
      source.addEventListener("abort", cancel, { once: true });
      if (source.aborted) cancel();
    }
    try {
      controller.signal.throwIfAborted();
      return await run({ signal: controller.signal, deadlineAt });
    } finally {
      clearTimeout(timer);
      for (const source of sources) source.removeEventListener("abort", cancel);
    }
  };
  const assertActive = (io: { signal: AbortSignal; deadlineAt: number }) => {
    io.signal.throwIfAborted();
    if (Date.now() >= io.deadlineAt) throw new EmbeddingUnavailableError();
  };
  return {
    // Document inputs measured by the child of the READY runtime; a
    // runtime change in between discards the measurement (the build is fenced).
    ...(countTokens
      ? {
          measureInputs: async (texts: readonly string[], { signal }: { signal?: AbortSignal }) => {
            try {
              return await operation(signal, async (io) => {
                const runtime = await deps.readReadyRuntime(io);
                assertActive(io);
                if (runtime === null) throw new EmbeddingUnavailableError();
                const measured = await countTokens({
                  purpose: "document",
                  texts: texts.map(prepareEmbeddingDocument),
                  runtime,
                  signal: io.signal,
                });
                assertActive(io);
                const after = await deps.readReadyRuntime(io);
                assertActive(io);
                if (
                  after === null ||
                  runtimeKey(after) !== runtimeKey(runtime) ||
                  io.signal.aborted
                )
                  throw new EmbeddingUnavailableError();
                return measured;
              });
            } catch {
              throw new EmbeddingUnavailableError();
            }
          },
        }
      : {}),
    embed: async (texts, { purpose, signal, beforeDispatch }) => {
      try {
        return await operation(signal, async (io) => {
          const runtime = await deps.readReadyRuntime(io);
          assertActive(io);
          if (runtime === null) throw new EmbeddingUnavailableError();
          const safe = texts.map((text) =>
            purpose === "query" ? prepareEmbeddingQuery(text) : prepareEmbeddingDocument(text),
          );
          await beforeDispatch?.();
          assertActive(io);
          // The supervisor tags only the child's own reply failures (`EmbedderCallError`);
          // lease, admission and SQL failures inside it stay untagged.
          const vectors = await deps.supervisor.embed({
            purpose,
            texts: safe,
            runtime,
            signal: io.signal,
          });
          assertActive(io);
          const after = await deps.readReadyRuntime(io);
          assertActive(io);
          if (after === null || runtimeKey(after) !== runtimeKey(runtime) || io.signal.aborted)
            throw new EmbeddingUnavailableError();
          return vectors;
        });
      } catch (error) {
        if (error instanceof EmbeddingInputTooLongError || error instanceof EmbedderCallError)
          throw error;
        throw new EmbeddingUnavailableError();
      }
    },
  };
}
