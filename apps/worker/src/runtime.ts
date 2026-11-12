import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssetStorageLifecycle,
  createAssetStorageLifecycle,
} from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import {
  admitAssetStorage,
  assetStorageSelection,
} from "@knowledge-base/api/lib/kb/asset-storage-mode";
import {
  assetRoleFenceProof,
  attachRuntimeAssetCache,
} from "@knowledge-base/api/lib/kb/asset-storage-runtime";
import {
  type DispatchWakeListener,
  listenForDispatchWake,
} from "@knowledge-base/api/lib/kb/dispatch";
import { assertSupportedGit, parseGitVersion } from "@knowledge-base/api/lib/kb/git-version";
import { DISPATCH_INTERVAL_MS, queueNameForDurableKind } from "@knowledge-base/api/lib/kb/jobs";
import { KB_LIMITS } from "@knowledge-base/api/lib/kb/limits";
import {
  acquireModelVolumeLease,
  cleanupUnusedBuiltinModelFiles,
  qwenConfigProbeStore,
  readReadyModelRuntime,
  recordModelPeakRss,
  recordWorkerMemoryBudget,
  releaseModelVolumeLease,
  renewModelVolumeLease,
} from "@knowledge-base/api/lib/kb/local-model";
import { startMaintenanceParticipant } from "@knowledge-base/api/lib/kb/maintenance";
import { QWEN_ARTIFACT } from "@knowledge-base/api/lib/kb/model-artifact";
import { GENERATION_LEASE_MS } from "@knowledge-base/api/lib/kb/query-embedding";
import {
  advanceQwenReembed,
  hasQwenReembedWork,
  QWEN_REEMBED_TICK_MS,
} from "@knowledge-base/api/lib/kb/qwen-reembed";
import prisma, { type Prisma } from "@knowledge-base/db";
import {
  errorClassOf,
  errorCodeOf,
  logEvent,
  logInternalError,
  type StartupStage,
} from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/shared";
import { assertLocalKbDataRoot, kbDataPaths } from "@knowledge-base/env/topology";
import type {
  CheckBackupFreshnessJobData,
  DownloadModelJobData,
  DurableProbeJobData,
  EchoJobData,
  IndexKbJobData,
  KbEmailJobData,
  KbGitRollupJobData,
  KbRetentionJobData,
  NotifyDataDeletionsJobData,
  ProviderProbeJobData,
  PushMirrorJobData,
  QueryEmbeddingJobData,
  ReapExpiredAuthTokensJobData,
  SeedJobData,
} from "@knowledge-base/queue";
import {
  checkBackupFreshnessQueue,
  createRedisConnection,
  downloadModelQueue,
  durableProbeQueue,
  indexKbQueue,
  KB_GIT_ROLLUP_CRON_PATTERN,
  KB_GIT_ROLLUP_SCHEDULER_ID,
  KB_RETENTION_HOURLY_CRON_PATTERN,
  KB_RETENTION_HOURLY_JOB_SCHEDULER_ID,
  KB_RETENTION_MINUTE_CRON_PATTERN,
  KB_RETENTION_MINUTE_JOB_SCHEDULER_ID,
  kbEmailQueue,
  kbGitRollupQueue,
  kbRetentionQueue,
  NOTIFY_DATA_DELETIONS_CRON_PATTERN,
  NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
  notifyDataDeletionsQueue,
  providerProbeQueue,
  pushMirrorQueue,
  QUEUE_NAMES,
  queryEmbeddingQueue,
  REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN,
  REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
  reapExpiredAuthTokensQueue,
} from "@knowledge-base/queue";
import { createConsumerHeartbeat } from "@knowledge-base/queue/consumer-health";
import { type Processor, Worker, type WorkerOptions } from "bullmq";
import { syncBackupFreshnessScheduler } from "./backup-freshness-scheduler.js";
import { startDurableDispatcherLoop } from "./durable-dispatcher.js";
import { handleCheckBackupFreshnessJob } from "./handlers/check-backup-freshness.js";
import { handleDownloadModelJob, prepareBuiltinConfigArtifact } from "./handlers/download-model.js";
import { handleDurableProbeJob } from "./handlers/durable-probe.js";
import { handleEchoJob } from "./handlers/echo.js";
import { handleIndexKbJob } from "./handlers/index-kb.js";
import { handleKbEmailJob } from "./handlers/kb-email.js";
import { handleKbGitRollupJob } from "./handlers/kb-git-rollup.js";
import { handleKbRetentionJob } from "./handlers/kb-retention.js";
import { handleNotifyDataDeletionsJob } from "./handlers/notify-data-deletions.js";
import { handleProviderProbeJob } from "./handlers/provider-probe.js";
import { handlePushMirrorJob, recoverMirrorReservations } from "./handlers/push-mirror.js";
import { handleQueryEmbeddingJob } from "./handlers/query-embedding.js";
import { handleReapExpiredAuthTokensJob } from "./handlers/reap-expired-auth-tokens.js";
import { handleSeedJob } from "./handlers/seed.js";
import { detectMemoryBudget } from "./lib/memory-budget.js";
import { assertMirrorStorage, MIRROR_TMPFS } from "./lib/mirror-ssh.js";
import { QWEN_CONFIG_PROBE_TICK_MS, runQwenConfigProbeTick } from "./lib/qwen-config-probe.js";
import {
  createQwenEmbedder,
  createQwenSupervisor,
  watchQwenModelRuntime,
} from "./lib/qwen-lifecycle.js";
import { verifyQwenRuntime } from "./lib/qwen-probe.js";
import { createQwenPeakReporter, startQwenRuntimeLoops } from "./lib/qwen-runtime-loops.js";
import {
  closeOperationalAlertConnection,
  sendOperationalFailureAlert,
} from "./operational-alerts.js";
import { waitUntilReady, withTimeout, workerDrainMs } from "./runtime-lifecycle.js";

// One lifecycle per process.
// The host owns signals, fatal exit, and the shared Prisma/producer connections.
let claimed = false;

/** An alert names the failure by class and stable code only, never its message (R3-W3). */
function failureSummary(error: unknown): string {
  const code = errorCodeOf(error);
  return `${errorClassOf(error)}${code === undefined ? "" : ` (${code})`}; see the worker log for its job record`;
}
export type WorkerRuntime = {
  assetStorage: AssetStorageLifecycle;
  isReady(): boolean;
  stop(): Promise<void>;
};
export class WorkerDrainError extends Error {}

export async function startWorkerRuntime(options: {
  onFatal(error: unknown): void;
  onStartupStage?(stage: StartupStage): void;
  onMaintenance?: () => void;
  onMaintenanceAdmitted?: () => void;
  signal?: AbortSignal;
}): Promise<WorkerRuntime> {
  if (claimed) throw new Error("Worker runtime already started; restart the process to re-enter.");
  claimed = true;
  const workerStartedAt = new Date();
  const assetStorage = createAssetStorageLifecycle("WORKER", options.signal);
  const { modelsDir } = kbDataPaths(env.KB_DATA_ROOT);
  let maintenance: Awaited<ReturnType<typeof startMaintenanceParticipant>> | undefined;
  try {
    // The worker reads the same repositories with the same git: same floor as the server.
    options.onStartupStage?.("git");
    logEvent("worker.git", {
      gitVersion: parseGitVersion(await assertSupportedGit({ signal: options.signal }))?.join("."),
    });
    options.onStartupStage?.("data-root");
    // The maintenance participant is the first Postgres connection: a database
    // that is still booting gets the readiness retries first.
    options.onStartupStage?.("postgres");
    await waitUntilReady(
      () => prisma.$queryRaw`SELECT 1`,
      "Postgres startup ping timed out",
      () => {
        if (options.signal?.aborted) throw new Error("Worker startup cancelled.");
      },
    );
    options.onStartupStage?.("maintenance");
    maintenance = await startMaintenanceParticipant(
      env.DATABASE_URL.reveal(),
      () => {
        if (options.onMaintenance) options.onMaintenance();
        else options.onFatal(new Error("Maintenance requested; stopping worker."));
      },
      undefined,
      () => assetStorage.stop(),
      async (query) => {
        const marker = await admitAssetStorage({
          query,
          selection: assetStorageSelection(env),
          assetsDir: kbDataPaths(env.KB_DATA_ROOT).assetsDir,
          role: "WORKER",
          signal: options.signal,
          assertServerFence: () => {
            throw new Error("Worker cannot initialize storage authority.");
          },
        });
        if (env.KB_ASSET_S3_ENABLED)
          await attachRuntimeAssetCache({
            env,
            assetsDir: kbDataPaths(env.KB_DATA_ROOT).assetsDir,
            connectionString: env.DATABASE_URL.reveal(),
            marker,
            lifecycle: assetStorage,
            assertRoleFence: assetRoleFenceProof(kbDataPaths(env.KB_DATA_ROOT).reposDir, "worker"),
          });
      },
    );
    if (options.signal?.aborted) throw new Error("Worker startup cancelled.");
    options.onMaintenanceAdmitted?.();
  } catch (error) {
    try {
      await assetStorage.stop();
      await maintenance?.release();
    } catch (cause) {
      throw new WorkerDrainError("Asset storage did not drain during worker startup.", { cause });
    }
    throw error;
  }
  const admittedMaintenance = maintenance;
  options.onStartupStage?.("redis");
  const connection = createRedisConnection();
  const heartbeatConnection = createRedisConnection({
    maxRetriesPerRequest: 1,
    commandTimeout: 3000,
  });
  const workers: Array<
    Pick<Worker, "name" | "close" | "run" | "isRunning" | "isPaused" | "waitUntilReady">
  > = [];
  const requiredQueues = Object.values(QUEUE_NAMES);
  const queryShutdown = new AbortController();
  const effects = new Set<Promise<unknown>>();
  const runs: Promise<void>[] = [];
  function trackEffect(effect: Promise<unknown>) {
    effects.add(effect);
    void effect.finally(() => effects.delete(effect)).catch(() => {});
  }
  function reportJobFailure(queue: string, job: FailedJob | undefined, error: Error) {
    trackEffect(sendJobFailure(queue, job, error));
  }
  // One serving built-in child, spawned lazily on the first model job. A config
  // probe may use a temporary second child when both fit the memory budget.
  // The parent never loads the native addon. The model
  // volume permit serializes downloads, runtime preparation and recovery even
  // after DB lease expiry. The native worker fence drains process replacements.
  options.onStartupStage?.("model-runtime");
  const modelIo = { connectionString: env.DATABASE_URL.reveal() };
  const qwenOwner = `qwen:${randomUUID()}`;
  const qwenChildEntry = fileURLToPath(new URL("./qwen-child.mjs", import.meta.url));
  const qwen = createQwenSupervisor({
    childEntry: qwenChildEntry,
    modelPath: join(modelsDir, QWEN_ARTIFACT.fileName),
    modelsDir,
    lease: {
      acquire: (signal) =>
        acquireModelVolumeLease(
          { connectionString: env.DATABASE_URL.reveal() },
          { owner: qwenOwner, now: new Date(), signal },
        ),
      renew: (signal) =>
        renewModelVolumeLease(
          { connectionString: env.DATABASE_URL.reveal() },
          { owner: qwenOwner, now: new Date(), signal },
        ),
      release: () =>
        releaseModelVolumeLease(
          { connectionString: env.DATABASE_URL.reveal() },
          { owner: qwenOwner },
        ),
    },
    // The panel shows the real peak next to the estimate.
    onPeakRss: createQwenPeakReporter({
      signal: queryShutdown.signal,
      write: (bytes, runtime, signal) =>
        recordModelPeakRss(modelIo, { bytes, ...runtime }, { signal }),
      track: trackEffect,
    }),
  });
  const stopQwenWatch = watchQwenModelRuntime(qwen, (io) => readReadyModelRuntime(modelIo, io));
  // SYSTEM_BUILTIN index builds and query embeddings run only here, in the forked
  // child; the API server never embeds and never loads the addon.
  const qwenEmbedder = createQwenEmbedder({
    supervisor: qwen,
    readReadyRuntime: (io) => readReadyModelRuntime(modelIo, io),
    signal: queryShutdown.signal,
  });
  const verifyModelRuntime = (modelPath: string, modelId: string, signal: AbortSignal) =>
    verifyQwenRuntime({
      ...modelIo,
      childEntry: qwenChildEntry,
      modelPath,
      modelId,
      signal,
    });
  // Memory budget reports and the deployment-wide sequential re-embed driver.
  const stopQwenLoops = startQwenRuntimeLoops({
    detectBudget: () => detectMemoryBudget(),
    reportBudget: (budget, signal) => recordWorkerMemoryBudget(modelIo, budget, { signal }),
    hasWork: () => hasQwenReembedWork(prisma),
    advance: () => advanceQwenReembed({ connectionString: env.DATABASE_URL.reveal() }),
    cleanup: async () => {
      if (await qwen.tryHoldLease()) {
        try {
          await cleanupUnusedBuiltinModelFiles(
            { prisma, connectionString: env.DATABASE_URL.reveal() },
            modelsDir,
          );
        } finally {
          await qwen.releaseLeaseHold();
        }
      }
    },
    reembedIntervalMs: QWEN_REEMBED_TICK_MS,
    // A new built-in config takes effect only after its load probe.
    probeConfig: () =>
      runQwenConfigProbeTick({
        owner: qwenOwner,
        budgetBytes: () => detectMemoryBudget()?.budgetBytes ?? null,
        ...qwenConfigProbeStore({ prisma, connectionString: env.DATABASE_URL.reveal() }, qwenOwner),
        supervisor: qwen,
        cleanup: () =>
          cleanupUnusedBuiltinModelFiles(
            { prisma, connectionString: env.DATABASE_URL.reveal() },
            modelsDir,
          ),
        signal: queryShutdown.signal,
        prepare: (runtime, signal) =>
          prepareBuiltinConfigArtifact({
            runtime: { prisma, connectionString: env.DATABASE_URL.reveal() },
            modelsDir,
            modelId: runtime.modelId,
            epoch: runtime.epoch,
            config: runtime.config,
            signal,
          }),
      }),
    probeIntervalMs: QWEN_CONFIG_PROBE_TICK_MS,
  });
  let stopping = false;
  let ready = false;
  let failed = false;
  let stopPromise: Promise<void> | undefined;
  let durableDispatcher: ReturnType<typeof startDurableDispatcherLoop> | undefined;
  let dispatchWake: DispatchWakeListener | undefined;
  let failureSweepTimer: ReturnType<typeof setTimeout> | undefined;
  let failureSweep = Promise.resolve();
  const failureWatermarkKey = "worker:durable-failure-watermark:v1";
  // Persist a keyset watermark, not a cycling ID cursor. The first deployment
  // starts at worker startup and never mails an existing historical backlog.
  // The shared Redis/AOF watermark also covers failures during later restarts.
  function sweepFailedJobs() {
    if (stopping) return;
    failureSweep = (async () => {
      await heartbeatConnection.set(
        failureWatermarkKey,
        JSON.stringify({ at: workerStartedAt.toISOString(), id: "" }),
        "NX",
      );
      const saved: unknown = JSON.parse(
        (await heartbeatConnection.get(failureWatermarkKey)) ?? "null",
      );
      if (
        !saved ||
        typeof saved !== "object" ||
        !("at" in saved) ||
        !("id" in saved) ||
        typeof saved.at !== "string" ||
        typeof saved.id !== "string" ||
        !Number.isFinite(Date.parse(saved.at))
      )
        throw new Error("Invalid failure watermark");
      const at = new Date(saved.at);
      const rows = await prisma.durableJob.findMany({
        where: {
          state: "FAILED",
          OR: [{ updatedAt: { gt: at } }, { updatedAt: at, id: { gt: saved.id } }],
        },
        select: {
          id: true,
          kind: true,
          lastError: true,
          updatedAt: true,
        } satisfies Prisma.DurableJobSelect,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: 50,
      });
      const groups = new Map<string, { queue: string; code: string; count: number }>();
      for (const row of rows) {
        const code = durableFailureCode(row.lastError);
        const identity = `${row.kind}:${code}`;
        const group = groups.get(identity);
        if (group) group.count++;
        else groups.set(identity, { queue: queueNameForDurableKind(row.kind), code, count: 1 });
      }
      for (const [identity, group] of groups) {
        if (stopping) return;
        await sendOperationalFailureAlert({
          queue: group.queue,
          jobId: undefined,
          identity,
          count: group.count,
          message: `Durable jobs failed (${group.code}); see the worker log for job records`,
        });
      }
      const last = rows.at(-1);
      if (last)
        await heartbeatConnection.set(
          failureWatermarkKey,
          JSON.stringify({ at: last.updatedAt.toISOString(), id: last.id }),
        );
    })()
      .catch((error: unknown) => {
        logInternalError("worker.alert-send", error, { queue: "worker" });
      })
      .finally(() => {
        if (!stopping) {
          failureSweepTimer = setTimeout(sweepFailedJobs, 60_000);
          failureSweepTimer.unref?.();
        }
      });
  }
  const durableQueues = {
    [QUEUE_NAMES.durableProbe]: durableProbeQueue,
    [QUEUE_NAMES.providerProbe]: providerProbeQueue,
    [QUEUE_NAMES.indexKb]: indexKbQueue,
    [QUEUE_NAMES.queryEmbedding]: queryEmbeddingQueue,
    [QUEUE_NAMES.pushMirror]: pushMirrorQueue,
    [QUEUE_NAMES.downloadModel]: downloadModelQueue,
    [QUEUE_NAMES.kbEmail]: kbEmailQueue,
  } as const;
  const heartbeat = createConsumerHeartbeat(
    heartbeatConnection,
    requiredQueues,
    () =>
      ready &&
      !stopping &&
      !failed &&
      connection.status === "ready" &&
      workers.length === requiredQueues.length &&
      requiredQueues.every((name) => workers.some((worker) => worker.name === name)) &&
      workers.every((worker) => worker.isRunning() && !worker.isPaused()),
  );
  function createWorker<T>(name: string, processor: Processor<T>, options: WorkerOptions) {
    const worker = new Worker<T>(name, processor, { ...options, autorun: false });
    workers.push(worker);
    if (DURABLE_QUEUE_NAMES.has(name)) {
      worker.on("completed", (job) => {
        trackEffect(sendJobFailure(name, job, new Error("Durable job failed")));
      });
    }
    worker.on("error", (error) =>
      logInternalError("worker.consumer-connection", error, { queue: name }),
    );
    return worker;
  }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearTimeout(failureSweepTimer);
    queryShutdown.abort();
    ready = false;
    stopPromise = (async () => {
      // Closing consumers must begin even if a pending heartbeat cannot finish.
      // stop() closes BullMQ admission synchronously before awaiting active jobs.
      const modelLoopDrain = stopQwenLoops();
      const modelWatchDrain = stopQwenWatch();
      // Interrupt native serving work before waiting for index/query consumers:
      // index handlers own no shutdown signal, and must not wait on a hung batch.
      const modelChildDrain = qwen.close();
      void modelChildDrain.catch(() => {});
      const workerDrains = Promise.allSettled(workers.map((worker) => worker.close()));
      const dispatcherStop = Promise.all([dispatchWake?.close(), durableDispatcher?.stop()]);
      const heartbeatFailure = await heartbeat.stop().then(
        () => false,
        () => true,
      );
      const results = await workerDrains;
      await dispatcherStop;
      await failureSweep;
      // Join child/probe ownership and loop cleanup before shared clients go away.
      await modelWatchDrain;
      await modelLoopDrain;
      await modelChildDrain;
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("One or more job consumers did not close cleanly.");
      }
      await Promise.allSettled(runs);
      // Producers are now settled; join their alert/RSS continuations before ack.
      await Promise.allSettled([...effects]);
      connection.disconnect();
      heartbeatConnection.disconnect();
      closeOperationalAlertConnection();
      if (heartbeatFailure) throw new Error("Consumer heartbeat did not close cleanly.");
      await assetStorage.stop();
      await admittedMaintenance.release();
    })();
    // Do not disconnect shared clients or pretend timed-out handlers stopped.
    // The host must exit on this rejection; its watchdog owns the hard deadline.
    stopPromise = withTimeout(
      stopPromise,
      workerDrainMs(admittedMaintenance.requested),
      "Worker drain timed out; process must exit.",
    ).catch((error: unknown) => {
      throw new WorkerDrainError(error instanceof Error ? error.message : "Worker drain failed.", {
        cause: error,
      });
    });
    return stopPromise;
  }
  options.signal?.addEventListener(
    "abort",
    () => {
      void stop().catch(() => {});
    },
    { once: true },
  );
  const requireRunning = () => {
    if (stopping || options.signal?.aborted) throw new Error("Worker startup cancelled.");
  };

  try {
    requireRunning();
    options.onStartupStage?.("redis");
    await waitUntilReady(() => connection.ping(), "Redis startup ping timed out", requireRunning);

    options.onStartupStage?.("data-root");
    assertLocalKbDataRoot(env.KB_DATA_ROOT);
    requireRunning();

    options.onStartupStage?.("consumers");
    const echoWorker = createWorker<EchoJobData>(QUEUE_NAMES.echo, handleEchoJob, {
      connection,
      concurrency: 5,
    });

    echoWorker.on("completed", (job) => {
      logEvent("worker.job-completed", { queue: "echo", jobId: job.id });
    });

    echoWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, { queue: "echo", jobId: job?.id });
      void reportJobFailure("echo", job, err);
    });

    // Database seed — on-demand only (no cron). Concurrency 1: never run two seeds
    // at once. Single-attempt; a failed author-written seed surfaces to the admin.
    const seedWorker = createWorker<SeedJobData>(QUEUE_NAMES.seed, handleSeedJob, {
      connection,
      concurrency: 1,
    });

    seedWorker.on("completed", (job) => {
      logEvent("worker.job-completed", { queue: "seed", jobId: job.id });
    });

    seedWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, { queue: "seed", jobId: job?.id });
      void reportJobFailure("seed", job, err);
    });

    // Expired short-lived credentials (sessions, verifications) — another
    // bounded Postgres delete, no storage involved.
    // Concurrency 1: two overlapping sweeps would select the same id pages and
    // race the delete loops for no gain.
    const reapExpiredAuthTokensWorker = createWorker<ReapExpiredAuthTokensJobData>(
      QUEUE_NAMES.reapExpiredAuthTokens,
      handleReapExpiredAuthTokensJob,
      { connection, concurrency: 1 },
    );

    reapExpiredAuthTokensWorker.on("completed", (job) => {
      logEvent("worker.job-completed", { queue: "reap-expired-auth-tokens", jobId: job.id });
    });

    reapExpiredAuthTokensWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, { queue: "reap-expired-auth-tokens", jobId: job?.id });
      void reportJobFailure("reap-expired-auth-tokens", job, err);
    });

    // Backup freshness: one listing of the backup bucket per run, so concurrency 1.
    // The worker is always constructed (a job enqueued from the admin UI must not
    // sit forever), but the schedule is registered only when backups are on.
    const checkBackupFreshnessWorker = createWorker<CheckBackupFreshnessJobData>(
      QUEUE_NAMES.checkBackupFreshness,
      handleCheckBackupFreshnessJob,
      { connection, concurrency: 1 },
    );

    checkBackupFreshnessWorker.on("completed", (job) => {
      logEvent("worker.job-completed", { queue: "check-backup-freshness", jobId: job.id });
    });

    checkBackupFreshnessWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, { queue: "check-backup-freshness", jobId: job?.id });
      void reportJobFailure("check-backup-freshness", job, err);
    });

    const notifyDataDeletionsWorker = createWorker<NotifyDataDeletionsJobData>(
      QUEUE_NAMES.notifyDataDeletions,
      handleNotifyDataDeletionsJob,
      { connection, concurrency: 1 },
    );
    notifyDataDeletionsWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, {
        queue: QUEUE_NAMES.notifyDataDeletions,
        jobId: job?.id,
      });
      reportJobFailure(QUEUE_NAMES.notifyDataDeletions, job, err);
    });

    const durableProbeWorker = createWorker<DurableProbeJobData>(
      QUEUE_NAMES.durableProbe,
      handleDurableProbeJob,
      { connection, concurrency: 2 },
    );

    durableProbeWorker.on("completed", (job) => {
      logEvent("worker.job-completed", { queue: "durable-probe", jobId: job.id });
    });

    durableProbeWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, { queue: "durable-probe", jobId: job?.id });
      void reportJobFailure("durable-probe", job, err);
    });

    const indexKbWorker = createWorker<IndexKbJobData>(
      QUEUE_NAMES.indexKb,
      (job) => handleIndexKbJob(job, qwenEmbedder),
      { connection, concurrency: KB_LIMITS.workerIndexConcurrency },
    );
    indexKbWorker.on("failed", (job) => {
      void reportJobFailure("index-kb", job, new Error("Index build failed"));
    });

    const queryEmbeddingWorker = createWorker<QueryEmbeddingJobData>(
      QUEUE_NAMES.queryEmbedding,
      (job) => handleQueryEmbeddingJob(job, queryShutdown.signal, qwenEmbedder),
      {
        connection,
        concurrency: KB_LIMITS.workerQueryConcurrency,
        lockDuration: GENERATION_LEASE_MS,
        lockRenewTime: 30_000,
      },
    );
    queryEmbeddingWorker.on("failed", (job, err) => {
      if (err?.name === "DurableJobFenceError") return;
      void reportJobFailure(
        "query-embedding",
        job,
        err instanceof Error ? err : new Error("Query embedding unavailable"),
      );
    });

    options.onStartupStage?.("mirror-storage");
    await assertMirrorStorage(MIRROR_TMPFS);
    options.onStartupStage?.("mirror-recovery");
    await recoverMirrorReservations(prisma, env.DATABASE_URL.reveal());
    options.onStartupStage?.("consumers");
    const pushMirrorWorker = createWorker<PushMirrorJobData>(
      QUEUE_NAMES.pushMirror,
      (job) => handlePushMirrorJob(job, queryShutdown.signal),
      { connection, concurrency: KB_LIMITS.workerMirrors },
    );
    pushMirrorWorker.on("failed", (job) => {
      void reportJobFailure("push-mirror", job, new Error("Mirror execution unavailable"));
    });

    // One model download at a time; the DB volume lease also excludes a
    // replacement worker sharing the model volume.
    const downloadModelWorker = createWorker<DownloadModelJobData>(
      QUEUE_NAMES.downloadModel,
      (job) => handleDownloadModelJob(job, queryShutdown.signal, verifyModelRuntime),
      { connection, concurrency: KB_LIMITS.workerDownloads },
    );
    downloadModelWorker.on("failed", (job) => {
      void reportJobFailure("download-model", job, new Error("Model download unavailable"));
    });

    const providerProbeWorker = createWorker<ProviderProbeJobData>(
      QUEUE_NAMES.providerProbe,
      handleProviderProbeJob,
      { connection, concurrency: 2 },
    );
    providerProbeWorker.on("failed", (job) => {
      void reportJobFailure("provider-probe", job, new Error("Embedding provider unavailable"));
    });

    // Invitation/transfer email: SMTP only ever runs here, never in a request.
    const kbEmailWorker = createWorker<KbEmailJobData>(QUEUE_NAMES.kbEmail, handleKbEmailJob, {
      connection,
      concurrency: 2,
    });
    kbEmailWorker.on("failed", (job) => {
      void reportJobFailure("kb-email", job, new Error("KB email delivery failed"));
    });

    // Retention: one sweep at a time (keyset pages never race a sibling sweep).
    const kbRetentionWorker = createWorker<KbRetentionJobData>(
      QUEUE_NAMES.kbRetention,
      handleKbRetentionJob,
      { connection, concurrency: 1 },
    );
    kbRetentionWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, { queue: "kb-retention", jobId: job?.id });
      void reportJobFailure("kb-retention", job, err);
    });

    const kbGitRollupWorker = createWorker<KbGitRollupJobData>(
      QUEUE_NAMES.kbGitRollup,
      (job) => handleKbGitRollupJob(job, options.signal),
      { connection, concurrency: 1 },
    );
    kbGitRollupWorker.on("failed", (job, err) => {
      logInternalError("worker.job", err, { queue: "kb-git-rollup", jobId: job?.id });
      void reportJobFailure("kb-git-rollup", job, err);
    });

    options.onStartupStage?.("schedulers");
    // Register the scheduled sweeps. Stable BullMQ Job Scheduler IDs make these
    // upserts idempotent across restarts and multiple worker replicas.
    // Expired-auth-token pruning is registered unconditionally for the same
    // reason: reading `expiresAt` back is the only thing that ever happened to
    // an expired session or verification — the
    // rows piled up forever. The sweep needs nothing but Postgres.
    try {
      requireRunning();
      await reapExpiredAuthTokensQueue.upsertJobScheduler(
        REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
        { pattern: REAP_EXPIRED_AUTH_TOKENS_CRON_PATTERN },
        { name: "reap-expired-auth-tokens", data: { reason: "cron" } },
      );
      logEvent("worker.scheduler-registered", { queue: "reap-expired-auth-tokens" });
    } catch (err) {
      logInternalError("worker.scheduler", err, { queue: "reap-expired-auth-tokens" });
      throw err;
    }

    try {
      requireRunning();
      await notifyDataDeletionsQueue.upsertJobScheduler(
        NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
        { pattern: NOTIFY_DATA_DELETIONS_CRON_PATTERN },
        { name: "notify-data-deletions", data: { reason: "cron" } },
      );
      await kbGitRollupQueue.upsertJobScheduler(
        KB_GIT_ROLLUP_SCHEDULER_ID,
        { pattern: KB_GIT_ROLLUP_CRON_PATTERN },
        { name: "kb-git-rollup", data: { reason: "cron" } },
      );
      await kbRetentionQueue.upsertJobScheduler(
        KB_RETENTION_MINUTE_JOB_SCHEDULER_ID,
        { pattern: KB_RETENTION_MINUTE_CRON_PATTERN },
        { name: "kb-retention", data: { schedule: "minute" } },
      );
      await kbRetentionQueue.upsertJobScheduler(
        KB_RETENTION_HOURLY_JOB_SCHEDULER_ID,
        { pattern: KB_RETENTION_HOURLY_CRON_PATTERN },
        { name: "kb-retention", data: { schedule: "hourly" } },
      );
    } catch (err) {
      logInternalError("worker.scheduler", err, { queue: "kb-retention" });
      throw err;
    }

    // Backup freshness is gated on the BACKUP_* config, not on object storage:
    // backups use their own bucket and credentials. The provider-only profile
    // (BACKUP_ENABLED=false) has nothing to measure, so it registers nothing.
    try {
      requireRunning();
      const action = await syncBackupFreshnessScheduler(checkBackupFreshnessQueue);
      if (action === "upserted") {
        logEvent("worker.scheduler-registered", { queue: "check-backup-freshness" });
      } else {
        logEvent("worker.scheduler-registered", {
          queue: "check-backup-freshness",
          reason: "BACKUP_DISABLED_REMOVED",
        });
      }
    } catch (err) {
      logInternalError("worker.scheduler", err, { queue: "check-backup-freshness" });
      throw err;
    }

    options.onStartupStage?.("consumer-ready");
    await withTimeout(
      Promise.all(workers.map((worker) => worker.waitUntilReady())),
      10_000,
      "Job consumer startup timed out",
    );
    requireRunning();
    ready = true;
    for (const worker of workers) {
      runs.push(
        worker.run().catch((error: unknown) => {
          failed = true;
          trackEffect(
            sendOperationalFailureAlert({
              queue: "worker",
              jobId: "consumer-failure",
              message: failureSummary(error),
            }).catch(() => {}),
          );
          options.onFatal(error);
        }),
      );
    }
    options.onStartupStage?.("heartbeat");
    await heartbeat.start();
    requireRunning();
    options.onStartupStage?.("dispatcher");
    durableDispatcher = startDurableDispatcherLoop(
      {
        db: prisma,
        ownerId: `dispatcher:${randomUUID()}`,
        now: () => new Date(),
        getQueue: (name) => {
          const queue = durableQueues[name as keyof typeof durableQueues];
          if (!queue) throw new Error(`No durable queue registered for ${name}`);
          return queue;
        },
      },
      DISPATCH_INTERVAL_MS,
    );
    sweepFailedJobs();
    // R3-W4: a committed enqueue (a query embedding above all) dispatches at once.
    const dispatcher = durableDispatcher;
    dispatchWake = listenForDispatchWake(env.DATABASE_URL.reveal(), () => dispatcher.wake());
    requireRunning();
    logEvent("worker.started");
    return { isReady: () => heartbeat.isReady(), stop, assetStorage };
  } catch (error) {
    // Propagate an unclean drain to the host. A rejected startup alone does not
    // prove that active jobs released their shared Prisma/producer dependencies.
    await stop();
    throw error;
  }
}

type FailedJob = {
  data?: unknown;
  id?: string | number;
  attemptsMade: number;
  finishedOn?: number;
  opts: { attempts?: number };
};

// BullMQ emits `failed` on every attempt, not only the last one. Act (alert,
// mark FAILED) only once the job has exhausted its retries so a queue with
// `attempts > 1` doesn't fire one alert per retry. A missing job handle (rare:
// lock lost) is treated as terminal so the failure is still surfaced.
function isTerminalFailure(job: FailedJob | undefined, err?: Error): boolean {
  if (!job) return true;
  if (err?.name === "UnrecoverableError") return true;
  if (job.finishedOn !== undefined) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

async function sendJobFailure(
  queue: string,
  job: FailedJob | undefined,
  err: Error,
): Promise<void> {
  // The authoritative sweep batches durable failures, including lease expiry.
  // BullMQ completion/failure events must not send a second, per-job alert.
  if (DURABLE_QUEUE_NAMES.has(queue)) return;
  if (!isTerminalFailure(job, err)) return;
  try {
    await sendOperationalFailureAlert({ queue, jobId: job?.id, message: failureSummary(err) });
  } catch (alertErr) {
    logInternalError("worker.alert-send", alertErr, { queue });
  }
}

const DURABLE_QUEUE_NAMES = new Set<string>([
  QUEUE_NAMES.durableProbe,
  QUEUE_NAMES.providerProbe,
  QUEUE_NAMES.indexKb,
  QUEUE_NAMES.queryEmbedding,
  QUEUE_NAMES.pushMirror,
  QUEUE_NAMES.downloadModel,
  QUEUE_NAMES.kbEmail,
]);

/** Durable errors are log details; only a stable machine code belongs in email. */
function durableFailureCode(error: string | null): string {
  if (error === "worker lease expired") return "LEASE_EXPIRED";
  return (
    error?.match(/^(?:[A-Za-z]+Error \()?([A-Z][A-Z0-9_]{2,63})(?:\)|:|;|$)/)?.[1] ??
    "DURABLE_JOB_FAILED"
  );
}
