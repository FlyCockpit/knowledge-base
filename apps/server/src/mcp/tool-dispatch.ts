import { randomUUID } from "node:crypto";
import { prismaAssetQuery } from "@knowledge-base/api/lib/kb/asset-authz";
import { listAssets, mutateAsset } from "@knowledge-base/api/lib/kb/assets";
import {
  createKnowledgeBaseAsGrant,
  deleteKnowledgeBase,
  getKnowledgeBaseAttachment,
  listKnowledgeBases,
  mapKbDomainError,
  updateKnowledgeBase,
} from "@knowledge-base/api/lib/kb/bases";
import {
  CHANGES_APPLY_OPERATION,
  changeSummaryTitle,
  changesPublicationForDocument,
  createChangesPublication,
  DOCUMENT_CREATE_OPERATION,
  DOCUMENT_DELETE_OPERATION,
  DOCUMENT_UPDATE_OPERATION,
} from "@knowledge-base/api/lib/kb/changes";
import { cursorExpiry, stableFilterHash } from "@knowledge-base/api/lib/kb/cursor";
import {
  authorizeDocumentRead,
  listDocumentsAtRevision,
  readDocumentAtRevision,
  resolvePinnedRevision,
} from "@knowledge-base/api/lib/kb/documents-read";
import { parseDreamChangesApplyRequest } from "@knowledge-base/api/lib/kb/dream";
import { KbDomainError } from "@knowledge-base/api/lib/kb/errors";
import { prepareExport } from "@knowledge-base/api/lib/kb/exports";
import lexicalOnlyText from "@knowledge-base/api/lib/kb/fixtures/lexical-only-warning.json" with {
  type: "json",
};
import { requestIndexBuild } from "@knowledge-base/api/lib/kb/generations";
import { gitReadOptions, kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import { getIndexProfile } from "@knowledge-base/api/lib/kb/index-status";
import { canonicalRequestHash } from "@knowledge-base/api/lib/kb/operation-intent";
import {
  authorize,
  type KbOperation,
  prismaAuthorityStore,
} from "@knowledge-base/api/lib/kb/permissions";
import { actorKeyFor, tokenHasOauthScope } from "@knowledge-base/api/lib/kb/principal";
import { KB_TOOL_CATALOG, type KbToolName } from "@knowledge-base/api/lib/kb/protocol/catalog";
import {
  buildKbErrorCallToolResult,
  buildKbSuccessCallToolResult,
} from "@knowledge-base/api/lib/kb/protocol/envelope";
import { kbReadToolSchemas } from "@knowledge-base/api/lib/kb/protocol/reads";
import { kbWriteToolSchemas } from "@knowledge-base/api/lib/kb/protocol/writes";
import {
  getPullRequest,
  listPullRequests,
  mutatePullRequest,
} from "@knowledge-base/api/lib/kb/pull-requests";
import { SensitiveQueryError } from "@knowledge-base/api/lib/kb/redact-for-embed";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { resolveSealedReference } from "@knowledge-base/api/lib/kb/sealed-resolve";
import { searchKnowledgeBase } from "@knowledge-base/api/lib/kb/search";
import { structuredSearchKnowledgeBase } from "@knowledge-base/api/lib/kb/structured-search";
import { completeExport, readTransfer } from "@knowledge-base/api/lib/kb/transfers";
import { uploadBegin, uploadFinish, uploadWrite } from "@knowledge-base/api/lib/kb/uploads";
import { logInternalError } from "@knowledge-base/env/log";
import type { z } from "zod";
import type { BearerAdmission } from "./context";

const schemas = { ...kbReadToolSchemas, ...kbWriteToolSchemas };
type Context = {
  runtime: KbRuntimeConfig;
  actor: BearerAdmission;
  signal: AbortSignal;
  masterKey?: string;
  /** The HTTP request id, for the operator log line of an unexpected failure. */
  requestId?: string;
};
type Binding<N extends KbToolName> = (
  input: z.output<(typeof schemas)[N]["input"]>,
  ctx: Context,
) => Promise<unknown>;

/** Why a KB was searched over its lexical-only generation (one fixture shared with `kb mcp`). */
function lexicalOnlyWarning(kbId: string, detail: string): string {
  const why =
    (lexicalOnlyText.why as Record<string, string>)[detail] ?? lexicalOnlyText.why.default;
  return lexicalOnlyText.template.replace("{kbId}", kbId).replace("{why}", why);
}

/** One-line MCP text warning per search notice (the JSON envelope stays first). */
export function indexNoticeWarnings(data: unknown): string[] {
  const output = data as { indexNotices?: unknown; items?: Array<{ mode?: string }> };
  const notices = output.indexNotices;
  // Structured exact-filter pages (including empty pages) perform no semantic ranking.
  const structured =
    Array.isArray(output.items) &&
    output.items.length > 0 &&
    output.items.every((item) => item.mode === "structured");
  if (!Array.isArray(notices)) return [];
  return notices.map((notice: { kbId: string; code: string; detail: string }) =>
    notice.code === "LEXICAL_ONLY"
      ? lexicalOnlyWarning(notice.kbId, notice.detail)
      : structured
        ? `Warning: knowledge base ${notice.kbId} was searched with exact structured filters using its previous index; ${notice.detail === "EMBEDDING_RUNTIME_RELOADING" ? "the built-in embedding runtime is reloading" : "embedding rebuild pending"}.`
        : Array.isArray(output.items) && output.items.length === 0
          ? `Warning: knowledge base ${notice.kbId} was searched using its previous index; ${notice.detail === "EMBEDDING_RUNTIME_RELOADING" ? "the built-in embedding runtime is reloading" : "embedding rebuild pending"}.`
          : notice.detail === "EMBEDDING_MODEL_CHANGED"
            ? `Warning: knowledge base ${notice.kbId} was searched lexical-only because the built-in embedding model changed; rebuild pending.`
            : notice.detail === "EMBEDDING_RUNTIME_RELOADING"
              ? `Warning: knowledge base ${notice.kbId} was searched lexical-only because the built-in embedding runtime is reloading with new settings; semantic ranking returns shortly.`
              : `Warning: semantic ranking for knowledge base ${notice.kbId} came from an index built with the previous embedding settings; rebuild pending.`,
  );
}

export function toolSuccess(name: KbToolName, data: unknown) {
  const parsed = schemas[name].output.parse(data);
  return buildKbSuccessCallToolResult(parsed, indexNoticeWarnings(parsed));
}
/** Codes that mean the server failed, not the caller: the operator must see the cause (R3-W3). */
const LOGGED_FAILURES = new Set(["INTERNAL", "STORAGE_UNAVAILABLE"]);
export function toolFailure(
  error: unknown,
  context: { tool?: string; kbId?: string | null; requestId?: string } = {},
) {
  const result = toolFailureResult(error);
  const code = (result.structuredContent as { error?: { code?: string } }).error?.code;
  if (code && LOGGED_FAILURES.has(code))
    logInternalError("mcp.tool", error, {
      requestId: context.requestId,
      tool: context.tool,
      kbId: context.kbId ?? undefined,
      code,
    });
  return result;
}
function toolFailureResult(error: unknown) {
  try {
    if (error instanceof SensitiveQueryError) return buildKbErrorCallToolResult("SENSITIVE_QUERY");
    if (error instanceof DOMException && error.name === "AbortError")
      return buildKbErrorCallToolResult("CANCELLED");
    if (error instanceof DOMException && error.name === "TimeoutError")
      return buildKbErrorCallToolResult("DEADLINE_EXCEEDED");
    const mapped = mapKbDomainError(error);
    if (mapped)
      return buildKbErrorCallToolResult(
        mapped.code,
        mapped.retryAfterSeconds === undefined
          ? mapped.details
          : { retryAfterSeconds: mapped.retryAfterSeconds },
      );
  } catch {
    /* Bad domain details never become an unvalidated response. */
  }
  return buildKbErrorCallToolResult("INTERNAL");
}
function readContext(ctx: Context, kbId: string) {
  return {
    ...ctx.runtime,
    ...ctx.actor,
    kbId,
    operation: "read" as const,
    store: prismaAuthorityStore(ctx.runtime.prisma),
    query: prismaAssetQuery(ctx.runtime.prisma),
  };
}
async function documents(
  ctx: Context,
  input: z.output<typeof kbReadToolSchemas.knowledge_documents_list.input> & { path?: string },
) {
  const readOptions = gitReadOptions({ signal: ctx.signal });
  const read = readContext(ctx, input.kbId);
  await authorizeDocumentRead(read);
  const row = await ctx.runtime.prisma.knowledgeBase.findUnique({
    where: { id: input.kbId },
    select: { headSha: true },
  });
  const binding = {
    actorKey: actorKeyFor(ctx.actor.principal),
    kbId: input.kbId,
    filterHash: stableFilterHash({ prefix: input.prefix ?? null }),
    sortKey: "path:asc",
    revision: "*",
  };
  const cursor = input.cursor ? ctx.runtime.cursorSigner.verify(input.cursor, binding) : null;
  if (cursor && input.rev && input.rev !== cursor.revision)
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const commitSha = await resolvePinnedRevision(
    kbBareRepoPath(ctx.runtime.reposDir, input.kbId),
    cursor?.revision ?? input.rev,
    row?.headSha ?? null,
    readOptions,
  );
  const pinned = { ...readOptions, reposDir: ctx.runtime.reposDir, kbId: input.kbId, commitSha };
  const result =
    input.path !== undefined
      ? await readDocumentAtRevision({ ...pinned, path: input.path, query: read.query })
      : await (async () => {
          const page = await listDocumentsAtRevision({
            ...pinned,
            prefix: input.prefix,
            limit: input.limit ?? 20,
            afterPath: cursor?.lastKey ?? null,
          });
          return {
            items: page.items,
            nextCursor:
              page.nextAfter === null
                ? null
                : ctx.runtime.cursorSigner.sign({
                    ...binding,
                    v: 1,
                    revision: commitSha,
                    lastKey: page.nextAfter,
                    exp: cursor?.exp ?? cursorExpiry(),
                  }),
          };
        })();
  await authorizeDocumentRead(read);
  return result;
}
function publish(
  ctx: Context,
  kbId: string,
  publication: ReturnType<typeof createChangesPublication>,
) {
  return ctx.runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [kbId],
    barrier: publication.barrier,
    run: (op) => {
      const executor = ctx.runtime.createGitExecutor?.(op, kbId);
      if (!executor) throw new KbDomainError("STORAGE_UNAVAILABLE", "Storage unavailable");
      return publication.publish(op.lease, executor);
    },
  });
}
async function liveAttachmentReceipt(ctx: Context, result: Promise<Record<string, unknown>>) {
  const data = kbWriteToolSchemas.knowledge_bases_create.output.parse(await result);
  return {
    ...data,
    kb: await getKnowledgeBaseAttachment(
      ctx.runtime,
      ctx.actor.principal,
      data.kb.id,
      ctx.actor.verifier,
    ),
  };
}
function publicationContext(ctx: Context, input: { kbId: string; idempotencyKey: string }) {
  return {
    ...ctx.runtime,
    ...ctx.actor,
    ...input,
    store: prismaAuthorityStore(ctx.runtime.prisma),
  };
}
const bindings: { [N in KbToolName]: Binding<N> } = {
  knowledge_bases_list: (i, c) =>
    listKnowledgeBases(c.runtime, c.actor.principal, i, c.actor.verifier),
  knowledge_bases_get: async (i, c) => ({
    index: (await getIndexProfile(c.runtime, c.actor, i.kbId)).index,
    kb: await getKnowledgeBaseAttachment(c.runtime, c.actor.principal, i.kbId, c.actor.verifier),
  }),
  knowledge_bases_create: (i, c) =>
    liveAttachmentReceipt(
      c,
      createKnowledgeBaseAsGrant(c.runtime, c.actor.principal, c.actor.verifier, i),
    ),
  knowledge_bases_update: (i, c) =>
    liveAttachmentReceipt(
      c,
      updateKnowledgeBase(c.runtime, c.actor.principal, i, c.actor.verifier),
    ),
  knowledge_bases_delete: (i, c) =>
    deleteKnowledgeBase(c.runtime, c.actor.principal, i, c.actor.verifier),
  knowledge_documents_list: (i, c) => documents(c, i),
  knowledge_documents_get: (i, c) => documents(c, i),
  knowledge_search: (i, c) =>
    searchKnowledgeBase({ ...c.runtime, masterKey: c.masterKey }, c.actor, i, c.signal),
  knowledge_structured_search: (i, c) =>
    structuredSearchKnowledgeBase({ ...c.runtime, masterKey: c.masterKey }, c.actor, i, c.signal),
  knowledge_changes_apply: ({ kbId, idempotencyKey, ...input }, c) => {
    // An omitted `sourceSessionIds` is the empty list, for the request hash too.
    const request = {
      ...input,
      title: input.title ?? changeSummaryTitle(input.changes),
      sourceSessionIds: input.sourceSessionIds ?? [],
    };
    return publish(
      c,
      kbId,
      createChangesPublication({
        ...publicationContext(c, { kbId, idempotencyKey }),
        request:
          request.mode === "dream"
            ? parseDreamChangesApplyRequest(request)
            : { ...request, mode: "edit" },
        operation: CHANGES_APPLY_OPERATION,
        requestHash: canonicalRequestHash({ kbId, ...request }),
      }),
    );
  },
  knowledge_documents_create: (i, c) =>
    publish(
      c,
      i.kbId,
      changesPublicationForDocument({
        ...publicationContext(c, i),
        baseRevision: i.baseRevision,
        proposalNumber: i.proposalNumber,
        proposalHeadSha: i.proposalHeadSha,
        request: {
          operation: DOCUMENT_CREATE_OPERATION,
          path: i.path,
          content: i.content,
          idempotencyKey: i.idempotencyKey,
        },
      }),
    ),
  knowledge_documents_update: (i, c) =>
    publish(
      c,
      i.kbId,
      changesPublicationForDocument({
        ...publicationContext(c, i),
        baseRevision: i.baseRevision,
        proposalNumber: i.proposalNumber,
        proposalHeadSha: i.proposalHeadSha,
        request: {
          operation: DOCUMENT_UPDATE_OPERATION,
          path: i.path,
          content: i.content,
          idempotencyKey: i.idempotencyKey,
        },
      }),
    ),
  knowledge_documents_delete: (i, c) =>
    publish(
      c,
      i.kbId,
      changesPublicationForDocument({
        ...publicationContext(c, i),
        baseRevision: i.baseRevision,
        proposalNumber: i.proposalNumber,
        proposalHeadSha: i.proposalHeadSha,
        request: {
          operation: DOCUMENT_DELETE_OPERATION,
          path: i.path,
          idempotencyKey: i.idempotencyKey,
        },
      }),
    ),
  knowledge_upload_begin: (i, c) =>
    uploadBegin(c.runtime, { ...c.actor, signal: c.signal }, c.runtime.assetsDir, i),
  knowledge_upload_write: (i, c) =>
    uploadWrite(c.runtime, { ...c.actor, signal: c.signal }, c.runtime.assetsDir, i),
  knowledge_upload_finish: (i, c) =>
    uploadFinish(c.runtime, { ...c.actor, signal: c.signal }, c.runtime.assetsDir, i),
  knowledge_assets_put: (i, c) =>
    mutateAsset(c.runtime, c.actor.principal, "put", i, c.actor.verifier),
  knowledge_assets_import: (i, c) =>
    mutateAsset(c.runtime, c.actor.principal, "import", i, c.actor.verifier),
  knowledge_assets_list: (i, c) =>
    listAssets(c.runtime, c.actor.principal, i, c.actor.verifier, { signal: c.signal }),
  knowledge_export_prepare: (i, c) => prepareExport(c.runtime, c.actor, i, { signal: c.signal }),
  knowledge_transfer_read: (i, c) => readTransfer(c.runtime, c.actor, i),
  knowledge_export_complete: (i, c) => completeExport(c.runtime, c.actor, i),
  knowledge_index_status: async (i, c) => (await getIndexProfile(c.runtime, c.actor, i.kbId)).index,
  knowledge_index_rebuild: (i, c) => requestIndexBuild(c.runtime, c.actor, i),
  knowledge_embedding_profile_get: (i, c) => getIndexProfile(c.runtime, c.actor, i.kbId),
  knowledge_embedding_profile_set: (i, c) => requestIndexBuild(c.runtime, c.actor, i),
  knowledge_pull_requests_list: (i, c) =>
    listPullRequests({ ...readContext(c, i.kbId), signal: c.signal }, i),
  knowledge_pull_requests_get: (i, c) =>
    getPullRequest({ ...readContext(c, i.kbId), signal: c.signal }, i),
  knowledge_pull_requests_create: (i, c) =>
    mutatePullRequest(
      c.runtime,
      c.actor.principal,
      { kind: "create", ...i },
      c.actor.verifier,
      c.signal,
    ),
  knowledge_pull_requests_review: (i, c) =>
    mutatePullRequest(
      c.runtime,
      c.actor.principal,
      { kind: "review", ...i },
      c.actor.verifier,
      c.signal,
    ),
  knowledge_sealed_resolve: (i, c) =>
    resolveSealedReference(c.runtime, c.actor.principal, i, {
      masterKey: c.masterKey,
      signal: c.signal,
      verifier: {
        ...c.actor.verifier,
        inspect: async (principal) => {
          if (!principal.credential)
            throw new KbDomainError("UNRESOLVED_REFERENCE", "Unresolved reference");
          return {
            ...(await c.actor.verifier.inspect(principal)),
            consumerKind: principal.credential.kind === "PAT" ? "pat" : "oauth",
          };
        },
      },
    }),
};

/** Cancellation stops new reservations; a durable reservation still owns publication/recovery. */
function requestRuntime(runtime: KbRuntimeConfig, signal: AbortSignal): KbRuntimeConfig {
  return {
    ...runtime,
    coordinator: {
      run: (options) => {
        signal.throwIfAborted();
        const barrier = options.barrier;
        return runtime.coordinator.run({
          ...options,
          barrier: barrier
            ? {
                prepare: async (lease) => {
                  signal.throwIfAborted();
                  await barrier.prepare?.(lease);
                },
                reauthorize: async (context) => {
                  signal.throwIfAborted();
                  await barrier.reauthorize(context);
                  signal.throwIfAborted();
                },
                reservePublication: async (context) => {
                  signal.throwIfAborted();
                  await barrier.reservePublication(context);
                },
              }
            : undefined,
          run: (context) => {
            if (!barrier) signal.throwIfAborted();
            return options.run(context);
          },
        });
      },
    },
  };
}

/** The only dispatch table: callers cannot name routers or supply an identity/namespace. */
export async function dispatchTool<N extends KbToolName>(
  name: N,
  input: z.output<(typeof schemas)[N]["input"]>,
  base: Context,
) {
  const kbId = "kbId" in input && typeof input.kbId === "string" ? input.kbId : null;
  const entry = KB_TOOL_CATALOG[name];
  // The call's admission is derived with the tool's group demand, so every
  // recheck (first, final and error-path) and every domain or lock-held
  // authorization enforces it. Supporting tools demand no group. A call is
  // allowed by the connection's live groups, never by what the tool list showed.
  const ctx: Context = { ...base, actor: base.actor.demandToolGroups(entry.groups) };
  try {
    ctx.signal.throwIfAborted();
    await ctx.actor.recheck();
    // Tombstone receipt replay is actor-bound and reauthorized inside the lifecycle service.
    if (kbId && name !== "knowledge_bases_delete" && name !== "knowledge_sealed_resolve") {
      const operation: KbOperation =
        entry.minimumAccess.kind === "permission" ? entry.minimumAccess.bit : "read";
      await authorize({ ...readContext(ctx, kbId), operation });
    }
    if (!tokenHasOauthScope(ctx.actor.principal.scopes, entry.requiredMcpScope === "mcp:write"))
      throw new KbDomainError("FORBIDDEN", "Forbidden");
    if (name === "knowledge_transfer_read") {
      // Final authority/signal checks and response validation belong to the EOF
      // transaction. A denied final reply must roll back this attempt's grace.
      let response: ReturnType<typeof toolSuccess> | undefined;
      const transfer = kbReadToolSchemas.knowledge_transfer_read.input.parse(input);
      await readTransfer(requestRuntime(ctx.runtime, ctx.signal), ctx.actor, transfer, {
        signal: ctx.signal,
        finalize: async (frame) => {
          ctx.signal.throwIfAborted();
          await ctx.actor.recheck();
          await authorizeDocumentRead(readContext(ctx, transfer.kbId));
          ctx.signal.throwIfAborted();
          response = toolSuccess("knowledge_transfer_read", frame);
        },
      });
      if (!response) throw new KbDomainError("STORAGE_UNAVAILABLE", "Transfer unavailable");
      return response;
    }
    const data = await bindings[name](input, {
      ...ctx,
      runtime: requestRuntime(ctx.runtime, ctx.signal),
    });
    ctx.signal.throwIfAborted();
    await ctx.actor.recheck();
    if (kbId && name !== "knowledge_bases_delete" && name !== "knowledge_sealed_resolve")
      await authorizeDocumentRead(readContext(ctx, kbId));
    return toolSuccess(name, data);
  } catch (error) {
    // Error details are a publication too: conflicts and index diagnostics can
    // outlive the domain lock and a share. Keep the actor-bound delete receipt
    // and uniformly sealed resolution on their own admission boundaries.
    if (kbId && name !== "knowledge_bases_delete" && name !== "knowledge_sealed_resolve") {
      try {
        ctx.signal.throwIfAborted();
        await ctx.actor.recheck();
        await authorize(readContext(ctx, kbId));
        ctx.signal.throwIfAborted();
      } catch (denial) {
        return toolFailure(ctx.signal.aborted ? ctx.signal.reason : denial, {
          tool: name,
          kbId,
          requestId: ctx.requestId,
        });
      }
    }
    return toolFailure(ctx.signal.aborted ? ctx.signal.reason : error, {
      tool: name,
      kbId,
      requestId: ctx.requestId,
    });
  }
}
