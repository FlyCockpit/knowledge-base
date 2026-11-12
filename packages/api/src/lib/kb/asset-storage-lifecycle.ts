import { randomUUID } from "node:crypto";

export type AssetStorageRole = "SERVER" | "WORKER";

/** One instance per native-fenced role generation, explicitly shared with stores.
 * Attachment never establishes owner death. No lease, timer or PID is evidence.
 */
export function createAssetStorageLifecycle(role: AssetStorageRole, parent?: AbortSignal) {
  const epoch = randomUUID();
  const shutdown = new AbortController();
  // Connect the parent before any startup IO or reconciliation can begin.
  // Cancellation closes admission immediately; stop() still joins owned IO.
  const signal = parent ? AbortSignal.any([parent, shutdown.signal]) : shutdown.signal;
  const tasks = new Set<Promise<unknown>>();
  const resources = new Set<() => Promise<void>>();
  const recoveries = new Set<() => Promise<void>>();
  let closing: Promise<void> | undefined;
  let ownershipFailed = false;
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const task = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
    return task;
  };
  return {
    role,
    epoch,
    signal,
    track,
    failOwnership() {
      ownershipFailed = true;
    },
    /** Register owned close/drain before returning a reader or fill to a caller. */
    own(close: () => Promise<void>): () => void {
      signal.throwIfAborted();
      resources.add(close);
      return () => resources.delete(close);
    },
    registerRecovery(recover: () => Promise<void>): () => void {
      signal.throwIfAborted();
      recoveries.add(recover);
      return () => recoveries.delete(recover);
    },
    async recover() {
      for (const recover of recoveries) await track(recover);
    },
    stop(): Promise<void> {
      if (closing) return closing;
      shutdown.abort(new Error("Asset storage is stopping"));
      closing = (async () => {
        // Close IO/pins independently of outstanding advisory SQL.
        const drains = await Promise.allSettled([...resources].map((close) => close()));
        await Promise.allSettled([...tasks]);
        if (ownershipFailed || drains.some((result) => result.status === "rejected"))
          throw new Error("Asset storage ownership did not drain");
      })();
      return closing;
    },
  };
}

export type AssetStorageLifecycle = ReturnType<typeof createAssetStorageLifecycle>;

/** One bounded sample per reader. The caller invokes this only after enqueue.
 * No buffer, descriptor, path or pin is captured by a sample. close never waits.
 */
export function createAssetCacheTouch(
  lifecycle: AssetStorageLifecycle,
  touch: () => Promise<void>,
) {
  let busy = false;
  let stopped = false;
  return {
    sample() {
      if (busy || stopped || lifecycle.signal.aborted) return;
      busy = true;
      try {
        void lifecycle
          .track(async () => {
            if (!stopped && !lifecycle.signal.aborted) await touch();
          })
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      } catch {
        busy = false;
      }
    },
    stop() {
      stopped = true;
    },
  };
}
