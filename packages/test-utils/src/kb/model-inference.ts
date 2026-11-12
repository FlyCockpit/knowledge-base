import { vi } from "vitest";

/**
 * Real-model correctness checks must not charge shared-host CPU throughput to
 * the production serving/probe budget. Freeze only the parent's deadline clock;
 * the forked model, IPC and Vitest's existing wall-clock timeout keep running.
 * Date must also stop: the embedder checks absolute expiry after inference.
 *
 * Leave explicit lifecycle polling and suite cleanup outside this scope.
 * qwen-lifecycle.test.ts independently pins the 120000 ms production deadlines.
 */
export function modelInference<Args extends unknown[], Result extends Promise<unknown>>(
  run: (...args: Args) => Result,
): (...args: Args) => Promise<Awaited<Result>> {
  return async (...args): Promise<Awaited<Result>> => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      return await run(...args);
    } finally {
      vi.useRealTimers();
    }
  };
}
