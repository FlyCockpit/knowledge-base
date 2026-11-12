import { logInternalError } from "@knowledge-base/env/log";

/**
 * Every connection gets an error listener: without one ioredis prints the raw
 * error itself (stack and all). The record names the connection and the
 * error's class and code only (R3-W3).
 */
export function observeRedis<
  T extends { on(event: "error", listener: (error: unknown) => void): unknown },
>(connection: T, name: string): T {
  connection.on("error", (error) =>
    logInternalError("redis.connection", error, { connection: name }),
  );
  return connection;
}
