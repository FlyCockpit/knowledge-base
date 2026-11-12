import { describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/api/lib/kb/jobs", () => ({
  claimJobAttempt: vi.fn(),
  commitProbeAttempt: vi.fn(),
  completeJobAttempt: vi.fn(),
  durableProbeDesiredSchema: { parse: (v: unknown) => v },
  durableQueuePayloadSchema: { parse: (v: unknown) => v },
  failJobAttempt: vi.fn(),
  heartbeatJobAttempt: vi.fn(),
  parseDesiredForKind: () => ({ marker: "x" }),
  WORKER_HEARTBEAT_MS: 5_000,
  DurableJobFenceError: class DurableJobFenceError extends Error {
    name = "DurableJobFenceError";
  },
  DurableJobCancelledError: class DurableJobCancelledError extends Error {
    name = "DurableJobCancelledError";
  },
}));
vi.mock("@knowledge-base/queue", () => ({
  durableProbeJobSchema: { parse: (v: unknown) => v },
}));

import { claimJobAttempt } from "@knowledge-base/api/lib/kb/jobs";
import { handleDurableProbeJob } from "./durable-probe.js";

describe("handleDurableProbeJob", () => {
  it("skips when the durable attempt cannot be claimed", async () => {
    vi.mocked(claimJobAttempt).mockResolvedValue(null);
    const result = await handleDurableProbeJob({
      data: { durableJobId: "550e8400-e29b-41d4-a716-446655440000" },
    } as never);
    expect(result).toEqual({ skipped: true });
  });

  it("returns the committed marker for a claimed delivery", async () => {
    vi.mocked(claimJobAttempt).mockImplementation(
      async (_db: unknown, input: { workerId: string }) =>
        ({
          id: "550e8400-e29b-41d4-a716-446655440000",
          kind: "PROBE",
          state: "RUNNING",
          workerOwner: input.workerId,
          attemptEpoch: 1,
          cancelledAt: null,
          desired: { marker: "x" },
        }) as never,
    );
    const result = await handleDurableProbeJob({
      data: { durableJobId: "550e8400-e29b-41d4-a716-446655440000" },
    } as never);
    expect(result).toEqual({ marker: "x" });
  });
});
