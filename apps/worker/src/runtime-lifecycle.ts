import { MAINTENANCE_DRAIN_MS } from "@knowledge-base/api/lib/kb/maintenance";

export function workerDrainMs(maintenance: boolean): number {
  return maintenance ? MAINTENANCE_DRAIN_MS : 15_000;
}

/** Deadlines do not cancel effects: callers must stop ownership and exit on timeout. */
export function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Startup readiness for a dependency that may still be booting (ECONNREFUSED,
 * Postgres 57P03): five bounded pings with backoff, then its own error. */
export async function waitUntilReady(
  ping: () => Promise<unknown>,
  timeoutMessage: string,
  requireRunning: () => void,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      requireRunning();
      await withTimeout(ping(), 5000, timeoutMessage);
      requireRunning();
      return;
    } catch (error) {
      requireRunning();
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
