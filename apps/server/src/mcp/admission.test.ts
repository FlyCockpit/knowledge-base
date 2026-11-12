import { describe, expect, it, vi } from "vitest";
import { createAdmissionGate } from "./admission";

describe("admission lifetime", () => {
  it("distinguishes a transport deadline from client cancellation", async () => {
    vi.useFakeTimers();
    const permit = createAdmissionGate().admit(new AbortController().signal)!;
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(permit.signal.reason).toMatchObject({ name: "TimeoutError" });
    } finally {
      permit.release();
      vi.useRealTimers();
    }
  });
  it("closes synchronously, aborts but joins owned work, and never reopens", async () => {
    const gate = createAdmissionGate();
    const permit = gate.admit(new AbortController().signal)!;
    let drained = false;
    const closing = gate.close().then(() => {
      drained = true;
    });
    expect(gate.admit(new AbortController().signal)).toBeNull();
    expect(permit.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    permit.release();
    permit.release();
    await closing;
    await gate.close();
    expect(gate.outstanding).toBe(0);
  });
  it("client cancellation owns only its permit and release removes tracking", () => {
    const gate = createAdmissionGate();
    const client = new AbortController();
    const one = gate.admit(client.signal)!;
    const two = gate.admit(new AbortController().signal)!;
    client.abort();
    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(false);
    one.release();
    two.release();
    expect(gate.outstanding).toBe(0);
  });
});
