import { initializeConnection } from "@knowledge-base/env/connection-config";
import { env } from "@knowledge-base/env/shared";
import IORedis from "ioredis";
import { observeRedis } from "./observe.js";

/**
 * Shared Redis connection for queue producers (adding jobs).
 * Workers should create their own connection with `maxRetriesPerRequest: null`.
 */
export const redisConnection = observeRedis(
  initializeConnection(
    "REDIS_URL",
    () =>
      new IORedis(env.REDIS_URL.reveal(), {
        // Readiness belongs to the server/worker startup PING gates. ioredis INFO
        // skips readiness on NOPERM and prints its raw diagnostic to console.
        enableReadyCheck: false,
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        commandTimeout: 5000,
      }),
  ),
  "shared",
);

/** Create a fresh IORedis connection from the env REDIS_URL. */
export function createRedisConnection(opts?: {
  maxRetriesPerRequest?: number | null;
  connectTimeout?: number;
  commandTimeout?: number;
}) {
  return observeRedis(
    initializeConnection(
      "REDIS_URL",
      () =>
        new IORedis(env.REDIS_URL.reveal(), {
          // Readiness belongs to the server/worker startup PING gates. ioredis INFO
          // skips readiness on NOPERM and prints its raw diagnostic to console.
          enableReadyCheck: false,
          maxRetriesPerRequest: opts?.maxRetriesPerRequest ?? null,
          connectTimeout: opts?.connectTimeout ?? 5000,
          commandTimeout: opts?.commandTimeout,
        }),
    ),
    "worker",
  );
}
