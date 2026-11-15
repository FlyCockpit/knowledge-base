import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliverBackup, publishBackupResult } from "../lib/kb-backup.mjs";
import {
  abandonedUploadCount,
  attemptLine,
  completedPairs,
  dailyPrunePlan,
  dueAtStart,
  exitAfterLoop,
  healthOf,
  migrationGate,
  nextAction,
  nextRunAt,
  nonDailyPrunePlan,
  pruneCompletedPairs,
  scheduleConfig,
  scheduledAttempt,
} from "./schedule.mjs";

async function pair(directory, { day = "2026-11-11", uploaded = true, label = "daily" } = {}) {
  const file = join(directory, `backup-${randomUUID()}.age`);
  const bytes = Buffer.from("age-encryption.org/v1\nsynthetic test bytes, not a recovery bundle");
  await writeFile(file, bytes);
  await writeFile(
    `${file}.complete`,
    JSON.stringify({
      version: 1,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  let result;
  try {
    result = await deliverBackup({
      file,
      label,
      createdAt: `${day}T03:00:00.000Z`,
      configured: !uploaded,
      upload: async () => {
        throw Error("offline");
      },
    });
  } catch {
    result = JSON.parse(await readFile(`${file}.result.json`, "utf8"));
  }
  return result;
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "kb-schedule-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test("schedule is off by default, daily opts in with reviewed hour/retention", () => {
  assert.deepEqual(scheduleConfig({}), { enabled: false });
  assert.deepEqual(scheduleConfig({ BACKUP_SCHEDULE: "daily" }), { enabled: false });
  assert.deepEqual(scheduleConfig({ BACKUP_ENABLED: "false", BACKUP_SCHEDULE: "daily" }), {
    enabled: false,
  });
  assert.deepEqual(scheduleConfig({ BACKUP_ENABLED: "true", BACKUP_SCHEDULE: "daily" }), {
    enabled: true,
    hourUtc: 3,
    keep: 14,
  });
  for (const env of [
    { BACKUP_SCHEDULE: "hourly" },
    { BACKUP_ENABLED: "true", BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "24" },
    { BACKUP_ENABLED: "true", BACKUP_SCHEDULE: "daily", BACKUP_KEEP: "0" },
  ])
    assert.throws(() => scheduleConfig(env));
});
test("daily scheduling with backups off warns once and stays healthy", (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  for (const enabled of [undefined, "", "false"]) {
    warning.mock.resetCalls();
    const config = scheduleConfig({ BACKUP_SCHEDULE: "daily", BACKUP_ENABLED: enabled });
    assert.equal(warning.mock.callCount(), 1);
    assert.match(warning.mock.calls[0].arguments[0], /daily backups are NOT running/);
    assert.match(warning.mock.calls[0].arguments[0], /BACKUP_ENABLED=true/);
    assert.equal(healthOf(config, Date.now()).healthy, true);
  }
  warning.mock.resetCalls();
  scheduleConfig({});
  scheduleConfig({ BACKUP_SCHEDULE: "daily", BACKUP_ENABLED: "true" });
  assert.equal(warning.mock.callCount(), 0);
});
test("UTC scheduling catches a missed slot after restart and rolls over years", () => {
  const now = Date.UTC(2026, 10, 11, 3, 5);
  assert.equal(dueAtStart(Date.UTC(2026, 10, 10, 3, 10), now, 3), true);
  assert.equal(dueAtStart(now, now, 3), false);
  assert.equal(nextRunAt(Date.UTC(2026, 11, 31, 23), 3), Date.UTC(2027, 0, 1, 3));
  assert.equal(nextAction({ utcDay: "yesterday" }), "upload");
});
test("health reports failed and stale delivery and permits initial grace/off", () => {
  const now = Date.now(),
    base = { enabled: true, startedAt: now, lastFailure: null, lastSuccess: null };
  assert.equal(healthOf(base, now).healthy, true);
  assert.equal(healthOf({ ...base, enabled: false, lastFailure: now }, now).healthy, true);
  assert.equal(healthOf({ ...base, lastFailure: now }, now).healthy, false);
  assert.equal(healthOf({ ...base, lastSuccess: now - 27 * 3600000 }, now).healthy, false);
});
test("migration gate waits for runner/Prisma and refuses unfinished/new install", () => {
  const facts = { runnerHeld: false, prismaHeld: false, hasHistory: true, unfinished: 0 };
  assert.equal(migrationGate(facts), "ready");
  for (const patch of [{ runnerHeld: true }, { prismaHeld: true }])
    assert.equal(migrationGate({ ...facts, ...patch }), "busy");
  assert.equal(migrationGate({ ...facts, unfinished: 1 }), "failed");
  assert.equal(migrationGate({ ...facts, hasHistory: false }), "new-install");
});
test("inventory and pruning ignore staging, missing/corrupt pairs and failed delivery", async (t) => {
  const dir = await directory(t);
  const old = await pair(dir, { day: "2026-11-09" });
  const newest = await pair(dir);
  const failed = await pair(dir, { day: "2026-11-08", uploaded: false });
  const manual = await pair(dir, { day: "2026-11-01", label: "manual" });
  await writeFile(join(dir, ".kb-backup-123456"), "staging");
  const corrupted = await pair(dir, { day: "2026-11-07" });
  await writeFile(corrupted.bundlePath, "corrupt");
  const pairs = await completedPairs(dir);
  assert.equal(pairs.length, 4);
  assert.deepEqual(
    dailyPrunePlan(pairs, 1).map((r) => r.runId),
    [old.runId],
  );
  await pruneCompletedPairs(dir, 1);
  await assert.rejects(readFile(old.bundlePath), { code: "ENOENT" });
  await assert.rejects(readFile(old.completion.path), { code: "ENOENT" });
  for (const result of [newest, failed, manual]) assert.ok(await readFile(result.bundlePath));
});
test("failed upload retries the exact completed pair after restart without another snapshot", async (t) => {
  const dir = await directory(t),
    original = await pair(dir, { day: "2026-11-10", uploaded: false });
  let snapshots = 0,
    uploads = 0;
  const input = {
    directory: dir,
    run: async () => {
      snapshots++;
    },
    deliver: async (args) => {
      uploads++;
      assert.equal(args.file, original.bundlePath);
      assert.equal(args.createdAt, original.createdAt);
      return deliverBackup({
        ...args,
        configured: true,
        upload: async () => ({ key: "verified" }),
      });
    },
  };
  assert.equal((await scheduledAttempt(input)).runId, original.runId);
  assert.equal(snapshots, 0);
  assert.equal(uploads, 1);
  assert.equal((await completedPairs(dir))[0].upload.outcome, "uploaded");
});
/** A scheduledAttempt `log` that records [line, isFailure] pairs. */
function lines() {
  const seen = [];
  const log = (line, failure) => seen.push([line, failure]);
  return { seen, log };
}

test("attempt lines are stable key=value lines without undefined fields", () => {
  assert.equal(
    attemptLine("failed", { kind: "gate", run: undefined, code: "MIGRATION_UNFINISHED" }),
    "kb-backup-schedule attempt=failed kind=gate code=MIGRATION_UNFINISHED",
  );
});

test("a retried upload logs started then uploaded, or failed with a stable code", async (t) => {
  const dir = await directory(t),
    original = await pair(dir, { uploaded: false });
  const ok = lines();
  await scheduledAttempt({
    directory: dir,
    log: ok.log,
    deliver: (args) =>
      deliverBackup({ ...args, configured: true, upload: async () => ({ key: "verified" }) }),
  });
  assert.deepEqual(ok.seen, [
    [`kb-backup-schedule attempt=started kind=upload run=${original.runId}`, false],
    [`kb-backup-schedule attempt=uploaded kind=upload run=${original.runId}`, false],
  ]);
  const next = await pair(dir, { uploaded: false });
  const denied = lines();
  await assert.rejects(
    scheduledAttempt({
      directory: dir,
      log: denied.log,
      deliver: (args) =>
        deliverBackup({
          ...args,
          configured: true,
          upload: async () => {
            throw Object.assign(new Error("Access Denied for bucket x"), {
              $metadata: { httpStatusCode: 403 },
            });
          },
        }),
    }),
  );
  assert.deepEqual(denied.seen, [
    [`kb-backup-schedule attempt=started kind=upload run=${next.runId}`, false],
    [`kb-backup-schedule attempt=failed kind=upload run=${next.runId} code=S3_HTTP_403`, true],
  ]);
  // The pair records why, and stays pending for the next attempt.
  const recorded = JSON.parse(await readFile(`${next.bundlePath}.result.json`, "utf8"));
  assert.deepEqual(recorded.upload, { configured: true, outcome: "failed", code: "S3_HTTP_403" });
  // A failed (not abandoned) upload never forces the scheduler's exit.
  assert.equal(abandonedUploadCount(), 0);
  exitAfterLoop(() => assert.fail("no exit without an abandoned upload"));
  assert.ok((await completedPairs(dir)).some((r) => r.runId === next.runId));
});

test("a pair-discovery failure is logged as failed kind=discover with its code", async (t) => {
  const missing = join(await directory(t), "absent");
  const seen = lines();
  await assert.rejects(scheduledAttempt({ directory: missing, log: seen.log }), { code: "ENOENT" });
  assert.deepEqual(seen.seen, [
    ["kb-backup-schedule attempt=failed kind=discover code=ENOENT", true],
  ]);
});

test("a hung upload is bounded: the attempt logs timed-out (UPLOAD_TIMEOUT) and the pair stays pending", async (t) => {
  const dir = await directory(t),
    original = await pair(dir, { uploaded: false });
  const hung = lines();
  let aborted = false;
  const before = abandonedUploadCount();
  const started = Date.now();
  await assert.rejects(
    scheduledAttempt({
      directory: dir,
      log: hung.log,
      deliver: (args) =>
        deliverBackup({
          ...args,
          configured: true,
          uploadTimeoutMs: 100,
          uploadAbortGraceMs: 100,
          // Never settles, even on abort: the bound must not depend on it.
          upload: ({ signal }) => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            return new Promise(() => {});
          },
        }),
    }),
    { code: "UPLOAD_TIMEOUT" },
  );
  assert.ok(Date.now() - started < 10_000);
  assert.equal(aborted, true, "the upload's signal is aborted at the deadline");
  // It ignored the abort: the scheduler counts it and exits after its loop.
  assert.equal(abandonedUploadCount(), before + 1);
  let exited = null;
  exitAfterLoop((code) => {
    exited = code;
  });
  assert.equal(exited, 0);
  const source = await readFile(new URL("./schedule.mjs", import.meta.url), "utf8");
  assert.match(source, /\n {2}exitAfterLoop\(\);\n\}\n?$/);
  assert.deepEqual(hung.seen, [
    [`kb-backup-schedule attempt=started kind=upload run=${original.runId}`, false],
    [
      `kb-backup-schedule attempt=timed-out kind=upload run=${original.runId} code=UPLOAD_TIMEOUT`,
      true,
    ],
  ]);
  const pending = (await completedPairs(dir)).find((r) => r.runId === original.runId);
  assert.deepEqual(pending.upload, { configured: true, outcome: "failed", code: "UPLOAD_TIMEOUT" });
});

test("a new bundle logs started then local-only; a failing child names its cause", async (t) => {
  const dir = await directory(t);
  const bundle = async (env, { uploaded = false, fail } = {}) => {
    const file = join(env.BACKUP_DIR, `backup-${env.KB_BACKUP_RUN_ID}.age`);
    const bytes = Buffer.from("age-encryption.org/v1\nsynthetic test bytes, not a recovery bundle");
    await writeFile(file, bytes);
    await writeFile(
      `${file}.complete`,
      JSON.stringify({
        version: 1,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    );
    await deliverBackup({
      file,
      label: "daily",
      resultFile: env.BACKUP_RESULT_FILE,
      configured: uploaded || Boolean(fail),
      upload: async () => {
        if (fail) throw fail;
        return { key: "verified" };
      },
    }).catch(() => {});
    if (fail)
      throw Object.assign(new Error("Client exited with status 1."), { code: "CHILD_EXIT" });
  };
  const local = lines();
  const result = await scheduledAttempt({
    directory: dir,
    log: local.log,
    run: (env) => bundle(env),
  });
  assert.deepEqual(local.seen, [
    [`kb-backup-schedule attempt=started kind=bundle run=${result.runId}`, false],
    [`kb-backup-schedule attempt=local-only kind=bundle run=${result.runId}`, false],
  ]);
  const uploaded = lines();
  const sent = await scheduledAttempt({
    directory: dir,
    log: uploaded.log,
    run: (env) => bundle(env, { uploaded: true }),
  });
  assert.equal(
    uploaded.seen[1][0],
    `kb-backup-schedule attempt=uploaded kind=bundle run=${sent.runId}`,
  );
  // The child's upload failed: the code it recorded beside the pair.
  const refused = lines();
  await assert.rejects(
    scheduledAttempt({
      directory: dir,
      log: refused.log,
      run: (env) => bundle(env, { fail: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }),
    }),
  );
  assert.match(
    refused.seen[1][0],
    /^kb-backup-schedule attempt=failed kind=bundle run=\S+ code=ECONNREFUSED$/,
  );
  // The pair is now pending; clear it so the next attempt bundles again.
  for (const r of await completedPairs(dir))
    if (r.upload?.outcome === "failed")
      for (const suffix of ["", ".complete", ".result.json"]) await rm(`${r.bundlePath}${suffix}`);
  for (const [error, expected] of [
    [Object.assign(new Error("deadline"), { code: "CHILD_DEADLINE" }), "timed-out"],
    [Object.assign(new Error("exit"), { code: "CHILD_EXIT" }), "failed"],
  ]) {
    const child = lines();
    await assert.rejects(
      scheduledAttempt({
        directory: dir,
        log: child.log,
        run: async () => {
          throw error;
        },
      }),
    );
    const code = error.code === "CHILD_EXIT" ? "BUNDLE_FAILED" : error.code;
    assert.match(
      child.seen[1][0],
      new RegExp(`^kb-backup-schedule attempt=${expected} kind=bundle run=\\S+ code=${code}$`),
    );
    assert.equal(child.seen[1][1], true);
  }
});

test("local result is atomic and configured failure cannot become success or heartbeat", async (t) => {
  const dir = await directory(t),
    result = await pair(dir, { uploaded: false });
  let heartbeat = 0;
  await assert.rejects(
    deliverBackup({
      file: result.bundlePath,
      label: "daily",
      configured: true,
      upload: async () => {
        throw Error("partial");
      },
      heartbeat: async () => heartbeat++,
    }),
  );
  assert.equal(heartbeat, 0);
  const resultFile = join(dir, "runner-result.json");
  const local = await deliverBackup({
    file: result.bundlePath,
    label: "pre-drop",
    configured: false,
    resultFile,
  });
  assert.equal(local.upload.outcome, "local-only");
  assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), local);
  await publishBackupResult(resultFile, { complete: true });
  assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), { complete: true });
});

test("portable pairs without sidecars and relocated pairs remain visible, ordered by marker time", async (t) => {
  const dir = await directory(t),
    moved = await directory(t);
  const original = await pair(dir, { day: "2026-11-01" });
  const portable = await pair(dir, { day: "2026-11-11" });
  await rm(`${portable.bundlePath}.result.json`);
  const marker = JSON.parse(await readFile(portable.completion.path, "utf8"));
  marker.createdAt = "2026-11-11T03:00:00.000Z";
  await writeFile(portable.completion.path, JSON.stringify(marker));
  for (const suffix of ["", ".complete", ".result.json"]) {
    await rename(
      `${original.bundlePath}${suffix}`,
      join(moved, original.bundlePath.split("/").at(-1) + suffix),
    );
  }
  const discovered = await completedPairs(dir);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].bundlePath, portable.bundlePath);
  assert.equal(discovered[0].createdAt, marker.createdAt);
  const relocated = await completedPairs(moved);
  assert.equal(relocated.length, 1);
  assert.equal(relocated[0].label, "daily");
  assert.ok(relocated[0].bundlePath.startsWith(moved));
});

test("non-daily retention keeps newest seven per label, preserves failed delivery and staging", async (t) => {
  const dir = await directory(t);
  const obsolete = [];
  for (const label of ["manual", "pre-migrate", "pre-drop"]) {
    for (let n = 1; n <= 9; n++) {
      const result = await pair(dir, { day: `2026-11-0${n}`, label });
      if (n <= 2) obsolete.push(result);
    }
  }
  const failed = await pair(dir, { day: "2026-10-01", label: "manual", uploaded: false });
  const staging = join(dir, ".kb-cutoff-unchanged");
  await writeFile(staging, "staging");
  assert.equal(nonDailyPrunePlan(await completedPairs(dir)).length, 6);
  await pruneCompletedPairs(dir);
  for (const result of obsolete) {
    for (const suffix of ["", ".complete", ".result.json"])
      await assert.rejects(readFile(`${result.bundlePath}${suffix}`), { code: "ENOENT" });
  }
  assert.equal((await completedPairs(dir)).length, 22);
  assert.ok(await readFile(failed.bundlePath));
  assert.equal(await readFile(staging, "utf8"), "staging");
});

test("cached verification invalidates when same-sized bundle or marker changes", async (t) => {
  const dir = await directory(t);
  const result = await pair(dir);
  assert.equal((await completedPairs(dir)).length, 1);
  assert.equal((await completedPairs(dir)).length, 1);
  const bytes = await readFile(result.bundlePath);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(result.bundlePath, bytes);
  assert.equal((await completedPairs(dir)).length, 0);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(result.bundlePath, bytes);
  assert.equal((await completedPairs(dir)).length, 1);
  const marker = JSON.parse(await readFile(result.completion.path, "utf8"));
  marker.sha256 = "0".repeat(64);
  await writeFile(result.completion.path, JSON.stringify(marker));
  await utimes(result.completion.path, new Date(), new Date());
  assert.equal((await completedPairs(dir)).length, 0);
});

test("restore --list discovers any named verified pair without a sidecar", async (t) => {
  const dir = await directory(t);
  const result = await pair(dir);
  const file = join(dir, "downloaded-from-s3.age");
  await rename(result.bundlePath, file);
  await rename(result.completion.path, `${file}.complete`);
  await rm(`${result.bundlePath}.result.json`);
  const pairs = await completedPairs(dir);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].bundlePath, file);
  const listed = execFileSync(
    "bash",
    [new URL("./restore.sh", import.meta.url).pathname, "--list"],
    {
      env: { ...process.env, BACKUP_DIR: dir },
      encoding: "utf8",
    },
  );
  assert.ok(listed.includes(file));
});

test("restore latest chooses a newer imported marker pair over an older local result", async (t) => {
  const dir = await directory(t);
  await pair(dir, { day: "2026-11-01" });
  const newest = await pair(dir, { day: "2026-11-11" });
  await rm(`${newest.bundlePath}.result.json`);
  const marker = JSON.parse(await readFile(newest.completion.path, "utf8"));
  marker.createdAt = "2026-11-11T03:00:00.000Z";
  await writeFile(newest.completion.path, JSON.stringify(marker));
  const script = new URL("./restore.sh", import.meta.url).pathname;
  // Keep discovery and argument handling real; replace only the offline
  // supervisor handoff so this database-free test cannot begin a restore.
  const source = (await readFile(script, "utf8")).replace(
    'exec /usr/local/bin/kb-supervisor --restore -- node "$ROOT/scripts/lib/kb-restore.mjs" "$@"',
    `printf '%s\\n' "$@"`,
  );
  const selected = execFileSync("bash", ["-c", source, script, "latest", "identity", "attempt"], {
    env: { ...process.env, BACKUP_DIR: dir },
    encoding: "utf8",
  });
  assert.deepEqual(selected.trim().split("\n"), [newest.bundlePath, "identity", "attempt"]);
});
