import { captureLog } from "@knowledge-base/env/log";
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
  it("logs the offline-recovery refusal with its stable code before refusing startup", async () => {
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("pg_try")
        ? [{ held: true }]
        : sql.includes("WHERE key=")
          ? [{ value: '{"assetStorageAttempt":null}' }]
          : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    const log = captureLog();
    try {
      const close = vi.fn();
      await expect(startMaintenanceParticipant("inert", close)).rejects.toThrow(/offline recovery/);
      expect(close).toHaveBeenCalledOnce();
      expect(log.records).toEqual([
        expect.objectContaining({
          site: "kb.maintenance-recovery-required",
          level: "warn",
          code: "MAINTENANCE_RECOVERY_REQUIRED",
        }),
      ]);
    } finally {
      log.restore();
    }
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
  it("registers only under a session-held liveness token, retrying a token another session owns", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let tokenTries = 0;
    state.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("$1::int,$2::int")) return { rows: [{ held: ++tokenTries > 1 }] };
      return { rows: sql.includes("pg_try") ? [{ held: true }] : [] };
    });
    const { startMaintenanceParticipant, MAINTENANCE_PARTICIPANT_LOCK_CLASS } = await import(
      "./maintenance"
    );
    const permit = await startMaintenanceParticipant("inert", vi.fn());
    const tokens = calls.filter((c) => c.sql.includes("$1::int,$2::int"));
    expect(tokens).toHaveLength(2);
    expect(tokens.every((c) => c.values[0] === MAINTENANCE_PARTICIPANT_LOCK_CLASS)).toBe(true);
    const insert = calls.findIndex((c) => c.sql.startsWith("INSERT INTO app_setting"));
    expect(insert).toBeGreaterThan(calls.indexOf(tokens[1]!));
    const key = String(calls[insert]?.values[0]);
    expect(key).toMatch(
      new RegExp(
        `^kb\\.maintenance\\.participant\\.${tokens[1]?.values[1]}\\.[A-Za-z0-9-]+\\.${process.pid}\\.`,
      ),
    );
    await permit.release();
  });
  it("refuses startup when no liveness token can be taken", async () => {
    state.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("$1::int,$2::int")
        ? [{ held: false }]
        : sql.includes("pg_try")
          ? [{ held: true }]
          : [],
    }));
    const { startMaintenanceParticipant } = await import("./maintenance");
    await expect(startMaintenanceParticipant("inert", vi.fn())).rejects.toThrow(/token/);
    expect(state.end).toHaveBeenCalledOnce();
  });
  it("writes keys the backup coordinator parses (token, host, pid)", async () => {
    const { maintenanceParticipantKey, MAINTENANCE_PARTICIPANT_LOCK_CLASS } = await import(
      "./maintenance"
    );
    const { describeParticipant } = await import("../../../../../scripts/lib/kb-backup.mjs");
    expect(MAINTENANCE_PARTICIPANT_LOCK_CLASS).toBe(0x4b424d50);
    expect(describeParticipant(maintenanceParticipantKey(2 ** 31 - 1, "web.host_1", 4242))).toBe(
      "web-host-1 pid 4242",
    );
  });
  it("never reuses a token a crashed participant's row still carries", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    let staleChecks = 0;
    state.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("key LIKE $1"))
        return { rows: ++staleChecks === 1 ? [{ "?column?": 1 }] : [] };
      return { rows: sql.includes("pg_try") ? [{ held: true }] : [] };
    });
    const { startMaintenanceParticipant } = await import("./maintenance");
    const permit = await startMaintenanceParticipant("inert", vi.fn());
    const tokens = calls.filter((c) => c.sql.includes("pg_try_advisory_lock($1::int,$2::int)"));
    expect(tokens).toHaveLength(2);
    const unlock = calls.find((c) => c.sql.includes("pg_advisory_unlock($1::int,$2::int)"));
    expect(unlock?.values[1]).toBe(tokens[0]?.values[1]);
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO app_setting"));
    expect(String(insert?.values[0])).toMatch(
      new RegExp(`^kb\\.maintenance\\.participant\\.${tokens[1]?.values[1]}\\.`),
    );
    await permit.release();
  });
});
