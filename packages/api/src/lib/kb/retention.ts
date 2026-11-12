import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@knowledge-base/db/client";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import { cursorPage, pageTake, withCursor } from "../pagination";
import {
  failDeadBuildGeneration,
  LIVE_JOB_STATES_SQL,
  UNFINISHED_GENERATION_STATES_SQL,
} from "./build-liveness";
import {
  fsyncDirectory,
  parseIndexFileName,
  removeGenerationFiles,
  unlinkIndexFile,
} from "./index-file/files";
import { KB_LIMITS } from "./limits";
import { checkoutPinnedSession, type LockQuery } from "./lock";
import { QUERY_SCRUB_MS } from "./query-embedding";
import { expireStagedUploadIfDue } from "./uploads";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Retention windows. Every sweep below measures from these exact values. */
export const RETENTION = {
  /** Query text/result/lease rows: scrubbed within 5 minutes of request creation. */
  queryScrubMs: QUERY_SCRUB_MS,
  /** Server janitor cadence; the worker's minute class is a second, independent enforcer. */
  queryJanitorIntervalMs: 30 * SECOND,
  /** Begin reclaiming at 3m, leaving two minutes for cadence, paging and a retry. */
  queryCleanupLeadMs: 2 * MINUTE,
  uploadTtlMs: HOUR,
  exportTtlMs: 15 * MINUTE,
  /** BullMQ payload retention (Redis); the Postgres durable job receipt persists. */
  bullCompletedAgeSeconds: 24 * 3600,
  bullFailedAgeSeconds: 7 * 24 * 3600,
  supersededGenerationMs: 7 * DAY,
  failedBuildMs: DAY,
  operationBodyMs: 30 * DAY,
  auditMs: 90 * DAY,
  deviceArtifactGraceMs: DAY,
  oauthArtifactGraceMs: DAY,
  refreshFamilyGraceMs: DAY,
  /** DPoP replay rows already store verifier expiry + 1s (mcp-plugins adapter). */
  dpopVerifierGraceMs: SECOND,
} as const;

export const RETENTION_PAGE_SIZE = 100;
/** A temp or orphan final younger than this is never reclaimed (an attempt may still own it). */
export const INDEX_TEMP_GRACE_MS = 5 * MINUTE;
/** Directory entries the index reconciler examines per pass. */
export const INDEX_RECONCILE_ENTRIES = 1000;

export type RetentionSweepOptions = {
  connectionString: string;
  /** Test clock for TTL cutoffs only. Lease liveness always uses the database clock. */
  now?: Date;
  pageSize?: number;
  /** Test seam: runs after each committed page (crash injection between pages). */
  afterPage?: (page: number) => void | Promise<void>;
  /** Test seam: runs after a candidate was scanned and before its locked recheck. */
  beforeRow?: (id: string) => void | Promise<void>;
  signal?: AbortSignal;
};

export type RetentionOptions = RetentionSweepOptions & {
  /** `<KB_DATA_ROOT>/index`: generation files are unlinked after their purge commits. */
  indexDir: string;
  /** Test seam: the reconciler's mtime grace (default INDEX_TEMP_GRACE_MS). */
  indexTempGraceMs?: number;
  /** Test seam: the per-directory dirent cap (default KB_LIMITS.indexDirEntryCap). */
  indexDirEntryCap?: number;
  /** Test seam: directory opener (counts dirents read). */
  openIndexDir?: (path: string) => Promise<AsyncIterable<Dirent> & { close(): Promise<void> }>;
};

/**
 * File cleanup after a row's transaction committed (file removal never precedes the commit).
 * The row is final once committed: a cleanup that fails is never retried by the sweep, and
 * `reconcileIndexFiles` removes what it left (a PURGED generation's files are "remove").
 */
type AfterCommit = () => Promise<void>;
type RowWork = (query: LockQuery, id: string) => Promise<boolean | AfterCommit>;

/**
 * Bounded keyset sweep: each page is selected fresh (rows already handled no longer
 * match), and each row is re-checked and mutated in its own transaction under the row
 * lock. A crash between pages loses nothing: the next run re-selects what is left, and
 * every row mutation is idempotent (state-guarded), so no quota or row is handled twice.
 */
async function sweep(
  name: string,
  options: RetentionSweepOptions,
  select: (query: LockQuery, afterId: string, limit: number) => Promise<string[]>,
  work: RowWork,
): Promise<number> {
  const limit = options.pageSize ?? RETENTION_PAGE_SIZE;
  let afterId = "";
  let done = 0;
  for (let page = 1; ; page++) {
    const lease = await checkoutPinnedSession({
      connectionString: options.connectionString,
      opId: randomUUID(),
    });
    let ids: string[];
    try {
      ids = await select(lease.query, afterId, limit);
      for (const id of ids) {
        await options.beforeRow?.(id);
        // One row's failure rolls back only its own transaction: the row
        // still matches, so the next run selects it again. It never stops
        // the rest of the sweep.
        let result: boolean | AfterCommit;
        try {
          result = await lease.transaction((query) => work(query, id));
        } catch (error) {
          logInternalError("kb.retention-row", error, { sweep: name, rowId: id });
          continue;
        }
        if (result === false) continue;
        done += 1;
        if (typeof result !== "function") continue;
        try {
          await result();
        } catch (error) {
          logInternalError("kb.retention-cleanup", error, { sweep: name, rowId: id });
        }
      }
    } finally {
      await lease.close();
    }
    if (ids.length === 0) return done;
    afterId = ids[ids.length - 1]!;
    await options.afterPage?.(page);
    if (ids.length < limit) return done;
  }
}

const cutoff = (options: RetentionSweepOptions) => options.now?.toISOString() ?? null;
const NOW_SQL = "COALESCE($1::timestamptz, clock_timestamp())";

/**
 * Query requests approaching `scrubAt` (creation + 5 min). Start at 3m, after the
 * 60s request / 90s lease limits, to leave headroom for the 30s janitor and SQL work.
 * Deleting the QUERY_EMBEDDING durable
 * job cascades the request (ciphertexts) and its lease. A lease that is still live by the
 * database clock is never deleted underneath its reader, whatever the test clock says.
 */
export function scrubExpiredQueryData(options: RetentionSweepOptions): Promise<number> {
  const now = cutoff(options);
  return sweep(
    "query-data",
    options,
    async (query, afterId, limit) =>
      (
        await query<{ id: string }>(
          `SELECT j.id FROM durable_job j
            LEFT JOIN query_embedding_request r ON r.id = j.id
            WHERE j.kind = 'QUERY_EMBEDDING' AND j.id > $2
              AND COALESCE(r."scrubAt" - ($5 * interval '1 millisecond'), j."createdAt" + ($4 * interval '1 millisecond')) <= ${NOW_SQL}
            ORDER BY j.id LIMIT $3`,
          [
            now,
            afterId,
            limit,
            RETENTION.queryScrubMs - RETENTION.queryCleanupLeadMs,
            RETENTION.queryCleanupLeadMs,
          ],
        )
      ).rows.map((row) => row.id),
    async (query, id) => {
      const deleted = await query(
        `DELETE FROM durable_job j WHERE j.id = $2 AND j.kind = 'QUERY_EMBEDDING'
           AND COALESCE((SELECT r."scrubAt" - ($4 * interval '1 millisecond') FROM query_embedding_request r WHERE r.id = j.id),
                        j."createdAt" + ($3 * interval '1 millisecond')) <= ${NOW_SQL}
           AND NOT EXISTS (SELECT 1 FROM generation_lease l WHERE l."requestId" = j.id
                             AND l."expiresAt" > clock_timestamp())`,
        [
          now,
          id,
          RETENTION.queryScrubMs - RETENTION.queryCleanupLeadMs,
          RETENTION.queryCleanupLeadMs,
        ],
      );
      return (deleted.rowCount ?? 0) > 0;
    },
  );
}

/**
 * Worker half of staging expiry: marks due WRITING/READY uploads EXPIRED and releases their
 * quota in the same row-locked transaction. It never touches files — the server's fenced
 * sweeper (`sweepExpiredStagedUploads`) unlinks terminal rows' staging files.
 */
export function markExpiredStagedUploads(options: RetentionSweepOptions): Promise<number> {
  const now = cutoff(options);
  return sweep(
    "staged-uploads",
    options,
    async (query, afterId, limit) =>
      (
        await query<{ id: string }>(
          `SELECT id::text AS id FROM staged_upload
            WHERE id::text > $2 AND "reservedByOpId" IS NULL AND (
                 (state = 'WRITING'::"StagedUploadState" AND "expiresAt" <= ${NOW_SQL})
              OR (state = 'READY'::"StagedUploadState" AND "readyExpiresAt" <= ${NOW_SQL}))
            ORDER BY id::text LIMIT $3`,
          [now, afterId, limit],
        )
      ).rows.map((row) => row.id),
    (query, id) => expireStagedUploadIfDue(query, id, options.now?.getTime()),
  );
}

async function purgeOne(
  query: LockQuery,
  id: string,
  now: string | null,
  indexDir: string,
): Promise<false | AfterCommit> {
  // FOR UPDATE conflicts with every lease insert's KEY SHARE and with the KEY SHARE every index
  // file read holds until its reader thread settled (§1.5 CL-INTERLOCK): a generation under a
  // read is skipped now and purged by a later pass. After this, no new lease or read can attach.
  const locked = await query<{ id: string; kbId: string }>(
    `SELECT g.id, g."kbId" FROM index_generation g
       LEFT JOIN durable_job j ON j.id = g."jobId"
      WHERE g.id = $2
        AND NOT EXISTS (SELECT 1 FROM knowledge_base k WHERE k."activeGenerationId" = g.id)
        AND NOT EXISTS (SELECT 1 FROM generation_lease l WHERE l."generationId" = g.id
                          AND l."expiresAt" > clock_timestamp())
        AND ((g.state = 'SUPERSEDED' AND g."retiredAt" <= ${NOW_SQL} - ($3 * interval '1 millisecond'))
          OR (g.state = 'FAILED' AND j.state IN ('FAILED', 'CANCELLED')
              AND g."retiredAt" <= ${NOW_SQL} - ($4 * interval '1 millisecond')))
      FOR UPDATE OF g SKIP LOCKED`,
    [now, id, RETENTION.supersededGenerationMs, RETENTION.failedBuildMs],
  );
  const row = locked.rows[0];
  if (!row) return false;
  // Re-read leases after acquiring the lock (READ COMMITTED: a new statement snapshot).
  const leased = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM generation_lease WHERE "generationId" = $1 AND "expiresAt" > clock_timestamp()`,
    [id],
  );
  if ((leased.rows[0]?.n ?? 0) > 0) return false;
  await query('DELETE FROM generation_document WHERE "generationId" = $1', [id]);
  // Guard I1 keeps reservation ids off SUPERSEDED/FAILED rows; the PURGED tombstone holds none.
  await query(`UPDATE index_generation SET state = 'PURGED' WHERE id = $1`, [id]);
  return () => removeGenerationFiles(join(indexDir, row.kbId), id).then(() => undefined);
}

/**
 * Superseded generations 7 days after retirement and failed builds 24 hours after their
 * final attempt, never while active, building, leased or read. The generation's index files are
 * unlinked only after its PURGED row committed. Git history is never touched.
 */
export async function purgeRetiredGenerations(
  options: RetentionOptions,
): Promise<{ purged: number }> {
  const now = cutoff(options);
  const purged = await sweep(
    "retired-generations",
    options,
    async (query, afterId, limit) =>
      (
        await query<{ id: string }>(
          `SELECT id FROM index_generation
            WHERE id > $2 AND state IN ('SUPERSEDED', 'FAILED')
              AND "retiredAt" <= ${NOW_SQL} - ($4 * interval '1 millisecond')
            ORDER BY id LIMIT $3`,
          [
            now,
            afterId,
            limit,
            Math.min(RETENTION.supersededGenerationMs, RETENTION.failedBuildMs),
          ],
        )
      ).rows.map((row) => row.id),
    (query, id) => purgeOne(query, id, now, options.indexDir),
  );
  return { purged };
}

/**
 * §1.8 (f) backstop, and convergence for the one liveness rule (`build-liveness.ts`): an
 * unfinished generation whose durable job is terminal (cancelled, which never writes the
 * generation, or failed on a path that could not settle it) becomes FAILED, its reservations
 * released in the same transaction. Exhausted lease recovery already does this in its own
 * transaction. A row whose generation fence or volume account is held elsewhere is skipped
 * until the next pass.
 */
export function releaseStaleBuildReservations(options: RetentionSweepOptions): Promise<number> {
  return sweep(
    "stale-build-reservations",
    options,
    async (query, afterId, limit) =>
      (
        await query<{ id: string }>(
          `SELECT g.id FROM index_generation g
            WHERE g.id > $1 AND g.state IN ${UNFINISHED_GENERATION_STATES_SQL}
              AND NOT EXISTS (SELECT FROM durable_job j WHERE j.id = g."jobId" AND j.state IN ${LIVE_JOB_STATES_SQL})
            ORDER BY g.id LIMIT $2`,
          [afterId, limit],
        )
      ).rows.map((row) => row.id),
    (query, id) =>
      failDeadBuildGeneration(query, id, {
        errorCode: "INDEX_BUILD_FAILED",
        requireDeadJob: true,
      }),
  );
}

/**
 * Reconciler resume point (in-process; a restart rescans): the KB directory being walked and the
 * last entry name judged in it. Entries are visited in sorted (bytewise) name order, so a pass
 * that ends inside a directory resumes exactly after the last entry it charged.
 */
let reconcileCursor = { kbId: "", name: "" };

/** Test seam: restart the reconciler from the first KB. */
export function resetIndexReconcilerForTests(): void {
  reconcileCursor = { kbId: "", name: "" };
}

type ReconcileVerdict = "keep" | "remove" | "warn";

async function judgeIndexFile(
  query: LockQuery,
  kbId: string,
  name: string,
  mtimeMs: number,
  graceMs: number,
): Promise<ReconcileVerdict> {
  const parsed = parseIndexFileName(name);
  if (parsed.kind === "unknown" || parsed.kind === "side") return "warn";
  const fresh = Date.now() - mtimeMs < graceMs;
  if (parsed.kind === "temp") {
    // CL3-RECON: a running attempt's temp (and its journal, judged by the temp's name) is kept.
    if (fresh) return "keep";
    const live = await query<{ live: boolean }>(
      `SELECT EXISTS (SELECT FROM index_generation g JOIN durable_job j ON j.id = g."jobId"
          WHERE g.id = $1 AND g."kbId" = $2 AND g.state = 'BUILDING' AND g.attempt = $3
            AND j.state = 'RUNNING' AND j."attemptEpoch" = $3) AS live`,
      [parsed.generationId, kbId, parsed.attempt],
    );
    return live.rows[0]?.live ? "keep" : "remove";
  }
  // CL4-FINAL: COMPLETE, SUPERSEDED and FAILED finals belong to retention, never to this pass.
  const row = (
    await query<{ state: string; live: boolean }>(
      `SELECT g.state, EXISTS (SELECT FROM durable_job j WHERE j.id = g."jobId" AND j.state IN ${LIVE_JOB_STATES_SQL}) AS live
         FROM index_generation g WHERE g.id = $1 AND g."kbId" = $2`,
      [parsed.generationId, kbId],
    )
  ).rows[0];
  if (!row || row.state === "PURGED") return "remove";
  if ((row.state === "BUILDING" || row.state === "INDEXING") && !row.live && !fresh)
    return "remove";
  return "keep";
}

const byteOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

type DirOpener = (path: string) => Promise<AsyncIterable<Dirent> & { close(): Promise<void> }>;

/**
 * Streams one KB directory and keeps only the `limit` smallest file names that sort after
 * `after` (a sorted array of at most `limit` names: O(limit) memory, never the whole listing).
 * Stops reading once `cap` dirents were consumed (`overCap`). `more` reports names beyond the
 * selection, i.e. the directory is not finished.
 */
async function nextIndexNames(
  open: DirOpener,
  kbDir: string,
  after: string,
  limit: number,
  cap: number,
): Promise<{ names: string[]; more: boolean; overCap: boolean; read: number }> {
  const names: string[] = [];
  let more = false;
  let read = 0;
  let dir: Awaited<ReturnType<DirOpener>>;
  try {
    dir = await open(kbDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { names, more, overCap: false, read };
    throw error;
  }
  try {
    for await (const entry of dir) {
      read += 1;
      if (read > cap) return { names, more, overCap: true, read };
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (after && byteOrder(name, after) <= 0) continue;
      if (names.length === limit) {
        more = true;
        if (limit === 0 || byteOrder(name, names[limit - 1]!) >= 0) continue;
        names.pop();
      }
      let lo = 0;
      let hi = names.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (byteOrder(names[mid]!, name) < 0) lo = mid + 1;
        else hi = mid;
      }
      names.splice(lo, 0, name);
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return { names, more, overCap: false, read };
}

/**
 * Bounded reconciler over `index/<kbId>/`: unlinks temps (and `-journal`s) of attempts that are
 * not running and finals that no live owner can still publish or purge. Each entry is judged
 * with a fresh query; unparseable names and SQLite side files are logged, never removed;
 * `index/<kbId>/` directories are never removed.
 *
 * Bounds per pass (budget B = INDEX_RECONCILE_ENTRIES, cap C = KB_LIMITS.indexDirEntryCap):
 * every directory visited and every entry judged costs one unit of B; each visit reads at most C
 * dirents (a directory over the cap is skipped with a redacted warning: it can only hold the
 * bounded set of generation files, so exceeding C is itself an anomaly); memory is O(B) names.
 * So a pass reads at most B x C dirents and judges at most B entries. A pass that stops inside a
 * directory resumes after the last judged name (in-process cursor; a restart rescans).
 */
export async function reconcileIndexFiles(
  options: RetentionOptions,
): Promise<{ removed: number; examined: number; direntsRead: number }> {
  const graceMs = options.indexTempGraceMs ?? INDEX_TEMP_GRACE_MS;
  const pageSize = options.pageSize ?? RETENTION_PAGE_SIZE;
  const cap = options.indexDirEntryCap ?? KB_LIMITS.indexDirEntryCap;
  const open: DirOpener = options.openIndexDir ?? ((path) => opendir(path));
  const lease = await checkoutPinnedSession({
    connectionString: options.connectionString,
    opId: randomUUID(),
  });
  let examined = 0;
  let removed = 0;
  let direntsRead = 0;
  const warned = new Set<string>();
  try {
    pass: for (;;) {
      options.signal?.throwIfAborted();
      // Resume inside the cursor's KB when a name is pending, else after it.
      const kbs = (
        await lease.query<{ id: string }>(
          reconcileCursor.name
            ? `SELECT id FROM knowledge_base WHERE id >= $1 ORDER BY id LIMIT $2`
            : `SELECT id FROM knowledge_base WHERE id > $1 ORDER BY id LIMIT $2`,
          [reconcileCursor.kbId, pageSize],
        )
      ).rows.map((row) => row.id);
      if (kbs.length === 0) {
        reconcileCursor = { kbId: "", name: "" };
        break;
      }
      for (const kbId of kbs) {
        if (examined >= INDEX_RECONCILE_ENTRIES) break pass;
        // The directory visit itself is charged.
        examined += 1;
        const after = kbId === reconcileCursor.kbId ? reconcileCursor.name : "";
        const kbDir = join(options.indexDir, kbId);
        const next = await nextIndexNames(
          open,
          kbDir,
          after,
          INDEX_RECONCILE_ENTRIES - examined,
          cap,
        );
        direntsRead += next.read;
        if (next.overCap) {
          logEvent("kb.retention", { kbId, reason: "INDEX_DIR_OVER_CAP" });
          reconcileCursor = { kbId, name: "" };
          continue;
        }
        const doomed: string[] = [];
        for (const name of next.names) {
          examined += 1;
          reconcileCursor = { kbId, name };
          let mtimeMs: number;
          try {
            mtimeMs = (await stat(join(kbDir, name))).mtimeMs;
          } catch {
            continue;
          }
          const verdict = await judgeIndexFile(lease.query, kbId, name, mtimeMs, graceMs);
          if (verdict === "remove") doomed.push(name);
          else if (verdict === "warn" && !warned.has(`${kbId}/${name}`)) {
            warned.add(`${kbId}/${name}`);
            logEvent("kb.retention", { kbId, reason: "UNEXPECTED_INDEX_ENTRY" });
          }
        }
        for (const name of doomed) await unlinkIndexFile(join(kbDir, name));
        if (doomed.length > 0) await fsyncDirectory(kbDir);
        removed += doomed.length;
        // Names beyond the selection remain: resume after the last judged one next pass.
        if (next.more) break pass;
        reconcileCursor = { kbId, name: "" };
      }
      if (kbs.length < pageSize) {
        reconcileCursor = { kbId: "", name: "" };
        break;
      }
    }
  } finally {
    await lease.close();
  }
  return { removed, examined, direntsRead };
}

/**
 * Operation receipts: after 30 days the prepared body is reduced to its integrity projection.
 * Actor, key, request hash, result revision/status and the replay response stay forever, so a
 * retry after live reauthorization returns the same receipt and a different body under the
 * same key remains IDEMPOTENCY_MISMATCH. Only terminal intents are compacted.
 */
export function compactOperationReceipts(options: RetentionSweepOptions): Promise<number> {
  const now = cutoff(options);
  return sweep(
    "operation-receipts",
    options,
    async (query, afterId, limit) =>
      (
        await query<{ id: string }>(
          `SELECT "opId"::text AS id FROM operation_intent
            WHERE "opId"::text > $2 AND "compactedAt" IS NULL
              AND phase IN ('FINALIZED'::"OperationIntentPhase", 'ABORTED'::"OperationIntentPhase")
              AND COALESCE("finishedAt", "createdAt") <= ${NOW_SQL} - ($4 * interval '1 millisecond')
            ORDER BY "opId"::text LIMIT $3`,
          [now, afterId, limit, RETENTION.operationBodyMs],
        )
      ).rows.map((row) => row.id),
    async (query, id) => {
      const updated = await query(
        `UPDATE operation_intent SET
           "preparedDelta" = CASE WHEN "preparedDelta" IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
             'compacted', true,
             'kind', "preparedDelta"->'kind',
             'headSha', "preparedDelta"->'headSha',
             'quotaReservationId', "preparedDelta"->'quotaReservationId',
             'quotaReservationIds', "preparedDelta"->'quotaReservationIds')) END,
           "compactedAt" = clock_timestamp()
         WHERE "opId" = $1::uuid AND "compactedAt" IS NULL
           AND phase IN ('FINALIZED'::"OperationIntentPhase", 'ABORTED'::"OperationIntentPhase")`,
        [id],
      );
      return (updated.rowCount ?? 0) > 0;
    },
  );
}

/** Audit events older than 90 days. Operation receipts keep the logical integrity trail. */
export function deleteExpiredAuditEvents(options: RetentionSweepOptions): Promise<number> {
  const now = cutoff(options);
  return sweep(
    "audit-events",
    options,
    async (query, afterId, limit) =>
      (
        await query<{ id: string }>(
          `SELECT id FROM audit_event
            WHERE id > $2 AND "createdAt" <= ${NOW_SQL} - ($4 * interval '1 millisecond')
            ORDER BY id LIMIT $3`,
          [now, afterId, limit, RETENTION.auditMs],
        )
      ).rows.map((row) => row.id),
    async (query, id) => {
      const deleted = await query(
        `DELETE FROM audit_event WHERE id = $2 AND "createdAt" <= ${NOW_SQL} - ($3 * interval '1 millisecond')`,
        [now, id, RETENTION.auditMs],
      );
      return (deleted.rowCount ?? 0) > 0;
    },
  );
}

export type RetentionSchedule = "minute" | "hourly";
export type RetentionClassName =
  | "queryData"
  | "stagedUploads"
  | "generations"
  | "operationReceipts"
  | "auditEvents";

/**
 * Retention classes. Only the generations class touches the filesystem: it unlinks purged and
 * orphaned index files under `index/` of the data volume (the worker mounts it read-write).
 */
export const RETENTION_CLASSES: Record<
  RetentionClassName,
  {
    schedule: RetentionSchedule;
    touchesFilesystem: boolean;
    run: (options: RetentionOptions) => Promise<number>;
  }
> = {
  queryData: { schedule: "minute", touchesFilesystem: false, run: scrubExpiredQueryData },
  stagedUploads: { schedule: "minute", touchesFilesystem: false, run: markExpiredStagedUploads },
  generations: {
    schedule: "hourly",
    touchesFilesystem: true,
    run: async (options) => {
      const { purged } = await purgeRetiredGenerations(options);
      const released = await releaseStaleBuildReservations(options);
      const { removed } = await reconcileIndexFiles(options);
      return purged + released + removed;
    },
  },
  operationReceipts: {
    schedule: "hourly",
    touchesFilesystem: false,
    run: compactOperationReceipts,
  },
  auditEvents: { schedule: "hourly", touchesFilesystem: false, run: deleteExpiredAuditEvents },
};

export function retentionClassesFor(schedule: RetentionSchedule): RetentionClassName[] {
  return (Object.keys(RETENTION_CLASSES) as RetentionClassName[]).filter(
    (name) => schedule === "hourly" || RETENTION_CLASSES[name].schedule === "minute",
  );
}

/**
 * One scheduled pass. Classes are independent: a failing class is reported (and rethrown
 * after the others ran) so one poisoned row cannot starve the query deadline.
 */
export async function runKbRetention(
  schedule: RetentionSchedule,
  options: RetentionOptions,
): Promise<Partial<Record<RetentionClassName, number>>> {
  const counts: Partial<Record<RetentionClassName, number>> = {};
  const failures: unknown[] = [];
  for (const name of retentionClassesFor(schedule)) {
    try {
      counts[name] = await RETENTION_CLASSES[name].run(options);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, `KB retention: ${failures.length} class(es) failed`);
  return counts;
}

const auditExportSelect = {
  id: true,
  createdAt: true,
  opId: true,
  action: true,
  outcome: true,
  actorKey: true,
  actorUserIdSnapshot: true,
  grantIdSnapshot: true,
  kbId: true,
  revision: true,
  metadata: true,
} satisfies Prisma.AuditEventSelect;

/** Administrative export of the retained (≤90 day) audit trail, oldest first, keyset paged. */
export async function listAuditEventsForExport(
  prisma: Pick<PrismaClient, "auditEvent">,
  input: { cursor?: string; limit: number },
) {
  const rows = await prisma.auditEvent.findMany({
    where: withCursor({}, "createdAt", input.cursor, "asc"),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: pageTake(input.limit),
    select: auditExportSelect,
  });
  return cursorPage(rows, input.limit, "createdAt");
}
