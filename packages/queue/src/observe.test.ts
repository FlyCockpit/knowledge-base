import { EventEmitter } from "node:events";
import { captureLog } from "@knowledge-base/env/log";
import { sharedVars } from "@knowledge-base/env/vars/shared";
import IORedis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { observeRedis } from "./observe";

const CANARY = "Zq7Kp2Xw9Lm4Rt8V";

describe("observeRedis", () => {
  it("turns connection errors into a fixed record and keeps the emitter from throwing", () => {
    const log = captureLog();
    try {
      const connection = observeRedis(new EventEmitter(), "shared");
      // Without a listener, emitting "error" would throw (and ioredis would print the stack).
      expect(() =>
        connection.emit(
          "error",
          Object.assign(new Error(`connect ECONNREFUSED redis://default:${CANARY}@redis:6379`), {
            code: "ECONNREFUSED",
          }),
        ),
      ).not.toThrow();
      expect(log.records).toEqual([
        {
          level: "warn",
          site: "redis.connection",
          message: "Redis connection error",
          errorClass: "Error",
          errorCode: "ECONNREFUSED",
          connection: "shared",
        },
      ]);
      expect(JSON.stringify(log.records)).not.toContain(CANARY);
    } finally {
      log.restore();
    }
  });

  it("covers the shared connection, worker connections and every queue", async () => {
    const { readFileSync } = await import("node:fs");
    const connection = readFileSync(new URL("./connection.ts", import.meta.url), "utf8");
    const queues = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(connection.match(/new IORedis\(/g)?.length).toBe(
      connection.match(/observeRedis\(/g)?.length,
    );
    expect(queues).toMatch(
      /for \(const \[name, queue\] of Object\.entries\(retentionQueues\)\) observeRedis\(/,
    );
  });
});

it("both connection factories leave readiness to our PING gates, never the library INFO console path", async () => {
  vi.doMock("@knowledge-base/env/shared", () => ({
    env: { REDIS_URL: { reveal: () => "redis://localhost:6379" } },
  }));
  const options: Array<{ enableReadyCheck: boolean }> = [];
  vi.doMock("ioredis", () => ({
    default: class extends EventEmitter {
      constructor(_url: string, opts: { enableReadyCheck: boolean }) {
        super();
        options.push(opts);
      }
    },
  }));
  try {
    const { createRedisConnection } = await import("./connection");
    createRedisConnection();
    expect(options).toHaveLength(2);
    expect(options.every((opts) => opts.enableReadyCheck === false)).toBe(true);
  } finally {
    vi.doUnmock("ioredis");
    vi.doUnmock("@knowledge-base/env/shared");
  }
});

it("lets the Redis driver resolve an empty authority and database number", () => {
  const redis = new IORedis(sharedVars.REDIS_URL.parse("redis:///3").reveal(), {
    lazyConnect: true,
  });
  try {
    expect(redis.options.db).toBe(3);
    expect(redis.options.host).toBe("localhost");
  } finally {
    redis.disconnect();
  }
});
