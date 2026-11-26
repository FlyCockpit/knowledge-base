import { env } from "@knowledge-base/env/shared";
import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { fromAdmissionError, KbDomainError } from "../lib/kb/errors";
import {
  configureMirror,
  disconnectMirror,
  enableUntestedMirror,
  getMirrorStatus,
  inspectMirrorRemote,
  mirrorAttemptResultSchema,
  mirrorConfigureInput,
  mirrorEnableUntestedInput,
  mirrorInspectInput,
  mirrorInspectSchema,
  mirrorMutationInput,
  mirrorResultSchema,
  mirrorStatusInput,
  mirrorStatusSchema,
  queueMirrorAttempt,
  rotateMirrorKey,
} from "../lib/kb/mirror";
import { MIRROR_HOST_KEY_REASONS, MIRROR_URL_REASONS } from "../lib/kb/mirror-remote";
import { getKbRuntime } from "../lib/kb/runtime";
import { MIRROR_HOST_NOT_FOUND_REASON, MIRROR_PRIVATE_HOST_REASON } from "../lib/kb/ssh-url";
import { createProcedureBudget } from "../lib/procedure-budget";

/** Each inspection opens outbound SSH connections: a per-user budget across all KBs. */
const inspectBudget = createProcedureBudget({
  keyPrefix: "rl:mirror-inspect",
  points: 20,
  durationSeconds: 600,
  failClosed: true,
  overBudgetMessage: () => "Mirror remote check rate limit",
  unavailableMessage: "Mirror remote check unavailable",
  unavailableLog: "[mirror] Remote check budget unavailable",
});

/** Refusals the setup guide explains by name. Each is a fixed code: no host or remote text. */
const NAMED_REASONS = new Set<string>([
  MIRROR_PRIVATE_HOST_REASON,
  MIRROR_HOST_NOT_FOUND_REASON,
  ...Object.values(MIRROR_URL_REASONS),
  ...Object.values(MIRROR_HOST_KEY_REASONS),
]);

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
    const reason = (domain?.details as { reason?: unknown } | undefined)?.reason;
    const named =
      domain?.code === "INVALID_ARGUMENT" &&
      typeof reason === "string" &&
      NAMED_REASONS.has(reason);
    throw new ORPCError(
      domain ? (codes[domain.code] ?? "INTERNAL_SERVER_ERROR") : "INTERNAL_SERVER_ERROR",
      {
        message: "Mirror operation unavailable",
        ...(named ? { data: { reason } } : {}),
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
  /** Normalise a remote and fetch/check its host keys; stores nothing. */
  inspect: protectedProcedure.input(mirrorInspectInput).handler(async ({ context, input }) => {
    await inspectBudget(context.session.user.id);
    return mirrorInspectSchema.parse(
      await safe(() =>
        inspectMirrorRemote(getKbRuntime(), browser(context.session.user.id), input),
      ),
    );
  }),
  /** Confirmed override: enable a first mirror whose connection test failed. */
  enableUntested: protectedProcedure
    .input(mirrorEnableUntestedInput)
    .handler(async ({ context, input }) =>
      mirrorResultSchema.parse(
        await safe(() =>
          enableUntestedMirror(getKbRuntime(), browser(context.session.user.id), input),
        ),
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
