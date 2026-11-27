import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("REDIS_URL", undefined);
  // Even a deferred import of shared application config is a regression.
  vi.doMock("@knowledge-base/env/shared", () => {
    throw new Error("Slot admission must not import application environment.");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@knowledge-base/env/shared");
  vi.doUnmock("../prisma/generated/client");
  vi.doUnmock("./prisma-adapter");
});

describe("pool slot configuration", () => {
  it("imports, configures and runs without DATABASE_URL or REDIS_URL", async () => {
    const slots = await import("./lock-slots");
    slots.configureLockSlots(8);
    await expect(slots.withLockSlot(async () => "ran")).resolves.toBe("ran");
    expect(slots.tryAcquireSlots(7)).toBe(true);
    expect(slots.tryAcquireSlots()).toBe(false);
    slots.releaseSlots(7);
  });

  it("makes progress on first use with two conservative slots before a factory runs", async () => {
    const slots = await import("./lock-slots");
    await expect(
      slots.withLockSlot(
        async () => {
          expect(slots.tryAcquireSlots()).toBe(false);
          return slots.withLockSlot(async () => "nested");
        },
        { nested: 1 },
      ),
    ).resolves.toBe("nested");
    expect(slots.tryAcquireSlots(2)).toBe(true);
    expect(slots.tryAcquireSlots()).toBe(false);
    slots.releaseSlots(2);
  });

  it.each([0, 1, 2, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "rejects invalid pool max %s without changing the conservative budget",
    async (poolMax) => {
      const slots = await import("./lock-slots");
      expect(() => slots.configureLockSlots(poolMax)).toThrow(/at least 3/);
      expect(slots.tryAcquireSlots(2)).toBe(true);
      expect(slots.tryAcquireSlots()).toBe(false);
      slots.releaseSlots(2);
      slots.configureLockSlots(3);
    },
  );

  it("accepts multiple matching pools and refuses a different budget even when idle", async () => {
    const slots = await import("./lock-slots");
    slots.configureLockSlots(8);
    slots.configureLockSlots(8);
    expect(() => slots.configureLockSlots(10)).toThrow(/different pool max/);
    expect(() => slots.configureLockSlots(3)).toThrow(/different pool max/);
    expect(slots.tryAcquireSlots(7)).toBe(true);
    expect(() => slots.configureLockSlots(3)).toThrow(/different pool max/);
    slots.configureLockSlots(8);
    expect(slots.tryAcquireSlots()).toBe(false);
    slots.releaseSlots(7);
  });

  it("preserves active reservations and FIFO waiters when a different pool is refused", async () => {
    const slots = await import("./lock-slots");
    slots.configureLockSlots(3);
    expect(slots.tryAcquireSlots()).toBe(true);
    const order: string[] = [];
    const pair = slots.withLockSlot(async () => order.push("pair"), { nested: 1 });
    const single = slots.withLockSlot(async () => order.push("single"));
    expect(() => slots.configureLockSlots(8)).toThrow(/different pool max/);
    slots.configureLockSlots(3);
    expect(order).toEqual([]);
    expect(slots.tryAcquireSlots()).toBe(false);
    slots.releaseSlots();
    await Promise.all([pair, single]);
    expect(order).toEqual(["pair", "single"]);
  });
});

/** Only construction is intercepted: the real production factory and slots run. */
function mockPoolConstruction(poolMax: number) {
  const adapter = {};
  const createAdapter = vi.fn(() => adapter);
  const createClient = vi.fn();
  vi.doMock("@knowledge-base/env/shared", () => ({
    env: {
      DATABASE_POOL_MAX: poolMax,
      DATABASE_URL: { reveal: () => "postgresql://localhost/slot_factory_unit" },
    },
  }));
  vi.doMock("./prisma-adapter", () => ({ createPrismaPgAdapter: createAdapter }));
  vi.doMock("../prisma/generated/client", () => ({
    PrismaClient: class {
      constructor(options: unknown) {
        createClient(options);
      }
    },
  }));
  return { adapter, createAdapter, createClient };
}

describe("production pool boundary", () => {
  it.each([3, 8, 10, 25])(
    "matches adapter max %s before constructing the client",
    async (poolMax) => {
      const construction = mockPoolConstruction(poolMax);
      const slots = await import("./lock-slots");
      construction.createAdapter.mockImplementation(() => {
        expect(slots.tryAcquireSlots(poolMax - 1)).toBe(true);
        expect(slots.tryAcquireSlots()).toBe(false);
        slots.releaseSlots(poolMax - 1);
        return construction.adapter;
      });
      await import("./index");
      expect(construction.createAdapter).toHaveBeenCalledWith({
        connectionString: "postgresql://localhost/slot_factory_unit",
        max: poolMax,
      });
      expect(construction.createClient).toHaveBeenCalledWith({ adapter: construction.adapter });
    },
  );

  it("can construct the pool inside first admission and admits queued work after expansion", async () => {
    mockPoolConstruction(8);
    const slots = await import("./lock-slots");
    await slots.withLockSlot(
      async () => {
        const queued = vi.fn(async () => "queued");
        const work = slots.withLockSlot(queued, { nested: 1 });
        expect(queued).not.toHaveBeenCalled();
        // Models a lazy application factory reached by the first query.
        await import("./index");
        await expect(work).resolves.toBe("queued");
        await expect(slots.withLockSlot(async () => "nested")).resolves.toBe("nested");
        // The outer holder still owns both its slots after configuration.
        expect(slots.tryAcquireSlots(5)).toBe(true);
        expect(slots.tryAcquireSlots()).toBe(false);
        slots.releaseSlots(5);
      },
      { nested: 1 },
    );
    expect(slots.tryAcquireSlots(7)).toBe(true);
    slots.releaseSlots(7);
  });
});
