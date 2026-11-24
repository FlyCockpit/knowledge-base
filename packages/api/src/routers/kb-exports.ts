import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { mapKbDomainError } from "../lib/kb/bases";
import { cancelExport, exportStatus, latestExport, prepareExport } from "../lib/kb/exports";
import { kbBaseInputSchema } from "../lib/kb/protocol/common";
import { kbReadToolSchemas } from "../lib/kb/protocol/reads";
import { getKbRuntime } from "../lib/kb/runtime";
import { completeExport, readTransfer } from "../lib/kb/transfers";
import { createProcedureBudget } from "../lib/procedure-budget";

const budget = createProcedureBudget({
  keyPrefix: "rl:kb-exports",
  points: 2048,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Too many transfer requests.",
  unavailableMessage: "Transfers unavailable.",
  unavailableLog: "[kb] transfer limiter unavailable",
});
async function run<T>(userId: string, work: () => Promise<T>) {
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
          : ["RATE_LIMITED", "QUOTA_EXCEEDED"].includes(mapped.code)
            ? "TOO_MANY_REQUESTS"
            : ["CONFLICT", "IDEMPOTENCY_MISMATCH"].includes(mapped.code)
              ? "CONFLICT"
              : mapped.code === "INVALID_ARGUMENT"
                ? "BAD_REQUEST"
                : "INTERNAL_SERVER_ERROR";
    throw new ORPCError(code, { message: mapped.message });
  }
}
export const kbExportsRouter = {
  prepare: protectedProcedure
    .input(kbReadToolSchemas.knowledge_export_prepare.input)
    .handler(({ context, input, signal }) =>
      run(context.session!.user.id, () =>
        prepareExport(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session!.user.id } },
          input,
          { signal },
        ),
      ),
    ),
  /** The requester's own job; another user's id is NOT_FOUND. */
  status: protectedProcedure
    .input(kbReadToolSchemas.knowledge_export_status.input)
    .handler(({ context, input }) =>
      run(context.session!.user.id, () =>
        exportStatus(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session!.user.id } },
          input,
        ),
      ),
    ),
  /** The requester's most recent job for this KB (a reopened page resumes it). */
  latest: protectedProcedure
    .input(kbBaseInputSchema)
    .handler(({ context, input }) =>
      run(context.session!.user.id, () =>
        latestExport(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session!.user.id } },
          input,
        ),
      ),
    ),
  cancel: protectedProcedure
    .input(kbReadToolSchemas.knowledge_export_cancel.input)
    .handler(({ context, input }) =>
      run(context.session!.user.id, () =>
        cancelExport(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session!.user.id } },
          input,
        ),
      ),
    ),
  read: protectedProcedure
    .input(kbReadToolSchemas.knowledge_transfer_read.input)
    .handler(({ context, input, signal }) =>
      run(context.session!.user.id, () =>
        readTransfer(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session!.user.id } },
          input,
          { signal },
        ),
      ),
    ),
  /** The client's "download complete" acknowledgement. */
  complete: protectedProcedure
    .input(kbReadToolSchemas.knowledge_export_complete.input)
    .handler(({ context, input }) =>
      run(context.session!.user.id, () =>
        completeExport(
          getKbRuntime(),
          { principal: { kind: "browser", userId: context.session!.user.id } },
          input,
        ),
      ),
    ),
};
