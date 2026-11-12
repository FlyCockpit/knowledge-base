/**
 * Worker background loops for the selected built-in embedding runtime:
 * - reports the memory budget this worker may use so the server can
 *   gate runtime configs against it;
 * - drives sequential re-embedding after a config change. Every tick is
 *   one authority transaction (qwen-reembed.ts); ticks never overlap within a
 *   process, and the DB lease serializes them across processes.
 * - runs config load probe ticks (qwen-config-probe.ts); never
 *   overlapping within a process, the DB claim serializes workers.
 */

import { sameQwenRuntimeConfig } from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { logInternalError } from "@knowledge-base/env/log";
import type { MemoryBudget } from "./memory-budget";
import type { QwenReadyRuntime } from "./qwen-lifecycle";

const WORKER_MEMORY_REPORT_MS = 5 * 60 * 1000;

/** Keep one SQL effect and one latest peak; never queue one write per native reply. */
export function createQwenPeakReporter(deps: {
  signal: AbortSignal;
  write: (bytes: number, runtime: QwenReadyRuntime, signal: AbortSignal) => Promise<void>;
  track: (task: Promise<void>) => void;
}): (bytes: number, runtime: QwenReadyRuntime) => void {
  let latest: { bytes: number; runtime: QwenReadyRuntime } | undefined;
  let reporting = false;
  return (bytes, runtime) => {
    if (deps.signal.aborted) return;
    if (
      latest &&
      latest.runtime.modelId === runtime.modelId &&
      latest.runtime.epoch === runtime.epoch &&
      sameQwenRuntimeConfig(latest.runtime.config, runtime.config)
    )
      bytes = Math.max(bytes, latest.bytes);
    latest = { bytes, runtime };
    if (reporting) return;
    reporting = true;
    deps.track(
      (async () => {
        try {
          while (latest && !deps.signal.aborted) {
            const next = latest;
            latest = undefined;
            try {
              await deps.write(next.bytes, next.runtime, deps.signal);
            } catch {
              /* Best effort; the next native observation remains eligible. */
            }
          }
        } finally {
          latest = undefined;
          reporting = false;
        }
      })(),
    );
  };
}

export function startQwenRuntimeLoops(deps: {
  detectBudget: () => MemoryBudget | null;
  reportBudget: (budget: MemoryBudget, signal: AbortSignal) => Promise<void>;
  hasWork: () => Promise<boolean>;
  advance: () => Promise<unknown>;
  cleanup?: () => Promise<void>;
  probeConfig?: () => Promise<unknown>;
  probeIntervalMs?: number;
  budgetIntervalMs?: number;
  reembedIntervalMs: number;
}): () => Promise<void> {
  let stopped = false;
  const pending = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>) => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const reportingShutdown = new AbortController();
  let reporting = false;
  const report = () => {
    if (stopped || reporting) return;
    const budget = deps.detectBudget();
    if (!budget) return;
    reporting = true;
    track(
      (async () => {
        try {
          await deps.reportBudget(budget, reportingShutdown.signal);
        } catch (error) {
          logInternalError("qwen.memory-report", error);
        } finally {
          reporting = false;
        }
      })(),
    );
  };
  report();
  const budgetTimer = setInterval(report, deps.budgetIntervalMs ?? WORKER_MEMORY_REPORT_MS);
  budgetTimer.unref?.();

  let busy = false;
  // The supervisor lends one cross-process volume lease to several holders.
  // Reserve preparation before waiting for any current cleanup. While reserved,
  // periodic recovery cannot reap a publisher's live intent; re-embed SQL still
  // advances. At most one probe waits for the one admitted cleanup to drain.
  let probing = false;
  let cleanupDone: Promise<unknown> = Promise.resolve();
  const reembedTimer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    const run = (async () => {
      try {
        if (stopped) return;
        if (await deps.hasWork()) await deps.advance();
        if (!stopped && !probing) {
          cleanupDone = deps.cleanup?.() ?? Promise.resolve();
          await cleanupDone;
        }
      } catch (error) {
        logInternalError("qwen.reembed", error);
      } finally {
        busy = false;
      }
    })();
    track(run);
  }, deps.reembedIntervalMs);
  reembedTimer.unref?.();

  const probeConfig = deps.probeConfig;
  const probeTimer = probeConfig
    ? setInterval(() => {
        if (probing || stopped) return;
        probing = true;
        const run = cleanupDone
          .catch(() => {})
          .then(() => (stopped ? undefined : probeConfig()))
          .catch((error: unknown) => {
            logInternalError("qwen.config-probe", error);
          })
          .finally(() => {
            probing = false;
          });
        track(run);
      }, deps.probeIntervalMs ?? 5_000)
    : null;
  probeTimer?.unref?.();

  let drain: Promise<void> | undefined;
  return () => {
    stopped = true;
    reportingShutdown.abort();
    clearInterval(budgetTimer);
    clearInterval(reembedTimer);
    if (probeTimer) clearInterval(probeTimer);
    // Keep the volume owner and database clients until every admitted effect exits.
    if (!drain) drain = Promise.allSettled([...pending]).then(() => {});
    return drain;
  };
}
