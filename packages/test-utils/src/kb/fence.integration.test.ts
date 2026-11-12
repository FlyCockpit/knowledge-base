import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it as registerTest } from "vitest";
import { buildArtifactPath, requireBuiltArtifact } from "./build-artifacts.mjs";
import {
  dockerFixtureLabels,
  drainDockerFixtures,
  removeDockerContainer,
  withDockerContainer,
} from "./docker.js";
import { NODE_BASE_IMAGE } from "./node-image.mjs";
import { drainProcessFixtures, ownProcess } from "./process.js";

afterEach(drainDockerFixtures, 300_000);

const ROOT = resolve(import.meta.dirname, "../../../..");
const NATIVE = join(ROOT, "apps/server/native");
const SUPERVISOR = join(NATIVE, "kb-supervisor");
const IMAGE = NODE_BASE_IMAGE;

const dirs: string[] = [];
const pendingActions = new Set<Promise<void>>();
function it(name: string, run: () => void | Promise<void>, timeout?: number): void {
  registerTest(
    name,
    () => {
      const action = Promise.resolve().then(run);
      const settled = action
        .then(
          () => {},
          () => {},
        )
        .finally(() => pendingActions.delete(settled));
      pendingActions.add(settled);
      return action;
    },
    timeout,
  );
}
const processes = new Map<number, Awaited<ReturnType<typeof ownProcess>>>();
const containers: string[] = [];
async function registerPid(pid: number, repos: string): Promise<void> {
  const owner = await ownProcess(pid, undefined, repos);
  if (!owner) return;
  processes.set(pid, owner);
  void owner.done
    .finally(() => {
      if (processes.get(pid) === owner) processes.delete(pid);
    })
    .catch(() => {});
}
async function killPid(pid: number): Promise<void> {
  const owner = processes.get(pid);
  processes.delete(pid);
  await owner?.kill();
}

afterEach(async () => {
  while (pendingActions.size) await Promise.all([...pendingActions]);
  await drainProcessFixtures();
  processes.clear();
  const removals = await Promise.allSettled(containers.splice(0).map(removeDockerContainer));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const result of removals) if (result.status === "rejected") throw result.reason;
}, 180_000);

function docker(
  args: string[],
  options?: { reject?: boolean },
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    if (options?.reject === false) {
      return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
    throw error;
  }
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** `<data root>/repos`: the supervisor derives it from KB_DATA_ROOT (dirname). */
function prepareRepos(): string {
  const root = join(tmp("kb-fence-data-"), "repos");
  mkdirSync(join(root, ".private"), { recursive: true });
  writeFileSync(join(root, ".private/server.fence"), "");
  writeFileSync(join(root, "readable.txt"), "ok");
  return root;
}

function requireSupervisor(): void {
  requireBuiltArtifact(SUPERVISOR, "pnpm test:kb --build-only fence");
}

function containerSupervisor(): string {
  return requireBuiltArtifact(
    buildArtifactPath("static-supervisor"),
    "pnpm test:kb --build-only fence",
  );
}

function writeFixture(dir: string): string {
  const path = join(dir, "fence-fixture.mjs");
  writeFileSync(
    path,
    `import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";

const MAX = 65536;
const MSG = { SPAWN:1, DRAIN:2, CLOSE:3, PING:4, SPAWNED:101, EXITED:102, ERR:103, PONG:104 };
function u16(n){ return Buffer.from([(n>>8)&255, n&255]); }
function u32(n){ return Buffer.from([(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255]); }
function str(s){ const b=Buffer.from(String(s)); return Buffer.concat([u16(b.length), b]); }
function frame(type, payload=Buffer.alloc(0)){
  const len = payload.length+1;
  const hdr = Buffer.alloc(5);
  hdr.writeUInt32BE(len,0); hdr[4]=type;
  return Buffer.concat([hdr, payload]);
}
function sockPath(addr){ return addr.startsWith("@") ? "\\0"+addr.slice(1) : addr; }
function encodeSpawn(opId, cwd, argv, env){
  const parts = [str(opId), str(cwd), u16(argv.length)];
  for (const a of argv) parts.push(str(a));
  const keys = Object.keys(env);
  parts.push(u16(keys.length));
  for (const k of keys) { parts.push(str(k), str(env[k])); }
  return frame(MSG.SPAWN, Buffer.concat(parts));
}
function encodeDrain(opId, pid){ return frame(MSG.DRAIN, Buffer.concat([str(opId), u32(pid>>>0)])); }

const addr = process.env.KB_SUPERVISOR_SOCK;
const fenceFd = Number(process.env.KB_FENCE_FD);
if (!addr) { process.stderr.write("missing sock\\n"); process.exit(2); }
fs.fstatSync(fenceFd);
const socket = net.connect({ path: sockPath(addr) });
let buf = Buffer.alloc(0);
const waiters = new Map();
socket.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0);
    if (len < 1 || len > MAX || buf.length < 4+len) break;
    const type = buf[4];
    const payload = buf.subarray(5, 4+len);
    buf = buf.subarray(4+len);
    if (type === MSG.PONG) waiters.get("ping")?.({ type });
    if (type === MSG.SPAWNED) {
      const n = payload.readUInt16BE(0);
      const opId = payload.subarray(2, 2+n).toString();
      const pid = payload.readUInt32BE(2+n);
      fs.writeSync(1, "SPAWNED "+opId+" "+pid+"\\n");
      waiters.get("spawn:"+opId)?.({ opId, pid });
    }
    if (type === MSG.EXITED) {
      const n = payload.readUInt16BE(0);
      const opId = payload.subarray(2, 2+n).toString();
      const pid = payload.readUInt32BE(2+n);
      const status = payload.readInt32BE(6+n);
      fs.writeSync(1, "EXITED "+opId+" "+pid+" "+status+"\\n");
      waiters.get("exit:"+pid)?.({ opId, pid, status });
    }
    if (type === MSG.ERR) {
      const n = payload.readUInt16BE(0);
      const opId = payload.subarray(2, 2+n).toString();
      const code = payload.readUInt32BE(2+n);
      const mn = payload.readUInt16BE(6+n);
      const message = payload.subarray(8+n, 8+n+mn).toString();
      fs.writeSync(1, "ERR "+opId+" "+code+" "+message+"\\n");
      waiters.get("spawn:"+opId)?.({ error: message });
    }
  }
});
function once(key, ms=15000){ return new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout "+key)), ms);
  waiters.set(key, (v) => { clearTimeout(t); waiters.delete(key); resolve(v); });
}); }
await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
socket.write(frame(MSG.PING));
await once("ping");
fs.writeSync(1, "READY "+process.pid+" "+process.ppid+"\\n");
const envBase = { PATH: process.env.PATH || "/usr/bin:/bin" };
const cwd = process.env.KB_DATA_ROOT + "/repos";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const parts = line.trim().split(" ");
  const cmd = parts[0];
  if (cmd === "SPAWN_PAUSE") {
    const opId = parts[1];
    const ready = parts[2];
    const child = [process.execPath, "-e",
      "require('fs').writeFileSync(process.env.CHILD_READY,'ready'); setInterval(()=>{}, 1000);"];
    socket.write(encodeSpawn(opId, cwd, child, { ...envBase, CHILD_READY: ready }));
    await once("spawn:"+opId);
  } else if (cmd === "SPAWN_IGNORE_TERM") {
    const opId = parts[1];
    const ready = parts[2];
    const leak = parts[3];
    const child = [process.execPath, "-e",
      "process.on('SIGTERM',()=>{}); require('fs').writeFileSync(process.env.CHILD_READY,'ready'); setTimeout(()=>{ require('fs').writeFileSync(process.env.LEAK_PATH,'leaked'); process.exit(0); }, 20000); setInterval(()=>{},1000);"];
    socket.write(encodeSpawn(opId, cwd, child, { ...envBase, CHILD_READY: ready, LEAK_PATH: leak }));
    await once("spawn:"+opId);
  } else if (cmd === "SPAWN_QUICK") {
    const opId = parts[1];
    const out = parts[2];
    const child = [process.execPath, "-e", "setTimeout(()=>require('fs').writeFileSync(process.env.OUT, process.env.MARK), 200);"];
    socket.write(encodeSpawn(opId, cwd, child, { ...envBase, OUT: out, MARK: opId }));
    await once("spawn:"+opId);
  } else if (cmd === "SPAWN_READ") {
    const opId = parts[1];
    const file = parts[2];
    const out = parts[3];
    const child = [process.execPath, "-e",
      "require('fs').writeFileSync(process.env.OUT, require('fs').readFileSync(process.env.IN,'utf8'));"];
    socket.write(encodeSpawn(opId, cwd, child, { ...envBase, IN: file, OUT: out }));
    const spawned = await once("spawn:"+opId);
    if (spawned.pid) await once("exit:"+spawned.pid);
  } else if (cmd === "SPAWN_BIN") {
    const opId = parts[1];
    const bin = parts[2];
    socket.write(encodeSpawn(opId, cwd, [bin], envBase));
    await once("spawn:"+opId);
  } else if (cmd === "SPAWN_FORK_IGNORE_TERM") {
    const opId = parts[1];
    const bin = parts[2];
    const ready = parts[3];
    const leak = parts[4];
    socket.write(encodeSpawn(opId, cwd, [bin], { ...envBase, CHILD_READY: ready, LEAK_PATH: leak }));
    await once("spawn:"+opId);
  } else if (cmd === "SPAWN_STEAL") {
    const opId = parts[1];
    const out = parts[2];
    const child = [process.execPath, "-e",
      "const net=require('net');const fs=require('fs');const path=String.fromCharCode(0)+('kb-sup-'+process.ppid);const s=net.connect({path});const ping=Buffer.alloc(5);ping.writeUInt32BE(1,0);ping[4]=4;let got='closed';const t=setTimeout(()=>{try{fs.writeFileSync(process.env.OUT,got);}catch(e){}process.exit(0);},800);s.on('connect',()=>s.write(ping));s.on('data',()=>{got='pong';clearTimeout(t);fs.writeFileSync(process.env.OUT,got);process.exit(0);});s.on('error',()=>{got='error';clearTimeout(t);try{fs.writeFileSync(process.env.OUT,got);}catch(e){}process.exit(0);});"];
    socket.write(encodeSpawn(opId, cwd, child, { ...envBase, OUT: out }));
    const spawned = await once("spawn:"+opId);
    if (spawned.pid) await once("exit:"+spawned.pid, 5000);
  } else if (cmd === "ADOPT_SLEEP") {
    const child = spawnChild("sleep", ["15"], { stdio: "ignore" });
    fs.writeSync(1, "ADOPTED "+child.pid+"\\n");
  } else if (cmd === "PING") {
    socket.write(frame(MSG.PING));
    await once("ping");
    fs.writeSync(1, "PONG\\n");
  } else if (cmd === "DRAIN") {
    const opId = parts[1];
    const pid = Number(parts[2]);
    socket.write(encodeDrain(opId, pid));
    await once("exit:"+pid, 12000);
  } else if (cmd === "CLOSE") {
    socket.write(frame(MSG.CLOSE));
    fs.writeSync(1, "CLOSED\\n");
  } else if (cmd === "QUIT") {
    break;
  }
}
process.exit(0);
`,
  );
  return path;
}

type Session = {
  child: ChildProcess;
  repos: string;
  send: (line: string) => void;
  wait: (re: RegExp, ms?: number) => Promise<RegExpMatchArray>;
  nodePid: number;
  supervisorPid: number;
};

async function startSupervised(repos: string, nodeArgv: string[]): Promise<Session> {
  const child = spawn(SUPERVISOR, ["--", ...nodeArgv], {
    cwd: repos,
    env: { ...process.env, KB_DATA_ROOT: dirname(repos) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid == null) throw new Error("failed to start supervisor");
  await registerPid(child.pid, repos);
  const lines: string[] = [];
  const waiters: Array<{ re: RegExp; resolve: (m: RegExpMatchArray) => void }> = [];
  const onLine = (line: string) => {
    lines.push(line);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (!waiter) continue;
      const match = line.match(waiter.re);
      if (match) {
        waiters.splice(i, 1);
        waiter.resolve(match);
      }
    }
  };
  if (child.stdout) createInterface({ input: child.stdout }).on("line", onLine);
  if (child.stderr) createInterface({ input: child.stderr }).on("line", onLine);
  const wait = (re: RegExp, ms = 10_000) =>
    new Promise<RegExpMatchArray>((resolveWait, reject) => {
      for (const line of lines) {
        const match = line.match(re);
        if (match) {
          resolveWait(match);
          return;
        }
      }
      const timer = setTimeout(
        () => reject(new Error(`timeout ${re} in ${lines.join(" | ")}`)),
        ms,
      );
      waiters.push({
        re,
        resolve: (match) => {
          clearTimeout(timer);
          resolveWait(match);
        },
      });
    });
  const ready = await wait(/^READY (\d+) (\d+)$/);
  const nodePid = Number(ready[1]);
  const supervisorPid = Number(ready[2]);
  await registerPid(nodePid, repos);
  return {
    child,
    repos,
    send: (line: string) => child.stdin?.write(`${line}\n`),
    wait,
    nodePid,
    supervisorPid,
  };
}

async function startSession(repos: string, fixture: string): Promise<Session> {
  return startSupervised(repos, [process.execPath, fixture]);
}

function childrenOf(pid: number): number[] {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (!text) return [];
    return text
      .split(/\s+/)
      .map(Number)
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

function sigBlkHasTerm(pid: number): boolean {
  const text = readFileSync(`/proc/${pid}/status`, "utf8");
  const line = text.split("\n").find((entry) => entry.startsWith("SigBlk:"));
  if (!line) throw new Error(`SigBlk missing for ${pid}`);
  const mask = BigInt(`0x${line.split(":")[1]?.trim() ?? "0"}`);
  return (mask & (1n << 14n)) !== 0n;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireOrFail(repos: string): Promise<{ status: number; stderr: string }> {
  const result = spawn(
    SUPERVISOR,
    ["--", process.execPath, "-e", "setTimeout(()=>process.exit(0), 40)"],
    {
      cwd: repos,
      env: { ...process.env, KB_DATA_ROOT: dirname(repos) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderrChunks: Buffer[] = [];
  result.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const exited = new Promise<number>((resolvePromise) => {
    result.on("exit", (code) => resolvePromise(code ?? 1));
  });
  if (result.pid) await registerPid(result.pid, repos);
  const status = await exited;
  return { status, stderr: Buffer.concat(stderrChunks).toString("utf8") };
}

async function waitFile(path: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (existsSync(path)) return;
    await delay(40);
  }
  throw new Error(`missing ${path}`);
}

async function waitAlive(pid: number, alive: boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const isAlive = (() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    if (isAlive === alive) return;
    await delay(40);
  }
  throw new Error(`pid ${pid} alive=${alive} not reached`);
}

function fenceStat(repos: string): { ino: number; dev: number } {
  const st = statSync(join(repos, ".private/server.fence"));
  return { ino: st.ino, dev: st.dev };
}

describe("kernel fence and descendant supervision", () => {
  it("signals a live owned process and retires an exited handle without touching a successor", async () => {
    const spawnHeld = () =>
      spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const old = spawnHeld();
    const oldExit = new Promise<void>((resolve) => old.once("close", () => resolve()));
    const successor = spawnHeld();
    const successorExit = new Promise<void>((resolve) => successor.once("close", () => resolve()));
    try {
      const owner = await ownProcess(old.pid!);
      expect(owner).toBeDefined();
      await owner!.kill();
      await oldExit;
      expect(old.signalCode).toBe("SIGKILL");
      // Reusing a completed ownership record cannot issue a numeric PID kill.
      await owner!.kill();
      // Safe substitution at acquisition: a different identity is refused.
      expect(await ownProcess(successor.pid!, "0")).toBeUndefined();
      expect(
        await ownProcess(successor.pid!, undefined, join(ROOT, "unowned-root")),
      ).toBeUndefined();
      await drainProcessFixtures();
      expect(successor.exitCode).toBeNull();
      expect(successor.signalCode).toBeNull();
      expect(isAlive(successor.pid!)).toBe(true);
    } finally {
      if (old.exitCode === null && old.signalCode === null) old.kill("SIGKILL");
      if (successor.exitCode === null && successor.signalCode === null) successor.kill("SIGKILL");
      await Promise.all([oldExit, successorExit]);
    }
  });

  it("requires the prebuilt supervisor and warnings-as-errors compiler policy", () => {
    requireSupervisor();
    expect(readFileSync(join(NATIVE, "Makefile"), "utf8")).toMatch(/-Werror/);
  });

  it("blocks a second writer while a paused grandchild holds the volume fence", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const readyPath = join(repos, "child.ready");
    const a = await startSession(repos, fixture);
    a.send(`SPAWN_PAUSE op_a ${readyPath}`);
    const spawned = await a.wait(/^SPAWNED op_a (\d+)$/);
    await registerPid(Number(spawned[1]), repos);
    await waitFile(readyPath);
    const b = await acquireOrFail(repos);
    // A held fence is its own typed record and exit status, not free text.
    expect(b.status).toBe(85);
    expect(
      b.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        level: "error",
        site: "supervisor.fatal",
        message: "native supervisor could not start",
        reason: "FENCE_HELD",
        exitCode: 85,
      },
    ]);
    expect(readFileSync(join(repos, "readable.txt"), "utf8")).toBe("ok");
  }, 30_000);

  it("drains descendants after Node exits before a replacement can acquire", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const readyPath = join(repos, "child.ready");
    const leakPath = join(repos, "leaked");
    const a = await startSession(repos, fixture);
    a.send(`SPAWN_IGNORE_TERM op_term ${readyPath} ${leakPath}`);
    const spawned = await a.wait(/^SPAWNED op_term (\d+)$/);
    const childPid = Number(spawned[1]);
    await registerPid(childPid, repos);
    await waitFile(readyPath);
    a.send("QUIT");
    await waitAlive(a.supervisorPid, false, 15_000);
    await waitAlive(childPid, false, 15_000);
    expect(existsSync(leakPath)).toBe(false);
    const b = await acquireOrFail(repos);
    expect(b.status).toBe(0);
  }, 30_000);

  it("KILLs a TERM-immune child, reaps it, and drops a delayed write", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const readyPath = join(repos, "child.ready");
    const leakPath = join(repos, "leaked");
    const a = await startSession(repos, fixture);
    a.send(`SPAWN_IGNORE_TERM op_kill ${readyPath} ${leakPath}`);
    const spawned = await a.wait(/^SPAWNED op_kill (\d+)$/);
    const childPid = Number(spawned[1]);
    await registerPid(childPid, repos);
    await waitFile(readyPath);
    a.send(`DRAIN op_kill ${childPid}`);
    const exited = await a.wait(/^EXITED op_kill (\d+) (\d+)$/, 12_000);
    expect(Number(exited[1])).toBe(childPid);
    expect(Number(exited[2])).toBe(128 + 9);
    await waitAlive(childPid, false, 2_000);
    expect(existsSync(leakPath)).toBe(false);
  }, 30_000);

  it("KILLs a TERM-immune grandchild after the group leader exits, then reports EXITED", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const bin = requireBuiltArtifact(
      buildArtifactPath("fork-ignore-child"),
      "pnpm test:kb --build-only fence",
    );
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const readyPath = join(repos, "child.ready");
    const leakPath = join(repos, "leaked");
    const a = await startSession(repos, fixture);
    a.send(`SPAWN_FORK_IGNORE_TERM op_grp ${bin} ${readyPath} ${leakPath}`);
    const spawned = await a.wait(/^SPAWNED op_grp (\d+)$/);
    const leaderPid = Number(spawned[1]);
    await registerPid(leaderPid, repos);
    await waitFile(readyPath);
    const grands = childrenOf(leaderPid);
    expect(grands.length).toBeGreaterThan(0);
    for (const grand of grands) await registerPid(grand, repos);
    const started = Date.now();
    a.send(`DRAIN op_grp ${leaderPid}`);
    const exited = await a.wait(/^EXITED op_grp (\d+) (\d+)$/, 12_000);
    expect(Number(exited[1])).toBe(leaderPid);
    expect(Number(exited[2])).toBe(128 + 15);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    await waitAlive(leaderPid, false, 2_000);
    for (const grand of grands) {
      await waitAlive(grand, false, 2_000);
    }
    expect(existsSync(leakPath)).toBe(false);
  }, 30_000);

  it("keeps the flock until a descendant holding the descriptor exits", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const readyPath = join(repos, "child.ready");
    const a = await startSession(repos, fixture);
    a.send(`SPAWN_PAUSE op_hold ${readyPath}`);
    const spawned = await a.wait(/^SPAWNED op_hold (\d+)$/);
    const childPid = Number(spawned[1]);
    await registerPid(childPid, repos);
    await waitFile(readyPath);
    await killPid(a.supervisorPid);
    await killPid(a.nodePid);
    await waitAlive(a.supervisorPid, false, 5_000);
    await waitAlive(childPid, true, 2_000);
    const blocked = await acquireOrFail(repos);
    expect(blocked.status).not.toBe(0);
    await killPid(childPid);
    await waitAlive(childPid, false, 5_000);
    const b = await acquireOrFail(repos);
    expect(b.status).toBe(0);
  }, 30_000);

  it("allows concurrent operations in one server and still excludes a second instance", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const a = await startSession(repos, fixture);
    const one = join(repos, "one.txt");
    const two = join(repos, "two.txt");
    const readOut = join(repos, "read-out.txt");
    a.send(`SPAWN_QUICK op_one ${one}`);
    a.send(`SPAWN_QUICK op_two ${two}`);
    await a.wait(/^SPAWNED op_one /);
    await a.wait(/^SPAWNED op_two /);
    await a.wait(/^EXITED op_one /);
    await a.wait(/^EXITED op_two /);
    expect(readFileSync(one, "utf8")).toBe("op_one");
    expect(readFileSync(two, "utf8")).toBe("op_two");
    a.send(`SPAWN_READ op_read ${join(repos, "readable.txt")} ${readOut}`);
    await a.wait(/^EXITED op_read /);
    expect(readFileSync(readOut, "utf8")).toBe("ok");
    const blocked = await acquireOrFail(repos);
    expect(blocked.status).not.toBe(0);
    a.send("QUIT");
    await waitAlive(a.supervisorPid, false, 10_000);
    const b = await acquireOrFail(repos);
    expect(b.status).toBe(0);
  }, 30_000);

  it("image smoke runs the supervisor as the configured UID and keeps the lock inode", async () => {
    requireSupervisor();
    const binary = containerSupervisor();
    const repos = prepareRepos();
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const before = fenceStat(repos);
    const run = (args: string[]) => {
      const name = `kb-fence-smoke-${randomUUID()}`;
      return withDockerContainer(name, () =>
        docker([
          "run",
          "--name",
          name,
          ...dockerFixtureLabels(),
          "--rm",
          "--user",
          user,
          "-v",
          `${binary}:/usr/local/bin/kb-supervisor:ro`,
          "-v",
          `${repos}:/var/lib/knowledge-base/repos`,
          "-e",
          "KB_DATA_ROOT=/var/lib/knowledge-base",
          IMAGE,
          ...args,
        ]),
      );
    };
    const present = await run(["sh", "-c", "test -x /usr/local/bin/kb-supervisor && id -u"]);
    expect(present.status).toBe(0);
    expect(present.stdout.trim()).toBe(String(process.getuid?.() ?? 1000));
    const first = await run([
      "/usr/local/bin/kb-supervisor",
      "--",
      "node",
      "-e",
      "setTimeout(()=>process.exit(0), 80)",
    ]);
    expect(first.status).toBe(0);
    const afterFirst = fenceStat(repos);
    expect(afterFirst.ino).toBe(before.ino);
    expect(afterFirst.dev).toBe(before.dev);
    const second = await run([
      "/usr/local/bin/kb-supervisor",
      "--",
      "node",
      "-e",
      "setTimeout(()=>process.exit(0), 80)",
    ]);
    expect(second.status).toBe(0);
    expect(fenceStat(repos).ino).toBe(before.ino);
    expect(existsSync(join(repos, ".private/server.fence"))).toBe(true);
  }, 60_000);

  it("container teardown after supervisor SIGKILL leaves no old writer", async () => {
    requireSupervisor();
    const binary = containerSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const readyPath = join(repos, "child.ready");
    const leakPath = join(repos, "leaked");
    const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const name = `kb-fence-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    containers.push(name);
    docker([
      "run",
      "-d",
      "-i",
      "--init",
      "--name",
      name,
      ...dockerFixtureLabels(),
      "--user",
      user,
      "-v",
      `${binary}:/usr/local/bin/kb-supervisor:ro`,
      "-v",
      `${repos}:/var/lib/knowledge-base/repos`,
      "-v",
      `${fixture}:/fixture.mjs:ro`,
      "-e",
      "KB_DATA_ROOT=/var/lib/knowledge-base",
      IMAGE,
      "/usr/local/bin/kb-supervisor",
      "--",
      "node",
      "/fixture.mjs",
    ]);
    const started = Date.now();
    let logs = "";
    while (Date.now() - started < 15_000) {
      logs = docker(["logs", name], { reject: false }).stdout;
      if (/READY /.test(logs)) break;
      await delay(100);
    }
    expect(logs).toMatch(/READY /);
    const pidsOut = docker([
      "exec",
      name,
      "node",
      "-e",
      "const fs=require('fs');console.log(fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)).join(' '));",
    ]).stdout.trim();
    let nodePid = "";
    for (const pid of pidsOut.split(/\s+/)) {
      const cmd = docker(
        ["exec", name, "sh", "-c", `tr '\\0' ' ' < /proc/${pid}/cmdline || true`],
        {
          reject: false,
        },
      ).stdout;
      if (cmd.includes("fixture.mjs") && !cmd.includes("kb-supervisor")) {
        nodePid = pid;
        break;
      }
    }
    expect(nodePid).not.toBe("");
    docker([
      "exec",
      name,
      "sh",
      "-c",
      `echo SPAWN_IGNORE_TERM op_ct /var/lib/knowledge-base/repos/child.ready /var/lib/knowledge-base/repos/leaked > /proc/${nodePid}/fd/0`,
    ]);
    await waitFile(readyPath, 8_000);
    const supervisorPid = logs
      .split("\n")
      .find((line) => line.startsWith("READY "))
      ?.split(" ")[2];
    expect(supervisorPid).toBeTruthy();
    docker(["exec", name, "kill", "-9", String(supervisorPid)], { reject: false });
    const blocked = await acquireOrFail(repos);
    expect(blocked.status).not.toBe(0);
    docker(["rm", "-f", name]);
    const idx = containers.indexOf(name);
    if (idx >= 0) containers.splice(idx, 1);
    const after = Date.now();
    while (Date.now() - after < 8_000) {
      const b = await acquireOrFail(repos);
      if (b.status === 0) {
        expect(existsSync(leakPath)).toBe(false);
        return;
      }
      await delay(100);
    }
    throw new Error("replacement writer did not acquire after container teardown");
  }, 60_000);

  it("delivers SIGTERM to a child that does not reset its signal mask", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const bin = requireBuiltArtifact(
      buildArtifactPath("pause-child"),
      "pnpm test:kb --build-only fence",
    );
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const a = await startSession(repos, fixture);
    a.send(`SPAWN_BIN op_term ${bin}`);
    const spawned = await a.wait(/^SPAWNED op_term (\d+)$/);
    const childPid = Number(spawned[1]);
    await registerPid(childPid, repos);
    const unblockedAt = Date.now();
    while (sigBlkHasTerm(childPid) && Date.now() - unblockedAt < 2_000) {
      await delay(20);
    }
    expect(sigBlkHasTerm(childPid)).toBe(false);
    const started = Date.now();
    a.send(`DRAIN op_term ${childPid}`);
    const exited = await a.wait(/^EXITED op_term (\d+) (\d+)$/, 4_000);
    expect(Number(exited[1])).toBe(childPid);
    expect(Number(exited[2])).toBe(128 + 15);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 30_000);

  it("keeps Node's control channel when a descendant tries to steal it", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const stealPath = join(repos, "steal.txt");
    const a = await startSession(repos, fixture);
    a.send(`SPAWN_STEAL op_steal ${stealPath}`);
    await a.wait(/^EXITED op_steal /);
    expect(readFileSync(stealPath, "utf8")).not.toBe("pong");
    a.send("PING");
    await a.wait(/^PONG$/);
  }, 30_000);

  it("reaps adopted descendants before the supervisor exits", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = writeFixture(tmp("kb-fence-fix-"));
    const a = await startSession(repos, fixture);
    a.send("ADOPT_SLEEP");
    const adopted = await a.wait(/^ADOPTED (\d+)$/);
    const adoptedPid = Number(adopted[1]);
    await registerPid(adoptedPid, repos);
    a.send("QUIT");
    await waitAlive(a.supervisorPid, false, 15_000);
    expect(isAlive(adoptedPid)).toBe(false);
  }, 30_000);

  it("does not crash when the control client stops reading replies", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const script =
      "const net=require('net');const addr=process.env.KB_SUPERVISOR_SOCK;const path=addr.startsWith('@')?'\\0'+addr.slice(1):addr;const s=net.connect({path});s.on('connect',()=>{const ping=Buffer.alloc(5);ping.writeUInt32BE(1,0);ping[4]=4;for(let i=0;i<200;i++)s.write(ping);s.destroy();});setTimeout(()=>process.exit(0),300);";
    const child = spawn(SUPERVISOR, ["--", process.execPath, "-e", script], {
      cwd: repos,
      env: { ...process.env, KB_DATA_ROOT: dirname(repos) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolvePromise) => {
        child.on("exit", (code, signal) => resolvePromise({ code, signal }));
      },
    );
    if (child.pid) await registerPid(child.pid, repos);
    const ended = await exited;
    expect(ended.signal).toBeNull();
    expect(ended.code).not.toBe(139);
    expect(ended.code).not.toBe(134);
    expect(Buffer.concat(stderrChunks).toString("utf8")).not.toMatch(
      /buffer overflow|AddressSanitizer|Segmentation fault/i,
    );
  }, 30_000);

  it("waits for an already-exited child without signaling siblings", async () => {
    requireSupervisor();
    const repos = prepareRepos();
    const fixture = join(ROOT, "apps/server/src/kb-process.client-fixture.ts");
    const a = await startSupervised(repos, [
      process.execPath,
      "--import",
      join(ROOT, "node_modules/tsx/dist/loader.mjs"),
      fixture,
    ]);
    const waited = await a.wait(/^WAITED (\d+)$/);
    expect(Number(waited[1])).toBe(7);
    const afterWait = await a.wait(/^DRAIN_AFTER_WAIT (.+)$/);
    expect(afterWait[1]).toMatch(/not found/i);
    const stale = await a.wait(/^STALE_DRAIN (.+)$/);
    expect(stale[1]).toMatch(/not found/i);
    await a.wait(/^LIVE_PRESERVED$/);
    const live = await a.wait(/^CONCUR op_live (ok|fail) (.+)$/);
    const quick2 = await a.wait(/^CONCUR op_quick2 (ok|fail) (.+)$/);
    const missing = await a.wait(/^CONCUR op_missing (ok|fail) (.+)$/);
    expect(live[1]).toBe("ok");
    expect(quick2[1]).toBe("ok");
    expect(Number(quick2[2])).toBe(0);
    expect(missing[1]).toBe("fail");
    expect(missing[2]).toMatch(/not found/i);
    await a.wait(/^DONE$/);
  }, 30_000);
});
