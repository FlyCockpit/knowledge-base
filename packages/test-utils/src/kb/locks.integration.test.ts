import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import {
  AUTHORITY_LOCK_CLASSID,
  AUTHORITY_LOCK_OBJID,
  checkoutPinnedSession,
  HeldLockLease,
  KB_LOCK_CLASSID,
  KbLockError,
  kbLockObjid,
  type LockSpec,
  requireOperationLease,
} from "@knowledge-base/api/lib/kb/lock";
import { isGitWriteCapability } from "@knowledge-base/api/lib/kb/write-capability";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { openKbPostgresClusterFromEnv, processIsAlive } from "./index.js";

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();

afterAll(async () => {
  await db.close();
  await cluster.close();
});

const url = db.urls.applier;

function superuserUrl(database: string): string {
  return `postgresql://postgres:${encodeURIComponent(cluster.superuserPassword)}@${cluster.host}:${cluster.port}/${database}`;
}

async function connect(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

async function advisoryHeld(pid: number): Promise<Array<{ classid: number; objid: number }>> {
  const result = await db.query(
    "applier",
    `SELECT classid, objid FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND pid = $1
      ORDER BY classid, objid`,
    [pid],
  );
  return result.rows.map((row) => ({
    classid: int4(Number(row.classid)),
    objid: int4(Number(row.objid)),
  }));
}

function int4(value: number): number {
  return value > 0x7fffffff ? value - 0x1_0000_0000 : value;
}

async function backendPid(lease: HeldLockLease): Promise<number> {
  const result = await lease.query<{ pg_backend_pid: number | string }>(
    "SELECT pg_backend_pid() AS pg_backend_pid",
  );
  return Number(result.rows[0]?.pg_backend_pid);
}

describe("pinned PG lock sessions", () => {
  it("uses one backend pid for lock, transaction, and unlock", async () => {
    const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_pid" });
    try {
      await lease.acquire([{ kind: "authority" }, { kind: "kb", kbId: "kb_pid" }]);
      const lockPid = await backendPid(lease);
      expect(lockPid).toBe(lease.backendPid);
      const duringTx = await lease.transaction(async (query) => {
        const result = await query<{ pg_backend_pid: number | string }>(
          "SELECT pg_backend_pid() AS pg_backend_pid",
        );
        expect(await advisoryHeld(lockPid)).toEqual(
          expect.arrayContaining([
            { classid: AUTHORITY_LOCK_CLASSID, objid: AUTHORITY_LOCK_OBJID },
            { classid: KB_LOCK_CLASSID, objid: kbLockObjid("kb_pid") },
          ]),
        );
        return Number(result.rows[0]?.pg_backend_pid);
      });
      expect(duringTx).toBe(lockPid);
      const unlockPid = await backendPid(lease);
      expect(unlockPid).toBe(lockPid);
    } finally {
      const pid = lease.backendPid;
      await lease.close();
      expect(await advisoryHeld(pid)).toEqual([]);
    }
  });

  it("serializes writers on the same knowledge-base", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = runLockedOperation({
      connectionString: url,
      opId: "op_same_a",
      kind: "kb-write",
      kbIds: ["kb_same"],
      async run() {
        order.push("a-start");
        started();
        await firstHold;
        order.push("a-end");
      },
    });
    await firstStarted;
    const second = runLockedOperation({
      connectionString: url,
      opId: "op_same_b",
      kind: "kb-write",
      kbIds: ["kb_same"],
      async run() {
        order.push("b-start");
        order.push("b-end");
      },
    });
    await delay(200);
    expect(order).toEqual(["a-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("lets independent knowledge-bases proceed outside the short authority reservation", async () => {
    let kb1Working = false;
    let kb1Done = false;
    let kb2SawOverlap = false;
    let releaseKb1: () => void = () => undefined;
    const kb1Hold = new Promise<void>((resolve) => {
      releaseKb1 = resolve;
    });
    let started: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = runLockedOperation({
      connectionString: url,
      opId: "op_ind_a",
      kind: "kb-write",
      kbIds: ["kb_one"],
      async run() {
        kb1Working = true;
        started();
        await kb1Hold;
        kb1Done = true;
      },
    });
    await firstStarted;
    const second = runLockedOperation({
      connectionString: url,
      opId: "op_ind_b",
      kind: "kb-write",
      kbIds: ["kb_two"],
      async run() {
        kb2SawOverlap = kb1Working && !kb1Done;
      },
    });
    await second;
    expect(kb2SawOverlap).toBe(true);
    releaseKb1();
    await first;
  });

  it("fails a reverse lock order before acquiring any lock", async () => {
    const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_rev" });
    try {
      await expect(
        lease.acquire([{ kind: "kb", kbId: "kb_z" }, { kind: "authority" }]),
      ).rejects.toMatchObject({ code: "LOCK_ORDER" });
      expect(await advisoryHeld(lease.backendPid)).toEqual([]);
    } finally {
      await lease.close();
    }
  });

  it("times out lock wait, releases held locks, and leaves no child", async () => {
    const holder = await checkoutPinnedSession({ connectionString: url, opId: "op_to_hold" });
    await holder.acquire([{ kind: "kb", kbId: "kb_timeout" }]);
    const waiter = checkoutPinnedSession({ connectionString: url, opId: "op_to_wait" }).then(
      async (lease) => {
        try {
          await lease.acquire([{ kind: "kb", kbId: "kb_timeout" }]);
          return lease;
        } catch (error) {
          const pid = lease.backendPid;
          await lease.close();
          return { error, pid };
        }
      },
    );
    const result = await waiter;
    expect(result).toMatchObject({ error: expect.objectContaining({ code: "LOCK_TIMEOUT" }) });
    if ("pid" in result) expect(await advisoryHeld(result.pid)).toEqual([]);
    await holder.close();
  }, 15_000);

  it("drains a paused child before a successor publishes after the owning backend dies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-lock-race-"));
    const leakPath = join(dir, "leaked");
    const publishedPath = join(dir, "published");
    const childScript = join(dir, "child.mjs");
    writeFileSync(
      childScript,
      `import { writeFileSync } from "node:fs";
setTimeout(() => { writeFileSync(${JSON.stringify(leakPath)}, "stale"); }, 8000);
setInterval(() => {}, 1000);
`,
    );

    let childPid = 0;
    let backendPidValue = 0;
    let holding: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });

    const first = runLockedOperation({
      connectionString: url,
      opId: "op_race_a",
      kind: "kb-write",
      kbIds: ["kb_race"],
      async run(lease) {
        backendPidValue = lease.backendPid;
        const child = spawn(process.execPath, [childScript], { stdio: "ignore" });
        childPid = child.pid ?? 0;
        if (!childPid) throw new Error("child pid missing");
        const reap = async () => {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* already gone */
          }
          if (child.exitCode != null || child.signalCode != null) return;
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
          });
        };
        lease.lost.addEventListener("abort", () => {
          void reap();
        });
        holding();
        await new Promise<void>((_, reject) => {
          lease.lost.addEventListener("abort", () => {
            void reap().then(() => reject(new KbLockError("CONNECTION_LOST", "lost", lease.opId)));
          });
        });
      },
    });
    void first.catch(() => undefined);

    await held;
    expect(childPid).toBeGreaterThan(0);
    const admin = await connect(superuserUrl(db.database));
    try {
      await admin.query("SELECT pg_terminate_backend($1)", [backendPidValue]);
    } finally {
      await admin.end().catch(() => undefined);
    }

    const second = runLockedOperation({
      connectionString: url,
      opId: "op_race_b",
      kind: "kb-write",
      kbIds: ["kb_race"],
      async run() {
        expect(processIsAlive(childPid)).toBe(false);
        writeFileSync(publishedPath, "ok");
      },
    });

    await expect(first).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    await second;
    expect(existsSync(publishedPath)).toBe(true);
    expect(existsSync(leakPath)).toBe(false);
    expect(processIsAlive(childPid)).toBe(false);
  }, 20_000);

  it("rejects incremental acquire that inverts authority-then-sorted order", async () => {
    const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_incr" });
    try {
      await lease.acquire([{ kind: "kb", kbId: "kb_z" }]);
      const held = await advisoryHeld(lease.backendPid);
      await expect(lease.acquire([{ kind: "authority" }])).rejects.toMatchObject({
        code: "LOCK_ORDER",
      });
      await expect(lease.acquire([{ kind: "kb", kbId: "kb_a" }])).rejects.toMatchObject({
        code: "LOCK_ORDER",
      });
      expect(await advisoryHeld(lease.backendPid)).toEqual(held);
    } finally {
      await lease.close();
    }
  });

  it("rethrows ordinary statement errors without destroying the pinned session", async () => {
    const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_sqlerr" });
    try {
      await expect(lease.query("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
      expect(lease.connectionLost).toBe(false);
      const result = await lease.query<{ n: number | string }>("SELECT 1 AS n");
      expect(Number(result.rows[0]?.n)).toBe(1);
    } finally {
      await lease.close();
    }
  });

  it.each([
    { name: "authority-after-KB", offending: { kind: "authority" } },
    { name: "descending-KB", offending: { kind: "kb", kbId: "kb_a" } },
    { name: "duplicate-lock", offending: { kind: "kb", kbId: "kb_z" } },
  ] satisfies Array<{ name: string; offending: LockSpec }>)(
    "rejects concurrent $name before dispatching any offending lock SQL",
    async ({ offending }) => {
      const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_concurrent" });
      const queries = vi.spyOn(Client.prototype, "query");
      try {
        const results = await Promise.allSettled([
          lease.acquire([
            { kind: "kb", kbId: "kb_m" },
            { kind: "kb", kbId: "kb_z" },
          ]),
          lease.acquire([offending]),
        ]);
        expect(results[0]).toMatchObject({ status: "fulfilled" });
        expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "LOCK_ORDER" } });
        const acquired = queries.mock.calls
          .map(([query]) => query)
          .filter(
            (query) =>
              typeof query !== "string" && query.text === "SELECT pg_advisory_lock($1, $2)",
          );
        expect(acquired).toEqual([
          {
            text: "SELECT pg_advisory_lock($1, $2)",
            values: [KB_LOCK_CLASSID, kbLockObjid("kb_m")],
            queryMode: "extended",
          },
          {
            text: "SELECT pg_advisory_lock($1, $2)",
            values: [KB_LOCK_CLASSID, kbLockObjid("kb_z")],
            queryMode: "extended",
          },
        ]);
        expect(await advisoryHeld(lease.backendPid)).toEqual(
          expect.arrayContaining([
            { classid: KB_LOCK_CLASSID, objid: kbLockObjid("kb_m") },
            { classid: KB_LOCK_CLASSID, objid: kbLockObjid("kb_z") },
          ]),
        );
        expect(await advisoryHeld(lease.backendPid)).toHaveLength(2);
      } finally {
        queries.mockRestore();
        await lease.close();
      }
    },
  );

  it("serializes valid concurrent acquisition requests as whole sequences", async () => {
    const lease = await checkoutPinnedSession({
      connectionString: url,
      opId: "op_concurrent_valid",
    });
    const queries = vi.spyOn(Client.prototype, "query");
    try {
      await Promise.all([
        lease.acquire([{ kind: "authority" }, { kind: "kb", kbId: "kb_a" }]),
        lease.acquire([
          { kind: "kb", kbId: "kb_m" },
          { kind: "kb", kbId: "kb_z" },
        ]),
      ]);
      expect(
        queries.mock.calls
          .map(([query]) => query)
          .filter(
            (query) =>
              typeof query !== "string" && query.text === "SELECT pg_advisory_lock($1, $2)",
          )
          .map((query) => query.values),
      ).toEqual([
        [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID],
        [KB_LOCK_CLASSID, kbLockObjid("kb_a")],
        [KB_LOCK_CLASSID, kbLockObjid("kb_m")],
        [KB_LOCK_CLASSID, kbLockObjid("kb_z")],
      ]);
    } finally {
      queries.mockRestore();
      await lease.close();
    }
  });

  it("closes public admission synchronously while joining admitted SQL and transaction finalization", async () => {
    await db.query("applier", "CREATE TABLE closing_finalization (id text PRIMARY KEY)");
    const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_closing" });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    await lease.acquire([{ kind: "kb", kbId: "kb_closing" }]);
    const transaction = lease.transaction(async (query) => {
      entered.resolve();
      await finish.promise;
      await query("INSERT INTO closing_finalization VALUES ('done')");
    });
    try {
      await entered.promise;
      const submitted = lease.query("SELECT 42 AS answer");
      const closing = lease.close();
      expect(lease.close()).toBe(closing);
      expect(() => lease.assertHeldKb("kb_closing")).toThrowError(
        expect.objectContaining({ code: "NOT_HELD" }),
      );
      expect(() => lease.assertCanReceiveNetworkBody()).toThrowError(
        expect.objectContaining({ code: "NOT_HELD" }),
      );
      await expect(lease.query("SELECT 1")).rejects.toMatchObject({ code: "NOT_HELD" });
      await expect(lease.transaction(async () => {})).rejects.toMatchObject({ code: "NOT_HELD" });
      await expect(lease.acquire([{ kind: "kb", kbId: "kb_z" }])).rejects.toMatchObject({
        code: "NOT_HELD",
      });
      await expect(lease.releaseAuthority()).rejects.toMatchObject({ code: "NOT_HELD" });
      expect(await advisoryHeld(lease.backendPid)).toHaveLength(1);
      expect((await submitted).rows).toEqual([{ answer: 42 }]);
      finish.resolve();
      await transaction;
      await closing;
      expect((await db.query("applier", "SELECT id FROM closing_finalization")).rows).toEqual([
        { id: "done" },
      ]);
      expect(await advisoryHeld(lease.backendPid)).toEqual([]);
    } finally {
      finish.resolve();
      await transaction;
      await lease.close();
    }
  });

  it("times out same-KB in-process contention without running the late callback", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = runLockedOperation({
      connectionString: url,
      opId: "op_gate_a",
      kind: "kb-write",
      kbIds: ["kb_gate_wait"],
      async run() {
        firstStarted();
        await firstHold;
      },
    });
    await started;
    let secondRan = false;
    const second = runLockedOperation({
      connectionString: url,
      opId: "op_gate_b",
      kind: "kb-write",
      kbIds: ["kb_gate_wait"],
      lockWaitMs: 80,
      async run() {
        secondRan = true;
      },
    });
    await expect(second).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(secondRan).toBe(false);
    releaseFirst();
    await first;
  });

  it("holds the knowledge-base gate until cleanup finishes before admitting a successor", async () => {
    let cleanupDone = false;
    let releaseCleanup: () => void = () => undefined;
    const cleanupHold = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let firstStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = runLockedOperation({
      connectionString: url,
      opId: "op_cleanup_a",
      kind: "kb-write",
      kbIds: ["kb_cleanup"],
      async run() {
        firstStarted();
      },
      async cleanup() {
        await cleanupHold;
        cleanupDone = true;
      },
    });
    await started;
    let successorSawCleanup = false;
    const second = runLockedOperation({
      connectionString: url,
      opId: "op_cleanup_b",
      kind: "kb-write",
      kbIds: ["kb_cleanup"],
      async run() {
        successorSawCleanup = cleanupDone;
      },
    });
    await delay(50);
    expect(cleanupDone).toBe(false);
    releaseCleanup();
    await Promise.all([first, second]);
    expect(successorSawCleanup).toBe(true);
  });

  it("does not mint a server write capability from a directly acquired lease", async () => {
    const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_mint" });
    try {
      await lease.acquire([{ kind: "authority" }, { kind: "kb", kbId: "kb_mint" }]);
      await lease.releaseAuthority();
      expect(isGitWriteCapability({ opId: lease.opId, kbId: "kb_mint" })).toBe(false);
    } finally {
      await lease.close();
    }
  });

  it("lets an admitted mutation run past the acquisition wait budget", async () => {
    let clock = Date.now();
    const result = await runLockedOperation({
      connectionString: url,
      opId: "op_admitted",
      kind: "kb-write",
      kbIds: ["kb_admitted"],
      now: () => clock,
      async run(lease) {
        // Admission used the real PG session and the ordinary five-second
        // budget. Advance only after admission; host scheduling cannot spend
        // a compressed 50ms fixture budget before the intended observation.
        clock += 5_001;
        await lease.query("SELECT 1");
        return "ran";
      },
    });
    expect(result).toBe("ran");
  });
});

describe("authority barrier on a real session", () => {
  it("rejects reservation when reauthorize observes revocation", async () => {
    await runLockedOperation({
      connectionString: url,
      opId: "op_auth_setup",
      kind: "authority",
      async run(lease) {
        await lease.query("CREATE TABLE kb_auth_flag (revoked boolean NOT NULL)");
        await lease.query("INSERT INTO kb_auth_flag VALUES (true)");
      },
    });
    let reserved = false;
    await expect(
      runLockedOperation({
        connectionString: url,
        opId: "op_auth_denied",
        kind: "kb-write",
        kbIds: ["kb_auth"],
        barrier: {
          async reauthorize() {
            const lease = requireOperationLease();
            const result = await lease.query<{ revoked: boolean }>(
              "SELECT revoked FROM kb_auth_flag",
            );
            if (result.rows[0]?.revoked) throw new KbLockError("REVOKED", "principal was revoked");
          },
          async reservePublication() {
            reserved = true;
          },
        },
        async run() {
          return "no";
        },
      }),
    ).rejects.toMatchObject({ code: "REVOKED" });
    expect(reserved).toBe(false);
  });

  it("reconciles an in-flight writer after reservation if revocation lands later", async () => {
    await db.query("applier", "UPDATE kb_auth_flag SET revoked = false");
    let reserved = false;
    let continueWork: () => void = () => undefined;
    const workHold = new Promise<void>((resolve) => {
      continueWork = resolve;
    });
    let reservedReleased: () => void = () => undefined;
    const afterReserve = new Promise<void>((resolve) => {
      reservedReleased = resolve;
    });

    const writer = runLockedOperation({
      connectionString: url,
      opId: "op_auth_ok",
      kind: "kb-write",
      kbIds: ["kb_auth2"],
      barrier: {
        async reauthorize() {
          const lease = requireOperationLease();
          const result = await lease.query<{ revoked: boolean }>(
            "SELECT revoked FROM kb_auth_flag",
          );
          if (result.rows[0]?.revoked) throw new KbLockError("REVOKED", "principal was revoked");
        },
        async reservePublication({ query }) {
          await query("CREATE TABLE kb_res (v int PRIMARY KEY)");
          await query("INSERT INTO kb_res VALUES (1)");
          reserved = true;
        },
      },
      async run() {
        reservedReleased();
        await workHold;
        return "reconciled";
      },
    });

    await afterReserve;
    expect(reserved).toBe(true);
    await runLockedOperation({
      connectionString: url,
      opId: "op_auth_revoke",
      kind: "authority",
      async run(lease) {
        await lease.query("UPDATE kb_auth_flag SET revoked = true");
      },
    });
    continueWork();
    await expect(writer).resolves.toBe("reconciled");
    const rows = await db.query("applier", "SELECT v FROM kb_res");
    expect(rows.rows).toEqual([{ v: 1 }]);
  });

  it("does not receive a network body while the authority lock is held", async () => {
    const lease = await checkoutPinnedSession({ connectionString: url, opId: "op_net" });
    try {
      await lease.acquire([{ kind: "authority" }]);
      expect(() => lease.assertCanReceiveNetworkBody("receive upload body")).toThrow(
        /authority lock/,
      );
      await lease.releaseAuthority();
      lease.assertCanReceiveNetworkBody("receive upload body");
    } finally {
      await lease.close();
    }
  });
});
