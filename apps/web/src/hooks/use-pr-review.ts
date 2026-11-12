import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import z from "zod";
import type { KbViewerDocument } from "@/components/kb/markdown-view";
import { type KbAccessActor, recheckKbAccess } from "@/hooks/use-kb-editor";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";

/**
 * Browser half of reviewed PR merge/close (CONTRACT `knowledge_pull_requests_get`
 * / `_review`). The reviewed revisions are exactly the head/target the FIRST
 * loaded diff page displayed; every later page must carry the same SHAs (the
 * server's cursor pins them) or the diff is marked drifted and cannot be
 * reviewed. Submissions only ever send those displayed SHAs. A CONFLICT never
 * triggers a resubmission (or a re-read to guess why): the server's structured
 * details decide the message, and the user must refresh to review again.
 */

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const assetRef = z.object({
  path: z.string(),
  hash: z.string(),
  size: z.number(),
  mime: z.string(),
});
const prSummarySchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.literal("main"),
  baseSha: sha,
  headSha: sha,
  targetSha: sha,
  status: z.enum(["OPEN", "CONFLICT", "CLOSED", "MERGED"]),
  authorActorKey: z.string(),
  version: z.number().int(),
  mergeCommitSha: sha.nullable(),
  /** The person behind the PR (browser only); absent in review receipts. */
  author: z
    .object({ name: z.string().nullable(), via: z.string().nullable(), isViewer: z.boolean() })
    .optional(),
});
const reviewResultSchema = z.object({ operationId: z.string(), pr: prSummarySchema });

export type PrSummary = z.infer<typeof prSummarySchema>;
export type AssetRefLike = z.infer<typeof assetRef>;
export type FileDelta = {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeBlobSha: string | null;
  afterBlobSha: string | null;
};
export type AssetDelta = { path: string; before: AssetRefLike | null; after: AssetRefLike | null };
export type PrPage = {
  pr: PrSummary;
  files: FileDelta[];
  touchedAssets: AssetDelta[];
  nextCursor: string | null;
};

export type ReviewedDiff = {
  /** Summary of the first page: its baseSha/headSha/targetSha are the reviewed revisions. */
  pr: PrSummary;
  files: FileDelta[];
  touchedAssets: AssetDelta[];
  /** True only once the final page (nextCursor null) of the SAME revisions loaded. */
  complete: boolean;
  /** A later page reported other revisions; its rows were discarded. */
  drift: boolean;
};

const sameRevisions = (a: PrSummary, b: PrSummary) =>
  a.baseSha === b.baseSha && a.headSha === b.headSha && a.targetSha === b.targetSha;

export function collectDiff(pages: readonly PrPage[]): ReviewedDiff | null {
  const first = pages[0];
  if (!first) return null;
  const files: FileDelta[] = [];
  const touchedAssets: AssetDelta[] = [];
  let drift = false;
  let complete = false;
  for (const page of pages) {
    if (!sameRevisions(first.pr, page.pr)) {
      drift = true;
      break;
    }
    files.push(...page.files);
    touchedAssets.push(...page.touchedAssets);
    complete = page.nextCursor === null;
  }
  return { pr: first.pr, files, touchedAssets, complete: complete && !drift, drift };
}

export type ReviewControls = {
  showMerge: boolean;
  canMerge: boolean;
  canClose: boolean;
  /** A reviewer sees Merge, disabled, while the PR conflicts with main. */
  mergeBlocked: boolean;
};

/**
 * Merge needs `review`; close needs `review` or the author with `propose`.
 * The author is the person: the server marks a PR opened by any of the
 * viewer's credentials; without that mark, the exact actor key decides.
 */
export function reviewControls(input: {
  bits: readonly string[];
  viewerActorKey: string | null;
  pr: PrSummary;
}): ReviewControls {
  const { bits, pr } = input;
  const review = bits.includes("read") && bits.includes("review");
  const active = pr.status === "OPEN" || pr.status === "CONFLICT";
  const isViewer =
    pr.author?.isViewer ??
    (input.viewerActorKey !== null && input.viewerActorKey === pr.authorActorKey);
  const author = isViewer && bits.includes("propose");
  return {
    showMerge: review,
    canMerge: review && pr.status === "OPEN",
    canClose: active && (review || author),
    mergeBlocked: review && pr.status === "CONFLICT",
  };
}

export type ReviewDecision = "merge" | "close";

/** Merge requires the complete, un-drifted diff; close requires un-drifted revisions. */
export function reviewReady(diff: ReviewedDiff | null, decision: ReviewDecision): boolean {
  if (!diff || diff.drift) return false;
  return decision === "merge" ? diff.complete : true;
}

export type ReviewOutcome =
  | { kind: "merged"; mergeCommitSha: string | null }
  | { kind: "closed" }
  /**
   * The reviewed revisions are no longer current (server details):
   * main (`targetMoved`) and/or the proposal head (`headMoved`) moved. Both
   * false only when the server gave no readable details. View the new diff.
   */
  | { kind: "changed"; targetMoved: boolean; headMoved: boolean }
  /** The PR was closed or merged elsewhere meanwhile: view its current state. */
  | { kind: "stateChanged" }
  /** Same revisions, unmergeable content: the PR conflicts with main. */
  | { kind: "conflict" }
  | { kind: "incomplete" }
  | { kind: "forbidden" }
  | { kind: "retryable" }
  | { kind: "error" };

export type ReviewMemory = { fingerprint: string | null; key: string | null };
export const initialReviewMemory = (): ReviewMemory => ({ fingerprint: null, key: null });

export type ReviewInput = {
  kbId: string;
  number: number;
  decision: ReviewDecision;
  confirm: "MERGE" | "CLOSE";
  expectedHeadSha: string;
  expectedTargetSha: string;
  idempotencyKey: string;
};
export type ReviewDeps = {
  review: (input: ReviewInput) => Promise<unknown>;
  newKey: () => string;
};

const conflictSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("revision_moved"),
    targetMoved: z.boolean(),
    headMoved: z.boolean(),
  }),
  z.object({ kind: z.literal("content_conflict") }),
  z.object({ kind: z.literal("state_changed") }),
]);

/**
 * The outcome of a review CONFLICT, straight from the server's structured
 * details (`data.conflict`). Missing or unreadable details are treated as
 * moved revisions: the safe reading, which requires viewing the diff again.
 */
export function conflictOutcome(error: unknown): ReviewOutcome {
  const parsed = conflictSchema.safeParse(
    (error as { data?: { conflict?: unknown } } | null)?.data?.conflict,
  );
  if (!parsed.success) return { kind: "changed", targetMoved: false, headMoved: false };
  switch (parsed.data.kind) {
    case "revision_moved":
      return {
        kind: "changed",
        targetMoved: parsed.data.targetMoved,
        headMoved: parsed.data.headMoved,
      };
    case "content_conflict":
      return { kind: "conflict" };
    case "state_changed":
      return { kind: "stateChanged" };
  }
}

const errorCode = (error: unknown): string | undefined => {
  const e = error as { code?: unknown; data?: { code?: unknown } } | null;
  if (typeof e?.data?.code === "string") return e.data.code;
  return typeof e?.code === "string" ? e.code : undefined;
};

export async function runReview(
  deps: ReviewDeps,
  memory: ReviewMemory,
  input: { kbId: string; diff: ReviewedDiff; decision: ReviewDecision },
): Promise<{ outcome: ReviewOutcome; memory: ReviewMemory }> {
  const { diff, decision } = input;
  if (!reviewReady(diff, decision)) return { outcome: { kind: "incomplete" }, memory };
  const fingerprint = [
    input.kbId,
    diff.pr.number,
    decision,
    diff.pr.headSha,
    diff.pr.targetSha,
  ].join(":");
  const key = memory.fingerprint === fingerprint && memory.key ? memory.key : deps.newKey();
  const pending: ReviewMemory = { fingerprint, key };
  const settled = (outcome: ReviewOutcome) => ({ outcome, memory: initialReviewMemory() });
  let response: unknown;
  try {
    response = await deps.review({
      kbId: input.kbId,
      number: diff.pr.number,
      decision,
      confirm: decision === "merge" ? "MERGE" : "CLOSE",
      expectedHeadSha: diff.pr.headSha,
      expectedTargetSha: diff.pr.targetSha,
      idempotencyKey: key,
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "CONFLICT") return settled(conflictOutcome(error));
    if (code === "FORBIDDEN" || code === "NOT_FOUND") return settled({ kind: "forbidden" });
    if (code === "BAD_REQUEST" || code === "INVALID_ARGUMENT" || code === "IDEMPOTENCY_MISMATCH")
      return settled({ kind: "error" });
    // Unknown outcome: a retry of this exact review reuses the key and gets the receipt.
    return { outcome: { kind: "retryable" }, memory: pending };
  }
  const parsed = reviewResultSchema.safeParse(response);
  if (!parsed.success) return settled({ kind: "error" });
  const pr = parsed.data.pr;
  if (pr.status === "MERGED") return settled({ kind: "merged", mergeCommitSha: pr.mergeCommitSha });
  if (pr.status === "CLOSED") return settled({ kind: "closed" });
  return settled({ kind: "error" });
}

/** Transport for the review page; the route binds oRPC, the browser harness the fixture. */
export type PrReviewSources = {
  /** Query key for the diff pages; KB-scoped so access loss clears it. */
  pageKey: readonly unknown[];
  fetchPage: (cursor: string | null) => Promise<PrPage>;
  review: (input: ReviewInput) => Promise<unknown>;
  loadDocument: (input: { kbId: string; path: string; rev: string }) => Promise<KbViewerDocument>;
};

export const PR_DIFF_PAGE_LIMIT = 50;

export type PrReviewState = ReturnType<typeof usePrReview>;

/** The caller keys the owning component by KB, PR and actor identity. */
export function usePrReview(input: {
  kbId: string;
  actor: KbAccessActor;
  sources: PrReviewSources;
  enabled?: boolean;
}) {
  const { kbId, actor, sources } = input;
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  // Explicit refresh retires pending results even while this owner stays mounted.
  const generation = useRef(0);
  const submitting = useRef(false);
  const pages = useInfiniteQuery({
    queryKey: sources.pageKey,
    queryFn: ({ pageParam }) => sources.fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: PrPage) => last.nextCursor ?? undefined,
    // The displayed diff IS the review: never swap it for fresher data behind the user.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
    enabled: input.enabled ?? true,
  });
  const diff = collectDiff(pages.data?.pages ?? []);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [pending, setPending] = useState(false);
  const memory = useRef<ReviewMemory>(initialReviewMemory());

  const submit = useCallback(
    async (decision: ReviewDecision) => {
      if (submitting.current || !session.current || !diff) return;
      const started = generation.current;
      const current = () => session.current && generation.current === started;
      submitting.current = true;
      setPending(true);
      try {
        const run = await runReview(
          { review: sources.review, newKey: () => crypto.randomUUID() },
          memory.current,
          { kbId, diff, decision },
        );
        if (run.outcome.kind === "forbidden") {
          // Merge/close may be refused while read access remains. Only the
          // fresh KB permission check can decide whether to forget this diff,
          // including a cached successor after this UI owner has retired.
          await recheckKbAccess(queryClient, kbId, undefined, actor);
        }
        if (!current()) return;
        memory.current = run.memory;
        setOutcome(run.outcome);
        if (run.outcome.kind === "merged" || run.outcome.kind === "closed") {
          // The terminal PR is immutable: reload it to show the recorded result.
          await queryClient.resetQueries({ queryKey: sources.pageKey });
        }
      } finally {
        if (current()) {
          submitting.current = false;
          setPending(false);
        }
      }
    },
    [session, diff, sources, kbId, actor, queryClient],
  );

  /** Explicit user action: drop the reviewed diff and load the current one from page 1. */
  const refresh = useCallback(async () => {
    if (!session.current) return;
    generation.current += 1;
    submitting.current = false;
    setPending(false);
    memory.current = initialReviewMemory();
    setOutcome(null);
    await queryClient.resetQueries({ queryKey: sources.pageKey });
  }, [session, queryClient, sources.pageKey]);

  return {
    diff,
    isPending: pages.isPending,
    isError: pages.isError,
    error: pages.error,
    refetch: pages.refetch,
    hasNextPage: pages.hasNextPage,
    isFetchingNextPage: pages.isFetchingNextPage,
    loadMore: () => pages.fetchNextPage(),
    outcome,
    pending,
    submit,
    refresh,
  };
}
