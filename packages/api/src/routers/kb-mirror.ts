import { env } from "@knowledge-base/env/shared";
import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { fromAdmissionError, KbDomainError } from "../lib/kb/errors";
import {
  configureMirror,
  disconnectMirror,
  getMirrorStatus,
  mirrorAttemptResultSchema,
  mirrorConfigureInput,
  mirrorMutationInput,
  mirrorResultSchema,
  mirrorStatusInput,
  mirrorStatusSchema,
  queueMirrorAttempt,
  rotateMirrorKey,
} from "../lib/kb/mirror";
import { getKbRuntime } from "../lib/kb/runtime";
import { MIRROR_PRIVATE_HOST_REASON } from "../lib/kb/ssh-url";

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const domain = error instanceof KbDomainError ? error : fromAdmissionError(error);
    const codes: Record<string, string> = {
      INVALID_ARGUMENT: "BAD_REQUEST",
      NOT_FOUND: "NOT_FOUND",
      FORBIDDEN: "FORBIDDEN",
      CONFLICT: "CONFLICT",
      IDEMPOTENCY_MISMATCH: "CONFLICT",
      RATE_LIMITED: "TOO_MANY_REQUESTS",
      STORAGE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
    };
    // The private-network egress block is the one refusal the form explains by name.
    const privateHost =
      domain?.code === "INVALID_ARGUMENT" &&
      (domain.details as { reason?: unknown } | undefined)?.reason === MIRROR_PRIVATE_HOST_REASON;
    throw new ORPCError(
      domain ? (codes[domain.code] ?? "INTERNAL_SERVER_ERROR") : "INTERNAL_SERVER_ERROR",
      {
        message: "Mirror operation unavailable",
        ...(privateHost ? { data: { reason: MIRROR_PRIVATE_HOST_REASON } } : {}),
      },
    );
  }
}
const browser = (userId: string) => ({ kind: "browser" as const, userId });

/**
 * Human manage-only mirror controls. Outputs are parsed through the public
 * projection schemas, so no private key, ciphertext or unknown field is ever
 * serialized. Activation/push queue an exact durable pin for the dedicated worker.
 */
export const kbMirrorRouter = {
  activate: protectedProcedure
    .input(mirrorMutationInput)
    .handler(async ({ context, input }) =>
      mirrorAttemptResultSchema.parse(
        await safe(() =>
          queueMirrorAttempt(getKbRuntime(), browser(context.session.user.id), input, "ACTIVATE"),
        ),
      ),
    ),
  push: protectedProcedure
    .input(mirrorMutationInput)
    .handler(async ({ context, input }) =>
      mirrorAttemptResultSchema.parse(
        await safe(() =>
          queueMirrorAttempt(getKbRuntime(), browser(context.session.user.id), input, "PUSH"),
        ),
      ),
    ),
  status: protectedProcedure
    .input(mirrorStatusInput)
    .handler(async ({ context, input }) =>
      mirrorStatusSchema.parse(
        await safe(() => getMirrorStatus(getKbRuntime(), browser(context.session.user.id), input)),
      ),
    ),
  configure: protectedProcedure
    .input(mirrorConfigureInput)
    .handler(async ({ context, input }) =>
      mirrorResultSchema.parse(
        await safe(() =>
          configureMirror(
            getKbRuntime(),
            browser(context.session.user.id),
            input,
            env.KB_MASTER_KEY?.reveal(),
          ),
        ),
      ),
    ),
  rotate: protectedProcedure
    .input(mirrorMutationInput)
    .handler(async ({ context, input }) =>
      mirrorResultSchema.parse(
        await safe(() =>
          rotateMirrorKey(
            getKbRuntime(),
            browser(context.session.user.id),
            input,
            env.KB_MASTER_KEY?.reveal(),
          ),
        ),
      ),
    ),
  disconnect: protectedProcedure
    .input(mirrorMutationInput)
    .handler(async ({ context, input }) =>
      mirrorResultSchema.parse(
        await safe(() => disconnectMirror(getKbRuntime(), browser(context.session.user.id), input)),
      ),
    ),
};
