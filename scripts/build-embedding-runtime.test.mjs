import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBuildSupervisor } from "./build-embedding-runtime.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test("measurement deadline settles after a real delayed-exit child and before its enclosing watchdog", {
  timeout: 10_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-measure-drain-test-"));
  const marker = join(dir, "pid");
  const s = createBuildSupervisor({ timeoutMs: 1500, graceMs: 500 });
  let enclosingExpired = false;
  const enclosing = setTimeout(() => {
    enclosingExpired = true;
  }, 5000);
  let pid;
  let running;
  let rejected;
  try {
    running = s.run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200));writeFileSync(${JSON.stringify(marker)}+".pending",String(process.pid));renameSync(${JSON.stringify(marker)}+".pending",${JSON.stringify(marker)});setInterval(()=>{},1000);`,
      ],
      dir,
    );
    rejected = assert.rejects(running, /native build deadline exceeded/);
    await until(() => existsSync(marker));
    pid = Number(readFileSync(marker, "utf8"));
    assert.ok(alive(pid), "real pending measurement required");
    await rejected;
    assert.equal(alive(pid), false, "deadline rejection must wait for child drain");
    assert.equal(enclosingExpired, false, "fixture must retain ownership through drain");
  } finally {
    clearTimeout(enclosing);
    s.close();
    await running?.catch(() => {});
    await rejected?.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
async function until(check) {
  const end = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < end, "real child did not reach pending operation");
    await delay(20);
  }
}
function alive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
test("a real cache lease survives SIGKILL of its ancestor until the detached writer exits", {
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-build-lease-test-"));
  const lock = join(dir, "lock");
  const marker = join(dir, "pid");
  const release = join(dir, "release");
  const leaf = join(dir, "writer.mjs");
  const middle = join(dir, "builder.mjs");
  const runner = join(dir, "runner.mjs");
  writeFileSync(lock, "");
  writeFileSync(
    leaf,
    `import {existsSync,writeFileSync,renameSync} from 'node:fs';import {createBuildSupervisor} from ${JSON.stringify(new URL("./build-embedding-runtime.mjs", import.meta.url).href)};const tool=createBuildSupervisor();try{await tool.run(process.execPath,['--input-type=module','-e',${JSON.stringify(`import {fstatSync,statSync} from 'node:fs';const lock=statSync(${JSON.stringify(lock)});let inherited;try{inherited=fstatSync(3)}catch(error){if(error.code!=='EBADF')throw error}if(inherited?.dev===lock.dev&&inherited?.ino===lock.ino)throw new Error('scratch tool inherited persistent cache lease');`)}],${JSON.stringify(dir)});}finally{tool.close()}writeFileSync(${JSON.stringify(marker)}+'.pending',JSON.stringify({pid:process.pid,parent:Number(process.argv[2])}));renameSync(${JSON.stringify(marker)}+'.pending',${JSON.stringify(marker)});setInterval(()=>{if(existsSync(${JSON.stringify(release)}))process.exit(0)},20);`,
  );
  writeFileSync(
    middle,
    `import {readFileSync} from 'node:fs';import {createBuildSupervisor} from ${JSON.stringify(new URL("./build-embedding-runtime.mjs", import.meta.url).href)};const stat=readFileSync('/proc/self/stat','utf8');const group=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[2]);const s=createBuildSupervisor({inheritedFd:3});try{await s.run(process.execPath,[${JSON.stringify(leaf)},String(group)],${JSON.stringify(dir)});}finally{s.close()}`,
  );
  writeFileSync(
    runner,
    `import {createBuildSupervisor} from ${JSON.stringify(new URL("./build-embedding-runtime.mjs", import.meta.url).href)};const s=createBuildSupervisor({inheritedFd:3});try{await s.run(process.execPath,[${JSON.stringify(middle)}],${JSON.stringify(dir)});}finally{s.close()}`,
  );
  const holder = spawn("flock", ["--exclusive", lock, process.execPath, runner], {
    detached: true,
    stdio: "ignore",
  });
  const closed = new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.once("close", resolve);
  });
  const contender = createBuildSupervisor({ timeoutMs: 10_000 });
  let pid;
  let parent;
  try {
    await until(() => existsSync(marker));
    ({ pid, parent } = JSON.parse(readFileSync(marker, "utf8")));
    assert.ok(alive(pid));
    assert.ok(alive(parent));
    assert.equal(holder.exitCode, null);
    assert.equal(holder.signalCode, null);
    process.kill(-holder.pid, "SIGKILL");
    await closed;
    // Name the actual builder explicitly: supervised admission may insert a
    // launcher as the writer's immediate parent, in the writer's own group.
    // Both detached ancestors are deliberately killed. Only the real writer
    // can now retain the same open-file-description lease.
    assert.ok(alive(parent));
    process.kill(-parent, "SIGKILL");
    await until(() => !alive(parent));
    assert.ok(alive(pid), "detached writer must outlive the killed ancestor in this fixture");
    await assert.rejects(
      contender.run(
        "flock",
        ["--nonblock", "--exclusive", lock, process.execPath, "-e", "process.exit(0)"],
        dir,
      ),
      /failed: flock \(1\)/,
    );
    writeFileSync(release, "");
    await until(() => !alive(pid));
    await contender.run(
      "flock",
      ["--exclusive", lock, process.execPath, "-e", "process.exit(0)"],
      dir,
    );
  } finally {
    writeFileSync(release, "");
    holder.kill("SIGTERM");
    await closed;
    if (pid) await until(() => !alive(pid));
    if (parent) await until(() => !alive(parent));
    contender.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
for (const stage of ["fetch", "configure", "compile"]) {
  test(`${stage}: SIGTERM drains a real TERM-resistant descendant before scratch cleanup`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-build-cancel-test-"));
    const marker = join(dir, "pid");
    const pending = join(dir, "pending.mjs");
    writeFileSync(
      pending,
      `import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(marker)}+".pending",String(process.pid));renameSync(${JSON.stringify(marker)}+".pending",${JSON.stringify(marker)});setInterval(()=>{},1000);`,
    );
    const runner = join(dir, "runner.mjs");
    writeFileSync(
      runner,
      `import {createBuildSupervisor} from ${JSON.stringify(new URL("./build-embedding-runtime.mjs", import.meta.url).href)};const s=createBuildSupervisor({graceMs:50});try{await s.run(process.execPath,['--input-type=module','-e',${JSON.stringify(`import {spawn} from 'node:child_process';spawn(process.execPath,[${JSON.stringify(pending)}],{stdio:'inherit'});setInterval(()=>{},1000);`)}],${JSON.stringify(dir)});}catch{}finally{s.close();}`,
    );
    const child = spawn(process.execPath, [runner], { stdio: "ignore" });
    const exit = new Promise((resolve) => child.once("exit", resolve));
    let pid;
    try {
      await until(() => existsSync(marker));
      pid = Number(readFileSync(marker, "utf8"));
      assert.ok(alive(pid));
      child.kill("SIGTERM");
      await exit;
      assert.equal(alive(pid), false, "descendant outlived build owner");
      // Scratch is now safe to remove: no compiler process owns it.
      rmSync(dir, { recursive: true, force: true });
      assert.equal(existsSync(dir), false);
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      if (child.exitCode === null) child.kill("SIGKILL");
      await exit;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
test("deadline kills pending real work; pre-abort admits no new process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-build-deadline-test-"));
  const marker = join(dir, "pid");
  const s = createBuildSupervisor({ timeoutMs: 1500, graceMs: 50 });
  try {
    await assert.rejects(
      s.run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {writeFileSync,renameSync} from 'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(marker)}+".pending",String(process.pid));renameSync(${JSON.stringify(marker)}+".pending",${JSON.stringify(marker)});setInterval(()=>{},1000);`,
        ],
        dir,
      ),
      /deadline/,
    );
    assert.equal(alive(Number(readFileSync(marker, "utf8"))), false);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const pre = createBuildSupervisor({ signal: AbortSignal.abort() });
  try {
    await assert.rejects(pre.run("must-not-spawn", [], "/"), /cancelled/);
  } finally {
    pre.close();
  }
});
test("ordinary success, tool failure and re-entry retain their exact outcomes", async () => {
  const s = createBuildSupervisor();
  try {
    await s.run(process.execPath, ["-e", "process.exit(0)"], tmpdir());
    await assert.rejects(s.run(process.execPath, ["-e", "process.exit(7)"], tmpdir()), /failed.*7/);
    await s.run(process.execPath, ["-e", "process.exit(0)"], tmpdir());
  } finally {
    s.close();
  }
  await assert.rejects(s.run("must-not-spawn", [], "/"), /closed/);
});

// flk8: the daemon drain readback belongs to the build-only bound. Under I/O
// pressure one `docker buildx history ls` took 7-25 s, so a fixed 30 s window
// reported healthy builds as incomplete drains. A slow daemon is waited for;
// only one that never confirms within the build bound fails closed.
const fakeDocker = (dir, confirmOnProbe) => {
  const probes = join(dir, "probes");
  writeFileSync(
    join(dir, "docker"),
    `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
const args = process.argv.slice(2);
const name = ${JSON.stringify(join(dir, "name"))};
if (args[0] === 'build') {
  writeFileSync(name, args.find((arg) => arg.startsWith('BUILDKIT_BUILD_NAME=')).split('=')[1]);
} else if (args[0] === 'buildx' && args[1] === 'history') {
  appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
  const count = readFileSync(${JSON.stringify(probes)}, 'utf8').trim().split('\\n').length;
  const done = count >= ${confirmOnProbe};
  process.stdout.write(JSON.stringify({ name: readFileSync(name, 'utf8'), status: done ? 'Completed' : 'Running', ...(done ? { completed_at: new Date().toISOString() } : {}) }) + '\\n');
} else process.exit(2);
`,
    { mode: 0o755 },
  );
  return { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, probes };
};

test("flk8 Docker drain waits for confirmation beyond the former 30-second ceiling", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kb-drain-slow-"));
  const { env, probes } = fakeDocker(dir, 4);
  const start = Date.now();
  let advanced = false;
  // Advance only the supervisor's clock, after drain has started and a pending
  // history record has been observed. No wall-clock wait is needed to cross
  // both the former fixed window and a capped default drainTimeoutMs.
  t.mock.method(Date, "now", () => {
    if (
      !advanced &&
      existsSync(probes) &&
      readFileSync(probes, "utf8").trim().split("\n").length >= 2
    )
      advanced = true;
    return start + (advanced ? 31_000 : 0);
  });
  const s = createBuildSupervisor({ timeoutMs: 30 * 60_000, groupDirectory: null });
  try {
    await s.run("docker", ["build", "."], dir, { env });
    assert.equal(advanced, true, "confirmation must follow the clock advance");
    assert.equal(Date.now() - start, 31_000, "confirmation must cross the former drain ceiling");
    assert.equal(readFileSync(probes, "utf8").trim().split("\n").length, 4);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("flk8 Docker drain that never confirms fails closed at the build bound", {
  // Regression guard for the former fixed 30 s readback window.
  timeout: 20_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-drain-stuck-"));
  const { env } = fakeDocker(dir, Number.POSITIVE_INFINITY);
  const s = createBuildSupervisor({ timeoutMs: 1000, groupDirectory: null });
  try {
    await assert.rejects(
      s.run("docker", ["build", "."], dir, { env }),
      (error) => error.drainIncomplete === true && /retained intent/.test(error.message),
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
