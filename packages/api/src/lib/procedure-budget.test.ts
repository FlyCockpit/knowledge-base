import { captureLog } from "@knowledge-base/env/log";
import type { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/queue", () => ({ redisConnection: {} }));

const consume = vi.fn();
const limiterOptions: Array<Record<string, unknown>> = [];

vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const actual = await importOriginal<typeof import("rate-limiter-flexible")>();
  return {
    ...actual,
    RateLimiterRedis: class {
      constructor(options: Record<string, unknown>) {
        limiterOptions.push(options);
      }
      consume = consume;
    },
  };
});

const { RateLimiterRes } = await import("rate-limiter-flexible");
const { createProcedureBudget } = await import("./procedure-budget");

const code = (error: unknown) => (error as ORPCError<string, unknown>).code;

beforeEach(() => {
  consume.mockReset();
  consume.mockResolvedValue(undefined);
  limiterOptions.length = 0;
});

describe("createProcedureBudget", () => {
  it("keys on the caller-supplied key in its own bucket", async () => {
    const consumeBudget = createProcedureBudget({
      keyPrefix: "rl:test",
      points: 10,
      durationSeconds: 60,
      failClosed: true,
      overBudgetMessage: (s) => `wait ${s}`,
      unavailableMessage: "down",
      unavailableLog: "[test] down",
    });
    await consumeBudget("ip:1.1.1.1");
    expect(consume).toHaveBeenCalledWith("ip:1.1.1.1");
    expect(limiterOptions[0]).toMatchObject({ keyPrefix: "rl:test", points: 10 });
  });

  it("refuses over budget with a retry hint", async () => {
    const consumeBudget = createProcedureBudget({
      keyPrefix: "rl:test",
      points: 10,
      durationSeconds: 60,
      failClosed: true,
      overBudgetMessage: (s) => `wait ${s}`,
      unavailableMessage: "down",
      unavailableLog: "[test] down",
    });
    consume.mockRejectedValue(new RateLimiterRes(0, 5_000, 11, false));
    const error = await consumeBudget("anon:x").catch((caught: unknown) => caught);
    expect(code(error)).toBe("TOO_MANY_REQUESTS");
    expect((error as ORPCError<string, { retryAfterSeconds: number }>).data).toEqual({
      retryAfterSeconds: 5,
    });
  });

  it("fails closed when the store is unreachable", async () => {
    const consumeBudget = createProcedureBudget({
      keyPrefix: "rl:test",
      points: 10,
      durationSeconds: 60,
      failClosed: true,
      overBudgetMessage: (s) => `wait ${s}`,
      unavailableMessage: "down",
      unavailableLog: "[test] down",
    });
    const logged = captureLog();
    consume.mockRejectedValue(new Error("ECONNREFUSED"));
    const error = await consumeBudget("anon:x").catch((caught: unknown) => caught);
    expect(code(error)).toBe("SERVICE_UNAVAILABLE");
    logged.restore();
  });

  it("fails open when configured to, logging a warning", async () => {
    const consumeBudget = createProcedureBudget({
      keyPrefix: "rl:test",
      points: 10,
      durationSeconds: 60,
      failClosed: false,
      overBudgetMessage: (s) => `wait ${s}`,
      unavailableMessage: "down",
      unavailableLog: "[test] down",
    });
    const logged = captureLog();
    consume.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(consumeBudget("anon:x")).resolves.toBeUndefined();
    expect(logged.records.length).toBeGreaterThan(0);
    logged.restore();
  });
});
