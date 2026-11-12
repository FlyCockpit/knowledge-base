import { ORPCError } from "@orpc/server";
import { liveAdminOr404Procedure, protectedProcedure } from "../index";
import { prismaAssetQuery } from "../lib/kb/asset-authz";
import { mapKbDomainError } from "../lib/kb/bases";
import { requestIndexBuild } from "../lib/kb/generations";
import {
  getIndexSettings,
  indexSettingsRefusal,
  readChunkCeilings,
  setChunkCeiling,
  setChunkCeilingInputSchema,
  setChunkLimitInputSchema,
  setIndexChunkLimit,
  setIndexQuantization,
  setQuantizationInputSchema,
} from "../lib/kb/index-settings";
import { getIndexProfile } from "../lib/kb/index-status";
import { kbReadToolSchemas } from "../lib/kb/protocol/reads";
import { kbWriteToolSchemas } from "../lib/kb/protocol/writes";
import { getKbRuntime } from "../lib/kb/runtime";

async function safe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const mapped = mapKbDomainError(error);
    // Index-settings refusals name their reason so the UI can localize it.
    const reason = indexSettingsRefusal(mapped);
    const codes: Record<string, string> = {
      NOT_FOUND: "NOT_FOUND",
      FORBIDDEN: "FORBIDDEN",
      INVALID_ARGUMENT: "BAD_REQUEST",
      IDEMPOTENCY_MISMATCH: "CONFLICT",
      CONFLICT: "CONFLICT",
      RATE_LIMITED: "TOO_MANY_REQUESTS",
    };
    throw new ORPCError(
      mapped ? (codes[mapped.code] ?? "INTERNAL_SERVER_ERROR") : "INTERNAL_SERVER_ERROR",
      { message: "Index operation unavailable", ...(reason ? { data: { reason } } : {}) },
    );
  }
}
export const kbIndexRouter = {
  status: protectedProcedure
    .input(kbReadToolSchemas.knowledge_index_status.input)
    .handler(({ context, input }) =>
      safe(
        async () =>
          (
            await getIndexProfile(
              getKbRuntime(),
              { principal: { kind: "browser", userId: context.session.user.id } },
              input.kbId,
            )
          ).index,
      ),
    ),
  profile: protectedProcedure
    .input(kbReadToolSchemas.knowledge_embedding_profile_get.input)
    .handler(({ context, input }) =>
      safe(() =>
        getIndexProfile(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session.user.id } },
          input.kbId,
        ),
      ),
    ),
  rebuild: protectedProcedure
    .input(kbWriteToolSchemas.knowledge_index_rebuild.input)
    .handler(({ context, input }) =>
      safe(() =>
        requestIndexBuild(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session.user.id } },
          input,
        ),
      ),
    ),
  setProfile: protectedProcedure
    .input(kbWriteToolSchemas.knowledge_embedding_profile_set.input)
    .handler(({ context, input }) =>
      safe(() =>
        requestIndexBuild(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session.user.id } },
          input,
        ),
      ),
    ),
  /** §1.9 index settings: web/oRPC only, never an MCP tool. */
  settings: protectedProcedure
    .input(kbReadToolSchemas.knowledge_index_status.input)
    .handler(({ context, input }) =>
      safe(() =>
        getIndexSettings(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session.user.id } },
          input.kbId,
        ),
      ),
    ),
  setQuantization: protectedProcedure
    .input(setQuantizationInputSchema)
    .handler(({ context, input }) =>
      safe(() =>
        setIndexQuantization(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session.user.id } },
          input,
        ),
      ),
    ),
  setChunkLimit: protectedProcedure
    .input(setChunkLimitInputSchema)
    .handler(({ context, input }) =>
      safe(() =>
        setIndexChunkLimit(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session.user.id } },
          input,
        ),
      ),
    ),
  chunkCeiling: liveAdminOr404Procedure.handler(({ context }) =>
    safe(() => readChunkCeilings(prismaAssetQuery(context.authorityTx))),
  ),
  setChunkCeiling: liveAdminOr404Procedure
    .input(setChunkCeilingInputSchema)
    .handler(({ context, input }) =>
      safe(() =>
        setChunkCeiling(
          prismaAssetQuery(context.authorityTx),
          { userId: context.session.user.id },
          input,
        ),
      ),
    ),
};
