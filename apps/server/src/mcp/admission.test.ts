import { captureLog } from "@knowledge-base/env/log";
import { describe, expect, it, vi } from "vitest";
import { createAdmissionGate, MCP_REQUEST_DEADLINE_MS } from "./admission";
import { toolFailure } from "./tool-dispatch";

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
  it("tells the work when the request deadline aborts it", async () => {
    vi.useFakeTimers();
    const before = Date.now();
    const permit = createAdmissionGate().admit(new AbortController().signal)!;
    try {
      expect(permit.deadlineAt).toBe(before + MCP_REQUEST_DEADLINE_MS);
      await vi.advanceTimersByTimeAsync(MCP_REQUEST_DEADLINE_MS - 1);
      expect(permit.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(permit.signal.aborted).toBe(true);
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
  it("a client cancellation with any reason reaches the work as CANCELLED, logged nowhere", () => {
    const log = captureLog();
    try {
      for (const reason of [
        "Client connection prematurely closed.",
        undefined,
        new Error("reset"),
      ]) {
        const client = new AbortController();
        const permit = createAdmissionGate().admit(client.signal)!;
        client.abort(reason);
        let thrown: unknown;
        try {
          permit.signal.throwIfAborted();
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ name: "AbortError" });
        const result = toolFailure(thrown, { tool: "knowledge_search_all" });
        expect(result.structuredContent).toMatchObject({ error: { code: "CANCELLED" } });
        permit.release();
      }
      expect(log.records.filter((r) => r.level === "error")).toEqual([]);
    } finally {
      log.restore();
    }
  });
});
