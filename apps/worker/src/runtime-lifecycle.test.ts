import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout, workerDrainMs } from "./runtime-lifecycle";

afterEach(() => vi.useRealTimers());
describe("withTimeout", () => {
  it("bounds maintenance drains to five minutes and ordinary shutdown to fifteen seconds", () => {
    expect(workerDrainMs(true)).toBe(300_000);
    expect(workerDrainMs(false)).toBe(15_000);
  });
  it("preserves success and failure and clears deadline timers", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(3), 10, "expired")).resolves.toBe(3);
    await expect(withTimeout(Promise.reject(new Error("bad")), 10, "expired")).rejects.toThrow(
      "bad",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a hung operation without claiming to cancel its underlying effects", async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise(() => {}), 10, "expired");
    const assertion = expect(result).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});
