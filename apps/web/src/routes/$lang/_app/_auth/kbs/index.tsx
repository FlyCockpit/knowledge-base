import { Button } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GettingStarted,
  type GettingStartedStep,
  useGettingStartedHidden,
} from "@/components/home/getting-started";
import { createdKbDestination, KbCreateDialog, KbList } from "@/components/kb/kb-list";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import PullToRefresh from "@/components/pull-to-refresh";
import { QueryBoundary } from "@/components/query-boundary";
import { useAccountSetupSteps } from "@/hooks/use-account-setup-steps";
import { hasConnectedClient } from "@/lib/credential-counts";
import { KB_GRID_CLASS } from "@/lib/kb-grid";
import { pageHead } from "@/lib/page-title";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

/**
 * The knowledge bases list, and the signed-in home (`APP_HOME`,
 * lib/app-home.ts): the main list made useful instead of a separate stats
 * page. docs/ui.md § The signed-in home.
 *
 * Top to bottom: the getting-started checklist until it is done (or hidden),
 * then "Owned" and "Shared with me", each with its count in its heading (the
 * only counters on the home). Every state has a next step: the checklist's
 * actions, the header's New knowledge base, the empty states, the error's Try
 * again. One create dialog serves the header button and the checklist.
 * Pull to refresh (phones) reloads the lists and the checklist's reads.
 */
export const Route = createFileRoute("/$lang/_app/_auth/kbs/")({
  staticData: { pendingShape: "cards" },
  head: ({ match }) => pageHead(match.context.i18n.t("nav:items.knowledgeBases")),
  component: KbIndexPage,
});

type Relation = "owned" | "shared";

const PAGE_LIMIT = 20;

/**
 * One relation's list as an infinite query, read once on the page and handed
 * to its section and (for "Owned") to the checklist.
 */
function useKbListQuery(relation: Relation) {
  return useInfiniteQuery(
    orpc.kbs.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: PAGE_LIMIT, cursor, relation }),
      initialPageParam: null,
      getNextPageParam: (last) => last?.nextCursor ?? null,
    }),
  );
}

type KbListQuery = ReturnType<typeof useKbListQuery>;

function KbIndexPage() {
  const { lang } = Route.useParams();
  const { session } = Route.useRouteContext();
  const { t } = useTranslation("kb");
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const open = (kbId: string) => navigate({ to: "/$lang/kbs/$kbId", params: { lang, kbId } });
  const owned = useKbListQuery("owned");
  const shared = useKbListQuery("shared");
  const queryClient = useQueryClient();
  const handleRefresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.kbs.shareStatusMine.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.countActiveMine.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.users.list.key() }),
    ]);
  }, [queryClient]);

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <PageShell>
        <PageHeader
          title={t("list.title")}
          description={t("list.description")}
          actions={
            <Button className="min-h-[44px]" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t("list.create")}
            </Button>
          }
        />
        {/* The `_auth` gate always puts the session in the route context; the
            KB browser test harness (apps/web/tests/kb-editor.harness.tsx)
            mounts this page without that gate, and gets the lists alone. */}
        {session ? (
          <KbHomeChecklist
            lang={lang}
            user={session.user}
            owned={owned}
            onCreate={() => setCreateOpen(true)}
          />
        ) : null}
        {/* Home sections that need their own data slot in here, between the
            checklist and the lists ("Pinned", "Recently opened"), and after
            the lists (recent agent changes across knowledge bases), each a
            `<section>` with an `<h2>` like `KbSection`. docs/ui.md § The
            signed-in home. */}
        <KbSection
          relation="owned"
          query={owned}
          lang={lang}
          onOpen={open}
          title={t("list.owned")}
          emptyTitle={t("list.ownedEmptyTitle")}
          emptyDescription={t("list.ownedEmptyDescription")}
        />
        <KbSection
          relation="shared"
          query={shared}
          lang={lang}
          onOpen={open}
          title={t("list.shared")}
          emptyTitle={t("list.sharedEmptyTitle")}
          emptyDescription={t("list.sharedEmptyDescription")}
        />
        <KbCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(kb) => {
            if (createdKbDestination(kb) === "open") open(kb.id);
            else toast.success(t("create.createdNoRead"));
          }}
        />
      </PageShell>
    </PullToRefresh>
  );
}

/**
 * The getting-started checklist, with every done state read from data:
 *
 * - **Create a knowledge base**: done once the "Owned" list has one (its
 *   first page, the same request as the section below). The action opens
 *   the page's create dialog.
 * - **Connect an AI client**: done once a personal access token, an MCP
 *   token minted by an API key, or a connected OAuth app is live
 *   (`mcpGrants.countActiveMine`, the count Settings → MCP uses). The action
 *   links to Settings → MCP, whose connect card walks through it. A failed
 *   count leaves the step out rather than guessing.
 * - **Share a knowledge base**: done once the user sent an unrevoked
 *   invitation or has a live member on a KB they own
 *   (`kbs.shareStatusMine`). The action opens the members tab of their first
 *   owned KB; with none yet, it opens the create dialog (sharing needs one).
 *   A failed read leaves the step out.
 * - **Invite someone** (admins): `useAccountSetupSteps`.
 *
 * Mounted only once every read behind it answered (it has no skeleton, and
 * a guess would tick wrongly and then move the page). While the user has it
 * hidden, none of those reads run.
 */
function KbHomeChecklist({
  lang,
  user,
  owned,
  onCreate,
}: {
  lang: string;
  user: { id: string; role?: string | null };
  owned: KbListQuery;
  onCreate: () => void;
}) {
  const { t } = useTranslation("kb");
  const hidden = useGettingStartedHidden(user.id);
  const clients = useQuery({
    ...orpc.mcpGrants.countActiveMine.queryOptions(),
    enabled: !hidden,
    // Both steps are done elsewhere (a client connects from its own app; a
    // share is sent from a KB's members tab): ask again whenever the home
    // mounts, so coming back never shows a cached "not yet".
    refetchOnMount: "always",
    // A failure only drops the step; no toast for a convenience read.
    meta: { skipGlobalErrorToast: true },
  });
  const sharing = useQuery({
    ...orpc.kbs.shareStatusMine.queryOptions(),
    enabled: !hidden,
    refetchOnMount: "always",
    meta: { skipGlobalErrorToast: true },
  });
  const account = useAccountSetupSteps({ lang, user, enabled: !hidden });

  if (hidden || !owned.isSuccess || clients.isPending || sharing.isPending || account.isPending) {
    return null;
  }

  const firstOwned = owned.data.pages[0]?.items[0];

  const steps: GettingStartedStep[] = [
    {
      id: "create-kb",
      title: t("gettingStarted.createKb.title"),
      description: t("gettingStarted.createKb.description"),
      done: firstOwned !== undefined,
      action: { label: t("gettingStarted.createKb.action"), onClick: onCreate },
    },
  ];
  if (clients.isSuccess) {
    steps.push({
      id: "connect-client",
      title: t("gettingStarted.connectClient.title"),
      description: t("gettingStarted.connectClient.description"),
      done: hasConnectedClient(clients.data),
      action: {
        label: t("gettingStarted.connectClient.action"),
        link: { to: "/$lang/settings/mcp", params: { lang } },
      },
    });
  }
  if (sharing.isSuccess) {
    steps.push({
      id: "share-kb",
      title: t("gettingStarted.shareKb.title"),
      description: firstOwned
        ? t("gettingStarted.shareKb.description")
        : t("gettingStarted.shareKb.descriptionNoKb"),
      done: sharing.data.shared,
      action: firstOwned
        ? {
            label: t("gettingStarted.shareKb.action"),
            link: {
              to: "/$lang/kbs/$kbId/settings",
              params: { lang, kbId: firstOwned.id },
              search: { tab: "members" },
            },
          }
        : { label: t("gettingStarted.createKb.action"), onClick: onCreate },
    });
  }
  steps.push(...account.steps);

  return <GettingStarted scope={user.id} steps={steps} />;
}

/** One relation of the caller's KBs ("Owned" or "Shared with me"), paginated on its own. */
function KbSection({
  relation,
  query,
  lang,
  onOpen,
  title,
  emptyTitle,
  emptyDescription,
}: {
  relation: Relation;
  query: KbListQuery;
  lang: string;
  onOpen: (kbId: string) => void;
  title: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const { t } = useTranslation("kb");
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
  } = query;
  // An access failure (session revoked) hides the cached list, as
  // QueryBoundary does for the cards, so its count goes too.
  const visible = isQueryAccessError(error) ? undefined : data;
  const items = visible?.pages.flatMap((page) => page?.items ?? []) ?? [];
  const headingId = `kb-list-${relation}`;
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
        <KbCount loaded={visible !== undefined} count={items.length} more={hasNextPage} />
      </h2>
      <QueryBoundary
        query={{ data, error, isPending, isError, fetchStatus, refetch }}
        errorMessage={t("list.loadFailed")}
        skeleton={
          <div className={`grid gap-3 ${KB_GRID_CLASS}`} aria-busy="true">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        }
      >
        {() => (
          <>
            <KbList
              lang={lang}
              items={items}
              onOpen={onOpen}
              emptyTitle={emptyTitle}
              emptyDescription={emptyDescription}
            />
            <LoadMore
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onLoadMore={() => fetchNextPage()}
            />
          </>
        )}
      </QueryBoundary>
    </section>
  );
}

/**
 * The section's count after its title ("Owned · 4"): what is loaded, with a
 * "+" while more pages exist, so it never claims a total it has not seen.
 * Nothing while loading or when the list is empty (the empty state says so).
 */
function KbCount({ loaded, count, more }: { loaded: boolean; count: number; more: boolean }) {
  const { t } = useTranslation("kb");
  if (!loaded || count === 0) return null;
  return (
    <span className="font-normal text-muted-foreground">
      <span aria-hidden="true"> · </span>
      <span className="sr-only"> </span>
      {more ? t("list.countMore", { count }) : t("list.count", { count })}
    </span>
  );
}
