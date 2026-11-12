import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PrReviewPanel } from "@/components/kb/pr-actions";
import { getAuthActorKey, useAuthSession } from "@/hooks/use-auth-session";
import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import { PR_DIFF_PAGE_LIMIT, type PrReviewSources, usePrReview } from "@/hooks/use-pr-review";
import { cachedKbName, pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/kbs/$kbId/prs/$number")({
  head: ({ match, params }) =>
    pageHead(
      match.context.i18n.t("kb:pr.pageTitle", { number: params.number }),
      cachedKbName(match.context.queryClient, params.kbId),
    ),
  component: PullRequestPage,
});

function PullRequestPage() {
  const { lang, kbId, number: rawNumber } = Route.useParams();
  const number = /^[1-9]\d{0,15}$/.test(rawNumber) ? Number(rawNumber) : null;
  const auth = useAuthSession();
  const userId = auth.state.status === "authenticated" ? auth.state.session.user.id : null;
  if (!userId) return null;
  // Router parameter changes reuse the route component. The hook, mutation
  // memory and dialogs must all belong to one KB/PR/actor, even with cached data.
  return (
    <PullRequestSession
      key={JSON.stringify([lang, kbId, number, userId])}
      lang={lang}
      kbId={kbId}
      number={number}
      viewerActorKey={`user:${userId}`}
    />
  );
}

function PullRequestSession({
  lang,
  kbId,
  number,
  viewerActorKey,
}: {
  lang: string;
  kbId: string;
  number: number | null;
  viewerActorKey: string;
}) {
  const { t } = useTranslation("kb");
  // The parent layout renders this route only once `kbs.get` has data.
  const kbQuery = orpc.kbs.get.queryOptions({ input: { kbId } });
  const {
    data: kbData,
    isPending: kbPending,
    error: kbError,
    refetch: refetchKb,
  } = useQuery({
    ...kbQuery,
    queryKey: [...kbQuery.queryKey, viewerActorKey],
  });
  // The review panel states every outcome inline; no generic toast on top (R2-4).
  const { mutateAsync: submitReview } = useMutation(
    orpc.pullRequests.review.mutationOptions({ meta: { skipGlobalErrorToast: true } }),
  );
  const sources = useMemo<PrReviewSources>(
    () => ({
      pageKey: [
        ...orpc.pullRequests.get.key({
          input: { kbId, number: number ?? 0 },
          type: "infinite",
        }),
        viewerActorKey,
      ],
      fetchPage: (cursor) =>
        orpc.pullRequests.get.call({
          kbId,
          number: number ?? 0,
          page: { limit: PR_DIFF_PAGE_LIMIT, cursor },
        }),
      review: submitReview,
      loadDocument: async (input) => {
        const document = await orpc.documents.get.call(input);
        if (!document) throw new Error("Document unavailable");
        return document;
      },
    }),
    [kbId, number, viewerActorKey, submitReview],
  );
  const actor = useMemo(
    () => ({ key: viewerActorKey, isCurrent: () => getAuthActorKey() === viewerActorKey }),
    [viewerActorKey],
  );
  const review = usePrReview({ kbId, actor, sources, enabled: number !== null });
  useKbAccessLoss(kbId, [review.error, kbError]);
  if (kbPending)
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (!kbData) return <InlineRetry message={t("pr.loadFailed")} onRetry={() => refetchKb()} />;
  return (
    <div className="min-w-0 space-y-4">
      {number === null ? (
        <p role="alert" className="text-sm">
          {t("pr.loadFailed")}
        </p>
      ) : (
        <PrReviewPanel
          lang={lang}
          kbId={kbId}
          number={number}
          bits={kbData.kb.capabilities}
          viewerActorKey={viewerActorKey}
          loadDocument={sources.loadDocument}
          review={review}
        />
      )}
    </div>
  );
}
