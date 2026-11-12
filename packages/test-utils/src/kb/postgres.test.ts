import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: vi.fn(), spawn: vi.fn() }));
vi.mock("pg", () => ({
  Client: class {
    connect = vi.fn(async () => {});
    end = vi.fn(async () => {});
    on = vi.fn();
    query = state.query;
  },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: state.spawn,
}));
const { openKbPostgresClusterFromEnv, assertTestDatabaseUrl } = await import("./postgres.js");

beforeEach(() => {
  vi.stubEnv("KB_TEST_ID", "fixture");
  vi.stubEnv("KB_TEST_PG_HOST", "127.0.0.1");
  vi.stubEnv("KB_TEST_PG_PORT", "5432");
  vi.stubEnv("KB_TEST_PG_SUPERUSER_PASSWORD", "disposable-fixture-password");
  vi.stubEnv("KB_TEST_TZ", Intl.DateTimeFormat().resolvedOptions().timeZone);
  vi.stubEnv("KB_TEST_PG_TIMEZONE", "Pacific/Honolulu");
  state.query.mockReset().mockImplementation(async (text: string) => ({
    rows: text.includes("current_setting('TimeZone')") ? [{ tz: "Pacific/Honolulu" }] : [],
    rowCount: 0,
  }));
  state.spawn.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
});
afterEach(() => vi.unstubAllEnvs());

describe("migration-backed Postgres fixture", () => {
  it("uses the committed migration runner with an owned engine and no runtime identity", async () => {
    const cluster = await openKbPostgresClusterFromEnv();
    const db = await cluster.createDatabase("migrationunit");
    try {
      db.applyPrismaSchema();
      const [executable, args, options] = state.spawn.mock.calls[0]!;
      expect(executable).toBe(process.execPath);
      expect(args.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
      expect(args[2]).toContain("scripts/db/migrate-runtime.mjs");
      expect(args[2]).toContain("scripts/db/lib/prisma.mjs");
      expect(args[2]).toContain("guardPath:");
      expect(args[2]).toContain("tempConfig");
      expect(args[2]).toContain("'--config'");
      expect(args[2]).not.toContain('"push"');
      expect(options.env.DATABASE_URL).toBe(db.urls.applier);
      expect(options.env.KB_INSTANCE_ID).toBeUndefined();
      expect(
        state.query.mock.calls.some(([sql]) => String(sql).includes("ALTER DEFAULT PRIVILEGES")),
      ).toBe(true);
    } finally {
      await cluster.close();
    }
    expect(() => db.applyPrismaSchema()).toThrow("is closed");
  });
  it("rejects a replaced nonfixture URL before spawning a migration", async () => {
    const cluster = await openKbPostgresClusterFromEnv();
    const db = await cluster.createDatabase("urlunit");
    try {
      db.urls.applier = "postgresql://postgres:disposable@localhost/knowledge_base";
      expect(() => db.applyPrismaSchema()).toThrow("Refusing shared developer");
      expect(state.spawn).not.toHaveBeenCalled();
      expect(() =>
        assertTestDatabaseUrl("postgresql://kb_applier_fixture:x@elsewhere/kb_test_fixture"),
      ).toThrow("non-loopback");
    } finally {
      await cluster.close();
    }
  });
  it("redacts the fixture credential and URL when a migration fails", async () => {
    const cluster = await openKbPostgresClusterFromEnv();
    const db = await cluster.createDatabase("redactionunit");
    try {
      const password = new URL(db.urls.applier).password;
      state.spawn.mockReturnValue({
        status: 1,
        stdout: db.urls.applier,
        stderr: `connection failed ${password}`,
      });
      let message = "";
      try {
        db.applyPrismaSchema();
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("Prisma fixture schema failed");
      expect(message).not.toContain(db.urls.applier);
      expect(message).not.toContain(password);
    } finally {
      await cluster.close();
    }
  });
});
