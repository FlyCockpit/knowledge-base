import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { linuxOnlyTest } from "./linux-only.mjs";

// host.sh is Linux-only (the deployment server): see linux-only.mjs.
const test = linuxOnlyTest(import.meta.url);

const host = fileURLToPath(new URL("./host.sh", import.meta.url));
const project = "knowledge-base-prod";
const attempt = "11111111-2222-4333-8444-555555555555";
const base = {};

// Docker is an inert inspect fixture. No real Docker, database or credential IO.
// A bash script, not Node: host.sh calls docker a dozen times per run, and a
// Node start per call was most of this file's time. The fixture arrives as
// HOST_FIXTURE_* variables (fixtureEnv). Each call appends
// "<argc>\0<arg>\0…" to $CALLS; `run` writes "<argc>\0<arg>\0…<env-file names>"
// to $RESULT.
const dockerStub = `#!/usr/bin/env bash
project=${project}
has() { local want=$1 arg; shift; for arg in "$@"; do [ "$arg" = "$want" ] && return 0; done; return 1; }
{ printf '%s\\0' "$#" "$@"; } >>"$CALLS"
case "$1" in
  ps)
    svc=
    for arg in "$@"; do
      case "$arg" in label=com.docker.compose.service=*) svc=\${arg##*=}; break ;; esac
    done
    # Without -a, docker ps lists running containers only.
    listed() { if has -a "$@" || ! has "$id" $HOST_FIXTURE_STOPPED; then echo "$id"; fi; }
    if ! has "label=com.docker.compose.project=$project" "$@"; then
      if [ -n "\${HOST_FIXTURE_PROJECTS+set}" ]; then printf '%s' "$HOST_FIXTURE_PROJECTS"
      else printf '%s\\n' "$project"; fi
    elif has label=io.knowledge-base.role=server "$@"; then id=server-id listed "$@"
    elif [ "$svc" = postgres ]; then id=pg-id listed "$@"
    elif [ "$svc" = worker ]; then id=worker-id listed "$@"
    elif [ "$svc" = backup ]; then id=backup-id listed "$@"
    fi ;;
  inspect)
    template=$3
    if [[ $template == *.Mounts* ]]; then
      if [[ $template == */var/lib/kb* ]]; then echo /srv/kb-data
      elif [ -n "\${HOST_FIXTURE_NO_BACKUPS:-}" ]; then echo
      else echo /srv/kb-backups; fi
    elif [[ $template == *.Config.Env* ]]; then
      # Format and value apart, so the line reads as no literal database URL.
      printf 'DATABASE_URL=%s\\n' postgresql://writer:fixture@postgres:5432/kb
      echo KB_DATA_ROOT=/var/lib/kb
      if [ -z "\${HOST_FIXTURE_NO_BACKUP_DIR:-}" ]; then echo BACKUP_DIR=/app/backups; fi
      printf '%s\\n' KB_MASTER_KEY=fixture-key KB_INSTANCE_ID=fixture-instance \\
        KB_ASSET_S3_SECRET_ACCESS_KEY=fixture-asset-secret UNRELATED_SECRET=fixture-unrelated
    elif [[ $template == *.NetworkSettings.Networks* ]]; then echo kb_private
    elif [[ $template == *.Image* ]]; then echo image-id
    elif [[ $template == *project.working_dir* ]]; then echo "\${HOST_FIXTURE_WORKING_DIR-<no value>}"
    elif [[ $template == *compose.service* ]]; then echo "\${HOST_FIXTURE_SERVICE-<no value>}"
    elif [[ $template == *config_files* ]]; then echo "\${HOST_FIXTURE_CONFIG_FILES-<no value>}"
    else exit 2
    fi ;;
  image)
    if [ "$2" != inspect ]; then exit 3; fi
    if [ -n "\${HOST_FIXTURE_IMAGE_GONE:-}" ]; then exit 1; fi ;;
  run)
    names=
    for ((index=1; index<=$#; index++)); do
      if [ "\${!index}" = --env-file ]; then
        next=$((index + 1)); names=$(cut -d= -f1 "\${!next}"); break
      fi
    done
    { printf '%s\\0' "$#" "$@"; printf '%s' "$names"; } >"$RESULT"
    if [ -n "\${MARK_RUN:-}" ]; then : >"$MARK_RUN"; sleep 0.3; fi
    if has restore "$@" && has /run/kb-restore.identity "$@"; then exit "\${HOST_FIXTURE_RESTORE_EXIT:-0}"; fi ;;
  stop)
    # Once: the first stop (after the prompt) is interrupted by a signal.
    if [ -n "\${HOST_FIXTURE_STOP_SIGNAL:-}" ] && [ ! -e "$CALLS.signalled" ]; then
      : >"$CALLS.signalled"
      kill -s "$HOST_FIXTURE_STOP_SIGNAL" "$PPID"
    fi
    if [ -n "\${MARK:-}" ]; then
      : >"$MARK"
      # Give the reader time to leave before the shell's next write.
      sleep 0.3
    fi
    exit "\${HOST_FIXTURE_STOP_EXIT:-0}" ;;
  info)
    if [ -n "\${HOST_FIXTURE_DOCKER_DOWN:-}" ]; then exit 1; fi ;;
  start) ;;
  *) exit 3 ;;
esac
exit 0
`;

const FIXTURE_ENV = {
  dockerDown: "HOST_FIXTURE_DOCKER_DOWN",
  projects: "HOST_FIXTURE_PROJECTS",
  stopped: "HOST_FIXTURE_STOPPED",
  noBackups: "HOST_FIXTURE_NO_BACKUPS",
  noBackupDir: "HOST_FIXTURE_NO_BACKUP_DIR",
  imageGone: "HOST_FIXTURE_IMAGE_GONE",
  workingDir: "HOST_FIXTURE_WORKING_DIR",
  service: "HOST_FIXTURE_SERVICE",
  configFiles: "HOST_FIXTURE_CONFIG_FILES",
  restoreExit: "HOST_FIXTURE_RESTORE_EXIT",
  stopSignal: "HOST_FIXTURE_STOP_SIGNAL",
  stopExit: "HOST_FIXTURE_STOP_EXIT",
};

/** The fixture as the stub's environment; an unknown key is a test bug. */
function fixtureEnv(fixture) {
  const env = {};
  for (const [key, value] of Object.entries(fixture)) {
    const name = FIXTURE_ENV[key];
    if (name === undefined) throw new Error(`unknown host fixture key ${key}`);
    if (value === undefined || value === false) continue;
    env[name] = Array.isArray(value) ? value.join(" ") : value === true ? "1" : String(value);
  }
  return env;
}

/** NUL-separated "<argc>\0<arg>\0…" records, and what follows the last one. */
function parseCalls(text) {
  const fields = text.split("\0");
  const calls = [];
  let at = 0;
  while (at < fields.length - 1) {
    const count = Number(fields[at++]);
    calls.push(fields.slice(at, at + count));
    at += count;
  }
  return { calls, rest: fields.slice(at).join("\0") };
}

/**
 * Real host.sh functions (sourced, then `body`), inert Docker boundary on an
 * isolated PATH entry; only disposable fake values. Bounded: a hung run is
 * killed with SIGKILL (its traps may hold a SIGTERM pending), and the scratch
 * directory is always removed.
 */
function run(
  fixture = base,
  {
    body = `main list --project ${project}`,
    input = "",
    markOnStop = false,
    markOnRun = false,
    gone = false,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "kb-host-test-"));
  try {
    writeFileSync(join(dir, "docker"), dockerStub);
    chmodSync(join(dir, "docker"), 0o755);
    const identity = join(dir, "identity");
    writeFileSync(identity, "fixture identity\n");
    // Node starts children with SIGPIPE ignored; a terminal shell has it at the
    // default (fatal), so restore that before bash starts (GNU env, Linux-only).
    const result = spawnSync(
      "env",
      ["--default-signal=PIPE", "bash", "-c", `source "$1"\n${body}`, "host-test", host],
      {
        encoding: "utf8",
        input,
        timeout: 20_000,
        killSignal: "SIGKILL",
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          IDENTITY: identity,
          ...fixtureEnv(fixture),
          RESULT: join(dir, "result"),
          CALLS: join(dir, "calls"),
          ...(markOnStop ? { MARK: join(dir, "stopped") } : {}),
          ...(markOnRun ? { MARK_RUN: join(dir, "restoring") } : {}),
          ...(gone ? { HOST_TEST_GONE: join(dir, "reader-gone") } : {}),
        },
      },
    );
    let invocation = null;
    try {
      const {
        calls: [args],
        rest,
      } = parseCalls(readFileSync(join(dir, "result"), "utf8"));
      invocation = { args, names: rest.split("\n").filter(Boolean).sort() };
    } catch {}
    let calls = [];
    try {
      calls = parseCalls(readFileSync(join(dir, "calls"), "utf8")).calls;
    } catch {}
    return { ...result, invocation, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const verbs = (result, keep = ["stop", "start", "run", "restart", "kill"]) =>
  result.calls.map((args) => args[0]).filter((verb) => keep.includes(verb));
const targets = (result, verb) =>
  result.calls.filter((args) => args[0] === verb).map((args) => args.at(-1));
const writerIds = ["server-id", "worker-id", "backup-id"];
const restoreArgs = `/app/backups/daily.age "$IDENTITY" ${attempt} --project ${project}`;
const restoreCall = `main restore ${restoreArgs}`;
// The terminal check and the typed answer are seams; everything else is real.
const confirmed = `stdin_is_terminal() { return 0; }\nread_answer() { answer=${project}; }`;
const restoreBody = `${confirmed}\n${restoreCall}`;

test("the Docker stub refuses commands it does not model", () => {
  // host.sh calling an unmodelled Docker command must fail loudly, not pass.
  for (const command of ["frobnicate", "image rm image-id", "volume ls"]) {
    const result = run(base, { body: `docker ${command}` });
    assert.equal(result.status, 3, command);
  }
  assert.equal(run(base, { body: "docker image inspect image-id" }).status, 0);
});

test("host can be sourced without discovering or changing anything", () => {
  const result = run(base, { body: ":" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("host rejects an unknown command, an incomplete --project and bad restore args before Docker", () => {
  for (const [body, message] of [
    ["main unknown", /Choose list/],
    ["main", /Choose list/],
    ["main list --project", /needs a name/],
    [`main restore latest "$IDENTITY"`, /same attempt UUID/],
    [`main drill latest "$IDENTITY" extra`, /only source and identity/],
  ]) {
    const result = run(base, { body });
    assert.equal(result.status, 1, body);
    assert.match(result.stderr, message, body);
    assert.deepEqual(result.calls, [], body);
  }
});

test("host stops before discovery when it cannot talk to Docker", () => {
  // Without the check, a failing `docker ps` inside the discovery read is
  // invisible to set -e and surfaces as a misleading "exactly one deployment".
  const result = run({ dockerDown: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cannot talk to Docker/);
  assert.doesNotMatch(result.stderr, /exactly one deployment|Expected one server/);
  assert.deepEqual(
    result.calls.map((args) => args[0]),
    ["info"],
  );
  assert.equal(result.invocation, null);
});

test("host refuses Docker results missing compose project labels", () => {
  // Unlabelled results are ignored, so the one labelled project is selected.
  const result = run({ projects: `\n<no value>\n${project}\n` }, { body: "main list" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.invocation);
  const none = run({ projects: "\n<no value>\n" }, { body: "main list" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /exactly one deployment/);
  assert.equal(none.invocation, null);
});

test("host forwards only the KB allowlist through the private Postgres network", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const args = result.invocation.args;
  assert.equal(args[args.indexOf("--network") + 1], "kb_private");
  assert.ok(args.includes("type=bind,src=/srv/kb-data,dst=/var/lib/kb"), args.join(" "));
  assert.ok(args.includes("type=bind,src=/srv/kb-backups,dst=/app/backups"), args.join(" "));
  assert.deepEqual(result.invocation.names, [
    "BACKUP_DIR",
    "DATABASE_URL",
    "KB_DATA_ROOT",
    "KB_MASTER_KEY",
  ]);
});

test("host stops with the recreate command when the server's image is gone; never falls back to the tag", () => {
  const gone = {
    imageGone: true,
    workingDir: "/etc/dokploy/compose/kb prod/code",
    service: "kb-web",
    configFiles: "/etc/dokploy/compose/kb prod/code/docker-compose.dokploy.yml,/srv/override.yml",
  };
  for (const body of [
    `main list --project ${project}`,
    `main backup --project ${project}`,
    `main drill latest "$IDENTITY" --project ${project}`,
    restoreBody,
  ]) {
    const result = run(gone, { body });
    assert.equal(result.status, 1, body);
    assert.match(result.stderr, /image \(image-id\) is no longer on this machine/, body);
    assert.ok(
      result.stderr.includes(
        `cd /etc/dokploy/compose/kb\\ prod/code && docker compose -p ${project} -f /etc/dokploy/compose/kb\\ prod/code/docker-compose.dokploy.yml -f /srv/override.yml up -d --no-build --force-recreate kb-web`,
      ),
      result.stderr,
    );
    assert.deepEqual(verbs(result), [], `${body}: nothing ran, stopped or started`);
    assert.equal(result.invocation, null, body);
  }
  // Without the compose labels the placeholders are printed verbatim, unquoted.
  const unlabelled = run({ imageGone: true });
  assert.equal(unlabelled.status, 1);
  assert.ok(
    unlabelled.stderr.includes(
      "cd <the compose's directory> && docker compose -p knowledge-base-prod -f <the deploy's compose file> up -d --no-build --force-recreate <the server's compose service>",
    ),
    unlabelled.stderr,
  );
});

test("host restore refuses before stopping anything when stdin is not a terminal", () => {
  // spawnSync gives the script a pipe for stdin: the real stdin_is_terminal.
  const result = run(base, { body: restoreCall, input: `${project}\n` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use a terminal/);
  assert.deepEqual(verbs(result), []);
});

test("host restore starts the writers again after a completed restore, stopping each first", () => {
  const result = run(base, { body: restoreBody });
  assert.equal(result.status, 0, result.stderr);
  // The restart waits for each writer's stop (idempotent) before starting it:
  // an interrupted `docker stop` would otherwise make the start a no-op on a
  // container that then exits (the stop-then-start race).
  assert.deepEqual(
    result.calls
      .filter((args) => ["stop", "start", "run"].includes(args[0]))
      .map((args) => `${args[0]} ${args[0] === "run" ? "" : args.at(-1)}`.trim()),
    [
      "stop server-id",
      "stop worker-id",
      "stop backup-id",
      "run",
      "stop server-id",
      "start server-id",
      "stop worker-id",
      "start worker-id",
      "stop backup-id",
      "start backup-id",
    ],
  );
  assert.deepEqual(result.invocation.args.slice(-4), [
    "restore",
    "/app/backups/daily.age",
    "/run/kb-restore.identity",
    attempt,
  ]);
  assert.ok(!result.calls.some((args) => args.includes("pg-id") && args[0] !== "inspect"));
  assert.match(result.stderr, /Restore done[\s\S]*Started the writers again/);
});

test("host restore: a completed retry starts writers an earlier failed attempt left stopped", () => {
  // The failed attempt kept every writer stopped; the retry must find them (ps -a).
  const result = run({ ...base, stopped: writerIds, restoreExit: 0 }, { body: restoreBody });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(targets(result, "start").sort(), [...writerIds].sort());
});

test("host without a backups mount: hold-deletions works; list, backup, restore and drill refuse before any one-off container", () => {
  for (const fixture of [
    { ...base, noBackups: true },
    { ...base, noBackupDir: true },
  ]) {
    const hold = run(fixture, { body: `main hold-deletions 7 --project ${project}` });
    assert.equal(hold.status, 0, hold.stderr);
    assert.ok(hold.invocation.args.includes("hold-deletions"));
    assert.ok(!hold.invocation.args.some((arg) => arg.includes("/srv/kb-backups")));
    for (const body of [
      `main list --project ${project}`,
      `main backup --project ${project}`,
      `${confirmed}\n${restoreCall}`,
      `main drill /app/backups/daily.age "$IDENTITY" --project ${project}`,
    ]) {
      const refused = run(fixture, { body });
      assert.equal(refused.status, 1, body);
      assert.match(refused.stderr, /no backups mount[\s\S]*--backups true/, body);
      assert.equal(refused.invocation, null, body);
      assert.deepEqual(verbs(refused), [], body);
    }
  }
});

test("host restore starts the writers again after a refusal (3) that changed nothing", () => {
  const result = run({ ...base, restoreExit: 3 }, { body: restoreBody });
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(
    result.calls
      .filter((args) => ["stop", "start", "run"].includes(args[0]))
      .map((args) => `${args[0]} ${args[0] === "run" ? "" : args.at(-1)}`.trim()),
    [
      "stop server-id",
      "stop worker-id",
      "stop backup-id",
      "run",
      "stop server-id",
      "start server-id",
      "stop worker-id",
      "start worker-id",
      "stop backup-id",
      "start backup-id",
    ],
  );
  assert.match(result.stderr, /Refused; nothing was changed[\s\S]*Started the writers again/);
  assert.doesNotMatch(result.stderr, /did not finish|Restore done/);
});

test("host restore: a refusal (3) starts again only the writers that were running before", () => {
  // An earlier failed attempt left every writer stopped: a refused retry
  // (e.g. a mistyped bundle) must not start them against a pending restore.
  const allStopped = run({ ...base, stopped: writerIds, restoreExit: 3 }, { body: restoreBody });
  assert.equal(allStopped.status, 3, allStopped.stderr);
  assert.deepEqual(targets(allStopped, "start"), []);
  assert.match(
    allStopped.stderr,
    /Left stopped \(they were not running before\): server-id worker-id backup-id/,
  );
  assert.doesNotMatch(allStopped.stderr, /Started the writers again/);
  // An operator-stopped backup service stays stopped; the rest start again.
  const backupStopped = run(
    { ...base, stopped: ["backup-id"], restoreExit: 3 },
    { body: restoreBody },
  );
  assert.equal(backupStopped.status, 3, backupStopped.stderr);
  assert.deepEqual(targets(backupStopped, "start"), ["server-id", "worker-id"]);
  assert.match(
    backupStopped.stderr,
    /Started the writers again[\s\S]*Left stopped \(they were not running before\): backup-id/,
  );
  // A completed restore still starts every one of them.
  const completed = run({ ...base, stopped: ["backup-id"], restoreExit: 0 }, { body: restoreBody });
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(targets(completed, "start"), writerIds);
});

test("host keeps the writers stopped after any other restore exit and prints start + retry", () => {
  for (const restoreExit of [1, 2, 7, 125, 129, 130, 143]) {
    const result = run({ restoreExit }, { body: restoreBody });
    assert.equal(result.status, restoreExit, result.stderr);
    assert.deepEqual(verbs(result), ["stop", "stop", "stop", "run"], String(restoreExit));
    assert.match(
      result.stderr,
      new RegExp(`did not finish \\(exit ${restoreExit}\\)\\. The writers stay stopped`),
    );
    assert.match(result.stderr, new RegExp(`same source and attempt UUID[\\s\\S]*${attempt}`));
    assert.match(result.stderr, /docker start server-id worker-id backup-id/);
    assert.doesNotMatch(result.stderr, /Started the writers again|Restore done/);
    if (restoreExit === 125) assert.match(result.stderr, /docker run failed \(exit 125\)/);
  }
});

// The typed answer arrives on stdin; read_answer is the real one.
const promptRestore = `stdin_is_terminal() { return 0; }\n${restoreCall}`;
const cancelLine = "[kb-host] Cancelled. Nothing was changed; no writer was stopped.\n";

test("host restore: declining the typed-project prompt (other text, Enter, EOF) exits 3, nothing stopped", () => {
  for (const [label, input] of [
    ["n", "n\n"],
    ["other project", "knowledge-base-staging\n"],
    ["empty input", "\n"],
    ["EOF", ""],
  ]) {
    const result = run(base, { body: promptRestore, input });
    assert.equal(result.status, 3, `${label}: ${result.stderr}`);
    assert.deepEqual(verbs(result), [], label);
    assert.ok(result.stdout.endsWith(cancelLine), `${label}: ${result.stdout}`);
    assert.doesNotMatch(result.stderr, /\[kb-host\]/, label);
  }
  const accepted = run(base, { body: promptRestore, input: `${project}\n` });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(verbs(accepted).slice(0, 4), ["stop", "stop", "stop", "run"]);
});

test("host restore: a declined prompt still exits 3 through `| tee` (pipefail / PIPESTATUS)", () => {
  for (const [label, input] of [
    ["n", "n\n"],
    ["EOF", ""],
  ]) {
    for (const tail of [
      `set -o pipefail\nmain restore ${restoreArgs} | cat\nexit $?`,
      `set +o pipefail\nmain restore ${restoreArgs} | cat\nexit "\${PIPESTATUS[0]}"`,
    ]) {
      const result = run(base, { body: `stdin_is_terminal() { return 0; }\n${tail}`, input });
      assert.equal(result.status, 3, `${label}: ${result.stderr}`);
      assert.match(result.stdout, /Cancelled\. Nothing was changed/, label);
      assert.deepEqual(verbs(result), [], label);
    }
  }
});

test("host restore: a completed or failed restore keeps its exit status through `| tee`", () => {
  for (const restoreExit of [0, 1]) {
    const result = run(
      { restoreExit },
      { body: `${confirmed}\nmain restore ${restoreArgs} | cat\nexit "\${PIPESTATUS[0]}"` },
    );
    assert.equal(result.status, restoreExit, result.stderr);
  }
});

// A reader that leaves after the first line and closes its end of the pipe.
const leavingReader = `| { read -r _ || true; exec 0<&-; touch "$HOST_TEST_GONE"; }`;

test("host restore: a declined prompt exits 3 even when the `| tee` reader left while it waited", () => {
  const result = run(base, {
    body: `stdin_is_terminal() { return 0; }
read_answer() { echo banner; until [ -f "$HOST_TEST_GONE" ]; do sleep 0.05; done; read -r answer; }
main restore ${restoreArgs} ${leavingReader}
exit "\${PIPESTATUS[0]}"`,
    input: "n\n",
    gone: true,
  });
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(verbs(result), []);
});

const promptSignals = [
  ["SIGINT", "INT"],
  ["SIGTERM", "TERM"],
  ["SIGHUP", "HUP"],
];
// The prompt waits on a reader that never answers and never reaches EOF while
// this shell lives (an EOF would cancel with 3 too, hiding an ignored signal:
// the run would time out instead).
const waitForever = 'read -r answer < <(exec tail -f /dev/null --pid="$pid" 2>/dev/null)';
const signalAtPrompt = (signal) =>
  `stdin_is_terminal() { return 0; }
read_answer() { local pid=$BASHPID; ( sleep 0.2; kill -${signal} "$pid" ) & ${waitForever}; }`;

test("host restore: Ctrl-C (INT), TERM or HUP while the prompt waits exits 3, nothing stopped", () => {
  for (const [name, signal] of promptSignals) {
    const result = run(base, { body: `${signalAtPrompt(signal)}\n${restoreCall}` });
    assert.equal(result.status, 3, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.deepEqual(verbs(result), [], name);
    assert.ok(result.stdout.endsWith(cancelLine), `${name}: ${result.stdout}`);
  }
});

test("host restore: a signal at the prompt exits 3 even when a `2>&1 | tee` reader is gone", () => {
  for (const [name, signal] of promptSignals) {
    const result = run(base, {
      body: `stdin_is_terminal() { return 0; }
read_answer() { local pid=$BASHPID; echo banner; until [ -f "$HOST_TEST_GONE" ]; do sleep 0.05; done; ( sleep 0.2; kill -${signal} "$pid" ) & ${waitForever}; }
main restore ${restoreArgs} 2>&1 ${leavingReader}
exit "\${PIPESTATUS[0]}"`,
      gone: true,
    });
    assert.equal(result.status, 3, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.deepEqual(verbs(result), [], name);
  }
});

test("host restore: the prompt's signal traps are gone after it (the previous ones are back)", () => {
  const result = run(base, {
    body: `project=${project}
read_answer() { answer=${project}; }
trap 'echo previous-int' INT
trap - TERM
confirm_stop
trap -p INT TERM HUP`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "trap -- 'echo previous-int' SIGINT\n");
});

test("host restore: a signal after the prompt, before the restore runs, starts the writers again", () => {
  for (const [name, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    const result = run({ stopSignal: name }, { body: restoreBody });
    assert.equal(result.status, status, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.ok(!verbs(result).includes("run"), name);
    assert.deepEqual(targets(result, "start"), writerIds, name);
    assert.match(result.stderr, /Restore was not invoked; nothing was restored/, name);
  }
});

test("host starts the writers again when its stdout reader dies before the restore runs", () => {
  // The reader leaves once the first writer is stopped, like `tee` killed by
  // Ctrl-C. A broken-pipe write must end the shell through set -e (the EXIT
  // trap runs), never through SIGPIPE (141, nothing started again).
  const result = run(base, {
    body: `${confirmed}
${restoreCall} | { until [ -f "$MARK" ]; do read -r -t 0.05 _ || true; done; exec 0<&-; }
exit "\${PIPESTATUS[0]}"`,
    markOnStop: true,
  });
  assert.notEqual(result.status, 141, result.stderr);
  assert.deepEqual(targets(result, "start"), writerIds, result.stderr);
  assert.ok(!verbs(result).includes("run"));
  assert.match(result.stderr, /Restore was not invoked/);
});

test("host keeps the restore's status when a `2>&1 | tee` reader died during the restore", () => {
  // Ctrl-C kills `tee` while the restore runs: the EXIT trap's notes then hit
  // a broken pipe. They must not change the status or skip the restart.
  for (const restoreExit of [0, 1]) {
    const result = run(
      { restoreExit },
      {
        body: `${confirmed}
${restoreCall} 2>&1 | { until [ -f "$MARK_RUN" ]; do read -r -t 0.05 _ || true; done; exec 0<&-; }
exit "\${PIPESTATUS[0]}"`,
        markOnRun: true,
      },
    );
    assert.equal(result.status, restoreExit, String(restoreExit));
    assert.deepEqual(
      targets(result, "start"),
      restoreExit === 0 ? writerIds : [],
      String(restoreExit),
    );
  }
});

test("host starts the writers again when stopping one fails", () => {
  const result = run({ stopExit: 8 }, { body: restoreBody });
  assert.equal(result.status, 8, result.stderr);
  assert.deepEqual(targets(result, "start"), writerIds);
  assert.ok(!verbs(result).includes("run"));
});
