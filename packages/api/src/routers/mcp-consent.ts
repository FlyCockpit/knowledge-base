import { canonicalMcpResource } from "@knowledge-base/auth/mcp-config";
import {
  consentApprovalInput,
  createMcpConsentService,
  McpConsentError,
  McpSealedConsentError,
} from "@knowledge-base/auth/mcp-consent";
import { env } from "@knowledge-base/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { getKbRuntime } from "../lib/kb/runtime";

function service() {
  const runtime = getKbRuntime();
  return createMcpConsentService({
    db: runtime.prisma,
    secret: env.BETTER_AUTH_SECRET.reveal(),
    resource: canonicalMcpResource(runtime.canonicalOrigin),
  });
}
async function consentControl<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Typed and user-visible, so the consent page can explain it.
    if (error instanceof McpSealedConsentError)
      throw new ORPCError("BAD_REQUEST", {
        message: error.message,
        data: { reason: error.code },
      });
    throw new ORPCError(
      error instanceof McpConsentError || error instanceof z.ZodError
        ? "BAD_REQUEST"
        : "INTERNAL_SERVER_ERROR",
    );
  }
}
/**
 * Cookie session + 2FA only. Client/redirect/resource always come from signed query.
 * `prepare` returns the durable intent plus the server-validated review projection
 * the consent page renders; nothing on the page is taken from unsigned URL state.
 */
export const mcpConsentRouter = {
  prepare: protectedProcedure
    .input(z.strictObject({ oauthQuery: z.string().min(1).max(16384) }))
    .handler(({ context, input }) =>
      consentControl(() =>
        service().review(
          { userId: context.session.user.id, sessionId: context.session.session.id },
          input.oauthQuery,
        ),
      ),
    ),
  approve: protectedProcedure
    .input(consentApprovalInput)
    .handler(({ context, input }) =>
      consentControl(() =>
        service().approve(
          { userId: context.session.user.id, sessionId: context.session.session.id },
          input,
        ),
      ),
    ),
};
