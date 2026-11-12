import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { builtinModel } from "@knowledge-base/api/lib/kb/builtin-model";
import type { DnsLookupFn } from "@knowledge-base/api/lib/kb/egress";
import {
  claimJobAttempt,
  completeJobAttempt,
  DurableJobCancelledError,
  DurableJobFenceError,
  failJobAttempt,
  heartbeatJobAttempt,
  WORKER_HEARTBEAT_MS,
} from "@knowledge-base/api/lib/kb/jobs";
import {
  acquireModelVolumeLease,
  isModelEpochCurrent,
  type ModelErrorCode,
  modelDownloadDesiredSchema,
  recordModelProgress,
  releaseModelVolumeLease,
  renewModelVolumeLease,
  reserveModelDisk,
  reservePendingModelDisk,
  settleModelDownloadAttempt,
  settlePendingModelDisk,
} from "@knowledge-base/api/lib/kb/local-model";
import {
  type ArtifactIdentity,
  downloadModelArtifact,
  ModelArtifactError,
  type ModelTransport,
} from "@knowledge-base/api/lib/kb/model-artifact";
import { type DiskMeter, statfsDiskMeter } from "@knowledge-base/api/lib/kb/quota";
import {
  type QwenRuntimeConfig,
  qwenRuntimeConfigSchema,
} from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import prisma from "@knowledge-base/db";
import type { PrismaClient } from "@knowledge-base/db/client";
import { env } from "@knowledge-base/env/shared";
import { kbDataPaths } from "@knowledge-base/env/topology";
import { type DownloadModelJobData, downloadModelJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";

const processWorkerId = `model:${randomUUID()}`;

/** The runtime probe's peak RSS and the config it ran under (qwen-probe.ts), if reported. */
function probeEvidence(
  value: unknown,
): { peakRssBytes: number | null; config: QwenRuntimeConfig } | null {
  if (typeof value !== "object" || value === null) return null;
  const { peakRssBytes, config } = value as { peakRssBytes?: unknown; config?: unknown };
  const parsed = qwenRuntimeConfigSchema.safeParse(config);
  if (!parsed.success) return null;
  return {
    peakRssBytes:
      typeof peakRssBytes === "number" && Number.isSafeInteger(peakRssBytes) && peakRssBytes > 0
        ? peakRssBytes
        : null,
    config: parsed.data,
  };
}
const PROGRESS_INTERVAL_MS = 1_000;

export type ModelDownloadResult = {
  state: "READY" | "FAILED" | "RETRY" | "SUPERSEDED" | "SKIPPED";
  code?: ModelErrorCode;
};

/** Fence errors mean the attempt already lost ownership; nothing else to settle. */
async function settle(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof DurableJobCancelledError || error instanceof DurableJobFenceError) return;
    throw error;
  }
}

/**
 * One fenced attempt of the admin-enabled download. Ownership order: durable
 * job fence → drained process permit + model volume lease → disk reservation (under the live epoch) →
 * network. The READY transition is an epoch CAS, so a superseded attempt can
 * finish its bytes but never activate them; link(2) never replaces a verified
 * file.
 */
export async function runModelDownload(
  db: PrismaClient,
  options: {
    durableJobId: string;
    workerId: string;
    connectionString: string;
    modelsDir: string;
    expected?: ArtifactIdentity;
    transport?: ModelTransport;
    lookup?: DnsLookupFn;
    meter?: DiskMeter;
    monitorMs?: number;
    signal?: AbortSignal;
    /**
     * Required runtime capability check on the verified file (qwen-probe.ts):
     * READY is never written unless it resolves. A rejection is a
     * non-retryable MODEL_RUNTIME_UNSUPPORTED (or its own artifact code).
     */
    verifyRuntime: (modelPath: string, modelId: string, signal: AbortSignal) => Promise<unknown>;
  },
): Promise<ModelDownloadResult> {
  let probe: { peakRssBytes: number | null; config: QwenRuntimeConfig } | null = null;
  const job = await claimJobAttempt(db, {
    jobId: options.durableJobId,
    workerId: options.workerId,
    now: new Date(),
  });
  if (!job) return { state: "SKIPPED" };
  const fence = { jobId: job.id, workerId: options.workerId, attemptEpoch: job.attemptEpoch };
  const desired = modelDownloadDesiredSchema.safeParse(job.desired);
  if (job.kind !== "DOWNLOAD_MODEL" || !desired.success) {
    await settle(() =>
      failJobAttempt(db, { ...fence, now: new Date(), error: "Invalid model download job" }),
    );
    return { state: "FAILED", code: "MODEL_DOWNLOAD_FAILED" };
  }
  const { epoch } = desired.data;
  const runtime = { prisma: db, connectionString: options.connectionString };
  const expected = options.expected ?? builtinModel(desired.data.modelId);

  if (!(await isModelEpochCurrent(db, epoch))) {
    await settle(() => completeJobAttempt(db, { ...fence, now: new Date() }));
    return { state: "SUPERSEDED" };
  }

  const settleOutcome = async (
    outcome: Parameters<typeof settleModelDownloadAttempt>[1]["outcome"],
    retryable = false,
  ) => {
    try {
      return await settleModelDownloadAttempt(runtime, { ...fence, epoch, outcome, retryable });
    } catch (error) {
      if (error instanceof DurableJobCancelledError || error instanceof DurableJobFenceError)
        return "SUPERSEDED" as const;
      throw error;
    }
  };
  const owner = options.workerId;
  if (!(await acquireModelVolumeLease(runtime, { owner, now: new Date() }))) {
    const state = await settleOutcome({ state: "FAILED", code: "MODEL_VOLUME_BUSY" }, true);
    return { state, code: "MODEL_VOLUME_BUSY" };
  }

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  options.signal?.addEventListener("abort", shutdown, { once: true });
  if (options.signal?.aborted) shutdown();
  let superseded = false;
  const supersede = () => {
    superseded = true;
    controller.abort();
  };
  let monitoring = true;
  let chain = Promise.resolve();
  let monitorPending = false;
  const timer = setInterval(() => {
    if (monitorPending) return;
    monitorPending = true;
    chain = Promise.resolve()
      .then(async () => {
        if (!monitoring) return;
        const now = new Date();
        const live = await heartbeatJobAttempt(db, { ...fence, now });
        const current = await isModelEpochCurrent(db, epoch);
        if (!live || !current) return supersede();
        if (!(await renewModelVolumeLease(runtime, { owner, now, signal: controller.signal })))
          controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => {
        monitorPending = false;
      });
  }, options.monitorMs ?? WORKER_HEARTBEAT_MS);

  let lastProgressAt = 0;
  try {
    try {
      await downloadModelArtifact({
        dir: options.modelsDir,
        epoch,
        expected,
        signal: controller.signal,
        onProgress: async (bytes) => {
          const now = Date.now();
          if (bytes < expected.sizeBytes && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
          lastProgressAt = now;
          if (!(await recordModelProgress(db, { epoch, bytes }))) supersede();
        },
        beforeTransfer: async () => {
          const reserved = await reserveModelDisk(runtime, {
            epoch,
            dir: options.modelsDir,
            meter: options.meter ?? statfsDiskMeter(options.modelsDir),
            expected,
          });
          if (!reserved) {
            supersede();
            throw new ModelArtifactError("MODEL_CANCELLED");
          }
        },
        beforePublish: async () => {
          const current = await isModelEpochCurrent(db, epoch);
          if (!current) supersede();
          return current;
        },
        deps: { transport: options.transport, lookup: options.lookup },
      });
      // Verified bytes are not yet an executable model: the real child must load
      // and embed them first. Heartbeats continue while the probe runs.
      if (!(await isModelEpochCurrent(db, epoch))) supersede();
      if (superseded) throw new ModelArtifactError("MODEL_CANCELLED");
      try {
        probe = probeEvidence(
          await options.verifyRuntime(
            join(options.modelsDir, expected.fileName),
            desired.data.modelId,
            controller.signal,
          ),
        );
        if (controller.signal.aborted) throw new ModelArtifactError("MODEL_CANCELLED");
      } catch (error) {
        throw error instanceof ModelArtifactError
          ? error
          : new ModelArtifactError("MODEL_RUNTIME_UNSUPPORTED");
      }
    } finally {
      monitoring = false;
      clearInterval(timer);
      await chain;
    }
    const state = await settleOutcome({
      state: "READY",
      bytes: expected.sizeBytes,
      ...(probe ? { peakRssBytes: probe.peakRssBytes, probedConfig: probe.config } : {}),
    });
    return { state };
  } catch (caught) {
    const error =
      caught instanceof ModelArtifactError
        ? caught
        : new ModelArtifactError("MODEL_DOWNLOAD_FAILED", true);
    if (superseded || !(await isModelEpochCurrent(db, epoch))) {
      await settle(() => completeJobAttempt(db, { ...fence, now: new Date() }));
      return { state: "SUPERSEDED" };
    }
    const code: ModelErrorCode =
      error.code === "MODEL_CANCELLED" ? "MODEL_DOWNLOAD_FAILED" : error.code;
    // Shutdown or a lost volume lease consumes the bounded retry budget. A
    // terminal failure releases quota in the very same fenced job transaction.
    const state = await settleOutcome(
      { state: "FAILED", code },
      error.retryable || error.code === "MODEL_CANCELLED",
    );
    return { state, code };
  } finally {
    monitoring = false;
    clearInterval(timer);
    options.signal?.removeEventListener("abort", shutdown);
    await releaseModelVolumeLease(runtime, { owner });
  }
}

export function handleDownloadModelJob(
  job: Job<DownloadModelJobData>,
  signal: AbortSignal | undefined,
  verifyRuntime: (modelPath: string, modelId: string, signal: AbortSignal) => Promise<unknown>,
) {
  return runModelDownload(prisma, {
    ...downloadModelJobSchema.parse(job.data),
    workerId: `${processWorkerId}:${randomUUID()}`,
    connectionString: env.DATABASE_URL.reveal(),
    modelsDir: kbDataPaths(env.KB_DATA_ROOT).modelsDir,
    signal,
    verifyRuntime,
  });
}

/** Caller holds the supervisor volume lease; the ordinary pinned downloader is reused.
 * A failed/cancelled candidate never changes the active selection or revision.
 */
export async function prepareBuiltinConfigArtifact(input: {
  runtime: { prisma: PrismaClient; connectionString: string };
  modelsDir: string;
  modelId: string;
  epoch: number;
  config: QwenRuntimeConfig;
  signal: AbortSignal;
  deps?: { transport?: ModelTransport; lookup?: DnsLookupFn };
}) {
  let ids: string[] = [];
  try {
    await downloadModelArtifact({
      dir: input.modelsDir,
      epoch: input.epoch,
      expected: builtinModel(input.modelId),
      signal: input.signal,
      onProgress: async () => {},
      deps: input.deps,
      beforeTransfer: async () => {
        ids = await reservePendingModelDisk(input.runtime, {
          ...input,
          dir: input.modelsDir,
          meter: statfsDiskMeter(input.modelsDir),
        });
      },
      beforePublish: async () => !input.signal.aborted,
    });
  } finally {
    if (ids.length) await settlePendingModelDisk(input.runtime, ids);
  }
}
