import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, FileX } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { actorLine } from "@/components/kb/document-history";
import { RestoreVersionDialog } from "@/components/kb/document-restore";
import { LoadMore } from "@/components/load-more";
import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

type Restoring = { path: string; revision: string };

type DeletedPage = NonNullable<Awaited<ReturnType<AppRouterClient["documents"]["deleted"]>>>;
type DeletedDocumentRow = DeletedPage["items"][number];

/**
 * What the list shows from its loaded pages. The window and whether the
 * scan's bounds cut it short come from the server, so the text says exactly
 * what the list covers: an empty capped scan (the newest deletions were all
 * recreated) says nothing about older ones in the window, so it never
 * claims "nothing was deleted". A denied list shows nothing.
 */
export function deletedListState(
  pages: readonly (DeletedPage | undefined)[] | undefined,
  denied: boolean,
): {
  rows: DeletedDocumentRow[];
  days: number | null;
  /** The text under an empty list, or the note under a non-empty one. */
  note:
    | { key: "deleted.empty"; days: number }
    | { key: "deleted.cappedEmpty" | "deleted.capped" }
    | null;
} {
  if (denied || !pages) return { rows: [], days: null, note: null };
  const rows = pages.flatMap((page) => page?.items ?? []);
  const days = pages[0]?.windowDays ?? null;
  const capped = pages.some((page) => page?.capped);
  const note =
    rows.length === 0
      ? capped
        ? { key: "deleted.cappedEmpty" as const }
        : { key: "deleted.empty" as const, days: days ?? 30 }
      : capped
        ? { key: "deleted.capped" as const }
        : null;
  return { rows, days, note };
}

/**
 * "Recently deleted" on the KB page: documents deleted from main in the
 * server's window (the last 30 days) that main no longer has, newest
 * deletion first. Each opens its last version or restores it as a new
 * revision; an older one still opens from its own link. Collapsed until
 * asked for: nothing is read before then.
 */
export function DeletedDocuments({
  lang,
  kbId,
  kbHeadSha,
  canRestore,
  proposing,
  onRestored,
}: {
  lang: string;
  kbId: string;
  kbHeadSha: string | null;
  canRestore: boolean;
  proposing: boolean;
  /** Restored (or proposed) `path`: open it. */
  onRestored: (path: string, proposalNumber: number | null) => void;
}) {
  const { t } = useTranslation("kb");
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState<Restoring | null>(null);
  const deleted = useInfiniteQuery({
    ...orpc.documents.deleted.infiniteOptions({
      input: (cursor: string | undefined) => ({ kbId, limit: 20, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last?.nextCursor ?? undefined,
    }),
    enabled: open,
    retry: false,
  });
  const {
    data,
    error,
    isPending,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = deleted;
  const lost = useKbAccessLoss(kbId, [error]);
  const denied = lost || isQueryAccessError(error);
  const { rows, days, note } = deletedListState(data?.pages, denied);
  const date = (value: string | null) =>
    value === null
      ? t("history.unknownDate")
      : new Date(value).toLocaleString(lang, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });

  return (
    <section className="min-w-0 space-y-3" aria-labelledby={`${listId}-title`}>
      <h2 id={`${listId}-title`} className="sr-only">
        {t("deleted.title")}
      </h2>
      <Button
        variant="ghost"
        className="min-h-[44px] px-2"
        data-testid="deleted-documents-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 transition-transform motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
        />
        {t("deleted.title")}
      </Button>
      {open && (
        <div id={listId} className="min-w-0 space-y-3">
          {days !== null && (
            <p className="text-sm text-muted-foreground">{t("deleted.description", { days })}</p>
          )}
          {isPending ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : rows.length === 0 && isError ? (
            <InlineRetry message={t("deleted.loadFailed")} onRetry={() => refetch()} />
          ) : rows.length === 0 ? (
            note && <p className="text-sm text-muted-foreground">{t(note.key, note)}</p>
          ) : (
            <ul
              data-testid="deleted-documents"
              className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
            >
              {rows.map((row) => (
                <li
                  key={row.path}
                  className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <FileX aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm">{row.path}</p>
                      <p className="text-xs text-muted-foreground">
                        {t("deleted.meta", {
                          date: date(row.deletedAt),
                          actor: actorLine(t, row.actor),
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Link
                      to="/$lang/kbs/$kbId/documents"
                      params={{ lang, kbId }}
                      search={{ path: row.path, rev: row.revision }}
                      aria-label={t("deleted.viewNamed", { path: row.path })}
                      className={cn(buttonVariants({ variant: "outline", size: "touch" }))}
                    >
                      {t("deleted.view")}
                    </Link>
                    {canRestore && kbHeadSha && (
                      <Button
                        size="touch"
                        data-testid="deleted-restore"
                        aria-label={t(proposing ? "deleted.proposeNamed" : "deleted.restoreNamed", {
                          path: row.path,
                        })}
                        onClick={() => setRestoring({ path: row.path, revision: row.revision })}
                      >
                        {proposing ? t("deleted.propose") : t("deleted.restore")}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && isError && !isFetchingNextPage && (
            <InlineRetry
              variant="destructive"
              message={t("deleted.loadFailed")}
              onRetry={() => (hasNextPage ? fetchNextPage() : refetch())}
            />
          )}
          {rows.length > 0 && note && !hasNextPage && (
            <p className="text-sm text-muted-foreground">{t(note.key)}</p>
          )}
          <LoadMore
            onLoadMore={() => fetchNextPage()}
            hasNextPage={!denied && hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
          />
        </div>
      )}
      {restoring && kbHeadSha && (
        <RestoreVersionDialog
          key={`${restoring.path}@${restoring.revision}`}
          lang={lang}
          kbId={kbId}
          kbHeadSha={kbHeadSha}
          proposing={proposing}
          path={restoring.path}
          revision={restoring.revision}
          open
          onOpenChange={(next) => !next && setRestoring(null)}
          onRestored={(outcome) => {
            const path = restoring.path;
            setRestoring(null);
            onRestored(path, outcome.kind === "proposed" ? outcome.proposalNumber : null);
          }}
        />
      )}
    </section>
  );
}
