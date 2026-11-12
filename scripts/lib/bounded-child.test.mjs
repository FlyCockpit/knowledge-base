import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { boundedChild } from "./bounded-child.mjs";

const helper = fileURLToPath(new URL("./owned-child.sh", import.meta.url));
function channelScenario(body, files = {}, expected = 0) {
  const directory = mkdtempSync(join(tmpdir(), "owned-child-test-"));
  try {
    for (const [name, source] of Object.entries(files))
      writeFileSync(join(directory, name), source);
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-ceu",
        `
      source "$HELPER"
      channel="$FIXTURE/control"
      ready() { for ((i=0; i<500; i++)); do [ -f "$1" ] && return; sleep 0.01; done; return 1; }
      ${body}
    `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          PS1: "",
          TMPDIR: directory,
          FIXTURE: directory,
          HELPER: helper,
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return { ...result, remaining: readdirSync(directory) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("shell channels preserve result/status after Bash has already reaped the child", () => {
  for (const status of [0, 41]) {
    channelScenario(
      `
      owned_child_open "$channel" 6
      owned_child_run "$channel" 6 native 0 node "$FIXTURE/child.mjs" & child=$!
      ready "$channel.drained"
      # A foreground shell command gives Bash a chance to reap the supervisor.
      for ((i=0; i<500; i++)); do [ ! -e "/proc/$child" ] && break; sleep 0.01; done
      [ ! -e "/proc/$child" ]
      # This is the defect boundary: the PID is gone, but wait retains status.
      # An inert kill sentinel rejects every attempted terminating shell signal.
      kill() { touch "$FIXTURE/unsafe-shell-signal"; return 99; }
      owned_child_cancel 6
      owned_child_cancel 6
      result=0; owned_child_wait "$channel" 6 "$child" || result=$?
      [ "$result" = ${status} ]
      [ ! -e "$FIXTURE/unsafe-shell-signal" ]
      owned_child_clear "$channel"
      [ ! -e "$channel" ]
    `,
      { "child.mjs": `process.stdout.write('result-bytes'); process.exit(${status});` },
    );
  }
});

test("queued cancellation before supervisor startup prevents command admission", () => {
  channelScenario(
    `
    owned_child_open "$channel" 6
    # Keep the inherited descriptor until exec, but queue a request beforehand.
    printf x >&6
    owned_child_run "$channel" 6 native 0 node "$FIXTURE/child.mjs" & child=$!
    status=0; owned_child_wait "$channel" 6 "$child" || status=$?
    [ "$status" -ne 0 ]
    [ ! -e "$FIXTURE/admitted" ]
    owned_child_clear "$channel"
  `,
    {
      "child.mjs":
        "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FIXTURE + '/admitted', 'bad')",
    },
  );
});

test("live native client drains through cancellation and descriptor EOF", () => {
  for (const cancel of [
    "owned_child_cancel 6",
    "exec 6>&-",
    'rm -f "$channel"; owned_child_cancel 6',
  ]) {
    channelScenario(
      `
      owned_child_open "$channel" 6
      owned_child_run "$channel" 6 native 0 node "$FIXTURE/child.mjs" & child=$!
      ready "$FIXTURE/ready"
      ${cancel}
      status=0; owned_child_wait "$channel" 6 "$child" || status=$?
      [ "$status" -ne 0 ]
      [ -f "$FIXTURE/stopped" ]
      owned_child_clear "$channel"
    `,
      {
        "child.mjs": `import {writeFileSync} from 'node:fs';
      process.on('SIGTERM', () => { writeFileSync(process.env.FIXTURE + '/stopped', 'yes'); process.exit(0); });
      writeFileSync(process.env.FIXTURE + '/ready', 'yes'); setInterval(() => {}, 1000);`,
      },
    );
  }
});

test("native deadline drains before acknowledgement and repeated signals remain idempotent", () => {
  channelScenario(`
    owned_child_open "$channel" 6
    owned_child_run "$channel" 6 native 50 node -e 'setInterval(() => {}, 1000)' & child=$!
    status=0; owned_child_wait "$channel" 6 "$child" || status=$?
    [ "$status" -ne 0 ]
    owned_child_clear "$channel"
  `);
});

test("cooperative nested parents wait past the native escalation before deleting artifacts", () => {
  channelScenario(
    `
    owned_child_open "$channel" 8
    owned_child_run "$channel" 8 cooperative 0 bash "$FIXTURE/parent.sh" & child=$!
    ready "$FIXTURE/ready"
    owned_child_cancel 8
    status=0; owned_child_wait "$channel" 8 "$child" || status=$?
    [ "$status" -ne 0 ]
    [ -f "$FIXTURE/parent-drained" ]
    owned_child_clear "$channel"
  `,
    {
      "parent.sh": `set -eu
      source "$HELPER"
      channel="$FIXTURE/inner-control"
      child=""
      trap 'trap "" HUP INT TERM; owned_child_cancel 6; owned_child_wait "$channel" 6 "$child" || true; sleep 0.1; touch "$FIXTURE/parent-drained"; exit 143' TERM
      owned_child_open "$channel" 6
      owned_child_run "$channel" 6 native 0 node "$FIXTURE/child.mjs" & child=$!
      wait "$child"
    `,
      "child.mjs": `import {writeFileSync} from 'node:fs'; process.on('SIGTERM', () => {});
      writeFileSync(process.env.FIXTURE + '/ready', 'yes'); setInterval(() => {}, 1000);`,
    },
  );
});

test("missing drain acknowledgement fails closed, including cooperative fatal signals", () => {
  for (const command of ["exit 125", "kill -KILL $$"]) {
    channelScenario(`
      owned_child_open "$channel" 6
      owned_child_run "$channel" 6 cooperative 0 bash -c '${command}' & child=$!
      status=0; owned_child_wait "$channel" 6 "$child" || status=$?
      [ "$status" = 125 ]
      [ ! -e "$channel.drained" ]
      if owned_child_clear "$channel"; then exit 42; fi
      [ -p "$channel" ]
    `);
  }
});

test("every production shell cancellation site uses channels, never stored PID signals", () => {
  for (const url of [
    new URL("../backup.sh", import.meta.url),
    new URL("./owned-child.sh", import.meta.url),
  ]) {
    const source = readFileSync(url, "utf8");
    assert.doesNotMatch(source, /\bkill\s+(?!-0\b)[^\n]*\$(?:\{|[A-Za-z_])/);
  }
});

test("natural supervisor errors cannot acknowledge a child before it closes", async () => {
  const owner = boundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  let settled = false;
  const done = owner.done.catch(() => {
    settled = true;
  });
  owner.child.emit("error", new Error("inert signal delivery error"));
  await new Promise(setImmediate);
  assert.equal(settled, false);
  owner.stop();
  await done;
  assert.notEqual(owner.child.signalCode, null);
});

test("native client success, failure, pre-start cancellation and timed cancellation", async () => {
  await boundedChild(process.execPath, ["-e", "process.exit(0)"], { timeout: 2_000 }).done;
  await assert.rejects(boundedChild(process.execPath, ["-e", "process.exit(1)"]).done);
  assert.throws(
    () => boundedChild(process.execPath, [], { signal: AbortSignal.abort() }),
    /before start/,
  );
  const owner = boundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeout: 100,
  });
  await assert.rejects(owner.done);
  assert.ok(owner.child.signalCode);
});

test("a native client ignoring TERM is killed and reaped before cancellation completes", async () => {
  const abort = new AbortController();
  const owner = boundedChild(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ],
    {
      signal: abort.signal,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  owner.child.stdout.once("data", () => abort.abort());
  await assert.rejects(owner.done);
  assert.equal(owner.child.signalCode, "SIGKILL");
});

test("lock-owner wrapper exits on client failure even if its command FIFO is still open", async () => {
  const script = fileURLToPath(new URL("./bounded-child.mjs", import.meta.url));
  const owner = boundedChild(
    process.execPath,
    [script, "0", "--close-input", process.execPath, "-e", "process.exit(0)"],
    { timeout: 2_000, stdio: ["pipe", "ignore", "ignore"] },
  );
  await owner.done;
});

test("lock-owner EOF bounds an unresponsive native client's drain", async () => {
  const script = fileURLToPath(new URL("./bounded-child.mjs", import.meta.url));
  const owner = boundedChild(
    process.execPath,
    [
      script,
      "0",
      "--close-input",
      process.execPath,
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    { timeout: 15_000, stdio: ["pipe", "ignore", "ignore"] },
  );
  owner.child.stdin.end();
  await assert.rejects(owner.done);
  assert.equal(owner.child.exitCode, 1);
});

// flk3: diagnosis must survive the same final-close boundary as cancellation.
test("native failures distinguish deadline, cancellation, exit and spawn error without argv", async () => {
  const timeout = boundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeout: 50,
    stdio: "ignore",
  });
  await assert.rejects(timeout.done, { code: "CHILD_DEADLINE", timeout: 50 });
  const abort = new AbortController();
  const cancelled = boundedChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: abort.signal,
    stdio: "ignore",
  });
  abort.abort();
  await assert.rejects(cancelled.done, { code: "CHILD_CANCELLED" });
  await assert.rejects(
    boundedChild(process.execPath, ["-e", "process.exit(17)"], { stdio: "ignore" }).done,
    { code: "CHILD_EXIT", exitCode: 17 },
  );
  await assert.rejects(
    boundedChild("/missing/flk3-client", ["disposable-argv-canary"], { stdio: "ignore" }).done,
    (error) =>
      error.code === "CHILD_SPAWN" &&
      error.cause.code === "ENOENT" &&
      !JSON.stringify(error).includes("disposable-argv-canary"),
  );
});

test("owned hard stop bypasses an adapted kill handle and still waits for pipe close", async () => {
  const owner = boundedChild(
    process.execPath,
    ["-e", "process.stdin.resume(); console.log('ready')"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const done = assert.rejects(owner.done, {
    code: "CHILD_CLI_STOP",
    exitCode: null,
    signal: "SIGKILL",
  });
  await new Promise((resolve) => owner.child.stdout.once("data", resolve));
  let ended = false;
  owner.child.stdout.once("end", () => {
    ended = true;
  });
  owner.child.kill = () => {
    throw new Error("client adapter must not intercept owned termination");
  };
  owner.stop("CHILD_CLI_STOP", "SIGKILL");
  owner.stop("CHILD_CLI_STOP", "SIGKILL");
  await done;
  assert.equal(ended, true);
  assert.throws(() => process.kill(owner.child.pid, 0), /ESRCH/);
});

test("failed private channel allocation never admits a child", () => {
  channelScenario(`
    touch "$channel"
    if owned_child_open "$channel" 6; then exit 42; fi
    [ ! -e "$FIXTURE/admitted" ]
  `);
});
