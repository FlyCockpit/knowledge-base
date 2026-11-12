/**
 * Sequential re-embedding of SYSTEM_BUILTIN knowledge bases after a built-in
 * runtime config change.
 *
 * Invariants:
 * - The `kb_qwen_reembed_lease` row durably selects one migration build across
 *   worker restarts. Actual built-in execution (including ordinary INDEX_KB
 *   jobs) owns a session permit in runIndexBuildDelivery (index-build.ts) until work drains;
 *   terminal jobs and retargeted rows cannot release that permit.
 * - Every transition runs in one authority transaction (the lease row is locked
 *   FOR UPDATE), so two workers ticking concurrently serialize.
 * - Order is stable: the KB's lastQueriedAt snapshotted at enqueue, most recent
 *   first, then kbId.
 * - A newer config change (retargetSystemBuiltinKbs) re-queues every waiting KB for
 *   the newest config and FENCES the in-flight build: its durable job is
 *   cancelled in the same transaction, so its heartbeat, chunk writes and
 *   activation all fail their attempt fence and a late result is discarded.
 * - A KB still waiting keeps serving hybrid search from its old ACTIVE
 *   generation (query-compatible while the model identity matches); a new
 *   commit to it is indexed straight into the new config (its profile was
 *   retargeted), and the driver adopts or skips that build instead of starting
 *   a second one for the KB.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@knowledge-base/db/client";
import { runLockedOperation } from "./authority-lock";
import { inProgressBuildSql, isInProgressBuild } from "./build-liveness";
import { builtinModel, QWEN_MODEL } from "./builtin-model";
import { builtinEmbeddingFingerprint, builtinModelIdentity } from "./fingerprint";
import { cancelIndexBuildJobs, scheduleIndexBuild } from "./generations";
import type { LockQuery } from "./lock";
import { QWEN_ARTIFACT } from "./model-artifact";
import { qwenRuntimeConfigSchema } from "./qwen-runtime-config";

export const QWEN_REEMBED_LEASE_ID = "qwen";
/** Worker tick; each tick does at most one transition. */
export const QWEN_REEMBED_TICK_MS = 10_000;
const MAX_SKIPS_PER_TICK = 64;

type LeaseRow = { kbId: string | null; generationId: string | null; configEpoch: number };

async function lockLease(query: LockQuery): Promise<LeaseRow> {
  await query(
    `INSERT INTO kb_qwen_reembed_lease (id, "configEpoch", "updatedAt") VALUES ($1, 0, now())
     ON CONFLICT (id) DO NOTHING`,
    [QWEN_REEMBED_LEASE_ID],
  );
  const row = (
    await query<LeaseRow>(
      `SELECT "kbId", "generationId", "configEpoch" FROM kb_qwen_reembed_lease WHERE id = $1 FOR UPDATE`,
      [QWEN_REEMBED_LEASE_ID],
    )
  ).rows[0];
  if (!row) throw new Error("re-embed lease unavailable");
  return row;
}

async function setLease(
  query: LockQuery,
  value: { kbId: string | null; generationId: string | null; configEpoch: number },
) {
  await query(
    `UPDATE kb_qwen_reembed_lease SET "kbId" = $2, "generationId" = $3, "configEpoch" = $4,
            "updatedAt" = now() WHERE id = $1`,
    [QWEN_REEMBED_LEASE_ID, value.kbId, value.generationId, value.configEpoch],
  );
}

/** Cancels a non-terminal build job; its attempt fence then rejects every later write. */
async function cancelGenerationJob(query: LockQuery, generationId: string) {
  await cancelIndexBuildJobs(query, { generationId });
}

/**
 * Authority transaction, called on a config change of a READY model and on
 * every READY transition. Points every KB attached to the system provider at
 * `version`, fences in-flight SYSTEM_BUILTIN builds for another fingerprint
 * (including the leased one), and queues every ACTIVE attached KB whose active
 * generation is not already on `fingerprint`, under `configEpoch`.
 */
export async function retargetSystemBuiltinKbs(
  query: LockQuery,
  target: { version: number; fingerprint: string; configEpoch: number },
): Promise<void> {
  const lease = await lockLease(query);
  await query(
    `UPDATE knowledge_base k SET "profileVersion" = $1
       FROM embedding_provider p
      WHERE p.id = k."profileProviderId" AND p.kind = 'SYSTEM_BUILTIN'
        AND k."profileVersion" IS DISTINCT FROM $1`,
    [target.version],
  );
  // Fence every unfinished build that would publish vectors of another config.
  await cancelIndexBuildJobs(query, { builtinFingerprintNot: target.fingerprint });
  if (lease.generationId) {
    const leased = (
      await query<{ fingerprint: string }>(
        `SELECT fingerprint FROM index_generation WHERE id = $1`,
        [lease.generationId],
      )
    ).rows[0];
    if (leased?.fingerprint !== target.fingerprint)
      await setLease(query, { kbId: null, generationId: null, configEpoch: target.configEpoch });
  }
  await query(
    `INSERT INTO kb_qwen_reembed ("kbId", "configEpoch", state, "lastQueriedAt", "updatedAt")
     SELECT k.id, $2, 'QUEUED', k."lastQueriedAt", now()
       FROM knowledge_base k
       JOIN embedding_provider p ON p.id = k."profileProviderId" AND p.kind = 'SYSTEM_BUILTIN'
       LEFT JOIN index_generation a ON a.id = k."activeGenerationId"
      WHERE k.state = 'ACTIVE' AND a.fingerprint IS DISTINCT FROM $1
     ON CONFLICT ("kbId") DO UPDATE
        SET "configEpoch" = EXCLUDED."configEpoch", state = 'QUEUED',
            "lastQueriedAt" = EXCLUDED."lastQueriedAt", "updatedAt" = now()`,
    [target.fingerprint, target.configEpoch],
  );
}

export type ReembedTick =
  | { state: "paused" }
  | { state: "idle" }
  | { state: "running"; kbId: string; generationId: string }
  | { state: "started"; kbId: string; generationId: string };

type Current = { configEpoch: number; fingerprint: string };

async function currentTarget(query: LockQuery): Promise<Current | null> {
  const row = (
    await query<{
      modelId?: string;
      runtimeIdentity?: string;
      state: string;
      configEpoch: number;
      contextTokens: number;
      kvKeyType: string;
      kvValueType: string;
    }>(
      `SELECT "modelId", "runtimeIdentity", state::text AS state, "configEpoch", "contextTokens", "kvKeyType", "kvValueType"
         FROM kb_local_model WHERE id = $1 AND "runtimeIdentity" IS NOT NULL`,
      [QWEN_ARTIFACT.modelId],
    )
  ).rows[0];
  if (row?.state !== "READY") return null;
  const model = builtinModel(row.modelId ?? QWEN_MODEL.modelId);
  if (row.runtimeIdentity !== undefined && row.runtimeIdentity !== builtinModelIdentity(model))
    return null;
  const config = qwenRuntimeConfigSchema.safeParse({
    contextTokens: row.contextTokens,
    kvKeyType: row.kvKeyType,
    kvValueType: row.kvValueType,
  });
  if (!config.success) return null;
  return {
    configEpoch: row.configEpoch,
    fingerprint: builtinEmbeddingFingerprint(model, config.data),
  };
}

/** An unfinished build of this KB for the current fingerprint (e.g. from a new commit). */
async function inProgressBuild(query: LockQuery, kbId: string, fingerprint: string) {
  return (
    await query<{ id: string }>(
      `SELECT g.id FROM knowledge_base k
         JOIN index_generation g ON g."kbId" = k.id AND g.epoch = k."desiredEpoch"
         JOIN durable_job j ON j.id = g."jobId"
        WHERE k.id = $1 AND g.fingerprint = $2 AND ${inProgressBuildSql("g", "j")}`,
      [kbId, fingerprint],
    )
  ).rows[0]?.id;
}

async function settleRow(
  query: LockQuery,
  kbId: string,
  configEpoch: number,
  state: "DONE" | "FAILED" | "QUEUED" | "RUNNING",
) {
  await query(
    `UPDATE kb_qwen_reembed SET state = $3::"QwenReembedState", "updatedAt" = now()
      WHERE "kbId" = $1 AND "configEpoch" = $2`,
    [kbId, configEpoch, state],
  );
}

/** Settles the leased build. Returns the still-running generation, or null once the slot is free. */
async function settleLease(
  query: LockQuery,
  lease: LeaseRow,
  current: Current,
): Promise<string | null> {
  if (!lease.generationId || !lease.kbId) return null;
  const g = (
    await query<{ state: string; fingerprint: string; jobState: string }>(
      `SELECT g.state::text AS state, g.fingerprint, j.state::text AS "jobState"
         FROM index_generation g JOIN durable_job j ON j.id = g."jobId" WHERE g.id = $1`,
      [lease.generationId],
    )
  ).rows[0];
  const onTarget = g?.fingerprint === current.fingerprint;
  if (g && onTarget && isInProgressBuild(g.state, g.jobState)) return lease.generationId;
  let outcome: "DONE" | "FAILED" | "QUEUED";
  if (!g || !onTarget) {
    // Built for an older config: fence it and let the row be rebuilt for the current one.
    await cancelGenerationJob(query, lease.generationId);
    outcome = "QUEUED";
  } else if (g.state === "COMPLETE") outcome = "DONE";
  else {
    const kb = (
      await query<{ active: string | null }>(
        `SELECT a.fingerprint AS active FROM knowledge_base k
           LEFT JOIN index_generation a ON a.id = k."activeGenerationId" WHERE k.id = $1`,
        [lease.kbId],
      )
    ).rows[0];
    // Superseded by a newer build for the same config (a commit), or already current.
    if (kb?.active === current.fingerprint) outcome = "DONE";
    else if (await inProgressBuild(query, lease.kbId, current.fingerprint)) outcome = "QUEUED";
    else outcome = g.state === "SUPERSEDED" ? "QUEUED" : "FAILED";
  }
  await settleRow(query, lease.kbId, current.configEpoch, outcome);
  await setLease(query, { kbId: null, generationId: null, configEpoch: current.configEpoch });
  return null;
}

/**
 * One driver step (authority transaction). Settles the in-flight build if it
 * finished, otherwise starts the next queued KB's build. Idempotent and safe to
 * call from any number of workers.
 */
export function advanceQwenReembed(runtime: { connectionString: string }): Promise<ReembedTick> {
  return runLockedOperation({
    connectionString: runtime.connectionString,
    opId: randomUUID(),
    kind: "authority",
    run: (lease) =>
      lease.transaction(async (query): Promise<ReembedTick> => {
        const current = await currentTarget(query);
        // Disabled/not READY: builds cannot run; the queue waits (never skipped).
        if (!current) return { state: "paused" };
        const slot = await lockLease(query);
        const running = await settleLease(query, slot, current);
        if (running && slot.kbId)
          return { state: "running", kbId: slot.kbId, generationId: running };
        for (let i = 0; i < MAX_SKIPS_PER_TICK; i++) {
          const next = (
            await query<{ kbId: string }>(
              `SELECT r."kbId" FROM kb_qwen_reembed r
                WHERE r.state = 'QUEUED' AND r."configEpoch" = $1
                ORDER BY r."lastQueriedAt" DESC NULLS LAST, r."kbId"
                LIMIT 1 FOR UPDATE OF r`,
              [current.configEpoch],
            )
          ).rows[0];
          if (!next) return { state: "idle" };
          const kb = (
            await query<{ state: string; kind: string | null; active: string | null }>(
              `SELECT k.state::text AS state, p.kind::text AS kind, a.fingerprint AS active
                 FROM knowledge_base k
                 LEFT JOIN embedding_provider p ON p.id = k."profileProviderId"
                 LEFT JOIN index_generation a ON a.id = k."activeGenerationId"
                WHERE k.id = $1`,
              [next.kbId],
            )
          ).rows[0];
          if (
            kb?.state !== "ACTIVE" ||
            kb.kind !== "SYSTEM_BUILTIN" ||
            kb.active === current.fingerprint
          ) {
            await settleRow(query, next.kbId, current.configEpoch, "DONE");
            continue;
          }
          const generationId =
            (await inProgressBuild(query, next.kbId, current.fingerprint)) ??
            (await scheduleIndexBuild(query, next.kbId))?.generationId;
          if (!generationId) {
            await settleRow(query, next.kbId, current.configEpoch, "FAILED");
            continue;
          }
          await settleRow(query, next.kbId, current.configEpoch, "RUNNING");
          await setLease(query, {
            kbId: next.kbId,
            generationId,
            configEpoch: current.configEpoch,
          });
          return { state: "started", kbId: next.kbId, generationId };
        }
        return { state: "idle" };
      }),
  });
}

/** Lock-free pre-check so idle workers never take the authority lock. */
export async function hasQwenReembedWork(
  prisma: Pick<PrismaClient, "$queryRaw">,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ work: boolean }>>`
    SELECT (EXISTS (SELECT 1 FROM kb_qwen_reembed_lease WHERE "generationId" IS NOT NULL)
         OR EXISTS (SELECT 1 FROM kb_qwen_reembed WHERE state = 'QUEUED'::"QwenReembedState")) AS work`;
  return rows[0]?.work === true;
}
