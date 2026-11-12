import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { requireOperationLease } from "@knowledge-base/api/lib/kb/lock";
import { isGitWriteCapability } from "@knowledge-base/api/lib/kb/write-capability";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/api/lib/kb/recovery", () => ({
  kbRecoveryGateOpen: () => true,
}));

import {
  openKbPostgresClusterFromEnv,
  processIsAlive,
} from "../../../packages/test-utils/src/kb/index.js";

// Only the process supervisor is substituted. Coordinator, leases, transactions,
// deadlines and both in-process/PG lock layers below are production code.
vi.mock("./kb-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kb-process.js")>()),
  assertProcessFence: vi.fn(),
  closeAdmission: vi.fn(async () => undefined),
  spawnMutatingChild: vi.fn(async () => ({ pid: 4242 })),
  waitMutatingChild: vi.fn(async (opId: string, pid: number) => ({ opId, pid, status: 0 })),
  drainMutatingChild: vi.fn(async (opId: string, pid: number) => ({ opId, pid, status: 0 })),
}));

const { createKbWriteCoordinator } = await import("./kb-write-coordinator.js");
const { issueGitWriteCapability } = await import("./kb-write-capability.js");
const { assertProcessFence } = await import("./kb-process.js");
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
const connectionString = db.urls.applier;

beforeAll(async () => {
  await db.query("applier", "CREATE TABLE reservations (id text PRIMARY KEY)");
  await db.query("applier", "CREATE TABLE finalizations (id text PRIMARY KEY)");
});
afterAll(async () => {
  await db.close();
  await cluster.close();
});

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
function reservation(id: string) {
  return {
    async reauthorize() {},
    async reservePublication({
      query,
    }: import("@knowledge-base/api/lib/kb/authority-lock").AuthorityBarrierContext) {
      await query("INSERT INTO reservations VALUES ($1)", [id]);
    },
  };
}
async function rows(table: "reservations" | "finalizations", id: string) {
  return (await db.query("applier", `SELECT id FROM ${table} WHERE id = $1`, [id])).rows;
}
async function held(pid: number) {
  return (
    await db.query(
      "applier",
      "SELECT pid FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND granted",
      [pid],
    )
  ).rows;
}

describe("coordinator through real Postgres locks", () => {
  it("seals the KB gate and rejects shutdown when a forked child's spawn acknowledgement is lost", async () => {
    const ack = Promise.withResolvers<{ pid: number }>();
    const forked = Promise.withResolvers<void>();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const close = vi.fn(async () => {});
    const coord = createKbWriteCoordinator({
      connectionString,
      closeAdmission: close,
      spawn: () => {
        forked.resolve();
        return ack.promise;
      },
    });
    const successorRun = vi.fn(async () => "unsafe");
    const otherCoordinator = createKbWriteCoordinator({
      connectionString,
      lockWaitMs: 80,
      closeAdmission: close,
    });
    try {
      const first = coord.run({
        opId: "lost_ack",
        kind: "git-write",
        kbIds: ["lost_ack_kb"],
        async run(ctx) {
          await ctx.spawnMutatingChild({
            argv: ["ignored"],
            cwd: "/tmp",
            capability: ctx.issueWriteCapability("lost_ack_kb"),
          });
        },
      });
      void first.catch(() => {});
      await forked.promise;
      const successor = otherCoordinator.run({
        opId: "lost_ack_next",
        kind: "git-write",
        kbIds: ["lost_ack_kb"],
        run: successorRun,
      });
      void successor.catch(() => {});
      ack.reject(new Error("control channel closed after fork"));
      await expect(first).rejects.toMatchObject({ code: "CONNECTION_LOST" });
      expect(processIsAlive(child.pid ?? 0)).toBe(true);
      expect(coord.admissionClosed).toBe(true);
      await expect(successor).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
      expect(successorRun).not.toHaveBeenCalled();
      await expect(coord.shutdown()).rejects.toMatchObject({ code: "CONNECTION_LOST" });
      // A close-admission send is not a teardown acknowledgement. This remains
      // an unclean shutdown even if cleanup later independently reaps the child.
      expect(processIsAlive(child.pid ?? 0)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await exited;
      await otherCoordinator.shutdown();
    }
  });

  it("joins committed finalization and response staging during shutdown before admitting a successor", async () => {
    const close = vi.fn(async () => {});
    const coord = createKbWriteCoordinator({ connectionString, closeAdmission: close });
    const successor = createKbWriteCoordinator({
      connectionString,
      closeAdmission: async () => {},
    });
    const finalizing = latch();
    const finish = latch();
    const events: string[] = [];
    let pid = 0;
    let shutdownDone = false;
    let successorRan = false;
    const first = coord.run({
      opId: "finalize",
      kind: "git-write",
      kbIds: ["finalize"],
      barrier: reservation("finalize"),
      async run(ctx) {
        pid = ctx.lease.backendPid;
        await ctx.lease.transaction(async (query) => {
          await query("INSERT INTO finalizations VALUES ('finalize')");
          finalizing.release();
          await finish.promise;
        });
        // A committed operation may still spawn during graceful shutdown.
        const capability = ctx.issueWriteCapability("finalize");
        expect(isGitWriteCapability(capability)).toBe(true);
        const child = await ctx.spawnMutatingChild({
          argv: ["/bin/true"],
          cwd: "/tmp",
          capability,
        });
        await ctx.waitChild(child.pid);
        await Promise.resolve();
        events.push("response-staged");
        return "reconciled";
      },
    });
    void first.catch(() => {});
    await finalizing.promise;
    const shutting = coord.shutdown().then(() => {
      shutdownDone = true;
    });
    const second = successor.run({
      opId: "finalize_next",
      kind: "git-write",
      kbIds: ["finalize"],
      async run() {
        successorRan = true;
        events.push("successor");
      },
    });
    try {
      await delay(40);
      expect(shutdownDone).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(successorRan).toBe(false);
      expect(await held(pid)).toHaveLength(1);
      expect(await rows("reservations", "finalize")).toEqual([{ id: "finalize" }]);
      expect(await rows("finalizations", "finalize")).toEqual([]);
    } finally {
      finish.release();
    }
    await expect(first).resolves.toBe("reconciled");
    await Promise.all([shutting, second]);
    expect(events).toEqual(["response-staged", "successor"]);
    expect(await rows("finalizations", "finalize")).toEqual([{ id: "finalize" }]);
    expect(await held(pid)).toEqual([]);
    await successor.shutdown();
  });

  it("joins a canceled async callback and transaction rollback before shutdown or a successor", async () => {
    const coord = createKbWriteCoordinator({ connectionString, closeAdmission: async () => {} });
    const successor = createKbWriteCoordinator({
      connectionString,
      closeAdmission: async () => {},
    });
    const entered = latch();
    const cleaning = latch();
    const finish = latch();
    let callbackFinished = false;
    let successorRan = false;
    let shutdownDone = false;
    let pid = 0;
    const first = coord.run({
      opId: "cancel_join",
      kind: "git-write",
      kbIds: ["cancel_join"],
      async run({ lease, signal }) {
        pid = lease.backendPid;
        try {
          await lease.transaction(async (query) => {
            await query("INSERT INTO finalizations VALUES ('cancel_join')");
            entered.release();
            await aborted(signal);
            cleaning.release();
            await finish.promise;
          });
        } finally {
          callbackFinished = true;
        }
      },
    });
    void first.catch(() => {});
    await entered.promise;
    const shutting = coord.shutdown().then(() => {
      shutdownDone = true;
    });
    await cleaning.promise;
    const second = successor.run({
      opId: "cancel_join_next",
      kind: "git-write",
      kbIds: ["cancel_join"],
      async run() {
        expect(callbackFinished).toBe(true);
        successorRan = true;
      },
    });
    try {
      await delay(40);
      expect(callbackFinished).toBe(false);
      expect(shutdownDone).toBe(false);
      expect(successorRan).toBe(false);
      expect(await held(pid)).toHaveLength(1);
    } finally {
      finish.release();
    }
    await expect(first).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
    await Promise.all([shutting, second]);
    expect(callbackFinished).toBe(true);
    expect(await rows("finalizations", "cancel_join")).toEqual([]);
    expect(await held(pid)).toEqual([]);
    await successor.shutdown();
  });

  it("bounds committed work during shutdown by the original deadline and joins its SQL rollback", async () => {
    const coord = createKbWriteCoordinator({
      connectionString,
      mutationDeadlineMs: 350,
      closeAdmission: async () => {},
    });
    const entered = latch();
    let callbackFinished = false;
    const start = Date.now();
    const first = coord.run({
      opId: "deadline_commit",
      kind: "git-write",
      kbIds: ["deadline_commit"],
      barrier: reservation("deadline_commit"),
      async run({ lease }) {
        try {
          await lease.transaction(async (query) => {
            await query("INSERT INTO finalizations VALUES ('deadline_commit')");
            entered.release();
            await query("SELECT pg_sleep(3)");
          });
          return "must not succeed";
        } finally {
          callbackFinished = true;
        }
      },
    });
    void first.catch(() => {});
    await entered.promise;
    await coord.shutdown();
    expect(callbackFinished).toBe(true);
    await expect(first).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(await rows("reservations", "deadline_commit")).toEqual([{ id: "deadline_commit" }]);
    expect(await rows("finalizations", "deadline_commit")).toEqual([]);
  });

  it("uses the remaining deadline across reauthorization and reservation statements", async () => {
    const coord = createKbWriteCoordinator({
      connectionString,
      mutationDeadlineMs: 800,
      closeAdmission: async () => {},
    });
    const budgets: number[] = [];
    let ran = false;
    await expect(
      coord.run({
        opId: "cumulative",
        kind: "git-write",
        kbIds: ["cumulative"],
        barrier: {
          async reauthorize({ query }) {
            budgets.push(
              Number(
                (
                  await query<{ ms: number }>(
                    "SELECT extract(epoch FROM current_setting('statement_timeout')::interval) * 1000 AS ms",
                  )
                ).rows[0]?.ms,
              ),
            );
            await query("SELECT pg_sleep(0.45)");
          },
          async reservePublication({ query }) {
            budgets.push(
              Number(
                (
                  await query<{ ms: number }>(
                    "SELECT extract(epoch FROM current_setting('statement_timeout')::interval) * 1000 AS ms",
                  )
                ).rows[0]?.ms,
              ),
            );
            await query("INSERT INTO reservations VALUES ('cumulative')");
            await query("SELECT pg_sleep(0.45)");
          },
        },
        async run() {
          ran = true;
          return "must not succeed";
        },
      }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(budgets).toHaveLength(2);
    expect(budgets[1]).toBeLessThan((budgets[0] ?? 0) - 350);
    expect(ran).toBe(false);
    expect(await rows("reservations", "cumulative")).toEqual([]);
    await coord.shutdown();
  });

  it.each(["reauthorize", "reservePublication"] as const)(
    "cancels a paused %s at the deadline without a late commit",
    async (stage) => {
      const coord = createKbWriteCoordinator({
        connectionString,
        mutationDeadlineMs: 200,
        closeAdmission: async () => {},
      });
      let pid = 0;
      let barrierFinished = false;
      let ran = false;
      const pause = async ({
        query,
        signal,
      }: import("@knowledge-base/api/lib/kb/authority-lock").AuthorityBarrierContext) => {
        pid = requireOperationLease().backendPid;
        await query("INSERT INTO reservations VALUES ($1)", [stage]);
        await aborted(signal);
        // Even an accidentally swallowed abort may not submit a COMMIT.
        barrierFinished = true;
      };
      await expect(
        coord.run({
          opId: stage,
          kind: "git-write",
          kbIds: [stage],
          barrier: { async reauthorize() {}, async reservePublication() {}, [stage]: pause },
          async run() {
            ran = true;
            return "late success";
          },
        }),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(barrierFinished).toBe(true);
      expect(ran).toBe(false);
      expect(await rows("reservations", stage)).toEqual([]);
      expect(await held(pid)).toEqual([]);
      await coord.shutdown();
    },
  );

  it("joins a paused uncommitted reservation on shutdown and forbids its late COMMIT", async () => {
    const coord = createKbWriteCoordinator({ connectionString, closeAdmission: async () => {} });
    const entered = latch();
    const finish = latch();
    const canceled = latch();
    let pid = 0;
    let done = false;
    let ran = false;
    const running = coord.run({
      opId: "reserve_shutdown",
      kind: "git-write",
      kbIds: ["reserve_shutdown"],
      barrier: {
        async reauthorize() {},
        async reservePublication({ query, signal }) {
          pid = requireOperationLease().backendPid;
          await query("INSERT INTO reservations VALUES ('reserve_shutdown')");
          entered.release();
          await aborted(signal);
          canceled.release();
          await finish.promise;
        },
      },
      async run() {
        ran = true;
      },
    });
    void running.catch(() => {});
    await entered.promise;
    const shutting = coord.shutdown().then(() => {
      done = true;
    });
    await canceled.promise;
    try {
      expect(done).toBe(false);
      expect(await held(pid)).toHaveLength(2);
    } finally {
      finish.release();
    }
    await shutting;
    await expect(running).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
    expect(ran).toBe(false);
    expect(await rows("reservations", "reserve_shutdown")).toEqual([]);
    expect(await held(pid)).toEqual([]);
  });

  it("joins real child drain and async work after PG loss before a same-KB successor", async () => {
    const spawned = latch();
    const draining = latch();
    const allowDrain = latch();
    const reaped = latch();
    const finishCallback = latch();
    const callbackCleaning = latch();
    let child: ChildProcess | undefined;
    let pid = 0;
    let backendPid = 0;
    let callbackFinished = false;
    let successorRan = false;
    const coord = createKbWriteCoordinator({
      connectionString,
      closeAdmission: async () => {},
      async spawn() {
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        pid = child.pid ?? 0;
        child.once("exit", reaped.release);
        if (!pid) throw new Error("child did not start");
        return { pid };
      },
      async drain(opId, childPid) {
        draining.release();
        await allowDrain.promise;
        child?.kill("SIGKILL");
        await reaped.promise;
        return { opId, pid: childPid, status: 137 };
      },
    });
    const first = coord.run({
      opId: "loss_join",
      kind: "git-write",
      kbIds: ["loss_join"],
      async run(ctx) {
        backendPid = ctx.lease.backendPid;
        const capability = ctx.issueWriteCapability("loss_join");
        await ctx.spawnMutatingChild({ argv: [process.execPath], cwd: "/tmp", capability });
        spawned.release();
        await aborted(ctx.signal);
        callbackCleaning.release();
        await finishCallback.promise;
        callbackFinished = true;
      },
    });
    void first.catch(() => {});
    await spawned.promise;
    let second: Promise<void> | undefined;
    try {
      await db.query("applier", "SELECT pg_terminate_backend($1)", [backendPid]);
      await Promise.all([draining.promise, callbackCleaning.promise]);
      second = coord.run({
        opId: "loss_join_next",
        kind: "git-write",
        kbIds: ["loss_join"],
        async run() {
          expect(processIsAlive(pid)).toBe(false);
          expect(callbackFinished).toBe(true);
          successorRan = true;
        },
      });
      await delay(30);
      expect(processIsAlive(pid)).toBe(true);
      expect(successorRan).toBe(false);
      allowDrain.release();
      await reaped.promise;
      await delay(30);
      expect(callbackFinished).toBe(false);
      expect(successorRan).toBe(false);
    } finally {
      allowDrain.release();
      finishCallback.release();
      child?.kill("SIGKILL");
    }
    await expect(first).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    await second;
    expect(successorRan).toBe(true);
    await coord.shutdown();
  });

  it("rejects multi-statement SQL that could reset a timeout within one query", async () => {
    const coord = createKbWriteCoordinator({ connectionString, closeAdmission: async () => {} });
    await expect(
      coord.run({
        opId: "multi_statement",
        kind: "git-write",
        kbIds: ["multi_statement"],
        barrier: {
          async reauthorize() {},
          async reservePublication({ query }) {
            await query("INSERT INTO reservations VALUES ('multi_statement'); COMMIT");
          },
        },
        async run() {
          throw new Error("must not run");
        },
      }),
    ).rejects.toMatchObject({ code: "42601" });
    expect(await rows("reservations", "multi_statement")).toEqual([]);
    await coord.shutdown();
  });

  it("requires the actual server fence even with a valid lease or a self-registered no-op", async () => {
    const coord = createKbWriteCoordinator({ connectionString, closeAdmission: async () => {} });
    await coord.run({
      opId: "mint_fence",
      kind: "git-write",
      kbIds: ["mint_fence"],
      async run({ lease }) {
        expect(() => issueGitWriteCapability({ assertFence: () => {} }, "mint_fence")).toThrow(
          /live pinned session/,
        );
        vi.mocked(assertProcessFence).mockImplementationOnce(() => {
          throw new Error("fence absent");
        });
        expect(() => issueGitWriteCapability(lease, "mint_fence")).toThrow("fence absent");
      },
    });
    await coord.shutdown();
  });
});
