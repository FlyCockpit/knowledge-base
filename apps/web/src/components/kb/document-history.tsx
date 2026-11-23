import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

type HistoryPage = Awaited<ReturnType<AppRouterClient["documents"]["history"]>>;
type DocumentHistoryRow = NonNullable<HistoryPage>["items"][number];
export type DocumentProvenance = "dream" | "agent" | "human" | "absent";
export type HistoryActor = DocumentHistoryRow["actor"];

const PROVENANCE_TONE: Record<DocumentProvenance, PillTone> = {
  human: "good",
  agent: "info",
  dream: "busy",
  absent: "muted",
};

/** Who wrote a document, from its front matter: Person, Agent, Dream or Unspecified. */
export function ProvenanceBadge({
  provenance,
  prefix,
}: {
  provenance: DocumentProvenance;
  /** Visible lead-in, e.g. "Before" on a pull request file. */
  prefix?: string;
}) {
  const { t } = useTranslation("kb");
  const label = t(`provenance.${provenance}.label`);
  return (
    <StatusPill
      tone={PROVENANCE_TONE[provenance]}
      title={t(`provenance.${provenance}.description`)}
      data-testid="provenance-badge"
      data-provenance={provenance}
    >
      {prefix ? t("provenance.prefixed", { prefix, label }) : label}
    </StatusPill>
  );
}

/**
 * "Ana in the web app", "Ana via credential “laptop”", or unattributed (a Git
 * push or an older commit). A credential's name is always quoted as one, so a
 * token named "web" never reads like the browser.
 */
export function actorLine(t: TFunction<"kb">, actor: HistoryActor): string {
  if (actor.kind === "unattributed") return t("history.unattributed");
  const name = actor.name ?? t("history.unknownPerson");
  if (actor.kind === "web") return t("history.viaWeb", { name });
  return actor.via === null
    ? t("history.viaUnknownCredential", { name })
    : t("history.viaCredential", { name, via: actor.via });
}

/**
 * The document's history on main, newest first: when, the commit subject,
 * who made it (person via web, or person via a token or app; Git pushes and
 * older commits are unattributed) and the label the document had there.
 * Each row opens that revision. Loaded rows stay on a failed refetch.
 */
/** The loaded rows to show: none once access is denied (cached private rows are hidden). */
export function visibleHistoryRows<R>(
  pages: readonly ({ items: readonly R[] } | null | undefined)[] | undefined,
  denied: boolean,
): R[] {
  return denied ? [] : (pages ?? []).flatMap((page) => [...(page?.items ?? [])]);
}

export function DocumentHistory({
  lang,
  kbId,
  path,
}: {
  lang: string;
  kbId: string;
  path: string;
}) {
  const { t } = useTranslation("kb");
  const history = useInfiniteQuery(
    orpc.documents.history.infiniteOptions({
      input: (cursor: string | undefined) => ({ kbId, path, limit: 20, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (last) => last?.nextCursor ?? undefined,
    }),
  );
  const {
    data,
    error,
    isPending,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = history;
  // A denial (on any page, a later one included) hides every loaded row and
  // triggers the KB-wide access recheck; only transient errors keep rows.
  const lost = useKbAccessLoss(kbId, [error]);
  const denied = lost || isQueryAccessError(error);
  const rows = visibleHistoryRows(data?.pages, denied);
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
    <section className="min-w-0 space-y-3" aria-labelledby="document-history-title">
      <h2 id="document-history-title" className="text-lg font-semibold">
        {t("history.title")}
      </h2>
      {isPending ? (
        <ul className="space-y-2" aria-hidden>
          {[0, 1, 2].map((key) => (
            <li key={key} className="space-y-1 rounded-md border p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 && isError ? (
        <InlineRetry message={t("history.loadFailed")} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("history.empty")}</p>
      ) : (
        <ul className="min-w-0 space-y-2" data-testid="document-history">
          {rows.map((row) => (
            <li key={row.sha} className="min-w-0 space-y-1 rounded-md border p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {row.deleted ? (
                  <span className="min-w-0 break-words text-sm font-medium">{row.subject}</span>
                ) : (
                  <Link
                    to="/$lang/kbs/$kbId/documents"
                    params={{ lang, kbId }}
                    search={{ path, rev: row.sha }}
                    className="inline-flex min-h-[44px] min-w-0 items-center break-words text-sm font-medium underline-offset-2 hover:underline"
                  >
                    {row.subject || t("history.noSubject")}
                  </Link>
                )}
                {row.deleted ? (
                  <StatusPill tone="bad">{t("history.deleted")}</StatusPill>
                ) : row.provenance ? (
                  <ProvenanceBadge provenance={row.provenance} />
                ) : null}
              </div>
              <p className="min-w-0 break-words text-xs text-muted-foreground">
                {t("history.meta", {
                  actor: actorLine(t, row.actor),
                  date: date(row.committedAt),
                  sha: row.sha.slice(0, 7),
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && isError && !isFetchingNextPage && (
        <InlineRetry
          variant="destructive"
          message={t("history.loadFailed")}
          onRetry={() => (hasNextPage ? fetchNextPage() : refetch())}
        />
      )}
      <LoadMore
        onLoadMore={() => fetchNextPage()}
        hasNextPage={!denied && hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
      />
    </section>
  );
}
