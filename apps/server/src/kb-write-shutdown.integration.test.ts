import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireBuiltArtifact } from "../../../packages/test-utils/src/kb/build-artifacts.mjs";

vi.mock("@knowledge-base/api/lib/kb/recovery", () => ({
  kbRecoveryGateOpen: () => true,
}));

import {
  openKbPostgresClusterFromEnv,
  processIsAlive,
} from "../../../packages/test-utils/src/kb/index.js";

const root = resolve(import.meta.dirname, "../../..");
const native = join(root, "apps/server/native");
const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();

beforeAll(async () => {
  requireBuiltArtifact(join(native, "kb-supervisor"), "pnpm test:kb --build-only locks");
  await db.query("applier", "CREATE TABLE shutdown_reservations (id text PRIMARY KEY)");
  await db.query("applier", "CREATE TABLE shutdown_finalizations (id text PRIMARY KEY)");
});
afterAll(async () => {
  await db.close();
  await cluster.close();
});

// Runs real coordinator, pinned sessions, capability issuer, FenceClient and C
// supervisor. No stdin, live app dependencies, or substituted process/PG I/O.
function fixtureSource(): string {
  const coordinator = pathToFileURL(join(root, "apps/server/src/kb-write-coordinator.ts")).href;
  const fence = pathToFileURL(join(root, "apps/server/src/kb-process.ts")).href;
  const recovery = pathToFileURL(join(root, "packages/api/src/lib/kb/recovery.ts")).href;
  const pg = pathToFileURL(join(root, "node_modules/pg/lib/index.js")).href;
  return `
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import pg from ${JSON.stringify(pg)};
import { createKbWriteCoordinator } from ${JSON.stringify(coordinator)};
import { pingProcessFence, MSG } from ${JSON.stringify(fence)};
import { setKbRecoveryComplete } from ${JSON.stringify(recovery)};
const mode = process.env.KB_TEST_SHUTDOWN_MODE;
const dir = process.env.KB_DATA_ROOT + "/repos";
const mark = (name, value = "ready") => writeFileSync(dir + "/" + name, value);
const signalled = Promise.withResolvers();
await pingProcessFence();
// This fixture has only shutdown metadata tables, no KB repositories to recover.
// Vitest's parent-process mock does not establish readiness in this real child.
setKbRecoveryComplete(true);
const coord = createKbWriteCoordinator({
  connectionString: process.env.KB_TEST_DATABASE_URL,
  ...(mode === "deadline" ? { mutationDeadlineMs: 2000 } : {}),
});
let operation;
if (mode === "teardown") {
  const unlocked = Promise.withResolvers();
  const acknowledge = Promise.withResolvers();
  const query = pg.Client.prototype.query;
  // Execute real SQL, then hold only delivery of the predecessor's unlock ack.
  pg.Client.prototype.query = async function(...args) {
    const result = await query.apply(this, args);
    if (args[0] === "SELECT pg_advisory_unlock_all()" &&
        this.connectionParameters.application_name === "kb-op-teardown") {
      unlocked.resolve();
      await acknowledge.promise;
    }
    return result;
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const arrived = async name => {
    const deadline = Date.now() + 10000;
    while (!existsSync(dir + "/" + name)) {
      assert(Date.now() < deadline, "missing marker " + name);
      await delay(10);
    }
  };
  let retained, capability, oldPid;
  const first = coord.run({
    opId: mode, kind: "git-write", kbIds: [mode],
    barrier: {
      reauthorize: async () => {},
      reservePublication: async ({ query }) => query("INSERT INTO shutdown_reservations VALUES ($1)", [mode]),
    },
    run: async ctx => {
      retained = ctx;
      capability = ctx.issueWriteCapability(mode);
      const child = await ctx.spawnMutatingChild({
        capability, cwd: dir,
        argv: [process.execPath, "-e", "const fs = require('fs'); process.on('SIGTERM', () => fs.writeFileSync(process.env.OUT + '/draining', 'yes')); fs.writeFileSync(process.env.OUT + '/child_ready', String(process.pid)); setInterval(() => {}, 1000)"],
        env: { OUT: dir },
      });
      oldPid = child.pid;
      mark("child_pid", String(oldPid));
      await arrived("child_ready");
      mark("reserved");
      return "success";
    },
  });
  const rejectLateWork = async () => {
    assert.throws(() => retained.issueWriteCapability(mode), { code: "ADMISSION_CLOSED" });
    await assert.rejects(retained.spawnMutatingChild({
      capability, cwd: dir,
      argv: [process.execPath, "-e", "require('fs').writeFileSync(process.env.OUT, 'unsafe'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      env: { OUT: dir + "/unsafe" },
    }), { code: "ADMISSION_CLOSED" });
  };
  await arrived("draining");
  // The lease is still open here: only the operation admission guard can reject.
  retained.lease.assertOpen();
  assert(alive(oldPid));
  await rejectLateWork();
  mark("drain_rejected");
  await unlocked.promise;
  assert(!alive(oldPid));
  await rejectLateWork();
  assert.throws(() => retained.lease.assertHeldKb(mode), { code: "NOT_HELD" });
  await assert.rejects(retained.lease.query("SELECT 1"), { code: "NOT_HELD" });
  await assert.rejects(retained.lease.acquire([{ kind: "kb", kbId: "z" }]), { code: "NOT_HELD" });
  await assert.rejects(retained.lease.transaction(async () => {}), { code: "NOT_HELD" });
  await assert.rejects(retained.lease.releaseAuthority(), { code: "NOT_HELD" });
  mark("unlock_rejected");
  const successor = coord.run({
    opId: "teardown_successor", kind: "git-write", kbIds: [mode],
    run: async () => { assert(!alive(oldPid)); assert(!existsSync(dir + "/unsafe")); mark("successor"); },
  });
  acknowledge.resolve();
  assert.equal(await first, "success");
  await successor;
  await rejectLateWork();
  pg.Client.prototype.query = query;
  await coord.shutdown();
  mark("shutdown_done");
  process.exit(0);
}
process.on("SIGTERM", () => {
  if (mode === "lost_ack") return;
  mark("signalled");
  const stopping = coord.shutdown(); // closes operation admission synchronously
  signalled.resolve();
  void (async () => {
    try {
      await coord.run({ opId: "new_operation", kind: "git-write", kbIds: [mode], run: async () => mark("unsafe") });
      throw new Error("admitted during shutdown");
    } catch (error) {
      if (error.code !== "ADMISSION_CLOSED") throw error;
    }
    await stopping;
    await operation;
    mark("shutdown_done");
    process.exit(0);
  })().catch(() => process.exit(1));
});

if (mode === "lost_ack") {
  // Drop the actual SPAWNED frame before FenceClient sees it. Wait until the
  // child ignores TERM, then sever the real channel: teardown takes 5s and
  // cannot possibly be mistaken for a completed drain.
  const emit = net.Socket.prototype.emit;
  let droppedSocket;
  net.Socket.prototype.emit = function(event, ...args) {
    if (event === "data" && (this === droppedSocket || (!droppedSocket && Buffer.isBuffer(args[0]) && args[0][4] === MSG.SPAWNED))) {
      if (!droppedSocket) {
        droppedSocket = this;
        void (async () => {
          while (!existsSync(dir + "/child_ready")) await delay(10);
          this.destroy();
        })();
      }
      return true;
    }
    return emit.call(this, event, ...args);
  };
}

operation = coord.run({
  opId: mode, kind: "git-write", kbIds: [mode],
  barrier: {
    reauthorize: async () => {},
    reservePublication: async ({ query }) => {
      await query("INSERT INTO shutdown_reservations VALUES ($1)", [mode]);
    },
  },
  run: async (ctx) => {
    mark("reserved");
    if (mode !== "lost_ack") await signalled.promise;
    if (mode === "success") await delay(6500, undefined, { signal: ctx.signal });
    const code = mode === "success"
      ? "require('fs').writeFileSync(process.env.OUT, 'published')"
      : "process.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.OUT, String(process.pid)); setInterval(() => {}, 1000)";
    const child = await ctx.spawnMutatingChild({
      capability: ctx.issueWriteCapability(mode), cwd: dir,
      argv: [process.execPath, "-e", code],
      env: { OUT: dir + (mode === "success" ? "/published" : "/child_ready") },
    });
    mark("child_pid", String(child.pid));
    const exit = await ctx.waitChild(child.pid);
    ctx.signal.throwIfAborted();
    if (exit.status !== 0) throw new Error("child failed");
    await ctx.lease.transaction(async (query) => {
      await query("SELECT pg_sleep(0.05)");
      await query("INSERT INTO shutdown_finalizations VALUES ($1)", [mode]);
    });
    await delay(100, undefined, { signal: ctx.signal });
    mark("response_staged");
    return "success";
  },
}).then(
  result => mark("outcome", result),
  async error => {
    mark("outcome", error.code ?? "unexpected");
    if (mode === "lost_ack") {
      try {
        await coord.run({ opId: "successor", kind: "git-write", kbIds: [mode], run: async () => mark("unsafe") });
      } catch (next) { mark("successor_error", next.code); }
      try { await coord.shutdown(); mark("unsafe_shutdown"); }
      catch { mark("unclean_shutdown"); }
      // Keep Node alive for the real supervisor to force-drain and reap.
      setInterval(() => {}, 1000);
    }
  },
);
`;
}

describe("committed writes across the real supervisor process boundary", () => {
  it.each(["success", "deadline", "lost_ack", "teardown"])(
    "handles %s without early admission or false drain success",
    async (mode) => {
      const dataRoot = mkdtempSync(join(tmpdir(), "kb-write-shutdown-"));
      const dir = join(dataRoot, "repos");
      mkdirSync(join(dir, ".private"), { recursive: true });
      writeFileSync(join(dir, ".private/server.fence"), "");
      const fixture = join(dir, "fixture.mts");
      writeFileSync(fixture, fixtureSource());
      const child = spawn(
        join(native, "kb-supervisor"),
        ["--", process.execPath, "--import", "tsx", fixture],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            KB_DATA_ROOT: dataRoot,
            KB_TEST_DATABASE_URL: db.urls.applier,
            KB_TEST_SHUTDOWN_MODE: mode,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<number | null>((done) => child.once("exit", done));
      const marker = (name: string) => join(dir, name);
      const arrived = async (name: string) => {
        await expect
          .poll(
            () => {
              if (child.exitCode !== null && !existsSync(marker(name)))
                throw new Error(`Supervisor exited: ${stderr}`);
              return existsSync(marker(name));
            },
            { timeout: 15_000, interval: 20 },
          )
          .toBe(true);
      };
      try {
        await arrived("reserved");
        expect(
          (await db.query("applier", "SELECT id FROM shutdown_reservations WHERE id = $1", [mode]))
            .rows,
        ).toHaveLength(1);
        if (mode !== "lost_ack" && mode !== "teardown") child.kill("SIGTERM");
        if (mode === "teardown") {
          await arrived("shutdown_done");
          expect(await exited, stderr).toBe(0);
          for (const name of ["drain_rejected", "unlock_rejected", "successor"]) {
            expect(existsSync(marker(name))).toBe(true);
          }
        } else if (mode === "lost_ack") {
          await arrived("unclean_shutdown");
          expect(readFileSync(marker("outcome"), "utf8")).toBe("CONNECTION_LOST");
          expect(readFileSync(marker("successor_error"), "utf8")).toBe("ADMISSION_CLOSED");
          expect(existsSync(marker("unsafe_shutdown"))).toBe(false);
          expect(processIsAlive(Number(readFileSync(marker("child_ready"), "utf8")))).toBe(true);
          expect(await exited).not.toBe(0);
        } else {
          await arrived("shutdown_done");
          expect(await exited, stderr).toBe(0);
          expect(readFileSync(marker("outcome"), "utf8")).toBe(
            mode === "success" ? "success" : "DEADLINE_EXCEEDED",
          );
          expect(existsSync(marker("published"))).toBe(mode === "success");
          expect(existsSync(marker("response_staged"))).toBe(mode === "success");
        }
        expect(existsSync(marker("unsafe"))).toBe(false);
        const pidFile = marker(mode === "lost_ack" ? "child_ready" : "child_pid");
        expect(processIsAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
        expect(
          (await db.query("applier", "SELECT id FROM shutdown_finalizations WHERE id = $1", [mode]))
            .rows,
        ).toHaveLength(mode === "success" ? 1 : 0);
      } finally {
        // A failed assertion uses control/process failure teardown, never leaves a
        // server behind or releases its fence while its descendants still live.
        if (child.exitCode === null) {
          child.kill("SIGHUP");
          // Force only this fixture's direct children; keep the supervisor alive
          // to drain/reap their descendants before it releases the volume fence.
          try {
            const pids = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8");
            for (const pid of pids.trim().split(/\s+/).map(Number)) {
              if (pid > 0) {
                try {
                  process.kill(pid, "SIGKILL");
                } catch {
                  /* already exited */
                }
              }
            }
          } catch {
            /* supervisor may already have exited */
          }
        }
        await exited;
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
