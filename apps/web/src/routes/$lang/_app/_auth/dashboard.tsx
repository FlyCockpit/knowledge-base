import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import { KbList } from "@/components/kb/kb-list";
import { PageHeader, PageShell } from "@/components/page-shell";
import PullToRefresh from "@/components/pull-to-refresh";
import { pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/dashboard")({
  head: ({ match }) => pageHead(match.context.i18n.t("nav:items.dashboard")),
  component: DashboardPage,
});

/** One bounded page per tile: a partial count reads "N+", never a hidden unbounded count. */
const PAGE = 50;

function DashboardPage() {
  const { session } = Route.useRouteContext();
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation(["common", "dashboard"]);
  const owned = useQuery(
    orpc.kbs.list.queryOptions({ input: { limit: PAGE, cursor: null, relation: "owned" } }),
  );
  const shared = useQuery(
    orpc.kbs.list.queryOptions({ input: { limit: PAGE, cursor: null, relation: "shared" } }),
  );
  // A server count: the token list pages through revoked history too, so a
  // first page can't tell how many are live.
  const tokens = useQuery(orpc.mcpGrants.countActiveMine.queryOptions());

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.key() }),
    ]);
  }, [queryClient]);

  const count = (items: readonly unknown[] | undefined, more: boolean) =>
    items === undefined
      ? null
      : more
        ? t("dashboard:kpi.more", { count: items.length })
        : String(items.length);
  const kbs = [...(owned.data?.items ?? []), ...(shared.data?.items ?? [])];
  const kbsLoaded = owned.data !== undefined && shared.data !== undefined;
  const moreKbs = Boolean(owned.data?.nextCursor || shared.data?.nextCursor);

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <PageShell>
        <PageHeader
          title={t("dashboard:welcomeBack", { name: session.user.name })}
          description={t("dashboard:description")}
        />
        {owned.isError || shared.isError ? (
          <InlineRetry
            message={t("dashboard:loadFailed")}
            onRetry={() => {
              void owned.refetch();
              void shared.refetch();
            }}
          />
        ) : (
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label={t("dashboard:kpi.owned")}
              value={count(owned.data?.items, Boolean(owned.data?.nextCursor))}
            />
            <Kpi
              label={t("dashboard:kpi.shared")}
              value={count(shared.data?.items, Boolean(shared.data?.nextCursor))}
            />
            <Kpi
              label={t("dashboard:kpi.searchable")}
              value={
                kbsLoaded
                  ? count(
                      kbs.filter((kb) => kb.embeddingGeneration),
                      false,
                    )
                  : null
              }
              hint={
                kbsLoaded ? t("dashboard:kpi.searchableHint", { count: kbs.length }) : undefined
              }
              more={moreKbs}
            />
            <Kpi
              label={t("dashboard:kpi.tokens")}
              value={tokens.isError ? "—" : tokens.data ? String(tokens.data.tokens) : null}
              href={
                <Link
                  to="/$lang/settings/mcp"
                  params={{ lang }}
                  className="inline-flex min-h-11 items-center text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  {t("dashboard:kpi.manageTokens")}
                </Link>
              }
            />
          </dl>
        )}
        <section aria-labelledby="dashboard-kbs" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="dashboard-kbs" className="text-lg font-semibold">
              {t("dashboard:recent")}
            </h2>
            <Link
              to="/$lang/kbs"
              params={{ lang }}
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {t("dashboard:openKbs")}
            </Link>
          </div>
          {!kbsLoaded && !owned.isError && !shared.isError ? (
            <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          ) : kbs.length === 0 ? (
            <EmptyState
              title={t("dashboard:emptyTitle")}
              description={t("dashboard:emptyDescription")}
            />
          ) : (
            <KbList
              lang={lang}
              items={kbs.slice(0, 4)}
              onOpen={(kbId) => navigate({ to: "/$lang/kbs/$kbId", params: { lang, kbId } })}
            />
          )}
        </section>
      </PageShell>
    </PullToRefresh>
  );
}

function Kpi({
  label,
  value,
  hint,
  more,
  href,
}: {
  label: string;
  /** null while loading. */
  value: string | null;
  hint?: string;
  more?: boolean;
  href?: React.ReactNode;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <dt className="truncate text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("text-2xl font-semibold tabular-nums", value === null && "sr-only")}>
        {value ?? t("kpi.loading")}
      </dd>
      {value === null && <Skeleton className="h-8 w-12" />}
      {(hint || more) && (
        <dd className="text-xs text-muted-foreground">
          {more ? t("kpi.firstPage", { count: PAGE }) : hint}
        </dd>
      )}
      {href && <dd>{href}</dd>}
    </div>
  );
}
