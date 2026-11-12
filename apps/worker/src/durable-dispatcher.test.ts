import * as jobs from "@knowledge-base/api/lib/kb/jobs";
import { afterEach, describe, expect, it, vi } from "vitest";

const publish = vi.fn();
vi.mock("@knowledge-base/queue/ensure-job", () => ({
  ensureRunnableJob: (...args: unknown[]) => publish(...args),
}));

import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { startDurableDispatcherLoop } from "./durable-dispatcher.js";

// Mock history must never leak between tests: a spy called by one test can
// make a later test's toHaveBeenCalled() pass for free.
afterEach(() => {
  vi.restoreAllMocks();
  publish.mockReset();
});

describe("runDurableDispatcherCycle", () => {
  it("releases the dispatch claim when publish hooks throw", async () => {
    const claimed = [
      {
        id: "job-1",
        kind: "PROBE" as const,
        attemptEpoch: 1,
        state: "PENDING" as const,
        attemptCount: 0,
      },
    ];
    const db = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
      $queryRaw: vi.fn(),
      durableJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    vi.spyOn(jobs, "claimDispatchBatch").mockResolvedValue(claimed);
    const release = vi.spyOn(jobs, "releaseDispatchClaim").mockResolvedValue(undefined);
    vi.spyOn(jobs, "markDispatchPublished").mockResolvedValue(true);
    publish.mockRejectedValueOnce(new Error("redis down"));

    const count = await runDurableDispatcherCycle({
      db: db as never,
      ownerId: "owner-a",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      getQueue: () => ({ add: vi.fn(), getJob: vi.fn() }),
      hooks: { beforePublish: () => {} },
    });
    expect(count).toBe(0);
    expect(release).toHaveBeenCalledWith(db, { jobId: "job-1", owner: "owner-a" });
  });
});

describe("startDurableDispatcherLoop", () => {
  it("waits for an in-flight startup cycle before stop resolves", async () => {
    // The claim mock signals from inside the cycle, so the test knows the
    // startup tick is genuinely in flight — not merely scheduled.
    let releaseCycle!: () => void;
    let signalClaim!: () => void;
    const claimEntered = new Promise<void>((resolve) => {
      signalClaim = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseCycle = resolve;
    });
    const claim = vi.spyOn(jobs, "claimDispatchBatch").mockImplementation(async () => {
      signalClaim();
      await blocked;
      return [];
    });

    const loop = startDurableDispatcherLoop(
      {
        db: { $transaction: vi.fn(), durableJob: { updateMany: vi.fn() } } as never,
        ownerId: "owner",
        now: () => new Date(),
        getQueue: () => ({ add: vi.fn(), getJob: vi.fn() }),
      },
      60_000,
    );

    await claimEntered;
    expect(claim).toHaveBeenCalledTimes(1);
    const stopPromise = loop.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    // stop() cannot resolve while the claimed cycle is still in flight.
    expect(stopped).toBe(false);
    releaseCycle();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("stops before the startup cycle runs when stop beats the first tick", async () => {
    const claim = vi.spyOn(jobs, "claimDispatchBatch").mockResolvedValue([]);
    const loop = startDurableDispatcherLoop(
      {
        db: { $transaction: vi.fn(), durableJob: { updateMany: vi.fn() } } as never,
        ownerId: "owner",
        now: () => new Date(),
        getQueue: () => ({ add: vi.fn(), getJob: vi.fn() }),
      },
      60_000,
    );

    await loop.stop();
    // Flush any mis-scheduled micro/macro task before asserting nothing ran.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(claim).not.toHaveBeenCalled();
  });

  it("R3-W4: wake runs a cycle at once, and a burst during a cycle coalesces into one more", async () => {
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const claim = vi.spyOn(jobs, "claimDispatchBatch").mockImplementation(async () => {
      entered += 1;
      await gate;
      return [];
    });
    const loop = startDurableDispatcherLoop(
      {
        db: { $transaction: vi.fn(), durableJob: { updateMany: vi.fn() } } as never,
        ownerId: "owner",
        now: () => new Date(),
        getQueue: () => ({ add: vi.fn(), getJob: vi.fn() }),
      },
      60_000,
    );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    await settle();
    expect(entered).toBe(1);
    // Three wakes while the startup cycle runs: one more cycle, not three.
    loop.wake();
    loop.wake();
    loop.wake();
    release();
    gate = Promise.resolve();
    await settle();
    expect(claim).toHaveBeenCalledTimes(2);
    // Idle: a wake dispatches without waiting for the 60 s poll.
    loop.wake();
    await settle();
    expect(claim).toHaveBeenCalledTimes(3);
    await loop.stop();
    loop.wake();
    await settle();
    expect(claim).toHaveBeenCalledTimes(3);
  });
});
