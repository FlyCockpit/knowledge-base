import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runClean, testOwner } from "./test-clean.mjs";

const owner = await testOwner();

test("budgets every nested broker below macOS sun_path even near PATH_MAX TMPDIR", async () => {
  if (process.platform === "win32") return;
  const external = mkdtempSync(join(tmpdir(), "kb-socket-budget-"));
  // macOS PATH_MAX is 1024. Leave room for the run and nested fixture names,
  // while exceeding sun_path by several times, including a worst-case PID.
  let longTmp = external;
  while (Buffer.byteLength(longTmp) < 899) {
    longTmp = join(longTmp, "t".repeat(Math.min(220, 899 - Buffer.byteLength(longTmp))));
  }
  assert.ok(Buffer.byteLength(longTmp) >= 899);
  mkdirSync(longTmp, { recursive: true, mode: 0o700 });
  const socketsFile = join(external, "sockets.json");
  const leaf = `
    const fs = require('node:fs'), path = require('node:path');
    const socket = process.env.KB_TEST_PROCESS_SOCKET;
    const sockets = [process.env.OUTER_SOCKET, socket];
    for (const name of sockets) {
      require('node:assert/strict').ok(Buffer.byteLength(name) < 104, name);
      require('node:assert/strict').equal(fs.statSync(path.dirname(name)).mode & 0o777, 0o700);
    }
    fs.writeFileSync(${JSON.stringify(socketsFile)}, JSON.stringify(sockets));
    const result = require('node:child_process').spawnSync(process.env.KB_TEST_PROCESS_OWNER,
      ['--escape-session', socket, process.execPath, '-e', ''], {stdio:'inherit'});
    process.exitCode = result.status;
  `;
  const leader = `
    const fs = require('node:fs'), path = require('node:path');
    const root = path.join(require('node:os').tmpdir(), 'kb-child-9999999999-9999999999');
    fs.mkdirSync(root);
    const result = require('node:child_process').spawnSync(process.env.KB_TEST_PROCESS_OWNER,
      [root, process.execPath, '-e', ${JSON.stringify(leaf)}],
      {stdio:'inherit', env:{...process.env, OUTER_SOCKET:process.env.KB_TEST_PROCESS_SOCKET}});
    process.exitCode = result.status;
  `;
  const runner = new URL("./test-clean.mjs", import.meta.url);
  const script = `
    import {runClean} from ${JSON.stringify(runner.href)};
    process.env.TMPDIR = ${JSON.stringify(longTmp)};
    process.exitCode = await runClean(process.execPath, ['-e', ${JSON.stringify(leader)}],
      {portable:true, owner:${JSON.stringify(owner)}});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: "inherit",
  });
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    const sockets = JSON.parse(readFileSync(socketsFile, "utf8"));
    assert.notEqual(sockets[0], sockets[1]);
    for (const socket of sockets) {
      assert.ok(Buffer.byteLength(socket) < 104);
      assert.equal(
        existsSync(join(socket, "..")),
        false,
        "private broker directory removed after drain",
      );
    }
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("rejects leaked stores while preserving another run's files", async () => {
  const foreign = mkdtempSync(join(tmpdir(), "kb-local-other-run-"));
  try {
    assert.equal(await runClean(process.execPath, ["-e", ""]), 0);
    assert.equal(await runClean(process.execPath, ["-e", "process.exit(7)"]), 7);
    assert.equal(
      await runClean(process.execPath, [
        "-e",
        "require('node:fs').mkdirSync(require('node:path').join(require('node:os').tmpdir(),'kb-local-leaked'))",
      ]),
      1,
    );
    assert.ok(existsSync(foreign));
  } finally {
    rmSync(foreign, { recursive: true });
  }
});

async function until(probe) {
  const deadline = Date.now() + 20_000;
  while (!probe()) {
    assert.ok(Date.now() < deadline, "fixture never became ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertReaped(pid) {
  if (process.platform === "linux") {
    assert.equal(existsSync(`/proc/${pid}`), false, `descendant ${pid} must be reaped`);
  } else {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }
}

// Exercise the non-subreaper signalling branch on Linux as well as macOS.
// Escapes use the broker contract on macOS/portable, just like embed_service.
for (const ownership of process.platform === "win32"
  ? ["native"]
  : ["native", "portable-group", "portable-session", "portable-nested-session"]) {
  for (const ending of ["normal", "failure", "SIGINT", "SIGTERM", "repeated-signals"]) {
    for (const handles of ["inherit", "ignore", "closed"]) {
      test(`drains and reaps ${ownership} ${handles} output descendants on ${ending}`, async () => {
        const external = mkdtempSync(join(tmpdir(), "kb-clean-probe-"));
        const ready = join(external, "ready");
        const release = join(external, "release");
        // This sibling is deliberately outside the run namespace and ownership
        // tree. Even an interrupted run must never signal or delete it.
        const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          stdio: "ignore",
        });
        const foreignClosed = once(foreign, "close");
        const leaf = `
        const fs=require('node:fs'),path=require('node:path');
        process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});
        ${handles === "closed" ? "fs.closeSync(1);fs.closeSync(2);" : ""}
        const root=require('node:os').tmpdir();
        const store=path.join(root,'kb-local-descendant');fs.mkdirSync(store);
        fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,root}));
        setInterval(()=>{
          // Continuing after cleanup would recreate the deleted namespace.
          fs.mkdirSync(store,{recursive:true});fs.writeFileSync(path.join(store,'tick'),'live');
        },10);
      `;
        const registered = ownership !== "native" || process.platform === "darwin";
        const middle = `
        const childProcess = require('node:child_process');
        childProcess.spawn(${registered ? "process.env.KB_TEST_PROCESS_OWNER" : "process.execPath"},
          ${registered ? `[${JSON.stringify(ownership.includes("session") ? "--escape-session" : "--escape-group")},process.env.KB_TEST_PROCESS_SOCKET,process.execPath,'-e',${JSON.stringify(leaf)}]` : `['-e',${JSON.stringify(leaf)}]`}, {
          stdio:${JSON.stringify(handles === "ignore" ? "ignore" : "inherit")},
          detached:${!registered && process.platform !== "win32"},
        });
        process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});
        setInterval(()=>{},1000);
      `;
        const leader = `
        const fs=require('node:fs');
        ${
          ownership === "portable-nested-session"
            ? `
        const innerRoot = require('node:path').join(require('node:os').tmpdir(), 'nested-owner');
        fs.mkdirSync(innerRoot);
        require('node:child_process').spawn(process.env.KB_TEST_PROCESS_OWNER,
          [innerRoot,process.execPath,'-e',${JSON.stringify(middle)}],{stdio:'inherit'});
        `
            : `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'inherit'});`
        }
        process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
        setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(${ending === "failure" ? 7 : 0})},10);
      `;
        const runner = new URL("./test-clean.mjs", import.meta.url);
        // Windows has no catchable POSIX kill(SIGINT/SIGTERM). Emit the registered
        // Node events over IPC there; Unix exercises actual OS signal delivery.
        const wrapperArgs = [
          "--input-type=module",
          "-e",
          `
        import {runClean} from ${JSON.stringify(runner.href)};
        ${process.platform === "win32" ? "process.on('message', signal => process.emit(signal));" : ""}
        process.exitCode = await runClean(process.execPath, ['-e', ${JSON.stringify(leader)}], {portable:${ownership !== "native"},owner:${JSON.stringify(owner)}});
        ${process.platform === "win32" ? "process.disconnect();" : ""}
      `,
        ];
        const wrapper = spawn(process.execPath, wrapperArgs, {
          stdio:
            process.platform === "win32"
              ? ["ignore", "pipe", "pipe", "ipc"]
              : ["ignore", "pipe", "pipe"],
        });
        const sendSignal = (signal) =>
          process.platform === "win32" ? wrapper.send(signal) : wrapper.kill(signal);
        let output = "";
        wrapper.stdout.on("data", (chunk) => {
          output += chunk;
        });
        wrapper.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const closed = once(wrapper, "close");
        let identity;
        try {
          await until(() => existsSync(ready));
          identity = JSON.parse(readFileSync(ready, "utf8"));
          assert.ok(existsSync(identity.root));
          if (ending === "normal" || ending === "failure") writeFileSync(release, "exit");
          else {
            sendSignal(ending === "repeated-signals" ? "SIGINT" : ending);
            if (ending === "repeated-signals") {
              await new Promise((resolve) => setTimeout(resolve, 30));
              sendSignal("SIGTERM");
            }
          }
          let watchdog;
          let code;
          try {
            [code] = await Promise.race([
              closed,
              new Promise((_, reject) => {
                watchdog = setTimeout(
                  () => reject(new Error(`tree failed to settle: ${output}`)),
                  5000,
                );
              }),
            ]);
          } finally {
            clearTimeout(watchdog);
          }
          // The deliberate leftover remains an error even when its writer was
          // terminated after a normal exit. Inspection must follow tree drain.
          assert.equal(code, 1, output);
          assert.match(output, /tests leaked 1 temp stores/);
          assertReaped(identity.pid);
          assert.equal(existsSync(identity.root), false);
          assert.equal(foreign.exitCode, null);
          assert.equal(foreign.signalCode, null);
        } finally {
          if (wrapper.exitCode === null && wrapper.signalCode === null) {
            sendSignal("SIGTERM");
            await closed;
          }
          foreign.kill();
          await foreignClosed;
          rmSync(external, { recursive: true, force: true });
        }
      });
    }
  }
}

test("cleans its namespace after a failed command admission", async () => {
  await assert.doesNotReject(async () => {
    assert.equal(await runClean("kb-command-that-does-not-exist-r5", []), 127);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} before admission prevents the command and releases its handlers`, async () => {
    const before = process.listenerCount(signal);
    const run = runClean(process.execPath, ["-e", "process.exit(99)"]);
    process.emit(signal);
    assert.equal(await run, 1);
    assert.equal(process.listenerCount(signal), before);
  });
}

test("runs a prepared owner without Cargo or a C compiler on PATH", async () => {
  const script = `
    import {runClean} from ${JSON.stringify(new URL("./test-clean.mjs", import.meta.url).href)};
    process.env.PATH = '/kb-test-no-toolchain';
    process.exitCode = await runClean(process.execPath, ['-e', ''], {owner:${JSON.stringify(owner)}});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: "inherit",
  });
  const [code] = await once(child, "close");
  assert.equal(code, 0);
});
