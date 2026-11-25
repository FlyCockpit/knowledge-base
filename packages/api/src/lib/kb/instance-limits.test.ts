import { describe, expect, it } from "vitest";
import {
  describeCreateLimit,
  INSTANCE_LIMITS,
  readInstanceLimit,
  readInstanceLimits,
  writeInstanceLimits,
} from "./instance-limits";
import type { LockQuery } from "./lock";

/** An app_setting table in memory; records every statement. */
function settings(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = (async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT value FROM app_setting WHERE key = $1")) {
      const value = rows.get(values[0] as string);
      return {
        rows: value === undefined ? [] : [{ value }],
        rowCount: value === undefined ? 0 : 1,
      };
    }
    if (sql.startsWith("SELECT key, value FROM app_setting")) {
      const keys = values[0] as string[];
      const found = keys
        .filter((key) => rows.has(key))
        .map((key) => ({ key, value: rows.get(key) }));
      return { rows: found, rowCount: found.length };
    }
    if (sql.startsWith("INSERT INTO app_setting")) {
      rows.set(values[0] as string, values[1] as string);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "audit_event"')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL: ${sql}`);
  }) as LockQuery;
  return { query, rows, calls };
}

const audits = (calls: { sql: string; values: unknown[] }[]) =>
  calls.filter((call) => call.sql.includes('INSERT INTO "audit_event"'));

describe("instance limits: reads", () => {
  it("defaults to the compiled limits when no row exists", async () => {
    const { query } = settings();
    expect(await readInstanceLimits(query)).toEqual({
      createsPerHour: 5,
      ownedLiveKbs: 20,
      childTokensPerApiKey: 200,
    });
  });

  it.each([
    ["", 200],
    ["0", 200],
    ["-3", 200],
    ["2.5", 200],
    ["10001", 200],
    ["1e3", 200],
    ["abc", 200],
    [" 7", 200],
    ["1", 1],
    ["10000", 10000],
    ["150", 150],
  ])("reads a stored %j as %d (garbage and out-of-range mean the default)", async (raw, want) => {
    const { query } = settings({ [INSTANCE_LIMITS.childTokensPerApiKey.key]: raw });
    expect(await readInstanceLimit(query, "childTokensPerApiKey")).toBe(want);
    expect((await readInstanceLimits(query)).childTokensPerApiKey).toBe(want);
  });
});

describe("instance limits: admin write", () => {
  const actor = { userId: "admin-1", opId: "op-1" };

  it.each([
    { createsPerHour: 0 },
    { createsPerHour: 1001 },
    { ownedLiveKbs: 10_001 },
    { childTokensPerApiKey: 0 },
    { childTokensPerApiKey: 1.5 },
    { ownedLiveKbs: Number.NaN },
  ])("rejects %j (never clamps) and writes nothing", async (patch) => {
    const { query, rows, calls } = settings();
    await expect(writeInstanceLimits(query, actor, patch)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(rows.size).toBe(0);
    expect(audits(calls)).toHaveLength(0);
  });

  it("rejects the whole patch when one value is out of range", async () => {
    const { query, rows } = settings();
    await expect(
      writeInstanceLimits(query, actor, { createsPerHour: 3, ownedLiveKbs: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(rows.size).toBe(0);
  });

  it("upserts each changed limit, audits it with before/after, and returns the stored values", async () => {
    const { query, rows, calls } = settings({ [INSTANCE_LIMITS.ownedLiveKbs.key]: "30" });
    const result = await writeInstanceLimits(query, actor, {
      createsPerHour: 2,
      ownedLiveKbs: 30, // unchanged: no write, no audit
      childTokensPerApiKey: 1,
    });
    expect(result).toEqual({ createsPerHour: 2, ownedLiveKbs: 30, childTokensPerApiKey: 1 });
    expect(Object.fromEntries(rows)).toEqual({
      "kb.limits.createsPerHour": "2",
      "kb.limits.ownedLiveKbs": "30",
      "kb.limits.childTokensPerApiKey": "1",
    });
    const events = audits(calls);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.values).toContain("instance_limit_update");
      expect(event.values).toContain("user:admin-1");
    }
    const metadata = events.map((event) => JSON.parse(String(event.values.at(-1))));
    expect(metadata).toEqual([
      { limit: "createsPerHour", before: "5", after: "2" },
      { limit: "childTokensPerApiKey", before: "200", after: "1" },
    ]);
  });
});

describe("describeCreateLimit", () => {
  it("names the live budget, the window and the wait", async () => {
    const { query } = settings({ [INSTANCE_LIMITS.createsPerHour.key]: "3" });
    expect(await describeCreateLimit(query, 42)).toEqual({
      limit: 3,
      windowSeconds: 3600,
      retryAfterSeconds: 42,
      message: "You can create 3 knowledge bases per 60 minutes. Try again in 42s.",
    });
    expect((await describeCreateLimit(settings().query, undefined)).retryAfterSeconds).toBe(3600);
  });
});
