import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { KB_LIMITS } from "./limits";
import {
  assertDiskFloor,
  capacityFor,
  commitQuota,
  expireQuota,
  type QuotaSession,
  releaseQuota,
  reserveQuota,
} from "./quota";

// Real directories for the filesystem-identity probe, anchored on this file so
// the result does not depend on the runner's cwd (package dir under turbo, repo
// root under a root-level vitest run).
const testDir = dirname(fileURLToPath(import.meta.url));
const parentDir = dirname(testDir);

const plenty = {
  async freeBytes() {
    return 10n << 30n;
  },
};

function scripted(
  handlers: Array<(text: string) => { rows: unknown[]; rowCount?: number } | undefined>,
): QuotaSession {
  let index = 0;
  return {
    transactionQuery: async (text) => {
      if (
        /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) /.test(text) ||
        text.includes("FOR UPDATE OF a") ||
        text.includes('ON CONFLICT (dimension, "subjectId") DO NOTHING')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT id, reserved"))
        return { rows: [{ id: "disk", reserved: "0" }], rowCount: 1 };
      const handler = handlers[index];
      index += 1;
      const result = handler?.(text);
      if (!result) throw new Error(`unexpected query ${index}: ${text}`);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    },
  };
}

describe("quota capacities", () => {
  it("maps storage and count caps including tombstone lineage", () => {
    expect(capacityFor("OWNER_LIVE_KB")).toBe(20n);
    expect(capacityFor("KB_BRANCH")).toBe(100n);
    expect(capacityFor("KB_HISTORY_BYTES")).toBe(1n << 30n);
    expect(capacityFor("KB_LINEAGE_BYTES")).toBe(1n << 30n);
    expect(capacityFor("OWNER_LINEAGE_BYTES")).toBe(5n << 30n);
  });

  it("rejects admission when injected free disk is below the 1 GiB floor", async () => {
    await expect(
      assertDiskFloor({
        async freeBytes() {
          return KB_LIMITS.freeDiskFloorBytes - 1n;
        },
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(
      assertDiskFloor({
        async freeBytes() {
          throw new Error("statfs");
        },
      }),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});

describe("quota reservations", () => {
  it.each(["charges", "disks"] as const)(
    "rejects more than 32 %s before SQL or disk measurement",
    async (field) => {
      const query = vi.fn(async () => {
        throw new Error("unexpected SQL");
      });
      const meter = { freeBytes: vi.fn(plenty.freeBytes) };
      await expect(
        reserveQuota(
          { transactionQuery: query },
          {
            opId: "oversized",
            charges: Array.from({ length: field === "charges" ? 33 : 1 }, (_, i) => ({
              dimension: "KB_BRANCH" as const,
              subjectId: `kb${i}`,
              amount: 1n,
            })),
            disks: Array.from({ length: field === "disks" ? 33 : 1 }, () => ({
              path: testDir,
              bytes: 0n,
              meter,
            })),
            expiresAt: new Date("2099-01-01"),
          },
        ),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      expect(query).not.toHaveBeenCalled();
      expect(meter.freeBytes).not.toHaveBeenCalled();
    },
  );

  it("refuses rollup scratch when another KB already reserved the shared filesystem headroom", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("SELECT id, reserved")
        ? [{ id: "shared-filesystem", reserved: String(100 << 20) }]
        : [],
      rowCount: 0,
    }));
    await expect(
      reserveQuota(
        { transactionQuery: query },
        {
          opId: "rollup-other-kb",
          charges: [],
          heldForPublication: true,
          expiresAt: new Date("2099-01-01"),
          disks: [
            {
              path: testDir,
              bytes: BigInt(96 << 20),
              meter: { freeBytes: async () => KB_LIMITS.freeDiskFloorBytes + BigInt(110 << 20) },
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "quota_reservation"'))).toBe(
      false,
    );
  });

  it("aggregates every positive charge by account before enforcing the entry bound", async () => {
    const amounts: string[] = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("SELECT id, reserved"))
        return { rows: [{ id: "disk", reserved: "0" }], rowCount: 1 };
      if (sql.includes('INSERT INTO "quota_account"') && sql.includes("RETURNING id")) {
        amounts.push(String(values[3]));
        return { rows: [{ id: "account" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const charges = Array.from({ length: 32 }, () => [
      { dimension: "KB_LINEAGE_BYTES" as const, subjectId: "kb", amount: 7n },
      { dimension: "OWNER_LINEAGE_BYTES" as const, subjectId: "owner", amount: 7n },
    ]).flat();
    const result = await reserveQuota(
      { transactionQuery: query },
      {
        opId: "32-assets",
        charges: [
          ...charges,
          { dimension: "KB_HISTORY_BYTES", subjectId: "kb", amount: 100n },
          { dimension: "KB_BRANCH", subjectId: "kb", amount: 1n },
        ],
        disks: [{ path: testDir, bytes: 0n, meter: plenty }],
        expiresAt: new Date("2099-01-01"),
      },
    );
    expect(result.charges.map((c) => c.amount)).toEqual([224n, 224n, 100n, 1n]);
    expect(amounts).toEqual(["224", "224", "100", "1"]);
    await expect(
      reserveQuota(
        { transactionQuery: query },
        {
          opId: "negative",
          charges: [...charges, { ...charges[0]!, amount: -1n }],
          disks: [{ path: testDir, bytes: 0n, meter: plenty }],
          expiresAt: new Date("2099-01-01"),
        },
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("accepts exactly 32 logical charges and 32 disk allocations", async () => {
    const lease = await reserveQuota(
      scripted(
        Array.from({ length: 32 }, (_, i) => [
          () => ({ rows: [{ id: `acct${i}` }] }),
          () => ({ rows: [] }),
        ]).flat(),
      ),
      {
        opId: "bounded",
        charges: Array.from({ length: 32 }, (_, i) => ({
          dimension: "KB_BRANCH" as const,
          subjectId: `kb${i}`,
          amount: 1n,
        })),
        disks: Array.from({ length: 32 }, () => ({
          path: testDir,
          bytes: 0n,
          meter: plenty,
        })),
        expiresAt: new Date("2099-01-01"),
      },
    );
    expect(lease.reservationIds).toHaveLength(32);
  });

  it("sums allocations across directories on one filesystem before admission", async () => {
    const meter = { freeBytes: async () => KB_LIMITS.freeDiskFloorBytes + 10n };
    await expect(
      reserveQuota(scripted([]), {
        opId: "combined",
        charges: [],
        expiresAt: new Date("2099-01-01"),
        disks: [
          { path: parentDir, bytes: 6n, meter },
          { path: testDir, bytes: 6n, meter },
        ],
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("keeps independent filesystems' headroom separate", async () => {
    const meter = { freeBytes: async () => KB_LIMITS.freeDiskFloorBytes + 10n };
    const update = vi.fn(() => ({ rows: [], rowCount: 1 }));
    const lease = await reserveQuota(scripted([update, update, update, update]), {
      opId: "independent",
      charges: [],
      expiresAt: new Date("2099-01-01"),
      disks: [
        { path: "/dev/shm", bytes: 10n, meter },
        { path: testDir, bytes: 10n, meter },
      ],
    });
    expect(lease.reservationIds).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(4);
  });

  it("fails closed on an unavailable allocation directory before SQL", async () => {
    const query = vi.fn();
    await expect(
      reserveQuota(
        { transactionQuery: query },
        {
          opId: "missing",
          charges: [],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: "/quota-test/missing", bytes: 1n, meter: plenty }],
        },
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(query).not.toHaveBeenCalled();
  });

  it("reserves against owner, kb, and disk caps then releases idempotently", async () => {
    const ids = ["disk", "acct", "res-1"];
    let n = 0;
    const lease = await reserveQuota(
      scripted([() => ({ rows: [{ id: "acct" }] }), () => ({ rows: [] })]),
      {
        opId: "op1",
        charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "user1", amount: 1n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: testDir, bytes: 0n, meter: plenty }],
        id: () => ids[n++] ?? "x",
      },
    );
    expect(lease.reservationIds).toEqual(["res-1"]);
    await releaseQuota(
      scripted([
        () => ({ rows: [{ accountId: "acct", amount: "1", dimension: "OWNER_LIVE_KB" }] }),
        () => ({ rows: [], rowCount: 1 }),
      ]),
      lease.reservationIds,
    );
    await releaseQuota(
      scripted([() => ({ rows: [] }), () => ({ rows: [{ outcome: "RELEASED" }] })]),
      lease.reservationIds,
    );
    expect(await expireQuota(scripted([() => ({ rows: [] })]), new Date("2099-01-02"))).toBe(0);
  });

  it("fails closed when quota storage is unavailable and when the cap is already taken", async () => {
    await expect(
      reserveQuota(
        {
          transactionQuery: async () => {
            throw new Error("down");
          },
        },
        {
          opId: "op2",
          charges: [{ dimension: "KB_BRANCH", subjectId: "kb1", amount: 1n }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: testDir, bytes: 0n, meter: plenty }],
        },
      ),
    ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(
      reserveQuota(scripted([() => ({ rows: [] })]), {
        opId: "op3",
        charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "user1", amount: 1n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: testDir, bytes: 0n, meter: plenty }],
      }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("replays a successful commit and rejects commit after release", async () => {
    await commitQuota(
      scripted([
        () => ({ rows: [{ accountId: "acct", amount: "1", dimension: "OWNER_LIVE_KB" }] }),
        () => ({ rows: [], rowCount: 1 }),
      ]),
      ["res-1"],
    );
    await commitQuota(
      scripted([() => ({ rows: [] }), () => ({ rows: [{ outcome: "COMMITTED" }] })]),
      ["res-1"],
    );
    await expect(
      commitQuota(scripted([() => ({ rows: [] }), () => ({ rows: [{ outcome: "RELEASED" }] })]), [
        "res-1",
      ]),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(
      commitQuota(scripted([() => ({ rows: [] }), () => ({ rows: [] })]), ["missing"]),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});
