import { logInternalError } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/shared";
import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { mapKbDomainError } from "../lib/kb/bases";
import { kbReadToolSchemas } from "../lib/kb/protocol/reads";
import { SensitiveQueryError } from "../lib/kb/redact-for-embed";
import { getKbRuntime } from "../lib/kb/runtime";
import { searchKnowledgeBase } from "../lib/kb/search";
import { structuredSearchKnowledgeBase } from "../lib/kb/structured-search";
import { createProcedureBudget } from "../lib/procedure-budget";

const ORPC_CODES: Record<string, string> = {
  INVALID_ARGUMENT: "BAD_REQUEST",
  INVALID_CURSOR: "BAD_REQUEST",
  SENSITIVE_QUERY: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  INDEX_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  STORAGE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  DEADLINE_EXCEEDED: "TIMEOUT",
};

const consumeSearchBudget = createProcedureBudget({
  keyPrefix: "rl:kb-search",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many search requests. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Search is temporarily unavailable. Please try again.",
  unavailableLog: "[kb] search limiter unavailable, failing closed:",
});

/** Fixed messages; the stable kb/1 code is the only detail a browser receives. */
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    const mapped = mapKbDomainError(error);
    if (!mapped && !(error instanceof SensitiveQueryError)) {
      logInternalError("kb.search", error, { stage: "router" });
    }
    const code = error instanceof SensitiveQueryError ? "SENSITIVE_QUERY" : mapped?.code;
    const data: { code: string; retryAfterSeconds?: number } = {
      code: code ?? "INTERNAL",
    };
    if (mapped?.retryAfterSeconds !== undefined) {
      data.retryAfterSeconds = mapped.retryAfterSeconds;
    }
    throw new ORPCError(ORPC_CODES[code ?? ""] ?? "INTERNAL_SERVER_ERROR", {
      message: "Search unavailable",
      data,
    });
  }
}

export const searchRouter = {
  hybrid: protectedProcedure
    .input(kbReadToolSchemas.knowledge_search.input)
    .handler(({ context, input, signal }) =>
      safe(async () => {
        await consumeSearchBudget(context.session.user.id);
        const runtime = getKbRuntime();
        return searchKnowledgeBase(
          {
            connectionString: runtime.connectionString,
            masterKey: env.KB_MASTER_KEY?.reveal(),
            ratePort: runtime.ratePort,
          },
          { principal: { kind: "browser", userId: context.session.user.id } },
          input,
          signal,
        );
      }),
    ),
  /** knowledge_structured_search: exact filters (with or without a query) and pinned pages. */
  structured: protectedProcedure
    .input(kbReadToolSchemas.knowledge_structured_search.input)
    .handler(({ context, input, signal }) =>
      safe(async () => {
        await consumeSearchBudget(context.session.user.id);
        const runtime = getKbRuntime();
        return structuredSearchKnowledgeBase(
          {
            connectionString: runtime.connectionString,
            masterKey: env.KB_MASTER_KEY?.reveal(),
            ratePort: runtime.ratePort,
            cursorSigner: runtime.cursorSigner,
          },
          { principal: { kind: "browser", userId: context.session.user.id } },
          input,
          signal,
        );
      }),
    ),
};
