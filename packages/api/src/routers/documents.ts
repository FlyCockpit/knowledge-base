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
  DOCUMENT_MOVE_OPERATION,
  DOCUMENT_STAGED_ASSETS_MAX,
  DOCUMENT_UPDATE_OPERATION,
  type DocumentMutationRequest,
} from "../lib/kb/changes";
import { MOVE_BREAKS_ASSET_LINKS } from "../lib/kb/changes-plan";
import { cursorExpiry, KB_PAGE_DEFAULT, KB_PAGE_MAX, stableFilterHash } from "../lib/kb/cursor";
import { DELETED_DOCUMENTS_CURSOR, readDeletedDocuments } from "../lib/kb/deleted-documents";
import { DOCUMENT_HISTORY_CURSOR, readDocumentHistory } from "../lib/kb/document-history";
import {
  authorizeDocumentRead,
  DOCUMENT_TREE_PAGE_MAX,
  estimateListPageBytes,
  isCommitReachable,
  listDocumentPathsAtRevision,
  listDocumentsAtRevision,
  readDocumentAtRevision,
  resolvePinnedRevision,
} from "../lib/kb/documents-read";
import { KbDomainError } from "../lib/kb/errors";
import { gitReadOptions, kbBareRepoPath } from "../lib/kb/git-read";
import { actorKeyForUser } from "../lib/kb/operation-intent";
import { readDocumentProvenance } from "../lib/kb/parse-markdown";
import { prismaAuthorityStore } from "../lib/kb/permissions";
import { kbContentWriteInputSchema } from "../lib/kb/protocol/common";
import {
  KB_FIELD_POINTER_RE,
  KB_INVALID_ARGUMENT_REASONS,
  type KbInvalidArgumentReason,
} from "../lib/kb/protocol/envelope";
import { readRecentChanges } from "../lib/kb/recent-changes";
import { getKbRuntime } from "../lib/kb/runtime";
import { cursorPageInput } from "../lib/pagination";
import { createProcedureBudget } from "../lib/procedure-budget";

const kbId = z.string().min(1).max(64);
const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .optional();
const path = z.string().min(1).max(512);
/** History pages: an opaque cursor pinning main's head and the rows already returned. */
const historyPageInput = cursorPageInput.extend({
  cursor: z.string().max(64).regex(DOCUMENT_HISTORY_CURSOR).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const baseRevision = z.string().regex(/^[0-9a-f]{40}$/);
/**
 * Images staged while editing: finished asset uploads committed with
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

/** `documents.tree` pages: paths only, so far larger than `list`'s. */
const DOCUMENT_TREE_PAGE_DEFAULT = 2000;
const DOCUMENT_TREE_SORT_KEY = "tree:path:asc";

/**
 * The workspace's own reads, each its own bucket so they never starve opening
 * documents: the file tree (read once per KB head: on open and after each
 * save, create, move or delete) and the recent-changes feed (the same, plus
 * its pages). 60 a minute each covers a person saving once a second.
 */
const consumeDocumentTreeBudget = createProcedureBudget({
  keyPrefix: "rl:kb-documents-tree",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many file list requests. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "The file list is temporarily unavailable. Please try again.",
  unavailableLog: "[kb] documents tree limiter unavailable, failing closed:",
});
const consumeRecentChangesBudget = createProcedureBudget({
  keyPrefix: "rl:kb-recent-changes",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many recent-changes requests. Try again in ${retryAfterSeconds}s.`,
  unavailableMessage: "Recent changes are temporarily unavailable. Please try again.",
  unavailableLog: "[kb] recent changes limiter unavailable, failing closed:",
});

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
    const details = mapped.details as { reason?: unknown; field?: unknown } | undefined;
    // Creating (or moving onto) a path that already exists: the form names the path field.
    if (mapped.code === "CONFLICT" && details?.reason === "PATH_EXISTS") {
      throw new ORPCError(code, {
        message: mapped.message,
        data: { code: "CONFLICT", details: { reason: "PATH_EXISTS" } },
      });
    }
    // A move that would break the document's relative image links: a
    // browser-only reason (no kb/1 caller can plan a move), explained under
    // the rename field. Only the reason travels.
    if (mapped.code === "INVALID_ARGUMENT" && details?.reason === MOVE_BREAKS_ASSET_LINKS) {
      throw new ORPCError(code, {
        message: mapped.message,
        data: { code: "INVALID_ARGUMENT", details: { reason: MOVE_BREAKS_ASSET_LINKS } },
      });
    }
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
    // A refused argument says which closed rule it broke and which field
    // (a fixed JSON pointer), so the editor can show it next to that field.
    // Both are protocol constants: no caller text travels.
    if (mapped.code === "INVALID_ARGUMENT" && isArgumentReason(details?.reason)) {
      throw new ORPCError(code, {
        message: mapped.message,
        data: {
          code: mapped.code,
          details: {
            reason: details.reason,
            ...(typeof details.field === "string" && KB_FIELD_POINTER_RE.test(details.field)
              ? { field: details.field }
              : {}),
          },
        },
      });
    }
    throw new ORPCError(code, { message: mapped.message, data: { code: mapped.code } });
  }
  throw error;
}

const isArgumentReason = (value: unknown): value is KbInvalidArgumentReason =>
  (KB_INVALID_ARGUMENT_REASONS as readonly unknown[]).includes(value);

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
        // Browser-only: each document's display title (the MCP list output is unchanged).
        const items = page.items.map((item) => ({
          ...item,
          title: page.titles.get(item.path) ?? null,
        }));
        if (estimateListPageBytes(items) > 8 * 1024 * 1024) {
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
        return { items, nextCursor };
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
        // Browser-only: who wrote the served document (the MCP output is unchanged).
        return { ...document, provenance: readDocumentProvenance(document.frontMatter) };
      } catch (error) {
        toOrpc(error);
      }
    }),
  /**
   * The document's history on main, newest first: each commit's time,
   * subject, the path's provenance there and who made it (from the server's
   * trailer block only; anything else is unattributed). Same read admission
   * and budget as `get`.
   */
  history: protectedProcedure
    .input(historyPageInput.extend({ kbId, path }))
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
        const headSha = await resolvePinnedRevision(repoPath, undefined, row.headSha, readOptions);
        const page = await readDocumentHistory({
          ...readOptions,
          repoPath,
          headSha,
          path: input.path,
          cursor: input.cursor ?? null,
          limit: input.limit,
          query: prismaAssetQuery(runtime.prisma),
        });
        await authorizeDocumentRead(admission);
        return page;
      } catch (error) {
        toOrpc(error);
      }
    }),
  /**
   * "Recently deleted": documents deleted on main in the last 30 days that
   * its head no longer has, newest first, each with the revision its last
   * version is read (and restored) at. With `path`, that document's latest
   * deletion at any age (its own page).
   * Same read admission and budget as `history`.
   */
  deleted: protectedProcedure
    .input(
      historyPageInput.extend({
        kbId,
        path: path.optional(),
        cursor: z.string().max(80).regex(DELETED_DOCUMENTS_CURSOR).optional(),
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
        const headSha = await resolvePinnedRevision(repoPath, undefined, row.headSha, readOptions);
        const page = await readDeletedDocuments({
          ...readOptions,
          repoPath,
          headSha,
          cursor: input.cursor ?? null,
          limit: input.limit,
          query: prismaAssetQuery(runtime.prisma),
          ...(input.path !== undefined ? { path: input.path } : {}),
        });
        await authorizeDocumentRead(admission);
        return page;
      } catch (error) {
        toOrpc(error);
      }
    }),
  /**
   * Every document path at a revision (main's head by default), for the
   * browser file tree and quick open: paths only, no document bodies, in
   * pages of up to 5000 under a signed cursor pinned to the first page's
   * commit. Browser-only; same read admission and budget as `list`.
   */
  tree: protectedProcedure
    .input(
      z.object({
        kbId,
        rev: sha,
        limit: z.number().int().min(1).max(DOCUMENT_TREE_PAGE_MAX).optional(),
        cursor: z.string().max(1024).nullable().optional(),
      }),
    )
    .handler(async ({ context, input, signal }) => {
      try {
        const readOptions = gitReadOptions({ signal });
        const runtime = getKbRuntime();
        const userId = context.session!.user.id;
        await consumeDocumentTreeBudget(userId);
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
        const actorKey = actorKeyForUser(userId);
        // Its own sort key and filter: a `list` cursor never resumes a tree page, nor the reverse.
        const filterHash = stableFilterHash({ tree: true });
        let afterPath: string | null = null;
        let commitSha: string;
        if (input.cursor) {
          const payload = runtime.cursorSigner.verify(input.cursor, {
            actorKey,
            kbId: input.kbId,
            filterHash,
            sortKey: DOCUMENT_TREE_SORT_KEY,
            revision: "*",
          });
          commitSha = payload.revision;
          if (input.rev && input.rev !== commitSha) {
            throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
          }
          afterPath = payload.lastKey;
        } else {
          commitSha = await resolvePinnedRevision(repoPath, input.rev, row.headSha, readOptions);
        }
        const page = await listDocumentPathsAtRevision({
          ...readOptions,
          reposDir: runtime.reposDir,
          kbId: input.kbId,
          commitSha,
          limit: input.limit ?? DOCUMENT_TREE_PAGE_DEFAULT,
          afterPath,
        });
        await authorizeDocumentRead(admission);
        const nextCursor =
          page.nextAfter === null
            ? null
            : runtime.cursorSigner.sign({
                v: 1,
                actorKey,
                kbId: input.kbId,
                filterHash,
                sortKey: DOCUMENT_TREE_SORT_KEY,
                revision: commitSha,
                lastKey: page.nextAfter,
                exp: cursorExpiry(),
              });
        return { commitSha, paths: page.paths, nextCursor };
      } catch (error) {
        toOrpc(error);
      }
    }),
  /**
   * The KB's recently changed documents: main's first-parent commits that
   * touch documents, newest first, each with who made it (human, agent or
   * unknown, from the server's trailer block only) and the documents it
   * changed. Browser-only; same read admission and budget as `history`.
   */
  recentChanges: protectedProcedure
    .input(historyPageInput.extend({ kbId }))
    .handler(async ({ context, input, signal }) => {
      try {
        const readOptions = gitReadOptions({ signal });
        const runtime = getKbRuntime();
        const userId = context.session!.user.id;
        await consumeRecentChangesBudget(userId);
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
        const headSha = await resolvePinnedRevision(repoPath, undefined, row.headSha, readOptions);
        const page = await readRecentChanges({
          ...readOptions,
          repoPath,
          headSha,
          cursor: input.cursor ?? null,
          limit: input.limit,
          query: prismaAssetQuery(runtime.prisma),
        });
        await authorizeDocumentRead(admission);
        return page;
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
  /**
   * Rename or move one document: a single commit (or auto-PR update, for a
   * propose-only user) that removes `path` and adds the same bytes at
   * `toPath`. Browser-only; the kb/1 protocol has no move op. Same admission,
   * idempotency and proposal handling as `delete`.
   */
  move: protectedProcedure
    .input(
      z.object({
        kbId,
        baseRevision,
        path,
        toPath: path,
        idempotencyKey,
        /** The proposal being edited: set once an edit targets a PR. */
        ...kbContentWriteInputSchema.pick({ proposalNumber: true, proposalHeadSha: true }).shape,
      }),
    )
    .handler(async ({ context, input }) => {
      try {
        return await runDocumentMutation(context.session!.user.id, {
          operation: DOCUMENT_MOVE_OPERATION,
          path: input.path,
          toPath: input.toPath,
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
