import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@knowledge-base/ui/components/alert-dialog";
import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { PrDiff } from "@/components/kb/pr-diff";
import { PR_STATUS_KEY, PR_STATUS_TONE } from "@/components/kb/pr-status";
import { StatusPill } from "@/components/status-pill";
import {
  type PrReviewSources,
  type PrReviewState,
  type PrSummary,
  type ReviewControls,
  type ReviewDecision,
  type ReviewedDiff,
  type ReviewOutcome,
  reviewControls,
  reviewReady,
} from "@/hooks/use-pr-review";
import { orpc } from "@/utils/orpc";

const short = (sha: string) => sha.slice(0, 12);

/** "Opened by Bob Builder via bob-direct" or "… via web"; nothing without an author. */
export function PrAuthor({
  author,
  className,
}: {
  author: PrSummary["author"];
  className?: string;
}) {
  const { t } = useTranslation("kb");
  if (!author) return null;
  const name = author.name ?? t("pr.author.unknown");
  return (
    <span data-testid="pr-author" className={className}>
      {author.via === null
        ? t("pr.author.web", { name })
        : t("pr.author.token", { name, via: author.via })}
    </span>
  );
}

/** Which reviewed revision moved, from the server's structured conflict details. */
function movedReason(outcome: Extract<ReviewOutcome, { kind: "changed" }>) {
  if (outcome.targetMoved && outcome.headMoved) return "both";
  if (outcome.targetMoved) return "target";
  if (outcome.headMoved) return "head";
  return "unknown";
}

/** Presentational review actions. The SHAs shown are exactly the ones a click submits. */
export function PrActionsView({
  pr,
  controls,
  mergeReady,
  closeReady,
  outcome,
  pending,
  onMerge,
  onClose,
  onRefresh,
}: {
  pr: PrSummary;
  controls: ReviewControls;
  mergeReady: boolean;
  closeReady: boolean;
  outcome: ReviewOutcome | null;
  pending: boolean;
  onMerge: () => void;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("kb");
  // A review attempt that found moved revisions (or a PR closed/merged
  // elsewhere) retires this diff until refreshed.
  const stale = outcome?.kind === "changed" || outcome?.kind === "stateChanged";
  const conflicted = outcome?.kind === "conflict" || pr.status === "CONFLICT";
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
      aria-labelledby="pr-review-title"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="pr-review-title" className="font-semibold">
          {t("pr.review.title")}
        </h3>
        <StatusPill data-testid="pr-status" tone={PR_STATUS_TONE[pr.status]}>
          {t(`pr.status.${PR_STATUS_KEY[pr.status]}`)}
        </StatusPill>
      </div>
      {pr.status === "MERGED" ? (
        <div className="space-y-1 text-sm" data-testid="pr-merge-commit">
          <p>{t("pr.review.mergedAs")}</p>
          <CopyField value={pr.mergeCommitSha ?? pr.headSha} copyLabel={t("pr.review.copySha")} />
        </div>
      ) : pr.status === "CLOSED" ? (
        <p className="text-sm text-muted-foreground">{t("pr.review.closedNote")}</p>
      ) : (
        <dl className="grid gap-1 text-xs sm:grid-cols-[auto_1fr] sm:gap-x-3">
          <dt className="text-muted-foreground">{t("pr.review.reviewedHead")}</dt>
          <dd data-testid="pr-reviewed-head" className="font-mono">
            {short(pr.headSha)}
          </dd>
          <dt className="text-muted-foreground">{t("pr.review.reviewedTarget")}</dt>
          <dd data-testid="pr-reviewed-target" className="font-mono">
            {short(pr.targetSha)}
          </dd>
        </dl>
      )}
      {conflicted && pr.status !== "MERGED" && pr.status !== "CLOSED" && (
        <p id="pr-conflict" role="alert" data-testid="pr-conflict" className="text-sm font-medium">
          {t("pr.review.conflicts")}
        </p>
      )}
      {outcome && outcome.kind !== "conflict" && outcome.kind !== "merged" && (
        <div
          data-testid="pr-outcome"
          data-kind={outcome.kind}
          data-reason={outcome.kind === "changed" ? movedReason(outcome) : undefined}
          role={outcome.kind === "closed" ? "status" : "alert"}
          className="space-y-2 text-sm"
        >
          <p>
            {outcome.kind === "changed"
              ? t(`pr.outcome.moved.${movedReason(outcome)}`)
              : t(`pr.outcome.${outcome.kind}`)}
          </p>
          {stale && (
            <Button data-testid="pr-refresh" className="min-h-[44px]" onClick={onRefresh}>
              {t("pr.review.refresh")}
            </Button>
          )}
        </div>
      )}
      {(controls.canMerge || controls.canClose || controls.mergeBlocked) && (
        <div className="flex flex-wrap gap-2">
          {controls.showMerge && (controls.canMerge || controls.mergeBlocked) && (
            <Button
              data-testid="pr-merge"
              className="min-h-[44px]"
              disabled={controls.mergeBlocked || !mergeReady || stale || pending}
              aria-describedby={controls.mergeBlocked ? "pr-conflict" : undefined}
              onClick={onMerge}
            >
              {t("pr.review.merge")}
            </Button>
          )}
          {controls.canClose && (
            <Button
              data-testid="pr-close"
              variant="outline"
              className="min-h-[44px]"
              disabled={!closeReady || stale || pending}
              onClick={onClose}
            >
              {t("pr.review.close")}
            </Button>
          )}
        </div>
      )}
      {controls.showMerge && controls.canMerge && !mergeReady && !stale && (
        <p className="text-xs text-muted-foreground">{t("pr.review.loadAllFirst")}</p>
      )}
    </section>
  );
}

/** One path an active PR still has to resolve (`pullRequests.conflicts`). */
export type PrConflictPath = {
  path: string;
  kind: "document" | "asset";
  recorded: boolean;
  standing: boolean;
};

/**
 * The paths this PR still conflicts on (R3-W6). The author resolves a
 * document by saving it in PR mode (against current main with the PR's
 * number); assets are resolved by re-adding or removing them over MCP.
 */
export function PrConflictsView({
  lang,
  kbId,
  number,
  paths,
  truncated,
  canResolve: author,
  isDream,
}: {
  lang: string;
  kbId: string;
  number: number;
  paths: readonly PrConflictPath[];
  truncated: boolean;
  /** The viewer authored this PR and can edit it from the web. */
  canResolve: boolean;
  /** A dream's PR is only ever updated by the run that dreamed it. */
  isDream: boolean;
}) {
  const { t } = useTranslation("kb");
  if (paths.length === 0) return null;
  const canResolve = author && !isDream;
  const hasAsset = paths.some((item) => item.kind === "asset");
  return (
    <section
      data-testid="pr-conflicts"
      aria-labelledby="pr-conflicts-title"
      className="min-w-0 space-y-3 rounded-xl bg-card p-4 ring-1 ring-destructive/30"
    >
      <h3 id="pr-conflicts-title" className="font-semibold">
        {t("pr.conflicts.title", { count: paths.length })}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t(canResolve ? "pr.conflicts.bodyAuthor" : "pr.conflicts.bodyReviewer")}
      </p>
      {author && isDream && (
        <p data-testid="pr-conflicts-dream" className="text-sm text-muted-foreground">
          {t("pr.conflicts.dream")}
        </p>
      )}
      <ul className="min-w-0 divide-y">
        {paths.map((item) => (
          <li
            key={`${item.kind}:${item.path}`}
            data-testid="pr-conflict-path"
            data-kind={item.kind}
            className="flex min-w-0 flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="font-mono text-sm break-all">{item.path}</p>
              <p className="text-xs text-muted-foreground">
                {t(item.kind === "asset" ? "pr.conflicts.asset" : "pr.conflicts.document")}
                {item.standing && ` · ${t("pr.conflicts.standing")}`}
              </p>
            </div>
            {item.kind === "document" && canResolve && (
              <Link
                data-testid="pr-conflict-resolve"
                aria-label={t("pr.conflicts.resolvePath", { path: item.path })}
                className="inline-flex min-h-[44px] shrink-0 items-center underline"
                to="/$lang/kbs/$kbId/documents"
                params={{ lang, kbId }}
                search={{ path: item.path, mode: "edit", pr: number }}
              >
                {t("pr.conflicts.resolve")}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {hasAsset && <p className="text-xs text-muted-foreground">{t("pr.conflicts.assetHint")}</p>}
      {truncated && (
        <p data-testid="pr-conflicts-truncated" className="text-xs text-muted-foreground">
          {t("pr.conflicts.truncated", { count: paths.length })}
        </p>
      )}
    </section>
  );
}

/** Loads the conflicts of an active PR for its current revisions. */
function PrConflicts({
  lang,
  kbId,
  number,
  viewerActorKey,
  pr,
  canResolve,
}: {
  lang: string;
  kbId: string;
  number: number;
  viewerActorKey: string | null;
  pr: PrSummary;
  canResolve: boolean;
}) {
  const { t } = useTranslation("kb");
  const active = pr.status === "OPEN" || pr.status === "CONFLICT";
  const options = orpc.pullRequests.conflicts.queryOptions({
    input: { kbId, number },
    enabled: active,
    retry: false,
  });
  const { data, isError, refetch } = useQuery({
    ...options,
    // One actor's view, re-read for the revisions shown.
    queryKey: [...options.queryKey, viewerActorKey, pr.headSha, pr.targetSha],
  });
  if (!active) return null;
  if (isError)
    return <InlineRetry message={t("pr.conflicts.loadFailed")} onRetry={() => refetch()} />;
  if (!data) return null;
  return (
    <PrConflictsView
      lang={lang}
      kbId={kbId}
      number={number}
      paths={data.paths}
      truncated={data.truncated}
      canResolve={canResolve}
      isDream={data.isDream}
    />
  );
}

type PrReviewPanelProps = {
  lang: string;
  kbId: string;
  number: number;
  bits: readonly string[];
  viewerActorKey: string | null;
  loadDocument: PrReviewSources["loadDocument"];
  /** From `usePrReview`, owned by the caller so it can watch access loss. */
  review: PrReviewState;
};

/** Complete review page body; confirmation belongs to these exact revisions. */
export function PrReviewPanel(props: PrReviewPanelProps) {
  const { t } = useTranslation("kb");
  const { review } = props;
  if (review.isPending)
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (review.isError || !review.diff)
    return <InlineRetry message={t("pr.loadFailed")} onRetry={() => review.refetch()} />;
  return (
    <PrLoadedReviewPanel
      key={JSON.stringify([
        props.kbId,
        props.number,
        props.viewerActorKey,
        review.diff.pr.baseSha,
        review.diff.pr.headSha,
        review.diff.pr.targetSha,
      ])}
      {...props}
      diff={review.diff}
    />
  );
}

function PrLoadedReviewPanel({
  lang,
  kbId,
  number,
  bits,
  viewerActorKey,
  loadDocument,
  review,
  diff,
}: PrReviewPanelProps & { diff: ReviewedDiff }) {
  const { t } = useTranslation("kb");
  const [confirming, setConfirming] = useState<ReviewDecision | null>(null);
  const controls = reviewControls({ bits, viewerActorKey, pr: diff.pr });
  const decide = async (decision: ReviewDecision) => {
    setConfirming(null);
    await review.submit(decision);
  };
  return (
    <div data-testid="pr-review" className="min-w-0 space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold break-words">
          {t("pr.heading", { number, title: diff.pr.title })}
        </h2>
        <p className="text-sm text-muted-foreground">
          <PrAuthor author={diff.pr.author} />
        </p>
        <p className="text-xs text-muted-foreground">
          {t("pr.branches", {
            source: diff.pr.sourceBranch.replace(/^refs\/heads\//, ""),
            target: diff.pr.targetBranch,
            base: short(diff.pr.baseSha),
          })}
        </p>
      </header>
      <PrActionsView
        pr={diff.pr}
        controls={controls}
        mergeReady={reviewReady(diff, "merge")}
        closeReady={reviewReady(diff, "close")}
        outcome={review.outcome}
        pending={review.pending}
        onMerge={() => setConfirming("merge")}
        onClose={() => setConfirming("close")}
        onRefresh={() => void review.refresh()}
      />
      <PrConflicts
        lang={lang}
        kbId={kbId}
        number={number}
        viewerActorKey={viewerActorKey}
        pr={diff.pr}
        canResolve={
          diff.pr.author?.isViewer === true && (bits.includes("propose") || bits.includes("write"))
        }
      />
      <PrDiff
        lang={lang}
        kbId={kbId}
        diff={diff}
        loadDocument={loadDocument}
        hasNextPage={review.hasNextPage}
        isFetchingNextPage={review.isFetchingNextPage}
        onLoadMore={() => void review.loadMore()}
      />
      {confirming === "merge" && (
        <ConfirmDeleteDialog
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          title={t("pr.confirm.mergeTitle", { number })}
          description={t("pr.confirm.mergeDescription", {
            head: short(diff.pr.headSha),
            target: short(diff.pr.targetSha),
          })}
          confirmToken="MERGE"
          typePrompt={t("pr.confirm.mergePrompt")}
          copyAriaLabel={t("pr.confirm.copyToken")}
          inputMode="text"
          confirmLabel={t("pr.confirm.mergeAction")}
          pendingLabel={t("pr.confirm.pending")}
          isPending={review.pending}
          onConfirm={() => void decide("merge")}
        />
      )}
      {confirming === "close" && (
        <AlertDialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("pr.confirm.closeTitle", { number })}</AlertDialogTitle>
              <AlertDialogDescription>{t("pr.confirm.closeDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="sm:flex-wrap">
              <AlertDialogCancel className="min-h-[44px] w-full sm:w-auto">
                {t("common:actions.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                className="min-h-[44px] w-full sm:w-auto"
                disabled={review.pending}
                onClick={() => void decide("close")}
              >
                {review.pending ? t("pr.confirm.pending") : t("pr.confirm.closeAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
