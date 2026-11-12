import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { listAssets, mutateAsset } from "../lib/kb/assets";
import { mapKbDomainError } from "../lib/kb/bases";
import { kbReadToolSchemas } from "../lib/kb/protocol/reads";
import { kbWriteToolSchemas } from "../lib/kb/protocol/writes";
import { getKbRuntime } from "../lib/kb/runtime";
import { createProcedureBudget } from "../lib/procedure-budget";

const budget = createProcedureBudget({
  keyPrefix: "rl:kb-assets",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Too many asset requests.",
  unavailableMessage: "Asset requests unavailable.",
  unavailableLog: "[kb] asset limiter unavailable",
});
async function run<T>(userId: string, work: () => Promise<T>): Promise<T> {
  try {
    await budget(userId);
    return await work();
  } catch (error) {
    const mapped = mapKbDomainError(error);
    if (!mapped) throw error;
    const code =
      mapped.code === "NOT_FOUND"
        ? "NOT_FOUND"
        : mapped.code === "FORBIDDEN"
          ? "FORBIDDEN"
          : ["CONFLICT", "IDEMPOTENCY_MISMATCH"].includes(mapped.code)
            ? "CONFLICT"
            : [
                  "INVALID_ARGUMENT",
                  "INVALID_CURSOR",
                  "UPLOAD_INCOMPLETE",
                  "UPLOAD_EXPIRED",
                ].includes(mapped.code)
              ? "BAD_REQUEST"
              : ["QUOTA_EXCEEDED", "RATE_LIMITED"].includes(mapped.code)
                ? "TOO_MANY_REQUESTS"
                : "INTERNAL_SERVER_ERROR";
    throw new ORPCError(code, { message: mapped.message });
  }
}
export const kbAssetsRouter = {
  list: protectedProcedure
    .input(kbReadToolSchemas.knowledge_assets_list.input)
    .handler(({ context, input, signal }) =>
      run(context.session!.user.id, () =>
        listAssets(getKbRuntime(), context.session!.user.id, input, undefined, { signal }),
      ),
    ),
  put: protectedProcedure
    .input(kbWriteToolSchemas.knowledge_assets_put.input)
    .handler(({ context, input }) =>
      run(context.session!.user.id, () =>
        mutateAsset(getKbRuntime(), context.session!.user.id, "put", input),
      ),
    ),
  import: protectedProcedure
    .input(kbWriteToolSchemas.knowledge_assets_import.input)
    .handler(({ context, input }) =>
      run(context.session!.user.id, () =>
        mutateAsset(getKbRuntime(), context.session!.user.id, "import", input),
      ),
    ),
};
