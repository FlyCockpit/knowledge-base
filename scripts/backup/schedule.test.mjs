import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliverBackup, publishBackupResult } from "../lib/kb-backup.mjs";
import {
  completedPairs,
  dailyPrunePlan,
  dueAtStart,
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
  assert.deepEqual(scheduleConfig({ BACKUP_SCHEDULE: "daily" }), {
    enabled: true,
    hourUtc: 3,
    keep: 14,
  });
  for (const env of [
    { BACKUP_SCHEDULE: "hourly" },
    { BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "24" },
    { BACKUP_SCHEDULE: "daily", BACKUP_KEEP: "0" },
  ])
    assert.throws(() => scheduleConfig(env));
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
