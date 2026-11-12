// Process entrypoint: runtime itself never loads files or owns process teardown.
import "@knowledge-base/env/load-dotenv";

import { createServer } from "node:http";
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
import { env } from "@knowledge-base/env/shared";
import { redisConnection } from "@knowledge-base/queue";
import { sendOperationalFailureAlert } from "./operational-alerts.js";
import { startWorkerRuntime, WorkerDrainError, type WorkerRuntime } from "./runtime.js";
import { workerDrainMs } from "./runtime-lifecycle.js";

let instanceHeartbeat: InstanceHeartbeat | undefined;
let runtime: WorkerRuntime | undefined;
let starting: Promise<WorkerRuntime> | undefined;
let closing = false;
let exitCode = 0;
const startup = new AbortController();
let startupStage: StartupStage = "config";
// Loopback only: no public unauthenticated operational surface.
const health = createServer((_request, response) => {
  response.writeHead(!closing && runtime?.isReady() ? 200 : 503);
  response.end();
});
async function shutdown(reason: string, code = 0) {
  if (code) exitCode = code;
  if (closing) return;
  closing = true;
  instanceHeartbeat?.stop();
  // Best effort only: dependency failure must never delay the process watchdog.
  if (code)
    void sendOperationalFailureAlert({ queue: "worker", jobId: reason, message: reason }).catch(
      () => {},
    );
  setTimeout(() => process.exit(1), workerDrainMs(reason === "maintenance") + 5000);
  startup.abort();
  logEvent("worker.shutdown-start", { signal: reason });
  health.close();
  try {
    const active =
      runtime ??
      (await starting?.catch((error: unknown) => {
        if (error instanceof WorkerDrainError) throw error;
        return undefined;
      }));
    await active?.stop();
  } catch (error) {
    logInternalError("worker.drain", error);
    process.exit(1);
    return;
  }
  await prisma.$disconnect();
  redisConnection.disconnect();
  process.exit(exitCode);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  logInternalError("worker.unhandled-rejection", error);
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  logInternalError("worker.uncaught-exception", error);
  instanceHeartbeat?.stop();
  process.exit(1);
});
try {
  starting = startWorkerRuntime({
    signal: startup.signal,
    onStartupStage: (stage) => {
      startupStage = stage;
    },
    onMaintenance: () => void shutdown("maintenance"),
    onMaintenanceAdmitted: () => {
      if (!closing) instanceHeartbeat = startInstanceHeartbeat({ role: "worker" });
    },
    onFatal: (error) => {
      logInternalError("worker.consumer", error);
      void shutdown("consumer failure", 1);
    },
  });
  runtime = await starting;
  if (!closing && runtime.isReady()) instanceHeartbeat?.markReady();
  startupStage = "listen";
  health.on("error", (error) => {
    logInternalError("worker.health", error);
    void shutdown("health listener failure", 1);
  });
  // Local dev's Vite server owns port 3001. Docker production workers live in
  // a separate container and are the only callers of this image health probe.
  if (!closing && env.NODE_ENV === "production") health.listen(3001, "127.0.0.1");
} catch (error) {
  logStartupFailure("worker", error, startupStage);
  void shutdown("startup failure", startup.signal.aborted ? 0 : 1);
}
