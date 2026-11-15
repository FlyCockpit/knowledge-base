// Dispatch and stop-signal tests for scripts/docker-entrypoint.sh, without app
// dependencies, a database, Docker or KB volumes. Only the absolute image
// paths (/app/scripts/...) are remapped into a temporary fixture; the shell
// logic is the real script, run by the same /bin/sh the images use. `node`
// (except the `node -p` instance id) and `tini` are recording stubs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const basePath = `${dirname(process.execPath)}:/usr/bin:/bin`;

// The entrypoint repeats a stop's TERM only where /proc exists (have_proc);
// without it each signal sends one TERM, by design, since the images always
// have /proc. Tests of the repeat path therefore skip on hosts without /proc
// (macOS). ENTRYPOINT_TEST_ASSUME_NO_PROC=1, read only here, simulates such a
// host on Linux: those tests skip and every fixture entrypoint runs with its
// /proc detection removed, so the rest exercise the no-/proc fallback.
const procDetection = "if [ -r /proc/self/stat ]; then have_proc=true; fi";
const assumeNoProc = process.env.ENTRYPOINT_TEST_ASSUME_NO_PROC === "1";
const needsProc =
  !assumeNoProc && existsSync("/proc/self/stat")
    ? {}
    : { skip: "needs /proc (Linux); the images always have it" };
/** `test` for the /proc repeat path: skipped (with that reason) without /proc. */
const procTest = (name, fn) => test(name, needsProc, fn);

const serverEnv = {
  DATABASE_URL: "postgresql://fixture:fixture@localhost/fixture",
  REDIS_URL: "redis://localhost",
  BETTER_AUTH_SECRET: "fixture-only",
};
const serverCmd = ["node", "apps/server/dist/index.mjs", "--fenced"];
const workerCmd = ["node", "apps/worker/dist/index.mjs", "--fenced"];
// Every startup-only credential the entrypoint holds for its children.
const startupKeys = {
  BACKUP_S3_ACCESS_KEY_ID: "fixture-only",
  BACKUP_S3_SECRET_ACCESS_KEY: "fixture-only",
  BACKUP_HEARTBEAT_URL: "https://fixture.invalid",
  KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "fixture-only",
  KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "fixture-only",
  KB_ASSET_S3_ACCESS_KEY_ID: "fixture-only",
  KB_ASSET_S3_SECRET_ACCESS_KEY: "fixture-asset-writer",
  BACKUP_S3_BUCKET: "fixture-bucket",
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY: "fixture-monitor",
};

async function entrypointFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "knowledge-base-entrypoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "bin"));
  // `node -p` (the instance id) is real node; every other node call is the
  // recording stub below.
  await writeFile(
    join(dir, "bin", "node"),
    `#!/bin/sh
if [ "$1" = -p ]; then exec '${process.execPath}' "$@"; fi
exec '${process.execPath}' '${join(dir, "command.cjs")}' "$@"
`,
    { mode: 0o755 },
  );
  // tini stub: marks what it starts, then execs it.
  await writeFile(
    join(dir, "bin", "tini"),
    `#!/bin/sh
[ "$1" = -- ] && shift
FIXTURE_TINI=1 exec "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "command.cjs"),
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
const env = process.env;
const log = (entry) => fs.appendFileSync(env.FIXTURE_LOG, JSON.stringify(entry) + '\\n');
log({
  args,
  id: env.KB_INSTANCE_ID ?? null,
  writer: Boolean(env.BACKUP_S3_SECRET_ACCESS_KEY || env.BACKUP_S3_ACCESS_KEY_ID),
  heartbeat: Boolean(env.BACKUP_HEARTBEAT_URL),
  operator: Boolean(env.KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY || env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID),
  assetWriter: env.KB_ASSET_S3_SECRET_ACCESS_KEY ?? null,
  assetWriterId: Boolean(env.KB_ASSET_S3_ACCESS_KEY_ID),
  bucket: env.BACKUP_S3_BUCKET ?? null,
  monitor: Boolean(env.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY),
  tini: Boolean(env.FIXTURE_TINI),
});
const joined = args.join(' ');
// A trailing "$" anchors the match at the end of the command line.
const matches = (pattern) =>
  pattern.endsWith('$') ? joined.endsWith(pattern.slice(0, -1)) : joined.includes(pattern);
if (env.FIXTURE_FAIL && matches(env.FIXTURE_FAIL)) process.exit(1);
if (env.FIXTURE_HANG && matches(env.FIXTURE_HANG)) {
  // A stalled check (a hung data-volume mount): it never finishes on its own.
  process.on('SIGTERM', () => { log({hangTerm: true}); process.exit(143); });
  process.on('SIGINT', () => { log({hangInt: true}); process.exit(130); });
  setInterval(() => {}, 1000);
  console.log('check-started');
}
if (env.FIXTURE_REFUSE && args.includes('apply')) process.exit(7);
if (env.FIXTURE_REFUSE && args.includes('wait')) process.exit(1);
if (env.FIXTURE_HOLD && args.includes('apply')) {
  // The runner: on TERM it aborts and drains its own children before exiting.
  const timer = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => setTimeout(() => {
    log({drained: true});
    clearInterval(timer);
  }, 60));
  setTimeout(() => { clearInterval(timer); process.exitCode = 99; }, 3000).unref();
  console.log('admission-started');
}
`,
  );
  const source = await readFile(join(root, "scripts/docker-entrypoint.sh"), "utf8");
  const script = join(dir, "entrypoint.sh");
  let fixtureSource = source.replaceAll("/app/scripts/", `${dir}/scripts/`);
  if (assumeNoProc) {
    assert.ok(fixtureSource.includes(procDetection), "the /proc detection line exists");
    fixtureSource = fixtureSource.replace(procDetection, "");
  }
  await writeFile(script, fixtureSource);
  await mkdir(join(dir, "scripts/backup"), { recursive: true });
  await mkdir(join(dir, "scripts/lib"), { recursive: true });
  // The entrypoint tests that these exist before it runs them (with the stub).
  await writeFile(join(dir, "scripts/init-kb-volumes.mjs"), "");
  for (const name of ["restore.sh", "pre-migrate.sh"])
    await writeFile(
      join(dir, "scripts/backup", name),
      `#!/bin/sh\nexec node '${dir}/scripts/backup/${name}' "$@"\n`,
    );
  /**
   * @param {string[]} args
   * @param {Record<string, string>} env
   * @param {{ signalOn?: string, signal?: NodeJS.Signals, script?: string, timeoutMs?: number, onSpawn?: (child: import("node:child_process").ChildProcess) => void }} [stop]
   *   send `signal` to the entrypoint once its output contains `signalOn`;
   *   `script` runs a modified copy instead of the entrypoint; `onSpawn` gets
   *   the entrypoint's ChildProcess
   */
  const run = async (args, env = {}, stop = {}) => {
    const log = join(dir, "commands");
    await writeFile(log, "");
    const child = spawn("sh", [stop.script ?? script, ...args], {
      env: { PATH: `${dir}/bin:${basePath}`, FIXTURE_LOG: log, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a hung run is reaped with every fixture child.
      detached: true,
    });
    stop.onSpawn?.(child);
    // The entrypoint's own exit; `close` also waits for every process that
    // still holds its output pipes.
    const exited = new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolveCode(exitCode ?? exitSignal));
    });
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    let output = "";
    let sent = false;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (stop.signalOn && !sent && output.includes(stop.signalOn)) {
        sent = true;
        child.kill(stop.signal ?? "SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let code;
    try {
      // Bounded: a regression that ignores a stop signal fails instead of hanging.
      code = await Promise.race([
        exited,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout("timeout"), stop.timeoutMs ?? 15_000);
        }),
      ]);
      assert.notEqual(code, "timeout", `the entrypoint did not exit in time:\n${output}`);
      // The entrypoint has exited: it must not have left a child running (a
      // stop that never reached the child). Allow 1 s for exits already under
      // way, then fail; the group is reaped either way.
      let survivors = true;
      for (let attempt = 0; attempt < 10 && survivors; attempt++) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        try {
          process.kill(-child.pid, 0);
        } catch {
          survivors = false;
        }
      }
      assert.equal(
        survivors,
        false,
        `processes left running after the entrypoint exited:\n${output}`,
      );
    } finally {
      clearTimeout(timer);
      // Reap the whole group, even after a clean exit: a fixture child left
      // behind would hold the pipes and hang the suite.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone (ESRCH).
      }
      await exited.catch(() => {});
      await closed;
    }
    const lines = (await readFile(log, "utf8")).trim();
    const all = lines ? lines.split("\n").map((line) => JSON.parse(line)) : [];
    const isCheck = (entry) =>
      entry.args?.some(
        (arg) => arg.endsWith("validate-kb-master-key.mjs") || arg.endsWith("init-kb-volumes.mjs"),
      );
    const isNotice = (entry) => entry.args?.includes("--startup-notice");
    const commands = all.filter((entry) => entry.args && !isCheck(entry) && !isNotice(entry));
    return {
      code,
      output,
      all,
      checks: all.filter(isCheck),
      notices: all.filter(isNotice),
      commands,
      runner: commands.filter((entry) => entry.args[0]?.endsWith("db/migrate-runtime.mjs")),
      cmd: commands.filter((entry) => entry.args[0]?.startsWith("apps/")),
    };
  };
  return { dir, run };
}

test("all seven image commands dispatch before normal validation without registering an instance", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  for (const [args, expected] of [
    [["migrate"], ["db/migrate-runtime.mjs", "apply"]],
    [
      ["hold-deletions", "3"],
      ["db/migrate-runtime.mjs", "hold", "3"],
    ],
    [
      ["hold-deletions", "--clear"],
      ["db/migrate-runtime.mjs", "hold", "--clear"],
    ],
    [
      ["backup", "--label", "daily"],
      ["backup/pre-migrate.sh", "--label", "manual", "--label", "daily"],
    ],
    [["backup-schedule"], ["backup/schedule.mjs", "run"]],
    [
      ["restore", "--list"],
      ["backup/restore.sh", "--list"],
    ],
    [
      ["asset-storage", "plan"],
      ["lib/asset-storage-migration.mjs", "plan"],
    ],
    [
      ["restore-drill", "bundle"],
      ["backup/drill.mjs", "bundle"],
    ],
  ]) {
    const result = await run(args, {
      DATABASE_URL: serverEnv.DATABASE_URL,
      ...startupKeys,
      KB_INSTANCE_ID: "inherited-server-id",
    });
    assert.equal(result.code, 0, result.output);
    // The `migrate` job runs the backups notice / check first, like every
    // migrating start; the other one-shots run nothing else.
    const migrate = args[0] === "migrate";
    assert.equal(result.all.length, migrate ? 2 : 1, args.join(" "));
    assert.equal(result.notices.length, migrate ? 1 : 0, args.join(" "));
    if (migrate) {
      assert.deepEqual(result.all[0].args, [
        `${dir}/scripts/backup/pre-migrate.sh`,
        "--startup-notice",
      ]);
      assert.equal(result.notices[0].tini, false, "the check is PID 1's supervised child");
      assert.equal(result.notices[0].assetWriter, null);
    }
    assert.equal(result.checks.length, 0, "one-shots skip the runtime checks");
    assert.deepEqual(result.commands[0].args, [
      `${dir}/scripts/${expected[0]}`,
      ...expected.slice(1),
    ]);
    assert.equal(result.commands[0].id, null);
    // One-shots keep their operator inputs but never the runtime asset writer.
    assert.equal(result.commands[0].writer, true);
    assert.equal(result.commands[0].operator, true);
    assert.equal(result.commands[0].heartbeat, true);
    assert.equal(result.commands[0].assetWriter, null);
    // `migrate` runs the runner as PID 1's child; every other one-shot is
    // exec'd under tini.
    assert.equal(result.commands[0].tini, args[0] !== "migrate", args.join(" "));
  }
  for (const args of [
    ["migrate", "--role", "server"],
    ["backup-schedule", "now"],
  ]) {
    const result = await run(args, serverEnv);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /takes no arguments/);
    assert.equal(result.all.length, 0);
  }
  const refused = await run(["migrate"], { ...serverEnv, FIXTURE_REFUSE: "1" });
  assert.equal(refused.code, 7, "the migrate job exits with the runner's status");
  const noDestination = await run(["migrate"], { ...serverEnv, FIXTURE_FAIL: "--startup-notice" });
  assert.equal(noDestination.code, 1, "a failed backups check fails the migrate job");
  assert.equal(noDestination.runner.length, 0, "the runner never starts");
});

test("server and worker run their checks and apply / wait before the CMD (under tini), with a fresh id and the startup-only keys dropped", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  const env = { ...serverEnv, ...startupKeys, KB_INSTANCE_ID: "inherited-id" };
  const ids = new Set();
  for (const [cmd, role, migrateOnStart, mode] of [
    [serverCmd, "server", undefined, "apply"],
    [serverCmd, "server", "false", "wait"],
    [workerCmd, "worker", undefined, "wait"],
    [workerCmd, "worker", "true", "apply"],
  ]) {
    const result = await run(cmd, {
      ...env,
      ...(migrateOnStart ? { MIGRATE_ON_START: migrateOnStart } : {}),
    });
    assert.equal(result.code, 0, result.output);
    // The backups notice / check runs before every migrating start (apply)
    // and before a waiting server (backups off here); waiting workers skip it.
    const notice = mode === "apply" || role === "server";
    assert.deepEqual(
      result.all.map((entry) => entry.args[0].replace(`${dir}/scripts/`, "")),
      [
        "lib/validate-kb-master-key.mjs",
        "init-kb-volumes.mjs",
        ...(notice ? ["backup/pre-migrate.sh"] : []),
        "db/migrate-runtime.mjs",
        "init-kb-volumes.mjs",
        cmd[1],
      ],
    );
    assert.deepEqual(
      result.notices.map((entry) => [entry.args.slice(1), entry.tini, entry.assetWriter]),
      notice ? [[["--startup-notice"], false, null]] : [],
    );
    assert.deepEqual(result.checks[1].args.slice(1), ["--check-runtime", role]);
    assert.deepEqual(result.runner[0].args.slice(1), [mode, "--role", role]);
    assert.deepEqual(result.cmd[0].args, cmd.slice(1));
    const id = result.runner[0].id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.notEqual(id, "inherited-id");
    assert.equal(result.cmd[0].id, id);
    ids.add(id);
    // The runner is PID 1's child: it holds the backup writer, operator pair
    // and heartbeat, never the runtime asset writer.
    const [runner] = result.runner;
    assert.equal(runner.tini, false, "the runner is PID 1's child, not tini's");
    assert.equal(runner.writer, true);
    assert.equal(runner.operator, true);
    assert.equal(runner.heartbeat, true);
    assert.equal(runner.assetWriter, null);
    for (const check of result.checks) assert.equal(check.tini, false);
    // The CMD runs under tini without the startup-only keys; the bucket and
    // the ListBucket-only monitor key stay for the freshness monitor.
    const [app] = result.cmd;
    assert.equal(app.tini, true);
    assert.equal(app.writer, false);
    assert.equal(app.operator, false);
    assert.equal(app.heartbeat, false);
    assert.equal(app.bucket, "fixture-bucket");
    assert.equal(app.monitor, true);
    assert.equal(app.assetWriter, role === "server" ? "fixture-asset-writer" : null);
    assert.equal(app.assetWriterId, role === "server");
  }
  assert.equal(ids.size, 4);
  // A failed backups check (BACKUP_ENABLED=true, no destination) refuses
  // every migrating start before the runner, the worker's too.
  for (const [cmd, extra] of [
    [serverCmd, {}],
    [workerCmd, { MIGRATE_ON_START: "true" }],
  ]) {
    const failed = await run(cmd, { ...env, ...extra, FIXTURE_FAIL: "--startup-notice" });
    assert.equal(failed.code, 1, failed.output);
    assert.equal(failed.notices.length, 1);
    assert.equal(failed.runner.length, 0, "the runner never starts");
    assert.equal(failed.cmd.length, 0, "the CMD never starts");
  }
  // A waiting server with backups on needs no destination: no check.
  const waiting = await run(serverCmd, {
    ...env,
    BACKUP_ENABLED: "true",
    MIGRATE_ON_START: "false",
  });
  assert.equal(waiting.code, 0, waiting.output);
  assert.equal(waiting.notices.length, 0);
  const refused = await run(serverCmd, { ...env, FIXTURE_REFUSE: "1" });
  assert.equal(refused.code, 7);
  assert.equal(refused.cmd.length, 0, "a refused migration never starts the CMD");
  const waitFailed = await run(workerCmd, { ...env, FIXTURE_REFUSE: "1" });
  assert.equal(waitFailed.code, 1);
  assert.match(waitFailed.output, /FATAL: migration wait failed/);
  assert.equal(waitFailed.cmd.length, 0);
  for (const failing of ["validate-kb-master-key", "--check-runtime"]) {
    const failed = await run(serverCmd, { ...env, FIXTURE_FAIL: failing });
    assert.equal(failed.code, 1, failing);
    assert.equal(failed.runner.length, 0, `${failing}: the runner never starts`);
    assert.equal(failed.cmd.length, 0);
  }
  const missing = await run(serverCmd, { ...env, REDIS_URL: "" });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Missing required environment variable\(s\): REDIS_URL/);
  assert.equal(missing.commands.length, 0);
  const invalid = await run(serverCmd, { ...env, MIGRATE_ON_START: "yes" });
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /MIGRATE_ON_START must be true or false/);
  assert.equal(invalid.commands.length, 0);
});

test("only the server warns about an empty ADMIN_EMAIL in production; the worker never does", async (t) => {
  const { run } = await entrypointFixture(t);
  const warning = /WARNING: ADMIN_EMAIL is empty/;
  for (const [cmd, env, warns] of [
    [serverCmd, { NODE_ENV: "production" }, true],
    [serverCmd, { NODE_ENV: "production", ADMIN_EMAIL: "ops@example.test" }, false],
    [serverCmd, {}, false],
    [workerCmd, { NODE_ENV: "production" }, false],
  ]) {
    const result = await run(cmd, { ...serverEnv, ...env });
    assert.equal(result.code, 0, result.output);
    assert.equal(warning.test(result.output), warns, `${cmd[1]} ${JSON.stringify(env)}`);
  }
});

test("BACKUP_ENABLED is strict for every command, before anything runs", async (t) => {
  const { run } = await entrypointFixture(t);
  for (const args of [["migrate"], ["backup"], ["restore"], serverCmd, workerCmd]) {
    for (const value of ["yes", "TRUE", "1", " true"]) {
      const bad = await run(args, { ...serverEnv, BACKUP_ENABLED: value });
      assert.equal(bad.code, 1, `${args.join(" ")} ${value}`);
      assert.match(bad.output, /BACKUP_ENABLED must be true or false/);
      assert.equal(bad.all.length, 0);
    }
  }
  for (const value of ["true", "false", ""]) {
    const ok = await run(serverCmd, { ...serverEnv, BACKUP_ENABLED: value });
    assert.equal(ok.code, 0, ok.output);
    // A migrating server runs the backups notice / check once, on or off.
    assert.equal(ok.notices.length, 1);
  }
});

for (const [signal, status] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  test(`${signal} during a hanging startup child exits ${status}; the child gets TERM; no later step or the CMD starts`, async (t) => {
    const { run } = await entrypointFixture(t);
    for (const [args, hang] of [
      [serverCmd, "validate-kb-master-key"],
      [workerCmd, "--check-runtime"],
      [serverCmd, "init-kb-volumes.mjs$"],
      [["migrate"], "db/migrate-runtime.mjs apply"],
    ]) {
      const result = await run(
        args,
        { ...serverEnv, FIXTURE_HANG: hang },
        { signalOn: "check-started", signal },
      );
      assert.equal(result.code, status, `${hang}: ${result.output}`);
      // TERM for every stop signal: a background child of sh starts with
      // SIGINT ignored, so only TERM reliably stops it.
      assert.ok(
        result.all.some((entry) => entry.hangTerm),
        `${hang}: the child got TERM: ${JSON.stringify(result.all)}`,
      );
      assert.equal(result.cmd.length, 0, `${hang}: the CMD never started`);
      const hung = result.all.findIndex((entry) => {
        const joined = entry.args?.join(" ") ?? "";
        return hang.endsWith("$") ? joined.endsWith(hang.slice(0, -1)) : joined.includes(hang);
      });
      assert.equal(
        result.all.filter((entry) => entry.args).length,
        hung + 1,
        `${hang}: nothing ran after the hanging child`,
      );
    }
  });
}

test("TERM during migrations is forwarded, PID 1 waits for the runner to drain, then exits 143", async (t) => {
  const { run } = await entrypointFixture(t);
  for (const args of [serverCmd, ["migrate"]]) {
    const result = await run(
      args,
      { ...serverEnv, FIXTURE_HOLD: "1" },
      { signalOn: "admission-started", signal: "SIGTERM" },
    );
    assert.equal(result.code, 143, result.output);
    assert.equal(result.cmd.length, 0, "the CMD never starts");
    assert.ok(result.all.some((entry) => entry.drained));
  }
});

test("stop-signal traps (TERM/INT/HUP) are installed before validation and any child, and cover the fork", async () => {
  const source = await readFile(join(root, "scripts/docker-entrypoint.sh"), "utf8");
  const body = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const traps = [
    "trap 'stop_startup TERM 143' TERM",
    "trap 'stop_startup INT 130' INT",
    "trap 'stop_startup HUP 129' HUP",
  ].map((line) => body.indexOf(line));
  assert.ok(
    traps.every((index) => index > 0),
    "the TERM, INT and HUP traps exist, each keeping its own status",
  );
  const trap = Math.max(...traps);
  // The strict-switch validation and every child come after all three traps.
  for (const step of [
    "BACKUP_ENABLED must be true or false",
    "unset KB_INSTANCE_ID",
    "$(node",
    "supervise node /app/scripts/lib/validate-kb-master-key.mjs",
    'supervise node /app/scripts/init-kb-volumes.mjs --check-runtime "$kb_volume_role"',
    "supervise node /app/scripts/init-kb-volumes.mjs\n",
    'run_runner apply --role "$kb_volume_role"',
    'run_runner wait --role "$kb_volume_role"',
    "run_runner apply ||",
    "exec tini",
  ]) {
    const first = body.indexOf(step);
    assert.ok(first > trap, `${step} comes after the traps`);
  }
  // No startup child runs in the foreground, where a trapped signal would wait
  // for it: every `node` call outside the dispatch is supervised (or the
  // builtin-free `node -p` id), and nothing but tini is exec'd.
  for (const line of body.split("\n").map((entry) => entry.trim())) {
    if (/^(env -u \S+ )?node\s/.test(line)) assert.fail(`unsupervised startup child: ${line}`);
    if (/^exec\s/.test(line)) assert.match(line, /^exec tini -- /, line);
  }
  assert.match(
    body,
    /run_runner\(\) \{ supervise env -u KB_ASSET_S3_SECRET_ACCESS_KEY node \/app\/scripts\/db\/migrate-runtime\.mjs "\$@"; \}/,
  );
  assert.equal(body.trimEnd().split("\n").at(-1), 'exec tini -- "$@"');
  // A signal between the fork and the PID assignment is only recorded (the
  // trap does not exit while a child is being launched); afterwards the child
  // is identified by its start time and gets TERM until it is gone.
  assert.match(
    body,
    /stop_startup\(\) \{\n\s*stop_signal="\$1"\n\s*\[ "\$stopping" = false \] \|\| \[ "\$have_proc" = false \] \|\| return 0\n\s*if \[ -n "\$child_pid" \]; then\n\s*stopping=true\n\s*stop_child\n\s*elif \[ "\$launching_child" = false \]; then\n\s*exit "\$2"\n\s*fi\n\s*\}/,
    "stop_startup only records a signal that lands while a child is launched",
  );
  assert.match(
    body,
    /launching_child=true\n\s*"\$@" &\n\s*child_pid=\$!\n\s*if \[ "\$have_proc" = true \]; then\n\s*proc_start "\$child_pid"\n\s*child_start=\$proc_start_value\n\s*fi\n\s*launching_child=false\n/,
    "supervise records the child's identity before it acts on a pending signal",
  );
  assert.match(
    body,
    /if \[ -n "\$stop_signal" \]; then\n\s*stopping=true\n\s*stop_child\n\s*wait "\$child_pid"/,
    "a pending or interrupting stop signal is forwarded until the child is gone",
  );
  // The trap path (stop_startup -> term_child -> child_alive -> proc_start)
  // never forks: no command substitution or external command in it.
  const fnBody = (name) => body.match(new RegExp(`\\n${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`))?.[1];
  for (const name of ["stop_startup", "term_child", "child_alive", "proc_start"]) {
    const fn = fnBody(name);
    assert.ok(fn, `${name} exists`);
    assert.doesNotMatch(fn, /\$\(|`|\bcat\b|\bsleep\b/, `${name} never forks`);
  }
  // No step resets the handlers to the default (which PID 1 ignores).
  assert.doesNotMatch(body, /trap -( |$)/m);
});

// Copies of the entrypoint with a stop signal injected at the exact gap,
// without production hooks.
async function entrypointCopy(dir, name, edit) {
  const source = await readFile(join(dir, "entrypoint.sh"), "utf8");
  const lines = source.split("\n");
  const out = edit(lines);
  assert.notDeepEqual(out, lines, `${name}: the injection point was not found`);
  const path = join(dir, name);
  await writeFile(path, out.join("\n"));
  return path;
}
const injectBefore = (lines, target, injected) =>
  lines.flatMap((line) => (line.trim() === target ? [injected, line] : [line]));
// The first supervised child of a server start, made to hang.
const hangFirstCheck = { ...serverEnv, FIXTURE_HANG: "validate-kb-master-key" };

for (const [signal, status] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
  ["SIGHUP", 129],
]) {
  const name = signal.slice(3);
  // Every test in this loop needs the /proc repeat path.
  const test = procTest;
  test(`${signal} in the fork window (after the fork, before the PID is known) still stops a hanging startup child; exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    const script = await entrypointCopy(dir, `launch-gap-${name}.sh`, (lines) =>
      injectBefore(lines, "child_pid=$!", `  kill -${name} "$$"`),
    );
    // The TERM reaches the child within microseconds of its fork, where the
    // forked shell can still swallow it with the trap it inherited: a single
    // TERM was lost in about 40% of runs. Repeat the case.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await run(serverCmd, hangFirstCheck, { script, timeoutMs: 8_000 });
      assert.equal(result.code, status, `attempt ${attempt}: ${result.output}`);
      assert.equal(result.commands.length, 0, "neither the runner nor the CMD started");
    }
  });

  test(`${signal}: a child that misses the first TERM is still stopped (the TERM is repeated until it is gone); exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // The child swallows the first TERM it gets (then execs the command),
    // standing in for a TERM swallowed by the forked shell's inherited trap.
    // The stop is sent only once its trap is in place, so the first TERM is
    // always missed, however the processes are scheduled.
    const ready = join(dir, `deaf-ready-${name}`);
    const script = await entrypointCopy(dir, `deaf-child-${name}.sh`, (lines) =>
      injectBefore(
        lines.map((line) =>
          line.trim() === '"$@" &'
            ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
            : line,
        ),
        "child_pid=$!",
        `  while [ ! -e '${ready}' ]; do :; done; kill -${name} "$$"`,
      ),
    );
    assert.match(
      await readFile(script, "utf8"),
      /trap 'n=\$\(\(n \+ 1\)\)' TERM; : > '[^']+'; while \[ "\$n" -lt 1 \]/,
    );
    const result = await run(serverCmd, hangFirstCheck, { script, timeoutMs: 8_000 });
    assert.equal(result.code, status, result.output);
    assert.ok(result.checks.length <= 1);
    assert.equal(result.commands.length, 0, "neither the runner nor the CMD started");
  });

  test(`${signal} just before supervise's wait still stops a child that misses the first TERM; exits ${status}`, async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // The signal lands after the "no stop pending" check, right before
    // `wait`: the handler runs first, then `wait` blocks. The handler must
    // itself repeat the TERM, or the deaf child runs to its end.
    const ready = join(dir, `wait-gap-ready-${name}`);
    const script = await entrypointCopy(dir, `wait-gap-${name}.sh`, (lines) =>
      injectBefore(
        lines.map((line) =>
          line.trim() === '"$@" &'
            ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
            : line,
        ),
        'wait "$child_pid"',
        `    while [ ! -e '${ready}' ]; do :; done; kill -${name} "$$"`,
      ),
    );
    const result = await run(serverCmd, hangFirstCheck, { script, timeoutMs: 8_000 });
    assert.equal(result.code, status, result.output);
    assert.equal(result.commands.length, 0, "neither the runner nor the CMD started");
  });
}

procTest(
  "repeated stop signals while the handler drains a child do not delay the exit; the last one sets the status",
  async (t) => {
    const { run, dir } = await entrypointFixture(t);
    // TERM arrives while supervise waits (as from `docker stop`); the handler
    // then repeats TERM until the child, which swallows the first three, is
    // gone; HUPs arrive during that drain. Each nested trap must only record
    // itself, and must not stretch the 0.2 s pause: in dash a nested trap leaves
    // $? at the outer trap's status (here the interrupted wait's), so the pause
    // cannot branch on sleep's status.
    const ready = join(dir, "drain-ready");
    const script = await entrypointCopy(dir, "drain-repeat.sh", (lines) =>
      lines.map((line) =>
        line.trim() === '"$@" &'
          ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 3 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
          : line,
      ),
    );
    const exists = (path) =>
      readFile(path).then(
        () => true,
        () => false,
      );
    let first = 0;
    // Bounded, and stopped once the run is over (even a failed one).
    let over = false;
    /** @type {Promise<void> | undefined} */
    let sender;
    let result;
    try {
      result = await run(serverCmd, hangFirstCheck, {
        script,
        timeoutMs: 8_000,
        onSpawn: (child) => {
          sender = (async () => {
            const deadline = Date.now() + 8_000;
            while (!over && !(await exists(ready))) {
              if (Date.now() > deadline) return;
              await delay(10);
            }
            if (over) return;
            // Let supervise reach its wait.
            await delay(50);
            first = Date.now();
            child.kill("SIGTERM");
            // One HUP inside each 0.2 s pause of the drain.
            for (let i = 0; i < 3; i++) {
              await delay(i === 0 ? 60 : 200);
              if (over) return;
              child.kill("SIGHUP");
            }
          })();
        },
      });
    } finally {
      over = true;
      await sender;
    }
    const elapsed = Date.now() - first;
    assert.equal(result.code, 129, result.output);
    assert.ok(first > 0, "the child became ready");
    // About 0.6 s (three 0.2 s pauses); each stretched pause would add up to
    // 1 s (2.5 s or more in all).
    assert.ok(elapsed < 1_500, `the entrypoint took ${elapsed} ms after the first stop`);
  },
);

test("without /proc, every stop signal still sends one TERM: a later signal stops a child that swallowed the first", async (t) => {
  const { run, dir } = await entrypointFixture(t);
  // /proc detection forced off (the fallback outside Linux): nothing repeats
  // the TERM, so the stop guard must not swallow a later signal's TERM. The
  // first TERM (recorded during the launch) is swallowed by the child; the
  // second stop signal must stop it.
  const ready = join(dir, "noproc-ready");
  const script = await entrypointCopy(dir, "noproc.sh", (lines) =>
    injectBefore(
      lines.map((line) => {
        if (line.trim() === procDetection) return "";
        return line.trim() === '"$@" &'
          ? `  ( n=0; trap 'n=$((n + 1))' TERM; : > '${ready}'; while [ "$n" -lt 1 ]; do sleep 0.05; done; trap - TERM; exec "$@" ) &`
          : line;
      }),
      "child_pid=$!",
      `  while [ ! -e '${ready}' ]; do :; done; kill -TERM "$$"`,
    ),
  );
  assert.doesNotMatch(await readFile(script, "utf8"), /have_proc=true/);
  const exists = (path) =>
    readFile(path).then(
      () => true,
      () => false,
    );
  let over = false;
  /** @type {Promise<void> | undefined} */
  let sender;
  let result;
  try {
    result = await run(serverCmd, hangFirstCheck, {
      script,
      timeoutMs: 8_000,
      onSpawn: (child) => {
        sender = (async () => {
          const deadline = Date.now() + 8_000;
          while (!over && !(await exists(ready))) {
            if (Date.now() > deadline) return;
            await delay(10);
          }
          // The first TERM has been swallowed by now; then a second stop.
          await delay(300);
          if (!over) child.kill("SIGHUP");
        })();
      },
    });
  } finally {
    over = true;
    await sender;
  }
  assert.equal(result.code, 129, result.output);
  assert.ok(result.checks.length <= 1);
});
