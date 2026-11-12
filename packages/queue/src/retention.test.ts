import { describe, expect, it, vi } from "vitest";
import { cleanQueuePayloads } from "./retention";

describe("bounded idle queue cleanup", () => {
  it("reports a failed set after still cleaning its sibling and the other queues", async () => {
    const poisoned = {
      clean: vi.fn().mockRejectedValueOnce(new Error("Redis failure")).mockResolvedValue([]),
    };
    const healthy = { clean: vi.fn().mockResolvedValue(["expired"]).mockResolvedValueOnce([]) };
    await expect(cleanQueuePayloads([poisoned, healthy])).rejects.toThrow(
      "Queue payload retention failed",
    );
    expect(poisoned.clean.mock.calls.map((call) => call[2])).toEqual(["completed", "failed"]);
    expect(healthy.clean.mock.calls.map((call) => call[2])).toEqual(["completed", "failed"]);
  });

  it("yields after a bounded pass even if arrivals keep every page full", async () => {
    const full = {
      clean: vi.fn().mockResolvedValue(Array.from({ length: 100 }, (_, n) => String(n))),
    };
    expect(await cleanQueuePayloads([full])).toBe(10_000);
    expect(full.clean).toHaveBeenCalledTimes(100);
    expect(full.clean.mock.calls.every((call) => call[1] === 100)).toBe(true);
  });
});
