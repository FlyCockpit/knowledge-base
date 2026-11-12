import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  instanceStart: vi.fn(),
  instanceReady: vi.fn(),
  instanceStop: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  disconnectDb: vi.fn(),
  disconnectRedis: vi.fn(),
  listen: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("@knowledge-base/env/load-dotenv", () => ({}));
vi.mock("@knowledge-base/env/shared", () => ({ env: { NODE_ENV: "production" } }));
vi.mock("@knowledge-base/db/instance-heartbeat", () => ({
  startInstanceHeartbeat: (options: unknown) => {
    state.instanceStart(options);
    return { markReady: state.instanceReady, stop: state.instanceStop };
  },
}));
vi.mock("@knowledge-base/db", () => ({ default: { $disconnect: state.disconnectDb } }));
vi.mock("@knowledge-base/queue", () => ({
  redisConnection: { disconnect: state.disconnectRedis },
}));
vi.mock("node:http", () => ({
  createServer: () => ({ listen: state.listen, close: state.close, on: state.on }),
}));
vi.mock("./operational-alerts.js", () => ({ sendOperationalFailureAlert: state.alert }));
vi.mock("./runtime.js", () => ({
  startWorkerRuntime: state.start,
  WorkerDrainError: class WorkerDrainError extends Error {},
}));
const listeners = new Map<string, (...args: unknown[]) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.resetAllMocks();
  listeners.clear();
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    listeners.set(String(event), listener);
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  state.start.mockImplementation(async (options) => {
    expect(listeners.has("SIGTERM")).toBe(true);
    expect(listeners.has("SIGINT")).toBe(true);
    expect(listeners.has("unhandledRejection")).toBe(true);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect("embedded" in options).toBe(false);
    options.onMaintenanceAdmitted();
    expect(state.instanceReady).not.toHaveBeenCalled();
    return { isReady: () => true, stop: state.stop };
  });
  state.stop.mockResolvedValue(undefined);
  state.disconnectDb.mockResolvedValue(undefined);
  state.alert.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("worker process entrypoint", () => {
  it("owns signals before processing, then listens only on the production loopback interface", async () => {
    await import("./index");
    expect(state.instanceStart).toHaveBeenCalledWith({ role: "worker" });
    expect(state.instanceReady).toHaveBeenCalledOnce();
    expect(state.listen).toHaveBeenCalledWith(3001, "127.0.0.1");
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.stop).toHaveBeenCalledOnce();
    expect(state.instanceStop).toHaveBeenCalledOnce();
    expect(state.disconnectDb).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it.each(["SIGTERM", "SIGINT", "unhandledRejection", "consumer failure"])(
    "%s during pending initial heartbeat cancels and drains before shared teardown",
    async (event) => {
      let finish: (() => void) | undefined;
      let fatal: ((error: Error) => void) | undefined;
      let aborted = false;
      state.start.mockImplementation((options) => {
        fatal = options.onFatal;
        options.onMaintenanceAdmitted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            aborted = true;
            finish = () => reject(new Error("cancelled after clean drain"));
          });
        });
      });
      const starting = import("./index");
      await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
      if (event === "consumer failure") fatal?.(new Error("fatal"));
      else listeners.get(event)?.(new Error("fatal"));
      expect(aborted).toBe(true);
      expect(state.instanceStop).toHaveBeenCalledOnce();
      expect(state.instanceReady).not.toHaveBeenCalled();
      expect(state.disconnectDb).not.toHaveBeenCalled();
      expect(state.listen).not.toHaveBeenCalled();
      finish?.();
      await starting;
      await vi.advanceTimersByTimeAsync(0);
      expect(state.disconnectDb).toHaveBeenCalledOnce();
      expect(process.exit).toHaveBeenCalledWith(event.startsWith("SIG") ? 0 : 1);
    },
  );

  it("does not register an instance when maintenance admission fails", async () => {
    state.start.mockRejectedValue(new Error("maintenance refused"));
    await import("./index");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.instanceStart).not.toHaveBeenCalled();
    expect(state.instanceReady).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("an unclean startup drain does not permit shared-client teardown", async () => {
    const { WorkerDrainError } = await import("./runtime.js");
    state.start.mockRejectedValue(new WorkerDrainError("still running"));
    await import("./index");
    await vi.advanceTimersByTimeAsync(0);
    expect(state.disconnectDb).not.toHaveBeenCalled();
    expect(state.disconnectRedis).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("watchdog bounds a hung startup drain even if the fatal alert stalls", async () => {
    state.start.mockImplementation(() => new Promise(() => {}));
    state.alert.mockImplementation(() => new Promise(() => {}));
    void import("./index");
    await vi.waitFor(() => expect(state.start).toHaveBeenCalled());
    listeners.get("unhandledRejection")?.(new Error("fatal"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(state.disconnectDb).not.toHaveBeenCalled();
  });

  it("health listener errors use the same fatal drain", async () => {
    await import("./index");
    const listener = state.on.mock.calls.find(([event]) => event === "error")?.[1];
    listener(new Error("listen failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.stop).toHaveBeenCalledOnce();
    expect(state.instanceStop).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
