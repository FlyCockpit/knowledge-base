import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { KbDomainError } from "../lib/kb/errors";
import { getKbRuntime } from "../lib/kb/runtime";
import {
  listPersonalTokens,
  mintPersonalToken,
  pageInput,
  patMintInput,
  revokePersonalToken,
} from "../lib/mcp-token-access";

const ORPC_CODES: Record<string, string> = {
  INVALID_ARGUMENT: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  QUOTA_EXCEEDED: "CONFLICT",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
};

/** Map control-plane failures to fixed messages; never forward internal detail. */
export async function mcpControl<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = error instanceof KbDomainError ? ORPC_CODES[error.code] : undefined;
    throw new ORPCError(code ?? "INTERNAL_SERVER_ERROR", {
      message: "Credential operation unavailable",
    });
  }
}

/**
 * Human personal-access-token management. Browser session + satisfied 2FA
 * only (protectedProcedure); a PAT is never an oRPC session, so a token can
 * never mint, list, or revoke credentials. Never exposed as MCP tools.
 */
export const mcpTokensRouter = {
  create: protectedProcedure
    .input(patMintInput)
    .handler(({ context, input }) =>
      mcpControl(() => mintPersonalToken(getKbRuntime(), context.session.user.id, input)),
    ),
  listMine: protectedProcedure
    .input(pageInput)
    .handler(({ context, input }) =>
      mcpControl(() => listPersonalTokens(getKbRuntime(), context.session.user.id, input)),
    ),
  revokeMine: protectedProcedure
    .input(z.strictObject({ id: z.string().min(1).max(64) }))
    .handler(({ context, input }) =>
      mcpControl(() => revokePersonalToken(getKbRuntime(), context.session.user.id, input.id)),
    ),
};
