import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  listenForDispatchWake,
  publishDurableRow,
  runDurableDispatcherCycle,
} from "@knowledge-base/api/lib/kb/dispatch";
import {
  cancelDurableJob,
  claimDispatchBatch,
  claimJobAttempt,
  commitProbeAttempt,
  completeJobAttempt,
  countReadyDispatchRows,
  DISPATCH_BATCH_SIZE,
  DurableJobCancelledError,
  DurableJobFenceError,
  durableBullmqJobId,
  EXPIRED_LEASE_ERROR,
  enqueueDurableJob,
  enqueueDurableJobOnQuery,
  failJobAttempt,
  heartbeatJobAttempt,
  markDispatchPublished,
  recordProbeEffect,
  retryDurableJob,
} from "@knowledge-base/api/lib/kb/jobs";
import { runDurableProbeDelivery } from "@knowledge-base/api/lib/kb/probe-consumer";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  killStuckChild,
  openKbPostgresClusterFromEnv,
  openKbRedisFromEnv,
  spawnProcessGroup,
} from "./index.js";

/** Literal backoff expectations, deliberately not derived from the implementation. */
const LITERAL_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const CLAIM_AND_LEASE_EXPIRY_MS = 61_000;
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const cluster = await openKbPostgresClusterFromEnv();
const redis = openKbRedisFromEnv(`${cluster.id}jobs`);

afterAll(async () => {
  await redis.close();
  await cluster.close();
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const database = await cluster.createDatabase();
  database.applyPrismaSchema();
  const prisma = database.createPrismaClient("runtime");
  const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
  const prefix = redis.key("bull");
  const queue = new Queue("durable-probe", { connection, prefix });
  const dispatcher = (
    ownerId: string,
    hooks?: Parameters<typeof runDurableDispatcherCycle>[0]["hooks"],
  ) => ({
    db: prisma,
    ownerId,
    now: () => new Date(),
    getQueue: () => queue,
    hooks,
  });
  return {
    database,
    prisma,
    connection,
    queue,
    redisUrl: redis.url,
    prefix,
    dispatcher,
    async close() {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      connection.disconnect();
      await prisma.$disconnect();
      await database.close();
    },
  };
}

function probeFixtureTest(name: string, run: (fixture: Fixture) => Promise<void>): void {
  describe(name, () => {
    let fixture: Fixture | undefined;
    let setup: Promise<void> | undefined;
    let action: Promise<void> | undefined;
    beforeAll(() => {
      // Schema/Redis setup is independent of each durable-job action's 30s.
      setup = createFixture().then((prepared) => {
        fixture = prepared;
      });
      return setup;
    }, 180_000);
    afterAll(async () => {
      await setup?.catch(() => {});
      await action?.catch(() => {});
      await fixture?.close();
    }, 180_000);
    it("preserves the durable state and fence assertions", () => {
      action = Promise.resolve().then(() => {
        if (!fixture) throw new Error("durable job fixture is not ready");
        return run(fixture);
      });
      return action;
    });
  });
}

async function waitForState(
  fixture: Fixture,
  jobId: string,
  state: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "missing";
  while (Date.now() < deadline) {
    const row = await fixture.prisma.durableJob.findUnique({ where: { id: jobId } });
    if (row) lastState = row.state;
    if (row?.state === state) return;
    await delay(50);
  }
  const counts = await fixture.queue
    .getJobCounts("waiting", "delayed", "active", "completed", "failed")
    .catch(() => null);
  throw new Error(
    `Timed out waiting for ${jobId} to reach ${state} (lastState=${lastState}, queue=${JSON.stringify(counts)})`,
  );
}

/** Wait for one deterministic BullMQ delivery to reach an exact Redis state. */
async function waitForJobState(
  fixture: Fixture,
  bullmqId: string,
  state: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await fixture.queue.getJob(bullmqId);
    const current = job ? await job.getState() : "missing";
    if (current === state) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for Redis delivery ${bullmqId} to reach ${state} (state=${current})`,
      );
    }
    await delay(50);
  }
}

/** BullMQ consumer that runs the exact production probe consumer path. */
async function runProbeWorker(fixture: Fixture, workerId: string) {
  const worker = new Worker(
    "durable-probe",
    async (job) =>
      runDurableProbeDelivery(fixture.prisma, {
        workerId,
        durableJobId: String(job.data.durableJobId),
      }),
    { connection: fixture.connection, prefix: fixture.prefix, concurrency: 1 },
  );
  await worker.waitUntilReady();
  return worker;
}

type CrashChildMessage = { owner: string; claimed: number; published: number };

/**
 * Real process-death barrier in a production dispatcher cycle: SIGKILL after
 * claim or after PUBLISHED commits, before any Redis delivery.
 */
async function spawnCrashingDispatcher(
  fixture: Fixture,
  input: { mode: "claim" | "before-publish"; owner: string },
): Promise<CrashChildMessage> {
  const tracked = spawnProcessGroup(
    process.execPath,
    ["--import", "tsx", join(import.meta.dirname, "durable-dispatcher-crash.child.ts")],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        KB_TEST_DB_URL: fixture.database.urls.runtime,
        KB_TEST_REDIS_URL: fixture.redisUrl,
        KB_TEST_REDIS_PREFIX: fixture.prefix,
        KB_TEST_OWNER: input.owner,
        KB_TEST_MODE: input.mode,
      },
    },
  );
  const message = await new Promise<CrashChildMessage>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const stdout = tracked.child.stdout;
    if (!stdout) {
      reject(new Error("crash child stdout is not piped"));
      return;
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        settled = true;
        stdout.off("data", onData);
        try {
          resolve(JSON.parse(line) as CrashChildMessage);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    };
    stdout.on("data", onData);
    void tracked.done.then((result) => {
      if (!settled) {
        reject(
          new Error(
            `crash child exited before signaling (code=${result.code}, signal=${result.signal})`,
          ),
        );
      }
    });
  });
  const result = await killStuckChild(tracked);
  expect(result.signal).toBe("SIGKILL");
  return message;
}

describe("durable jobs integration", () => {
  probeFixtureTest(
    "R3-W4: a committed enqueue wakes the dispatcher listener; a rolled-back one never does",
    async (fixture) => {
      let wakes = 0;
      const woke: Array<() => void> = [];
      const listener = listenForDispatchWake(
        fixture.database.urls.runtime,
        () => {
          wakes += 1;
          for (const resolve of woke.splice(0)) resolve();
        },
        { retryMs: 100, applicationName: "kb-dispatch-wake-test" },
      );
      const nextWake = () => new Promise<void>((resolve) => woke.push(resolve));
      try {
        // One wake after connecting, so a commit made while disconnected is not missed.
        await vi.waitFor(() => expect(wakes).toBe(1), { timeout: 10_000 });
        const client = new Client({ connectionString: fixture.database.urls.runtime });
        await client.connect();
        const enqueue = async (marker: string, end: "COMMIT" | "ROLLBACK") => {
          await client.query("BEGIN");
          await enqueueDurableJobOnQuery((sql, values) => client.query(sql, values) as never, {
            dedupKey: `probe:${randomUUID()}`,
            kind: "PROBE",
            desired: { marker },
          });
          await client.query(end);
        };
        try {
          await enqueue("rolled-back", "ROLLBACK");
          await delay(300);
          expect(wakes).toBe(1);
          const started = Date.now();
          const woken = nextWake();
          await enqueue("committed", "COMMIT");
          await woken;
          expect(wakes).toBe(2);
          expect(Date.now() - started).toBeLessThan(1_000);
          // A killed LISTEN backend reconnects (one wake on reconnect), and wakes again on commit.
          const reconnected = nextWake();
          await client.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='kb-dispatch-wake-test'",
          );
          await reconnected;
          expect(wakes).toBe(3);
          const after = nextWake();
          await enqueue("after-reconnect", "COMMIT");
          await after;
          expect(wakes).toBe(4);
        } finally {
          await client.end();
        }
      } finally {
        await listener.close();
      }
    },
  );
  probeFixtureTest(
    "recovers a dispatch claim abandoned by a killed dispatcher before publish",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "crash-before-publish" },
      });
      const message = await spawnCrashingDispatcher(fixture, {
        mode: "claim",
        owner: "crash-claim-owner",
      });
      expect(message.claimed).toBe(1);

      // Process death left the durable claim committed: the row is claimed,
      // not published, and no competing dispatcher may take it while the
      // claim is unexpired.
      const stranded = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(stranded?.state).toBe("PENDING");
      expect(stranded?.dispatchOwner).toBe("crash-claim-owner");
      expect(stranded?.dispatchClaimUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(await countReadyDispatchRows(fixture.prisma, new Date())).toBe(0);
      expect(await runDurableDispatcherCycle(fixture.dispatcher("recover-1"))).toBe(0);

      const expired = new Date(Date.now() + CLAIM_AND_LEASE_EXPIRY_MS);
      expect(
        await runDurableDispatcherCycle({ ...fixture.dispatcher("recover-2"), now: () => expired }),
      ).toBe(1);
      const published = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(published?.state).toBe("PUBLISHED");

      const worker = await runProbeWorker(fixture, "recover-worker");
      await waitForState(fixture, job.id, "COMPLETE");
      await worker.close();
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(1);
    },
  );

  probeFixtureTest(
    "recovers PUBLISHED demand after a killed dispatcher before Redis delivery, with one effect",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "crash-after-published" },
      });
      const message = await spawnCrashingDispatcher(fixture, {
        mode: "before-publish",
        owner: "crash-publish-owner",
      });
      expect(message).toMatchObject({ claimed: 1, published: 0 });

      // The database transition committed before the producer died. Redis
      // has never received this attempt; recovery must not depend on it.
      const stranded = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(stranded?.state).toBe("PUBLISHED");
      expect(stranded?.dispatchOwner).toBeNull();
      expect(stranded?.dispatchClaimUntil).toBeNull();
      expect(await fixture.queue.getJob(durableBullmqJobId(job.id, 1))).toBeUndefined();
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(0);

      expect(await runDurableDispatcherCycle(fixture.dispatcher("recover"))).toBe(1);
      await waitForJobState(fixture, durableBullmqJobId(job.id, 1), "waiting");
      // A redundant cycle retains one deterministic delivery.
      expect(await runDurableDispatcherCycle(fixture.dispatcher("recover-again"))).toBe(1);
      expect(await fixture.queue.getJobCounts("waiting")).toMatchObject({ waiting: 1 });

      const worker = await runProbeWorker(fixture, "recover-worker");
      try {
        await waitForState(fixture, job.id, "COMPLETE");
        await waitForJobState(fixture, durableBullmqJobId(job.id, 1), "completed");
        // Force a second actual delivery of this attempt. The production
        // consumer's durable fence must skip it after the first completion.
        const delivery = await fixture.queue.getJob(durableBullmqJobId(job.id, 1));
        expect(delivery).toBeDefined();
        await delivery!.retry("completed");
        await waitForJobState(fixture, durableBullmqJobId(job.id, 1), "completed");
      } finally {
        await worker.close();
      }
      const completed = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(completed).toMatchObject({ state: "COMPLETE", attemptEpoch: 1 });
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(1);
      expect(await runDurableDispatcherCycle(fixture.dispatcher("after-complete"))).toBe(0);
    },
  );

  probeFixtureTest(
    "rebuilds delivery after disposable Redis loss without manual intervention",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "redis-loss" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("d1"));
      await fixture.queue.obliterate({ force: true });
      await runDurableDispatcherCycle(fixture.dispatcher("d1"));
      const worker = await runProbeWorker(fixture, "w3");
      await waitForState(fixture, job.id, "COMPLETE");
      await worker.close();
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(1);
    },
  );

  probeFixtureTest("partitions rows between overlapping competing dispatchers", async (fixture) => {
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: `m${i}` },
        now,
      });
    }
    const [left, right] = await Promise.all([
      claimDispatchBatch(fixture.prisma, { owner: "compete-left", now, limit: 3 }),
      claimDispatchBatch(fixture.prisma, { owner: "compete-right", now, limit: 3 }),
    ]);
    expect(left.length + right.length).toBe(6);
    const ids = [...left, ...right].map((row) => row.id);
    expect(new Set(ids).size).toBe(6);

    for (const row of left) {
      await publishDurableRow({ ...fixture.dispatcher("compete-left") }, row);
      await expect(
        markDispatchPublished(fixture.prisma, {
          jobId: row.id,
          owner: "compete-left",
          now: new Date(),
        }),
      ).resolves.toBe(true);
    }
    for (const row of right) {
      await publishDurableRow({ ...fixture.dispatcher("compete-right") }, row);
      await expect(
        markDispatchPublished(fixture.prisma, {
          jobId: row.id,
          owner: "compete-right",
          now: new Date(),
        }),
      ).resolves.toBe(true);
    }
    expect(await fixture.prisma.durableJob.count({ where: { state: "PUBLISHED" } })).toBe(6);
    for (const row of [...left, ...right]) {
      expect(
        await fixture.queue.getJob(durableBullmqJobId(row.id, row.attemptEpoch)),
      ).not.toBeNull();
    }
  });

  probeFixtureTest(
    "treats an expired worker lease as a fenced failure with a fresh attempt fence",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "recover-fence" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("fence-d"));
      const workerId = "same-worker";
      const first = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId,
        now: new Date(),
      });
      expect(first?.state).toBe("RUNNING");
      expect(first?.attemptEpoch).toBe(1);

      const expired = new Date(Date.now() + CLAIM_AND_LEASE_EXPIRY_MS);
      const batch = await claimDispatchBatch(fixture.prisma, {
        owner: "fence-recover",
        now: expired,
        limit: DISPATCH_BATCH_SIZE,
      });
      expect(batch).toEqual([]);
      const recovered = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(recovered?.state).toBe("RETRY");
      expect(recovered?.attemptEpoch).toBe(2);
      expect(recovered?.attemptCount).toBe(1);
      expect(recovered?.workerOwner).toBeNull();
      expect(recovered?.lastError).toBe(EXPIRED_LEASE_ERROR);
      expect(recovered?.nextRunAt.getTime()).toBe(expired.getTime() + LITERAL_RETRY_DELAYS_MS[0]!);

      // The expired worker's entire fence is dead: no effect write, no
      // completion, no heartbeat renewal, no failure attribution — even for a
      // replacement invocation with the identical worker id.
      await expect(
        recordProbeEffect(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          marker: "stale-A",
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);
      await expect(
        completeJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);
      await expect(
        heartbeatJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          now: new Date(),
        }),
      ).resolves.toBe(false);
      await expect(
        failJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          now: new Date(),
          error: "stale",
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(0);

      // Admission before the backoff deadline refuses the row; after it, the
      // replacement delivery uses the fresh epoch's deterministic id.
      expect(
        await claimDispatchBatch(fixture.prisma, {
          owner: "fence-early",
          now: new Date(expired.getTime() + LITERAL_RETRY_DELAYS_MS[0]! - 10),
          limit: DISPATCH_BATCH_SIZE,
        }),
      ).toEqual([]);
      const due = new Date(expired.getTime() + LITERAL_RETRY_DELAYS_MS[0]! + 500);
      expect(
        await runDurableDispatcherCycle({ ...fixture.dispatcher("fence-due"), now: () => due }),
      ).toBe(1);
      expect(await fixture.queue.getJob(durableBullmqJobId(job.id, 2))).not.toBeNull();

      const worker = await runProbeWorker(fixture, workerId);
      await waitForState(fixture, job.id, "COMPLETE");
      await worker.close();
      const effect = await fixture.prisma.durableJobProbeEffect.findFirst();
      expect(effect?.marker).toBe("recover-fence");
      expect(effect?.attemptEpoch).toBe(2);
    },
  );

  probeFixtureTest(
    "returns the acquiring worker its own fence when a replacement shares its worker id",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "claim-snapshot" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("snapshot-d"));
      const workerId = "same-process-worker";
      const first = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId,
        now: new Date(),
      });
      expect(first?.state).toBe("RUNNING");
      expect(first?.attemptEpoch).toBe(1);

      // Worker A is paused here holding only the row its claim returned. Its
      // lease expires; recovery converts A's execution into a fenced RETRY
      // with a fresh epoch, the replacement delivery is published, and worker
      // B — running in the same process, so sharing A's worker id — acquires
      // it before A resumes.
      const expired = new Date(Date.now() + CLAIM_AND_LEASE_EXPIRY_MS);
      expect(
        await claimDispatchBatch(fixture.prisma, {
          owner: "snapshot-recover",
          now: expired,
          limit: DISPATCH_BATCH_SIZE,
        }),
      ).toEqual([]);
      const due = new Date(expired.getTime() + LITERAL_RETRY_DELAYS_MS[0]! + 500);
      expect(
        await runDurableDispatcherCycle({
          ...fixture.dispatcher("snapshot-republish"),
          now: () => due,
        }),
      ).toBe(1);
      const replacement = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId,
        now: new Date(),
      });
      expect(replacement?.state).toBe("RUNNING");
      expect(replacement?.attemptEpoch).toBe(2);
      expect(replacement?.workerOwner).toBe(workerId);

      // A resumes with its original fence: even though the row's workerOwner
      // equals A's worker id, every fenced operation is rejected against B's
      // replacement — no domain write, no completion, no heartbeat, no failure
      // attribution.
      await expect(
        recordProbeEffect(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          marker: "stale-A",
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);
      await expect(
        completeJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);
      await expect(
        heartbeatJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          now: new Date(),
        }),
      ).resolves.toBe(false);
      await expect(
        failJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: first!.attemptEpoch,
          now: new Date(),
          error: "stale",
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(0);

      // B's replacement attempt survives A's late activity and completes with
      // exactly one domain effect under the fresh epoch.
      await commitProbeAttempt(fixture.prisma, {
        jobId: job.id,
        workerId,
        attemptEpoch: replacement!.attemptEpoch,
        marker: "claim-snapshot",
        now: new Date(),
      });
      const row = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(row?.state).toBe("COMPLETE");
      const effect = await fixture.prisma.durableJobProbeEffect.findFirst();
      expect(effect?.marker).toBe("claim-snapshot");
      expect(effect?.attemptEpoch).toBe(2);
    },
  );

  probeFixtureTest(
    "routes repeated worker-lease expiries through the retry budget to FAILED",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "budget" },
      });
      let fakeMs = Date.now();
      const fakeNow = () => new Date(fakeMs);
      await runDurableDispatcherCycle({ ...fixture.dispatcher("budget-d0"), now: fakeNow });

      for (let i = 1; i <= LITERAL_RETRY_DELAYS_MS.length; i++) {
        const claimed = await claimJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId: `budget-${i}`,
          now: new Date(),
        });
        expect(claimed?.state).toBe("RUNNING");

        fakeMs += CLAIM_AND_LEASE_EXPIRY_MS;
        const expiry = new Date(fakeMs);
        const batch = await claimDispatchBatch(fixture.prisma, {
          owner: `budget-rec-${i}`,
          now: expiry,
          limit: DISPATCH_BATCH_SIZE,
        });
        expect(batch).toEqual([]);
        const row = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
        expect(row?.state).toBe("RETRY");
        expect(row?.attemptCount).toBe(i);
        expect(row?.attemptEpoch).toBe(i + 1);
        expect(row?.lastError).toBe(EXPIRED_LEASE_ERROR);
        expect(row?.nextRunAt.getTime()).toBe(expiry.getTime() + LITERAL_RETRY_DELAYS_MS[i - 1]!);

        if (i === 1) {
          const notYetDue = new Date(expiry.getTime() + LITERAL_RETRY_DELAYS_MS[0]! - 10);
          expect(
            await claimDispatchBatch(fixture.prisma, {
              owner: "budget-early",
              now: notYetDue,
              limit: DISPATCH_BATCH_SIZE,
            }),
          ).toEqual([]);
        }

        fakeMs += LITERAL_RETRY_DELAYS_MS[i - 1]! + 1_000;
        expect(
          await runDurableDispatcherCycle({
            ...fixture.dispatcher(`budget-d${i}`),
            now: () => new Date(fakeMs),
          }),
        ).toBe(1);
      }

      // Sixth expired execution: the budget is exhausted, so recovery fails
      // the job closed instead of scheduling another retry.
      const sixth = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId: "budget-6",
        now: new Date(),
      });
      expect(sixth?.state).toBe("RUNNING");
      fakeMs += CLAIM_AND_LEASE_EXPIRY_MS;
      const finalBatch = await claimDispatchBatch(fixture.prisma, {
        owner: "budget-rec-6",
        now: new Date(fakeMs),
        limit: DISPATCH_BATCH_SIZE,
      });
      expect(finalBatch).toEqual([]);
      const failed = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(failed?.state).toBe("FAILED");
      expect(failed?.attemptCount).toBe(LITERAL_RETRY_DELAYS_MS.length + 1);
      expect(failed?.workerOwner).toBeNull();
      expect(failed?.lastError).toBe(EXPIRED_LEASE_ERROR);
      await expect(
        claimJobAttempt(fixture.prisma, { jobId: job.id, workerId: "budget-7", now: new Date() }),
      ).resolves.toBeNull();
      expect(await countReadyDispatchRows(fixture.prisma, new Date(fakeMs))).toBe(0);
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(0);
    },
  );

  probeFixtureTest(
    "blocks unreserved dispatch and late completion after cancellation",
    async (fixture) => {
      // Cancelled before dispatch: nothing is published to Redis.
      const pendingJob = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "cancel-pending" },
      });
      await cancelDurableJob(fixture.prisma, pendingJob.id);
      expect(await runDurableDispatcherCycle(fixture.dispatcher("cancel-d"))).toBe(0);
      expect(await fixture.queue.getJob(durableBullmqJobId(pendingJob.id, 1))).toBeUndefined();

      // Cancelled after publish but before the worker claims: the production
      // consumer skips the unreserved external delivery.
      const publishedJob = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "cancel-published" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("cancel-d"));
      await cancelDurableJob(fixture.prisma, publishedJob.id);
      await expect(
        runDurableProbeDelivery(fixture.prisma, {
          workerId: "late-worker",
          durableJobId: publishedJob.id,
        }),
      ).resolves.toEqual({ skipped: true });
      const cancelledRow = await fixture.prisma.durableJob.findUnique({
        where: { id: publishedJob.id },
      });
      expect(cancelledRow?.state).toBe("CANCELLED");

      // Cancelled while running: the late completion is rejected.
      const runningJob = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "cancel-running" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("cancel-d"));
      const claimed = await claimJobAttempt(fixture.prisma, {
        jobId: runningJob.id,
        workerId: "w-cancel",
        now: new Date(),
      });
      expect(claimed).not.toBeNull();
      await cancelDurableJob(fixture.prisma, runningJob.id);
      await expect(
        completeJobAttempt(fixture.prisma, {
          jobId: runningJob.id,
          workerId: "w-cancel",
          attemptEpoch: claimed!.attemptEpoch,
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(DurableJobCancelledError);
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(0);
    },
  );

  probeFixtureTest(
    "cannot revoke a worker lease acquired between dispatch claim and acknowledgment",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "ack-race" },
      });
      // Publish once, then re-claim the PUBLISHED row for reconciliation — the
      // crash-after-publish recovery path. The dispatcher holds a dispatch
      // claim but has not re-acknowledged yet.
      await runDurableDispatcherCycle(fixture.dispatcher("ack-d0"));
      const [row] = await claimDispatchBatch(fixture.prisma, {
        owner: "racing-dispatcher",
        now: new Date(),
        limit: 1,
      });
      expect(row?.id).toBe(job.id);
      expect(row?.state).toBe("PUBLISHED");
      await publishDurableRow({ ...fixture.dispatcher("racing-dispatcher") }, row!);

      // A worker acquires the delivery and renews the lease while the
      // dispatcher is still between publish and acknowledgment.
      const claimed = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId: "racing-worker",
        now: new Date(),
      });
      expect(claimed?.state).toBe("RUNNING");
      const renewed = await heartbeatJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId: "racing-worker",
        attemptEpoch: claimed!.attemptEpoch,
        now: new Date(Date.now() + 1_000),
      });
      expect(renewed).toBe(true);
      const runningRow = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      const heldLeaseUntil = runningRow?.leaseUntil;

      // The late acknowledgment must not match: the worker cleared the
      // dispatch claim when acquiring, and a RUNNING row is never acceptable.
      await expect(
        markDispatchPublished(fixture.prisma, {
          jobId: job.id,
          owner: "racing-dispatcher",
          now: new Date(),
        }),
      ).resolves.toBe(false);
      const afterAck = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(afterAck?.state).toBe("RUNNING");
      expect(afterAck?.workerOwner).toBe("racing-worker");
      expect(afterAck?.leaseUntil).toEqual(heldLeaseUntil);

      // The fenced completion still succeeds after the failed ack.
      await expect(
        completeJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId: "racing-worker",
          attemptEpoch: claimed!.attemptEpoch,
          now: new Date(),
        }),
      ).resolves.toBe(true);
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(0);
    },
  );

  probeFixtureTest(
    "re-dispatches stranded RUNNING rows after lease expiry and Redis loss",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "stranded" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("d-strand"));
      const claimed = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId: "ghost-worker",
        now: new Date(),
      });
      expect(claimed?.state).toBe("RUNNING");
      const expired = new Date(Date.now() + CLAIM_AND_LEASE_EXPIRY_MS);
      await fixture.queue.obliterate({ force: true });
      expect(
        await runDurableDispatcherCycle({
          ...fixture.dispatcher("d-strand-2"),
          now: () => expired,
        }),
      ).toBe(0);
      const recovered = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(recovered?.state).toBe("RETRY");
      const due = new Date(expired.getTime() + LITERAL_RETRY_DELAYS_MS[0]! + 500);
      expect(
        await runDurableDispatcherCycle({ ...fixture.dispatcher("d-strand-3"), now: () => due }),
      ).toBe(1);
      const worker = await runProbeWorker(fixture, "recovery-worker");
      await waitForState(fixture, job.id, "COMPLETE");
      await worker.close();
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(1);
    },
  );

  probeFixtureTest(
    "bumps attempt epoch on automatic retry so the prior fence cannot complete",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "retry-fence" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("retry-d"));
      const workerId = "retry-worker";
      const claimed = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId,
        now: new Date(),
      });
      expect(claimed).not.toBeNull();
      const firstEpoch = claimed!.attemptEpoch;
      const failed = await failJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId,
        attemptEpoch: firstEpoch,
        now: new Date(),
        error: "transient",
      });
      expect(failed?.state).toBe("RETRY");
      const row = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(row?.attemptEpoch).toBe(firstEpoch + 1);
      await expect(
        completeJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId,
          attemptEpoch: firstEpoch,
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);
    },
  );

  probeFixtureTest(
    "keeps a completed Redis delivery from stranding a DB RETRY row",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "late-delivery" },
      });
      await runDurableDispatcherCycle(fixture.dispatcher("late-d0"));
      const claimed = await claimJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId: "old-worker",
        now: new Date(),
      });
      expect(claimed).not.toBeNull();
      const failNow = new Date(Date.now() + 10_000);
      const failed = await failJobAttempt(fixture.prisma, {
        jobId: job.id,
        workerId: "old-worker",
        attemptEpoch: claimed!.attemptEpoch,
        now: failNow,
        error: "transient",
      });
      expect(failed?.state).toBe("RETRY");

      // The superseded Redis delivery drains through a real BullMQ worker: the
      // production consumer skips it (the RETRY row is unclaimable), BullMQ
      // records the terminal completed state for that deterministic id, and
      // the DB row is untouched.
      const staleWorker = await runProbeWorker(fixture, "old-worker");
      await waitForJobState(
        fixture,
        durableBullmqJobId(job.id, claimed!.attemptEpoch),
        "completed",
      );
      await staleWorker.close();
      const retryRow = await fixture.prisma.durableJob.findUnique({ where: { id: job.id } });
      expect(retryRow?.state).toBe("RETRY");

      // Admission before the persisted deadline refuses to re-dispatch; after
      // it, the replacement publishes under the fresh epoch's deterministic id
      // and the job eventually completes with exactly one domain effect.
      expect(
        await runDurableDispatcherCycle({
          ...fixture.dispatcher("late-d1"),
          now: () => new Date(failNow.getTime() - 5_000),
        }),
      ).toBe(0);
      expect(
        await runDurableDispatcherCycle({
          ...fixture.dispatcher("late-d2"),
          now: () => new Date(failNow.getTime() + LITERAL_RETRY_DELAYS_MS[0]! + 2_000),
        }),
      ).toBe(1);

      const worker = await runProbeWorker(fixture, "fresh-worker");
      await waitForState(fixture, job.id, "COMPLETE");
      await worker.close();
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(1);
    },
  );

  probeFixtureTest(
    "explicit retry preserves the desired snapshot and reseeds the attempt budget",
    async (fixture) => {
      const job = await enqueueDurableJob(fixture.prisma, {
        dedupKey: `probe:${randomUUID()}`,
        kind: "PROBE",
        desired: { marker: "snapshot-keep" },
      });
      let fakeMs = Date.now();
      await runDurableDispatcherCycle({
        ...fixture.dispatcher("snap-d0"),
        now: () => new Date(fakeMs),
      });

      let finalEpoch = 1;
      for (let i = 1; i <= LITERAL_RETRY_DELAYS_MS.length + 1; i++) {
        const claimed = await claimJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId: `snap-${i}`,
          now: new Date(),
        });
        expect(claimed).not.toBeNull();
        finalEpoch = claimed!.attemptEpoch;
        const failed = await failJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId: `snap-${i}`,
          attemptEpoch: claimed!.attemptEpoch,
          now: new Date(fakeMs),
          error: `boom-${i}`,
        });
        if (i <= LITERAL_RETRY_DELAYS_MS.length) {
          expect(failed?.state).toBe("RETRY");
          fakeMs += LITERAL_RETRY_DELAYS_MS[i - 1]! + 1_000;
          expect(
            await runDurableDispatcherCycle({
              ...fixture.dispatcher(`snap-d${i}`),
              now: () => new Date(fakeMs),
            }),
          ).toBe(1);
        } else {
          expect(failed?.state).toBe("FAILED");
        }
      }

      const retried = await retryDurableJob(fixture.prisma, job.id, new Date(fakeMs + 1_000));
      expect(retried).not.toBeNull();
      expect(retried?.state).toBe("PENDING");
      expect(retried?.attemptCount).toBe(0);
      expect(retried?.attemptEpoch).toBe(finalEpoch + 1);
      expect(retried?.desired).toEqual({ marker: "snapshot-keep" });
      expect(retried?.lastError).toBeNull();
      expect(retried?.completedAt).toBeNull();
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(0);

      // The exhausted attempt's fence stays dead after the explicit retry.
      await expect(
        completeJobAttempt(fixture.prisma, {
          jobId: job.id,
          workerId: `snap-${LITERAL_RETRY_DELAYS_MS.length + 1}`,
          attemptEpoch: finalEpoch,
          now: new Date(),
        }),
      ).rejects.toBeInstanceOf(DurableJobFenceError);

      const worker = await runProbeWorker(fixture, "snap-fresh");
      try {
        // Old, exhausted deliveries remain unclaimable while retry is PENDING.
        for (let epoch = 1; epoch <= finalEpoch; epoch++) {
          await waitForJobState(fixture, durableBullmqJobId(job.id, epoch), "completed");
        }
        const freshDeliveryId = durableBullmqJobId(job.id, retried!.attemptEpoch);
        expect(
          await runDurableDispatcherCycle({
            ...fixture.dispatcher("snap-final", {
              // Delivery can finish before Queue.add resumes: its durable
              // attempt must already be claimable on this first publication.
              afterPublish: () => waitForJobState(fixture, freshDeliveryId, "completed"),
            }),
            now: () => new Date(fakeMs + 2_000),
          }),
        ).toBe(1);
        expect((await fixture.prisma.durableJob.findUnique({ where: { id: job.id } }))?.state).toBe(
          "COMPLETE",
        );
        expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(1);
        // The same delivery never needs a periodic poll to make progress.
        expect(
          await runDurableDispatcherCycle({
            ...fixture.dispatcher("snap-reconcile"),
            now: () => new Date(fakeMs + 3_000),
          }),
        ).toBe(0);
        await waitForJobState(fixture, freshDeliveryId, "completed");
      } finally {
        await worker.close();
      }
      const effect = await fixture.prisma.durableJobProbeEffect.findFirst();
      expect(effect?.marker).toBe("snapshot-keep");
      expect(effect?.attemptEpoch).toBe(finalEpoch + 1);
      expect(await fixture.prisma.durableJobProbeEffect.count()).toBe(1);
    },
  );

  probeFixtureTest(
    "drains backlog larger than one dispatch page across cycles",
    async (fixture) => {
      const total = DISPATCH_BATCH_SIZE + 5;
      const now = new Date();
      for (let i = 0; i < total; i++) {
        await enqueueDurableJob(fixture.prisma, {
          dedupKey: `probe:${randomUUID()}`,
          kind: "PROBE",
          desired: { marker: `bulk-${i}` },
          now,
        });
      }
      expect(await countReadyDispatchRows(fixture.prisma, now)).toBe(total);
      await runDurableDispatcherCycle(fixture.dispatcher("bulk-1"));
      await runDurableDispatcherCycle(fixture.dispatcher("bulk-2"));
      const published = await fixture.prisma.durableJob.count({ where: { state: "PUBLISHED" } });
      expect(published).toBe(total);
    },
  );
});
