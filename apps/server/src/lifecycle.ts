import { createAssetStorageLifecycle } from "@knowledge-base/api/lib/kb/asset-storage-lifecycle";
import {
  admitAssetStorage,
  assetStorageSelection,
} from "@knowledge-base/api/lib/kb/asset-storage-mode";
import { startExportLifecycle } from "@knowledge-base/api/lib/kb/exports";
import { assertSupportedGit, parseGitVersion } from "@knowledge-base/api/lib/kb/git-version";
import { MUTATION_DEADLINE_MS } from "@knowledge-base/api/lib/kb/lock";
import { startMaintenanceParticipant } from "@knowledge-base/api/lib/kb/maintenance";
import { recoverPushSpools } from "@knowledge-base/api/lib/kb/push-spool";
import {
  runStartupJournalRecovery,
  startJournalRecoverySweep,
} from "@knowledge-base/api/lib/kb/recovery";
import { getKbRuntime } from "@knowledge-base/api/lib/kb/runtime";
import prisma from "@knowledge-base/db";
import {
  type InstanceHeartbeat,
  startInstanceHeartbeat,
} from "@knowledge-base/db/instance-heartbeat";
import {
  logEvent,
  logInternalError,
  logStartupFailure,
  type StartupStage,
} from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/server";
import { assertLocalKbDataRoot, kbDataPaths } from "@knowledge-base/env/topology";
import { redisConnection } from "@knowledge-base/queue";
import { assertProcessFence, closeAdmission, DRAIN_MS, pingProcessFence } from "./kb-process.js";
import { configureServerIndexReader, configureServerKbRuntime } from "./kb-runtime.js";
import { startKbStagingCleanup } from "./kb-staging-cleanup.js";
import {
  closeKbWriteAdmission,
  shutdownKbWriteCoordinator,
  startKbWriteCoordinator,
} from "./kb-write-coordinator.js";

export const HTTP_QUIESCE_MS = 5_000;
export const HTTP_DRAIN_MS = 10_000;
export const SHUTDOWN_WATCHDOG_MS =
  Math.max(MUTATION_DEADLINE_MS, 60_000) + DRAIN_MS + HTTP_QUIESCE_MS + HTTP_DRAIN_MS + 5_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The HTTP host owns signals before dependency startup. It never starts job consumers. */
export function createServerLifecycle(
  options: {
    closeBearerAdmission?: () => Promise<void>;
    closeGitAdmission?: () => Promise<void>;
  } = {},
) {
  const startup = new AbortController();
  const assetStorage = createAssetStorageLifecycle("SERVER", startup.signal);
  // closeIdleConnections exists on plain HTTP servers (Node >= 18.2); hono's
  // serve() return union also admits Http2 servers, which lack it — hence optional.
  let server:
    | { close(callback: (error?: Error) => void): unknown; closeIdleConnections?(): void }
    | undefined;
  let closing: Promise<void> | undefined;
  let claimed = false;
  let exitCode = 0;
  let exportLifecycle: { stop(): Promise<void> } | undefined;
  let recoverySweep: { stop(): void } | undefined;
  let maintenance: Awaited<ReturnType<typeof startMaintenanceParticipant>> | undefined;
  let stagingCleanup: { stop(): Promise<void> } | undefined;
  let instanceHeartbeat: InstanceHeartbeat | undefined;
  let indexReader: { stop(): Promise<void> } | undefined;

  function requireRunning() {
    if (startup.signal.aborted) throw new Error("Server startup cancelled.");
  }
  async function waitForDependency(name: string, ping: () => Promise<unknown>) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      requireRunning();
      try {
        await withTimeout(ping(), 5000, `${name} startup ping`);
        requireRunning();
        logEvent("server.dependency-ready", { dependency: name });
        return;
      } catch (error) {
        requireRunning();
        if (attempt === 5) throw error;
        const delay = 500 * 2 ** (attempt - 1);
        logEvent("server.dependency-retry", { dependency: name, attempt, delayMs: delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  function shutdown(reason: string, code = 0): Promise<void> {
    if (code) exitCode = code;
    if (closing) return closing;
    const watchdog = setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_WATCHDOG_MS);
    startup.abort();
    instanceHeartbeat?.stop();
    closeKbWriteAdmission();
    // Close synchronously before any drain await. COMMITTING recovery still owns
    // its existing coordinator/native permits; it is not a new bearer admission.
    const gitDrain = withTimeout(
      options.closeGitAdmission?.() ?? Promise.resolve(),
      60_000 + DRAIN_MS,
      "Git publication drain",
    );
    void gitDrain.catch(() => {});
    const bearerDrain = options.closeBearerAdmission?.() ?? Promise.resolve();
    const boundedBearerDrain = withTimeout(bearerDrain, HTTP_DRAIN_MS, "Bearer admission drain");
    // Observe immediately while coordinator drain runs; failure remains fatal below.
    void boundedBearerDrain.catch(() => {});
    logEvent("server.shutdown-start", { signal: reason });
    closing = (async () => {
      await recoverySweep?.stop();
      await stagingCleanup?.stop();
      await exportLifecycle?.stop();
      await gitDrain;
      await shutdownKbWriteCoordinator();
      await closeAdmission();
      await boundedBearerDrain;
      if (server) {
        // /ready has already flipped to 503, allowing the proxy to stop routing.
        await new Promise((resolve) => setTimeout(resolve, HTTP_QUIESCE_MS));
        // close() also waits on idle keep-alive sockets; release them now so only
        // in-flight requests hold the drain.
        server.closeIdleConnections?.();
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, HTTP_DRAIN_MS);
          server?.close((error) => {
            clearTimeout(timeout);
            if (error) logInternalError("server.shutdown", error, { stage: "http-close" });
            resolve();
          });
        });
      }
      // In-flight index reads settled with the HTTP drain; terminate the reader threads.
      await indexReader?.stop();
      await assetStorage.stop();
      await prisma.$disconnect();
      redisConnection.disconnect();
      await maintenance?.release();
      clearTimeout(watchdog);
      process.exit(exitCode);
    })().catch((error: unknown) => {
      logInternalError("server.shutdown", error);
      process.exit(1);
    });
    return closing;
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (error) => {
    logInternalError("server.unhandled-rejection", error);
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (error) => {
    // An unwound stack may leave shared state inconsistent; don't run a drain.
    logInternalError("server.uncaught-exception", error);
    instanceHeartbeat?.stop();
    process.exit(1);
  });
  return {
    isShuttingDown: () => startup.signal.aborted,
    async start(listen: (onListening: () => void) => NonNullable<typeof server>) {
      if (claimed) throw new Error("Server already started; restart the process to re-enter.");
      claimed = true;
      const { reposDir, assetsDir } = kbDataPaths(env.KB_DATA_ROOT);
      // Typed startup stage for the failure record.
      let stage: StartupStage = "config";
      try {
        // PR merges and conflict checks need git >= 2.45 (R3-W1): refuse an older one here.
        stage = "git";
        logEvent("server.git", {
          gitVersion: parseGitVersion(await assertSupportedGit({ signal: startup.signal }))?.join(
            ".",
          ),
        });
        // The maintenance participant is the first Postgres connection: a
        // database that is still booting gets the readiness retries first,
        // instead of failing startup at the maintenance stage.
        stage = "postgres";
        await waitForDependency("Postgres", () => prisma.$queryRaw`SELECT 1`);
        stage = "maintenance";
        maintenance = await startMaintenanceParticipant(
          env.DATABASE_URL.reveal(),
          () => {
            void shutdown("maintenance");
          },
          () =>
            runStartupJournalRecovery(
              prisma,
              reposDir,
              assetsDir,
              env.DATABASE_URL.reveal(),
              assertProcessFence,
            ),
          () => assetStorage.stop(),
          (query) =>
            admitAssetStorage({
              query,
              selection: assetStorageSelection(env),
              assetsDir,
              role: "SERVER",
              signal: startup.signal,
              assertServerFence: assertProcessFence,
            }),
        );
        requireRunning();
        instanceHeartbeat = startInstanceHeartbeat({ role: "server" });
        stage = "process-fence";
        await pingProcessFence();
        stage = "data-root";
        assertLocalKbDataRoot(env.KB_DATA_ROOT);
        // The supervisor owns the exclusive server fence; no HTTP uploads exist
        // yet, so every generated Git spool left by a predecessor is abandoned.
        stage = "push-spools";
        await recoverPushSpools(reposDir, assertProcessFence);
        requireRunning();
        stage = "redis";
        await waitForDependency("Redis", () => redisConnection.ping());
        stage = "journal-recovery";
        await runStartupJournalRecovery(
          prisma,
          reposDir,
          assetsDir,
          env.DATABASE_URL.reveal(),
          assertProcessFence,
        );
        recoverySweep = startJournalRecoverySweep(
          prisma,
          reposDir,
          assetsDir,
          env.DATABASE_URL.reveal(),
          assertProcessFence,
          () => assetStorage.recover(),
        );
        // Query data past its 5-minute deadline is scrubbed before admission opens.
        stage = "staging-cleanup";
        stagingCleanup = await startKbStagingCleanup({
          connectionString: env.DATABASE_URL.reveal(),
          assertFence: assertProcessFence,
        });
        stage = "write-coordinator";
        startKbWriteCoordinator({ connectionString: env.DATABASE_URL.reveal() });
        stage = "index-reader";
        const reader = configureServerIndexReader();
        indexReader = reader;
        // Each reader thread opens a probe index file before admission (sqlite-vec, FTS5,
        // hamming, a refused write); a failure fails startup.
        await reader.start();
        requireRunning();
        stage = "kb-runtime";
        await configureServerKbRuntime(assetStorage);
        stage = "exports";
        exportLifecycle = await startExportLifecycle(getKbRuntime());
        requireRunning();
        stage = "listen";
        server = listen(() => {
          if (!startup.signal.aborted) instanceHeartbeat?.markReady();
        });
      } catch (error) {
        logStartupFailure("server", error, stage);
        await shutdown("startup failure", startup.signal.aborted ? 0 : 1);
      }
    },
  };
}
