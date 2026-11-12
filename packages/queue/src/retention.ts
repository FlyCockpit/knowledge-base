import type { Queue } from "bullmq";
import { BULL_PAYLOAD_RETENTION } from "./jobs.js";

/** Auto-removal needs a later completion. Hourly cleanup also covers idle queues.
 * Each Redis script handles <=100 jobs; at most 5,000 per set/pass (the largest
 * default count cap). Larger inherited backlogs continue on the next firing.
 * Only terminal Redis payloads are removed; active/waiting work and SQL receipts
 * remain owned by their existing consumers. Failures never skip sibling sets.
 */
export async function cleanQueuePayloads(queues: readonly Pick<Queue, "clean">[]): Promise<number> {
  let removed = 0;
  const failures: unknown[] = [];
  for (const queue of queues) {
    for (const [state, seconds] of [
      ["completed", BULL_PAYLOAD_RETENTION.completedAgeSeconds],
      ["failed", BULL_PAYLOAD_RETENTION.failedAgeSeconds],
    ] as const) {
      try {
        for (let page = 0; page < 50; page++) {
          const ids = await queue.clean(seconds * 1000, 100, state);
          removed += ids.length;
          if (ids.length < 100) break;
        }
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Queue payload retention failed");
  return removed;
}
