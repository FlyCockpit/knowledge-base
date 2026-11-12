import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scrub = vi.hoisted(() => vi.fn());
vi.mock("@knowledge-base/api/lib/kb/retention", () => ({
  RETENTION: { queryJanitorIntervalMs: 30_000 },
  scrubExpiredQueryData: scrub,
}));

const { startKbStagingCleanup } = await import("./kb-staging-cleanup");

describe("server query/staging janitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scrub.mockReset();
    scrub.mockResolvedValue(0);
  });
  afterEach(() => vi.useRealTimers());

  it("scrubs once before admission, then every janitor interval under the process fence", async () => {
    const fence = vi.fn();
    const cleanup = await startKbStagingCleanup({
      connectionString: "postgres://runtime.invalid/kb",
      assertFence: fence,
    });
    // The startup sweep completed before start resolved (admission opens after it).
    expect(scrub).toHaveBeenCalledTimes(1);
    expect(scrub).toHaveBeenCalledWith({ connectionString: "postgres://runtime.invalid/kb" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scrub).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scrub).toHaveBeenCalledTimes(3);
    expect(fence).toHaveBeenCalled();
    await cleanup.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(scrub).toHaveBeenCalledTimes(3);
  });

  it("fails startup closed when the startup scrub fails", async () => {
    scrub.mockRejectedValueOnce(new Error("db down"));
    await expect(
      startKbStagingCleanup({ connectionString: "postgres://x.invalid/kb", assertFence: vi.fn() }),
    ).rejects.toThrow("db down");
  });

  it("never overlaps ticks and survives a failing tick", async () => {
    const errors = captureLog();
    const cleanup = await startKbStagingCleanup({
      connectionString: "postgres://runtime.invalid/kb",
      assertFence: vi.fn(),
    });
    let release = () => {};
    scrub.mockImplementationOnce(() => new Promise<number>((r) => (release = () => r(0))));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scrub).toHaveBeenCalledTimes(2); // second tick skipped while the first is in flight
    release();
    scrub.mockRejectedValueOnce(new Error("transient"));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scrub).toHaveBeenCalledTimes(4);
    expect(errors.records.length).toBeGreaterThan(0);
    await cleanup.stop();
  });

  it("stops before a tick when the process fence is lost", async () => {
    const fence = vi.fn();
    const cleanup = await startKbStagingCleanup({
      connectionString: "postgres://runtime.invalid/kb",
      assertFence: fence,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    fence.mockImplementation(() => {
      throw new Error("fence lost");
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scrub).toHaveBeenCalledTimes(1);
    await cleanup.stop();
  });
});
