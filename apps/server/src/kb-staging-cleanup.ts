import { RETENTION, scrubExpiredQueryData } from "@knowledge-base/api/lib/kb/retention";
import { logInternalError } from "@knowledge-base/env/log";

/**
 * Server-owned, process-fenced janitor for transient KB data. Query text,
 * results and leases must be gone five minutes after request creation, so this runs a
 * sweep before admission (start resolves only after it succeeds) and then every
 * `queryJanitorIntervalMs`, independent of the worker's minute/hourly retention jobs.
 * Upload/export staging files are unlinked by this same process's fenced sweeps
 * (journal recovery + export lifecycle); the worker only marks DB state (the server's
 * fenced sweeper owns file reclaim). Ticks never overlap; a lost process fence stops the tick before any SQL.
 */
export async function startKbStagingCleanup(input: {
  connectionString: string;
  assertFence: () => void;
}): Promise<{ stop(): Promise<void> }> {
  input.assertFence();
  await scrubExpiredQueryData({ connectionString: input.connectionString });
  let stopped = false;
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = (async () => {
      input.assertFence();
      await scrubExpiredQueryData({ connectionString: input.connectionString });
    })()
      .catch((error: unknown) => {
        logInternalError("kb.staging-cleanup", error);
      })
      .finally(() => {
        inFlight = undefined;
      });
  }, RETENTION.queryJanitorIntervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
