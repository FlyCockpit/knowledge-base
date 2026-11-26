import { env } from "@knowledge-base/env/shared";
import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { fromAdmissionError, KbDomainError } from "../lib/kb/errors";
import { getKbRuntime } from "../lib/kb/runtime";
import {
  listSealedConsumers,
  listSealedValues,
  sealedListInput,
  sealedUsageInput,
  sealedValueUsage,
} from "../lib/kb/sealed-overview";
import {
  enrollSealedRecord,
  grantSealedRecord,
  revokeSealedGrant,
  revokeSealedRecord,
  sealedEnrollInput,
  sealedGrantInput,
  sealedRevokeGrantInput,
  sealedRevokeInput,
} from "../lib/kb/sealed-records";

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const domain = error instanceof KbDomainError ? error : fromAdmissionError(error);
    const codes: Record<string, string> = {
      INVALID_ARGUMENT: "BAD_REQUEST",
      UNRESOLVED_REFERENCE: "NOT_FOUND",
      NOT_FOUND: "NOT_FOUND",
      FORBIDDEN: "FORBIDDEN",
      CONFLICT: "CONFLICT",
      IDEMPOTENCY_MISMATCH: "CONFLICT",
      RATE_LIMITED: "TOO_MANY_REQUESTS",
    };
    throw new ORPCError(
      domain ? (codes[domain.code] ?? "INTERNAL_SERVER_ERROR") : "INTERNAL_SERVER_ERROR",
      { message: "Sealed operation unavailable" },
    );
  }
}
const browser = (userId: string) => ({ kind: "browser" as const, userId });
/**
 * Owner-only sealed controls. Reads return metadata only (names, dates,
 * approvals, document paths, pickable tokens), never ciphertext or plaintext;
 * every procedure applies the same exact-owner + live-2FA gate.
 */
export const kbSealedRouter = {
  list: protectedProcedure
    .input(sealedListInput)
    .handler(({ context, input }) =>
      safe(() => listSealedValues(getKbRuntime(), browser(context.session.user.id), input)),
    ),
  usage: protectedProcedure
    .input(sealedUsageInput)
    .handler(({ context, input, signal }) =>
      safe(() =>
        sealedValueUsage(getKbRuntime(), browser(context.session.user.id), input, { signal }),
      ),
    ),
  consumers: protectedProcedure
    .input(sealedListInput)
    .handler(({ context, input }) =>
      safe(() => listSealedConsumers(getKbRuntime(), browser(context.session.user.id), input)),
    ),
  revokeGrant: protectedProcedure
    .input(sealedRevokeGrantInput)
    .handler(({ context, input }) =>
      safe(() => revokeSealedGrant(getKbRuntime(), browser(context.session.user.id), input)),
    ),
  enroll: protectedProcedure
    .input(sealedEnrollInput)
    .handler(({ context, input }) =>
      safe(() =>
        enrollSealedRecord(
          getKbRuntime(),
          { kind: "browser", userId: context.session.user.id },
          input,
          env.KB_MASTER_KEY?.reveal(),
        ),
      ),
    ),
  grant: protectedProcedure
    .input(sealedGrantInput)
    .handler(({ context, input }) =>
      safe(() =>
        grantSealedRecord(
          getKbRuntime(),
          { kind: "browser", userId: context.session.user.id },
          input,
        ),
      ),
    ),
  revoke: protectedProcedure
    .input(sealedRevokeInput)
    .handler(({ context, input }) =>
      safe(() =>
        revokeSealedRecord(
          getKbRuntime(),
          { kind: "browser", userId: context.session.user.id },
          input,
        ),
      ),
    ),
};
