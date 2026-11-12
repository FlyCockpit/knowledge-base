import { logInternalError } from "@knowledge-base/env/log";
import { redisConnection } from "@knowledge-base/queue";
import { ORPCError } from "@orpc/server";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";

export type ProcedureBudgetOptions = {
  /** Distinct `keyPrefix` is what makes this budget independent of others. */
  keyPrefix: string;
  points: number;
  durationSeconds: number;
  /**
   * Fail-closed refuses the procedure when Redis is unreachable.
   * Fail-open logs and lets the call through — only for surfaces where a
   * ten-minute outage must not take the site down, and never for spend,
   * mail, or unbounded writes.
   */
  failClosed: boolean;
  overBudgetMessage: (retryAfterSeconds: number) => string;
  unavailableMessage: string;
  unavailableLog: string;
};

/**
 * Procedure-layer rate budget. Use this for oRPC procedures that spend,
 * send mail, or write rows — a batched `/rpc/<prefix>/__batch__` POST is
 * one HTTP request, so the Hono `/rpc/*` limiter cannot see per-procedure
 * cost.
 *
 * Built on first consume, not at module load, so importing the router
 * graph in unit tests does not construct a Redis-backed limiter.
 */
export function createProcedureBudget(
  options: ProcedureBudgetOptions,
): (key: string) => Promise<void> {
  let limiter: RateLimiterRedis | undefined;
  const getLimiter = (): RateLimiterRedis => {
    limiter ??= new RateLimiterRedis({
      storeClient: redisConnection,
      keyPrefix: options.keyPrefix,
      points: options.points,
      duration: options.durationSeconds,
      inMemoryBlockOnConsumed: options.points + 1,
      inMemoryBlockDuration: options.durationSeconds,
    });
    return limiter;
  };

  return async (key: string): Promise<void> => {
    try {
      await getLimiter().consume(key);
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        const retryAfterSeconds = Math.ceil(error.msBeforeNext / 1000);
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: options.overBudgetMessage(retryAfterSeconds),
          data: { retryAfterSeconds },
        });
      }
      if (options.failClosed) {
        logInternalError("rate-limit.procedure-budget", error, {
          limiter: options.keyPrefix,
          mode: "fail-closed",
        });
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: options.unavailableMessage,
        });
      }
      logInternalError("rate-limit.procedure-budget.open", error, {
        limiter: options.keyPrefix,
        mode: "fail-open",
      });
    }
  };
}
