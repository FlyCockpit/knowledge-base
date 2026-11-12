import { createHash } from "node:crypto";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { backupMonitorConfigWarnings } from "@knowledge-base/env/backup-config";
import { logEvent } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/shared";

/** Mirrors scripts/lib/backup-identity.mjs for the worker's read-only listing. */
export function backupNamespace(prefix: string, databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("?")[0] ?? "");
  if (!database) throw new Error("DATABASE_URL does not name a database.");
  const canonical = `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
  const targetId = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new Error("BACKUP_S3_PREFIX must not be empty.");
  return `${normalized}/${targetId}`;
}

/** The two Redis commands this module needs; satisfied by `redisConnection`. */
export type FreshnessStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
};

/**
 * Backup freshness — "did a completed encrypted bundle land recently?"
 *
 * A backup cron that silently stops running produces no error anywhere. The
 * only signal that covers both "ran and failed" and "never ran" is the age of
 * the newest object in the backup bucket. The worker computes that on a
 * schedule (`check-backup-freshness`), writes the verdict to Redis, and alerts
 * admins when it is stale; the admin dashboard reads the same record so the
 * problem is visible the next time anyone opens `/admin`.
 *
 * Read-only against the bucket: ListObjectsV2 only, using the monitor's
 * dedicated ListBucket-only key. It never needs dump read/write access.
 */

/**
 * A cached result belongs to exactly one target and backup configuration.
 * Rotating credentials does not change this identity; switching database,
 * bucket, endpoint, region, or human prefix does, so an old "fresh" result
 * cannot bless a new target before its worker performs a new list.
 */
export function backupFreshnessRedisKey(): string {
  const namespace = backupNamespace(env.BACKUP_S3_PREFIX, env.DATABASE_URL.reveal());
  const config = [
    env.BACKUP_S3_BUCKET ?? "",
    env.BACKUP_S3_REGION,
    env.BACKUP_S3_ENDPOINT ?? "",
    namespace,
  ].join("\n");
  return `backup:freshness:${createHash("sha256").update(config).digest("hex").slice(0, 24)}`;
}

/** Keep the last verdict for three days so a stopped worker reads as "unknown". */
export const BACKUP_FRESHNESS_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Worker schedule interval — a verdict older than this has not been re-checked. */
export const BACKUP_CHECKER_INTERVAL_HOURS = 6;

/** Valid freshness states stored in Redis. */
const FRESHNESS_STATES = new Set([
  "fresh",
  "stale",
  "empty",
  "error",
  "misconfigured",
  "setup-missing",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms);
}

/**
 * Runtime validation for a Redis freshness record. Malformed structured JSON
 * must never become `fresh`; callers treat null as unknown/attention.
 */
export function parseBackupFreshness(raw: unknown, now: Date = new Date()): BackupFreshness | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.state !== "string" || !FRESHNESS_STATES.has(value.state)) return null;
  if (!isIsoTimestamp(value.checkedAt)) return null;
  if (Date.parse(value.checkedAt) > now.getTime() + CLOCK_SKEW_TOLERANCE_HOURS * 3_600_000) {
    return null;
  }

  if (!isFiniteNumber(value.maxAgeHours) || value.maxAgeHours < 1 || value.maxAgeHours > 24 * 30) {
    return null;
  }
  const maxAgeHours = value.maxAgeHours;

  switch (value.state) {
    case "fresh":
    case "stale": {
      if (typeof value.latestKey !== "string" || value.latestKey.length === 0) return null;
      if (!isIsoTimestamp(value.latestAt)) return null;
      if (!isFiniteNumber(value.ageHours) || value.ageHours < 0) return null;
      if (value.reason !== undefined && value.reason !== "future-timestamp") return null;
      return {
        state: value.state,
        checkedAt: value.checkedAt,
        latestKey: value.latestKey,
        latestAt: value.latestAt,
        ageHours: value.ageHours,
        maxAgeHours,
        ...(value.reason === "future-timestamp" ? { reason: "future-timestamp" as const } : {}),
      };
    }
    case "empty":
      return { state: "empty", checkedAt: value.checkedAt, maxAgeHours };
    case "error":
      return {
        state: "error",
        checkedAt: value.checkedAt,
        maxAgeHours,
        message: LISTING_FAILURE_CODES.some((code) => value.message === `listing failed (${code})`)
          ? (value.message as ListingFailureMessage)
          : "listing failed (LISTING_FAILED)",
      };
    case "misconfigured":
    case "setup-missing":
      return typeof value.reason === "string" && value.reason.length > 0
        ? {
            state: value.state,
            checkedAt: value.checkedAt,
            maxAgeHours,
            reason: value.reason,
          }
        : null;
    default:
      return null;
  }
}

/** Bound the listing so a bucket with years of dumps cannot hang the job. */
const MAX_LIST_PAGES = 50;

/** Clock drift we tolerate before a future-dated backup counts as broken. */
const CLOCK_SKEW_TOLERANCE_HOURS = 5 / 60;

/**
 * Why a verdict is what it is, when the age alone does not say. A code, not a
 * sentence: the admin card translates it, so it must not carry English prose.
 */
export type BackupFreshnessReason = "future-timestamp";

export type BackupFreshness =
  | {
      state: "fresh" | "stale";
      checkedAt: string;
      latestKey: string;
      latestAt: string;
      ageHours: number;
      maxAgeHours: number;
      /** Set only when the verdict needs an explanation the age alone does not give. */
      reason?: BackupFreshnessReason;
    }
  | {
      /**
       * A bucket is set but this freshness monitor cannot list it (see
       * `backupMonitorConfigWarnings`). That leaves backup health unknown, so
       * it must be as loud as a stale backup rather than read as "off". It
       * does not assert whether a separate dump writer can still upload.
       */
      state: "misconfigured";
      checkedAt: string;
      maxAgeHours: number;
      /** The monitor-validation text, shown verbatim to admins — it names the variable to fix. */
      reason: string;
    }
  | {
      /**
       * Logical backups are enabled but the off-site bucket is not configured
       * yet. Distinct from `BACKUP_ENABLED=false` (deliberate opt-out).
       */
      state: "setup-missing";
      checkedAt: string;
      maxAgeHours: number;
      reason: string;
    }
  | {
      state: "empty";
      checkedAt: string;
      maxAgeHours: number;
    }
  | {
      state: "error";
      checkedAt: string;
      maxAgeHours: number;
      message: ListingFailureMessage;
    };

type BackupBucket = {
  client: S3Client;
  bucket: string;
  prefix: string;
};

/**
 * A backup bucket that is set but not usable for the monitor — a missing or
 * reused monitor key pair, or region "auto" with no endpoint. `packages/env` deliberately does NOT fail
 * validation on these (a backup-only mistake must never crash-loop the server
 * or the worker), so the check reports monitor misconfiguration rather than
 * throwing on every run or, worse, reporting a bucket it cannot address.
 * Returns null when the monitor configuration is fine.
 */
export function backupFreshnessMisconfiguration(): string | null {
  return backupMonitorConfigWarnings(env).join(" ") || null;
}

/**
 * True when this deployment intends to take logical backups at all.
 * `BACKUP_ENABLED=false` is deliberate opt-out; a missing bucket with backups
 * enabled still counts as on — the admin card reports setup-missing instead.
 */
export function backupFreshnessEnabled(): boolean {
  return env.BACKUP_ENABLED;
}

/** True when a backup bucket name is configured (credentials may still be wrong). */
export function backupFreshnessBucketConfigured(): boolean {
  return Boolean(env.BACKUP_S3_BUCKET);
}

const SETUP_MISSING_REASON =
  "BACKUP_S3_BUCKET is not set. Logical backups are enabled but the off-site bucket is missing — set BACKUP_S3_BUCKET, then configure bundle-writer and freshness-monitor credentials for the processes that need them.";

/**
 * Enabled backups with no bucket yet — first-deploy state on Render and similar.
 * Computed from env, not Redis, because no checker can list a bucket that does
 * not exist.
 */
export function setupMissingBackupFreshness(now: Date = new Date()): BackupFreshness | null {
  if (!env.BACKUP_ENABLED || env.BACKUP_S3_BUCKET) return null;
  return {
    state: "setup-missing",
    checkedAt: now.toISOString(),
    maxAgeHours: env.BACKUP_MAX_AGE_HOURS,
    reason: SETUP_MISSING_REASON,
  };
}

/**
 * The verdict for a set-but-unusable backup config, or null when the config is
 * fine (or absent). Computed from env, not from Redis: the worker never gets to
 * run the check in this state, so the admin card would otherwise show nothing.
 */
export function misconfiguredBackupFreshness(now: Date = new Date()): BackupFreshness | null {
  const reason = backupFreshnessMisconfiguration();
  if (!reason) return null;
  return {
    state: "misconfigured",
    checkedAt: now.toISOString(),
    maxAgeHours: env.BACKUP_MAX_AGE_HOURS,
    reason,
  };
}

let loggedMisconfiguration = false;

/**
 * True when the freshness check can actually list the bucket. A misconfigured
 * bucket cannot, so the listing is skipped — but the misconfiguration is
 * reported (`misconfiguredBackupFreshness`), never swallowed.
 */
export function backupFreshnessConfigured(): boolean {
  if (!backupFreshnessBucketConfigured()) return false;
  const misconfigured = backupFreshnessMisconfiguration();
  if (!misconfigured) return true;
  if (!loggedMisconfiguration) {
    loggedMisconfiguration = true;
    // BACKUP_S3_BUCKET is set but this monitor cannot list it: no verdict is recorded.
    logEvent("backup.config", { reason: "MONITOR_CANNOT_LIST" });
  }
  return false;
}

function buildBackupBucket(): BackupBucket | null {
  if (!backupFreshnessConfigured()) return null;
  if (
    !env.BACKUP_S3_BUCKET ||
    !env.BACKUP_MONITOR_S3_ACCESS_KEY_ID ||
    !env.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  const client = new S3Client({
    region: env.BACKUP_S3_REGION,
    endpoint: env.BACKUP_S3_ENDPOINT,
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.BACKUP_MONITOR_S3_ACCESS_KEY_ID.reveal(),
      secretAccessKey: env.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY.reveal(),
    },
  });
  return {
    client,
    bucket: env.BACKUP_S3_BUCKET,
    prefix: backupNamespace(env.BACKUP_S3_PREFIX, env.DATABASE_URL.reveal()),
  };
}

let cachedBucket: BackupBucket | null | undefined;
function backupBucket(): BackupBucket | null {
  cachedBucket ??= buildBackupBucket();
  return cachedBucket;
}

export type LatestBackup = { key: string; lastModified: Date } | null;

/**
 * Newest COMPLETED encrypted bundle under the prefix, or null when there is none.
 * A bundle counts only once its `backup-*.age.complete` marker is listed too:
 * the uploader publishes the marker last, so a lone `.age` is a partial or
 * failed delivery. Its freshness is the marker's time. Pages through the
 * listing (bounded) because S3 returns keys in lexical order, not by date, and
 * lifecycle rules may leave hundreds behind.
 */
export async function findLatestBackup(
  bucket: BackupBucket = requireBackupBucket(),
): Promise<LatestBackup> {
  const bundles = new Set<string>();
  const markers = new Map<string, Date>();
  let continuationToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await bucket.client.send(
      new ListObjectsV2Command({
        Bucket: bucket.bucket,
        Prefix: `${bucket.prefix}/backup-`,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of result.Contents ?? []) {
      if (!object.Key || !object.LastModified) continue;
      if (object.Key.endsWith(".age")) bundles.add(object.Key);
      else if (object.Key.endsWith(".age.complete"))
        markers.set(object.Key.slice(0, -".complete".length), object.LastModified);
    }
    if (!result.IsTruncated || !result.NextContinuationToken) break;
    continuationToken = result.NextContinuationToken;
  }
  let latest: LatestBackup = null;
  for (const [key, lastModified] of markers) {
    if (!bundles.has(key)) continue;
    if (!latest || lastModified > latest.lastModified) latest = { key, lastModified };
  }
  return latest;
}

function requireBackupBucket(): BackupBucket {
  const bucket = backupBucket();
  if (!bucket) {
    throw new Error(
      "Backup freshness check requires BACKUP_ENABLED=true plus BACKUP_S3_BUCKET and BACKUP_MONITOR_S3_* credentials.",
    );
  }
  return bucket;
}

/** Pure: turn a listing result into a verdict. */
export function evaluateBackupFreshness(
  latest: LatestBackup,
  now: Date,
  maxAgeHours: number = env.BACKUP_MAX_AGE_HOURS,
): BackupFreshness {
  const checkedAt = now.toISOString();
  if (!latest) return { state: "empty", checkedAt, maxAgeHours };
  const ageHours = (now.getTime() - latest.lastModified.getTime()) / 3_600_000;
  // A backup dated in the future can never age past the limit, so clamping the
  // age to 0 would report "fresh" forever — the exact failure this check
  // exists to catch. A few minutes either way is ordinary clock drift between
  // the bucket and this process; anything beyond that is a real problem
  // (a wrong clock, or an object written with a bogus timestamp) and the
  // freshness verdict cannot be trusted until it is fixed.
  const future = ageHours < -CLOCK_SKEW_TOLERANCE_HOURS;
  return {
    state: future || ageHours > maxAgeHours ? "stale" : "fresh",
    checkedAt,
    latestKey: latest.key,
    latestAt: latest.lastModified.toISOString(),
    ageHours: Math.round(Math.max(0, ageHours) * 10) / 10,
    maxAgeHours,
    ...(future ? { reason: "future-timestamp" as const } : {}),
  };
}

/** List the bucket and evaluate; listing errors become an `error` verdict. */
export async function checkBackupFreshness(now: Date = new Date()): Promise<BackupFreshness> {
  const setupMissing = setupMissingBackupFreshness(now);
  if (setupMissing) return setupMissing;
  // A bucket that cannot be addressed produces a misconfiguration verdict, not
  // a listing error: the fix is an env var, and saying so beats "AccessDenied".
  const misconfigured = misconfiguredBackupFreshness(now);
  if (misconfigured) return misconfigured;
  try {
    const latest = await findLatestBackup();
    return evaluateBackupFreshness(latest, now);
  } catch (err) {
    return {
      state: "error",
      checkedAt: now.toISOString(),
      maxAgeHours: env.BACKUP_MAX_AGE_HOURS,
      // A stable failure code, never the S3 exception text (it can quote credentials).
      message: `listing failed (${listingFailureCode(err)})`,
    };
  }
}

/** Only known failure codes cross into the dashboard and alert email. */
const LISTING_FAILURE_CODES = [
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "NoSuchBucket",
  "ExpiredToken",
  "InvalidToken",
  "SlowDown",
  "ServiceUnavailable",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "LISTING_FAILED",
] as const;
type ListingFailureCode = (typeof LISTING_FAILURE_CODES)[number];
type ListingFailureMessage = `listing failed (${ListingFailureCode})`;
function listingFailureCode(error: unknown): ListingFailureCode {
  if (error === null || typeof error !== "object") return "LISTING_FAILED";
  for (const key of ["code", "name"] as const) {
    try {
      const value = (error as Record<string, unknown>)[key];
      for (const code of LISTING_FAILURE_CODES) if (value === code) return code;
    } catch {
      // An upstream error cannot define the content of an operational alert.
    }
  }
  return "LISTING_FAILED";
}

/** A verdict that admins need to act on. */
export function backupFreshnessNeedsAttention(status: BackupFreshness): boolean {
  return status.state !== "fresh";
}

export async function writeBackupFreshness(
  redis: FreshnessStore,
  status: BackupFreshness,
): Promise<void> {
  await redis.set(
    backupFreshnessRedisKey(),
    JSON.stringify(status),
    "EX",
    BACKUP_FRESHNESS_TTL_SECONDS,
  );
}

/**
 * Recompute time-dependent fields on a cached verdict. Freshness ages with
 * wall-clock time; a checker that has not run within its interval cannot leave a
 * dump reading as healthy.
 */
export function refreshBackupFreshness(
  status: BackupFreshness,
  now: Date = new Date(),
): BackupFreshness | null {
  const checkedAtMs = Date.parse(status.checkedAt);
  if (Number.isNaN(checkedAtMs)) return null;

  const checkerAgeHours = (now.getTime() - checkedAtMs) / 3_600_000;
  const checkerOverdue = checkerAgeHours > BACKUP_CHECKER_INTERVAL_HOURS;

  if (status.state === "fresh" || status.state === "stale") {
    const latestAtMs = Date.parse(status.latestAt);
    if (Number.isNaN(latestAtMs)) return null;
    const ageHours = (now.getTime() - latestAtMs) / 3_600_000;
    const future = ageHours < -CLOCK_SKEW_TOLERANCE_HOURS;
    const maxAgeHours = env.BACKUP_MAX_AGE_HOURS;
    const staleByAge = future || ageHours > maxAgeHours;
    const state = staleByAge || checkerOverdue ? "stale" : "fresh";
    return {
      ...status,
      state,
      maxAgeHours,
      ageHours: Math.round(Math.max(0, ageHours) * 10) / 10,
      ...(future ? { reason: "future-timestamp" as const } : {}),
    };
  }

  if (status.state === "empty" || status.state === "error") {
    if (checkerAgeHours > BACKUP_FRESHNESS_TTL_SECONDS / 3_600_000) return null;
    return status;
  }

  return status;
}

/**
 * Last verdict, or null when none was recorded within the TTL (the check has
 * not run yet, or the worker is down). Callers should treat null as "unknown",
 * not "fine", when backups are configured.
 */
export async function readBackupFreshness(
  redis: FreshnessStore,
  now: Date = new Date(),
): Promise<BackupFreshness | null> {
  const setupMissing = setupMissingBackupFreshness(now);
  if (setupMissing) return setupMissing;

  const raw = await redis.get(backupFreshnessRedisKey());
  if (!raw) return null;
  try {
    const parsed = parseBackupFreshness(JSON.parse(raw), now);
    if (!parsed) return null;
    return refreshBackupFreshness(parsed, now);
  } catch {
    return null;
  }
}
