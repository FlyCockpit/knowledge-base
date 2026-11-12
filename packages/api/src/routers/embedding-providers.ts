import { env } from "@knowledge-base/env/shared";
import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { fromAdmissionError, KbDomainError } from "../lib/kb/errors";
import { providerSummarySchema } from "../lib/kb/protocol/common";
import {
  createProvider,
  listMyProviders,
  listSystemProviders,
  probeProvider,
  providerCreateInput,
  providerProbeInput,
  providerRevokeInput,
  revokeProvider,
} from "../lib/kb/providers";
import { getKbRuntime } from "../lib/kb/runtime";
import { cursorPageInput } from "../lib/pagination";

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const domain = error instanceof KbDomainError ? error : fromAdmissionError(error);
    const codes: Record<string, string> = {
      INVALID_ARGUMENT: "BAD_REQUEST",
      NOT_FOUND: "NOT_FOUND",
      FORBIDDEN: "FORBIDDEN",
      IDEMPOTENCY_MISMATCH: "CONFLICT",
      QUOTA_EXCEEDED: "TOO_MANY_REQUESTS",
      RATE_LIMITED: "TOO_MANY_REQUESTS",
    };
    throw new ORPCError(
      domain ? (codes[domain.code] ?? "INTERNAL_SERVER_ERROR") : "INTERNAL_SERVER_ERROR",
      { message: "Provider operation unavailable" },
    );
  }
}

export const embeddingProvidersRouter = {
  create: protectedProcedure
    .input(providerCreateInput)
    .handler(({ context, input }) =>
      safe(() =>
        createProvider(getKbRuntime(), context.session.user.id, input, env.KB_MASTER_KEY?.reveal()),
      ),
    ),
  probe: protectedProcedure
    .input(providerProbeInput)
    .handler(({ context, input }) =>
      safe(() =>
        probeProvider(getKbRuntime(), context.session.user.id, input, env.KB_MASTER_KEY?.reveal()),
      ),
    ),
  listMine: protectedProcedure
    .input(cursorPageInput)
    .handler(({ context, input }) =>
      safe(() => listMyProviders(getKbRuntime(), context.session.user.id, input)),
    ),
  /** Built-in providers (READY active model) any signed-in user may attach to a KB they manage. */
  listSystem: protectedProcedure.handler(async ({ context }) => {
    const { items } = await safe(() =>
      listSystemProviders(getKbRuntime(), context.session.user.id),
    );
    return {
      items: items.map(
        ({ providerId, revision, kind, name, model, dimensions, contextTokens, status }) =>
          providerSummarySchema.parse({
            providerId,
            revision,
            kind,
            name,
            model,
            dimensions,
            contextTokens,
            status,
          }),
      ),
    };
  }),
  revoke: protectedProcedure
    .input(providerRevokeInput)
    .handler(({ context, input }) =>
      safe(() => revokeProvider(getKbRuntime(), context.session.user.id, input)),
    ),
};
