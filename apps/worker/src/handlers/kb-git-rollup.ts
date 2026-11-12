import { randomUUID } from "node:crypto";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import {
  acknowledgeGitRollup,
  GIT_ROLLUP,
  gitRollupState,
  measureGitRollup,
  recoverGitRollup,
  rollupGitObjects,
} from "@knowledge-base/api/lib/kb/git-rollup";
import {
  checkoutPinnedSession,
  type HeldLockLease,
  type LockQuery,
  MutationScope,
} from "@knowledge-base/api/lib/kb/lock";
import { releaseQuota, reserveQuota, statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/shared";
import { kbDataPaths } from "@knowledge-base/env/topology";
import { type KbGitRollupJobData, kbGitRollupJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";

const CURSOR_KEY = "kb.git-rollup.cursor";
const PAGE_SIZE = 16;
const PASS_MS = 45_000;
const RETRY_MS = 5 * 60_000;
type Backoff = {
  level: number;
  failures: number;
  retryAt: number;
  attempt?: boolean;
  cleanup?: boolean;
  prior?: { level: number; failures: number; retryAt: number };
};
function backoff(value: string | undefined): Backoff | undefined {
  if (!value) return;
  const parsed: Backoff = JSON.parse(value);
  if (
    !Number.isSafeInteger(parsed.level) ||
    parsed.level < 0 ||
    !Number.isSafeInteger(parsed.failures) ||
    parsed.failures < 0 ||
    parsed.failures > 32 ||
    !Number.isSafeInteger(parsed.retryAt) ||
    parsed.retryAt < 0
  )
    throw new Error("Invalid rollup backoff");
  return parsed;
}
/** Back-off spaces retries; neither elapsed retries nor pressure change the cap. */
export function gitRollupRetry(previous: Backoff | undefined, level: number, now = Date.now()) {
  return {
    allowed:
      !previous ||
      now >= previous.retryAt ||
      (!previous.cleanup &&
        level >=
          previous.level + (GIT_ROLLUP.packs << Math.min(Math.max(0, previous.failures - 1), 4))),
    maxBytes: GIT_ROLLUP.maxBytes,
  };
}
async function setting(query: LockQuery, key: string, value?: Backoff | string) {
  if (value === undefined) {
    await query(`DELETE FROM "app_setting" WHERE key = $1`, [key]);
  } else {
    await query(
      `INSERT INTO "app_setting" (key, value, "updatedAt") VALUES ($1, $2, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      [key, typeof value === "string" ? value : JSON.stringify(value)],
    );
  }
}

async function maintain(lease: HeldLockLease, kbId: string) {
  const live = await lease.query<{ state: string }>(
    `SELECT state FROM "knowledge_base" WHERE id = $1`,
    [kbId],
  );
  const key = `kb.git-rollup.${kbId}`;
  const repo = kbBareRepoPath(kbDataPaths(env.KB_DATA_ROOT).reposDir, kbId);
  const options = { signal: lease.scope.signal, deadlineAt: lease.scope.deadlineAt };
  let previous = backoff(
    (await lease.query<{ value: string }>(`SELECT value FROM "app_setting" WHERE key = $1`, [key]))
      .rows[0]?.value,
  );
  const state = await gitRollupState(repo);
  // A graceful pre-prepare interruption drains and removes scratch. A crash
  // leaves unprepared scratch behind; its marker spaces recovery without ever
  // increasing the failed-fold count. A done directory settles completion.
  if (previous?.attempt && state === "none") {
    previous = previous.prior;
    await setting(lease.query, key, previous);
  }
  const quotaOp = `git-rollup-${kbId}`;
  const reservations = (
    await lease.query<{ id: string }>(
      `SELECT id FROM "quota_reservation"
    WHERE "opId" = $1 AND outcome = 'RESERVED'::"QuotaReservationOutcome" AND "releasedAt" IS NULL
    ORDER BY id LIMIT 32`,
      [quotaOp],
    )
  ).rows.map((r) => r.id);
  if (state === "none" && reservations.length) await releaseQuota(lease, reservations);
  if (state !== "none") {
    if (previous && Date.now() < previous.retryAt && (state !== "done" || previous.cleanup))
      return false;
    let completed: boolean;
    try {
      completed = await recoverGitRollup(repo, options);
    } catch (error) {
      // Recovery and post-install retirement never count as failed folds. The
      // prepared intent owns the covering pack and the held disk reservation.
      if (!lease.scope.signal.aborted)
        await setting(lease.query, key, {
          ...previous,
          level: previous?.level ?? 0,
          failures: previous?.failures ?? 0,
          retryAt: Date.now() + RETRY_MS,
          cleanup: true,
        });
      throw error;
    }
    await releaseQuota(lease, reservations);
    await setting(
      lease.query,
      key,
      completed ? undefined : previous?.attempt ? previous.prior : previous,
    );
    await acknowledgeGitRollup(repo);
    return completed;
  }
  if (live.rows[0]?.state !== "ACTIVE") return false;
  const pressure = await measureGitRollup(repo, options);
  if (!pressure.due || !gitRollupRetry(previous, pressure.level).allowed) return false;
  // A held reservation survives deadlines/crashes and cannot expire while a
  // prepared pack still occupies scratch. The next lease reconciles it before
  // new work. Filesystem accounts include pending allocations from other KBs.
  const quota = await reserveQuota(lease, {
    opId: quotaOp,
    charges: [],
    heldForPublication: true,
    expiresAt: new Date(Date.now() + RETRY_MS),
    disks: [{ path: repo, bytes: BigInt(GIT_ROLLUP.maxBytes * 3), meter: statfsDiskMeter(repo) }],
  });
  await setting(lease.query, key, {
    level: pressure.level,
    failures: previous?.failures ?? 0,
    retryAt: Date.now() + RETRY_MS,
    attempt: true,
    prior: previous,
  });
  let folded: boolean;
  try {
    folded = await rollupGitObjects(repo, pressure, options);
  } catch (error) {
    const remaining = await gitRollupState(repo);
    // Query settlement only while the owned SQL channel is active. An expired
    // lease leaves the crash marker, whose disk-derived outcome is reconciled
    // next firing. Never start detached Prisma work to settle an expired scope.
    if (!lease.scope.signal.aborted) {
      if (remaining === "none") await releaseQuota(lease, quota.reservationIds);
      const interrupted =
        error instanceof Error &&
        "code" in error &&
        ["CANCELLED", "DEADLINE_EXCEEDED", "ADMISSION_CLOSED"].includes(String(error.code));
      if (interrupted && remaining === "none") {
        await setting(lease.query, key, previous);
        throw error;
      }
      const cleanup = remaining === "installed" || remaining === "done" || remaining === "prepared";
      const failedFold = !interrupted && remaining !== "installed" && remaining !== "done";
      const failures = Math.min((previous?.failures ?? 0) + (failedFold ? 1 : 0), 32);
      await setting(lease.query, key, {
        level: pressure.level,
        failures,
        cleanup,
        retryAt: Date.now() + RETRY_MS * 2 ** Math.min(Math.max(0, failures - 1), 4),
      });
    }
    throw error;
  }
  // SQL settlement and receipt disposal are outside failed-fold classification.
  // The on-disk done receipt survives until both bookkeeping steps succeed.
  await releaseQuota(lease, quota.reservationIds);
  await setting(lease.query, key, folded ? undefined : previous);
  if (folded) await acknowledgeGitRollup(repo);
  return folded;
}

/** One persistent keyset page per firing. All SQL, including page admission,
 * uses owned deadline-aware sessions; per-KB SQL reuses its Git lock session. */
export async function handleKbGitRollupJob(job: Job<KbGitRollupJobData>, signal?: AbortSignal) {
  kbGitRollupJobSchema.parse(job.data);
  const start = Date.now(),
    end = start + PASS_MS;
  const scope = new MutationScope(randomUUID(), Date.now, end);
  const stop = () => scope.requestShutdown();
  signal?.addEventListener("abort", stop);
  if (signal?.aborted) stop();
  let page: HeldLockLease | undefined;
  let count = 0;
  try {
    page = await checkoutPinnedSession({
      connectionString: env.DATABASE_URL.reveal(),
      opId: scope.opId,
      scope,
    });
    const cursor =
      (
        await page.query<{ value: string }>(`SELECT value FROM "app_setting" WHERE key = $1`, [
          CURSOR_KEY,
        ])
      ).rows[0]?.value ?? "";
    const kbs = (
      await page.query<{ id: string }>(
        `SELECT id FROM "knowledge_base" k WHERE id > $1 AND (state = 'ACTIVE' OR EXISTS (
          SELECT 1 FROM "quota_reservation" r WHERE r."opId" = 'git-rollup-' || k.id
          AND r.outcome = 'RESERVED'::"QuotaReservationOutcome" AND r."releasedAt" IS NULL
        )) ORDER BY id LIMIT $2`,
        [cursor, PAGE_SIZE],
      )
    ).rows;
    for (const kb of kbs) {
      scope.assertActive();
      const kbStart = Date.now();
      try {
        const completed = await runLockedOperation({
          connectionString: env.DATABASE_URL.reveal(),
          opId: randomUUID(),
          kind: "kb-write",
          kbIds: [kb.id],
          signal: scope.signal,
          lockWaitMs: 250,
          mutationDeadlineAt: Math.min(end, Date.now() + GIT_ROLLUP.budgetMs),
          run: (lease) => maintain(lease, kb.id),
        });
        if (completed) count++;
        logEvent("worker.kb-git-rollup", {
          kbId: kb.id,
          stage: completed ? "completed" : "idle",
          durationMs: Date.now() - kbStart,
        });
      } catch (error) {
        logInternalError("worker.kb-git-rollup", error, {
          kbId: kb.id,
          stage: "deferred",
          durationMs: Date.now() - kbStart,
        });
      }
      await setting(page.query, CURSOR_KEY, kb.id);
    }
    if (kbs.length === 0) await setting(page.query, CURSOR_KEY);
  } finally {
    await page?.close();
    signal?.removeEventListener("abort", stop);
    scope.dispose();
  }
  logEvent("worker.kb-git-rollup", {
    jobId: job.id,
    stage: "pass",
    count,
    durationMs: Date.now() - start,
  });
  return { count };
}
