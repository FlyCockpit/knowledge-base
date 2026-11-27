import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { orpc } from "@/utils/orpc";

type Invitation = Awaited<ReturnType<AppRouterClient["kbs"]["shareInbox"]>>["items"][number];

export function RecipientInvitationRows({ lang, items }: { lang: string; items: Invitation[] }) {
  const { t } = useTranslation("kb");
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t("list.inbox.empty")}</p>;
  return (
    <ul className="divide-y rounded-xl border">
      {items.map((invite) => (
        <li key={invite.requestId} className="flex min-w-0 flex-wrap items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{invite.kbName}</p>
            <p className="text-sm text-muted-foreground">
              {t("list.inbox.from", { name: invite.inviterName })}
            </p>
            <p className="text-sm text-muted-foreground">
              {invite.bits.map((bit) => t(`settings.bits.${bit}`)).join(", ")}
            </p>
          </div>
          <Link
            to="/$lang/kbs/$kbId/settings"
            params={{ lang, kbId: invite.kbId }}
            search={{ accept: invite.requestId }}
            className="inline-flex min-h-[44px] items-center rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            {t("list.inbox.review")}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The recipient opens the existing preview/accept flow, which reauthorizes. */
export function RecipientInvitations({ lang }: { lang: string }) {
  const {
    data,
    error,
    isPending,
    isError,
    fetchStatus,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery(
    orpc.kbs.shareInbox.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 20, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last?.nextCursor ?? undefined,
      staleTime: 0,
      gcTime: 0,
      retry: false,
      meta: { skipGlobalErrorToast: true },
    }),
  );
  const { t } = useTranslation("kb");
  return (
    <section aria-labelledby="recipient-invitations-title" className="min-w-0 space-y-3">
      <h2 id="recipient-invitations-title" className="text-lg font-semibold">
        {t("list.inbox.title")}
      </h2>
      <QueryBoundary
        query={{ data, error, isPending, isError, fetchStatus, refetch }}
        errorMessage={t("list.inbox.failed")}
        skeleton={<Skeleton className="h-24 rounded-xl" />}
      >
        {(data) => (
          <RecipientInvitationRows
            lang={lang}
            items={data.pages.flatMap((page) => page?.items ?? [])}
          />
        )}
      </QueryBoundary>
      <LoadMore
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={() => fetchNextPage()}
      />
    </section>
  );
}
