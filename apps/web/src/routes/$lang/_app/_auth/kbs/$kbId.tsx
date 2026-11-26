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
import { DeletedDocuments } from "@/components/kb/deleted-documents";
import { KbDocumentList } from "@/components/kb/document-list";
import { awaitsInvitationAccept } from "@/components/kb/kb-links";
import {
  KbDeleteDialog,
  type KbItem,
  KbManageActions,
  KbMetadataSheet,
  kbAccessLabelKey,
} from "@/components/kb/kb-list";
import { KbPinButton } from "@/components/kb/kb-pin-button";
import { KbWorkspace, type WorkspaceSearch } from "@/components/kb/kb-workspace";
import { FRESHNESS_TONE, SearchPanel } from "@/components/kb/search-results";
import { LoadMore } from "@/components/load-more";
import NotFoundState from "@/components/not-found-state";
import { PageHeader, PageShell, type SectionTab, SectionTabs } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { StatusPill } from "@/components/status-pill";
import { isAccessLoss, kbControls, useKbAccessLoss } from "@/hooks/use-kb-editor";
import { cachedKbName, routeHead } from "@/lib/page-title";
import { kbPendingFrame } from "@/lib/pending-layout";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/kbs/$kbId")({
  staticData: {
    // The workspace for the KB home and its documents, the page column for
    // the rest, as KbLayout below draws them.
    pendingFrame: kbPendingFrame,
    pendingShape: "detail",
  },
  // Every KB page's title names the KB. `head()` runs after the
  // loaders, so priming `kbs.get` here names it on a cold load too. A KB the
  // viewer can't read resolves to nothing: the layout (or Settings, for an
  // invitation recipient) renders that state from its own query.
  loader: async ({ context, params, location }) => {
    const search: { accept?: unknown } = location.search;
    if (awaitsInvitationAccept(/\/settings\/?$/.test(location.pathname), search.accept)) return;
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
  // An unknown KB sub-path (`/pull-requests`) renders inside this layout's
  // Outlet, in the app shell; without this the nearest explicit boundary is
  // `$lang`'s public 404 (docs/ui.md § Shell rules).
  notFoundComponent: () => <NotFoundState />,
});

type IndexFreshness = keyof typeof FRESHNESS_TONE;

function KbLayout() {
  const { lang, kbId } = Route.useParams();
  const { t } = useTranslation("kb");
  // The session the protected layout resolved before this page rendered.
  const { session } = Route.useRouteContext();
  const viewerId = session?.user.id ?? null;
  const matchRoute = useMatchRoute();
  const search: WorkspaceSearch & { accept?: string } = useSearch({ strict: false });
  // Settings owns its own KB loading: a recipient accepting an invitation
  // cannot read the KB yet, so the layout must not replace it with "unavailable".
  const onSettings = Boolean(matchRoute({ to: "/$lang/kbs/$kbId/settings" }));
  const awaitingAccept = awaitsInvitationAccept(onSettings, search.accept);
  const onDocument = Boolean(matchRoute({ to: "/$lang/kbs/$kbId/documents" }));
  const onPrs = Boolean(matchRoute({ to: "/$lang/kbs/$kbId/prs", fuzzy: true }));
  const prMatch = matchRoute({ to: "/$lang/kbs/$kbId/prs/$number" });
  // Anything else under the KB (e.g. `/pull-requests`) is not the KB home: the
  // Outlet renders the router's not-found page instead of Documents.
  const onHome = Boolean(matchRoute({ to: "/$lang/kbs/$kbId" }));
  const prNumber = prMatch ? prMatch.number : null;
  const { data, isPending, isError, error, refetch } = useQuery(
    orpc.kbs.get.queryOptions({
      input: { kbId },
      retry: false,
      staleTime: 0,
      enabled: !awaitingAccept,
    }),
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
          ? // The editor's own "New document" heading sits right below.
            { key: "doc", label: t("detail.newDocument"), hideOnPhone: true }
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

  // The workspace (file tree, tabs, read/edit view) is the KB home and its
  // documents, full width; the KB's other pages keep their page column.
  if (kb && !lost && (onDocument || onHome) && kbControls(kb.capabilities).canRead) {
    return (
      <KbWorkspace
        // One workspace per viewer and KB: nothing (tabs, tree, a kept previous
        // tree or feed) carries over to another KB or another account.
        key={`${viewerId ?? ""}:${kbId}`}
        lang={lang}
        kbId={kbId}
        kbName={kb.name}
        viewerId={viewerId}
        canRead
        canWrite={kbControls(kb.capabilities).editMode !== "none" && kb.headSha !== null}
        current={onDocument ? search : null}
      >
        <div className="space-y-6">
          <Breadcrumbs items={crumbs} className="-mt-2" />
          {onDocument ? (
            <Outlet />
          ) : (
            <div className="mx-auto max-w-6xl space-y-6">
              {chrome(kb, data?.index)}
              <KbHome key={`home:${kbId}`} kb={kb} lang={lang} />
            </div>
          )}
        </div>
      </KbWorkspace>
    );
  }
  return (
    <PageShell>
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
          <>
            <KbPinButton kbId={kb.id} kbName={kb.name} kbSlug={kb.slug} />
            {manage && (
              <KbManageActions
                kb={kb}
                onEdit={() => setEditing(true)}
                onDelete={() => setDeleting(true)}
              />
            )}
          </>
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
  const openDocument = (search: { path?: string; rev?: string; mode?: "new"; proposal?: number }) =>
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
            <KbDocumentList
              lang={lang}
              kbId={kb.id}
              items={items}
              onOpen={(path) => openDocument({ path })}
            />
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
      <DeletedDocuments
        key={`deleted:${kb.id}`}
        lang={lang}
        kbId={kb.id}
        kbHeadSha={kb.headSha}
        canRestore={controls.editMode !== "none"}
        proposing={controls.editMode === "proposal"}
        onRestored={(path, proposal) =>
          openDocument(proposal === null ? { path } : { path, proposal })
        }
      />
    </div>
  );
}
