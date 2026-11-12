import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {
    KB_INSTANCE_ID: "0b9b6c1e-6f39-4d4a-9a7e-3f2b1c0d9e8f" as string | undefined,
    DATABASE_URL: { reveal: () => state.url },
  },
  url: "postgresql://u:p@db:5432/app",
  queryRaw: vi.fn(),
}));
vi.mock("@knowledge-base/env/shared", () => ({ env: state.env }));
vi.mock("./index", () => ({ default: { $queryRaw: state.queryRaw } }));
vi.mock("../prisma/generated/client", () => ({
  Prisma: { raw: (sql: string) => ({ raw: sql }) },
}));

/** The SQL text and values of the nth $queryRaw call. */
function call(n: number) {
  const [strings, ...values] = state.queryRaw.mock.calls[n] ?? [];
  return { sql: (strings as string[]).join("?"), values };
}

let log: ReturnType<typeof captureLog>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  state.queryRaw.mockReset();
  state.queryRaw.mockResolvedValue([{ schema_level: "20261101000000_x" }]);
  state.env.KB_INSTANCE_ID = "0b9b6c1e-6f39-4d4a-9a7e-3f2b1c0d9e8f";
  state.url = "postgresql://u:p@db:5432/app";
  log = captureLog();
});
afterEach(() => {
  log.restore();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startInstanceHeartbeat", () => {
  it("is a no-op without KB_INSTANCE_ID", async () => {
    state.env.KB_INSTANCE_ID = undefined;
    const { startInstanceHeartbeat } = await import("./instance-heartbeat");
    const heartbeat = startInstanceHeartbeat({ role: "server" });
    heartbeat.markReady();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.queryRaw).not.toHaveBeenCalled();
  });

  it("ticks immediately, then every 60 s after the previous tick completes", async () => {
    const { startInstanceHeartbeat, HEARTBEAT_INTERVAL_MS } = await import("./instance-heartbeat");
    let finish: (() => void) | undefined;
    state.queryRaw.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve([{ schema_level: "x" }]))),
    );
    startInstanceHeartbeat({ role: "worker" });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    // The first tick is still in flight: nothing else is scheduled yet.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    finish?.();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1);
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.queryRaw).toHaveBeenCalledTimes(2);
    const { sql, values } = call(0);
    expect(sql).toMatch(/INSERT INTO \? AS i \(id, role, host, ready_at\)/);
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET last_seen_at = now\(\)/);
    expect(sql).toMatch(/RETURNING schema_level/);
    expect(values[0]).toEqual({ raw: '"public"."_knowledge_base_instance"' });
    expect(values.slice(1, 3)).toEqual(["0b9b6c1e-6f39-4d4a-9a7e-3f2b1c0d9e8f", "worker"]);
    expect(values[4]).toBe(false);
  });

  it("qualifies the table with Prisma's schema from DATABASE_URL", async () => {
    state.url = "postgresql://u:p@db:5432/app?schema=tenant";
    const { startInstanceHeartbeat } = await import("./instance-heartbeat");
    startInstanceHeartbeat({ role: "server" });
    await vi.advanceTimersByTimeAsync(0);
    expect(call(0).values[0]).toEqual({ raw: '"tenant"."_knowledge_base_instance"' });
  });

  it("markReady writes ready_at once (coalesce keeps the first) with an immediate tick", async () => {
    const { startInstanceHeartbeat } = await import("./instance-heartbeat");
    const heartbeat = startInstanceHeartbeat({ role: "server" });
    await vi.advanceTimersByTimeAsync(0);
    heartbeat.markReady();
    heartbeat.markReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.queryRaw).toHaveBeenCalledTimes(2);
    expect(call(1).values[4]).toBe(true);
    expect(call(1).sql).toMatch(/ready_at = coalesce\(i\.ready_at, EXCLUDED\.ready_at\)/);
  });

  it("warns once when the runner did not register this instance (NULL level)", async () => {
    state.queryRaw.mockResolvedValue([{ schema_level: null }]);
    const { startInstanceHeartbeat } = await import("./instance-heartbeat");
    startInstanceHeartbeat({ role: "server" });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(state.queryRaw.mock.calls.length).toBeGreaterThan(1);
    expect(log.records).toEqual([
      expect.objectContaining({
        site: "instance.unregistered",
        service: "server",
        rowId: state.env.KB_INSTANCE_ID,
      }),
    ]);
  });

  it("never throws: a missing registry warns once, other errors are logged and it keeps ticking", async () => {
    state.queryRaw.mockRejectedValue(
      Object.assign(new Error("raw query failed"), { meta: { code: "42P01" } }),
    );
    const { startInstanceHeartbeat } = await import("./instance-heartbeat");
    startInstanceHeartbeat({ role: "server" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log.records).toEqual([
      expect.objectContaining({ site: "instance.registry-missing", service: "server" }),
    ]);
    state.queryRaw.mockRejectedValue(new Error("connection reset"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.records[1]).toMatchObject({
      site: "instance.heartbeat",
      errorClass: "Error",
      service: "server",
    });
    expect(JSON.stringify(log.records)).not.toContain("connection reset");
    state.queryRaw.mockResolvedValue([{ schema_level: "x" }]);
    const before = state.queryRaw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.queryRaw.mock.calls.length).toBe(before + 1);
  });

  it("stop() clears the timer and writes nothing", async () => {
    const { startInstanceHeartbeat } = await import("./instance-heartbeat");
    const heartbeat = startInstanceHeartbeat({ role: "worker" });
    await vi.advanceTimersByTimeAsync(0);
    heartbeat.stop();
    heartbeat.markReady();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(state.queryRaw).toHaveBeenCalledTimes(1);
  });
});

it("does not issue a queued heartbeat after stop, including a queued markReady", async () => {
  const { startInstanceHeartbeat } = await import("./instance-heartbeat");
  const heartbeat = startInstanceHeartbeat({ role: "server" });
  heartbeat.markReady();
  heartbeat.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.queryRaw).not.toHaveBeenCalled();
});
