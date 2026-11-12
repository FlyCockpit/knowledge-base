import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../index";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBaseForViewer,
  listKnowledgeBasesForViewer,
  mapKbDomainError,
  updateKnowledgeBase,
} from "../lib/kb/bases";
import { KbDomainError } from "../lib/kb/errors";
import { getIndexProfile } from "../lib/kb/index-status";
import { getKbRuntime } from "../lib/kb/runtime";
import { kbDescriptionSchema, kbNameSchema } from "../lib/schemas";
import { kbMembersProcedures } from "./kb-members";

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const kbId = z.string().min(1).max(64);
const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .max(63);
// Shared metadata policy (scalar bounds and controls) agrees with MCP and the
// browser forms; domain validation still follows live admission/replay.
const name = kbNameSchema;
const description = kbDescriptionSchema;

function orpcCode(error: KbDomainError): string {
  switch (error.code) {
    case "INVALID_ARGUMENT":
    case "INVALID_CURSOR":
      return "BAD_REQUEST";
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "CONFLICT":
    case "IDEMPOTENCY_MISMATCH":
      return "CONFLICT";
    case "RATE_LIMITED":
      return "TOO_MANY_REQUESTS";
    case "QUOTA_EXCEEDED":
      return "TOO_MANY_REQUESTS";
    case "STORAGE_UNAVAILABLE":
    case "REPAIR_REQUIRED":
    case "INTERNAL":
      return "INTERNAL_SERVER_ERROR";
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

export const kbsRouter = {
  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).optional(),
          cursor: z.string().max(1024).nullable().optional(),
          /** The KB list page shows "Owned" and "Shared with me" separately. */
          relation: z.enum(["all", "owned", "shared"]).optional(),
        })
        .optional(),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await listKnowledgeBasesForViewer(runtime, context.session!.user.id, {
          limit: input?.limit,
          cursor: input?.cursor ?? null,
          relation: input?.relation ?? "all",
        });
      } catch (error) {
        toOrpc(error);
      }
    }),
  get: protectedProcedure.input(z.object({ kbId })).handler(async ({ context, input }) => {
    try {
      const runtime = getKbRuntime();
      const kb = await getKnowledgeBaseForViewer(runtime, context.session!.user.id, input.kbId);
      const { index } = await getIndexProfile(
        runtime,
        { principal: { kind: "browser", userId: context.session!.user.id } },
        input.kbId,
      );
      return { kb: { ...kb, embeddingGeneration: index.activeGenerationId }, index };
    } catch (error) {
      toOrpc(error);
    }
  }),
  create: protectedProcedure
    .input(z.object({ name, slug, description, idempotencyKey }))
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        const result = await createKnowledgeBase(runtime, context.session!.user.id, input);
        return result;
      } catch (error) {
        toOrpc(error);
      }
    }),
  update: protectedProcedure
    .input(
      z.object({
        kbId,
        metadataVersion: z.number().int().min(1),
        idempotencyKey,
        name: name.optional(),
        description: description.optional(),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await updateKnowledgeBase(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),
  delete: protectedProcedure
    .input(
      z.object({
        kbId,
        metadataVersion: z.number().int().min(1),
        idempotencyKey,
        confirm: z.literal("DELETE"),
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        const runtime = getKbRuntime();
        return await deleteKnowledgeBase(runtime, context.session!.user.id, input);
      } catch (error) {
        toOrpc(error);
      }
    }),
  ...kbMembersProcedures,
};
