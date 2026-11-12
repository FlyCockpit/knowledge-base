// @ts-nocheck — scripts/*.mjs are untyped ESM consumed only by this PG suite.
import { execFileSync } from "node:child_process";
import { recordAuditEvent } from "@knowledge-base/api/lib/kb/audit";
import { checkoutPinnedSession } from "@knowledge-base/api/lib/kb/lock";
import {
  authorize,
  prismaAuthorityStore,
  recheckRead,
  recheckWriteBeforeReservation,
  sqlAuthorityStore,
} from "@knowledge-base/api/lib/kb/permissions";
import {
  commitQuota,
  expireQuota,
  releaseQuota,
  reserveQuota,
} from "@knowledge-base/api/lib/kb/quota";
import {
  recordTwoFactorGraceStartAtCreation,
  recordTwoFactorGraceStartForPolicyActivation,
  recordTwoFactorGraceStartForRoleChange,
  withOutgoingTwoFactorMcpSettlement,
} from "@knowledge-base/auth/ban";
import {
  isForcedTwoFactorActivation,
  isTwoFactorRequirementSatisfied,
} from "@knowledge-base/auth/two-factor-policy";
import { PrismaClient } from "@knowledge-base/db/client";
import { createPrismaPgAdapter } from "@knowledge-base/db/prisma-adapter";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertNoSessionOptionOverride } from "../../../../scripts/lib/session-timezone.mjs";
import { openKbPostgresClusterFromEnv } from "./index.js";

function filesystemSubject(path: string): string {
  return `fs:${execFileSync("/usr/bin/stat", ["--file-system", "--format=%t:%i", "--", path], { encoding: "utf8" }).trim()}`;
}

const diskSubjectId = filesystemSubject(process.cwd());

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DESCRIPTION = "a knowledge base used by authority tests";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
const prisma = db.createPrismaClient("applier");

afterAll(async () => {
  await prisma.$disconnect();
  await db.close();
  await cluster.close();
});

db.applyPrismaSchema();

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: db.urls.applier, connectionTimeoutMillis: 5_000 });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

async function quotaSession() {
  return checkoutPinnedSession({ connectionString: db.urls.applier, opId: crypto.randomUUID() });
}

async function user(email: string) {
  return prisma.user.create({
    data: { name: email, email, emailVerified: false },
  });
}

describe("Committed migration constraints", () => {
  it("registers named checks with the exact pg_catalog definitions", async () => {
    const defs = await db.query(
      "applier",
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND c.conname = ANY($1)
        ORDER BY c.conname`,
      [
        [
          "knowledge_base_active_requires_owner_head",
          "quota_account_nonnegative",
          "quota_reservation_positive_amount",
        ],
      ],
    );
    const byName = Object.fromEntries(defs.rows.map((row) => [row.conname, row.definition]));
    const indexes = await db.query(
      "applier",
      `SELECT t.relname AS table_name, i.indisunique, i.indisvalid, pg_get_indexdef(c.oid) AS definition
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE n.nspname = 'public' AND c.relname = 'knowledge_base_live_owner_slug'`,
    );
    expect(byName.knowledge_base_active_requires_owner_head).toBeTruthy();
    expect(indexes.rows[0]?.indisunique).toBe(true);
    expect(indexes.rows[0]?.table_name).toBe("knowledge_base");
  });

  it("detects a live owner+slug index with the wrong definition", async () => {
    const drop = ["DROP", "INDEX", "IF", "EXISTS", "knowledge_base_live_owner_slug"].join(" ");
    try {
      await db.query("applier", `${drop};`);
      await db.query(
        "applier",
        'CREATE INDEX knowledge_base_live_owner_slug ON "quota_account" (id);',
      );
      const live = await db.query(
        "applier",
        `SELECT i.indisunique, t.relname AS table_name
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        JOIN pg_class t ON t.oid=i.indrelid WHERE c.oid='knowledge_base_live_owner_slug'::regclass`,
      );
      expect(live.rows[0]).toEqual({ indisunique: false, table_name: "quota_account" });
    } finally {
      await db.query("applier", `${drop};`);
      await db.query(
        "applier",
        `CREATE UNIQUE INDEX knowledge_base_live_owner_slug
           ON "knowledge_base" ("ownerId", slug)
           WHERE "ownerId" IS NOT NULL AND state <> 'TOMBSTONED'::"KnowledgeBaseState";`,
      );
    }
  });

  it("rejects ACTIVE owner/head violations, duplicate shares, and live owner+slug collisions", async () => {
    const owner = await user("owner@example.com");
    const other = await user("other@example.com");
    await expect(
      prisma.knowledgeBase.create({
        data: {
          name: "Active",
          slug: "active",
          description: DESCRIPTION,
          state: "ACTIVE",
          ownerId: owner.id,
        },
      }),
    ).rejects.toThrow(/knowledge_base_active_requires_owner_head|violates check/i);
    await expect(
      prisma.knowledgeBase.create({
        data: {
          name: "Active",
          slug: "active-head",
          description: DESCRIPTION,
          state: "ACTIVE",
          headSha: HEAD,
        },
      }),
    ).rejects.toThrow(/knowledge_base_active_requires_owner_head|violates check/i);

    const live = await prisma.knowledgeBase.create({
      data: {
        name: "Live",
        slug: "notes",
        description: DESCRIPTION,
        state: "ACTIVE",
        ownerId: owner.id,
        headSha: HEAD,
      },
    });
    await expect(
      prisma.knowledgeBase.create({
        data: {
          name: "Dup",
          slug: "notes",
          description: DESCRIPTION,
          state: "CREATING",
          ownerId: owner.id,
        },
      }),
    ).rejects.toThrow(/knowledge_base_live_owner_slug|unique/i);

    await prisma.knowledgeBase.create({
      data: {
        name: "Other",
        slug: "notes",
        description: DESCRIPTION,
        state: "CREATING",
        ownerId: other.id,
      },
    });
    await prisma.knowledgeBase.create({
      data: {
        name: "Gone",
        slug: "notes",
        description: DESCRIPTION,
        state: "TOMBSTONED",
        ownerId: owner.id,
        headSha: HEAD,
      },
    });

    await prisma.kbShare.create({
      data: { kbId: live.id, userId: other.id, bits: ["read"] },
    });
    await expect(
      prisma.kbShare.create({
        data: { kbId: live.id, userId: other.id, bits: ["write"] },
      }),
    ).rejects.toThrow(/kb_share_kb_user_unique|unique/i);
    await expect(
      prisma.kbShare.create({
        data: { kbId: live.id, userId: "missing-user", bits: ["read"] },
      }),
    ).rejects.toThrow(/foreign key|kb_share_userId_fkey/i);
  });
});

describe("quota reservations", () => {
  const disk = {
    async freeBytes() {
      return 10n << 30n;
    },
  };

  function countInput(opId: string) {
    return {
      opId,
      charges: [{ dimension: "OWNER_LIVE_KB", subjectId: opId, amount: 1n }],
      expiresAt: new Date("2099-01-01"),
      disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
    };
  }

  async function expectNoQuota(opId: string) {
    const rows = await db.query(
      "applier",
      `SELECT count(*)::int AS n FROM "quota_reservation" WHERE "opId" = $1`,
      [opId],
    );
    expect(rows.rows[0]?.n).toBe(0);
    const balance = await db.query(
      "applier",
      `SELECT coalesce(sum(committed + reserved), 0)::text AS total
         FROM "quota_account" WHERE "subjectId" = $1`,
      [opId],
    );
    expect(balance.rows[0]?.total).toBe("0");
  }

  it("preserves a caller's read-only-prefix transaction for outer rollback", async () => {
    const client = await connect();
    const transactionQuery = (text, values) => client.query(text, values);
    const input = countInput("outer-read-only");
    try {
      await client.query("BEGIN");
      await client.query("SELECT 1");
      const before = await client.query("SELECT pg_current_xact_id_if_assigned() AS xid");
      expect(before.rows[0]?.xid).toBeNull();
      await reserveQuota({ transactionQuery }, input);
      await client.query("ROLLBACK");
      await expectNoQuota(input.opId);
    } finally {
      await client.end();
    }
  });

  it("rolls quota back when the authority lease transaction callback fails", async () => {
    const lease = await quotaSession();
    const input = countInput("outer-lease-failure");
    try {
      await lease.acquire([{ kind: "authority" }]);
      await expect(
        lease.transaction(async (transactionQuery) => {
          await transactionQuery("SELECT 1");
          await reserveQuota({ transactionQuery }, input);
          throw new Error("intent insert failed");
        }, true),
      ).rejects.toThrow("intent insert failed");
      await expectNoQuota(input.opId);
    } finally {
      await lease.close();
    }
  });

  it("isolates a caught later-dimension rejection and preserves earlier outer work", async () => {
    const lease = await quotaSession();
    const kept = countInput("outer-kept");
    const rejected = countInput("outer-rejected");
    rejected.disks[0].bytes = 20n;
    rejected.charges.push({ dimension: "KB_BRANCH", subjectId: rejected.opId, amount: 101n });
    try {
      await lease.transaction(async (transactionQuery) => {
        await reserveQuota({ transactionQuery }, kept);
        const before = await transactionQuery("SELECT pg_current_xact_id_if_assigned() AS xid");
        expect(before.rows[0]?.xid).not.toBeNull();
        await expect(reserveQuota({ transactionQuery }, rejected)).rejects.toMatchObject({
          code: "QUOTA_EXCEEDED",
        });
      });
      await expectNoQuota(rejected.opId);
      const volume = await db.query(
        "applier",
        `SELECT reserved FROM "quota_account" WHERE "subjectId" = $1`,
        [diskSubjectId],
      );
      expect(volume.rows).toEqual([{ reserved: "0" }]);
      const saved = await db.query(
        "applier",
        `SELECT reserved FROM "quota_account" WHERE "subjectId" = $1`,
        [kept.opId],
      );
      expect(saved.rows[0]?.reserved).toBe("1");
    } finally {
      await lease.close();
    }
  });

  it("rejects autocommit composition and nested standalone calls before charging", async () => {
    const lease = await quotaSession();
    const input = countInput("invalid-transaction-owner");
    try {
      await expect(reserveQuota({ transactionQuery: lease.query }, input)).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
      await lease.transaction(async () => {
        await expect(reserveQuota(lease, input)).rejects.toMatchObject({
          code: "STORAGE_UNAVAILABLE",
        });
      });
      await expectNoQuota(input.opId);
    } finally {
      await lease.close();
    }
  });

  it.each(["commit", "release", "expire"])(
    "leaves %s finalization under the caller's rollback",
    async (action) => {
      const lease = await quotaSession();
      const input = countInput(`outer-${action}`);
      try {
        const reserved = await reserveQuota(lease, input);
        await expect(
          lease.transaction(async (transactionQuery) => {
            const session = { transactionQuery };
            if (action === "commit") await commitQuota(session, reserved.reservationIds);
            if (action === "release") await releaseQuota(session, reserved.reservationIds);
            if (action === "expire") await expireQuota(session, new Date("2100-01-01"));
            throw new Error("outer failure");
          }),
        ).rejects.toThrow("outer failure");
        const rows = await db.query(
          "applier",
          `SELECT outcome FROM "quota_reservation" WHERE "opId" = $1`,
          [input.opId],
        );
        expect(rows.rows).toEqual([{ outcome: "RESERVED" }]);
        const balance = await db.query(
          "applier",
          `SELECT committed, reserved FROM "quota_account" WHERE "subjectId" = $1`,
          [input.opId],
        );
        expect(balance.rows).toEqual([{ committed: "0", reserved: "1" }]);
      } finally {
        await lease.close();
      }
    },
  );

  it("refreshes disk admission when another KB materializes and finalizes before the first SQL", async () => {
    const a = await quotaSession();
    const b = await quotaSession();
    const amount = 768n << 20n;
    let free = 2n << 30n;
    const meter = {
      async freeBytes() {
        return free;
      },
    };
    const input = (kbId: string) => ({
      opId: kbId,
      charges: [{ dimension: "KB_HISTORY_BYTES", subjectId: kbId, amount }],
      expiresAt: new Date("2099-01-01"),
      disks: [{ path: process.cwd(), bytes: amount, meter }],
    });
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let attempt: Promise<unknown> | undefined;
    try {
      const reserved = await reserveQuota(a, input("disk-finalize-a"));
      attempt = b.transaction(async (query) => {
        let first = true;
        return reserveQuota(
          {
            transactionQuery: async (text, values) => {
              if (first) {
                first = false;
                paused.resolve();
                await resume.promise;
              }
              return query(text, values);
            },
          },
          input("disk-finalize-b"),
        );
      });
      const rejected = expect(attempt).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      await paused.promise;
      free -= amount;
      await commitQuota(a, reserved.reservationIds);
      resume.resolve();
      await rejected;
      await expectNoQuota("disk-finalize-b");
      const volume = await db.query(
        "applier",
        `SELECT reserved FROM "quota_account" WHERE "subjectId" = $1`,
        [diskSubjectId],
      );
      expect(volume.rows[0]?.reserved).toBe("0");
    } finally {
      resume.resolve();
      await attempt?.catch(() => undefined);
      await a.close();
      await b.close();
    }
  });

  it("holds the volume lock from measurement through admission against finalization", async () => {
    const a = await quotaSession();
    const b = await quotaSession();
    const amount = 768n << 20n;
    let free = 2n << 30n;
    const measured = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let admission: Promise<unknown> | undefined;
    let finalization: Promise<unknown> | undefined;
    const input = (opId: string, bytes: bigint, meter: { freeBytes(): Promise<bigint> }) => ({
      opId,
      charges: [{ dimension: "KB_HISTORY_BYTES", subjectId: opId, amount: bytes }],
      expiresAt: new Date("2099-01-01"),
      disks: [{ path: process.cwd(), bytes, meter }],
    });
    try {
      const reserved = await reserveQuota(
        a,
        input("measure-lock-a", amount, {
          async freeBytes() {
            return free;
          },
        }),
      );
      admission = reserveQuota(
        b,
        input("measure-lock-b", 128n << 20n, {
          async freeBytes() {
            const snapshot = free;
            measured.resolve();
            await resume.promise;
            return snapshot;
          },
        }),
      );
      await measured.promise;
      free -= amount;
      finalization = commitQuota(a, reserved.reservationIds);
      await expect
        .poll(async () => {
          const blockers = await db.query("applier", "SELECT pg_blocking_pids($1) AS pids", [
            a.backendPid,
          ]);
          return blockers.rows[0]?.pids;
        })
        .toContain(b.backendPid);
      resume.resolve();
      const admitted = await admission;
      await finalization;
      const volume = await db.query(
        "applier",
        `SELECT reserved FROM "quota_account" WHERE "subjectId" = $1`,
        [diskSubjectId],
      );
      expect(volume.rows[0]?.reserved).toBe((128n << 20n).toString());
      expect(free - (128n << 20n)).toBeGreaterThanOrEqual(1n << 30n);
      await releaseQuota(b, admitted.reservationIds);
    } finally {
      resume.resolve();
      await Promise.allSettled([admission, finalization]);
      await a.close();
      await b.close();
    }
  });

  it.each([20n << 20n, 0n])(
    "charges paired logical lineage with only %s new physical bytes",
    async (bytes) => {
      const lease = await quotaSession();
      const amount = 20n << 20n;
      const volumeId = `lineage-volume-${bytes}`;
      const floor = 1n << 30n;
      let free = floor + (bytes === 0n ? 0n : 30n << 20n);
      try {
        const result = await reserveQuota(lease, {
          opId: volumeId,
          charges: [
            { dimension: "KB_LINEAGE_BYTES", subjectId: volumeId, amount },
            { dimension: "OWNER_LINEAGE_BYTES", subjectId: volumeId, amount },
          ],
          expiresAt: new Date("2099-01-01"),
          disks: [
            {
              path: process.cwd(),
              bytes,
              meter: {
                async freeBytes() {
                  return free;
                },
              },
            },
          ],
        });
        const pending = await db.query(
          "applier",
          `SELECT dimension, reserved FROM "quota_account" WHERE "subjectId" = ANY($1::text[])`,
          [[volumeId, diskSubjectId]],
        );
        expect(
          Object.fromEntries(pending.rows.map((row) => [row.dimension, row.reserved])),
        ).toEqual({
          KB_LINEAGE_BYTES: amount.toString(),
          OWNER_LINEAGE_BYTES: amount.toString(),
          DISK_VOLUME: bytes.toString(),
        });
        free -= bytes;
        await commitQuota(lease, result.reservationIds);
        const committed = await db.query(
          "applier",
          `SELECT dimension, committed, reserved FROM "quota_account" WHERE "subjectId" = ANY($1::text[])`,
          [[volumeId, diskSubjectId]],
        );
        for (const row of committed.rows) {
          expect(row.reserved).toBe("0");
          expect(row.committed).toBe(row.dimension === "DISK_VOLUME" ? "0" : amount.toString());
        }
        expect(free >= floor).toBe(true);
      } finally {
        await lease.close();
      }
    },
  );

  it("covers count and byte caps including owner lineage that retains tombstones", async () => {
    const client = await quotaSession();
    const query = client;
    try {
      await reserveQuota(query, {
        opId: "op-live",
        charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "user-cap", amount: 20n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      await expect(
        reserveQuota(query, {
          opId: "op-live-over",
          charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "user-cap", amount: 1n }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

      await reserveQuota(query, {
        opId: "op-branch",
        charges: [{ dimension: "KB_BRANCH", subjectId: "kb-cap", amount: 100n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      await expect(
        reserveQuota(query, {
          opId: "op-branch-over",
          charges: [{ dimension: "KB_BRANCH", subjectId: "kb-cap", amount: 1n }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

      await reserveQuota(query, {
        opId: "op-hist",
        charges: [{ dimension: "KB_HISTORY_BYTES", subjectId: "kb-hist", amount: 1n << 30n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      await expect(
        reserveQuota(query, {
          opId: "op-hist-over",
          charges: [{ dimension: "KB_HISTORY_BYTES", subjectId: "kb-hist", amount: 1n }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

      await reserveQuota(query, {
        opId: "op-lin",
        charges: [{ dimension: "KB_LINEAGE_BYTES", subjectId: "kb-lin", amount: 1n << 30n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      await expect(
        reserveQuota(query, {
          opId: "op-lin-over",
          charges: [{ dimension: "KB_LINEAGE_BYTES", subjectId: "kb-lin", amount: 1n }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

      await reserveQuota(query, {
        opId: "op-owner-lin",
        charges: [{ dimension: "OWNER_LINEAGE_BYTES", subjectId: "owner-lin", amount: 5n << 30n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      await expect(
        reserveQuota(query, {
          opId: "op-owner-lin-over",
          charges: [{ dimension: "OWNER_LINEAGE_BYTES", subjectId: "owner-lin", amount: 1n }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

      await expect(
        reserveQuota(query, {
          opId: "op-disk",
          charges: [{ dimension: "KB_HISTORY_BYTES", subjectId: "kb-disk", amount: 1n }],
          expiresAt: new Date("2099-01-01"),
          disks: [
            {
              path: process.cwd(),
              bytes: 1n,
              meter: {
                async freeBytes() {
                  return (1n << 30n) - 1n;
                },
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("lets only one of two boundary reservations succeed and keeps a non-negative balance", async () => {
    const a = await quotaSession();
    const b = await quotaSession();
    try {
      await a.query(
        `INSERT INTO "quota_account" (id, dimension, "subjectId", committed, reserved, "updatedAt")
         VALUES ($1, 'OWNER_LIVE_KB', $2, 19, 0, now())`,
        ["qa-boundary", "boundary-user"],
      );
      const expiresAt = new Date("2099-01-01");
      const attempt = (client: Awaited<ReturnType<typeof quotaSession>>, opId: string) =>
        reserveQuota(client, {
          opId,
          charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "boundary-user", amount: 1n }],
          expiresAt,
          disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        });
      const settled = await Promise.allSettled([attempt(a, "op-a"), attempt(b, "op-b")]);
      const ok = settled.filter((row) => row.status === "fulfilled");
      const failed = settled.filter((row) => row.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const balance = await db.query(
        "applier",
        `SELECT committed, reserved FROM "quota_account" WHERE "subjectId" = $1`,
        ["boundary-user"],
      );
      const committed = BigInt(balance.rows[0]?.committed ?? -1);
      const reserved = BigInt(balance.rows[0]?.reserved ?? -1);
      expect(committed >= 0n).toBe(true);
      expect(reserved >= 0n).toBe(true);
      expect(committed + reserved).toBe(20n);

      const lease = ok[0]?.status === "fulfilled" ? ok[0].value : undefined;
      expect(lease).toBeTruthy();
      await releaseQuota(a, lease?.reservationIds ?? []);
      await releaseQuota(a, lease?.reservationIds ?? []);
      const after = await db.query(
        "applier",
        `SELECT reserved FROM "quota_account" WHERE "subjectId" = $1`,
        ["boundary-user"],
      );
      expect(BigInt(after.rows[0]?.reserved ?? -1)).toBe(0n);
      expect(await expireQuota(a)).toBe(0);
    } finally {
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
    }
  });

  it("rolls back earlier charges when a later dimension is rejected", async () => {
    const client = await quotaSession();
    const query = client;
    try {
      await expect(
        reserveQuota(query, {
          opId: "op-partial",
          charges: [
            { dimension: "OWNER_LIVE_KB", subjectId: "atomic-user", amount: 1n },
            { dimension: "KB_BRANCH", subjectId: "atomic-kb", amount: 101n },
          ],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        }),
      ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
      const rows = await db.query(
        "applier",
        `SELECT dimension::text AS dimension, committed, reserved
           FROM "quota_account"
          WHERE "subjectId" IN ('atomic-user', 'atomic-kb')
          ORDER BY dimension`,
      );
      for (const row of rows.rows) {
        expect(BigInt(row.committed ?? -1) + BigInt(row.reserved ?? -1)).toBe(0n);
      }
      const reservations = await db.query(
        "applier",
        `SELECT count(*)::int AS n FROM "quota_reservation" WHERE "opId" = 'op-partial'`,
      );
      expect(reservations.rows[0]?.n).toBe(0);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("leaves no leaked reserved capacity when a charge fails after inserting the reservation row", async () => {
    const client = await quotaSession();
    let inserts = 0;
    const query = async (text: string, values?: unknown[]) => {
      const result = await client.query(text, values);
      if (text.includes('INSERT INTO "quota_reservation"')) {
        inserts += 1;
        if (inserts === 1) throw new Error("injected failure after reservation insert");
      }
      return result;
    };
    try {
      await expect(
        client.transaction(() =>
          reserveQuota(
            { transactionQuery: query },
            {
              opId: "op-crash",
              charges: [
                { dimension: "OWNER_LIVE_KB", subjectId: "crash-user", amount: 1n },
                { dimension: "KB_BRANCH", subjectId: "crash-kb", amount: 1n },
              ],
              expiresAt: new Date("2099-01-01"),
              disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
            },
          ),
        ),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      const balance = await db.query(
        "applier",
        `SELECT coalesce(sum(committed + reserved), 0)::text AS total
           FROM "quota_account"
          WHERE "subjectId" IN ('crash-user', 'crash-kb')`,
      );
      expect(BigInt(balance.rows[0]?.total ?? "-1")).toBe(0n);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("commits once, rejects expire/abort then commit, and keeps publication-held quota", async () => {
    const client = await quotaSession();
    const query = client;
    try {
      const lease = await reserveQuota(query, {
        opId: "op-commit",
        charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "commit-user", amount: 1n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      await commitQuota(query, lease.reservationIds);
      await commitQuota(query, lease.reservationIds);
      const once = await db.query(
        "applier",
        `SELECT committed, reserved FROM "quota_account" WHERE "subjectId" = 'commit-user'`,
      );
      expect(BigInt(once.rows[0]?.committed ?? -1)).toBe(1n);
      expect(BigInt(once.rows[0]?.reserved ?? -1)).toBe(0n);

      const released = await reserveQuota(query, {
        opId: "op-released",
        charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "release-commit", amount: 1n }],
        expiresAt: new Date("2099-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      await releaseQuota(query, released.reservationIds);
      await expect(commitQuota(query, released.reservationIds)).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
      });

      const expired = await reserveQuota(query, {
        opId: "op-expired",
        charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "expire-commit", amount: 1n }],
        expiresAt: new Date("2000-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
      });
      expect(await expireQuota(query, new Date("2000-01-02"))).toBeGreaterThan(0);
      await expect(commitQuota(query, expired.reservationIds)).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
      });
      const afterExpire = await db.query(
        "applier",
        `SELECT committed, reserved FROM "quota_account" WHERE "subjectId" = 'expire-commit'`,
      );
      expect(BigInt(afterExpire.rows[0]?.committed ?? -1)).toBe(0n);
      expect(BigInt(afterExpire.rows[0]?.reserved ?? -1)).toBe(0n);

      const held = await reserveQuota(query, {
        opId: "op-held",
        charges: [{ dimension: "OWNER_LIVE_KB", subjectId: "held-user", amount: 1n }],
        expiresAt: new Date("2000-01-01"),
        disks: [{ path: process.cwd(), bytes: 0n, meter: disk }],
        heldForPublication: true,
      });
      expect(await expireQuota(query, new Date("2000-01-02"))).toBe(0);
      await commitQuota(query, held.reservationIds);
      const afterHeld = await db.query(
        "applier",
        `SELECT committed, reserved FROM "quota_account" WHERE "subjectId" = 'held-user'`,
      );
      expect(BigInt(afterHeld.rows[0]?.committed ?? -1)).toBe(1n);
      expect(BigInt(afterHeld.rows[0]?.reserved ?? -1)).toBe(0n);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("lets only one of two disk reservations consume the 1 GiB floor across knowledge bases", async () => {
    const a = await quotaSession();
    const b = await quotaSession();
    const tight = {
      async freeBytes() {
        return 2n << 30n;
      },
    };
    const amount = 768n << 20n;
    try {
      const settled = await Promise.allSettled([
        reserveQuota(a, {
          opId: "op-disk-a",
          charges: [{ dimension: "KB_HISTORY_BYTES", subjectId: "disk-kb-a", amount }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: amount, meter: tight }],
        }),
        reserveQuota(b, {
          opId: "op-disk-b",
          charges: [{ dimension: "KB_HISTORY_BYTES", subjectId: "disk-kb-b", amount }],
          expiresAt: new Date("2099-01-01"),
          disks: [{ path: process.cwd(), bytes: amount, meter: tight }],
        }),
      ]);
      expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((row) => row.status === "rejected")).toHaveLength(1);
      const disk = await db.query(
        "applier",
        `SELECT reserved FROM "quota_account"
          WHERE dimension = 'DISK_VOLUME' AND "subjectId" = $1`,
        [diskSubjectId],
      );
      expect(BigInt(disk.rows[0]?.reserved ?? -1)).toBe(amount);
    } finally {
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
    }
  });
});

describe("live browser identity", () => {
  it("rejects a ban and a forced-2FA change on recheck, including under the authority lock", async () => {
    const owner = await user("ban-recheck@example.com");
    await prisma.user.update({
      where: { id: owner.id },
      data: { createdAt: new Date("2020-01-01T00:00:00.000Z"), twoFactorEnabled: false },
    });
    const live = await prisma.knowledgeBase.create({
      data: {
        name: "Identity",
        slug: "identity",
        description: DESCRIPTION,
        state: "ACTIVE",
        ownerId: owner.id,
        headSha: HEAD,
      },
    });
    const store = prismaAuthorityStore(prisma);
    const principal = { kind: "browser" as const, userId: owner.id };
    await expect(
      authorize({ principal, kbId: live.id, operation: "read", store }),
    ).resolves.toMatchObject({ kbId: live.id });

    await prisma.user.update({ where: { id: owner.id }, data: { banned: true } });
    await expect(
      recheckRead({ principal, kbId: live.id, operation: "read", store }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await prisma.user.update({ where: { id: owner.id }, data: { banned: false } });
    const lease = await checkoutPinnedSession({
      connectionString: db.urls.applier,
      opId: "op_ban_write",
    });
    try {
      await lease.acquire([{ kind: "authority" }]);
      await expect(
        recheckWriteBeforeReservation(lease, {
          principal,
          kbId: live.id,
          operation: "write",
          store,
        }),
      ).resolves.toMatchObject({ kbId: live.id });
      await prisma.user.update({ where: { id: owner.id }, data: { banned: true } });
      await expect(
        recheckWriteBeforeReservation(lease, {
          principal,
          kbId: live.id,
          operation: "write",
          store,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await lease.close();
    }

    await prisma.user.update({ where: { id: owner.id }, data: { banned: false } });
    await prisma.appSetting.upsert({
      where: { key: "force2faPublicUsers" },
      create: { key: "force2faPublicUsers", value: "true" },
      update: { value: "true" },
    });
    await expect(
      recheckRead({ principal, kbId: live.id, operation: "read", store }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("audit events", () => {
  it("prevents logical duplicates and keeps actor snapshots after user removal", async () => {
    const actor = await user("audit@example.com");
    const client = await connect();
    const query = (text: string, values?: unknown[]) => client.query(text, values);
    try {
      await recordAuditEvent(query, {
        opId: "op-audit",
        action: "kb.create",
        outcome: "SUCCESS",
        actorKey: `user:${actor.id}`,
        actorUserIdSnapshot: actor.id,
        actorUserId: actor.id,
        metadata: { reasonCode: "created" },
      });
      await recordAuditEvent(query, {
        opId: "op-audit",
        action: "kb.create",
        outcome: "SUCCESS",
        actorKey: `user:${actor.id}`,
        actorUserIdSnapshot: actor.id,
        actorUserId: actor.id,
        metadata: { reasonCode: "created" },
      });
      const rows = await db.query(
        "applier",
        `SELECT count(*)::int AS n, min("actorUserIdSnapshot") AS snapshot
           FROM "audit_event" WHERE "opId" = $1`,
        ["op-audit"],
      );
      expect(rows.rows[0]?.n).toBe(1);
      await prisma.user.delete({ where: { id: actor.id } });
      const kept = await db.query(
        "applier",
        `SELECT "actorUserId", "actorUserIdSnapshot" FROM "audit_event" WHERE "opId" = $1`,
        ["op-audit"],
      );
      expect(kept.rows[0]?.actorUserId).toBeNull();
      expect(kept.rows[0]?.actorUserIdSnapshot).toBe(actor.id);
    } finally {
      await client.end().catch(() => undefined);
    }
  });
});

describe("timestamp instants across process and session time zones", () => {
  const guards = [
    (connectionString: string) => createPrismaPgAdapter({ connectionString }),
    (connectionString: string) => assertNoSessionOptionOverride(connectionString, "Schema applier"),
  ];

  it("both guards reject plain, encoded and driver-normalized options query keys", () => {
    const keys = ["options", "%6fptions", "op%74ions"];
    for (const character of ["\t", "\n", "\r"]) {
      for (let index = 0; index <= "options".length; index++) {
        keys.push("options".slice(0, index) + character + "options".slice(index));
      }
    }
    for (const key of keys) {
      const connectionString = `postgresql://u:p@h:5432/db?${key}=-c%20TimeZone%3DPacific%2FPago_Pago`;
      // Exercise the installed pg parser, not a second approximation of URL semantics.
      // Constructing a Client parses the URL without opening a connection.
      const driver = new Client({ connectionString, options: "-c TimeZone=UTC" });
      expect(driver.connectionParameters.options, JSON.stringify(key)).toBe(
        "-c TimeZone=Pacific/Pago_Pago",
      );
      for (const guard of guards) {
        expect(() => guard(connectionString), JSON.stringify(key)).toThrow(
          /options.*query parameter|literal TAB\/LF\/CR/i,
        );
      }
    }
    for (const guard of guards) {
      expect(() => guard("postgresql://u@/db?OPTIONS=ignored")).toThrow(
        /options.*query parameter/i,
      );
    }
  });

  it("both guards reject literal TAB/LF/CR throughout the URL without exposing its contents", () => {
    for (const character of ["\t", "\n", "\r"]) {
      for (const connectionString of [
        `${character}postgresql://u:p@h/db`,
        `postgresql://u${character}:p@h/db`,
        `postgresql://u:p${character}@h/db`,
        `postgresql://u:p@h${character}/db`,
        `postgresql://u:p@h/d${character}b`,
        `postgresql://u:p@h/db?application_name=test${character}`,
      ]) {
        for (const guard of guards) {
          expect(() => guard(connectionString)).toThrow(/literal TAB\/LF\/CR/);
          try {
            guard(connectionString);
          } catch (error) {
            expect(String(error)).not.toContain(connectionString);
          }
        }
      }
    }
  });

  it("both guards reject all trailing C0 controls that erase the pin through an empty options value", () => {
    for (let code = 0; code < 32; code++) {
      const connectionString = `postgresql://u@h/db?options${String.fromCharCode(code)}`;
      const driver = new Client({ connectionString, options: "-c TimeZone=UTC" });
      expect(driver.connectionParameters.options, `C0 ${code}`).not.toBe("-c TimeZone=UTC");
      for (const guard of guards) {
        expect(() => guard(connectionString), `C0 ${code}`).toThrow(/literal TAB\/LF\/CR/);
      }
    }
  });

  it("both guards preserve hostless URLs and percent-encoded characters that cannot replace the pin", () => {
    for (const connectionString of [
      "postgresql://u@/db",
      "postgresql://kb@/kb?host=%2Fvar%2Frun%2Fpostgresql",
      "socket:/var/run/postgresql?db=kb",
      "postgresql://u@/db?application_name=kb-test",
      "postgres://u:p@h:5432/db?application_name=kb-test",
      "postgresql://u%09:p%0A@h/db?application_name=kb%0Dtest",
      "postgresql://u@h/db?op%09tions=ignored",
      "postgresql://u@h/db?op%0Ations=ignored",
      "postgresql://u@h/db?op%0Dtions=ignored",
      "postgresql://u@h/db?%256fptions=ignored&application_name=options",
      "postgresql://u@h/db?options%00=ignored",
      "postgresql://u@h/db?options%1F=ignored",
    ]) {
      for (const guard of guards) expect(() => guard(connectionString)).not.toThrow();
      const driver = new Client({ connectionString, options: "-c TimeZone=UTC" });
      expect(driver.connectionParameters.options).toBe("-c TimeZone=UTC");
    }
  });

  it("refuses an empty DATABASE_URL before constructing a pool", () => {
    expect(() => createPrismaPgAdapter({ connectionString: "" })).toThrow(/empty DATABASE_URL/);
  });

  const HOUR = 60 * 60 * 1000;
  // Opposite extremes: UTC-11 and UTC+14 (no DST in either zone).
  const configs = [
    { node: "Pacific/Pago_Pago", nodeOffsetMinutes: 660, session: "Pacific/Kiritimati" },
    { node: "Pacific/Kiritimati", nodeOffsetMinutes: -840, session: "Pacific/Pago_Pago" },
  ];

  for (const config of configs) {
    it(`Prisma and raw-SQL authority stores agree (Node ${config.node}, PG ${config.session})`, async () => {
      const originalTz = process.env.TZ;
      const client = await connect();
      // Legitimate encoded URL values must keep the actual Prisma connection pinned.
      const connectionString = `${db.urls.applier}?application_name=kb%09timezone-test`;
      const pinnedPrisma = new PrismaClient({
        adapter: createPrismaPgAdapter({ connectionString }),
      });
      try {
        process.env.TZ = config.node;
        expect(new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset()).toBe(config.nodeOffsetMinutes);
        await client.query(`SET TimeZone TO '${config.session}'`);
        expect((await client.query("SHOW TimeZone")).rows[0]?.TimeZone).toBe(config.session);
        expect(await pinnedPrisma.$queryRawUnsafe("SHOW TimeZone")).toEqual([{ TimeZone: "UTC" }]);

        const now = Date.now();
        const tag = config.node.replace(/\W/g, "").toLowerCase();
        const cases = [
          { label: "admin25h", role: "admin", createdAt: now - 25 * HOUR, twoFactor: false },
          { label: "admin23h", role: "admin", createdAt: now - 23 * HOUR, twoFactor: true },
          { label: "banSoon", banExpires: now + HOUR, banned: true },
          { label: "banLapsed", banExpires: now - HOUR, banned: false },
        ];
        const ids = new Map<string, string>();
        for (const c of cases) {
          const created = await pinnedPrisma.user.create({
            data: {
              name: c.label,
              email: `${c.label}-${tag}@example.com`,
              emailVerified: true,
              role: c.role ?? "user",
              twoFactorEnabled: false,
              createdAt: new Date(c.createdAt ?? now),
              banned: c.banExpires !== undefined,
              banExpires: c.banExpires === undefined ? null : new Date(c.banExpires),
            },
          });
          ids.set(c.label, created.id);
        }
        // Raw-SQL writes of JS Date parameters under the same offsets.
        const rawCreated = new Date(now - 25 * HOUR);
        const rawBanExpires = new Date(now + HOUR);
        const raw = await client.query(
          `INSERT INTO "user" (id, name, email, "emailVerified", role, "twoFactorEnabled", banned, "banExpires", "createdAt", "updatedAt")
           VALUES ($1, 'raw', $2, true, 'admin', false, true, $3, $4, now()) RETURNING id`,
          [`raw-${tag}`, `raw-${tag}@example.com`, rawBanExpires, rawCreated],
        );
        ids.set("raw", raw.rows[0].id);
        const expected = new Map<string, { createdAt: number; banExpires: number | null }>([
          ...cases.map(
            (c) =>
              [
                c.label,
                { createdAt: c.createdAt ?? now, banExpires: c.banExpires ?? null },
              ] as const,
          ),
          ["raw", { createdAt: rawCreated.getTime(), banExpires: rawBanExpires.getTime() }],
        ]);

        const rawRows: Array<Record<string, unknown>> = [];
        const sqlStore = sqlAuthorityStore(async (text, values) => {
          const result = await client.query(text, values);
          rawRows.push(...result.rows);
          return result;
        });
        const prismaStore = prismaAuthorityStore(pinnedPrisma);
        for (const [label, id] of ids) {
          rawRows.length = 0;
          const viaSql = await sqlStore.loadIdentity(id);
          const viaPrisma = await prismaStore.loadIdentity(id);
          expect(viaSql, label).toEqual(viaPrisma);
          const row = await pinnedPrisma.user.findUniqueOrThrow({
            where: { id },
            select: { createdAt: true, banExpires: true },
          });
          const epoch = await client.query(
            `SELECT (extract(epoch FROM "createdAt") * 1000)::bigint::text AS created,
                    (extract(epoch FROM "banExpires") * 1000)::bigint::text AS ban
               FROM "user" WHERE id = $1`,
            [id],
          );
          const want = expected.get(label)!;
          expect(row.createdAt.getTime(), label).toBe(want.createdAt);
          expect(rawRows, label).toHaveLength(1);
          const rawRow = rawRows[0] as { createdAt: Date; banExpires: Date | null };
          expect(rawRow.createdAt, label).toBeInstanceOf(Date);
          expect(rawRow.createdAt.getTime(), label).toBe(want.createdAt);
          expect(Number(epoch.rows[0]?.created), label).toBe(want.createdAt);
          expect(row.banExpires?.getTime() ?? null, label).toBe(want.banExpires);
          expect(rawRow.banExpires?.getTime() ?? null, label).toBe(want.banExpires);
          if (want.banExpires !== null)
            expect(Number(epoch.rows[0]?.ban), label).toBe(want.banExpires);
        }
        const identity = async (label: string) => sqlStore.loadIdentity(ids.get(label)!);
        expect((await identity("admin25h"))?.twoFactorSatisfied).toBe(false);
        expect((await identity("admin23h"))?.twoFactorSatisfied).toBe(true);
        expect((await identity("raw"))?.twoFactorSatisfied).toBe(false);
        expect((await identity("banSoon"))?.banned).toBe(true);
        expect((await identity("raw"))?.banned).toBe(true);
        expect((await identity("banLapsed"))?.banned).toBe(false);
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
        await pinnedPrisma.$disconnect();
        await client.end().catch(() => undefined);
      }
    });
  }
});

describe("forced 2FA enrollment grace start", () => {
  const DAY = 24 * 60 * 60 * 1000;
  type Exec = (sql: string, params: unknown[]) => Promise<unknown>;
  type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

  async function aged(email: string, role: string, days: number) {
    return prisma.user.create({
      data: {
        name: email,
        email,
        emailVerified: true,
        role,
        createdAt: new Date(Date.now() - days * DAY),
      },
    });
  }
  async function graceRow(id: string) {
    return prisma.user.findUniqueOrThrow({
      where: { id },
      select: {
        createdAt: true,
        twoFactorGraceStartedAt: true,
        role: true,
        twoFactorEnabled: true,
      },
    });
  }
  /** One identity/policy write through the production chokepoint. */
  function viaWriter(userId: string | null, write: (exec: Exec, tx: Tx) => Promise<unknown>) {
    return prisma.$transaction(async (tx) => {
      const exec: Exec = (sql, params) => tx.$executeRawUnsafe(sql, ...params);
      await withOutgoingTwoFactorMcpSettlement(exec, userId, () => write(exec, tx));
    });
  }
  /** Mirrors `users.setRole`. */
  const setRole = (userId: string, role: string) =>
    viaWriter(userId, async (exec, tx) => {
      await recordTwoFactorGraceStartForRoleChange(exec, userId, role);
      await tx.user.update({ where: { id: userId }, data: { role } });
    });
  /** Mirrors `settings.update`. */
  const setPolicy = (key: "force2faPublicUsers" | "force2faInternalUsers", value: string) =>
    viaWriter(null, async (exec, tx) => {
      const before = await tx.appSetting.findUnique({ where: { key }, select: { value: true } });
      await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      if (isForcedTwoFactorActivation(key, before?.value, value)) {
        await recordTwoFactorGraceStartForPolicyActivation(exec, key);
      }
    });
  const satisfied = async (id: string, forced = true, now?: number) =>
    isTwoFactorRequirementSatisfied(await graceRow(id), forced, now);

  it("starts at promotion, at policy activation and at creation, and never moves", async () => {
    await setPolicy("force2faPublicUsers", "false");
    await setPolicy("force2faInternalUsers", "true");

    // Promotion of a 10-day-old, never-covered user: the grace starts now.
    const promoted = await aged("grace-promoted@example.com", "user", 10);
    expect(await satisfied(promoted.id)).toBe(false);
    await setRole(promoted.id, "admin");
    const afterPromotion = await graceRow(promoted.id);
    expect(afterPromotion.twoFactorGraceStartedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await satisfied(promoted.id)).toBe(true);
    expect(await satisfied(promoted.id, true, Date.now() + DAY + 60_000)).toBe(false);

    // A recorded start is never moved by later role writes.
    await setRole(promoted.id, "user");
    await setRole(promoted.id, "admin");
    expect((await graceRow(promoted.id)).twoFactorGraceStartedAt).toEqual(
      afterPromotion.twoFactorGraceStartedAt,
    );

    // A role write the policy doesn't cover starts nothing.
    const untouched = await aged("grace-untouched@example.com", "user", 10);
    await setRole(untouched.id, "user");
    expect((await graceRow(untouched.id)).twoFactorGraceStartedAt).toBeNull();

    // Turning on public forced 2FA starts the grace for never-covered public users.
    await setPolicy("force2faPublicUsers", "true");
    expect((await graceRow(untouched.id)).twoFactorGraceStartedAt).not.toBeNull();
    expect(await satisfied(untouched.id)).toBe(true);

    // Covered at creation: the start is createdAt itself.
    const fresh = await prisma.user.create({
      data: { name: "fresh", email: "grace-fresh@example.com", emailVerified: true },
    });
    await recordTwoFactorGraceStartAtCreation(
      (sql, params) => prisma.$executeRawUnsafe(sql, ...params),
      fresh.id,
    );
    const freshRow = await graceRow(fresh.id);
    expect(freshRow.twoFactorGraceStartedAt).toEqual(freshRow.createdAt);

    await setPolicy("force2faPublicUsers", "false");
  });

  // Legacy rows: covered since creation, start NULL (measured from createdAt).
  // Every way of losing and regaining coverage must keep that basis.
  it.each([
    ["demote+promote (setRole)", "role"],
    ["internal policy off+on", "policy"],
  ] as const)("gives a legacy covered admin no second grace on %s", async (_name, path) => {
    await setPolicy("force2faInternalUsers", "true");
    const legacy = await aged(`grace-legacy-${path}@example.com`, "admin", 10);
    expect((await graceRow(legacy.id)).twoFactorGraceStartedAt).toBeNull();
    expect(await satisfied(legacy.id)).toBe(false);
    if (path === "role") {
      await setRole(legacy.id, "user");
      await setRole(legacy.id, "admin");
    } else {
      await setPolicy("force2faInternalUsers", "false");
      await setPolicy("force2faInternalUsers", "true");
    }
    const row = await graceRow(legacy.id);
    expect(row.role).toBe("admin");
    expect(row.twoFactorGraceStartedAt).toEqual(row.createdAt);
    expect(await satisfied(legacy.id)).toBe(false);
  });

  it("still starts a fresh grace for an admin the policy never covered", async () => {
    await setPolicy("force2faInternalUsers", "false");
    const neverCovered = await aged("grace-never-covered@example.com", "admin", 10);
    await setPolicy("force2faInternalUsers", "true");
    expect(await satisfied(neverCovered.id)).toBe(true);
  });
});
