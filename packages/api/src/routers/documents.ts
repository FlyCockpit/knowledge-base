import { randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { prismaAssetQuery } from "../lib/kb/asset-authz";
import { mapKbDomainError } from "../lib/kb/bases";
import { browserConflictDetails } from "../lib/kb/browser-conflict";
import {
  changesPublicationForDocument,
  DOCUMENT_CREATE_OPERATION,
  DOCUMENT_DELETE_OPERATION,
  DOCUMENT_STAGED_ASSETS_MAX,
  DOCUMENT_UPDATE_OPERATION,
  type DocumentMutationRequest,
} from "../lib/kb/changes";
import { cursorExpiry, KB_PAGE_DEFAULT, KB_PAGE_MAX, stableFilterHash } from "../lib/kb/cursor";
import {
  authorizeDocumentRead,
  estimateListPageBytes,
  isCommitReachable,
  listDocumentsAtRevision,
  readDocumentAtRevision,
  resolvePinnedRevision,
} from "../lib/kb/documents-read";
import { KbDomainError } from "../lib/kb/errors";
import { gitReadOptions, kbBareRepoPath } from "../lib/kb/git-read";
import { actorKeyForUser } from "../lib/kb/operation-intent";
import { prismaAuthorityStore } from "../lib/kb/permissions";
import { kbContentWriteInputSchema } from "../lib/kb/protocol/common";
import { getKbRuntime } from "../lib/kb/runtime";
import { createProcedureBudget } from "../lib/procedure-budget";

const kbId = z.string().min(1).max(64);
const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .optional();
const path = z.string().min(1).max(512);
const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const baseRevision = z.string().regex(/^[0-9a-f]{40}$/);
/**
 * Images staged while editing (R3-W7): finished asset uploads committed with
 * the document's own save, never before it. Paths and uploads are checked by
 * the change-set rules like any `assetPut`.
 */
const stagedAssets = z
  .array(z.object({ path, uploadId: z.string().uuid() }))
  .max(DOCUMENT_STAGED_ASSETS_MAX)
  .optional();
const textContent = z.union([
  z.object({ markdown: z.string().max(128 * 1024) }),
  z.object({ uploadId: z.string().uuid() }),
]);

const consumeDocumentReadBudget = createProcedureBudget({
  keyPrefix: "rl:kb-documents-read",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many document read requests. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Document reads are temporarily unavailable. Please try again.",
  unavailableLog: "[kb] documents read limiter unavailable, failing closed:",
});

export function documentErrorToOrpc(error: unknown): never {
  const mapped = mapKbDomainError(error);
  if (mapped) {
    if (mapped.code === "REPAIR_REQUIRED") {
      throw new ORPCError("REPAIR_REQUIRED", { status: 409, message: mapped.message });
    }
    const code =
      mapped.code === "INVALID_ARGUMENT" || mapped.code === "INVALID_CURSOR"
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
    if (mapped.code === "CONFLICT") {
      throw new ORPCError(code, {
        message: mapped.message,
        data: { code: "CONFLICT", details: browserConflictDetails(mapped.details) ?? {} },
      });
    }
    // A readable revision without this path is a state of the page, not
    // a denial. Only the reason travels, never any other detail.
    if (
      mapped.code === "NOT_FOUND" &&
      (mapped.details as { reason?: unknown } | undefined)?.reason === "PATH_NOT_FOUND"
    ) {
      throw new ORPCError(code, {
        message: mapped.message,
        data: { code: "NOT_FOUND", details: { reason: "PATH_NOT_FOUND" } },
      });
    }
    throw new ORPCError(code, { message: mapped.message, data: { code: mapped.code } });
  }
  throw error;
}

const toOrpc = documentErrorToOrpc;

export const documentsRouter = {
  list: protectedProcedure
    .input(
      z.object({
        kbId,
        rev: sha,
        prefix: path.optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().max(1024).nullable().optional(),
      }),
    )
    .handler(async ({ context, input, signal }) => {
      try {
        const readOptions = gitReadOptions({ signal });
        const runtime = getKbRuntime();
        const userId = context.session!.user.id;
        await consumeDocumentReadBudget(userId);
        const admission = {
          store: prismaAuthorityStore(runtime.prisma),
          principal: { kind: "browser" as const, userId },
          kbId: input.kbId,
          operation: "read" as const,
        };
        await authorizeDocumentRead(admission);
        const row = await runtime.prisma.knowledgeBase.findUnique({
          where: { id: input.kbId },
          select: { headSha: true, state: true },
        });
        if (!row || row.state === "TOMBSTONED") {
          throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
        }
        const repoPath = kbBareRepoPath(runtime.reposDir, input.kbId);
        const limit = Math.min(Math.max(input.limit ?? KB_PAGE_DEFAULT, 1), KB_PAGE_MAX);
        const actorKey = actorKeyForUser(userId);
        const filterHash = stableFilterHash({ prefix: input.prefix ?? null });
        let afterPath: string | null = null;
        let commitSha: string;
        if (input.cursor) {
          const payload = runtime.cursorSigner.verify(input.cursor, {
            actorKey,
            kbId: input.kbId,
            filterHash,
            sortKey: "path:asc",
            revision: "*",
          });
          commitSha = payload.revision;
          if (input.rev && input.rev !== commitSha) {
            throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
          }
          if (!(await isCommitReachable(repoPath, commitSha, readOptions))) {
            throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
          }
          afterPath = payload.lastKey;
        } else {
          commitSha = await resolvePinnedRevision(repoPath, input.rev, row.headSha, readOptions);
        }
        const page = await listDocumentsAtRevision({
          ...readOptions,
          reposDir: runtime.reposDir,
          kbId: input.kbId,
          commitSha,
          prefix: input.prefix,
          limit,
          afterPath,
        });
        if (estimateListPageBytes(page.items) > 8 * 1024 * 1024) {
          throw new KbDomainError("INVALID_ARGUMENT", "Response too large");
        }
        await authorizeDocumentRead(admission);
        const nextCursor =
          page.nextAfter === null
            ? null
            : runtime.cursorSigner.sign({
                v: 1,
                actorKey,
                kbId: input.kbId,
                filterHash,
                sortKey: "path:asc",
                revision: commitSha,
                lastKey: page.nextAfter,
                exp: cursorExpiry(),
              });
        return { items: page.items, nextCursor };
      } catch (error) {
        toOrpc(error);
      }
    }),
  get: protectedProcedure
    .input(z.object({ kbId, rev: sha, path }))
    .handler(async ({ context, input, signal }) => {
      try {
        const readOptions = gitReadOptions({ signal });
        const runtime = getKbRuntime();
        const userId = context.session!.user.id;
        await consumeDocumentReadBudget(userId);
        const admission = {
          store: prismaAuthorityStore(runtime.prisma),
          principal: { kind: "browser" as const, userId },
          kbId: input.kbId,
          operation: "read" as const,
        };
        await authorizeDocumentRead(admission);
        const row = await runtime.prisma.knowledgeBase.findUnique({
          where: { id: input.kbId },
          select: { headSha: true, state: true },
        });
        if (!row || row.state === "TOMBSTONED") {
          throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
        }
        const repoPath = kbBareRepoPath(runtime.reposDir, input.kbId);
        const commitSha = await resolvePinnedRevision(
          repoPath,
          input.rev,
          row.headSha,
          readOptions,
        );
        const document = await readDocumentAtRevision({
          ...readOptions,
          reposDir: runtime.reposDir,
          kbId: input.kbId,
          commitSha,
          path: input.path,
          query: prismaAssetQuery(runtime.prisma),
        });
        await authorizeDocumentRead(admission);
        return document;
      } catch (error) {
        toOrpc(error);
      }
    }),
  create: protectedProcedure
    .input(
      z.object({
        kbId,
        baseRevision,
        path,
        content: textContent,
        idempotencyKey,
        assets: stagedAssets,
        /** The proposal being edited: set once an edit targets a PR. */
        ...kbContentWriteInputSchema.pick({ proposalNumber: true, proposalHeadSha: true }).shape,
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        return await runDocumentMutation(context.session!.user.id, {
          operation: DOCUMENT_CREATE_OPERATION,
          path: input.path,
          content: input.content,
          idempotencyKey: input.idempotencyKey,
          ...(input.assets?.length ? { assets: input.assets } : {}),
          kbId: input.kbId,
          baseRevision: input.baseRevision,
          proposalNumber: input.proposalNumber,
          proposalHeadSha: input.proposalHeadSha,
        });
      } catch (error) {
        toOrpc(error);
      }
    }),
  update: protectedProcedure
    .input(
      z.object({
        kbId,
        baseRevision,
        path,
        content: textContent,
        idempotencyKey,
        assets: stagedAssets,
        /** The proposal being edited: set once an edit targets a PR. */
        ...kbContentWriteInputSchema.pick({ proposalNumber: true, proposalHeadSha: true }).shape,
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        return await runDocumentMutation(context.session!.user.id, {
          operation: DOCUMENT_UPDATE_OPERATION,
          path: input.path,
          content: input.content,
          idempotencyKey: input.idempotencyKey,
          ...(input.assets?.length ? { assets: input.assets } : {}),
          kbId: input.kbId,
          baseRevision: input.baseRevision,
          proposalNumber: input.proposalNumber,
          proposalHeadSha: input.proposalHeadSha,
        });
      } catch (error) {
        toOrpc(error);
      }
    }),
  delete: protectedProcedure
    .input(
      z.object({
        kbId,
        baseRevision,
        path,
        confirm: z.literal("DELETE"),
        idempotencyKey,
        /** The proposal being edited: set once an edit targets a PR. */
        ...kbContentWriteInputSchema.pick({ proposalNumber: true, proposalHeadSha: true }).shape,
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        return await runDocumentMutation(context.session!.user.id, {
          operation: DOCUMENT_DELETE_OPERATION,
          path: input.path,
          idempotencyKey: input.idempotencyKey,
          kbId: input.kbId,
          baseRevision: input.baseRevision,
          proposalNumber: input.proposalNumber,
          proposalHeadSha: input.proposalHeadSha,
        });
      } catch (error) {
        toOrpc(error);
      }
    }),
};

async function runDocumentMutation(
  userId: string,
  input: DocumentMutationRequest & {
    kbId: string;
    baseRevision: string;
    proposalNumber?: number;
    proposalHeadSha?: string;
  },
) {
  const runtime = getKbRuntime();
  const publication = changesPublicationForDocument({
    store: prismaAuthorityStore(runtime.prisma),
    principal: { kind: "browser", userId },
    reposDir: runtime.reposDir,
    canonicalOrigin: runtime.canonicalOrigin,
    kbId: input.kbId,
    idempotencyKey: input.idempotencyKey,
    baseRevision: input.baseRevision,
    proposalNumber: input.proposalNumber,
    proposalHeadSha: input.proposalHeadSha,
    request: input,
    assetsDir: runtime.assetsDir,
    blobStore: runtime.blobStore,
    ratePort: runtime.ratePort,
    diskMeter: runtime.diskMeter,
  });
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: publication.barrier,
    run: (ctx) => {
      const executor = runtime.createGitExecutor?.(ctx, input.kbId);
      if (!executor) {
        throw new KbDomainError("INTERNAL", "Git executor is not configured");
      }
      return publication.publish(ctx.lease, executor);
    },
  });
}
