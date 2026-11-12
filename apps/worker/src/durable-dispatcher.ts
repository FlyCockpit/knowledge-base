import {
  type DurableDispatcherDeps,
  runDurableDispatcherCycle,
} from "@knowledge-base/api/lib/kb/dispatch";
import { logInternalError } from "@knowledge-base/env/log";

export type DurableDispatcherLoop = {
  /** R3-W4: run a cycle now (a committed enqueue), coalescing with one already queued. */
  wake(): void;
  stop(): Promise<void>;
};

export function startDurableDispatcherLoop(
  deps: DurableDispatcherDeps,
  intervalMs: number,
): DurableDispatcherLoop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve();
  // At most one cycle waits behind the running one, and at most one poll timer exists.
  let queued = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await runDurableDispatcherCycle(deps);
    } catch (error) {
      logInternalError("worker.dispatcher", error);
    }
  };

  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(run, intervalMs);
    timer.unref?.();
  };

  function run() {
    timer = undefined;
    if (stopped || queued) return;
    queued = true;
    chain = chain
      .then(() => {
        queued = false;
        return tick();
      })
      .then(schedule);
  }

  run();

  return {
    wake() {
      if (stopped) return;
      clearTimeout(timer);
      run();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await chain.catch(() => {});
    },
  };
}
