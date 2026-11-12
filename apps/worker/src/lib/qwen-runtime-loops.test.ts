import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQwenPeakReporter, startQwenRuntimeLoops } from "./qwen-runtime-loops";

const budget = {
  budgetBytes: 8 * 1024 ** 3,
  availableBytes: 5 * 1024 ** 3,
  source: "meminfo" as const,
};

describe("worker Qwen runtime loops", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces native peaks, retries future observations after failure and joins shutdown", async () => {
    const shutdown = new AbortController();
    const first = Promise.withResolvers<void>();
    const last = Promise.withResolvers<void>();
    const writes = vi
      .fn(async () => {})
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => last.promise);
    const pending: Promise<void>[] = [];
    const report = createQwenPeakReporter({
      signal: shutdown.signal,
      write: writes,
      track: (work) => pending.push(work),
    });
    const runtime = {
      modelId: "qwen3-embedding-0.6b-q8_0",
      epoch: 1,
      config: { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" },
    } as const;
    report(1, runtime);
    for (let peak = 2; peak <= 100; peak++) report(peak, runtime);
    // A replacement child may observe a lower HWM for the same runtime.
    report(50, runtime);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    first.reject(new Error("SQL cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes).toHaveBeenLastCalledWith(100, runtime, shutdown.signal);
    report(200, runtime);
    shutdown.abort();
    let joined = false;
    const closing = Promise.all(pending).then(() => {
      joined = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(joined).toBe(false);
    last.resolve();
    await closing;
    report(300, runtime);
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it("reports the memory budget at start and periodically; nothing when undetectable", async () => {
    const report = vi.fn(async () => {});
    const stop = startQwenRuntimeLoops({
      detectBudget: () => budget,
      reportBudget: report,
      hasWork: async () => false,
      advance: vi.fn(),
      budgetIntervalMs: 1000,
      reembedIntervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(budget, expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(2000);
    expect(report).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(report).toHaveBeenCalledTimes(3);

    const silent = vi.fn(async () => {});
    const stopSilent = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: silent,
      hasWork: async () => false,
      advance: vi.fn(),
      budgetIntervalMs: 1000,
      reembedIntervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(silent).not.toHaveBeenCalled();
    stopSilent();
  });

  it("skips overlapping reports, retries after failure and joins cancellation before closing admission", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = Promise.withResolvers<void>();
    const final = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const report = vi
      .fn(async (_budget, current: AbortSignal) => {
        signal = current;
        await final.promise;
      })
      .mockImplementationOnce(() => first.promise);
    const stop = startQwenRuntimeLoops({
      detectBudget: () => budget,
      reportBudget: report,
      hasWork: async () => false,
      advance: async () => {},
      budgetIntervalMs: 10,
      reembedIntervalMs: 60_000,
    });
    try {
      await vi.advanceTimersByTimeAsync(200);
      expect(report).toHaveBeenCalledTimes(1);
      first.reject(new Error("blocked report failed"));
      await vi.advanceTimersByTimeAsync(10);
      expect(report).toHaveBeenCalledTimes(2);
      let drained = false;
      const closing = stop().then(() => {
        drained = true;
      });
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(drained).toBe(false);
      expect(report).toHaveBeenCalledTimes(2);
      final.resolve();
      await closing;
      await vi.advanceTimersByTimeAsync(100);
      expect(report).toHaveBeenCalledTimes(2);
    } finally {
      first.resolve();
      final.resolve();
      await stop();
      logged.mockRestore();
    }
  });

  it("advances re-embedding only when there is work, never two ticks at once, and survives failures", async () => {
    let work = false;
    let release: () => void = () => {};
    const advance = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => work,
      advance,
      budgetIntervalMs: 60_000,
      reembedIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(advance).not.toHaveBeenCalled();
    work = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(advance).toHaveBeenCalledTimes(1);
    // The first tick is still running: later intervals do not overlap it.
    await vi.advanceTimersByTimeAsync(500);
    expect(advance).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(advance).toHaveBeenCalledTimes(2);
    release();
    advance.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(advance).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(advance).toHaveBeenCalledTimes(4);
    release();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(advance).toHaveBeenCalledTimes(4);
  });

  it("runs config load probe ticks on their own interval, never overlapping, surviving failures", async () => {
    let release: () => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => false,
      advance: vi.fn(),
      probeConfig: probe,
      probeIntervalMs: 100,
      budgetIntervalMs: 60_000,
      reembedIntervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(probe).toHaveBeenCalledTimes(1);
    release();
    probe.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(probe).toHaveBeenCalledTimes(3);
    release();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).toHaveBeenCalledTimes(3);
  });
  it("cleans obsolete files even with no rebuild work; cleanup ticks do not overlap and stop", async () => {
    let release: () => void = () => {};
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => false,
      advance: vi.fn(),
      cleanup,
      reembedIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(cleanup).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(cleanup).toHaveBeenCalledTimes(2);
    release();
    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it("shutdown drains an in-flight cleanup before the caller can release the model volume owner", async () => {
    let release: () => void = () => {};
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => false,
      advance: vi.fn(),
      cleanup,
      reembedIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    let drained = false;
    const closing = stop();
    expect(closing).toBeInstanceOf(Promise);
    void Promise.resolve(closing).then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(drained).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    release();
    await closing;
    expect(drained).toBe(true);
  });
  it("retries cleanup after an I/O rejection and drains the successful retry", async () => {
    const error = captureLog();
    const cleanup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(Object.assign(new Error("volume unavailable"), { code: "EIO" }));
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => false,
      advance: vi.fn(),
      cleanup,
      reembedIntervalMs: 100,
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(error.records).toContainEqual(expect.objectContaining({ site: "qwen.reembed" }));
      await vi.advanceTimersByTimeAsync(100);
      expect(cleanup).toHaveBeenCalledTimes(2);
      await stop();
      await vi.advanceTimersByTimeAsync(300);
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
      error.restore();
    }
  });

  it.each(["success", "failure"])(
    "serializes volume effects without starving queued probes after %s",
    async (outcome) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let finishProbe: () => void = () => {};
      let finishCleanup: () => void = () => {};
      const probe = vi
        .fn(async () => {})
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              finishProbe = () => (outcome === "success" ? resolve() : reject(new Error("EIO")));
            }),
        );
      const cleanup = vi
        .fn(async () => {})
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishCleanup = resolve;
            }),
        );
      const stop = startQwenRuntimeLoops({
        detectBudget: () => null,
        reportBudget: async () => {},
        hasWork: async () => false,
        advance: vi.fn(),
        cleanup,
        probeConfig: probe,
        probeIntervalMs: 100,
        reembedIntervalMs: 200,
      });
      try {
        await vi.advanceTimersByTimeAsync(500);
        expect(probe).toHaveBeenCalledTimes(1);
        // The publisher may have a live journal/partial: recovery cannot enter.
        expect(cleanup).not.toHaveBeenCalled();
        finishProbe();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(cleanup).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(200);
        // Cleanup now holds the permit; a probe queues rather than overlaps or
        // repeatedly losing to a cleanup tick on the same interval boundary.
        expect(probe).toHaveBeenCalledTimes(1);
        finishCleanup();
        await vi.advanceTimersByTimeAsync(0);
        expect(probe).toHaveBeenCalledTimes(2);
        await stop();
        await vi.advanceTimersByTimeAsync(500);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(cleanup).toHaveBeenCalledTimes(1);
      } finally {
        finishProbe();
        finishCleanup();
        await stop();
        logged.mockRestore();
      }
    },
  );

  it("drains the volume owner and skips a queued probe on shutdown", async () => {
    let release: () => void = () => {};
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const probe = vi.fn(async () => {});
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => false,
      advance: vi.fn(),
      cleanup,
      probeConfig: probe,
      probeIntervalMs: 100,
      reembedIntervalMs: 100,
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(probe).not.toHaveBeenCalled();
      let drained = false;
      const closing = stop().then(() => {
        drained = true;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(drained).toBe(false);
      release();
      await closing;
      expect(drained).toBe(true);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      release();
      await stop();
    }
  });

  it("continues re-embed scheduling while preparation holds the file permit", async () => {
    let release: () => void = () => {};
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const advance = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => true,
      advance,
      cleanup,
      probeConfig: probe,
      probeIntervalMs: 100,
      reembedIntervalMs: 200,
    });
    try {
      await vi.advanceTimersByTimeAsync(600);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(advance).toHaveBeenCalledTimes(3);
      expect(cleanup).not.toHaveBeenCalled();
    } finally {
      release();
      await stop();
    }
  });

  it("starts the waiting probe after a failed cleanup releases its permit", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail: () => void = () => {};
    const cleanup = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new Error("EIO"));
        }),
    );
    const probe = vi.fn(async () => {});
    const stop = startQwenRuntimeLoops({
      detectBudget: () => null,
      reportBudget: async () => {},
      hasWork: async () => false,
      advance: vi.fn(),
      cleanup,
      probeConfig: probe,
      probeIntervalMs: 100,
      reembedIntervalMs: 100,
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(probe).not.toHaveBeenCalled();
      fail();
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      fail();
      await stop();
      logged.mockRestore();
    }
  });
});
