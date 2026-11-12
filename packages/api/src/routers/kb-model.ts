import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { adminOr404Procedure } from "../index";
import {
  countBuiltinAttachedKbs,
  disableLocalModel,
  enableLocalModel,
  getLocalModelStatus,
  localModelStatusSchema,
  ModelConfigError,
  removeLocalModelFiles,
  setLocalModelRuntimeConfig,
  setModelRuntimeConfigInputSchema,
} from "../lib/kb/local-model";
import { getKbRuntime } from "../lib/kb/runtime";

/** Config-gate refusals are the admin's to act on; everything else stays generic. */
const CONFIG_ERRORS = {
  MODEL_CONFIG_INVALID: {
    status: "BAD_REQUEST",
    message: "Unsupported built-in model configuration.",
  },
  MODEL_CONFIG_MEMORY_BLOCKED: {
    status: "BAD_REQUEST",
    message: "The estimated memory is at or above 90% of the worker's memory budget.",
  },
  MODEL_CONFIG_NEEDS_ACKNOWLEDGEMENT: {
    status: "PRECONDITION_FAILED",
    message:
      "The estimated memory exceeds 70% of the worker's memory budget; acknowledge to apply.",
  },
  MODEL_MEMORY_BUDGET_UNKNOWN: {
    status: "PRECONDITION_FAILED",
    message: "No worker has reported its memory budget yet.",
  },
  MODEL_REMOVE_REQUIRES_DISABLED: {
    status: "PRECONDITION_FAILED",
    message: "Disable the built-in model before removing its downloaded weights.",
  },
} as const;

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ModelConfigError) {
      const mapped = CONFIG_ERRORS[error.code];
      throw new ORPCError(mapped.status, { message: mapped.message, data: { code: error.code } });
    }
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Model operation unavailable" });
  }
}

function modelRuntime() {
  const { prisma, connectionString } = getKbRuntime();
  return { prisma, connectionString };
}

/**
 * Instance-admin controls for the built-in local embedding model. The artifact,
 * URL and digest are server constants (no input selects them). Status is read
 * from the DB (the server never mounts the model volume) and parsed through the
 * public projection so nothing else serializes. The runtime config (context and
 * K/V cache types) is gated here against the worker-reported memory
 * budget: >= 90% is rejected, > 70% needs `acknowledgeMemoryWarning`.
 */
export const kbModelRouter = {
  status: adminOr404Procedure.handler(async () =>
    localModelStatusSchema.parse(await safe(() => getLocalModelStatus(modelRuntime().prisma))),
  ),
  /** The live KBs a disable or a runtime change affects (their confirmations say how many). */
  attachedKnowledgeBases: adminOr404Procedure.handler(async () => ({
    count: await safe(() => countBuiltinAttachedKbs(modelRuntime().prisma)),
  })),
  enable: adminOr404Procedure
    .input(z.strictObject({ acknowledgeMemoryWarning: z.boolean().optional() }).optional())
    .handler(async ({ context, input }) =>
      localModelStatusSchema.parse(
        await safe(() =>
          enableLocalModel(modelRuntime(), { userId: context.session.user.id }, input),
        ),
      ),
    ),
  disable: adminOr404Procedure.handler(async ({ context }) =>
    localModelStatusSchema.parse(
      await safe(() => disableLocalModel(modelRuntime(), { userId: context.session.user.id })),
    ),
  ),
  /** Delete the downloaded weights of a disabled model (Disable keeps them). */
  remove: adminOr404Procedure
    .input(z.strictObject({ confirm: z.literal("REMOVE") }))
    .handler(async ({ context }) =>
      localModelStatusSchema.parse(
        await safe(() =>
          removeLocalModelFiles(modelRuntime(), { userId: context.session.user.id }),
        ),
      ),
    ),
  setRuntimeConfig: adminOr404Procedure
    .input(setModelRuntimeConfigInputSchema)
    .handler(async ({ context, input }) =>
      localModelStatusSchema.parse(
        await safe(async () => {
          const runtime = modelRuntime();
          await setLocalModelRuntimeConfig(runtime, input, { userId: context.session.user.id });
          return getLocalModelStatus(runtime.prisma);
        }),
      ),
    ),
};
