#!/usr/bin/env node
/** Opt-in daily KB encrypted bundles. No plain dumps or prose result parsing. */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  assertNoPendingRestore,
  pgConnectionString,
  prismaSchemaName,
} from "../db/lib/migration-state.mjs";
import { boundedChild } from "../lib/bounded-child.mjs";
import {
  deliverBackup,
  digest,
  openPath,
  publishBackupResult,
  syncDir,
  verifyEncryptedBundle,
} from "../lib/kb-backup.mjs";

const DAY_MS = 86400000,
  HOUR_MS = 3600000,
  STALE_AFTER_MS = 26 * HOUR_MS;
export const STATUS_FILE = "/tmp/knowledge-base-backup-status.json";
const PAIR_NAME = /^backup-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.age$/;
const verificationCache = new Map();
const delivered = (r) =>
  r.upload?.configured ? r.upload.outcome === "uploaded" : r.upload?.outcome === "local-only";
export function scheduleConfig(env) {
  const mode = (env.BACKUP_SCHEDULE ?? "").trim() || "off";
  if (mode === "off") return { enabled: false };
  if (mode !== "daily")
    throw new Error(`BACKUP_SCHEDULE must be "off" or "daily" (got "${mode}").`);
  const hourUtc = Number((env.BACKUP_HOUR_UTC ?? "").trim() || 3);
  if (!Number.isInteger(hourUtc) || hourUtc < 0 || hourUtc > 23)
    throw new Error("BACKUP_HOUR_UTC must be a whole hour from 0 to 23.");
  const keep = Number((env.BACKUP_KEEP ?? "").trim() || 14);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365)
    throw new Error("BACKUP_KEEP must be a whole number from 1 to 365.");
  return { enabled: true, hourUtc, keep };
}

/** The next run strictly after `nowMs`, at `hourUtc`:00 UTC. */
export function nextRunAt(nowMs, hourUtc) {
  const next = new Date(nowMs);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next.getTime() <= nowMs) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

/**
 * Back up at start? Yes when there is no success yet, or the most recent
 * scheduled time (today's or yesterday's `hourUtc`) passed after it, so a
 * restart just after the hour never skips that day's run.
 */
export function dueAtStart(lastSuccessMs, nowMs, hourUtc) {
  if (lastSuccessMs === null) return true;
  const lastScheduled = nextRunAt(nowMs, hourUtc) - DAY_MS;
  return lastSuccessMs < lastScheduled;
}

export function migrationGate({ runnerHeld, prismaHeld, hasHistory, unfinished }) {
  if (runnerHeld || prismaHeld) return "busy";
  if (!hasHistory) return "new-install";
  if (unfinished > 0) return "failed";
  return "ready";
}

export function healthOf(status, nowMs) {
  if (!status.enabled) return { healthy: true, reason: "scheduled backups are off" };
  if (status.lastFailure !== null && (status.lastSuccess ?? 0) < status.lastFailure)
    return { healthy: false, reason: "the last scheduled backup failed (see this service's log)" };
  if (status.lastSuccess === null)
    return nowMs - status.startedAt < HOUR_MS
      ? { healthy: true, reason: "first backup in progress" }
      : { healthy: false, reason: "no scheduled backup has succeeded yet" };
  if (nowMs - status.lastSuccess > STALE_AFTER_MS)
    return { healthy: false, reason: "the last successful backup is more than 26 hours old" };
  return { healthy: true, reason: "last backup succeeded" };
}

/** A pending completed pair is retried even across midnight; never dump hourly. */
export function nextAction(pending) {
  return pending ? "upload" : "bundle";
}

export function dailyPrunePlan(results, keepDays) {
  if (!Number.isInteger(keepDays) || keepDays < 1) throw new Error("Invalid retention.");
  const days = new Map();
  for (const result of results
    .filter((r) => r.label === "daily" && delivered(r))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))) {
    days.set(result.utcDay, [...(days.get(result.utcDay) ?? []), result]);
  }
  return [...days.keys()]
    .sort()
    .reverse()
    .flatMap((day, i) => days.get(day).filter((_, n) => i >= keepDays || n > 0));
}

/** Cache only byte verification, never delivery state. Both no-follow files
 * must retain their size, inode and nanosecond timestamps across verification.
 */
async function pairStamp(file) {
  const stamps = [];
  for (const name of [file, `${file}.complete`]) {
    const fd = await openPath(name);
    try {
      const s = await fd.stat({ bigint: true });
      stamps.push([s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":"));
    } finally {
      await fd.close();
    }
  }
  return stamps.join("/");
}
async function verifiedPair(file) {
  const before = await pairStamp(file);
  if (verificationCache.get(file) === before) return;
  await verifyEncryptedBundle(file);
  if ((await pairStamp(file)) !== before) throw new Error("Backup changed during verification.");
  verificationCache.set(file, before);
}
async function jsonFile(file, limit) {
  const fd = await openPath(file);
  try {
    if ((await fd.stat()).size > limit) throw new Error("Oversized backup metadata.");
    return { value: JSON.parse(await fd.readFile("utf8")), stat: await fd.stat() };
  } finally {
    await fd.close();
  }
}

/** Portable recovery needs only the verified ciphertext/marker pair. Delivery
 * sidecars are local scheduler state and may be missing or refer to an old path.
 */
export async function completedPairs(directory) {
  const results = [];
  const files = new Set();
  for (const name of await readdir(directory)) {
    const match = PAIR_NAME.exec(name);
    if (!name.endsWith(".age") || name.startsWith(".")) continue;
    const file = join(directory, name);
    files.add(file);
    try {
      await verifiedPair(file);
      const marker = await jsonFile(`${file}.complete`, 4096);
      const markerDigest = (await digest(`${file}.complete`)).sha256;
      let result;
      try {
        result = (await jsonFile(`${file}.result.json`, 65536)).value;
      } catch {}
      if (
        match !== null &&
        result?.version === 1 &&
        result.runId === match[1] &&
        ["manual", "pre-migrate", "pre-drop", "daily"].includes(result.label) &&
        /^\d{4}-\d\d-\d\dT.*Z$/.test(result.createdAt) &&
        Number.isFinite(Date.parse(result.createdAt)) &&
        result.utcDay === result.createdAt.slice(0, 10) &&
        result.completion?.sha256 === markerDigest &&
        typeof result.upload?.configured === "boolean" &&
        ["uploaded", "local-only", "failed"].includes(result.upload.outcome)
      ) {
        results.push({
          ...result,
          bundlePath: file,
          completion: { ...result.completion, path: `${file}.complete` },
        });
      } else {
        const createdAt = Number.isFinite(Date.parse(marker.value.createdAt))
          ? new Date(marker.value.createdAt).toISOString()
          : marker.stat.mtime.toISOString();
        // Unknown delivery/label must never become a scheduler success or an
        // automatic deletion candidate. It remains available to list/latest.
        results.push({
          version: 1,
          runId: match?.[1] ?? name,
          label: "imported",
          createdAt,
          utcDay: createdAt.slice(0, 10),
          bundlePath: file,
          completion: { path: `${file}.complete`, sha256: markerDigest },
          upload: null,
        });
      }
    } catch (error) {
      verificationCache.delete(file);
      if (error.code === "CHILD_CANCELLED") throw error;
    }
  }
  for (const file of verificationCache.keys())
    if (file.startsWith(`${directory}/`) && !files.has(file)) verificationCache.delete(file);
  return results;
}

export function nonDailyPrunePlan(results) {
  return ["pre-migrate", "pre-drop", "manual"].flatMap((label) =>
    results
      .filter((r) => r.label === label && delivered(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))
      .slice(7),
  );
}

export async function pruneCompletedPairs(directory, keep) {
  const results = await completedPairs(directory);
  const plan = [
    ...(keep == null ? [] : dailyPrunePlan(results, keep)),
    ...nonDailyPrunePlan(results),
  ];
  for (const result of plan) {
    await verifiedPair(result.bundlePath);
    // Remove validity first: a crash can leave an orphan, never a false complete pair.
    await unlink(result.completion.path);
    await unlink(result.bundlePath);
    await unlink(`${result.bundlePath}.result.json`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    verificationCache.delete(result.bundlePath);
    syncDir(directory);
  }
}

export async function scheduledAttempt({
  directory,
  connectionString,
  signal,
  run = async (env) => {
    await boundedChild("bash", [join(import.meta.dirname, "pre-migrate.sh"), "--label", "daily"], {
      env,
      signal,
      cooperative: true,
      timeout: 4_000_000,
    }).done;
  },
  deliver = deliverBackup,
}) {
  const pairs = (await completedPairs(directory)).filter((r) => r.label === "daily");
  const pending = pairs
    .filter((r) => !delivered(r))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (pending)
    return deliver({
      file: pending.bundlePath,
      label: "daily",
      createdAt: pending.createdAt,
      connectionString,
      resultFile: `${pending.bundlePath}.result.json`,
      signal,
    });
  const runId = randomUUID(),
    resultFile = join(directory, `backup-${runId}.age.result.json`);
  await run({
    ...process.env,
    BACKUP_DIR: directory,
    KB_BACKUP_RUN_ID: runId,
    BACKUP_RESULT_FILE: resultFile,
  });
  const result = JSON.parse(await readFile(resultFile, "utf8"));
  if (!delivered(result)) throw new Error("Backup delivery is incomplete.");
  const verified = (await completedPairs(directory)).find((r) => r.runId === runId);
  if (!verified || !delivered(verified)) throw new Error("Backup result has no completed pair.");
  return result;
}

async function migrationFacts(client, schema) {
  await assertNoPendingRestore(client);
  const locks = (
    await client.query(`SELECT objid::integer AS key FROM pg_locks WHERE locktype='advisory'
    AND classid=0 AND objsubid=1 AND granted AND objid IN (72707370,72707369)
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)
  ).rows;
  const present = (
    await client.query("SELECT to_regclass(format('%I._prisma_migrations',$1::text)) AS present", [
      schema,
    ])
  ).rows[0]?.present;
  const ident = '"' + schema.replaceAll('"', '""') + '"';
  const history = present
    ? (
        await client.query(`SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::int AS applied,
    count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished FROM ${ident}._prisma_migrations`)
      ).rows[0]
    : null;
  return {
    runnerHeld: locks.some((r) => r.key === 72707370),
    prismaHeld: locks.some((r) => r.key === 72707369),
    hasHistory: (history?.applied ?? 0) > 0,
    unfinished: history?.unfinished ?? 0,
  };
}

export async function runLoop(env = process.env) {
  const config = scheduleConfig(env),
    directory = resolve(env.BACKUP_DIR || "/app/backups");
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => controller.abort());
  const status = {
    enabled: config.enabled,
    startedAt: Date.now(),
    lastSuccess: null,
    lastFailure: null,
  };
  const statusWrite = () => publishBackupResult(STATUS_FILE, status);
  await statusWrite();
  const sleep = (ms) => delay(ms, undefined, { signal: controller.signal });
  if (!config.enabled) {
    while (!controller.signal.aborted) await sleep(60000);
    return;
  }
  if (!isAbsolute(env.BACKUP_DIR || "/app/backups"))
    throw new Error("BACKUP_DIR must be absolute.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const client = new Client({
    connectionString: pgConnectionString(env.DATABASE_URL),
    connectionTimeoutMillis: 10000,
    application_name: "kb-backup-schedule",
    statement_timeout: 30000,
  });
  client.on("error", () => controller.abort());
  try {
    await client.connect();
    // Independent scheduler key: backup children NEVER acquire the runner key.
    if (
      !(await client.query("SELECT pg_try_advisory_lock(1262633555::bigint) AS held")).rows[0]?.held
    )
      throw new Error("Another scheduler owns this instance.");
    const pairs = await completedPairs(directory);
    const successes = pairs.filter((r) => r.label === "daily" && delivered(r));
    const stateFile = join(directory, ".backup-schedule.json");
    let saved;
    try {
      saved = JSON.parse(await readFile(stateFile, "utf8"));
    } catch {}
    status.lastSuccess =
      typeof saved?.lastSuccess === "number"
        ? saved.lastSuccess
        : successes.length
          ? Math.max(...successes.map((r) => Date.parse(r.createdAt)))
          : null;
    status.lastFailure = typeof saved?.lastFailure === "number" ? saved.lastFailure : null;
    await statusWrite();
    let nextAt =
      pairs.some((r) => r.label === "daily" && !delivered(r)) ||
      dueAtStart(status.lastSuccess, Date.now(), config.hourUtc)
        ? Date.now() + 300000
        : nextRunAt(Date.now(), config.hourUtc);
    while (!controller.signal.aborted) {
      if (nextAt > Date.now()) await sleep(Math.min(60000, nextAt - Date.now()));
      if (nextAt > Date.now()) continue;
      try {
        const gate = migrationGate(
          await migrationFacts(client, prismaSchemaName(env.DATABASE_URL)),
        );
        if (gate === "busy" || gate === "new-install") {
          nextAt = Date.now() + 15000;
          continue;
        }
        if (gate !== "ready") throw new Error("An unfinished migration requires recovery.");
        const result = await scheduledAttempt({
          directory,
          connectionString: env.DATABASE_URL,
          signal: controller.signal,
        });
        status.lastSuccess = Date.parse(result.createdAt);
        status.lastFailure = null;
        // Retention never discards undelivered pairs or runs after a failed delivery.
        await pruneCompletedPairs(directory, config.keep);
        nextAt = dueAtStart(status.lastSuccess, Date.now(), config.hourUtc)
          ? Date.now()
          : nextRunAt(Date.now(), config.hourUtc);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        status.lastFailure = Date.now();
        console.error(
          "Scheduled full-bundle backup failed; retrying the completed pair in one hour.",
        );
        nextAt = Date.now() + HOUR_MS;
      }
      await publishBackupResult(stateFile, {
        lastSuccess: status.lastSuccess,
        lastFailure: status.lastFailure,
      });
      await statusWrite();
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "run") await runLoop();
    else if (process.argv[2] === "health") {
      const verdict = healthOf(JSON.parse(await readFile(STATUS_FILE, "utf8")), Date.now());
      console.log(verdict.reason);
      process.exitCode = verdict.healthy ? 0 : 1;
    } else throw new Error("usage: schedule.mjs run|health");
  } catch (error) {
    if (error.name !== "AbortError") {
      console.error("Backup scheduler unavailable; inspect its configuration and completed pairs.");
      process.exitCode = 1;
    }
  }
}
