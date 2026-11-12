import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), connect: vi.fn() }));
vi.mock("pg", () => ({
  Client: class {
    query = state.query;
    end = state.end;
    connect = state.connect;
    on() {
      return this;
    }
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("maintenance participant", () => {
  it("checks storage admission before abandoned-maintenance recovery can make effects", async () => {
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("pg_try")
        ? [{ held: true }]
        : sql.includes("WHERE key=")
          ? [{ value: "request" }]
          : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    const recover = vi.fn();
    await expect(
      startMaintenanceParticipant("inert", vi.fn(), recover, undefined, async () => {
        throw new Error("mode mismatch");
      }),
    ).rejects.toThrow("mode mismatch");
    expect(recover).not.toHaveBeenCalled();
  });
  it("withholds acknowledgement and the permit until storage ownership drains", async () => {
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("pg_try") ? [{ held: true }] : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    let finish!: () => void;
    const pending = new Promise<void>((r) => {
      finish = r;
    });
    const permit = await startMaintenanceParticipant("inert", vi.fn(), undefined, () => pending);
    const release = permit.release();
    const duplicate = permit.release();
    expect(state.end).not.toHaveBeenCalled();
    finish();
    await Promise.all([release, duplicate]);
    expect(state.end).toHaveBeenCalledOnce();
  });
  it("retains the maintenance permit after a failed storage drain", async () => {
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("pg_try") ? [{ held: true }] : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    let fail = true;
    const permit = await startMaintenanceParticipant("inert", vi.fn(), undefined, async () => {
      if (fail) throw new Error("drain failed");
    });
    await expect(permit.release()).rejects.toThrow("drain failed");
    expect(state.end).not.toHaveBeenCalled();
    fail = false;
    await permit.release();
  });
  it("default admission holds a shared permit until the owner finishes draining", async () => {
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("pg_try") ? [{ held: true }] : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    const close = vi.fn();
    const permit = await startMaintenanceParticipant("inert", close);
    expect(close).not.toHaveBeenCalled();
    expect(state.end).not.toHaveBeenCalled();
    await permit.release();
    expect(state.end).toHaveBeenCalledOnce();
  });
  it.each(["ECONNREFUSED", "28P01", "57P03"])(
    "propagates the driver's own %s connect failure, not a configuration error",
    async (code) => {
      const failure = Object.assign(new Error("connect failed"), { code });
      state.connect.mockRejectedValue(failure);
      const { startMaintenanceParticipant } = await import("./maintenance");
      await expect(startMaintenanceParticipant("inert", vi.fn())).rejects.toBe(failure);
      expect(state.end).toHaveBeenCalledOnce();
    },
  );
  it("refuses startup during maintenance and releases the provisional session", async () => {
    vi.useFakeTimers();
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("pg_try") ? [{ held: false }] : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    await expect(startMaintenanceParticipant("inert", vi.fn())).rejects.toThrow(/maintenance/i);
    expect(state.end).toHaveBeenCalledOnce();
  });
  it("closes admission once for a durable request without releasing a live owner's permit", async () => {
    vi.useFakeTimers();
    let requested = false;
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("pg_try") ? [{ held: true }] : requested ? [{ value: "request" }] : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    const close = vi.fn();
    const permit = await startMaintenanceParticipant("inert", close);
    requested = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(close).toHaveBeenCalledOnce();
    expect(permit.requested).toBe(true);
    expect(state.end).not.toHaveBeenCalled();
    await permit.release();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([true, false])(
    "recovery keeps admission closed and cannot race a live coordinator (%s)",
    async (held) => {
      vi.useFakeTimers();
      state.query.mockImplementation(async (sql: string, values: unknown[]) => ({
        rows: sql.includes("pg_try")
          ? [{ held: values[0] === 0x4b424d52 ? held : true }]
          : [{ value: "durable" }],
      }));
      const recover = vi.fn(async () => {});
      const { startMaintenanceParticipant } = await import("./maintenance");
      await expect(startMaintenanceParticipant("inert", vi.fn(), recover)).rejects.toThrow(
        /recovery/,
      );
      expect(recover).toHaveBeenCalledTimes(held ? 1 : 0);
      expect(state.end).toHaveBeenCalledOnce();
    },
  );
});
