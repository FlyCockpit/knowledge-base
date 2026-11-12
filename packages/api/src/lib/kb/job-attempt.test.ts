import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./jobs.js", () => ({
  completeJobAttempt: vi.fn(),
  failJobAttempt: vi.fn().mockResolvedValue({ state: "RETRY", attemptCount: 1 }),
  heartbeatJobAttempt: vi.fn(),
  WORKER_HEARTBEAT_MS: 5_000,
  DurableJobFenceError: class DurableJobFenceError extends Error {
    name = "DurableJobFenceError";
  },
  DurableJobCancelledError: class DurableJobCancelledError extends Error {
    name = "DurableJobCancelledError";
  },
}));

import { withJobAttempt } from "./job-attempt.js";
import { failJobAttempt, heartbeatJobAttempt } from "./jobs.js";

describe("withJobAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(heartbeatJobAttempt).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips pending heartbeat ticks and drains the in-flight heartbeat on cleanup", async () => {
    vi.useFakeTimers();
    let renew = (_ok: boolean) => {};
    vi.mocked(heartbeatJobAttempt).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          renew = resolve;
        }),
    );
    let finish = () => {};
    const handler = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let settled = false;
    const onHeartbeat = vi.fn();
    const pending = withJobAttempt(
      { id: "j1", attemptEpoch: 1, workerOwner: "w1", state: "RUNNING", cancelledAt: null },
      { db: {} as never, workerId: "w1", onHeartbeat },
      () => handler,
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(1);
    renew(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    expect(heartbeatJobAttempt).toHaveBeenCalledTimes(2);
    renew(true);
    await pending;
    expect(settled).toBe(true);
    expect(onHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("heartbeats on interval and clears timer after run", async () => {
    vi.useFakeTimers();
    const db = {} as never;
    const job = {
      id: "j1",
      attemptEpoch: 1,
      workerOwner: "w1",
      state: "RUNNING" as const,
      cancelledAt: null,
    };
    await withJobAttempt(job, { db, workerId: "w1" }, async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(heartbeatJobAttempt).toHaveBeenCalled();
      return "ok";
    });
    vi.useRealTimers();
  });

  it("routes handler failures through failJobAttempt", async () => {
    const db = {} as never;
    const job = {
      id: "j1",
      attemptEpoch: 1,
      workerOwner: "w1",
      state: "RUNNING" as const,
      cancelledAt: null,
    };
    await expect(
      withJobAttempt(job, { db, workerId: "w1" }, async () => {
        throw new Error("handler blew up");
      }),
    ).rejects.toThrow("handler blew up");
    expect(failJobAttempt).toHaveBeenCalledWith(db, {
      jobId: "j1",
      workerId: "w1",
      attemptEpoch: 1,
      now: expect.any(Date),
      error: "handler blew up",
    });
  });

  it("stops heartbeats when renewal is rejected", async () => {
    vi.useFakeTimers();
    vi.mocked(heartbeatJobAttempt).mockRejectedValueOnce(new Error("db down"));
    const db = {} as never;
    const job = {
      id: "j1",
      attemptEpoch: 1,
      workerOwner: "w1",
      state: "RUNNING" as const,
      cancelledAt: null,
    };
    await expect(
      withJobAttempt(job, { db, workerId: "w1" }, async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(100);
      }),
    ).rejects.toThrow("db down");
    vi.useRealTimers();
  });
});
