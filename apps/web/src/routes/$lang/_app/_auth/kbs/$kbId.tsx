import { Button } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { FileText, GitPullRequest, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Breadcrumbs, type Crumb } from "@/components/breadcrumbs";
import { InlineRetry } from "@/components/inline-retry";
import { kbDocumentHref } from "@/components/kb/kb-links";
import {
  KbDeleteDialog,
  type KbItem,
  KbManageActions,
  KbMetadataSheet,
  kbAccessLabelKey,
  routerClick,
} from "@/components/kb/kb-list";
import { FRESHNESS_TONE, SearchPanel } from "@/components/kb/search-results";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell, type SectionTab, SectionTabs } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import { isAccessLoss, kbControls, useKbAccessLoss } from "@/hooks/use-kb-editor";
import { cachedKbName, routeHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/kbs/$kbId")({
  // Every KB page's title names the KB (R2-12). `head()` runs after the
  // loaders, so priming `kbs.get` here names it on a cold load too. A KB the
  // viewer can't read resolves to nothing: the layout (or Settings, for an
  // invitation recipient) renders that state from its own query.
  loader: async ({ context, params }) => {
    await context.queryClient
      .ensureQueryData(orpc.kbs.get.queryOptions({ input: { kbId: params.kbId }, retry: false }))
      .catch(() => undefined);
  },
  head: (head) =>
    routeHead(
      head,
      cachedKbName(head.match.context.queryClient, head.params.kbId) ??
        head.match.context.i18n.t(
          isAccessLoss(
            head.match.context.queryClient.getQueryState(
              orpc.kbs.get.queryKey({ input: { kbId: head.params.kbId } }),
            )?.error,
          )
            ? "errors:pageNotFound.title"
            : "nav:titles.knowledgeBase",
        ),
    ),
  component: KbLayout,
});

type IndexFreshness = keyof typeof FRESHNESS_TONE;

function KbLayout() {
  const { lang, kbId } = Route.useParams();
  const { t } = useTranslation("kb");
  const matchRoute = useMatchRoute();
  const search: { path?: string; mode?: string } = useSearch({ strict: false });
  // Settings owns its own KB loading: a recipient accepting an invitation
  // cannot read the KB yet, so the layout must not replace it with "unavailable".
  const onSettings = Boolean(matchRoute({ to: "/$lang/kbs/$kbId/settings" }));
  const onDocument = Boolean(matchRoute({ to: "/$lang/kbs/$kbId/documents" }));
  const onPrs = Boolean(matchRoute({ to: "/$lang/kbs/$kbId/prs", fuzzy: true }));
  const prMatch = matchRoute({ to: "/$lang/kbs/$kbId/prs/$number" });
  // Anything else under the KB (e.g. `/pull-requests`) is not the KB home: the
  // Outlet renders the router's not-found page instead of Documents (R2-13).
  const onHome = Boolean(matchRoute({ to: "/$lang/kbs/$kbId" }));
  const prNumber = prMatch ? prMatch.number : null;
  const { data, isPending, isError, error, refetch } = useQuery(
    orpc.kbs.get.queryOptions({ input: { kbId }, retry: false, staleTime: 0 }),
  );
  const lost = useKbAccessLoss(kbId, [error]);
  const kb = data?.kb;

  const crumbs: Crumb[] = [
    {
      key: "kbs",
      label: t("detail.breadcrumbRoot"),
      render: (className, children) => (
        <Link to="/$lang/kbs" params={{ lang }} className={className}>
          {children}
        </Link>
      ),
    },
  ];
  if (kb) {
    crumbs.push({
      key: "kb",
      label: kb.name,
      render: (className, children) => (
        <Link to="/$lang/kbs/$kbId" params={{ lang, kbId }} className={className}>
          {children}
        </Link>
      ),
    });
    if (onDocument)
      crumbs.push(
        search.mode === "new" || !search.path
          ? { key: "doc", label: t("detail.newDocument") }
          : { key: "doc", label: search.path.slice(search.path.lastIndexOf("/") + 1), mono: true },
      );
    if (onPrs)
      crumbs.push({
        key: "prs",
        label: t("detail.pullRequests"),
        render: (className, children) => (
          <Link to="/$lang/kbs/$kbId/prs" params={{ lang, kbId }} className={className}>
            {children}
          </Link>
        ),
      });
    if (prNumber) crumbs.push({ key: "pr", label: t("pr.number", { number: prNumber }) });
    if (onSettings) crumbs.push({ key: "settings", label: t("detail.settings") });
  }

  // The document page brings its own document header; every
  // other KB page shows the KB header and section tabs once, here.
  const chrome = (kb: KbItem, index: { freshness: IndexFreshness } | undefined) => (
    <>
      <KbHeader
        key={`header:${kbId}`}
        kb={kb}
        lang={lang}
        freshness={index?.freshness}
        manage={!onPrs}
      />
      <KbSectionTabs lang={lang} kbId={kbId} />
    </>
  );

  // The split editor/preview gets the full width; reading keeps a long-read measure.
  const editing = onDocument && (search.mode === "edit" || search.mode === "new" || !search.path);
  return (
    <PageShell width={editing ? "wide" : "default"}>
      <Breadcrumbs items={crumbs} className="-mt-2" />
      {onSettings ? (
        <>
          {kb && !lost && chrome(kb, data?.index)}
          <Outlet />
        </>
      ) : lost ? (
        <div role="alert" className="space-y-2 rounded-md border p-4">
          <h1 className="text-xl font-semibold">{t("errors:pageNotFound.title")}</h1>
          <p className="text-sm">{t("detail.unavailable")}</p>
        </div>
      ) : isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-5 w-80" />
          <Skeleton className="h-11 w-72" />
        </div>
      ) : isError || !kb ? (
        <InlineRetry message={t("detail.loadFailed")} onRetry={() => refetch()} />
      ) : onDocument || !(onHome || onPrs) ? (
        <Outlet />
      ) : (
        <>
          {chrome(kb, data.index)}
          {onPrs ? <Outlet /> : <KbHome key={`home:${kbId}`} kb={kb} lang={lang} />}
        </>
      )}
    </PageShell>
  );
}

function KbSectionTabs({ lang, kbId }: { lang: string; kbId: string }) {
  const { t } = useTranslation("kb");
  const tabs: SectionTab[] = [
    {
      key: "documents",
      label: t("detail.documents"),
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/kbs/$kbId"
          params={{ lang, kbId }}
          activeOptions={{ exact: true }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          <FileText aria-hidden className="size-4" />
          {children}
        </Link>
      ),
    },
    {
      key: "prs",
      label: t("detail.pullRequests"),
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/kbs/$kbId/prs"
          params={{ lang, kbId }}
          activeOptions={{ includeSearch: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          <GitPullRequest aria-hidden className="size-4" />
          {children}
        </Link>
      ),
    },
    {
      key: "settings",
      label: t("detail.settings"),
      render: (className, activeClassName, children) => (
        <Link
          to="/$lang/kbs/$kbId/settings"
          params={{ lang, kbId }}
          search={{}}
          activeOptions={{ includeSearch: false }}
          className={className}
          activeProps={{ className: activeClassName }}
        >
          <Settings aria-hidden className="size-4" />
          {children}
        </Link>
      ),
    },
  ];
  return <SectionTabs tabs={tabs} ariaLabel={t("detail.sectionsLabel")} />;
}

function KbHeader({
  kb,
  lang,
  freshness,
  manage,
}: {
  kb: KbItem;
  lang: string;
  freshness?: IndexFreshness;
  /** Edit details / Delete: on the KB home and settings, never on content pages. */
  manage: boolean;
}) {
  const { t } = useTranslation("kb");
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <PageHeader
        title={kb.name}
        description={kb.description}
        meta={
          <>
            <span className="font-mono">{kb.slug}</span>
            <StatusPill tone={kb.isOwner ? "info" : "muted"}>{t(kbAccessLabelKey(kb))}</StatusPill>
            {freshness && (
              <StatusPill tone={FRESHNESS_TONE[freshness]} data-testid="kb-index-status">
                {t(`detail.indexStatus.${freshness}`)}
              </StatusPill>
            )}
          </>
        }
        actions={
          manage ? (
            <KbManageActions
              kb={kb}
              onEdit={() => setEditing(true)}
              onDelete={() => setDeleting(true)}
            />
          ) : undefined
        }
      />
      {editing && <KbMetadataSheet kb={kb} open={editing} onOpenChange={setEditing} />}
      <KbDeleteDialog
        kb={kb}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => navigate({ to: "/$lang/kbs", params: { lang } })}
      />
    </>
  );
}

function KbHome({ kb, lang }: { kb: KbItem; lang: string }) {
  const { t } = useTranslation("kb");
  const navigate = useNavigate();
  const controls = kbControls(kb.capabilities);
  const docs = useInfiniteQuery(
    orpc.documents.list.infiniteOptions({
      input: controls.canRead
        ? (cursor: string | null) => ({ kbId: kb.id, limit: 20, cursor })
        : skipToken,
      initialPageParam: null,
      getNextPageParam: (last) => last?.nextCursor ?? null,
      retry: false,
    }),
  );
  const documentsAccessLost = useKbAccessLoss(kb.id, [docs.error]);
  const openDocument = (search: { path?: string; rev?: string; mode?: "new" }) =>
    navigate({ to: "/$lang/kbs/$kbId/documents", params: { lang, kbId: kb.id }, search });
  const items = docs.data?.pages.flatMap((page) => page?.items ?? []) ?? [];

  if (!controls.canRead || documentsAccessLost) return null;
  return (
    <div className="space-y-8">
      <section className="min-w-0 space-y-3" aria-labelledby="kb-documents">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="kb-documents" className="text-lg font-semibold">
            {t("detail.documents")}
          </h2>
          {controls.editMode !== "none" && (
            <Button className="min-h-[44px]" onClick={() => openDocument({ mode: "new" })}>
              <Plus className="size-4" />
              {t("detail.newDocument")}
            </Button>
          )}
        </div>
        <QueryBoundary
          query={docs}
          errorMessage={t("detail.documentsLoadFailed")}
          skeleton={
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          }
          isEmpty={() => items.length === 0}
          empty={<p className="text-sm text-muted-foreground">{t("detail.documentsEmpty")}</p>}
        >
          {() => (
            <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
              {items.map((doc) => {
                const slash = doc.path.lastIndexOf("/");
                return (
                  <li key={doc.path}>
                    <a
                      href={kbDocumentHref(lang, kb.id, { path: doc.path })}
                      onClick={routerClick(() => openDocument({ path: doc.path }))}
                      className="flex min-h-[44px] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 truncate font-mono text-sm">
                        {slash >= 0 && (
                          <span className="text-muted-foreground">
                            {doc.path.slice(0, slash + 1)}
                          </span>
                        )}
                        {doc.path.slice(slash + 1)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </QueryBoundary>
        <LoadMore
          hasNextPage={docs.hasNextPage}
          isFetchingNextPage={docs.isFetchingNextPage}
          onLoadMore={() => docs.fetchNextPage()}
        />
      </section>
      <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-6">
        <SearchPanel key={kb.id} lang={lang} kbId={kb.id} onOpen={openDocument} />
      </div>
    </div>
  );
}
