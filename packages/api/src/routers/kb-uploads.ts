import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { mapKbDomainError } from "../lib/kb/bases";
import { getKbRuntime } from "../lib/kb/runtime";
import { UPLOAD_MAX_CHUNK_BYTES, uploadBegin, uploadFinish, uploadWrite } from "../lib/kb/uploads";
import { createProcedureBudget } from "../lib/procedure-budget";

const kbId = z.string().min(1).max(64);
const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const uploadId = z.string().uuid();

const consumeUploadBudget = createProcedureBudget({
  keyPrefix: "rl:kb-upload",
  points: 120,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many upload requests. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Uploads are temporarily unavailable. Please try again.",
  unavailableLog: "[kb] upload limiter unavailable, failing closed:",
});

function toOrpc(error: unknown): never {
  const mapped = mapKbDomainError(error);
  if (mapped) {
    const code =
      mapped.code === "INVALID_ARGUMENT" ||
      mapped.code === "UPLOAD_INCOMPLETE" ||
      mapped.code === "UPLOAD_EXPIRED"
        ? "BAD_REQUEST"
        : mapped.code === "NOT_FOUND"
          ? "NOT_FOUND"
          : mapped.code === "FORBIDDEN"
            ? "FORBIDDEN"
            : mapped.code === "CONFLICT" || mapped.code === "IDEMPOTENCY_MISMATCH"
              ? "CONFLICT"
              : mapped.code === "RATE_LIMITED" || mapped.code === "QUOTA_EXCEEDED"
                ? "TOO_MANY_REQUESTS"
                : "INTERNAL_SERVER_ERROR";
    throw new ORPCError(code, { message: mapped.message });
  }
  throw error;
}

export const kbUploadsRouter = {
  begin: protectedProcedure
    .input(
      z.object({
        kbId,
        idempotencyKey,
        kind: z.enum(["markdown", "asset"]),
        size: z.number().int().min(1),
        contentHash: hash,
        mime: z.string().min(1).max(128),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        await consumeUploadBudget(context.session!.user.id);
        return await uploadBegin(runtime, context.session!.user.id, runtime.assetsDir, input);
      } catch (error) {
        toOrpc(error);
      }
    }),
  write: protectedProcedure
    .input(
      z.object({
        kbId,
        uploadId,
        offset: z.number().int().min(0),
        bytesBase64: z
          .string()
          .min(1)
          .max(Math.ceil((UPLOAD_MAX_CHUNK_BYTES * 4) / 3) + 4),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        await consumeUploadBudget(context.session!.user.id);
        return await uploadWrite(runtime, context.session!.user.id, runtime.assetsDir, input);
      } catch (error) {
        toOrpc(error);
      }
    }),
  finish: protectedProcedure
    .input(
      z.object({
        kbId,
        uploadId,
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        await consumeUploadBudget(context.session!.user.id);
        return await uploadFinish(runtime, context.session!.user.id, runtime.assetsDir, input);
      } catch (error) {
        toOrpc(error);
      }
    }),
};
