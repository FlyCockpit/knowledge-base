import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertTestDatabaseUrl,
  createCrashBarrier,
  createTempGitRepo,
  type KbPostgresDatabase,
  killStuckChild,
  openKbPostgresClusterFromEnv,
  openKbRedisFromEnv,
  processIsAlive,
  startPublicHttpFixture,
} from "./index.js";

const cluster = await openKbPostgresClusterFromEnv();

afterAll(async () => {
  await cluster.close();
});

describe("kb integration fixtures", () => {
  it("rejects a supplied developer database URL before connecting", () => {
    expect(() =>
      assertTestDatabaseUrl("postgresql://postgres:password@localhost:5432/knowledge_base"),
    ).toThrow(/Refusing shared developer DATABASE_URL before connecting/);
  });

  it("isolates two databases and cleans them independently", async () => {
    const first = await cluster.createDatabase();
    const second = await cluster.createDatabase();
    try {
      await first.query("applier", "CREATE TABLE probe (v text)");
      await first.query("applier", "INSERT INTO probe VALUES ($1)", ["secret-a"]);
      await second.query("applier", "CREATE TABLE probe (v text)");
      await second.query("applier", "INSERT INTO probe VALUES ($1)", ["secret-b"]);
      expect((await first.query("applier", "SELECT v FROM probe")).rows).toEqual([
        { v: "secret-a" },
      ]);
      expect((await second.query("applier", "SELECT v FROM probe")).rows).toEqual([
        { v: "secret-b" },
      ]);
      await first.close();
      expect((await second.query("applier", "SELECT v FROM probe")).rows).toEqual([
        { v: "secret-b" },
      ]);
    } finally {
      await second.close();
    }
  });

  describe("Prisma fixture lifecycle", () => {
    let db: KbPostgresDatabase;
    // Provisioning and the initial empty-schema apply perform durable catalog
    // writes and start Prisma. They own a separate 120s fixture setup budget;
    // the behavior assertions retain the suite's unchanged 30s test budget.
    beforeAll(async () => {
      db = await cluster.createDatabase();
      db.applyPrismaSchema();
    }, 120_000);
    afterAll(async () => {
      await db?.close();
    }, 120_000);

    it("applies Prisma to an empty fixture, preserves rows on re-entry, and refuses a closed fixture", async () => {
      try {
        expect((await db.query("applier", 'SELECT COUNT(*) FROM "verification"')).rows).toEqual([
          { count: "0" },
        ]);
        await db.query(
          "applier",
          'INSERT INTO "verification" (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, NOW(), NOW(), NOW())',
          ["ci0-fixture", "ci0", "inert"],
        );
        db.applyPrismaSchema();
        expect(
          (
            await db.query("applier", 'SELECT value FROM "verification" WHERE id = $1', [
              "ci0-fixture",
            ])
          ).rows,
        ).toEqual([{ value: "inert" }]);
      } finally {
        await db.close();
      }
      expect(() => db.applyPrismaSchema()).toThrow(/is closed/);
    });
  });

  describe("Prisma CLI failure", () => {
    let db: KbPostgresDatabase;
    // Provisioning creates roles, a database and extensions with durable catalog
    // writes. It owns a separate 120s setup budget under host I/O contention;
    // the behavior assertions retain the suite's unchanged 30s test budget.
    beforeAll(async () => {
      db = await cluster.createDatabase();
    }, 120_000);
    afterAll(async () => {
      await db?.close();
    }, 120_000);

    it("reports a CLI connection failure without credentials, then allows a valid retry", async () => {
      const originalUrl = db.urls.applier;
      try {
        const refused = new URL(originalUrl);
        refused.port = "1";
        db.urls.applier = refused.href;
        let failure = "";
        try {
          db.applyPrismaSchema();
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        expect(failure).toContain("Prisma fixture schema failed");
        expect(failure).toMatch(/ECONNREFUSED|unreachable|connect/i);
        expect(failure.includes(decodeURIComponent(refused.password))).toBe(false);
        expect(failure.includes(refused.href)).toBe(false);
        db.urls.applier = originalUrl;
        db.applyPrismaSchema();
        expect((await db.query("applier", 'SELECT COUNT(*) FROM "verification"')).rows).toEqual([
          { count: "0" },
        ]);
      } finally {
        db.urls.applier = originalUrl;
        await db.close();
      }
    });
  });

  it("enqueues and dequeues through disposable Redis prefixes", async () => {
    const left = openKbRedisFromEnv(`${cluster.id}a`);
    const right = openKbRedisFromEnv(`${cluster.id}b`);
    try {
      await left.client().rpush(left.key("q"), "job-a");
      await right.client().rpush(right.key("q"), "job-b");
      expect(await left.client().lpop(left.key("q"))).toBe("job-a");
      expect(await left.client().lpop(left.key("q"))).toBeNull();
      expect(await right.client().lpop(right.key("q"))).toBe("job-b");
    } finally {
      await left.close();
      await right.close();
    }
  });

  it("pauses a child at a named barrier, releases it, and reaps a stuck process", async () => {
    const barrier = await createCrashBarrier("work");
    try {
      const released = barrier.spawnChild("gate");
      await barrier.waitUntil("gate");
      expect(processIsAlive(released.pid)).toBe(true);
      await barrier.release("gate");
      const finished = await released.done;
      expect(finished.code).toBe(0);
      expect(processIsAlive(released.pid)).toBe(false);

      const stuck = barrier.spawnChild("stuck");
      await barrier.waitUntil("stuck");
      const reaped = await killStuckChild(stuck);
      expect(reaped.signal === "SIGKILL" || reaped.code !== 0).toBe(true);
      expect(processIsAlive(stuck.pid)).toBe(false);
    } finally {
      await barrier.close();
    }
  });

  it("creates a real temporary Git repo and a fake public HTTP seam", async () => {
    const repo = createTempGitRepo();
    const http = await startPublicHttpFixture();
    try {
      expect(repo.git("rev-parse", "--is-inside-work-tree").trim()).toBe("true");
      const response = await fetch(http.embeddingsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hello", model: "kb-test-fake" }),
      });
      expect(response.ok).toBe(true);
      expect(http.requests).toHaveLength(1);
      expect(await response.json()).toMatchObject({ model: "kb-test-fake" });
    } finally {
      repo.close();
      await http.close();
    }
  });
});
