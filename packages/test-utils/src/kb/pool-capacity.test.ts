import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("REDIS_URL", undefined);
  vi.doMock("@knowledge-base/env/shared", () => {
    throw new Error("Fixture construction must not import application environment.");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@knowledge-base/env/shared");
  vi.doUnmock("@knowledge-base/db/client");
  vi.doUnmock("@knowledge-base/db/prisma-adapter");
  vi.doUnmock("pg");
});

function mockPoolConstruction() {
  const adapter = {};
  const createAdapter = vi.fn((_config: { connectionString: string; max: number }) => adapter);
  const createClient = vi.fn();
  vi.doMock("@knowledge-base/db/prisma-adapter", () => ({ createPrismaPgAdapter: createAdapter }));
  vi.doMock("@knowledge-base/db/client", () => ({
    PrismaClient: class {
      constructor(options: unknown) {
        createClient(options);
      }
    },
  }));
  return { createAdapter, createClient };
}

/** Exercise the real fixture factory; only driver I/O and construction are fake. */
async function fixtureWithoutPostgres() {
  vi.stubEnv("KB_TEST_ID", "capacity");
  vi.stubEnv("KB_TEST_PG_HOST", "127.0.0.1");
  vi.stubEnv("KB_TEST_PG_PORT", "5432");
  vi.stubEnv("KB_TEST_PG_SUPERUSER_PASSWORD", "fixture-only");
  vi.stubEnv("KB_TEST_TZ", Intl.DateTimeFormat().resolvedOptions().timeZone);
  vi.stubEnv("KB_TEST_PG_TIMEZONE", "America/Bogota");
  vi.doMock("pg", () => ({
    Client: class {
      on() {}
      async connect() {}
      async end() {}
      async query(text: string) {
        return { rows: text.includes("current_setting") ? [{ tz: "America/Bogota" }] : [] };
      }
    },
  }));
  const { openKbPostgresClusterFromEnv } = await import("./postgres");
  const cluster = await openKbPostgresClusterFromEnv();
  return cluster.createDatabase("capacity");
}

function readyApplicationUrls() {
  vi.doUnmock("@knowledge-base/env/shared");
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/slot_factory_unit");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
}

describe("fixture and production factory capacity agreement", () => {
  it.each([
    [undefined, 10],
    ["", 10],
    ["3", 3],
    ["8", 8],
  ] as const)("shares capacity %s → %s before and after URLs are ready", async (input, poolMax) => {
    vi.stubEnv("DATABASE_POOL_MAX", input);
    const construction = mockPoolConstruction();
    const slots = await import("@knowledge-base/db/lock-slots");
    // A queued nested borrower must progress when the fixture first configures
    // the pool, without losing the already-held outer reservation.
    expect(slots.tryAcquireSlots()).toBe(true);
    const borrower = vi.fn(async () => "progress");
    const pending = slots.withLockSlot(borrower, { nested: 1 });
    expect(borrower).not.toHaveBeenCalled();
    const fixture = await fixtureWithoutPostgres();
    fixture.createPrismaClient("runtime");
    slots.releaseSlots();
    await expect(pending).resolves.toBe("progress");
    // Fixture work must already have its full budget before production imports.
    expect(slots.tryAcquireSlots(poolMax - 1)).toBe(true);
    expect(slots.tryAcquireSlots()).toBe(false);
    slots.releaseSlots(poolMax - 1);
    fixture.createPrismaClient("applier");
    // The real shared env validator is loaded only now, as in browser setup.
    readyApplicationUrls();
    await import("@knowledge-base/db");
    expect(construction.createAdapter.mock.calls).toHaveLength(3);
    for (const [config] of construction.createAdapter.mock.calls) {
      expect(config).toMatchObject({ max: poolMax });
    }
    expect(construction.createClient).toHaveBeenCalledTimes(3);
    expect(slots.tryAcquireSlots(poolMax - 1)).toBe(true);
    expect(slots.tryAcquireSlots()).toBe(false);
    slots.releaseSlots(poolMax - 1);
    await expect(slots.withLockSlot(async () => "nested progress", { nested: 1 })).resolves.toBe(
      "nested progress",
    );
  });

  it.each(["2", "0", "3.5", "invalid"])(
    "both factories reject invalid capacity %s",
    async (input) => {
      vi.stubEnv("DATABASE_POOL_MAX", input);
      const construction = mockPoolConstruction();
      const fixture = await fixtureWithoutPostgres();
      expect(() => fixture.createPrismaClient()).toThrow();
      readyApplicationUrls();
      await expect(import("@knowledge-base/db")).rejects.toMatchObject({
        name: "EnvValidationError",
      });
      expect(construction.createAdapter).not.toHaveBeenCalled();
      expect(construction.createClient).not.toHaveBeenCalled();
      const slots = await import("@knowledge-base/db/lock-slots");
      expect(slots.tryAcquireSlots(2)).toBe(true);
      expect(slots.tryAcquireSlots()).toBe(false);
      slots.releaseSlots(2);
    },
  );
});
