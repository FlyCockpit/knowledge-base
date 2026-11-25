import { describe, expect, it } from "vitest";
import {
  acquireQuerySlot,
  CAS_BLOB_MAX_BYTES,
  chargeRate,
  chargeRpcBatch,
  createMemoryRatePort,
  createRedisRatePort,
  KB_LIMITS,
  KB_TREE_LIMITS,
} from "./limits";

describe("KB_TREE_LIMITS", () => {
  it("exports the whole-tree budgets", () => {
    expect(KB_TREE_LIMITS.maxFiles).toBe(4096);
    expect(KB_TREE_LIMITS.maxMarkdownBytes).toBe(2 * 1024 * 1024);
    expect(KB_TREE_LIMITS.maxTreeBytes).toBe(64 * 1024 * 1024);
    expect(KB_TREE_LIMITS.maxNewCommitsPerPush).toBe(512);
  });
});

describe("KB_LIMITS", () => {
  it("exports the domain budgets", () => {
    expect(KB_LIMITS.ownedLiveKbsPerUser).toBe(20);
    expect(KB_LIMITS.branchesPerKb).toBe(100);
    expect(KB_LIMITS.gitHistoryBytesPerKb).toBe(1n << 30n);
    expect(KB_LIMITS.casLineageBytesPerKb).toBe(1n << 30n);
    expect(KB_LIMITS.casLineageBytesPerOwner).toBe(5n << 30n);
    expect(KB_LIMITS.freeDiskFloorBytes).toBe(1n << 30n);
    expect(KB_LIMITS.createsPerHourPerUser).toBe(5);
    expect(KB_LIMITS.mutationsPerMinutePerActorKb).toBe(60);
    expect(KB_LIMITS.uploadBytesPerHourPerUser).toBe(100n << 20n);
    expect(KB_LIMITS.providerRevisionsPerProvider).toBe(50);
    expect(KB_LIMITS.providerRevisionsPerUser).toBe(
      KB_LIMITS.providersPerUser * KB_LIMITS.providerRevisionsPerProvider,
    );
    expect(CAS_BLOB_MAX_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe("rate charging", () => {
  it("fails closed for unknown buckets in both the memory and Redis ports", async () => {
    for (const port of [createMemoryRatePort(), createRedisRatePort({})]) {
      await expect(port.consume("kb:unknown", "user", 1)).resolves.toEqual({ unavailable: true });
    }
  });

  it("charges every RPC batch element against its own budget", async () => {
    const port = createMemoryRatePort();
    await chargeRpcBatch(port, [
      { kind: "mutation", key: "actor:kb" },
      { kind: "mutation", key: "actor:kb" },
      { kind: "query", key: "user:kb" },
    ]);
    expect(port.counts.get("kb:mutation:actor:kb")).toBe(2);
    expect(port.counts.get("kb:query:user:kb")).toBe(1);
  });

  it("rate-limits an exhausted bucket and fails closed when the store is down", async () => {
    const port = createMemoryRatePort();
    for (let i = 0; i < KB_LIMITS.createsPerHourPerUser; i += 1) {
      await chargeRate(port, { kind: "create", key: "user1" });
    }
    await expect(chargeRate(port, { kind: "create", key: "user1" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    await expect(
      chargeRate(
        {
          async consume() {
            return { unavailable: true };
          },
        },
        { kind: "mutation", key: "x" },
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });

  it("charges the create window against a live budget when one is given", async () => {
    const port = createMemoryRatePort();
    // Admin → Limits lowered the hourly create budget to 2.
    await chargeRate(port, { kind: "create", key: "user2", limit: 2 });
    await chargeRate(port, { kind: "create", key: "user2", limit: 2 });
    await expect(
      chargeRate(port, { kind: "create", key: "user2", limit: 2 }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 3600 });
    // Raising it applies to the window in progress (one shared counter).
    await expect(chargeRate(port, { kind: "create", key: "user2", limit: 3 })).resolves.toBe(
      undefined,
    );
    expect(port.counts.get("kb:create:user2")).toBe(3);
    // chargeRate hands the budget to the port.
    const seen: unknown[] = [];
    await chargeRate(
      {
        async consume(...args) {
          seen.push(args);
          return { ok: true };
        },
      },
      { kind: "create", key: "u", limit: 7 },
    );
    expect(seen).toEqual([["kb:create", "u", 1, 7]]);
  });

  it("the Redis port fails closed on an unusable budget", async () => {
    const port = createRedisRatePort({});
    for (const limit of [0, -1, 1.5, Number.NaN])
      await expect(port.consume("kb:create", "u", 1, limit)).resolves.toEqual({
        unavailable: true,
      });
  });

  it("caps in-flight queries per user", async () => {
    let held = 0;
    const slots = {
      async tryAcquire(_key: string, max: number) {
        if (held >= max) return false;
        held += 1;
        return true;
      },
      async release() {
        held -= 1;
      },
    };
    for (let i = 0; i < KB_LIMITS.queryInFlightPerUser; i += 1) {
      await acquireQuerySlot(slots, "user1");
    }
    await expect(acquireQuerySlot(slots, "user1")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});
