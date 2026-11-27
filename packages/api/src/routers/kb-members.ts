import { SUPPORTED_LOCALES } from "@knowledge-base/config/locales";
import { mailboxSchema } from "@knowledge-base/env/mailbox";
import { env, SIGNUP_ENABLED } from "@knowledge-base/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { mapKbDomainError } from "../lib/kb/bases";
import { KbDomainError } from "../lib/kb/errors";
import { getKbRuntime } from "../lib/kb/runtime";
import {
  hasSharedKnowledgeBase,
  shareAccept,
  shareInbox,
  shareInvite,
  shareInviteCancel,
  shareInvitePreview,
  shareInviteResend,
  shareList,
  sharePendingList,
  sharePermissionSchemaValues,
  shareRevoke,
  shareSetSealedValues,
  shareUpdate,
} from "../lib/kb/shares";
import { transferAccept, transferRequest } from "../lib/kb/transfer";
import { cursorPageInput } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const kbId = z.string().min(1).max(64);
const invitationId = z.string().min(1).max(64);
// The listed send (`sentAt`): pins the exact invitation, never its replacement.
const sentAt = z.string().datetime({ offset: true });
// Language of an invitation email (the sender's UI locale).
const locale = z.enum(SUPPORTED_LOCALES).optional();
const pageInput = {
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(1024).nullable().optional(),
};

/**
 * The recipient's invitation preview is a per-user read keyed by request id;
 * its own bucket keeps it off the shared `/rpc` budget and bounds how fast
 * one account can probe ids (each unknown one answers the same NOT_FOUND).
 */
const consumeInvitePreviewBudget = createProcedureBudget({
  keyPrefix: "rl:kb-share-invite-preview",
  points: 30,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many invitation lookups. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Invitations are temporarily unavailable. Please try again.",
  unavailableLog: "[kb] share invite preview limiter unavailable, failing closed:",
});

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
  /** Pending invitations addressed to the current verified recipient only. */
  shareInbox: protectedProcedure.input(cursorPageInput).handler(async ({ context, input }) => {
    try {
      return await shareInbox(getKbRuntime(), context.session!.user.id, input);
    } catch (error) {
      toOrpc(error);
    }
  }),

  shareInvite: protectedProcedure
    .input(
      z.object({
        kbId,
        email: mailboxSchema,
        permissions: permissionsSchema,
        idempotencyKey,
        locale,
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareInvite(
          runtime,
          context.session!.user.id,
          // The email offers sign-up only when this server's sign-up is open.
          { ...input, signupOpen: SIGNUP_ENABLED },
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

  /**
   * The signed-in recipient's view of one pending invitation addressed to
   * them; the same NOT_FOUND in every other case (see the service).
   */
  shareInvitePreview: protectedProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .handler(async ({ context, input }) => {
      const userId = context.session!.user.id;
      await consumeInvitePreviewBudget(userId);
      try {
        return await shareInvitePreview(getKbRuntime(), userId, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  shareList: protectedProcedure
    .input(z.object({ kbId, ...pageInput }))
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await shareList(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  /** Pending invitations; `manage`, like the member list. */
  sharePendingList: protectedProcedure
    .input(z.object({ kbId, ...pageInput }))
    .handler(async ({ context, input }) => {
      try {
        return await sharePendingList(getKbRuntime(), context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  /** Cancel a pending invitation; `manage`, like revoke. */
  shareInviteCancel: protectedProcedure
    .input(z.object({ kbId, invitationId, sentAt }))
    .handler(async ({ context, input }) => {
      try {
        return await shareInviteCancel(getKbRuntime(), context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),

  /**
   * Re-send a pending invitation's email (same link); `manage` and the KB
   * mutation budget, like an invite.
   */
  shareInviteResend: protectedProcedure
    .input(z.object({ kbId, invitationId, sentAt, idempotencyKey, locale }))
    .handler(async ({ context, input }) => {
      try {
        return await shareInviteResend(getKbRuntime(), context.session!.user.id, {
          ...input,
          signupOpen: SIGNUP_ENABLED,
        });
      } catch (error) {
        toOrpc(error);
      }
    }),

  /** Whether the caller has shared any KB (the web home's checklist step). */
  shareStatusMine: protectedProcedure.handler(async ({ context }) => {
    try {
      const runtime = getKbRuntime();
      return { shared: await hasSharedKnowledgeBase(runtime, context.session!.user.id) };
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
