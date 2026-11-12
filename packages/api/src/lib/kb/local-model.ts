/// <reference path="./pg.d.ts" />
/**
 * Built-in Qwen model lifecycle state.
 *
 * Admin enable/disable, the worker's progress/READY transitions and the model
 * volume lease live here. Every admin transition runs in one authority
 * transaction that increments `epoch`, so a download belonging to an older
 * epoch can never CAS the row to READY. Disable cancels the durable job and
 * releases the disk reservation in that same transaction; the worker's own
 * cleanup is then a no-op replay, so quota is released exactly once.
 *
 * Status is DB-only: the server never mounts the model volume. The worker's
 * forked model child (apps/worker/src/lib/qwen-lifecycle.ts) runs only against
 * a READY epoch read here and discards results once that epoch changes.
 *
 * READY means verified artifact AND verified runtime: the worker marks READY
 * only after the checksum-verified file was loaded and embedded by the real
 * forked child (apps/worker/src/lib/qwen-probe.ts). Only then is the model
 * `executable` and the system SYSTEM_BUILTIN profile eligible for every user's
 * manage attach (generations.ts `usableIndexProfile`). Disable leaves READY,
 * so new builds/queries are unavailable and late results fail their fence.
 */
import { randomUUID } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isAdminRole } from "@knowledge-base/auth/roles";
import type { DurableJobState, Prisma, PrismaClient } from "@knowledge-base/db/client";
import {
  assertNoSessionOptionOverride,
  PRISMA_SESSION_OPTIONS,
} from "@knowledge-base/db/prisma-adapter";
import { Client } from "pg";
import { z } from "zod";
import { recordAuditEvent } from "./audit";
import { runLockedOperation } from "./authority-lock";
import { BUILTIN_MODELS, builtinModel, GEMMA_MODEL, QWEN_MODEL } from "./builtin-model";
import { builtinModelIdSchema, builtinRuntimeEstimates } from "./builtin-registry";
import { builtinEmbeddingFingerprint, builtinModelIdentity } from "./fingerprint";
import { enqueueDurableJobOnQuery, settleJobAttemptOnQuery } from "./jobs";
import type { LockQuery } from "./lock";
import {
  type ArtifactIdentity,
  MODEL_ARTIFACT_ERROR_CODES,
  ModelArtifactError,
  QWEN_ARTIFACT,
  recoverArtifactPublication,
} from "./model-artifact";
import { sqlAuthorityStore } from "./permissions";
import { assertLiveIdentity, KbAdmissionError } from "./principal";
import { BUILTIN_PROVIDER_REF } from "./protocol/common";
import { commitQuota, type DiskMeter, releaseQuota, reserveQuota } from "./quota";
import { QWEN_REEMBED_LEASE_ID, retargetSystemBuiltinKbs } from "./qwen-reembed";
import {
  assessBuiltinRuntimeConfig,
  DEFAULT_QWEN_RUNTIME_CONFIG,
  QWEN_KV_TYPES,
  type QwenRuntimeConfig,
  qwenRuntimeConfigSchema,
  sameQwenRuntimeConfig,
} from "./qwen-runtime-config";

export const QWEN_MODEL_ID = QWEN_ARTIFACT.modelId;
export const MODEL_VOLUME_ID = "models";
/** The one system-owned SYSTEM_BUILTIN provider (ownerId NULL); a stable public Id. */
export const SYSTEM_BUILTIN_PROVIDER_ID = BUILTIN_PROVIDER_REF.id;
const SYSTEM_BUILTIN_PROVIDER_NAME = "Built-in embedding model";
/** Not a network endpoint: the column is informational for the system provider. */

export const MODEL_VOLUME_LEASE_MS = 30_000;
/** Disk reservation outlives any plausible download; expiry only returns bytes. */
const DISK_RESERVATION_MS = 6 * 60 * 60 * 1000;

export const MODEL_ERROR_CODES = [
  ...MODEL_ARTIFACT_ERROR_CODES.filter((code) => code !== "MODEL_CANCELLED"),
  "MODEL_VOLUME_BUSY",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export const modelDownloadDesiredSchema = z.strictObject({
  modelId: builtinModelIdSchema,
  epoch: z.number().int().positive(),
});

export const localModelStates = ["DISABLED", "DOWNLOADING", "READY", "FAILED"] as const;
export type LocalModelStateName = (typeof localModelStates)[number];

/** Output projection: unknown keys are stripped, never serialized. */
export const localModelStatusSchema = z.object({
  modelId: z.string(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  state: z.enum(localModelStates),
  epoch: z.number().int().nonnegative(),
  bytesDownloaded: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  progress: z.number().min(0).max(1),
  errorCode: z.enum(MODEL_ERROR_CODES).nullable(),
  reservedBytes: z.number().int().nonnegative(),
  /** True only for READY: verified artifact plus verified child runtime. */
  executable: z.boolean(),
  /** Admin runtime config; batch and flash attention are fixed. */
  runtime: z.object({
    contextTokens: z.number().int(),
    kvKeyType: z.enum(QWEN_KV_TYPES),
    kvValueType: z.enum(QWEN_KV_TYPES),
    batchTokens: z.number().int().positive(),
    flashAttention: z.literal(true),
  }),
  /** What the worker reported; null until a worker has started. */
  memory: z.object({
    budgetBytes: z.number().int().positive().nullable(),
    availableBytes: z.number().int().nonnegative().nullable(),
    source: z.enum(["cgroup-v2", "cgroup-v1", "meminfo"]).nullable(),
    reportedAt: z.string().nullable(),
  }),
  /** Real child peak RSS (VmHWM) observed under the current config, if any. */
  peakRssBytes: z.number().int().positive().nullable(),
  /** Every selectable option: estimate and its share of the reported budget. */
  estimates: z.array(
    z.object({
      modelId: z.string(),
      recommended: z.boolean().optional(),
      smaller: z.boolean().optional(),
      contextTokens: z.number().int(),
      kvKeyType: z.enum(QWEN_KV_TYPES),
      kvValueType: z.enum(QWEN_KV_TYPES),
      bytes: z.number().int().positive(),
      source: z.enum(["measured", "estimated"]),
      percent: z.number().nonnegative().nullable(),
      level: z.enum(["ok", "warn", "block", "unknown"]),
    }),
  ),
  /**
   * A requested config awaiting its worker load probe. It takes effect
   * (becomes `runtime`) only after the probe succeeded.
   */
  pendingConfig: z
    .object({
      modelId: z.string(),
      contextTokens: z.number().int(),
      kvKeyType: z.enum(QWEN_KV_TYPES),
      kvValueType: z.enum(QWEN_KV_TYPES),
      state: z.enum(["queued", "probing"]),
      /** exclusive = the running config is stopped during the probe (brief lexical-only gap). */
      mode: z.enum(["side-by-side", "exclusive"]).nullable(),
    })
    .nullable(),
  /** The last config that failed its load probe; the previous config stayed active. */
  configError: z
    .object({
      code: z.enum([
        "MODEL_CONFIG_PROBE_FAILED",
        "MODEL_CONFIG_PROBE_TIMEOUT",
        "MODEL_CONFIG_PROBE_INTERRUPTED",
      ]),
      contextTokens: z.number().int(),
      kvKeyType: z.enum(QWEN_KV_TYPES),
      kvValueType: z.enum(QWEN_KV_TYPES),
      at: z.string(),
    })
    .nullable(),
  /** "Remove" was requested; the worker deletes the downloaded weights at its next cleanup. */
  removalPending: z.boolean(),
  /** Sequential re-embedding after the latest config change. */
  reembed: z.object({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** Opaque id of the KB being rebuilt; names are not disclosed to instance admins. */
    currentKbId: z.string().nullable(),
  }),
});
export type LocalModelStatus = z.infer<typeof localModelStatusSchema>;

export const MODEL_CONFIG_ERROR_CODES = [
  "MODEL_CONFIG_INVALID",
  "MODEL_CONFIG_MEMORY_BLOCKED",
  "MODEL_CONFIG_NEEDS_ACKNOWLEDGEMENT",
  "MODEL_MEMORY_BUDGET_UNKNOWN",
  "MODEL_REMOVE_REQUIRES_DISABLED",
] as const;
export class ModelConfigError extends Error {
  override name = "ModelConfigError";
  constructor(readonly code: (typeof MODEL_CONFIG_ERROR_CODES)[number]) {
    super(code);
  }
}

export const MODEL_CONFIG_PROBE_ERROR_CODES = [
  "MODEL_CONFIG_PROBE_FAILED",
  "MODEL_CONFIG_PROBE_TIMEOUT",
  "MODEL_CONFIG_PROBE_INTERRUPTED",
] as const;
export type ModelConfigProbeErrorCode = (typeof MODEL_CONFIG_PROBE_ERROR_CODES)[number];
const storedConfigErrorSchema = z.object({
  code: z.enum(MODEL_CONFIG_PROBE_ERROR_CODES),
  contextTokens: z.number().int(),
  kvKeyType: z.enum(QWEN_KV_TYPES),
  kvValueType: z.enum(QWEN_KV_TYPES),
  at: z.string(),
});

export const setModelRuntimeConfigInputSchema = qwenRuntimeConfigSchema.extend({
  modelId: builtinModelIdSchema.optional(),
  contextTokens: z.union([z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192)]),
  /** Required to accept an option estimated above 70% of the worker budget. */
  acknowledgeMemoryWarning: z.boolean().optional(),
});

export type LocalModelRowView = {
  modelId: string;
  state: LocalModelStateName;
  epoch: number;
  bytesDownloaded: bigint;
  errorCode: string | null;
  jobState: DurableJobState | null;
  reservedBytes: bigint;
  config?: QwenRuntimeConfig;
  runtimeIdentity?: string | null;
  peakRssBytes?: bigint | null;
  memoryBudgetBytes?: bigint | null;
  memoryAvailableBytes?: bigint | null;
  memoryBudgetSource?: string | null;
  memoryReportedAt?: Date | null;
  reembed?: { total: number; done: number; failed: number; currentKbId: string | null };
  pending?: {
    modelId: string;
    config: QwenRuntimeConfig;
    probing: boolean;
    mode: "SIDE_BY_SIDE" | "EXCLUSIVE" | null;
  } | null;
  configError?: unknown;
  removeRequestedEpoch?: number | null;
};

/** The pending (requested, not yet probed) config, or null when none/unparseable. */
function pendingQwenRuntimeConfig(row: {
  pendingContextTokens?: number | null;
  pendingKvKeyType?: string | null;
  pendingKvValueType?: string | null;
}): QwenRuntimeConfig | null {
  if (row.pendingContextTokens === null || row.pendingContextTokens === undefined) return null;
  const parsed = qwenRuntimeConfigSchema.safeParse({
    contextTokens: row.pendingContextTokens,
    kvKeyType: row.pendingKvKeyType,
    kvValueType: row.pendingKvValueType,
  });
  return parsed.success ? parsed.data : null;
}

/** A stored config that no longer parses falls back to the default (never trusted raw). */
export function storedQwenRuntimeConfig(row: {
  contextTokens: number;
  kvKeyType: string;
  kvValueType: string;
}): QwenRuntimeConfig {
  const parsed = qwenRuntimeConfigSchema.safeParse({
    contextTokens: row.contextTokens,
    kvKeyType: row.kvKeyType,
    kvValueType: row.kvValueType,
  });
  return parsed.success ? parsed.data : DEFAULT_QWEN_RUNTIME_CONFIG;
}

const positiveOrNull = (value: bigint | null | undefined) =>
  value === null || value === undefined || value <= 0n ? null : Number(value);
const budgetSources = ["cgroup-v2", "cgroup-v1", "meminfo"] as const;

function fixedCode(code: string | null): ModelErrorCode {
  return (MODEL_ERROR_CODES as readonly string[]).includes(code ?? "")
    ? (code as ModelErrorCode)
    : "MODEL_DOWNLOAD_FAILED";
}

/** Effective state: a DOWNLOADING row whose durable job is exhausted/cancelled is FAILED. */
function effectiveState(row: Pick<LocalModelRowView, "state" | "jobState">): LocalModelStateName {
  if (row.state === "DOWNLOADING" && (row.jobState === "FAILED" || row.jobState === "CANCELLED"))
    return "FAILED";
  return row.state;
}

export function projectLocalModelStatus(row: LocalModelRowView | null): LocalModelStatus {
  const model = builtinModel(row ? row.modelId : GEMMA_MODEL.modelId);
  const total = model.sizeBytes;
  const state = row ? effectiveState(row) : "DISABLED";
  const config =
    row?.config ??
    (row ? DEFAULT_QWEN_RUNTIME_CONFIG : { ...DEFAULT_QWEN_RUNTIME_CONFIG, contextTokens: 1024 });
  const budget = positiveOrNull(row?.memoryBudgetBytes);
  const bytes = row ? Number(row.bytesDownloaded < 0n ? 0n : row.bytesDownloaded) : 0;
  const bounded = Math.min(bytes, total);
  return {
    modelId: model.modelId,
    fileName: model.fileName,
    sizeBytes: model.sizeBytes,
    sha256: model.sha256,
    state,
    epoch: row?.epoch ?? 0,
    bytesDownloaded: bounded,
    totalBytes: total,
    progress: state === "READY" ? 1 : bounded / total,
    errorCode: state === "FAILED" ? fixedCode(row?.errorCode ?? null) : null,
    reservedBytes: row ? Number(row.reservedBytes) : 0,
    executable: state === "READY" && row?.runtimeIdentity === builtinModelIdentity(model),
    runtime: {
      ...config,
      batchTokens: model.batchTokens === "full-input" ? config.contextTokens : model.batchTokens,
      flashAttention: true,
    },
    memory: {
      budgetBytes: budget,
      availableBytes:
        row?.memoryAvailableBytes === null || row?.memoryAvailableBytes === undefined
          ? null
          : Number(row.memoryAvailableBytes < 0n ? 0n : row.memoryAvailableBytes),
      source: (budgetSources as readonly string[]).includes(row?.memoryBudgetSource ?? "")
        ? (row?.memoryBudgetSource as (typeof budgetSources)[number])
        : null,
      reportedAt: row?.memoryReportedAt?.toISOString() ?? null,
    },
    peakRssBytes: positiveOrNull(row?.peakRssBytes),
    estimates: builtinRuntimeEstimates(budget),
    pendingConfig: row?.pending
      ? {
          ...row.pending.config,
          modelId: row.pending.modelId,
          state: row.pending.probing ? "probing" : "queued",
          mode: !row.pending.probing
            ? null
            : row.pending.mode === "EXCLUSIVE"
              ? "exclusive"
              : "side-by-side",
        }
      : null,
    configError: storedConfigErrorSchema.safeParse(row?.configError).data ?? null,
    removalPending:
      row !== null &&
      (state === "DISABLED" || state === "FAILED") &&
      row.removeRequestedEpoch === row.epoch,
    reembed: row?.reembed ?? { total: 0, done: 0, failed: 0, currentKbId: null },
  };
}

const statusSelect = {
  modelId: true,
  pendingModelId: true,
  state: true,
  epoch: true,
  bytesDownloaded: true,
  errorCode: true,
  quotaReservationIds: true,
  job: { select: { state: true } },
  contextTokens: true,
  kvKeyType: true,
  kvValueType: true,
  configEpoch: true,
  runtimeIdentity: true,
  peakRssBytes: true,
  memoryBudgetBytes: true,
  memoryAvailableBytes: true,
  memoryBudgetSource: true,
  memoryReportedAt: true,
  pendingContextTokens: true,
  pendingKvKeyType: true,
  pendingKvValueType: true,
  probeMode: true,
  probeOwner: true,
  probeLeaseUntil: true,
  configError: true,
  removeRequestedEpoch: true,
} satisfies Prisma.LocalModelSelect;

type StatusDb = Pick<PrismaClient, "localModel" | "$queryRaw">;

/**
 * How many live knowledge bases use the built-in model as their embedding
 * profile: what disabling it or applying new runtime settings affects
 * (R3-W9). A count only, for the instance admin.
 */
export async function countBuiltinAttachedKbs(
  prisma: Pick<PrismaClient, "knowledgeBase">,
): Promise<number> {
  return prisma.knowledgeBase.count({
    where: { state: "ACTIVE", profileProviderId: SYSTEM_BUILTIN_PROVIDER_ID },
  });
}

export async function getLocalModelStatus(prisma: StatusDb): Promise<LocalModelStatus> {
  const row = await prisma.localModel.findUnique({
    where: { id: QWEN_MODEL_ID },
    select: statusSelect,
  });
  if (!row) return projectLocalModelStatus(null);
  const progress = await prisma.$queryRaw<
    Array<{ total: number; done: number; failed: number; currentKbId: string | null }>
  >`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE state = 'DONE'::"QwenReembedState")::int AS done,
           count(*) FILTER (WHERE state = 'FAILED'::"QwenReembedState")::int AS failed,
           (SELECT "kbId" FROM kb_qwen_reembed_lease WHERE id = ${QWEN_REEMBED_LEASE_ID}) AS "currentKbId"
      FROM kb_qwen_reembed WHERE "configEpoch" = ${row.configEpoch}`;
  const reserved =
    row.quotaReservationIds.length === 0
      ? [{ total: "0" }]
      : await prisma.$queryRaw<Array<{ total: string }>>`
          SELECT COALESCE(SUM(amount), 0)::text AS total FROM quota_reservation
           WHERE id = ANY(${row.quotaReservationIds}::text[])
             AND outcome = 'RESERVED'::"QuotaReservationOutcome"`;
  return projectLocalModelStatus({
    modelId: row.modelId,
    state: row.state,
    epoch: row.epoch,
    bytesDownloaded: row.bytesDownloaded,
    errorCode: row.errorCode,
    jobState: row.job?.state ?? null,
    reservedBytes: BigInt(reserved[0]?.total ?? "0"),
    config: storedQwenRuntimeConfig(row),
    runtimeIdentity: row.runtimeIdentity,
    peakRssBytes: row.peakRssBytes,
    memoryBudgetBytes: row.memoryBudgetBytes,
    memoryAvailableBytes: row.memoryAvailableBytes,
    memoryBudgetSource: row.memoryBudgetSource,
    memoryReportedAt: row.memoryReportedAt,
    reembed: progress[0] ?? { total: 0, done: 0, failed: 0, currentKbId: null },
    pending: (() => {
      const config = pendingQwenRuntimeConfig(row);
      if (!config) return null;
      const probing =
        row.probeOwner !== null &&
        row.probeLeaseUntil !== null &&
        row.probeLeaseUntil.getTime() > Date.now();
      return {
        modelId: row.pendingModelId ?? row.modelId,
        config,
        probing,
        mode: probing ? row.probeMode : null,
      };
    })(),
    configError: row.configError,
    removeRequestedEpoch: row.removeRequestedEpoch,
  });
}

export type ModelRuntime = { prisma: StatusDb; connectionString: string };

async function inAuthorityTransaction<T>(
  runtime: ModelRuntime,
  work: (query: LockQuery) => Promise<T>,
): Promise<T> {
  return runLockedOperation({
    connectionString: runtime.connectionString,
    opId: randomUUID(),
    kind: "authority",
    run: (lease) => lease.transaction(work),
  });
}

type LockedRow = {
  modelId: string;
  pendingModelId?: string | null;
  state: LocalModelStateName;
  epoch: number;
  jobId: string | null;
  quotaReservationIds: string[];
  jobState: DurableJobState | null;
  contextTokens: number;
  kvKeyType: string;
  kvValueType: string;
  configEpoch: number;
  runtimeIdentity: string | null;
  pendingRuntimeIdentity: string | null;
  configError: unknown;
  memoryBudgetBytes: string | null;
  pendingContextTokens?: number | null;
  pendingKvKeyType?: string | null;
  pendingKvValueType?: string | null;
  probeEpoch?: number;
  probeOwner?: string | null;
  /** The probe claim's lease is still live. */
  probeLive?: boolean;
  removeRequestedEpoch?: number | null;
};

async function lockModelRow(query: LockQuery): Promise<LockedRow> {
  await query(
    `INSERT INTO kb_local_model (id, "modelId", "contextTokens", "updatedAt") VALUES ($1, $2, 1024, now()) ON CONFLICT (id) DO NOTHING`,
    [QWEN_MODEL_ID, GEMMA_MODEL.modelId],
  );
  const rows = await query<LockedRow>(
    `SELECT m."modelId", m."pendingModelId", m.state::text AS state, m.epoch, m."jobId", m."quotaReservationIds",
            j.state::text AS "jobState", m."contextTokens", m."kvKeyType", m."kvValueType",
            m."configEpoch", m."runtimeIdentity", m."pendingRuntimeIdentity", m."configError", m."memoryBudgetBytes"::text AS "memoryBudgetBytes",
            m."pendingContextTokens", m."pendingKvKeyType", m."pendingKvValueType",
            m."probeEpoch", m."probeOwner", m."removeRequestedEpoch",
            COALESCE(m."probeLeaseUntil" > clock_timestamp(), false) AS "probeLive"
       FROM kb_local_model m LEFT JOIN durable_job j ON j.id = m."jobId"
      WHERE m.id = $1
      FOR UPDATE OF m`,
    [QWEN_MODEL_ID],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("local model row unavailable");
  return row;
}

async function cancelModelJob(query: LockQuery, jobId: string | null) {
  if (!jobId) return;
  // Clearing the worker fence makes a running attempt's heartbeat fail.
  await query(
    `UPDATE durable_job
        SET state = 'CANCELLED', "cancelledAt" = now(), "updatedAt" = now(),
            "dispatchOwner" = NULL, "dispatchClaimUntil" = NULL,
            "workerOwner" = NULL, "leaseUntil" = NULL
      WHERE id = $1 AND state NOT IN ('COMPLETE', 'CANCELLED')`,
    [jobId],
  );
}

async function releaseReservations(query: LockQuery, ids: readonly string[]) {
  if (ids.length > 0) await releaseQuota({ transactionQuery: query }, ids);
}

/** Instance-admin actor for model lifecycle audit; worker outcomes use `system:worker`. */
export type ModelAuditActor = { userId: string };

/** Human mutations reauthorize after the authority wait, before even a no-op. */
async function assertModelAdmin(query: LockQuery, actor: ModelAuditActor | undefined) {
  // Worker/test setup has no human actor; the only production human callers are
  // the three adminOr404Procedure handlers, which always supply their actor.
  if (!actor) return;
  assertLiveIdentity(await sqlAuthorityStore(query).loadIdentity(actor.userId));
  const { rows } = await query<{ role: string | null; emailVerified: boolean | null }>(
    `SELECT role, "emailVerified" FROM "user" WHERE id = $1`,
    [actor.userId],
  );
  if (!rows[0]?.emailVerified || !isAdminRole(rows[0].role))
    throw new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
}

async function auditModel(
  query: LockQuery,
  action:
    | "model_enable"
    | "model_disable"
    | "model_remove"
    | "model_runtime_config"
    | "model_download",
  opId: string,
  actor: ModelAuditActor | "system:worker" | undefined,
  outcome: "SUCCESS" | "FAILURE" = "SUCCESS",
  state?: string,
): Promise<void> {
  const system = actor === undefined || actor === "system:worker";
  const actorKey = system ? (actor ?? "system:admin") : `user:${actor.userId}`;
  await recordAuditEvent(query, {
    opId,
    action,
    outcome,
    actorKey,
    actorUserIdSnapshot: system ? actorKey : actor.userId,
    actorUserId: system ? null : actor.userId,
    metadata: state ? { state } : undefined,
  });
}

/** Download once per epoch; READY can retry an unverified runtime identity. */
export async function enableLocalModel(
  runtime: ModelRuntime,
  actor?: ModelAuditActor,
  input?: { acknowledgeMemoryWarning?: boolean },
): Promise<LocalModelStatus> {
  await inAuthorityTransaction(runtime, async (query) => {
    await assertModelAdmin(query, actor);
    const row = await lockModelRow(query);
    const state = effectiveState(row);
    if (state === "READY") {
      await queueRuntimeUpgrade(query, row, true);
      return;
    }
    if (state === "DOWNLOADING") return;
    const assessment = assessBuiltinRuntimeConfig(
      builtinModel(row.modelId),
      storedQwenRuntimeConfig(row),
      row.memoryBudgetBytes === null ? null : Number(row.memoryBudgetBytes),
    );
    if (assessment.level === "unknown") throw new ModelConfigError("MODEL_MEMORY_BUDGET_UNKNOWN");
    if (assessment.level === "block") throw new ModelConfigError("MODEL_CONFIG_MEMORY_BLOCKED");
    if (assessment.level === "warn" && input?.acknowledgeMemoryWarning !== true)
      throw new ModelConfigError("MODEL_CONFIG_NEEDS_ACKNOWLEDGEMENT");
    await cancelModelJob(query, row.jobId);
    await releaseReservations(query, row.quotaReservationIds);
    const model = builtinModel(row.modelId);
    const epoch = row.epoch + 1;
    const jobId = randomUUID();
    await enqueueDurableJobOnQuery(query, {
      jobId,
      dedupKey: `model-download:${QWEN_MODEL_ID}:${epoch}`,
      kind: "DOWNLOAD_MODEL",
      desired: { modelId: model.modelId, epoch },
    });
    await query(
      `UPDATE kb_local_model
          SET state = 'DOWNLOADING', epoch = $2, "bytesDownloaded" = 0, "errorCode" = NULL,
              "jobId" = $3, "quotaReservationIds" = '{}', "readyAt" = NULL,
              ${RESET_PROBE_SQL}, "updatedAt" = now()
        WHERE id = $1`,
      [QWEN_MODEL_ID, epoch, jobId],
    );
    // One logical event per epoch transition; the durable job id names it.
    await auditModel(query, "model_enable", jobId, actor, "SUCCESS", "DOWNLOADING");
  });
  return getLocalModelStatus(runtime.prisma);
}

/**
 * Increments the epoch, cancels the durable job and releases the disk
 * reservation atomically. A verified file already on the volume is kept, so a
 * later enable re-verifies it without downloading.
 */
export async function disableLocalModel(
  runtime: ModelRuntime,
  actor?: ModelAuditActor,
): Promise<LocalModelStatus> {
  await inAuthorityTransaction(runtime, async (query) => {
    await assertModelAdmin(query, actor);
    const row = await lockModelRow(query);
    if (row.state === "DISABLED") return;
    await auditModel(
      query,
      "model_disable",
      `model-disable:${row.epoch + 1}`,
      actor,
      "SUCCESS",
      "DISABLED",
    );
    await cancelModelJob(query, row.jobId);
    await releaseReservations(query, row.quotaReservationIds);
    await query(
      `UPDATE kb_local_model
          SET state = 'DISABLED', epoch = epoch + 1, "bytesDownloaded" = 0, "errorCode" = NULL,
              "quotaReservationIds" = '{}', "readyAt" = NULL,
              ${RESET_PROBE_SQL}, "updatedAt" = now()
        WHERE id = $1`,
      [QWEN_MODEL_ID],
    );
  });
  return getLocalModelStatus(runtime.prisma);
}

/**
 * "Remove": Disable keeps the verified weights so a later enable re-verifies them without
 * downloading; Remove asks the worker, which owns the model volume, to delete both registry
 * files at its next cleanup (`cleanupUnusedBuiltinModelFiles`). Only a DISABLED or FAILED
 * model; the request is bound to the current epoch, so enabling first voids it. Generations
 * built with the weights keep serving search over their FTS5 arm.
 */
export async function removeLocalModelFiles(
  runtime: ModelRuntime,
  actor?: ModelAuditActor,
): Promise<LocalModelStatus> {
  await inAuthorityTransaction(runtime, async (query) => {
    await assertModelAdmin(query, actor);
    const row = await lockModelRow(query);
    const state = effectiveState(row);
    if (state !== "DISABLED" && state !== "FAILED")
      throw new ModelConfigError("MODEL_REMOVE_REQUIRES_DISABLED");
    if (row.removeRequestedEpoch === row.epoch) return;
    await auditModel(query, "model_remove", `model-remove:${row.epoch}`, actor, "SUCCESS", state);
    await query(
      `UPDATE kb_local_model SET "removeRequestedEpoch" = epoch, "updatedAt" = now() WHERE id = $1`,
      [QWEN_MODEL_ID],
    );
  });
  return getLocalModelStatus(runtime.prisma);
}

/** Fence ownership at every model epoch transition without losing requested settings. */
const RESET_PROBE_SQL = `"probeEpoch" = "probeEpoch" + 1, "probeMode" = NULL,
  "probeOwner" = NULL, "probeLeaseUntil" = NULL`;
/** Clears the pending request and fences any old claim. */
const CLEAR_PENDING_SQL = `"pendingModelId" = NULL, "pendingRuntimeIdentity" = NULL, "pendingContextTokens" = NULL, "pendingKvKeyType" = NULL,
  "pendingKvValueType" = NULL, ${RESET_PROBE_SQL}`;

/**
 * Reuse the durable config-probe request for a native identity upgrade. No
 * provider revision or rebuild is published before the current binary passes
 * its probe. A failed/interrupted identity stays terminal until an admin retry
 * or a different deployment identity; worker restarts never retry a bad probe.
 * Authority transaction -> model row lock; the existing worker then owns the
 * volume hold -> probe claim -> child. Queued intent precedes that child.
 */
async function queueRuntimeUpgrade(query: LockQuery, row: LockedRow, retry = false) {
  const identity = builtinModelIdentity(builtinModel(row.pendingModelId ?? row.modelId));
  if (row.state !== "READY" || !row.jobId || row.runtimeIdentity === identity) return;
  if (row.pendingRuntimeIdentity === identity && pendingQwenRuntimeConfig(row)) return;
  const error = z.object({ runtimeIdentity: z.string() }).safeParse(row.configError);
  if (!retry && error.success && error.data.runtimeIdentity === identity) return;
  // Preserve a requested config through upgrade, including legacy requests.
  const config = pendingQwenRuntimeConfig(row) ?? storedQwenRuntimeConfig(row);
  await query(
    `UPDATE kb_local_model
        SET "pendingContextTokens" = $2, "pendingKvKeyType" = $3, "pendingKvValueType" = $4,
            "pendingRuntimeIdentity" = $5, ${RESET_PROBE_SQL},
            "configError" = NULL, "updatedAt" = now()
      WHERE id = $1`,
    [QWEN_MODEL_ID, config.contextTokens, config.kvKeyType, config.kvValueType, identity],
  );
}

/** Production worker reconciliation; safe to replay on startup and every tick. */
export async function reconcileQwenRuntimeIdentity(runtime: ModelRuntime): Promise<void> {
  await inAuthorityTransaction(runtime, async (query) => {
    const row = await lockModelRow(query);
    // Dispatcher exhaustion and pre-atomic-settlement crash residues have no
    // runnable delivery. Settle their model/quota on every production probe
    // tick, under the same authority/model locks as ordinary completion.
    if (
      row.state === "DOWNLOADING" &&
      ["COMPLETE", "FAILED", "CANCELLED"].includes(row.jobState ?? "")
    ) {
      await finishModelDownloadOnQuery(query, row, {
        state: "FAILED",
        code: "MODEL_DOWNLOAD_FAILED",
      });
      return;
    }
    await queueRuntimeUpgrade(query, row);
  });
}

/**
 * Admin runtime config change, one authority
 * transaction. The server gate is authoritative: the estimate for the
 * requested option against the budget the worker reported must be below 90%
 * (> 70% needs an explicit acknowledgement); an unknown budget fails closed.
 *
 * On a READY model the request is only QUEUED for a worker load probe: the
 * active config, its fingerprint and every KB stay as they are until the probe
 * succeeds (commitQwenConfigProbe switches, creates the revision and queues
 * re-embedding). Requesting the active config cancels a pending one. A model
 * that is not READY has no child to protect: the config is stored directly and
 * the next READY probe (the download's runtime probe) loads it.
 */
export async function setLocalModelRuntimeConfig(
  runtime: ModelRuntime,
  raw: z.input<typeof setModelRuntimeConfigInputSchema>,
  actor?: ModelAuditActor,
): Promise<void> {
  const { acknowledgeMemoryWarning, modelId, ...config } =
    setModelRuntimeConfigInputSchema.parse(raw);
  await inAuthorityTransaction(runtime, async (query) => {
    await assertModelAdmin(query, actor);
    const row = await lockModelRow(query);
    await auditModel(query, "model_runtime_config", randomUUID(), actor);
    const model = builtinModel(modelId ?? row.modelId);
    if (
      !model.contextTiers.includes(config.contextTokens) ||
      (!model.causal && (config.kvKeyType !== "f16" || config.kvValueType !== "f16"))
    )
      throw new ModelConfigError("MODEL_CONFIG_INVALID");
    const pending = pendingQwenRuntimeConfig(row);
    const ready = row.state === "READY" && row.jobId !== null;
    if (
      row.modelId === model.modelId &&
      sameQwenRuntimeConfig(storedQwenRuntimeConfig(row), config)
    ) {
      if (pending)
        await query(
          `UPDATE kb_local_model SET ${CLEAR_PENDING_SQL}, "updatedAt" = now() WHERE id = $1`,
          [QWEN_MODEL_ID],
        );
      await queueRuntimeUpgrade(
        query,
        { ...row, pendingContextTokens: null, pendingModelId: null, pendingRuntimeIdentity: null },
        true,
      );
      return;
    }
    if (
      ready &&
      pending &&
      (row.pendingModelId ?? row.modelId) === model.modelId &&
      sameQwenRuntimeConfig(pending, config)
    )
      return;
    const budget = row.memoryBudgetBytes === null ? null : Number(row.memoryBudgetBytes);
    const { level } = assessBuiltinRuntimeConfig(model, config, budget);
    if (level === "unknown") throw new ModelConfigError("MODEL_MEMORY_BUDGET_UNKNOWN");
    if (level === "block") throw new ModelConfigError("MODEL_CONFIG_MEMORY_BLOCKED");
    if (level === "warn" && acknowledgeMemoryWarning !== true)
      throw new ModelConfigError("MODEL_CONFIG_NEEDS_ACKNOWLEDGEMENT");
    if (!ready) {
      await query(
        `UPDATE kb_local_model
            SET "modelId" = $6, "contextTokens" = $2, "kvKeyType" = $3, "kvValueType" = $4, "configEpoch" = $5,
                "peakRssBytes" = NULL, "configError" = NULL, ${CLEAR_PENDING_SQL}, "updatedAt" = now()
          WHERE id = $1`,
        [
          QWEN_MODEL_ID,
          config.contextTokens,
          config.kvKeyType,
          config.kvValueType,
          row.configEpoch + 1,
          model.modelId,
        ],
      );
      if (row.state === "DOWNLOADING") {
        await cancelModelJob(query, row.jobId);
        await releaseReservations(query, row.quotaReservationIds);
        const jobId = randomUUID();
        const epoch = row.epoch + 1;
        await enqueueDurableJobOnQuery(query, {
          jobId,
          dedupKey: `model-download:${QWEN_MODEL_ID}:${epoch}`,
          kind: "DOWNLOAD_MODEL",
          desired: { modelId: model.modelId, epoch },
        });
        await query(
          `UPDATE kb_local_model SET epoch = $2, "jobId" = $3, "bytesDownloaded" = 0,
          "quotaReservationIds" = '{}', "errorCode" = NULL, "updatedAt" = now() WHERE id = $1`,
          [QWEN_MODEL_ID, epoch, jobId],
        );
      }
      return;
    }
    await query(
      `UPDATE kb_local_model
          SET "pendingModelId" = $7, "pendingContextTokens" = $2, "pendingKvKeyType" = $3, "pendingKvValueType" = $4,
              "pendingRuntimeIdentity" = $6, "probeEpoch" = $5, "probeMode" = NULL, "probeOwner" = NULL, "probeLeaseUntil" = NULL,
              "configError" = NULL, "updatedAt" = now()
        WHERE id = $1`,
      [
        QWEN_MODEL_ID,
        config.contextTokens,
        config.kvKeyType,
        config.kvValueType,
        (row.probeEpoch ?? 0) + 1,
        builtinModelIdentity(model),
        model.modelId,
      ],
    );
  });
}

// ---- worker side: config load probe --------------------------------

export type QwenConfigProbeState = {
  modelId: string;
  modelEpoch: number;
  active: QwenRuntimeConfig;
  activePeakBytes: number | null;
  pending: {
    probeEpoch: number;
    config: QwenRuntimeConfig;
    modelId: string;
    requiresExclusive: boolean;
    claim: { owner: string; mode: "side-by-side" | "exclusive"; expired: boolean } | null;
  } | null;
};

/** Lock-free read for the worker tick; null unless the model is READY. */
export async function readQwenConfigProbe(
  prisma: Pick<PrismaClient, "$queryRaw">,
): Promise<QwenConfigProbeState | null> {
  const row = (
    await prisma.$queryRaw<
      Array<{
        modelId: string;
        pendingModelId: string | null;
        epoch: number;
        runtimeIdentity: string | null;
        contextTokens: number;
        kvKeyType: string;
        kvValueType: string;
        peakRssBytes: string | null;
        pendingContextTokens: number | null;
        pendingKvKeyType: string | null;
        pendingKvValueType: string | null;
        probeEpoch: number;
        probeMode: string | null;
        probeOwner: string | null;
        expired: boolean;
      }>
    >`
      SELECT "modelId", "pendingModelId", epoch, "runtimeIdentity", "contextTokens", "kvKeyType", "kvValueType", "peakRssBytes"::text AS "peakRssBytes",
             "pendingContextTokens", "pendingKvKeyType", "pendingKvValueType", "probeEpoch",
             "probeMode"::text AS "probeMode", "probeOwner",
             COALESCE("probeLeaseUntil" <= clock_timestamp(), true) AS expired
        FROM kb_local_model WHERE id = ${QWEN_MODEL_ID} AND state = 'READY'
          AND ("pendingRuntimeIdentity" IN (${builtinModelIdentity(QWEN_MODEL)}, ${builtinModelIdentity(GEMMA_MODEL)}) OR "pendingContextTokens" IS NULL)`
  )[0];
  if (!row) return null;
  const config = pendingQwenRuntimeConfig(row);
  const peak = row.peakRssBytes === null ? null : Number(row.peakRssBytes);
  return {
    modelId: row.modelId,
    modelEpoch: row.epoch,
    active: storedQwenRuntimeConfig(row),
    activePeakBytes: peak !== null && peak > 0 ? peak : null,
    pending: config
      ? {
          probeEpoch: row.probeEpoch,
          config,
          modelId: row.pendingModelId ?? row.modelId,
          requiresExclusive:
            row.runtimeIdentity !== builtinModelIdentity(builtinModel(row.modelId)),
          claim:
            row.probeOwner === null
              ? null
              : {
                  owner: row.probeOwner,
                  mode: row.probeMode === "EXCLUSIVE" ? "exclusive" : "side-by-side",
                  expired: row.expired,
                },
        }
      : null,
  };
}

export const QWEN_PROBE_CLAIM_MS = 60_000;

/** CAS: only an unclaimed request of this probeEpoch on a READY model. */
export async function claimQwenConfigProbe(
  prisma: LeaseDb,
  input: { owner: string; probeEpoch: number; mode: "side-by-side" | "exclusive"; ttlMs?: number },
): Promise<boolean> {
  const mode = input.mode === "exclusive" ? "EXCLUSIVE" : "SIDE_BY_SIDE";
  const ttl = `${Math.max(1, Math.round(input.ttlMs ?? QWEN_PROBE_CLAIM_MS))} milliseconds`;
  const updated = await prisma.$executeRaw`
    UPDATE kb_local_model
       SET "probeMode" = ${mode}::"QwenProbeMode", "probeOwner" = ${input.owner},
           "probeLeaseUntil" = clock_timestamp() + ${ttl}::interval, "updatedAt" = now()
     WHERE id = ${QWEN_MODEL_ID} AND state = 'READY' AND "probeEpoch" = ${input.probeEpoch}
       AND "pendingContextTokens" IS NOT NULL AND "probeOwner" IS NULL
       AND "pendingRuntimeIdentity" IN (${builtinModelIdentity(QWEN_MODEL)}, ${builtinModelIdentity(GEMMA_MODEL)})`;
  return updated === 1;
}

/** Extends a live claim; false when it was lost (new request, settled, or expired). */
export async function renewQwenConfigProbe(
  runtime: { connectionString: string },
  input: { owner: string; probeEpoch: number; ttlMs?: number },
): Promise<boolean> {
  return modelSqlQuery(runtime.connectionString, async (query) => {
    await query("SELECT id FROM kb_local_model WHERE id=$1 FOR UPDATE", [QWEN_MODEL_ID]);
    const updated = await query(
      `UPDATE kb_local_model
      SET "probeLeaseUntil" = clock_timestamp() + ($4::double precision * interval '1 millisecond')
      WHERE id=$1 AND "probeEpoch"=$2 AND "probeOwner"=$3
        AND state='READY' AND "probeLeaseUntil" > clock_timestamp()
        AND "pendingRuntimeIdentity" IN ($5, $6)`,
      [
        QWEN_MODEL_ID,
        input.probeEpoch,
        input.owner,
        input.ttlMs ?? QWEN_PROBE_CLAIM_MS,
        builtinModelIdentity(QWEN_MODEL),
        builtinModelIdentity(GEMMA_MODEL),
      ],
    );
    return updated.rowCount === 1;
  });
}

/**
 * Successful probe: the ONLY path that switches a READY model's config. One
 * authority transaction: the active config becomes the probed one, the
 * SYSTEM_BUILTIN revision for its fingerprint is ensured, and every attached KB is
 * retargeted and queued for sequential re-embedding. A stale claim
 * (newer request / settled) changes nothing; a model no longer READY releases
 * the claim and keeps the request queued.
 */
export async function commitQwenConfigProbe(
  runtime: ModelRuntime,
  input: { owner: string; probeEpoch: number; peakRssBytes: number | null },
): Promise<boolean> {
  return inAuthorityTransaction(runtime, async (query) => {
    const row = await lockModelRow(query);
    const config = pendingQwenRuntimeConfig(row);
    if (
      !config ||
      row.probeEpoch !== input.probeEpoch ||
      row.probeOwner !== input.owner ||
      !row.probeLive ||
      row.pendingRuntimeIdentity !==
        builtinModelIdentity(builtinModel(row.pendingModelId ?? row.modelId))
    )
      return false;
    if (row.state !== "READY" || !row.jobId) {
      await query(
        `UPDATE kb_local_model SET "probeMode" = NULL, "probeOwner" = NULL, "probeLeaseUntil" = NULL,
                "updatedAt" = now() WHERE id = $1`,
        [QWEN_MODEL_ID],
      );
      return false;
    }
    const model = builtinModel(row.pendingModelId ?? row.modelId);
    const peak = input.peakRssBytes;
    const configEpoch = row.configEpoch + 1;
    await query(
      `UPDATE kb_local_model
          SET "modelId" = $9, "contextTokens" = $2, "kvKeyType" = $3, "kvValueType" = $4, "configEpoch" = $5,
              "peakRssBytes" = $6, "runtimeIdentity" = $7, epoch = $8, "configError" = NULL, ${CLEAR_PENDING_SQL}, "updatedAt" = now()
        WHERE id = $1`,
      [
        QWEN_MODEL_ID,
        config.contextTokens,
        config.kvKeyType,
        config.kvValueType,
        configEpoch,
        peak !== null && Number.isSafeInteger(peak) && peak > 0 ? peak : null,
        builtinModelIdentity(model),
        row.runtimeIdentity === builtinModelIdentity(model) ? row.epoch : row.epoch + 1,
        model.modelId,
      ],
    );
    const version = await ensureSystemBuiltinProvider(query, row.jobId, config, model.modelId);
    await retargetSystemBuiltinKbs(query, {
      version,
      fingerprint: builtinEmbeddingFingerprint(model, config),
      configEpoch,
    });
    return true;
  });
}

/**
 * Failed probe: the request is rejected with a fixed code and the last good
 * config stays active (nothing else changes). `interrupted` settles a claim
 * whose worker died mid-probe (its lease expired) and requires exactly that.
 */
export async function failQwenConfigProbe(
  runtime: ModelRuntime,
  input: {
    owner: string;
    probeEpoch: number;
    code: ModelConfigProbeErrorCode;
    interrupted?: boolean;
  },
): Promise<boolean> {
  return inAuthorityTransaction(runtime, async (query) => {
    const row = await lockModelRow(query);
    const config = pendingQwenRuntimeConfig(row);
    if (
      !config ||
      row.probeEpoch !== input.probeEpoch ||
      row.pendingRuntimeIdentity !==
        builtinModelIdentity(builtinModel(row.pendingModelId ?? row.modelId))
    )
      return false;
    if (
      input.interrupted
        ? row.probeOwner === null || row.probeOwner === undefined || row.probeLive
        : row.probeOwner !== input.owner
    )
      return false;
    await query(
      `UPDATE kb_local_model
          SET "configError" = $2::jsonb, ${CLEAR_PENDING_SQL}, "updatedAt" = now()
        WHERE id = $1`,
      [
        QWEN_MODEL_ID,
        JSON.stringify({
          code: input.code,
          ...config,
          runtimeIdentity: builtinModelIdentity(builtinModel(row.pendingModelId ?? row.modelId)),
          at: new Date().toISOString(),
        }),
      ],
    );
    return true;
  });
}

/** The DB half of the worker's probe tick, bound to one owner. */
export function qwenConfigProbeStore(runtime: ModelRuntime & { prisma: LeaseDb }, owner: string) {
  return {
    read: async () => {
      await reconcileQwenRuntimeIdentity(runtime);
      return readQwenConfigProbe(runtime.prisma);
    },
    claim: (input: { probeEpoch: number; mode: "side-by-side" | "exclusive"; ttlMs?: number }) =>
      claimQwenConfigProbe(runtime.prisma, { ...input, owner }),
    renew: (input: { probeEpoch: number; ttlMs?: number }) =>
      renewQwenConfigProbe(runtime, { ...input, owner }),
    commit: (input: { probeEpoch: number; peakRssBytes: number | null }) =>
      commitQwenConfigProbe(runtime, { ...input, owner }),
    fail: (input: { probeEpoch: number; code: ModelConfigProbeErrorCode; interrupted?: boolean }) =>
      failQwenConfigProbe(runtime, { ...input, owner }),
  };
}

// ---- worker side -----------------------------------------------------------

type LeaseDb = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/** The native worker fence drains the old process and descendants before a
 * replacement starts. Within that process this permit spans all filesystem
 * work and child drain, including DB stalls. Lease expiry alone never transfers
 * it. One volume per worker; owners must release only after their work drains.
 * Supervisor reentrancy is counted/serialized in qwen-lifecycle, not here.
 */
export const MODEL_VOLUME_SQL_TIMEOUT_MS = 5_000;
let modelVolumeHold: {
  owner: string;
  connectionString: string;
  fence: number;
  closing: boolean;
  renewal: Promise<boolean> | null;
} | null = null;

/** Caller budgets are absolute, so pre/post inference reads cannot restart them. */
export type ModelRuntimeIo = { signal?: AbortSignal; deadlineAt?: number; timeoutMs?: number };

/**
 * Model runtime I/O never enters the shared Prisma pool. Each operation owns one
 * transaction and its connection through teardown. Cancellation uses a separate
 * bounded connection to terminate only this operation's backend, waiting for PG's
 * acknowledgement before closing the receive path. Startup transaction/idle
 * limits also fence effects if the transport is lost. No authority/KB locks are
 * acquired here; volume callers take their process permit before entering SQL.
 */
async function modelSqlQuery<T>(
  connectionString: string,
  run: (query: LockQuery) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = MODEL_VOLUME_SQL_TIMEOUT_MS,
  deadlineAt = Date.now() + timeoutMs,
): Promise<T> {
  signal?.throwIfAborted();
  assertNoSessionOptionOverride(connectionString);
  const duration = Math.ceil(Math.min(timeoutMs, deadlineAt - Date.now()));
  if (!Number.isSafeInteger(duration) || duration <= 0)
    throw new Error("Model SQL deadline exceeded");
  const deadline = Date.now() + duration;
  const applicationName = `kb-model-io-${randomUUID()}`;
  const client = new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: duration,
    statement_timeout: duration,
    query_timeout: duration + 2_500,
    options: `${PRISMA_SESSION_OPTIONS} -c transaction_timeout=${duration} -c idle_in_transaction_session_timeout=${duration}`,
  });
  client.on("error", () => {});
  let connected = false;
  let cancelled = false;
  let stopping: Promise<void> | undefined;
  const cancel = () => {
    cancelled = true;
    if (stopping) return;
    stopping = (async () => {
      if (!connected) {
        await client.end();
        return;
      }
      const control = new Client({
        connectionString,
        application_name: "kb-model-io-cancel",
        connectionTimeoutMillis: 1_000,
        statement_timeout: 1_000,
        query_timeout: 2_000,
        options: PRISMA_SESSION_OPTIONS,
      });
      control.on("error", () => {});
      try {
        await control.connect();
        const drained = await control.query<{ terminated: boolean }>(
          `SELECT pg_terminate_backend(pid, 500) AS terminated FROM pg_stat_activity
           WHERE application_name=$1 AND datname=current_database() AND usename=current_user`,
          [applicationName],
        );
        if (drained.rows.length === 0 || drained.rows.every((row) => row.terminated))
          await client.end();
      } finally {
        await control.end();
      }
    })().catch(() => {
      // Retain the original SQL/transaction until it settles under the server
      // deadline; a failed cancellation acknowledgement does not release it.
    });
  };
  const timer = setTimeout(cancel, duration);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const assertActive = () => {
    signal?.throwIfAborted();
    if (cancelled || Date.now() >= deadline) throw new Error("Model SQL deadline exceeded");
  };
  const query: LockQuery = async <R>(text: string, values: unknown[] = []) => {
    assertActive();
    const result = await client.query<R>({ text, values, queryMode: "extended" });
    assertActive();
    return result;
  };
  try {
    // pg does not settle connect() when end() closes an in-flight startup.
    // Join the actual connection end as well, so cancellation cannot strand
    // this operation after its owned socket has already drained.
    const closed = Promise.withResolvers<never>();
    const onEnd = () => closed.reject(new Error("Model SQL connection ended during startup"));
    client.on("end", onEnd);
    try {
      await Promise.race([client.connect(), closed.promise]);
    } finally {
      client.removeListener("end", onEnd);
    }
    connected = true;
    await query("BEGIN");
    const result = await run(query);
    await query("COMMIT");
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    await stopping;
    await client.end();
  }
}

/** Take the process permit before the DB row. Time is sampled by PostgreSQL. */
export async function acquireModelVolumeLease(
  runtime: { connectionString: string },
  input: { owner: string; now: Date; ttlMs?: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  if (modelVolumeHold) return false;
  const hold = {
    owner: input.owner,
    connectionString: runtime.connectionString,
    fence: 0,
    closing: false,
    renewal: null as Promise<boolean> | null,
  };
  modelVolumeHold = hold;
  try {
    const rows = await modelSqlQuery(
      runtime.connectionString,
      async (query) => {
        // Insert has no predecessor row to wait for. On conflict lock first, then
        // compare/extend using fresh database time rather than a pre-wait sample.
        await query(
          `INSERT INTO kb_model_volume_lease (id, owner, fence, "leaseUntil")
        VALUES ($1, $2, 0, '-infinity'::timestamptz) ON CONFLICT (id) DO NOTHING`,
          [MODEL_VOLUME_ID, input.owner],
        );
        await query("SELECT id FROM kb_model_volume_lease WHERE id=$1 FOR UPDATE", [
          MODEL_VOLUME_ID,
        ]);
        return (
          await query<{ fence: number }>(
            `UPDATE kb_model_volume_lease
        SET owner=$2, fence=fence+1, "leaseUntil"=clock_timestamp()+($3::double precision * interval '1 millisecond')
        WHERE id=$1 AND ("leaseUntil" < clock_timestamp() OR owner=$2) RETURNING fence`,
            [MODEL_VOLUME_ID, input.owner, input.ttlMs ?? MODEL_VOLUME_LEASE_MS],
          )
        ).rows;
      },
      input.signal,
      input.timeoutMs,
    );
    if (rows.length === 1) {
      hold.fence = rows[0]!.fence;
      return true;
    }
  } catch (error) {
    if (modelVolumeHold === hold) modelVolumeHold = null;
    throw error;
  }
  if (modelVolumeHold === hold) modelVolumeHold = null;
  return false;
}

export async function renewModelVolumeLease(
  _runtime: { connectionString: string },
  input: { owner: string; now: Date; ttlMs?: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean> {
  const hold = modelVolumeHold;
  if (hold?.owner !== input.owner || hold.closing) return false;
  // Also bound this shared boundary if more than one consumer requests renewal.
  if (hold.renewal) return hold.renewal;
  hold.renewal = modelSqlQuery(
    hold.connectionString,
    async (query) => {
      await query(
        "SELECT id FROM kb_model_volume_lease WHERE id=$1 AND owner=$2 AND fence=$3 FOR UPDATE",
        [MODEL_VOLUME_ID, hold.owner, hold.fence],
      );
      const updated = await query(
        `UPDATE kb_model_volume_lease
      SET "leaseUntil"=clock_timestamp()+($4::double precision * interval '1 millisecond')
      WHERE id=$1 AND owner=$2 AND fence=$3 AND "leaseUntil" >= clock_timestamp()`,
        [MODEL_VOLUME_ID, hold.owner, hold.fence, input.ttlMs ?? MODEL_VOLUME_LEASE_MS],
      );
      return updated.rowCount === 1;
    },
    input.signal,
    input.timeoutMs,
  ).finally(() => {
    hold.renewal = null;
  });
  return hold.renewal;
}

export async function releaseModelVolumeLease(
  _runtime: { connectionString: string },
  input: { owner: string; timeoutMs?: number },
): Promise<void> {
  const hold = modelVolumeHold;
  if (hold?.owner !== input.owner) return;
  hold.closing = true;
  try {
    await hold.renewal?.catch(() => {});
    await modelSqlQuery(
      hold.connectionString,
      async (query) => {
        await query(
          `UPDATE kb_model_volume_lease SET "leaseUntil" = '-infinity'::timestamptz
        WHERE id=$1 AND owner=$2 AND fence=$3`,
          [MODEL_VOLUME_ID, hold.owner, hold.fence],
        );
      },
      undefined,
      input.timeoutMs,
    );
  } finally {
    if (modelVolumeHold === hold) modelVolumeHold = null;
  }
}

export async function isModelEpochCurrent(prisma: LeaseDb, epoch: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM kb_local_model
     WHERE id = ${QWEN_MODEL_ID} AND epoch = ${epoch} AND state = 'DOWNLOADING'`;
  return rows.length === 1;
}

/**
 * The epoch and runtime config the model child may execute under, or null when
 * not READY. Read before dispatch and again before a result is returned: any
 * enable/disable (which bumps the epoch) or config change in between discards
 * the late result.
 */
export async function readReadyModelRuntime(
  runtime: { connectionString: string },
  io: ModelRuntimeIo = {},
): Promise<{ modelId: string; epoch: number; config: QwenRuntimeConfig } | null> {
  return modelSqlQuery(
    runtime.connectionString,
    async (query) => {
      const rows = await query<{
        modelId: string;
        runtimeIdentity: string;
        epoch: number;
        contextTokens: number;
        kvKeyType: string;
        kvValueType: string;
      }>(
        `SELECT "modelId", "runtimeIdentity", epoch, "contextTokens", "kvKeyType", "kvValueType" FROM kb_local_model
       WHERE id = $1 AND state = 'READY' AND "runtimeIdentity" IN ($2, $3)`,
        [QWEN_MODEL_ID, builtinModelIdentity(QWEN_MODEL), builtinModelIdentity(GEMMA_MODEL)],
      );
      const row = rows.rows[0];
      if (!row) return null;
      const config = qwenRuntimeConfigSchema.safeParse({
        contextTokens: row.contextTokens,
        kvKeyType: row.kvKeyType,
        kvValueType: row.kvValueType,
      });
      return config.success &&
        row.runtimeIdentity === builtinModelIdentity(builtinModel(row.modelId))
        ? { modelId: row.modelId, epoch: row.epoch, config: config.data }
        : null;
    },
    io.signal,
    io.timeoutMs,
    io.deadlineAt,
  );
}

/** The admin runtime config in any model state (the READY probe runs under it). */
export async function readModelRuntimeConfig(
  runtime: { connectionString: string },
  io: ModelRuntimeIo = {},
): Promise<QwenRuntimeConfig & { modelId: string }> {
  return modelSqlQuery(
    runtime.connectionString,
    async (query) => {
      const rows = await query<{
        modelId: string;
        contextTokens: number;
        kvKeyType: string;
        kvValueType: string;
      }>(
        `SELECT "modelId", "contextTokens", "kvKeyType", "kvValueType" FROM kb_local_model WHERE id = $1`,
        [QWEN_MODEL_ID],
      );
      return rows.rows[0]
        ? { ...storedQwenRuntimeConfig(rows.rows[0]), modelId: rows.rows[0].modelId }
        : { ...DEFAULT_QWEN_RUNTIME_CONFIG, contextTokens: 1024, modelId: GEMMA_MODEL.modelId };
    },
    io.signal,
    io.timeoutMs,
    io.deadlineAt,
  );
}

/** Worker startup/periodic report of the memory it may use. */
export async function recordWorkerMemoryBudget(
  runtime: { connectionString: string },
  budget: { budgetBytes: number; availableBytes: number; source: (typeof budgetSources)[number] },
  io: ModelRuntimeIo = {},
): Promise<void> {
  await modelSqlQuery(
    runtime.connectionString,
    async (query) => {
      await query(
        `INSERT INTO kb_local_model (id, "modelId", "updatedAt", "memoryBudgetBytes", "memoryAvailableBytes",
                                  "memoryBudgetSource", "memoryReportedAt")
       VALUES ($1, $2, now(), $3, $4, $5, now())
       ON CONFLICT (id) DO UPDATE
         SET "memoryBudgetBytes" = EXCLUDED."memoryBudgetBytes",
             "memoryAvailableBytes" = EXCLUDED."memoryAvailableBytes",
             "memoryBudgetSource" = EXCLUDED."memoryBudgetSource",
             "memoryReportedAt" = EXCLUDED."memoryReportedAt"`,
        [
          QWEN_MODEL_ID,
          GEMMA_MODEL.modelId,
          BigInt(budget.budgetBytes),
          BigInt(budget.availableBytes),
          budget.source,
        ],
      );
    },
    io.signal,
    io.timeoutMs,
    io.deadlineAt,
  );
}

/** Child peak reports share the same bounded I/O and shutdown owner as budgets. */
export async function recordModelPeakRss(
  runtime: { connectionString: string },
  input: { bytes: number; epoch: number; config: QwenRuntimeConfig },
  io: ModelRuntimeIo = {},
): Promise<void> {
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) return;
  await modelSqlQuery(
    runtime.connectionString,
    async (query) => {
      await query(
        `UPDATE kb_local_model
         SET "peakRssBytes" = GREATEST(COALESCE("peakRssBytes", 0), $1::bigint)
       WHERE id = $2 AND state = 'READY' AND epoch = $3
         AND "contextTokens" = $4 AND "kvKeyType" = $5 AND "kvValueType" = $6`,
        [
          BigInt(input.bytes),
          QWEN_MODEL_ID,
          input.epoch,
          input.config.contextTokens,
          input.config.kvKeyType,
          input.config.kvValueType,
        ],
      );
    },
    io.signal,
    io.timeoutMs,
    io.deadlineAt,
  );
}

/** Bounded progress CAS; false means the epoch is no longer the live download. */
export async function recordModelProgress(
  prisma: LeaseDb,
  input: { epoch: number; bytes: number },
): Promise<boolean> {
  const bytes = BigInt(Math.max(0, Math.min(input.bytes, QWEN_ARTIFACT.sizeBytes)));
  const updated = await prisma.$executeRaw`
    UPDATE kb_local_model SET "bytesDownloaded" = ${bytes}, "updatedAt" = now()
     WHERE id = ${QWEN_MODEL_ID} AND epoch = ${input.epoch} AND state = 'DOWNLOADING'`;
  return updated === 1;
}

/**
 * Reserve the artifact's bytes on the model volume before any network I/O.
 * Reuses an existing reservation across retries of the same epoch. Returns
 * false when the epoch is stale (nothing reserved).
 */
export async function reserveModelDisk(
  runtime: ModelRuntime,
  input: { epoch: number; dir: string; meter: DiskMeter; expected: ArtifactIdentity },
): Promise<boolean> {
  try {
    return await inAuthorityTransaction(runtime, async (query) => {
      const row = await lockModelRow(query);
      if (row.epoch !== input.epoch || row.state !== "DOWNLOADING") return false;
      if (row.quotaReservationIds.length > 0) return true;
      const lease = await reserveQuota(
        { transactionQuery: query },
        {
          opId: `model-download:${QWEN_MODEL_ID}:${input.epoch}`,
          charges: [],
          disks: [{ path: input.dir, bytes: BigInt(input.expected.sizeBytes), meter: input.meter }],
          expiresAt: new Date(Date.now() + DISK_RESERVATION_MS),
        },
      );
      await query(
        `UPDATE kb_local_model SET "quotaReservationIds" = $2::text[], "updatedAt" = now()
          WHERE id = $1`,
        [QWEN_MODEL_ID, lease.reservationIds],
      );
      return true;
    });
  } catch (error) {
    if (error instanceof KbAdmissionError && error.code === "QUOTA_EXCEEDED")
      throw new ModelArtifactError("MODEL_DISK_QUOTA");
    throw new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
  }
}

/**
 * Authority transaction. Idempotently creates the system SYSTEM_BUILTIN provider
 * and returns the revision whose fingerprint is the Qwen fingerprint of the
 * given runtime config (model identity + build parameters). Revisions are
 * append-only and keyed by fingerprint: switching back to an earlier config
 * reuses its revision. A revision for another config or an older model identity
 * stays usable for QUERIES while its identity matches and never for
 * builds (generations.ts usableIndexProfile).
 */
export async function ensureSystemBuiltinProvider(
  query: LockQuery,
  jobId: string,
  config: QwenRuntimeConfig,
  modelId: string,
): Promise<number> {
  const model = builtinModel(modelId);
  await query(
    `INSERT INTO embedding_provider (id, "ownerId", name, kind, "createdAt")
     VALUES ($1, NULL, $2, 'SYSTEM_BUILTIN', now()) ON CONFLICT (id) DO NOTHING`,
    [SYSTEM_BUILTIN_PROVIDER_ID, SYSTEM_BUILTIN_PROVIDER_NAME],
  );
  const fingerprint = builtinEmbeddingFingerprint(model, config);
  const existing = (
    await query<{ version: number }>(
      `SELECT version FROM provider_revision
        WHERE "providerId" = $1 AND fingerprint = $2 ORDER BY version DESC LIMIT 1`,
      [SYSTEM_BUILTIN_PROVIDER_ID, fingerprint],
    )
  ).rows[0];
  if (existing) return existing.version;
  const latest = (
    await query<{ version: number }>(
      `SELECT max(version)::int AS version FROM provider_revision WHERE "providerId" = $1`,
      [SYSTEM_BUILTIN_PROVIDER_ID],
    )
  ).rows[0];
  const version = (latest?.version ?? 0) + 1;
  await query(
    `INSERT INTO provider_revision ("providerId",version,"endpointUrl",model,dimensions,ciphertext,"aadVersion","keyVersion","ownerSnapshot",fingerprint,"idempotencyKey","requestHash","jobId","modelIdentity")
     VALUES ($1,$2,$3,$4,$5,NULL,1,1,'system',$6,$7,$6,$8,$9)`,
    [
      SYSTEM_BUILTIN_PROVIDER_ID,
      version,
      `builtin:${model.modelId}`,
      model.modelId,
      model.dimensions,
      fingerprint,
      `system-qwen-${version}`,
      jobId,
      builtinModelIdentity(model),
    ],
  );
  return version;
}

/**
 * Settle the live epoch: READY commits the disk reservation, FAILED releases
 * it. Returns false (and changes nothing) for a stale epoch — a late download
 * can never become READY.
 */
type ModelDownloadOutcome =
  | {
      state: "READY";
      bytes?: number;
      /** Probe evidence; stored only if the probe ran under the row's current config. */
      peakRssBytes?: number | null;
      probedConfig?: QwenRuntimeConfig;
    }
  | { state: "FAILED"; code: ModelErrorCode };

export async function finishModelDownload(
  runtime: ModelRuntime,
  input: { epoch: number; outcome: ModelDownloadOutcome },
): Promise<boolean> {
  return inAuthorityTransaction(runtime, async (query) => {
    const row = await lockModelRow(query);
    if (row.epoch !== input.epoch || row.state !== "DOWNLOADING") return false;
    await finishModelDownloadOnQuery(query, row, input.outcome);
    return true;
  });
}

/** Model state, reservation, audit/provider effects and the acquired job tuple
 * commit together. An interrupted transaction leaves RUNNING recoverable by
 * the dispatcher; an expired/reclaimed tuple cannot settle a successor.
 * Lock order: authority -> model row -> job row -> quota/provider/KB effects.
 */
export async function settleModelDownloadAttempt(
  runtime: ModelRuntime,
  input: {
    epoch: number;
    jobId: string;
    workerId: string;
    attemptEpoch: number;
    outcome: ModelDownloadOutcome;
    retryable?: boolean;
  },
): Promise<"READY" | "FAILED" | "RETRY" | "SUPERSEDED"> {
  return inAuthorityTransaction(runtime, async (query) => {
    const row = await lockModelRow(query);
    const current = row.epoch === input.epoch && row.jobId === input.jobId;
    const state = await settleJobAttemptOnQuery(query, {
      ...input,
      now: new Date(),
      outcome:
        !current || input.outcome.state === "READY"
          ? { state: "COMPLETE" }
          : { state: "FAILED", error: input.outcome.code, retryable: input.retryable ?? false },
    });
    if (!current) return "SUPERSEDED";
    if (state === "RETRY") return "RETRY";
    // A replay after older code settled READY still completes its delivery.
    if (row.state === "DOWNLOADING") await finishModelDownloadOnQuery(query, row, input.outcome);
    return input.outcome.state;
  });
}

async function finishModelDownloadOnQuery(
  query: LockQuery,
  row: LockedRow,
  outcome: ModelDownloadOutcome,
): Promise<void> {
  const model = builtinModel(row.modelId);
  const ids = row.quotaReservationIds;
  await auditModel(
    query,
    "model_download",
    `model-download:${row.epoch}`,
    "system:worker",
    outcome.state === "READY" ? "SUCCESS" : "FAILURE",
    outcome.state,
  );
  if (outcome.state === "READY") {
    if (ids.length > 0) {
      try {
        await commitQuota({ transactionQuery: query }, ids);
      } catch {
        // Expired reservation: the file is already counted by statfs.
        await releaseQuota({ transactionQuery: query }, ids);
      }
    }
    const { peakRssBytes: peak, probedConfig } = outcome;
    const probedCurrent =
      probedConfig !== undefined &&
      sameQwenRuntimeConfig(probedConfig, storedQwenRuntimeConfig(row));
    await query(
      `UPDATE kb_local_model
        SET state = 'READY', "bytesDownloaded" = $2, "errorCode" = NULL,
            "quotaReservationIds" = '{}', "readyAt" = now(), "updatedAt" = now(),
            "peakRssBytes" = $3, "runtimeIdentity" = $4
      WHERE id = $1`,
      [
        QWEN_MODEL_ID,
        outcome.bytes ?? model.sizeBytes,
        probedCurrent && typeof peak === "number" && Number.isSafeInteger(peak) && peak > 0
          ? peak
          : null,
        probedCurrent ? builtinModelIdentity(model) : null,
      ],
    );
    if (row.jobId && probedCurrent) {
      // The probe ran under this config; KBs on any other SYSTEM_BUILTIN revision
      // (config changed while not READY, or a new model identity) re-embed.
      const config = storedQwenRuntimeConfig(row);
      const version = await ensureSystemBuiltinProvider(query, row.jobId, config, model.modelId);
      await retargetSystemBuiltinKbs(query, {
        version,
        fingerprint: builtinEmbeddingFingerprint(model, config),
        configEpoch: row.configEpoch,
      });
    }
    if (!probedCurrent)
      await queueRuntimeUpgrade(query, { ...row, state: "READY", runtimeIdentity: null });
  } else {
    await releaseReservations(query, ids);
    await query(
      `UPDATE kb_local_model
        SET state = 'FAILED', "errorCode" = $2, "quotaReservationIds" = '{}', "updatedAt" = now()
      WHERE id = $1`,
      [QWEN_MODEL_ID, fixedCode(outcome.code)],
    );
  }
}

/** Worker owns the volume hold before calling. Authority -> model row -> quota.
 * Durable pending selection precedes downloading; stale requests reserve nothing.
 */
export async function reservePendingModelDisk(
  runtime: ModelRuntime,
  input: {
    modelId: string;
    epoch: number;
    config: QwenRuntimeConfig;
    dir: string;
    meter: DiskMeter;
  },
): Promise<string[]> {
  return inAuthorityTransaction(runtime, async (query) => {
    const row = await lockModelRow(query);
    const pending = pendingQwenRuntimeConfig(row);
    if (
      row.state !== "READY" ||
      row.epoch !== input.epoch ||
      !row.probeLive ||
      (row.pendingModelId ?? row.modelId) !== input.modelId ||
      !pending ||
      !sameQwenRuntimeConfig(pending, input.config)
    )
      throw new ModelArtifactError("MODEL_CANCELLED");
    const reservation = await reserveQuota(
      { transactionQuery: query },
      {
        opId: `model-probe-download:${row.epoch}:${row.probeEpoch}`,
        charges: [],
        disks: [
          {
            path: input.dir,
            bytes: BigInt(builtinModel(input.modelId).sizeBytes),
            meter: input.meter,
          },
        ],
        expiresAt: new Date(Date.now() + DISK_RESERVATION_MS),
      },
    );
    return reservation.reservationIds;
  });
}

export async function settlePendingModelDisk(runtime: ModelRuntime, ids: string[]): Promise<void> {
  // The verified file is already counted by statfs. Release the temporary reservation.
  await inAuthorityTransaction(runtime, (query) => releaseReservations(query, ids));
}

/** Exactly the two registry filenames and their epoch partials/intents, never recursive cleanup. Worker holds the volume
 * lease; runtime loops serialize cleanup with preparation within that owner.
 * Authority serialization prevents attach/retarget during check + unlink.
 * Disabled/current and pending selections are retained. Any generation reference,
 * including failed/leased/old generations, retains its model until generation GC.
 * PURGED rows are cursor tombstones and no longer require weights.
 */
export async function cleanupUnusedBuiltinModelFiles(
  runtime: ModelRuntime,
  dir: string,
): Promise<void> {
  await inAuthorityTransaction(runtime, async (query) => {
    const row = await lockModelRow(query);
    // "Remove": an admin asked to delete the weights of this disabled model epoch; the
    // selection and every generation reference no longer retain them.
    const state = effectiveState(row);
    const removing =
      (state === "DISABLED" || state === "FAILED") && row.removeRequestedEpoch === row.epoch;
    const names = await readdir(dir);
    for (const model of Object.values(BUILTIN_MODELS)) {
      await recoverArtifactPublication(dir, model);
      const prefix = `.${model.fileName}.e`;
      for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith(".partial")) continue;
        const epochText = name.slice(prefix.length, -".partial".length);
        if (!/^[1-9]\d*$/.test(epochText)) continue;
        const epoch = Number(epochText);
        if (!Number.isSafeInteger(epoch)) continue;
        const downloading =
          row.state === "DOWNLOADING" &&
          ["PENDING", "PUBLISHED", "RUNNING", "RETRY"].includes(row.jobState ?? "") &&
          row.modelId === model.modelId &&
          row.epoch === epoch;
        const candidate =
          (row.pendingModelId ?? row.modelId) === model.modelId &&
          row.pendingContextTokens !== null &&
          row.epoch === epoch;
        if (downloading || candidate) continue;
        const partial = join(dir, name);
        const info = await lstat(partial).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (info?.isFile()) await unlink(partial);
      }
      if (removing) {
        await unlinkModelFile(join(dir, model.fileName));
        continue;
      }
      if (model.modelId === row.modelId || model.modelId === row.pendingModelId) continue;
      const referenced = await query<{ retained: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM index_generation g JOIN provider_revision r
          ON r."providerId" = g."providerId" AND r.version = g."providerVersion"
          WHERE r.model = $1 AND (g.state <> 'PURGED' OR EXISTS (
            SELECT 1 FROM generation_lease l WHERE l."generationId" = g.id
              AND l."expiresAt" > clock_timestamp()))) AS retained`,
        [model.modelId],
      );
      if (referenced.rows[0]?.retained !== false) continue;
      await unlinkModelFile(join(dir, model.fileName));
    }
    if (removing)
      await query(
        `UPDATE kb_local_model SET "removeRequestedEpoch" = NULL, "updatedAt" = now()
          WHERE id = $1 AND epoch = $2`,
        [QWEN_MODEL_ID, row.epoch],
      );
  });
}

/** Unlinks a regular file (never a directory or symlink target); a missing file is done. */
async function unlinkModelFile(file: string): Promise<void> {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isFile()) await unlink(file);
}
