import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PrAuthor } from "@/components/kb/pr-actions";
import { PR_STATUS_KEY, PR_STATUS_TONE, type PrStatus } from "@/components/kb/pr-status";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusPill } from "@/components/status-pill";
import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import { cachedKbName, pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

type Status = PrStatus;
type Filter = Status | "ALL";
const STATUSES: readonly Status[] = ["OPEN", "CONFLICT", "CLOSED", "MERGED"];

export const Route = createFileRoute("/$lang/_app/_auth/kbs/$kbId/prs/")({
  validateSearch: (search: Record<string, unknown>): { status?: Status } => ({
    status: STATUSES.includes(search.status as Status) ? (search.status as Status) : undefined,
  }),
  head: ({ match, params }) =>
    pageHead(
      match.context.i18n.t("kb:detail.pullRequests"),
      cachedKbName(match.context.queryClient, params.kbId),
    ),
  component: PullRequestList,
});

function PullRequestList() {
  const { lang, kbId } = Route.useParams();
  const { status } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { t } = useTranslation("kb");
  const list = useInfiniteQuery(
    orpc.pullRequests.list.infiniteOptions({
      input: (cursor: string | null) => ({
        kbId,
        limit: 20,
        cursor,
        ...(status ? { status } : {}),
      }),
      initialPageParam: null,
      getNextPageParam: (last) => last?.nextCursor ?? null,
      retry: false,
    }),
  );
  useKbAccessLoss(kbId, [list.error]);
  const items = list.data?.pages.flatMap((page) => page?.items ?? []) ?? [];
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="kb-prs">
      <h2 id="kb-prs" className="text-lg font-semibold">
        {t("pr.list.title")}
      </h2>
      <SegmentedControl<Filter>
        ariaLabel={t("pr.list.filter")}
        value={status ?? "ALL"}
        onChange={(next) =>
          navigate({ search: next === "ALL" ? {} : { status: next }, resetScroll: false })
        }
        items={[
          { value: "ALL", label: t("pr.list.all") },
          ...STATUSES.map((value) => ({ value, label: t(`pr.status.${PR_STATUS_KEY[value]}`) })),
        ]}
      />
      <QueryBoundary
        query={list}
        errorMessage={t("pr.list.loadFailed")}
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        }
        isEmpty={() => items.length === 0}
        empty={<p className="text-sm text-muted-foreground">{t("pr.list.empty")}</p>}
      >
        {() => (
          <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            {items.map((pr) => (
              <li key={pr.number}>
                <Link
                  to="/$lang/kbs/$kbId/prs/$number"
                  params={{ lang, kbId, number: String(pr.number) }}
                  className="flex min-h-[44px] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">
                      {t("pr.heading", { number: pr.number, title: pr.title })}
                    </span>
                    <PrAuthor
                      author={pr.author}
                      className="truncate text-xs text-muted-foreground"
                    />
                  </span>
                  <StatusPill tone={PR_STATUS_TONE[pr.status]}>
                    {t(`pr.status.${PR_STATUS_KEY[pr.status]}`)}
                  </StatusPill>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => list.fetchNextPage()}
      />
    </section>
  );
}
