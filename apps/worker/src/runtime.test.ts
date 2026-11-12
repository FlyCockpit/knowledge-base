vi.mock("@knowledge-base/api/lib/kb/asset-storage-mode", () => ({
  assetStorageSelection: () => ({ mode: "disk" }),
  admitAssetStorage: () => state.storageAdmission(),
}));
vi.mock("@knowledge-base/api/lib/kb/git-version", async (original) => ({
  ...(await original<object>()),
  assertSupportedGit: async () => "git version 2.47.3",
}));
vi.mock("@knowledge-base/api/lib/kb/maintenance", () => ({
  startMaintenanceParticipant: async (
    ...args: Parameters<
      typeof import("@knowledge-base/api/lib/kb/maintenance").startMaintenanceParticipant
    >
  ) => {
    await args[4]?.(async () => ({ rows: [], rowCount: 0 }));
    state.events.push("maintenance");
    return { release: async () => undefined };
  },
}));

import type { AssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import { QUEUE_NAMES } from "@knowledge-base/queue/jobs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  events: [] as string[],
  workers: [] as Array<{
    name: string;
    options: {
      concurrency: number;
      autorun: boolean;
      lockDuration?: number;
      lockRenewTime?: number;
    };
    running: boolean;
    run: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    emit(event: string, ...args: unknown[]): void;
  }>,
  failedRows: vi.fn(),
  watermarks: new Map<string, string>(),
  redisSet: vi.fn(),
  redisGet: vi.fn(),
  durableState: vi.fn(),
  alert: vi.fn(),
  ping: vi.fn(),
  storageAdmission: vi.fn(),
  assetS3Enabled: false,
  attachCache: vi.fn(),
  postgres: vi.fn(),
  disconnect: vi.fn(),
  scheduler: vi.fn(),
  heartbeatStart: vi.fn(),
  heartbeatStop: vi.fn(),
  waitReady: vi.fn(),
  run: vi.fn(),
  runFinishes: [] as Array<() => void>,
}));
vi.mock("@knowledge-base/env/shared", () => ({
  env: {
    get KB_ASSET_S3_ENABLED() {
      return state.assetS3Enabled;
    },
    KB_DATA_ROOT: "/var/lib/knowledge-base",
    // No database: the mocked boundaries never connect (reveal() yields nothing).
    DATABASE_URL: { reveal: () => undefined },
  },
}));
vi.mock("@knowledge-base/api/lib/kb/asset-storage-runtime", () => ({
  attachRuntimeAssetCache: (input: { lifecycle: AssetStorageLifecycle }) =>
    state.attachCache(input.lifecycle),
  assetRoleFenceProof: () => () => {},
}));
vi.mock("@knowledge-base/env/topology", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@knowledge-base/env/topology")>()),
  assertLocalKbDataRoot: vi.fn(),
}));
vi.mock("@knowledge-base/queue", async () => {
  const jobs = await import("@knowledge-base/queue/jobs");
  return {
    ...jobs,
    createRedisConnection: () => ({
      ping: state.ping,
      set: state.redisSet,
      get: state.redisGet,
      disconnect: state.disconnect,
      status: "ready",
    }),
    reapExpiredAuthTokensQueue: { upsertJobScheduler: state.scheduler },
    kbRetentionQueue: { upsertJobScheduler: state.scheduler },
    kbGitRollupQueue: { upsertJobScheduler: state.scheduler },
    checkBackupFreshnessQueue: { upsertJobScheduler: state.scheduler },
    notifyDataDeletionsQueue: { upsertJobScheduler: state.scheduler },
    durableProbeQueue: {},
    providerProbeQueue: {},
    indexKbQueue: {},
    queryEmbeddingQueue: {},
    pushMirrorQueue: {},
    downloadModelQueue: {},
    kbEmailQueue: {},
  };
});
vi.mock("@knowledge-base/queue/consumer-health", () => ({
  createConsumerHeartbeat: (
    _connection: unknown,
    _queues: readonly string[],
    healthy: () => boolean,
  ) => ({
    start: state.heartbeatStart,
    stop: state.heartbeatStop,
    isReady: healthy,
  }),
}));
vi.mock("./backup-freshness-scheduler.js", () => ({
  syncBackupFreshnessScheduler: () => state.scheduler().then(() => "upserted"),
}));
vi.mock("./operational-alerts.js", () => ({
  closeOperationalAlertConnection: () => state.events.push("alerts-close"),
  sendOperationalFailureAlert: state.alert,
}));
// Runtime lifecycle tests own fake timers, not a PostgreSQL authority session.
// Probe/store transactions are exercised by the disposable qwen-reembed lane.
vi.mock("@knowledge-base/api/lib/kb/local-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@knowledge-base/api/lib/kb/local-model")>()),
  qwenConfigProbeStore: vi.fn(() => ({ read: vi.fn(async () => null) })),
}));
vi.mock("@knowledge-base/db", () => ({
  default: {
    $queryRaw: state.postgres,
    durableJob: { findMany: state.failedRows, findUnique: state.durableState },
  },
}));
vi.mock("./handlers/notify-data-deletions.js", () => ({ handleNotifyDataDeletionsJob: vi.fn() }));
vi.mock("./handlers/check-backup-freshness.js", () => ({ handleCheckBackupFreshnessJob: vi.fn() }));
vi.mock("./handlers/echo.js", () => ({ handleEchoJob: vi.fn() }));
vi.mock("./handlers/reap-expired-auth-tokens.js", () => ({
  handleReapExpiredAuthTokensJob: vi.fn(),
}));
vi.mock("./handlers/seed.js", () => ({ handleSeedJob: vi.fn() }));
vi.mock("./handlers/kb-git-rollup.js", () => ({ handleKbGitRollupJob: vi.fn() }));
vi.mock("./handlers/kb-retention.js", () => ({ handleKbRetentionJob: vi.fn() }));
vi.mock("./lib/mirror-ssh.js", () => ({
  assertMirrorStorage: vi.fn(),
  MIRROR_TMPFS: "/run/kb-mirror",
}));
vi.mock("./handlers/push-mirror.js", () => ({
  handlePushMirrorJob: vi.fn(),
  recoverMirrorReservations: vi.fn(),
}));
vi.mock("./handlers/download-model.js", () => ({ handleDownloadModelJob: vi.fn() }));
vi.mock("./handlers/query-embedding.js", () => ({ handleQueryEmbeddingJob: vi.fn() }));
vi.mock("./handlers/index-kb.js", () => ({ handleIndexKbJob: vi.fn() }));
vi.mock("./handlers/provider-probe.js", () => ({ handleProviderProbeJob: vi.fn() }));
vi.mock("./handlers/durable-probe.js", () => ({ handleDurableProbeJob: vi.fn() }));
vi.mock("./handlers/kb-email.js", () => ({ handleKbEmailJob: vi.fn() }));
vi.mock("./durable-dispatcher.js", () => ({
  startDurableDispatcherLoop: vi.fn(() => ({ wake: vi.fn(), stop: vi.fn(async () => {}) })),
}));
vi.mock("@knowledge-base/api/lib/kb/dispatch", () => ({
  listenForDispatchWake: vi.fn(() => ({ close: vi.fn(async () => {}) })),
}));
vi.mock("bullmq", () => ({
  Worker: class {
    running = false;
    constructor(
      public name: string,
      _processor: unknown,
      public options: {
        concurrency: number;
        autorun: boolean;
        lockDuration?: number;
        lockRenewTime?: number;
      },
    ) {
      state.workers.push(this);
    }
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    on = vi.fn((name: string, listener: (...args: unknown[]) => void) => {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
      return this;
    });
    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    waitUntilReady = state.waitReady;
    isRunning = () => this.running;
    isPaused = () => false;
    run = vi.fn(() => {
      this.running = true;
      state.events.push("run");
      return state.run();
    });
    close = vi.fn(async () => {
      this.running = false;
      state.events.push("close");
      state.runFinishes.shift()?.();
    });
  },
}));
// Resolve the cold dependency graph during collection, like a static import.
// Each test still reloads the module below to get an unclaimed runtime.
let runtimeModule = await import("./runtime");
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.failedRows.mockReset().mockResolvedValue([]);
  state.durableState.mockReset().mockResolvedValue({ state: "RETRY" });
  state.watermarks.clear();
  state.redisSet.mockReset().mockImplementation(async (key: string, value: string, nx?: string) => {
    if (nx !== "NX" || !state.watermarks.has(key)) state.watermarks.set(key, value);
    return "OK";
  });
  state.redisGet
    .mockReset()
    .mockImplementation(async (key: string) => state.watermarks.get(key) ?? null);
  state.alert.mockReset().mockResolvedValue(undefined);
  state.storageAdmission.mockReset().mockResolvedValue(undefined);
  state.assetS3Enabled = false;
  state.attachCache.mockReset();
  state.workers.length = 0;
  state.events.length = 0;
  state.ping.mockReset().mockResolvedValue("PONG");
  state.postgres.mockReset().mockImplementation(async () => {
    state.events.push("postgres");
    return 1;
  });
  state.waitReady.mockResolvedValue(undefined);
  state.runFinishes.length = 0;
  state.run.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        state.runFinishes.push(resolve);
      }),
  );
  state.scheduler.mockImplementation(async () => {
    state.events.push("scheduler");
  });
  state.heartbeatStart.mockResolvedValue(undefined);
  state.heartbeatStop.mockImplementation(async () => {
    state.events.push("heartbeat-stop");
  });
  state.disconnect.mockImplementation(() => state.events.push("disconnect"));
  // Prepare a fresh process-scoped claim; startup remains the test action.
  runtimeModule = await import("./runtime");
});
afterEach(() => vi.useRealTimers());

describe("startWorkerRuntime", () => {
  it("notifies registry admission only after maintenance succeeds and before starting consumers", async () => {
    const admitted = vi.fn(() => {
      expect(state.events).toContain("maintenance");
      expect(state.workers).toHaveLength(0);
    });
    const runtime = await runtimeModule.startWorkerRuntime({
      onFatal: vi.fn(),
      onMaintenanceAdmitted: admitted,
    });
    expect(admitted).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("reports an unconfirmed startup ownership drain as fatal to the host", async () => {
    state.assetS3Enabled = true;
    state.attachCache.mockImplementation((storage: AssetStorageLifecycle) => {
      storage.failOwnership();
      throw new Error("Cache startup failed");
    });
    await expect(runtimeModule.startWorkerRuntime({ onFatal: vi.fn() })).rejects.toBeInstanceOf(
      runtimeModule.WorkerDrainError,
    );
    expect(state.workers).toHaveLength(0);
  });
  it("cancels cache attachment before Redis startup and joins its lifecycle drain", async () => {
    state.assetS3Enabled = true;
    const parent = new AbortController();
    const entered = Promise.withResolvers<void>();
    const finishClose = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    state.attachCache.mockImplementation((storage: AssetStorageLifecycle) => {
      storage.own(async () => {
        closing.resolve();
        await finishClose.promise;
      });
      return storage.track(async () => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          storage.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        storage.signal.throwIfAborted();
      });
    });
    let settled = false;
    const starting = runtimeModule
      .startWorkerRuntime({ onFatal: vi.fn(), signal: parent.signal })
      .finally(() => {
        settled = true;
      });
    const rejected = expect(starting).rejects.toThrow("Parent cancelled attachment");
    await entered.promise;
    parent.abort(new Error("Parent cancelled attachment"));
    await closing.promise;
    expect(settled).toBe(false);
    expect(state.ping).not.toHaveBeenCalled();
    expect(state.workers).toHaveLength(0);
    finishClose.resolve();
    await rejected;
  });
  it("refuses stale storage before queue/scheduler/consumer effects", async () => {
    state.storageAdmission.mockRejectedValue(new Error("storage mode mismatch"));
    await expect(runtimeModule.startWorkerRuntime({ onFatal: vi.fn() })).rejects.toThrow(
      "storage mode mismatch",
    );
    expect(state.workers).toHaveLength(0);
    expect(state.scheduler).not.toHaveBeenCalled();
  });

  it("runs every declared queue externally, with dedicated concurrency and one scheduler path", async () => {
    const { startWorkerRuntime } = runtimeModule;
    const runtime = await startWorkerRuntime({ onFatal: vi.fn() });
    expect(state.workers.map((worker) => worker.name).sort()).toEqual(
      Object.values(QUEUE_NAMES).sort(),
    );
    expect(state.workers.every((worker) => !worker.options.autorun)).toBe(true);
    expect(
      state.workers.find((worker) => worker.name === QUEUE_NAMES.echo)?.options.concurrency,
    ).toBe(5);
    expect(
      state.workers.find((worker) => worker.name === QUEUE_NAMES.queryEmbedding)?.options
        .concurrency,
    ).toBe(4);
    expect(
      state.workers.find((worker) => worker.name === QUEUE_NAMES.downloadModel)?.options
        .concurrency,
    ).toBe(1);
    expect(
      state.workers.find((worker) => worker.name === QUEUE_NAMES.queryEmbedding)?.options
        .lockDuration,
    ).toBe(90_000);
    expect(
      state.workers.find((worker) => worker.name === QUEUE_NAMES.indexKb)?.options.concurrency,
    ).toBe(2);
    // Worker concurrency: index2 / query4 / download1 / mirror2 (model child 1 and
    // export 2 are enforced by the Qwen supervisor and the server export limiter
    // respectively; see their own suites).
    const concurrency = (name: string) =>
      state.workers.find((worker) => worker.name === name)?.options.concurrency;
    expect(concurrency(QUEUE_NAMES.pushMirror)).toBe(2);
    // Retention: one sweep at a time so two replicas never page the same keyset.
    expect(concurrency(QUEUE_NAMES.kbRetention)).toBe(1);
    expect(concurrency(QUEUE_NAMES.kbGitRollup)).toBe(1);
    expect(state.scheduler.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(["kb-retention-minute", "kb-retention-hourly"]),
    );
    expect(state.events.lastIndexOf("scheduler")).toBeLessThan(state.events.indexOf("run"));
    expect(runtime.isReady()).toBe(true);
    await expect(startWorkerRuntime({ onFatal: vi.fn() })).rejects.toThrow("already started");
    const stop = runtime.stop();
    expect(runtime.stop()).toBe(stop);
    expect(runtime.isReady()).toBe(false);
    await stop;
    await expect(startWorkerRuntime({ onFatal: vi.fn() })).rejects.toThrow("already started");
  });

  it("still drains every consumer when heartbeat withdrawal fails", async () => {
    const { startWorkerRuntime } = runtimeModule;
    const runtime = await startWorkerRuntime({ onFatal: vi.fn() });
    state.heartbeatStop.mockRejectedValueOnce(new Error("offline"));
    await expect(runtime.stop()).rejects.toThrow("did not close cleanly");
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
  });

  it("cleans up partial startup and never starts consumers when scheduler registration fails", async () => {
    state.scheduler.mockRejectedValueOnce(new Error("registration failed"));
    const { startWorkerRuntime } = runtimeModule;
    const onStartupStage = vi.fn();
    await expect(startWorkerRuntime({ onFatal: vi.fn(), onStartupStage })).rejects.toThrow(
      "registration failed",
    );
    expect(onStartupStage.mock.lastCall).toEqual(["schedulers"]);
    expect(
      state.workers.every(
        (worker) => worker.run.mock.calls.length === 0 && worker.close.mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(state.disconnect).toHaveBeenCalledTimes(2);
  });

  it("reports data-root startup failures separately from scheduler failures", async () => {
    const { assertLocalKbDataRoot } = await import("@knowledge-base/env/topology");
    vi.mocked(assertLocalKbDataRoot).mockImplementationOnce(() => {
      throw new Error("bad root");
    });
    const onStartupStage = vi.fn();
    await expect(
      runtimeModule.startWorkerRuntime({ onFatal: vi.fn(), onStartupStage }),
    ).rejects.toThrow("bad root");
    expect(onStartupStage.mock.lastCall).toEqual(["data-root"]);
  });

  it("retries startup Redis without creating duplicate consumers", async () => {
    vi.useFakeTimers();
    state.ping.mockRejectedValueOnce(new Error("offline"));
    const { startWorkerRuntime } = runtimeModule;
    const starting = startWorkerRuntime({ onFatal: vi.fn() });
    await vi.advanceTimersByTimeAsync(500);
    const runtime = await starting;
    expect(state.ping).toHaveBeenCalledTimes(2);
    expect(state.workers).toHaveLength(Object.keys(QUEUE_NAMES).length);
    await runtime.stop();
  });

  it("retries a Postgres that is still booting before the maintenance participant connects", async () => {
    vi.useFakeTimers();
    const booting = Object.assign(new Error("the database system is starting up"), {
      code: "57P03",
    });
    state.postgres.mockRejectedValueOnce(booting).mockRejectedValueOnce(booting);
    const onStartupStage = vi.fn();
    const starting = runtimeModule.startWorkerRuntime({ onFatal: vi.fn(), onStartupStage });
    await vi.advanceTimersByTimeAsync(1500);
    const runtime = await starting;
    expect(state.postgres).toHaveBeenCalledTimes(3);
    expect(state.events.slice(0, 2)).toEqual(["postgres", "maintenance"]);
    const stages = onStartupStage.mock.calls.map(([stage]) => stage);
    expect(stages.indexOf("postgres")).toBeLessThan(stages.indexOf("maintenance"));
    await runtime.stop();
  });

  it("an unreachable Postgres fails at the postgres stage, before maintenance", async () => {
    vi.useFakeTimers();
    state.postgres.mockRejectedValue(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    const onStartupStage = vi.fn();
    const assertion = expect(
      runtimeModule.startWorkerRuntime({ onFatal: vi.fn(), onStartupStage }),
    ).rejects.toThrow("refused");
    await vi.advanceTimersByTimeAsync(7500);
    await assertion;
    expect(state.postgres).toHaveBeenCalledTimes(5);
    expect(state.events).not.toContain("maintenance");
    expect(onStartupStage.mock.lastCall).toEqual(["postgres"]);
  });

  it("aborted startup cannot enter processing later", async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    state.ping.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { startWorkerRuntime } = runtimeModule;
    const starting = startWorkerRuntime({
      onFatal: vi.fn(),
      signal: controller.signal,
    });
    const rejected = expect(starting).rejects.toThrow("cancelled");
    controller.abort();
    release?.();
    await rejected;
    expect(state.workers).toHaveLength(0);
  });

  it("closes admission immediately when cancelled during the initial heartbeat, and drains before cleanup", async () => {
    let publish: (() => void) | undefined;
    let drain: (() => void) | undefined;
    state.heartbeatStart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          publish = resolve;
        }),
    );
    state.heartbeatStop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          drain = resolve;
        }),
    );
    const controller = new AbortController();
    const { startWorkerRuntime } = runtimeModule;
    const starting = startWorkerRuntime({
      onFatal: vi.fn(),
      signal: controller.signal,
    });
    const rejected = expect(starting).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(state.heartbeatStart).toHaveBeenCalled());
    expect(state.workers.every((worker) => worker.running)).toBe(true);
    controller.abort();
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
    expect(state.disconnect).not.toHaveBeenCalled();
    publish?.();
    drain?.();
    await rejected;
    expect(state.disconnect).toHaveBeenCalledTimes(2);
  });

  it("propagates an unclean startup drain instead of disguising it as an ordinary startup failure", async () => {
    vi.useFakeTimers();
    state.heartbeatStart.mockRejectedValueOnce(new Error("publication failed"));
    state.heartbeatStop.mockImplementationOnce(() => new Promise(() => {}));
    const { startWorkerRuntime, WorkerDrainError } = runtimeModule;
    const assertion = expect(startWorkerRuntime({ onFatal: vi.fn() })).rejects.toBeInstanceOf(
      WorkerDrainError,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it("bounds a hung drain and stays unready without prematurely disconnecting dependencies", async () => {
    vi.useFakeTimers();
    const { startWorkerRuntime } = runtimeModule;
    const runtime = await startWorkerRuntime({ onFatal: vi.fn() });
    state.workers[0]?.close.mockImplementation(() => new Promise(() => {}));
    const stopped = expect(runtime.stop()).rejects.toThrow("must exit");
    await vi.advanceTimersByTimeAsync(15_000);
    await stopped;
    expect(runtime.isReady()).toBe(false);
    expect(state.disconnect).not.toHaveBeenCalled();
  });

  it("a missing or duplicate registered queue suppresses readiness", async () => {
    const { startWorkerRuntime } = runtimeModule;
    const runtime = await startWorkerRuntime({ onFatal: vi.fn() });
    const worker = state.workers[0];
    if (!worker) throw new Error("missing test worker");
    worker.name = "unregistered-queue";
    expect(runtime.isReady()).toBe(false);
    await runtime.stop();
  });

  it("registers auth and backup schedulers before workers run", async () => {
    const jobs = await import("@knowledge-base/queue/jobs");
    const { startWorkerRuntime } = runtimeModule;
    const runtime = await startWorkerRuntime({ onFatal: vi.fn() });
    expect(state.scheduler.mock.calls.map((args) => args[0]).filter(Boolean)).toEqual([
      jobs.REAP_EXPIRED_AUTH_TOKENS_JOB_SCHEDULER_ID,
      jobs.NOTIFY_DATA_DELETIONS_JOB_SCHEDULER_ID,
      jobs.KB_GIT_ROLLUP_SCHEDULER_ID,
      jobs.KB_RETENTION_MINUTE_JOB_SCHEDULER_ID,
      jobs.KB_RETENTION_HOURLY_JOB_SCHEDULER_ID,
    ]);
    expect(state.events.lastIndexOf("scheduler")).toBeLessThan(state.events.indexOf("run"));
    await runtime.stop();
  });

  it("cancelled scheduler startup admits no subsequent scheduler or job", async () => {
    const controller = new AbortController();
    state.scheduler.mockImplementationOnce(async () => {
      controller.abort();
    });
    const { startWorkerRuntime } = runtimeModule;
    await expect(
      startWorkerRuntime({ onFatal: vi.fn(), signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(state.scheduler).toHaveBeenCalledOnce();
    expect(state.run).not.toHaveBeenCalled();
  });

  it("a pre-aborted startup cannot construct consumers", async () => {
    await expect(
      runtimeModule.startWorkerRuntime({
        onFatal: vi.fn(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("cancelled");
    expect(state.ping).not.toHaveBeenCalled();
    expect(state.workers).toHaveLength(0);
  });

  it("exhausted Redis retries cannot construct consumers", async () => {
    vi.useFakeTimers();
    state.ping.mockRejectedValue(new Error("offline"));
    const assertion = expect(
      runtimeModule.startWorkerRuntime({ onFatal: vi.fn() }),
    ).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(7500);
    await assertion;
    expect(state.ping).toHaveBeenCalledTimes(5);
    expect(state.workers).toHaveLength(0);
  });

  it("times out consumer readiness before starting any jobs", async () => {
    vi.useFakeTimers();
    state.waitReady.mockImplementation(() => new Promise(() => {}));
    const { startWorkerRuntime } = runtimeModule;
    const assertion = expect(startWorkerRuntime({ onFatal: vi.fn() })).rejects.toThrow(
      "startup timed out",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(state.run).not.toHaveBeenCalled();
    expect(state.workers.every((worker) => worker.close.mock.calls.length === 1)).toBe(true);
  });

  it("a consumer run rejection revokes readiness and reaches the host fatal path", async () => {
    state.run.mockRejectedValueOnce(new Error("consumer crashed"));
    const fatal = vi.fn();
    const { startWorkerRuntime } = runtimeModule;
    const runtime = await startWorkerRuntime({ onFatal: fatal });
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ message: "consumer crashed" }));
    expect(runtime.isReady()).toBe(false);
    await runtime.stop();
  });

  it("rejected consumer close cannot authorize runtime-owned connection teardown", async () => {
    const { startWorkerRuntime, WorkerDrainError } = runtimeModule;
    const runtime = await startWorkerRuntime({ onFatal: vi.fn() });
    state.workers[0]?.close.mockRejectedValueOnce(new Error("still active"));
    await expect(runtime.stop()).rejects.toBeInstanceOf(WorkerDrainError);
    expect(state.disconnect).not.toHaveBeenCalled();
  });
});

describe("committed durable failure alerts", () => {
  beforeEach(() => vi.useFakeTimers());
  const at = new Date("2026-11-11T00:00:01Z");
  const failure = (id: string, lastError = "PROVIDER_DOWN") => ({
    id,
    kind: "QUERY_EMBEDDING",
    lastError,
    updatedAt: at,
    state: "FAILED",
  });
  const watermarkKey = "worker:durable-failure-watermark:v1";
  function authoritativeRows(rows: ReturnType<typeof failure>[]) {
    state.failedRows.mockImplementation(async (query) => {
      const [newer, sameTime] = query.where.OR;
      return rows
        .filter(
          (row) =>
            row.state === query.where.state &&
            (row.updatedAt > newer.updatedAt.gt ||
              (+row.updatedAt === +sameTime.updatedAt && row.id > sameTime.id.gt)),
        )
        .sort((a, b) => +a.updatedAt - +b.updatedAt || a.id.localeCompare(b.id))
        .slice(0, query.take);
    });
  }
  it("ignores historical FAILED rows on first deployment and after a restart", async () => {
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    authoritativeRows([{ ...failure("old"), updatedAt: new Date("2026-11-10") }]);
    const runtime = await runtimeModule.startWorkerRuntime({ onFatal: vi.fn() });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.alert).not.toHaveBeenCalled();
    await runtime.stop();
    vi.resetModules();
    runtimeModule = await import("./runtime");
    const restarted = await runtimeModule.startWorkerRuntime({ onFatal: vi.fn() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.alert).not.toHaveBeenCalled();
    await restarted.stop();
  });
  it("aggregates the same kind/code and never re-alerts unchanged rows after cooldown or restart", async () => {
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    authoritativeRows([failure("a"), failure("b"), failure("c", "LEASE_LOST")]);
    const runtime = await runtimeModule.startWorkerRuntime({ onFatal: vi.fn() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.alert).toHaveBeenCalledTimes(2);
    expect(state.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: QUEUE_NAMES.queryEmbedding,
        identity: "QUERY_EMBEDDING:PROVIDER_DOWN",
        count: 2,
      }),
    );
    const watermark = state.watermarks.get(watermarkKey);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(state.alert).toHaveBeenCalledTimes(2);
    await runtime.stop();
    vi.resetModules();
    runtimeModule = await import("./runtime");
    const restarted = await runtimeModule.startWorkerRuntime({ onFatal: vi.fn() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.watermarks.get(watermarkKey)).toBe(watermark);
    expect(state.alert).toHaveBeenCalledTimes(2);
    await restarted.stop();
  });
  it("resumes a persisted watermark, pages timestamp ties, and alerts a new failure transition", async () => {
    vi.setSystemTime(new Date("2026-11-11T00:01:00Z"));
    state.watermarks.set(watermarkKey, JSON.stringify({ at: "2026-11-11T00:00:00.000Z", id: "" }));
    const rows = Array.from({ length: 51 }, (_, i) => failure(String(i).padStart(3, "0")));
    authoritativeRows(rows);
    const runtime = await runtimeModule.startWorkerRuntime({ onFatal: vi.fn() });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.alert.mock.calls.map(([args]) => args.count)).toEqual([50, 1]);
    expect(JSON.parse(state.watermarks.get(watermarkKey)!)).toEqual({
      at: at.toISOString(),
      id: "050",
    });
    rows[0]!.updatedAt = new Date("2026-11-11T00:02:01Z");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.alert).toHaveBeenCalledTimes(3);
    expect(state.failedRows).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));
    await runtime.stop();
  });
  it("does not bypass aggregation through BullMQ completion or failure events", async () => {
    const runtime = await runtimeModule.startWorkerRuntime({ onFatal: vi.fn() });
    const consumer = state.workers.find((w) => w.name === QUEUE_NAMES.downloadModel)!;
    const job = { data: { durableJobId: "id" }, attemptsMade: 1, opts: { attempts: 1 } };
    consumer.emit("failed", job, new Error("temporary"));
    consumer.emit("completed", job, { state: "FAILED" });
    await runtime.stop();
    expect(state.alert).not.toHaveBeenCalled();
  });
});
