import { SUPPORTED_LOCALES } from "@knowledge-base/config/locales";
import { mailboxSchema } from "@knowledge-base/env/mailbox";
import { env } from "@knowledge-base/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { mapKbDomainError } from "../lib/kb/bases";
import { KbDomainError } from "../lib/kb/errors";
import { getKbRuntime } from "../lib/kb/runtime";
import {
  shareAccept,
  shareInvite,
  shareList,
  sharePermissionSchemaValues,
  shareRevoke,
  shareSetSealedValues,
  shareUpdate,
} from "../lib/kb/shares";
import { transferAccept, transferRequest } from "../lib/kb/transfer";

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const kbId = z.string().min(1).max(64);

const permissionsSchema = z
  .array(z.enum(sharePermissionSchemaValues))
  .min(1)
  .max(sharePermissionSchemaValues.length);

function orpcCode(error: KbDomainError): string {
  switch (error.code) {
    case "INVALID_ARGUMENT":
      return "BAD_REQUEST";
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "CONFLICT":
    case "IDEMPOTENCY_MISMATCH":
    case "QUOTA_EXCEEDED":
      return "CONFLICT";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

function toOrpc(error: unknown): never {
  const mapped = mapKbDomainError(error);
  if (mapped) {
    throw new ORPCError(orpcCode(mapped), { message: mapped.message });
  }
  throw error;
}

export const kbMembersProcedures = {
  shareInvite: protectedProcedure
    .input(
      z.object({
        kbId,
        email: mailboxSchema,
        permissions: permissionsSchema,
        idempotencyKey,
        // Language of the invitation email (the inviter's UI locale).
        locale: z.enum(SUPPORTED_LOCALES).optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareInvite(
          runtime,
          context.session!.user.id,
          input,
          env.KB_MASTER_KEY?.reveal(),
        );
      } catch (error) {
        toOrpc(error);
      }
    }),

  shareAccept: protectedProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareAccept(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  shareList: protectedProcedure
    .input(
      z.object({
        kbId,
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(1024).nullable().optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareList(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  shareRevoke: protectedProcedure
    .input(z.object({ kbId, shareUserId: z.string().min(1) }))
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareRevoke(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  /** Change a live member's bits; `manage`, like invite and revoke. */
  shareUpdate: protectedProcedure
    .input(z.object({ kbId, shareUserId: z.string().min(1), permissions: permissionsSchema }))
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareUpdate(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  /** Owner-only; the service refuses any non-owner, managers included. */
  shareSetSealedValues: protectedProcedure
    .input(z.object({ kbId, shareUserId: z.string().min(1), includeSealedValues: z.boolean() }))
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareSetSealedValues(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  transferRequest: protectedProcedure
    .input(
      z.object({
        kbId,
        recipientUserId: z.string().min(1),
        metadataVersion: z.number().int().min(1),
        idempotencyKey,
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await transferRequest(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  transferAccept: protectedProcedure
    .input(
      // The former owner always keeps `manage`; there is no choice to make.
      z.object({ requestId: z.string().uuid() }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await transferAccept(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),
};
