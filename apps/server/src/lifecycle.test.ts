import { readFileSync } from "node:fs";
import type { AssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import { MUTATION_DEADLINE_MS } from "@knowledge-base/api/lib/kb/lock";
import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import { DRAIN_MS } from "./kb-process.js";
import {
  createServerLifecycle,
  HTTP_DRAIN_MS,
  HTTP_QUIESCE_MS,
  SHUTDOWN_WATCHDOG_MS,
} from "./lifecycle.js";

const state = vi.hoisted(() => ({
  instanceStart: vi.fn(),
  instanceReady: vi.fn(),
  instanceStop: vi.fn(),
  postgres: vi.fn(),
  storageAdmission: vi.fn(),
  redis: vi.fn(),
  disconnectDb: vi.fn(),
  disconnectRedis: vi.fn(),
  events: [] as string[],
  volumes: vi.fn(),
  fence: vi.fn(),
  shutdownCoordinator: vi.fn(),
  recoverSpools: vi.fn(),
  readerStart: vi.fn(),
  git: vi.fn(),
  configureStorage: vi.fn(),
}));
vi.mock("@knowledge-base/db/instance-heartbeat", () => ({
  startInstanceHeartbeat: (options: unknown) => {
    state.instanceStart(options);
    state.events.push("instance-start");
    return { markReady: state.instanceReady, stop: state.instanceStop };
  },
}));
vi.mock("@knowledge-base/db", () => ({
  default: { $queryRaw: state.postgres, $disconnect: state.disconnectDb },
}));
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    DATABASE_URL: new Secret("postgresql://kb_runtime_x:x@127.0.0.1:5432/kb_test_x"),
    KB_DATA_ROOT: "/var/lib/knowledge-base",
  },
}));
vi.mock("@knowledge-base/env/topology", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@knowledge-base/env/topology")>()),
  assertLocalKbDataRoot: (...args: unknown[]) => state.volumes(...args),
}));
vi.mock("@knowledge-base/queue", () => ({
  redisConnection: { ping: state.redis, disconnect: state.disconnectRedis },
}));
vi.mock("./kb-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./kb-process.js")>()),
  pingProcessFence: (...args: unknown[]) => state.fence(...args),
  closeAdmission: async () => {
    state.events.push("admission-closed");
  },
}));
vi.mock("@knowledge-base/api/lib/kb/recovery", () => ({
  runStartupJournalRecovery: vi.fn(async () => undefined),
  startJournalRecoverySweep: () => ({ stop: vi.fn(async () => undefined) }),
}));
vi.mock("@knowledge-base/api/lib/kb/push-spool", () => ({
  recoverPushSpools: (...args: unknown[]) => state.recoverSpools(...args),
}));
vi.mock("./kb-write-coordinator.js", () => ({
  closeKbWriteAdmission: vi.fn(),
  startKbWriteCoordinator: () => {
    state.events.push("coordinator-started");
  },
  shutdownKbWriteCoordinator: async () => {
    state.events.push("coordinator-shutdown");
    await state.shutdownCoordinator();
  },
}));
vi.mock("./kb-staging-cleanup.js", () => ({
  startKbStagingCleanup: async () => {
    state.events.push("query-scrub-before-admission");
    return { stop: async () => undefined };
  },
}));
vi.mock("./kb-runtime.js", () => ({
  configureServerKbRuntime: async (storage: AssetStorageLifecycle) => {
    storage.own(async () => {
      state.events.push("asset-storage-closed");
    });
    state.events.push("kb-runtime-configured");
    await state.configureStorage(storage);
  },
  configureServerIndexReader: () => ({
    start: async () => {
      state.events.push("index-reader-started");
      await state.readerStart();
    },
    stop: async () => {
      state.events.push("index-reader-stopped");
    },
  }),
}));
vi.mock("@knowledge-base/api/lib/kb/runtime", () => ({ getKbRuntime: () => ({}) }));
vi.mock("@knowledge-base/api/lib/kb/exports", () => ({
  startExportLifecycle: async () => ({ stop: async () => undefined }),
}));
vi.mock("@knowledge-base/api/lib/kb/git-version", async (original) => ({
  ...(await original<object>()),
  assertSupportedGit: () => state.git(),
}));
vi.mock("@knowledge-base/api/lib/kb/asset-storage-mode", () => ({
  assetStorageSelection: () => ({ mode: "disk" }),
  admitAssetStorage: () => state.storageAdmission(),
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
const native = readFileSync(new URL("../native/kb-supervisor.c", import.meta.url), "utf8");
const nativeGrace = Number(native.match(/#define GRACEFUL_SHUTDOWN_MS (\d+)/)?.[1]);
const generator = readFileSync(
  new URL("../../../scripts/generate-dokploy-config.ts", import.meta.url),
  "utf8",
);
const containerGrace =
  Number(
    generator.match(/(?: {2}server:| {2}\$\{router\}:)\n[\s\S]*?stop_grace_period: (\d+)s/)?.[1],
  ) * 1000;

const listeners = new Map<string, (...args: unknown[]) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  listeners.clear();
  state.events.length = 0;
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    listeners.set(String(event), listener);
    return process;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  state.postgres.mockResolvedValue(1);
  state.redis.mockResolvedValue("PONG");
  state.volumes.mockReturnValue(undefined);
  state.fence.mockResolvedValue(undefined);
  state.recoverSpools.mockImplementation(async () => {
    state.events.push("git-spools-recovered");
  });
  state.readerStart.mockResolvedValue(undefined);
  state.git.mockResolvedValue("git version 2.47.3");
  state.disconnectDb.mockImplementation(async () => {
    state.events.push("db-disconnect");
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createServerLifecycle", () => {
  it("starts registry tracking after maintenance and marks ready only once the HTTP listener opens", async () => {
    let opened: (() => void) | undefined;
    const lifecycle = createServerLifecycle();
    await lifecycle.start((ready) => {
      opened = ready;
      return { close: (done) => done() };
    });
    expect(state.events.indexOf("instance-start")).toBeGreaterThan(
      state.events.indexOf("maintenance"),
    );
    expect(state.instanceStart).toHaveBeenCalledWith({ role: "server" });
    expect(state.instanceReady).not.toHaveBeenCalled();
    opened?.();
    expect(state.instanceReady).toHaveBeenCalledOnce();
    listeners.get("SIGTERM")?.();
    expect(state.instanceStop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(HTTP_QUIESCE_MS + HTTP_DRAIN_MS);
  });
  it("stops registry tracking on a startup failure and refuses a late listening callback", async () => {
    let opened: (() => void) | undefined;
    const lifecycle = createServerLifecycle();
    await lifecycle.start((ready) => {
      opened = ready;
      throw new Error("listen failed");
    });
    expect(state.instanceStop).toHaveBeenCalledOnce();
    opened?.();
    expect(state.instanceReady).not.toHaveBeenCalled();
  });

  it("propagates SIGTERM during cache attachment and joins the scan before DB disconnect", async () => {
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    state.configureStorage.mockImplementation((storage: AssetStorageLifecycle) =>
      storage.track(async () => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          storage.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        cancelled.resolve();
        await drained.promise;
        storage.signal.throwIfAborted();
      }),
    );
    const listen = vi.fn();
    const lifecycle = createServerLifecycle();
    const starting = lifecycle.start(listen);
    await entered.promise;
    listeners.get("SIGTERM")?.();
    await cancelled.promise;
    expect(listen).not.toHaveBeenCalled();
    expect(state.disconnectDb).not.toHaveBeenCalled();
    drained.resolve();
    await starting;
    expect(state.disconnectDb).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledWith(0);
  });
  it("refuses stale storage before spool/journal recovery or listen", async () => {
    state.storageAdmission.mockRejectedValue(new Error("storage mode mismatch"));
    const listen = vi.fn();
    await createServerLifecycle().start(listen);
    expect(state.recoverSpools).not.toHaveBeenCalled();
    expect(state.instanceStart).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
  it("recovers abandoned Git spools under the fence before listening, and fails closed on recovery error", async () => {
    await createServerLifecycle().start(() => {
      state.events.push("listen");
      return { close: (done) => done() };
    });
    expect(state.recoverSpools).toHaveBeenCalledOnce();
    expect(state.events.indexOf("git-spools-recovered")).toBeLessThan(
      state.events.indexOf("listen"),
    );
    state.recoverSpools.mockRejectedValue(new Error("unsafe spool path"));
    const listen = vi.fn();
    await createServerLifecycle().start(listen);
    expect(listen).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
  it("places maintenance admission before OAuth and every effectful route", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const admission = index.indexOf("const httpGate = createAdmissionGate()");
    expect(admission).toBeGreaterThan(0);
    expect(admission).toBeLessThan(index.indexOf("const mcpAuthHandler = mountMcpOAuth("));
    expect(admission).toBeLessThan(index.indexOf('app.route("/", gitHttp.app)'));
  });
  it("joins storage ownership before database disconnect", async () => {
    await createServerLifecycle().start(() => ({ close: (done) => done() }));
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.events.indexOf("asset-storage-closed")).toBeGreaterThan(-1);
    expect(state.events.indexOf("asset-storage-closed")).toBeLessThan(
      state.events.indexOf("db-disconnect"),
    );
  });
  it("scrubs expired query data before admission opens", async () => {
    await createServerLifecycle().start(() => {
      state.events.push("listen");
      return { close: (done) => done() };
    });
    expect(state.events.indexOf("query-scrub-before-admission")).toBeGreaterThanOrEqual(0);
    expect(state.events.indexOf("query-scrub-before-admission")).toBeLessThan(
      state.events.indexOf("listen"),
    );
  });
  it("joins reserved Git publication before closing native admission or the database", async () => {
    let finish!: () => void;
    await createServerLifecycle({
      closeGitAdmission: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    }).start(() => ({ close: (done) => done() }));
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(20000);
    expect(state.events).not.toContain("coordinator-shutdown");
    expect(state.disconnectDb).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(6000);
    expect(state.disconnectDb).toHaveBeenCalledOnce();
  });
  it("closes bearer admission before coordinator drain and joins it before DB disconnect", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = createServerLifecycle({
      closeBearerAdmission: () => {
        state.events.push("bearer-closed");
        return pending;
      },
    });
    await lifecycle.start(() => ({
      close: (callback) => {
        callback();
      },
    }));
    listeners.get("SIGTERM")?.();
    expect(state.events).toContain("bearer-closed");
    await vi.advanceTimersByTimeAsync(1);
    expect(state.events.indexOf("bearer-closed")).toBeLessThan(
      state.events.indexOf("coordinator-shutdown"),
    );
    expect(state.disconnectDb).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.disconnectDb).toHaveBeenCalledOnce();
  });
  it("allows the mutation and child drain budgets before starting the full HTTP drain", async () => {
    const operationBudget = MUTATION_DEADLINE_MS + DRAIN_MS;
    state.shutdownCoordinator.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, operationBudget)),
    );
    const close = vi.fn(); // Exhaust the HTTP timeout, too.
    await createServerLifecycle().start(() => ({ close }));
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(operationBudget - 1);
    expect(process.exit).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(state.disconnectDb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HTTP_QUIESCE_MS + HTTP_DRAIN_MS);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_WATCHDOG_MS);
    expect(process.exit).toHaveBeenCalledOnce(); // watchdog was cleared

    expect(SHUTDOWN_WATCHDOG_MS).toBeGreaterThan(operationBudget + HTTP_QUIESCE_MS + HTTP_DRAIN_MS);
    expect(nativeGrace).toBeGreaterThanOrEqual(SHUTDOWN_WATCHDOG_MS + DRAIN_MS);
    expect(containerGrace).toBeGreaterThan(nativeGrace + DRAIN_MS);
  });

  it("still forces a nonzero exit when coordinator shutdown never settles", async () => {
    state.shutdownCoordinator.mockImplementation(() => new Promise(() => {}));
    await createServerLifecycle().start(() => ({ close: vi.fn() }));
    listeners.get("SIGTERM")?.();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_WATCHDOG_MS - 1);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(state.disconnectDb).not.toHaveBeenCalled();
  });

  it("owns signals before listen, never starts a consumer, and rejects re-entry", async () => {
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    expect(listeners.has("SIGTERM")).toBe(true);
    await lifecycle.start(listen);
    expect(state.fence).toHaveBeenCalledOnce();
    expect(state.volumes).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
    await expect(lifecycle.start(listen)).rejects.toThrow("already started");
  });

  it("starts the index reader before admission and fails startup when its probe fails", async () => {
    await createServerLifecycle().start(() => {
      state.events.push("listen");
      return { close: (done) => done() };
    });
    expect(state.events.indexOf("index-reader-started")).toBeGreaterThanOrEqual(0);
    expect(state.events.indexOf("index-reader-started")).toBeLessThan(
      state.events.indexOf("kb-runtime-configured"),
    );
    expect(state.events.indexOf("index-reader-started")).toBeLessThan(
      state.events.indexOf("listen"),
    );
    state.readerStart.mockRejectedValue(new Error("KB index reader probe failed: vec"));
    const listen = vi.fn();
    await createServerLifecycle().start(listen);
    expect(listen).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    [
      "data-root",
      () =>
        state.volumes.mockImplementation(() => {
          throw new Error("relative secret-path");
        }),
    ],
    ["index-reader", () => state.readerStart.mockRejectedValue(new Error("SQLite secret-path"))],
  ])("identifies a failed %s prerequisite without printing exception text", async (stage, fail) => {
    const log = captureLog();
    try {
      fail();
      await createServerLifecycle().start(vi.fn());
      expect(log.records).toContainEqual(
        expect.objectContaining({
          site: "server.startup",
          level: "error",
          stage,
          errorClass: "Error",
        }),
      );
      expect(JSON.stringify(log.records)).not.toContain("secret-path");
    } finally {
      log.restore();
    }
  });

  it("refuses to start on an unsupported git before any startup work", async () => {
    state.git.mockRejectedValue(new Error("Installed git version 2.39.5 is too old"));
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    await createServerLifecycle().start(listen);
    expect(listen).not.toHaveBeenCalled();
    expect(state.fence).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("fails startup when the process fence is unavailable", async () => {
    state.fence.mockRejectedValue(new Error("Process fence is unavailable"));
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    await createServerLifecycle().start(listen);
    expect(listen).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("retries a Postgres that is still booting before the maintenance participant connects", async () => {
    const booting = Object.assign(new Error("the database system is starting up"), {
      code: "57P03",
    });
    state.postgres
      .mockRejectedValueOnce(booting)
      .mockRejectedValueOnce(booting)
      .mockImplementation(async () => {
        state.events.push("postgres-ready");
        return 1;
      });
    const log = captureLog();
    try {
      const starting = createServerLifecycle().start(() => {
        state.events.push("listen");
        return { close: (done) => done() };
      });
      await vi.advanceTimersByTimeAsync(1500);
      await starting;
      expect(state.postgres).toHaveBeenCalledTimes(3);
      expect(state.events.indexOf("postgres-ready")).toBeLessThan(
        state.events.indexOf("maintenance"),
      );
      expect(state.events).toContain("listen");
      expect(process.exit).not.toHaveBeenCalled();
      expect(
        log.records.filter((record) => record.site === "server.dependency-retry"),
      ).toHaveLength(2);
      expect(log.records.some((record) => record.site === "server.startup")).toBe(false);
    } finally {
      log.restore();
    }
  });

  it.each(["SIGTERM", "SIGINT", "unhandledRejection"])(
    "%s during dependency ping stops admission and skips the listener",
    async (event) => {
      let finish: (() => void) | undefined;
      state.postgres.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const lifecycle = createServerLifecycle();
      const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
      const starting = lifecycle.start(listen);
      listeners.get(event)?.(new Error("fatal"));
      expect(lifecycle.isShuttingDown()).toBe(true);
      expect(listen).not.toHaveBeenCalled();
      finish?.();
      await starting;
      expect(process.exit).toHaveBeenCalledWith(event.startsWith("SIG") ? 0 : 1);
      await expect(lifecycle.start(listen)).rejects.toThrow("already started");
    },
  );

  it("drains HTTP, preserves a fatal exit arriving during a signal drain", async () => {
    vi.useFakeTimers();
    const close = vi.fn((done: () => void) => {
      state.events.push("http-drained");
      done();
    });
    const closeIdleConnections = vi.fn(() => {
      state.events.push("idle-connections-closed");
    });
    const lifecycle = createServerLifecycle();
    await lifecycle.start(() => ({ close, closeIdleConnections }));
    listeners.get("SIGTERM")?.();
    listeners.get("unhandledRejection")?.(new Error("fatal while draining"));
    expect(lifecycle.isShuttingDown()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.events.indexOf("coordinator-started")).toBeGreaterThanOrEqual(0);
    expect(state.events.indexOf("coordinator-shutdown")).toBeGreaterThan(
      state.events.indexOf("coordinator-started"),
    );
    expect(state.events.indexOf("admission-closed")).toBeGreaterThan(
      state.events.indexOf("coordinator-shutdown"),
    );
    expect(closeIdleConnections).toHaveBeenCalledOnce();
    expect(state.events.indexOf("idle-connections-closed")).toBeLessThan(
      state.events.indexOf("http-drained"),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(state.disconnectDb).toHaveBeenCalledOnce();
    expect(state.events.indexOf("http-drained")).toBeLessThan(
      state.events.indexOf("db-disconnect"),
    );
    // Reader threads terminate only after in-flight requests drained.
    expect(state.events.indexOf("index-reader-stopped")).toBeGreaterThan(
      state.events.indexOf("http-drained"),
    );
    expect(state.events.indexOf("index-reader-stopped")).toBeLessThan(
      state.events.indexOf("db-disconnect"),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("cancels pending dependency startup without creating a listener", async () => {
    let finish: (() => void) | undefined;
    state.postgres.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const lifecycle = createServerLifecycle();
    const listen = vi.fn(() => ({ close: vi.fn(), closeIdleConnections: vi.fn() }));
    const starting = lifecycle.start(listen);
    listeners.get("SIGINT")?.();
    finish?.();
    await starting;
    expect(listen).not.toHaveBeenCalled();
  });

  it("the real entrypoint never imports the worker and uses enumerated consumer health", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const lifecycle = readFileSync(new URL("./lifecycle.ts", import.meta.url), "utf8");
    // The entrypoint hands its admission closers to the lifecycle so shutdown
    // closes Git and bearer admission before draining.
    expect(source).toContain("const lifecycle = createServerLifecycle({");
    expect(source).toContain("closeGitAdmission: () => gitHttp.close()");
    expect(source).toContain("closeBearerAdmission: () =>");
    expect(source).toContain("await lifecycle.start((onListening) =>");
    expect(source).toContain("lifecycle.isShuttingDown()");
    expect(source).toContain("hasExternalConsumer(redisConnection, Object.values(QUEUE_NAMES))");
    expect(source).not.toContain("startWorkerRuntime(");
    expect(source).not.toContain("isWorkerReady");
    expect(lifecycle).toContain("pingProcessFence");
    expect(lifecycle).toContain("closeAdmission");
    expect(lifecycle).toContain("startKbWriteCoordinator");
    expect(lifecycle).toContain("shutdownKbWriteCoordinator");
    expect(lifecycle).not.toContain("worker/runtime");
    expect(lifecycle).not.toContain("startWorkerRuntime");
  });
});
