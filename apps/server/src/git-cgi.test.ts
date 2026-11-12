import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { requireBuiltArtifact } from "../../../packages/test-utils/src/kb/build-artifacts.mjs";
import { cgiResponse, gitCgiEnvironment, parseCgiHead } from "./git-cgi";

const kbId = "a123456789012345678901234";
const input = {
  kbId,
  reposDir: "/repos",
  userId: "user",
  method: "GET" as const,
  discovery: true,
  length: 0,
  protocol: "version=2",
  refs: ["refs/heads/main"],
};

describe("bounded Git CGI", () => {
  it.each(["missing", "nonexecutable", "redirected"])(
    "refuses a %s hook before receive-pack can publish, while clone remains available",
    (mode) => {
      const root = resolve(import.meta.dirname, "../../..");
      // The supervisor fences <KB_DATA_ROOT>/repos; the fixture lives in repos/.
      const dataRoot = mkdtempSync(join(tmpdir(), "kb-cgi-hook-"));
      const dir = join(dataRoot, "repos");
      // Synchronous setup cannot be interrupted by Vitest's outer timer.
      // Git fixture publication may wait on the shared disk. Give setup its
      // own bounded budget; the transport probe below still has exactly 30s.
      const deadline = Date.now() + 120_000;
      const remaining = () => Math.max(1, deadline - Date.now());
      try {
        mkdirSync(dir);
        mkdirSync(join(dir, "src"));
        mkdirSync(join(dir, "dist/hooks"), { recursive: true });
        mkdirSync(join(dir, ".private"));
        // Copy only the three modules owning this boundary. Dependencies remain
        // read-only links; no shared artifact is removed by the fault fixture.
        for (const name of ["git-cgi.ts", "git-pre-receive.ts", "kb-process.ts"])
          copyFileSync(join(import.meta.dirname, name), join(dir, "src", name));
        symlinkSync(join(root, "apps/server/node_modules"), join(dir, "node_modules"));
        writeFileSync(join(dir, "package.json"), '{"type":"module"}');
        if (mode !== "missing") {
          writeFileSync(join(dir, "dist/git-pre-receive.mjs"), "process.exit(1);", { mode: 0o644 });
          symlinkSync(
            mode === "redirected" ? process.execPath : "../git-pre-receive.mjs",
            join(dir, "dist/hooks/pre-receive"),
          );
        }
        // Prepare repositories and wire bytes before the bounded transport child.
        // Its watchdog measures admission/clone, rather than fixture Git writes.
        const git = (args: string[]) =>
          execFileSync("git", args, {
            cwd: dir,
            env: { PATH: process.env.PATH, TMPDIR: dir },
            timeout: remaining(),
            encoding: "utf8",
            stdio: "pipe",
          }).trim();
        const repo = join(dir, "kb_" + kbId + ".git");
        const clone = join(dir, "clone");
        git(["init", "--bare", "--initial-branch=main", repo]);
        git(["init", "--initial-branch=main", clone]);
        const commit = (path: string) => {
          writeFileSync(join(clone, path), "forbidden");
          git(["-C", clone, "add", "."]);
          git([
            "-C",
            clone,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "fixture",
          ]);
          return git(["-C", clone, "rev-parse", "HEAD"]);
        };
        const old = commit("first.md");
        git(["-C", clone, "push", repo, "main"]);
        const next = commit("forbidden.txt");
        const pack = execFileSync("git", ["-C", clone, "pack-objects", "--stdout", "--revs"], {
          env: { PATH: process.env.PATH, TMPDIR: dir },
          timeout: remaining(),
          input: next + "\n^" + old + "\n",
        });
        const command = Buffer.from(old + " " + next + " refs/heads/main\0report-status\n");
        const bytes = Buffer.concat([
          Buffer.from((command.length + 4).toString(16).padStart(4, "0")),
          command,
          Buffer.from("0000"),
          pack,
        ]);
        writeFileSync(join(dir, "request"), bytes);
        writeFileSync(join(dir, "fixture.json"), JSON.stringify({ old, length: bytes.length }));
        const fixture = join(dir, "fixture.mts");
        writeFileSync(
          fixture,
          `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {runGitCgi,gitCgiEnvironment} from './src/git-cgi.ts';
const dir=process.env.KB_DATA_ROOT+'/repos', id=${JSON.stringify(kbId)};
const git=(args,input)=>execFileSync('git',args,{cwd:dir,input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const {old,length}=JSON.parse(readFileSync(dir+'/fixture.json','utf8'));
const file=await open(dir+'/request','r');let disposed=false,rejection;
try {await runGitCgi({env:gitCgiEnvironment({reposDir:dir,kbId:id,userId:'fixture',method:'POST',discovery:false,length,protocol:null,refs:['refs/heads/main'],receive:true}),file,signal:new AbortController().signal,reauthorize:async()=>{},onDone:async()=>{disposed=true;},buffered:true});}catch(error){rejection=error;}finally{await file.close();}
assert.equal(git(['--git-dir='+dir+'/kb_'+id+'.git','rev-parse','main']),old,'unvalidated ref moved');assert.equal(rejection?.message,'GIT_TRANSPORT_UNAVAILABLE');assert(disposed);
const cloneDone=Promise.withResolvers();
const response=await runGitCgi({env:gitCgiEnvironment({reposDir:dir,kbId:id,userId:'fixture',method:'GET',discovery:true,length:0,protocol:null,refs:['refs/heads/main']}),signal:new AbortController().signal,reauthorize:async()=>{},onDone:async()=>{cloneDone.resolve();}});
assert.equal(response.status,200);assert((await response.text()).includes(old));await cloneDone.promise;console.log('hook admission and clone passed');process.exit(0);`,
        );
        const supervisor = requireBuiltArtifact(
          join(root, "apps/server/native/kb-supervisor"),
          "pnpm test:kb --build-only git-http",
        );
        const out = execFileSync(
          supervisor,
          [
            "--",
            process.execPath,
            "--import",
            join(root, "node_modules/tsx/dist/loader.mjs"),
            fixture,
          ],
          {
            env: { PATH: process.env.PATH, KB_DATA_ROOT: dataRoot, TMPDIR: dir },
            timeout: 30_000,
            encoding: "utf8",
            stdio: "pipe",
          },
        );
        expect(out).toContain("hook admission and clone passed");
        expect(readdirSync(dir).filter((name) => name.startsWith("kb-cgi-"))).toEqual([]);
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    160_000,
  );
  it("parses Status and headers, preserves binary remainder and fragmented boundaries", async () => {
    expect(
      parseCgiHead(Buffer.from("Status: 403 Forbidden\r\nContent-Type: text/plain\r\n")),
    ).toBeNull();
    const head = parseCgiHead(
      Buffer.from("Status: 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nbody"),
    );
    expect(head?.status).toBe(403);
    expect(head?.headers.get("content-type")).toBe("text/plain");
    expect(head?.rest.toString()).toBe("body");
    const source = new PassThrough();
    const cancel = vi.fn(async () => {});
    const response = cgiResponse({
      source,
      signal: new AbortController().signal,
      reauthorize: async () => {},
      wait: async () => 0,
      cancel,
    });
    source.write("Content-Ty");
    source.write("pe: application/x-git-upload-pack-result\r\n\r");
    source.end(Buffer.from([10, 0, 255, 1]));
    expect(Buffer.from(await (await response).arrayBuffer())).toEqual(Buffer.from([0, 255, 1]));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    "Status: 999 Invalid\r\n\r\n",
    "Content-Type: x\r\nSet-Cookie: stolen=1\r\n\r\n",
    "Content-Type: x\r\nContent-Type: y\r\n\r\n",
    "Bad header\r\n\r\n",
    "x".repeat(16385),
  ])("rejects malformed/unsafe CGI headers", (value) => {
    expect(() => parseCgiHead(Buffer.from(value))).toThrow();
  });
  it("builds a closed env and hides every namespace except the explicit retained refs", () => {
    const env = gitCgiEnvironment(input);
    expect(env.PATH_INFO).toBe(`/kb_${kbId}.git/info/refs`);
    expect(env.QUERY_STRING).toBe("service=git-upload-pack");
    expect(env.REMOTE_USER).toBe("user");
    // A v2 request is served as v0: v2 fetch would ignore the unadvertised-want rules.
    expect(env).not.toHaveProperty("HTTP_GIT_PROTOCOL");
    expect(env).not.toHaveProperty("GIT_PROTOCOL");
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    // The `#!/usr/bin/env node` receive hook must find this server's interpreter first.
    expect(env.PATH?.split(":")).toEqual([dirname(process.execPath), "/usr/bin", "/bin"]);
    expect(env).not.toHaveProperty("HTTP_AUTHORIZATION");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(Object.values(env)).toContain("!refs/heads/main");
    expect(Object.values(env)).toContain("uploadpack.allowAnySHA1InWant");
  });
  it.each([
    "0e0vluxcgs5wyhelc42wdzz3",
    "012345678901234567890123",
    "z1234567890123456789012345678901",
  ])("accepts every protocol KB id, including a generated digit-leading one: %s", (kbId) => {
    expect(gitCgiEnvironment({ ...input, kbId }).PATH_INFO).toBe(`/kb_${kbId}.git/info/refs`);
  });
  it.each([
    { kbId: "../../escape" },
    { kbId: "A123456789012345678901234" },
    { kbId: "a12345678901234567890123456789012" },
    { protocol: "version=2:GIT_CONFIG_COUNT=1" },
    { userId: "a\nPATH_INFO=/secret" },
    { refs: ["refs/tags/private"] },
    { refs: ["refs/heads/main\n"] },
  ])("rejects path/env/protocol injection", (change) => {
    expect(() => gitCgiEnvironment({ ...input, ...change })).toThrow();
  });
  it("does not prefetch a slow clone and stops the next frame on revocation", async () => {
    const source = new PassThrough({ highWaterMark: 65536 });
    const reauthorize = vi.fn(async () => {});
    const cancel = vi.fn(async () => {
      source.destroy();
    });
    const response = cgiResponse({
      source,
      signal: new AbortController().signal,
      reauthorize,
      wait: async () => 0,
      cancel,
    });
    source.write("Content-Type: application/x-git-upload-pack-result\r\n\r\n");
    const result = await response;
    const reader = result.body!.getReader();
    expect(source.write(Buffer.alloc(512 * 1024))).toBe(false);
    const first = await reader.read();
    expect(first.value!.byteLength).toBeLessThanOrEqual(256 * 1024);
    const calls = reauthorize.mock.calls.length;
    await new Promise((resolve) => setImmediate(resolve));
    expect(reauthorize.mock.calls.length).toBe(calls);
    reauthorize.mockRejectedValue(new Error("revoked"));
    await expect(reader.read()).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels pending header I/O on disconnect and rejects truncated CGI", async () => {
    const source = new PassThrough();
    const abort = new AbortController();
    const cancel = vi.fn(async () => {
      source.destroy();
    });
    const response = cgiResponse({
      source,
      signal: abort.signal,
      reauthorize: async () => {},
      wait: async () => 0,
      cancel,
    });
    abort.abort();
    await expect(response).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    const truncated = new PassThrough();
    const other = cgiResponse({
      source: truncated,
      signal: new AbortController().signal,
      reauthorize: async () => {},
      wait: async () => 0,
      cancel: async () => {},
    });
    truncated.end("Content-Type: text/plain");
    await expect(other).rejects.toThrow();
  });
});

describe("CGI pending-spawn ownership across the real native supervisor", () => {
  it.each(["cancel", "deadline", "cleanup", "not-started"])(
    "bounds %s while retaining and draining a late acknowledgement",
    async (mode) => {
      const root = resolve(import.meta.dirname, "../../..");
      const native = join(root, "apps/server/native");
      requireBuiltArtifact(join(native, "kb-supervisor"), "pnpm test:kb --build-only git-http");
      const dataRoot = mkdtempSync(join(tmpdir(), "kb-cgi-owner-test-"));
      const dir = join(dataRoot, "repos");
      mkdirSync(join(dir, ".private"), { recursive: true });
      mkdirSync(join(dir, "cgi"));
      const fixture = join(dir, "fixture.mts");
      const cgi = pathToFileURL(join(root, "apps/server/src/git-cgi.ts")).href;
      const fence = pathToFileURL(join(root, "apps/server/src/kb-process.ts")).href;
      writeFileSync(
        fixture,
        `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runGitCgi, gitCgiEnvironment } from ${JSON.stringify(cgi)};
import { pingProcessFence, isAdmissionOpen, spawnMutatingChild } from ${JSON.stringify(fence)};
const dir = process.env.KB_DATA_ROOT + "/repos";
const mark = (name, value = "ready") => process.stdout.write("R36 " + name + ": " + value + "\\n");
await pingProcessFence();
if (["cleanup", "not-started"].includes(${JSON.stringify(mode)})) {
  const kbId = "a123456789012345678901234";
  if (${JSON.stringify(mode)} === "cleanup")
    execFileSync("git", ["init", "--bare", "--initial-branch=main", dir + "/kb_" + kbId + ".git"], { stdio: "pipe" });
  const release = Promise.withResolvers();
  const disposed = Promise.withResolvers();
  let cleaning = false;
  const response = runGitCgi({
    env: ${JSON.stringify(mode)} === "not-started" ? { GIT_PROJECT_ROOT: "" } : gitCgiEnvironment({ reposDir: dir, kbId, userId: "user", method: "GET", discovery: true, length: 0, protocol: null, refs: ["refs/heads/main"] }),
    signal: new AbortController().signal, reauthorize: async () => {},
    onDone: async () => { cleaning = true; mark("cleaning"); await release.promise; mark("disposed"); disposed.resolve(); },
    onUnconfirmedDrain: () => { throw new Error("confirmed child treated as unconfirmed"); },
  });
  // Observe disposal before joining response completion: the stream's final
  // pull may itself await onDone, whose release this fixture owns.
  const completed = ${JSON.stringify(mode)} === "not-started"
    ? assert.rejects(response)
    : response.then(async (result) => {
        assert.equal(result.status, 200);
        await result.arrayBuffer();
      });
  // Observe early rejection while the fixture checks the blocked disposer;
  // the original completion is still awaited and must pass below.
  void completed.catch(() => {});
  while (!cleaning) await delay(10);
  await delay(5500);
  assert(isAdmissionOpen(), "slow resource disposal fenced confirmed native ownership");
  release.resolve();
  await completed;
  await disposed.promise;
  mark("drained");
  process.exit(0);
}
const before = new AbortController();
before.abort();
let beforeDone = false;
await assert.rejects(runGitCgi({
  env: { GIT_PROJECT_ROOT: dir }, signal: before.signal,
  reauthorize: async () => { throw new Error("pre-abort authorized"); },
  onDone: async () => { beforeDone = true; },
}));
assert(beforeDone);
assert(isAdmissionOpen(), "pre-abort closed legitimate native admission");
const originalTmp = process.env.TMPDIR;
process.env.TMPDIR = dir + "/missing";
let setupDone = false;
await assert.rejects(runGitCgi({
  env: { GIT_PROJECT_ROOT: dir }, signal: new AbortController().signal,
  reauthorize: async () => { throw new Error("failed setup authorized"); },
  onDone: async () => { setupDone = true; },
}));
process.env.TMPDIR = originalTmp;
assert(setupDone);
assert(isAdmissionOpen(), "failed filesystem setup closed native admission");
process.kill(process.ppid, "SIGSTOP");
const abort = new AbortController();
mark("stopped", String(process.pid));
const start = Date.now();
// Keep the fixture alive like the listening HTTP host, without disk I/O in timed callbacks.
const heartbeat = setInterval(() => {}, 1000);
let completed = false;
const pending = runGitCgi({
  env: { GIT_PROJECT_ROOT: dir }, signal: abort.signal,
  reauthorize: async () => {}, onDone: async () => { completed = true; mark("done"); },
  onUnconfirmedDrain: () => mark("unconfirmed", String(Date.now() - start)),
});
if (${JSON.stringify(mode)} === "cancel") setTimeout(() => abort.abort(), 100);
await assert.rejects(pending);
clearInterval(heartbeat);
assert(!isAdmissionOpen());
assert(!completed, "released pending native ownership");
await assert.rejects(spawnMutatingChild({ opId: "successor", cwd: dir, argv: ["/bin/true"] }), { spawnOutcome: "not-started" });
mark("settled", String(Date.now() - start));
while (!completed) await delay(10);
mark("drained");
process.exit(0);
`,
      );
      const child = spawn(
        join(native, "kb-supervisor"),
        [
          "--",
          process.execPath,
          "--import",
          join(root, "node_modules/tsx/dist/loader.mjs"),
          fixture,
        ],
        {
          env: { PATH: process.env.PATH, KB_DATA_ROOT: dataRoot, TMPDIR: join(dir, "cgi") },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const exit = new Promise<number | null>((done) => child.once("exit", done));
      // Cold loader/filesystem work and post-resume disposal share the host
      // disk. These fixture watchdogs do not relax the elapsed caller bounds.
      const fixtureIoBudget = 60000;
      const arrived = async (name: string, ms: number) => {
        const deadline = Date.now() + ms;
        while (!output.includes("R36 " + name + ":")) {
          if (child.exitCode !== null || Date.now() >= deadline)
            throw new Error(`missing ${name}: ${output}`);
          await delay(20);
        }
      };
      try {
        if (mode === "cleanup" || mode === "not-started") {
          await arrived("drained", fixtureIoBudget);
          expect(await exit).toBe(0);
          expect(output).toContain("R36 cleaning:");
          expect(output).toContain("R36 disposed:");
          return;
        }
        await arrived("stopped", fixtureIoBudget);
        await arrived("settled", mode === "cancel" ? 10000 : 75000);
        const elapsed = Number(/R36 settled: (\d+)/.exec(output)?.[1]);
        process.stdout.write(
          `real supervisor ${mode}: caller settled in ${elapsed}ms while peer remained stopped\n`,
        );
        expect(elapsed).toBeGreaterThanOrEqual(mode === "cancel" ? 5000 : 65000);
        expect(elapsed).toBeLessThan(mode === "cancel" ? 9000 : 68000);
        expect(output).toContain("R36 unconfirmed:");
        expect(output).not.toContain("R36 done:");
        expect(
          readdirSync(join(dir, "cgi")).filter((name) => name.startsWith("kb-cgi-")),
        ).toHaveLength(1);
        child.kill("SIGCONT");
        await arrived("drained", fixtureIoBudget);
        expect(await exit).toBe(0);
        expect(readdirSync(join(dir, "cgi")).filter((name) => name.startsWith("kb-cgi-"))).toEqual(
          [],
        );
        expect(output).toContain('"site":"supervisor.op-spawned"');
        expect(output).toContain('"site":"supervisor.op-reaped"');
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGCONT");
          child.kill("SIGTERM");
          await exit;
        }
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    200000,
  );
});
