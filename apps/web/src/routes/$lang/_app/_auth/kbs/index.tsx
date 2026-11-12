import { Button } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createdKbDestination, KbCreateDialog, KbList } from "@/components/kb/kb-list";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/kbs/")({
  head: ({ match }) => pageHead(match.context.i18n.t("nav:items.knowledgeBases")),
  component: KbIndexPage,
});

function KbIndexPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("kb");
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const open = (kbId: string) => navigate({ to: "/$lang/kbs/$kbId", params: { lang, kbId } });

  return (
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
      <KbSection
        relation="owned"
        lang={lang}
        onOpen={open}
        title={t("list.owned")}
        emptyTitle={t("list.ownedEmptyTitle")}
        emptyDescription={t("list.ownedEmptyDescription")}
      />
      <KbSection
        relation="shared"
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
  );
}

/** One relation of the caller's KBs ("Owned" or "Shared with me"), paginated on its own. */
function KbSection({
  relation,
  lang,
  onOpen,
  title,
  emptyTitle,
  emptyDescription,
}: {
  relation: "owned" | "shared";
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
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery(
    orpc.kbs.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: 20, cursor, relation }),
      initialPageParam: null,
      getNextPageParam: (last) => last?.nextCursor ?? null,
    }),
  );
  const items = data?.pages.flatMap((page) => page?.items ?? []) ?? [];
  const headingId = `kb-list-${relation}`;
  return (
    <section aria-labelledby={headingId} className="min-w-0 space-y-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      <QueryBoundary
        query={{ data, error, isPending, isError, refetch }}
        errorMessage={t("list.loadFailed")}
        skeleton={
          <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
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
