import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import { resolveActors } from "../lib/kb/actors";
import { prismaAssetQuery } from "../lib/kb/asset-authz";
import { mapKbDomainError } from "../lib/kb/bases";
import { prFileAttribution } from "../lib/kb/document-history";
import { authorizeDocumentRead } from "../lib/kb/documents-read";
import { kbBareRepoPath } from "../lib/kb/git-read";
import { prismaAuthorityStore } from "../lib/kb/permissions";
import { pullRequestErrorData } from "../lib/kb/pr-conflict";
import { kbReadToolSchemas } from "../lib/kb/protocol/reads";
import { kbWriteToolSchemas } from "../lib/kb/protocol/writes";
import {
  findViewerProposalForPath,
  getPullRequest,
  getPullRequestConflicts,
  listPullRequests,
  mutatePullRequest,
} from "../lib/kb/pull-requests";
import { getKbRuntime } from "../lib/kb/runtime";
import { createProcedureBudget } from "../lib/procedure-budget";

const budget = createProcedureBudget({
  keyPrefix: "rl:kb-pr",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: () => "Pull request request limit reached",
  unavailableMessage: "Pull requests unavailable",
  unavailableLog: "[kb] PR limiter unavailable",
});
async function safe<T>(userId: string, work: () => Promise<T>) {
  await budget(userId);
  try {
    return await work();
  } catch (error) {
    const code = mapKbDomainError(error)?.code ?? "INTERNAL";
    const codes: Record<string, string> = {
      INVALID_ARGUMENT: "BAD_REQUEST",
      INVALID_CURSOR: "BAD_REQUEST",
      NOT_FOUND: "NOT_FOUND",
      FORBIDDEN: "FORBIDDEN",
      CONFLICT: "CONFLICT",
      IDEMPOTENCY_MISMATCH: "CONFLICT",
      RATE_LIMITED: "TOO_MANY_REQUESTS",
      QUOTA_EXCEEDED: "TOO_MANY_REQUESTS",
      STORAGE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
      REPAIR_REQUIRED: "CONFLICT",
    };
    throw new ORPCError(codes[code] ?? "INTERNAL_SERVER_ERROR", {
      message:
        code === "CONFLICT"
          ? "This pull request changed or conflicts with main"
          : "Pull request unavailable",
      data: pullRequestErrorData(error, code),
    });
  }
}
function reads(userId: string) {
  const runtime = getKbRuntime();
  return {
    ...runtime,
    store: prismaAuthorityStore(runtime.prisma),
    principal: { kind: "browser" as const, userId },
    query: prismaAssetQuery(runtime.prisma),
  };
}
/**
 * The browser names the person behind each PR ("Bob Builder via
 * bob-direct", or "via web") and whether it is the viewer, who may then
 * close it with their own `propose` bit. The MCP outputs stay unchanged.
 */
async function withAuthors<T extends { authorActorKey: string }>(
  userId: string,
  items: readonly T[],
) {
  const actors = await resolveActors(
    prismaAssetQuery(getKbRuntime().prisma),
    items.map((item) => item.authorActorKey),
  );
  return items.map((item) => {
    const actor = actors.get(item.authorActorKey);
    return {
      ...item,
      author: {
        // From the actor key, never from the credential's (user-chosen) name.
        kind: item.authorActorKey.startsWith("grant:") ? ("credential" as const) : ("web" as const),
        name: actor?.name ?? null,
        via: actor?.via ?? null,
        isViewer: actor?.userId === userId,
      },
    };
  });
}

export const pullRequestsRouter = {
  list: protectedProcedure
    .input(kbReadToolSchemas.knowledge_pull_requests_list.input)
    .handler(({ context, input, signal }) =>
      safe(context.session.user.id, async () => {
        const runtime = reads(context.session.user.id);
        const page = await listPullRequests({ ...runtime, signal }, input);
        const items = await withAuthors(context.session.user.id, page.items);
        // The author reads ran after the list's own final check: recheck before publishing.
        await authorizeDocumentRead({ ...runtime, kbId: input.kbId, operation: "read" });
        return { ...page, items };
      }),
    ),
  get: protectedProcedure
    .input(kbReadToolSchemas.knowledge_pull_requests_get.input)
    .handler(({ context, input, signal }) =>
      safe(context.session.user.id, async () => {
        const runtime = reads(context.session.user.id);
        const page = await getPullRequest({ ...runtime, signal }, input);
        const [pr] = await withAuthors(context.session.user.id, [page.pr]);
        // Browser-only: who wrote each Markdown file, before and after (MCP output unchanged).
        const attribution = await prFileAttribution({
          signal,
          repoPath: kbBareRepoPath(runtime.reposDir, input.kbId),
          baseSha: page.pr.baseSha,
          headSha: page.pr.headSha,
          files: page.files,
          query: runtime.query,
        });
        // Author and attribution reads ran after the PR read's final check:
        // recheck live read access before publishing any of it.
        await authorizeDocumentRead({ ...runtime, kbId: input.kbId, operation: "read" });
        return {
          ...page,
          pr: pr!,
          files: page.files.map((file) => ({
            ...file,
            beforeProvenance: attribution.get(file.path)?.beforeProvenance ?? null,
            afterProvenance: attribution.get(file.path)?.afterProvenance ?? null,
            writtenBy: attribution.get(file.path)?.writtenBy ?? null,
          })),
        };
      }),
    ),
  /** R3-W6: the paths an open PR still has to resolve, with their versions' revisions. */
  conflicts: protectedProcedure
    .input(kbReadToolSchemas.knowledge_pull_requests_get.input.pick({ kbId: true, number: true }))
    .handler(({ context, input, signal }) =>
      safe(context.session.user.id, () =>
        getPullRequestConflicts({ ...reads(context.session.user.id), signal }, input),
      ),
    ),
  /** R3-W6: the viewer's own open PR changing the document at `path`, if any. */
  forDocument: protectedProcedure
    .input(
      z.object({
        kbId: kbReadToolSchemas.knowledge_pull_requests_get.input.shape.kbId,
        path: z.string().min(1).max(512),
      }),
    )
    .handler(({ context, input, signal }) =>
      safe(context.session.user.id, () =>
        findViewerProposalForPath(
          { ...reads(context.session.user.id), signal, userId: context.session.user.id },
          input,
        ),
      ),
    ),
  create: protectedProcedure
    .input(kbWriteToolSchemas.knowledge_pull_requests_create.input)
    .handler(({ context, input, signal }) =>
      safe(context.session.user.id, () =>
        mutatePullRequest(
          getKbRuntime(),
          context.session.user.id,
          { kind: "create", ...input },
          undefined,
          signal,
        ),
      ),
    ),
  review: protectedProcedure
    .input(kbWriteToolSchemas.knowledge_pull_requests_review.input)
    .handler(({ context, input, signal }) =>
      safe(context.session.user.id, () =>
        mutatePullRequest(
          getKbRuntime(),
          context.session.user.id,
          { kind: "review", ...input },
          undefined,
          signal,
        ),
      ),
    ),
};
