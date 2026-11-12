import { env } from "@knowledge-base/env/shared";
import { ORPCError } from "@orpc/server";
import { protectedProcedure } from "../index";
import { fromAdmissionError, KbDomainError } from "../lib/kb/errors";
import { getKbRuntime } from "../lib/kb/runtime";
import {
  enrollSealedRecord,
  grantSealedRecord,
  revokeSealedRecord,
  sealedEnrollInput,
  sealedGrantInput,
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
export const kbSealedRouter = {
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
