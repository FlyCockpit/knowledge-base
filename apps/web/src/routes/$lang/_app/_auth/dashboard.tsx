import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/empty-state";
import { InlineRetry } from "@/components/inline-retry";
import {
  createdKbDestination,
  KB_GRID_CLASS,
  KbCreateDialog,
  KbList,
} from "@/components/kb/kb-list";
import { PageHeader, PageShell } from "@/components/page-shell";
import PullToRefresh from "@/components/pull-to-refresh";
import { activeTokenCount } from "@/lib/credential-counts";
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
  const { t } = useTranslation(["common", "dashboard", "kb"]);
  const [createOpen, setCreateOpen] = useState(false);
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
  const openKb = (kbId: string) => navigate({ to: "/$lang/kbs/$kbId", params: { lang, kbId } });

  const count = (items: readonly unknown[] | undefined, more: boolean) =>
    items === undefined
      ? null
      : more
        ? t("dashboard:kpi.more", { count: items.length })
        : String(items.length);
  const kbs = [...(owned.data?.items ?? []), ...(shared.data?.items ?? [])];
  const kbsLoaded = owned.data !== undefined && shared.data !== undefined;
  const moreKbs = Boolean(owned.data?.nextCursor || shared.data?.nextCursor);
  const searchable = kbs.filter((kb) => kb.embeddingGeneration);
  const activeTokens = tokens.data ? activeTokenCount(tokens.data) : null;

  // A stat that is zero says nothing (and "0 of 0" is noise): each tile
  // shows its skeleton while loading and stays only if it counts something.
  const tiles = [
    owned.data?.items.length !== 0 && (
      <Kpi
        key="owned"
        label={t("dashboard:kpi.owned")}
        value={count(owned.data?.items, Boolean(owned.data?.nextCursor))}
      />
    ),
    shared.data?.items.length !== 0 && (
      <Kpi
        key="shared"
        label={t("dashboard:kpi.shared")}
        value={count(shared.data?.items, Boolean(shared.data?.nextCursor))}
      />
    ),
    !(kbsLoaded && searchable.length === 0) && (
      <Kpi
        key="searchable"
        label={t("dashboard:kpi.searchable")}
        value={kbsLoaded ? count(searchable, false) : null}
        hint={kbsLoaded ? t("dashboard:kpi.searchableHint", { count: kbs.length }) : undefined}
        more={moreKbs}
      />
    ),
    activeTokens !== 0 && (
      <Kpi
        key="tokens"
        label={t("dashboard:kpi.tokens")}
        value={tokens.isError ? "—" : activeTokens === null ? null : String(activeTokens)}
        hint={
          tokens.data && tokens.data.childTokens > 0
            ? t("dashboard:kpi.tokensFromKeysHint", { count: tokens.data.childTokens })
            : undefined
        }
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
    ),
  ].filter(Boolean);

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <PageShell>
        <PageHeader
          // "Welcome, {name}", never "Welcome back": nothing in the session
          // tells a first sign-in from a return visit (the account is created
          // before the email is verified, so createdAt is not it), and "back"
          // greets a brand-new user wrongly.
          title={t("dashboard:welcome", { name: session.user.name })}
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
          tiles.length > 0 && (
            <dl data-testid="dashboard-kpis" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {tiles}
            </dl>
          )
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
            <div className={`grid gap-3 ${KB_GRID_CLASS}`} aria-busy="true">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          ) : kbs.length === 0 ? (
            <EmptyState
              title={t("dashboard:emptyTitle")}
              description={t("dashboard:emptyDescription")}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    data-testid="dashboard-create-kb"
                    className="min-h-[44px]"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus className="size-4" />
                    {t("dashboard:createKb")}
                  </Button>
                  <Link
                    data-testid="dashboard-connect-client"
                    to="/$lang/settings/mcp"
                    params={{ lang }}
                    className={cn(buttonVariants({ variant: "outline" }), "min-h-[44px]")}
                  >
                    {t("dashboard:connectClient")}
                  </Link>
                </div>
              }
            />
          ) : (
            <KbList lang={lang} items={kbs.slice(0, 4)} onOpen={openKb} />
          )}
        </section>
        <KbCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(kb) => {
            if (createdKbDestination(kb) === "open") openKb(kb.id);
            else toast.success(t("kb:create.createdNoRead"));
          }}
        />
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
