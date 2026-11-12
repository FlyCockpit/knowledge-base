/** R47 owning-boundary regressions: real SQL and Redis jobs. */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@knowledge-base/api/context";
import type { Session } from "@knowledge-base/auth";
import {
  AUTHORITY_LOCK_CLASSID,
  AUTHORITY_LOCK_OBJID,
  lockIdentityAuthority,
} from "@knowledge-base/db/authority-lock";
import type { PrismaClient } from "@knowledge-base/db/client";
import type { KbRetentionJobData } from "@knowledge-base/queue/jobs";
import { cleanQueuePayloads } from "@knowledge-base/queue/retention";
import { type Job, Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import { openKbPostgresClusterFromEnv } from "./postgres";
import { openKbRedisFromEnv } from "./redis";

const state = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
  env: {} as Record<string, unknown>,
  queues: [] as Pick<Queue, "clean">[],
}));
vi.mock("@knowledge-base/db", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (!state.prisma) throw new Error("Fixture database is not initialized");
        const value: unknown = Reflect.get(state.prisma, key);
        return typeof value === "function" ? value.bind(state.prisma) : value;
      },
    },
  ),
}));
vi.mock("@knowledge-base/env/server", () => ({ env: {}, ADMIN_EMAIL: undefined }));
vi.mock("@knowledge-base/env/shared", () => ({ env: state.env }));
vi.mock("@knowledge-base/queue", async () => {
  const jobs = await import("@knowledge-base/queue/jobs");
  const q = {};
  return {
    ...jobs,
    ...Object.fromEntries(Object.keys(jobs.QUEUE_NAMES).map((key) => [`${key}Queue`, q])),
    redisConnection: {},
    cleanExpiredQueuePayloads: () => cleanQueuePayloads(state.queues),
  };
});

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();

const prisma = db.createPrismaClient("runtime");
state.prisma = prisma;
state.env.DATABASE_URL = new Secret(db.urls.runtime);
// The generations class unlinks index files under <KB_DATA_ROOT>/index.
const dataRoot = mkdtempSync(join(tmpdir(), "kb-retention-boundaries-"));
state.env.KB_DATA_ROOT = dataRoot;
const redis = openKbRedisFromEnv();
const connection = redis.client();
const { createRouterClient } = (await import(
  createRequire(new URL("../../../api/package.json", import.meta.url)).resolve("@orpc/server")
)) as {
  createRouterClient(
    router: unknown,
    options: { context: Context },
  ): { auditExport(input: { limit: number }): Promise<{ items: { id: string }[] }> };
};
const { queueRouter } = await import(
  new URL("../../../api/src/routers/queue.ts", import.meta.url).href
);
const { handleKbRetentionJob } = (await import(
  new URL("../../../../apps/worker/src/handlers/kb-retention.ts", import.meta.url).href
)) as {
  handleKbRetentionJob(
    job: Job<KbRetentionJobData>,
  ): Promise<{ schedule: string; queuePayloads: number }>;
};

afterAll(async () => {
  await redis.close();
  await prisma.$disconnect();
  await cluster.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

async function auditFixture() {
  const user = await prisma.user.create({
    data: {
      name: "Audit fixture",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: true,
      role: "admin",
      twoFactorEnabled: true,
    },
  });
  const row = await prisma.auditEvent.create({
    data: {
      id: randomUUID().replaceAll("-", "").slice(0, 24),
      opId: randomUUID(),
      action: "fixture",
      outcome: "SUCCESS",
      actorKey: `user:${user.id}`,
      actorUserIdSnapshot: user.id,
      metadata: {},
    },
  });
  const context: Context = {
    clientIp: undefined,
    session: { user: { ...user }, session: { userId: user.id } } as Session,
  };
  const client = createRouterClient(queueRouter, { context });
  return { user, row, client };
}

describe("audit export live authority", () => {
  it("permits a live admin but rejects the same captured session after demotion, ban or deletion", async () => {
    const { user, row, client } = await auditFixture();
    expect((await client.auditExport({ limit: 100 })).items.some((r) => r.id === row.id)).toBe(
      true,
    );
    for (const data of [{ role: "user" }, { role: "admin", banned: true }]) {
      await prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.user.update({ where: { id: user.id }, data });
      });
      await expect(client.auditExport({ limit: 100 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await prisma.$transaction(async (tx) => {
      await lockIdentityAuthority(tx);
      await tx.user.delete({ where: { id: user.id } });
    });
    await expect(client.auditExport({ limit: 100 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("holds authority while the actual audit read waits, then admits the queued demotion", async () => {
    const { user, row, client } = await auditFixture();
    const blocker = new Client({ connectionString: db.urls.applier });
    await blocker.connect();
    let exporting: ReturnType<typeof client.auditExport> | undefined;
    let demotion: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE audit_event IN ACCESS EXCLUSIVE MODE");
      exporting = client.auditExport({ limit: 100 });
      await vi.waitFor(async () => {
        const waiting = await db.query(
          "applier",
          `SELECT 1 FROM pg_locks WHERE relation='public.audit_event'::regclass AND NOT granted`,
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
      let changed = false;
      demotion = prisma.$transaction(async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.user.update({ where: { id: user.id }, data: { role: "user" } });
        changed = true;
      });
      await vi.waitFor(async () => {
        const waiting = await db.query(
          "applier",
          `SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND classid=$1 AND objid=$2`,
          [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID],
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
      expect(changed).toBe(false);
      await blocker.query("ROLLBACK");
      expect((await exporting).items.some((r) => r.id === row.id)).toBe(true);
      await demotion;
      await expect(client.auditExport({ limit: 100 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await Promise.allSettled([exporting, demotion].filter(Boolean));
      await blocker.end();
    }
  });
});

describe("idle BullMQ payload retention", () => {
  it("hourly production delivery removes old idle terminal payloads across pages, preserving recent/waiting jobs", async () => {
    const name = `idle-${randomUUID()}`;
    const prefix = redis.key("idle");
    const q = new Queue(name, { connection, prefix });
    state.queues = [q];
    try {
      const stale = [];
      for (const terminal of ["completed", "failed"]) {
        for (let n = 0; n < 103; n++) {
          const job = await q.add("fixture", { canary: "private-idle-payload" });
          stale.push(job.id!);
          // Canonical finished-job hash + terminal set. No later job completion
          // triggers BullMQ's automatic age cleanup after these timestamps age.
          const finishedOn = Date.now() - (terminal === "completed" ? 25 : 8 * 24) * 3600_000;
          await connection.lrem(q.toKey("wait"), 0, job.id!);
          await connection.hset(q.toKey(job.id!), "finishedOn", finishedOn);
          await connection.zadd(q.toKey(terminal), finishedOn, job.id!);
        }
      }
      const recent = await q.add("fixture", {});
      await connection.lrem(q.toKey("wait"), 0, recent.id!);
      await connection.hset(q.toKey(recent.id!), "finishedOn", Date.now());
      await connection.zadd(q.toKey("completed"), Date.now(), recent.id!);
      const waiting = await q.add("fixture", {});
      const result = await handleKbRetentionJob({
        id: "idle-pass",
        data: { schedule: "hourly" },
      } as Job<KbRetentionJobData>);
      for (const id of stale) expect(Boolean(await q.getJob(id))).toBe(false);
      expect(result.queuePayloads).toBe(206);
      expect(await q.getJob(recent.id!)).toBeDefined();
      expect(await waiting.getState()).toBe("waiting");
      expect(
        (await handleKbRetentionJob({ data: { schedule: "hourly" } } as Job<KbRetentionJobData>))
          .queuePayloads,
      ).toBe(0);
    } finally {
      state.queues = [];
      await q.close();
    }
  });
});
