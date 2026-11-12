import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { writeGitFixtureBlobPack } from "@knowledge-base/api/lib/kb/fixtures/git-objects";
import { hardenedGitEnv } from "@knowledge-base/api/lib/kb/git-read";
import {
  measureGitRollup,
  recoverGitRollup,
  rollupGitObjects,
} from "@knowledge-base/api/lib/kb/git-rollup";
import type { HeldLockLease } from "@knowledge-base/api/lib/kb/lock";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { openKbPostgresClusterFromEnv } from "./postgres";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();
const root = mkdtempSync(join(tmpdir(), "kb-rollup-integration-"));
const repo = join(root, "repo.git"),
  work = join(root, "work");
const env = hardenedGitEnv();
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const execute = promisify(execFile);
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterAll(async () => {
  await db.close();
  await cluster.close();
  rmSync(root, { recursive: true, force: true });
});

let action: Promise<void> | undefined;
afterEach(async () => {
  await action?.catch(() => {});
});

let names: string[] = [],
  next: string;
beforeAll(() => {
  git(root, ["init", "--bare", "--template=", repo]);
  git(repo, ["config", "gc.auto", "0"]);
  git(repo, ["config", "maintenance.auto", "false"]);
  mkdirSync(work);
  git(work, ["init", "--template="]);
  writeFileSync(join(work, "doc.md"), "# Initial\n");
  git(work, ["add", "doc.md"]);
  git(work, ["commit", "-m", "Initial"]);
  git(work, ["push", repo, "HEAD:refs/heads/main"]);
  names = [];
  for (let i = 0; i < 12; i++) {
    names.push(writeGitFixtureBlobPack(repo, Buffer.from(`unreachable ${i}`)).objectSha);
  }
  writeFileSync(join(work, "doc.md"), "# Concurrent push\n");
  git(work, ["add", "doc.md"]);
  git(work, ["commit", "-m", "Concurrent push"]);
  next = git(work, ["rev-parse", "HEAD"]);
}, 180_000);

it("serializes a real receive-pack with rollup while an existing reader keeps every object readable", () => {
  action = concurrentPushAndRollup();
  return action;
});

async function concurrentPushAndRollup() {
  const reader = spawn("git", ["cat-file", "--batch"], {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise<void>((done) => reader.once("close", () => done()));
  const read = (name: string) =>
    new Promise<string>((done) => {
      let output = "";
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        const headerEnd = output.indexOf("\n");
        const size = Number(output.slice(0, headerEnd).split(" ")[2]);
        if (headerEnd < 0 || output.length < headerEnd + 1 + size + 1) return;
        reader.stdout.off("data", collect);
        done(output);
      };
      reader.stdout.on("data", collect);
      reader.stdin.write(`${name}\n`);
    });
  const acquired = latch(),
    release = latch();
  let rollupFinished = false;
  const locked = <T>(run: (lease: HeldLockLease) => Promise<T>) =>
    runLockedOperation({
      connectionString: db.urls.runtime,
      opId: randomUUID(),
      kind: "kb-write",
      kbIds: ["rollup_fixture"],
      run,
    });
  const maintenance = locked(async (lease) => {
    acquired.resolve();
    await release.promise;
    const options = { signal: lease.scope.signal, deadlineAt: lease.scope.deadlineAt };
    expect(await rollupGitObjects(repo, await measureGitRollup(repo, options), options)).toBe(true);
    rollupFinished = true;
  });
  let push: Promise<unknown> | undefined;
  try {
    await Promise.race([acquired.promise, maintenance]);
    expect(await read(names[0]!)).toContain(" blob ");
    push = locked(async () => {
      expect(rollupFinished).toBe(true);
      await execute("git", ["push", repo, "HEAD:refs/heads/main"], { cwd: work, env });
    });
    void push.catch(() => {});
    release.resolve();
    await maintenance;
    await push;
    expect(git(repo, ["rev-parse", "refs/heads/main"])).toBe(next);
    for (const [i, name] of names.entries())
      expect(await read(name)).toBe(
        `${name} blob ${Buffer.byteLength(`unreachable ${i}`)}\nunreachable ${i}\n`,
      );
    expect(git(repo, ["show", `${next}:doc.md`])).toBe("# Concurrent push");
    expect(git(repo, ["fsck", "--full", "--no-dangling"])).not.toContain("missing");
    expect(
      readdirSync(join(repo, "objects/pack")).filter((n) => n.endsWith(".pack")).length,
    ).toBeLessThan(4);
  } finally {
    release.resolve();
    await maintenance.catch(() => {});
    await push?.catch(() => {});
    reader.stdin.end();
    await closed;
  }
}

it("drains lock-blocked maintenance SQL at its deadline before admitting the next KB writer", async () => {
  const key = `rollup-block-${randomUUID()}`;
  await db.query(
    "runtime",
    `INSERT INTO "app_setting" (key, value, "updatedAt") VALUES ($1, 'before', now())`,
    [key],
  );
  const { Client } = await import("pg");
  const blocker = new Client({ connectionString: db.urls.runtime });
  await blocker.connect();
  await blocker.query("BEGIN");
  await blocker.query(`UPDATE "app_setting" SET value = 'blocker' WHERE key = $1`, [key]);
  let pid = 0;
  try {
    await expect(
      runLockedOperation({
        connectionString: db.urls.runtime,
        opId: randomUUID(),
        kind: "kb-write",
        kbIds: ["deadline_fixture"],
        mutationDeadlineAt: Date.now() + 2000,
        run: async (lease) => {
          pid = lease.backendPid;
          await lease.query(`UPDATE "app_setting" SET value = 'late maintenance' WHERE key = $1`, [
            key,
          ]);
        },
      }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    // The blocked statement and its owning session are joined before the KB
    // lock can be reacquired. No independent pool promise can mutate afterward.
    const running = await db.query(
      "runtime",
      `SELECT count(*)::text AS count FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    expect(running.rows[0]?.count).toBe("0");
    await runLockedOperation({
      connectionString: db.urls.runtime,
      opId: randomUUID(),
      kind: "kb-write",
      kbIds: ["deadline_fixture"],
      lockWaitMs: 250,
      run: async (lease) => {
        expect((await lease.query(`SELECT 1 AS ready`)).rows).toEqual([{ ready: 1 }]);
      },
    });
  } finally {
    await blocker.query("ROLLBACK");
    await blocker.end();
  }
  expect(
    (await db.query("runtime", `SELECT value FROM "app_setting" WHERE key = $1`, [key])).rows[0]
      ?.value,
  ).toBe("before");
});

it("retains worker scratch reservations through interruption and reconciles them before new work", async () => {
  const { kbDataPaths } = await import("@knowledge-base/env/topology");
  const { kbBareRepoPath } = await import("@knowledge-base/api/lib/kb/git-read");
  const { reserveQuota, releaseQuota, expireQuota } = await import(
    "@knowledge-base/api/lib/kb/quota"
  );
  const { vi } = await import("vitest");
  const client = db.createPrismaClient("runtime");
  try {
    const owner = await client.user.create({
      data: { name: "rollup", email: `rollup-${randomUUID()}@example.invalid` },
    });
    const kb = await client.knowledgeBase.create({
      data: {
        ownerId: owner.id,
        name: "rollup",
        slug: `rollup-${randomUUID()}`,
        description: "Scheduled rollup fixture knowledge base",
        state: "ACTIVE",
      },
    });
    const workerRepo = kbBareRepoPath(kbDataPaths(root).reposDir, kb.id);
    mkdirSync(kbDataPaths(root).reposDir, { recursive: true });
    git(root, ["init", "--bare", "--template=", workerRepo]);
    const names = Array.from(
      { length: 8 },
      (_, i) => writeGitFixtureBlobPack(workerRepo, Buffer.from(`worker ${i}`)).objectSha,
    );
    vi.doMock("@knowledge-base/env/shared", () => ({
      env: { DATABASE_URL: { reveal: () => db.urls.runtime }, KB_DATA_ROOT: root },
    }));
    const handlerPath = "../../../../apps/worker/src/handlers/kb-git-rollup";
    const {
      handleKbGitRollupJob,
    }: {
      handleKbGitRollupJob(job: {
        id: string;
        data: { reason: "cron" };
      }): Promise<{ count: number }>;
    } = await import(handlerPath);
    const job = { id: "integration", data: { reason: "cron" } } as Parameters<
      typeof handleKbGitRollupJob
    >[0];
    // Leave an allocation and unprepared scratch exactly as a killed process
    // would. Expiry must not forgive bytes that still occupy disk.
    await runLockedOperation({
      connectionString: db.urls.runtime,
      opId: randomUUID(),
      kind: "kb-write",
      kbIds: [kb.id],
      run: async (lease) => {
        await reserveQuota(lease, {
          opId: `git-rollup-${kb.id}`,
          charges: [],
          heldForPublication: true,
          expiresAt: new Date(0),
          disks: [
            {
              path: workerRepo,
              bytes: BigInt(96 << 20),
              meter: { freeBytes: async () => 1n << 40n },
            },
          ],
        });
        expect(await expireQuota(lease)).toBe(0);
        mkdirSync(join(workerRepo, "objects/kb-rollup"));
        writeFileSync(join(workerRepo, "objects/kb-rollup/roll.pack"), "interrupted scratch");
      },
    });
    await handleKbGitRollupJob(job); // drains abandoned scratch and releases its obligation
    expect(
      (
        await db.query(
          "runtime",
          `SELECT id FROM "quota_reservation" WHERE "opId" = $1 AND outcome = 'RESERVED'`,
          [`git-rollup-${kb.id}`],
        )
      ).rows,
    ).toHaveLength(0);
    await handleKbGitRollupJob(job); // wraps the one-KB cursor
    const key = `kb.git-rollup.${kb.id}`;
    await client.appSetting.create({
      data: { key, value: JSON.stringify({ level: 0, failures: 0, retryAt: 0 }) },
    });
    const { Client } = await import("pg");
    const blocker = new Client({ connectionString: db.urls.runtime });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(`UPDATE "app_setting" SET value = value WHERE key = $1`, [key]);
    try {
      // This is the actual worker's attempt-marker upsert, blocked after disk
      // reservation. It must time out on the KB lease's pinned SQL channel.
      expect(await handleKbGitRollupJob(job)).toEqual({ count: 0 });
      await runLockedOperation({
        connectionString: db.urls.runtime,
        opId: randomUUID(),
        kind: "kb-write",
        kbIds: [kb.id],
        lockWaitMs: 250,
        run: async (lease) => {
          await lease.query("SELECT 1");
        },
      });
      expect((await client.appSetting.findUniqueOrThrow({ where: { key } })).value).toBe(
        JSON.stringify({ level: 0, failures: 0, retryAt: 0 }),
      );
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    await handleKbGitRollupJob(job); // wraps after the interrupted attempt
    await handleKbGitRollupJob(job); // fresh fold, or retained prepared intent if budget expires
    // Production is best effort under a two-second budget. Drain the same
    // prepared intent under an ordinary lease before checking payloads.
    await runLockedOperation({
      connectionString: db.urls.runtime,
      opId: randomUUID(),
      kind: "kb-write",
      kbIds: [kb.id],
      run: async (lease) => {
        await recoverGitRollup(workerRepo, {
          signal: lease.scope.signal,
          deadlineAt: lease.scope.deadlineAt,
        });
        const ids = (
          await lease.query<{ id: string }>(
            `SELECT id FROM "quota_reservation" WHERE "opId" = $1 AND outcome = 'RESERVED' ORDER BY id LIMIT 32`,
            [`git-rollup-${kb.id}`],
          )
        ).rows.map((r) => r.id);
        await releaseQuota(lease, ids);
      },
    });
    for (const [i, name] of names.entries())
      expect(git(workerRepo, ["cat-file", "blob", name])).toBe(`worker ${i}`);
    const accounts = await db.query(
      "runtime",
      `SELECT reserved FROM "quota_account" WHERE dimension = 'DISK_VOLUME'`,
    );
    expect(accounts.rows.every((row) => row.reserved === "0")).toBe(true);
  } finally {
    await client.$disconnect();
    vi.doUnmock("@knowledge-base/env/shared");
  }
});
