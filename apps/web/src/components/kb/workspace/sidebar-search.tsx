import { Button } from "@knowledge-base/ui/components/button";
import { Input } from "@knowledge-base/ui/components/input";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Search } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { kbDocumentHref } from "@/components/kb/kb-links";
import { routerClick } from "@/components/kb/kb-list";
import { type CitationHitLike, searchView } from "@/components/kb/search-results";
import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import { headingForSnippet } from "@/lib/kb-workspace/snippet-heading";
import {
  assessRelevance,
  highlightSnippet,
  highlightTerms,
  partitionByFloor,
} from "@/lib/search-relevance";
import { orpc } from "@/utils/orpc";

/** Query length bound of the hybrid search input (Unicode scalars, as the KB home's search). */
const QUERY_MAX = 1024;

/**
 * Search in the workspace sidebar: the KB's hybrid search (the same request
 * as the KB home's plain query), compact hits with the query's words
 * highlighted and the same relevance bands and floor. Opening a hit jumps to
 * the heading its passage sits under: the cited version is read (immutable,
 * cached), the snippet located, and `onOpen` gets that heading's id.
 */
export function SidebarSearch({
  lang,
  kbId,
  onOpen,
}: {
  lang: string;
  kbId: string;
  /** `rev`: the version the hit was cited at (its heading is looked up there). */
  onOpen: (path: string, hash: string | undefined, rev: string) => void;
}) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const query = submitted?.trim() ?? "";
  const input = query !== "" ? { kbId, query } : skipToken;
  const hybrid = useQuery(orpc.search.hybrid.queryOptions({ input, retry: false }));
  const lost = useKbAccessLoss(kbId, [hybrid.error]);
  const view = searchView({
    enabled: input !== skipToken,
    isPending: hybrid.isPending,
    isError: hybrid.isError,
    error: hybrid.error,
    hits: hybrid.data?.results,
    meta: hybrid.data,
    query,
  });
  const open = async (hit: CitationHitLike) => {
    let hash: string | undefined;
    try {
      const document = await queryClient.fetchQuery(
        orpc.documents.get.queryOptions({
          input: { kbId, path: hit.path, rev: hit.commitSha },
          retry: false,
        }),
      );
      hash = (document && headingForSnippet(document.markdown, hit.snippet)) ?? undefined;
    } catch {
      // The document opens anyway; its own page reports what is wrong.
    }
    onOpen(hit.path, hash, hit.commitSha);
  };
  if (lost) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-search">
      <form
        role="search"
        className="flex gap-1 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if ([...draft.trim()].length <= QUERY_MAX) setSubmitted(draft);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {t("workspace.search.label")}
        </label>
        <Input
          id={inputId}
          data-workspace-search-input=""
          type="search"
          inputMode="search"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={2048}
          placeholder={t("workspace.search.placeholder")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-9 pointer-coarse:min-h-11"
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon-touch"
          aria-label={t("workspace.search.submit")}
          title={t("workspace.search.submit")}
        >
          <Search aria-hidden className="size-4" />
        </Button>
      </form>
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-clip p-2"
        aria-live="polite"
        aria-busy={view.kind === "loading"}
      >
        {view.kind === "idle" ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">{t("workspace.search.idle")}</p>
        ) : view.kind === "loading" ? (
          <ul className="space-y-3 p-1">
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-1.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </li>
            ))}
          </ul>
        ) : view.kind === "error" ? (
          <InlineRetry
            variant="destructive"
            message={view.unavailable ? t("search.indexUnavailable") : t("search.error")}
            onRetry={() => void hybrid.refetch()}
          />
        ) : (
          <SidebarHits
            lang={lang}
            kbId={kbId}
            hits={view.hits}
            calibration={view.calibration}
            query={query}
            onOpen={(hit) => void open(hit)}
          />
        )}
      </div>
    </div>
  );
}

/** The hits above the relevance floor, the weaker ones collapsed, or why there are none. */
export function SidebarHits({
  lang,
  kbId,
  hits,
  calibration,
  query,
  onOpen,
}: {
  lang: string;
  kbId: string;
  hits: readonly CitationHitLike[];
  calibration: string | undefined;
  query: string;
  onOpen: (hit: CitationHitLike) => void;
}) {
  const { t } = useTranslation("kb");
  const [showWeaker, setShowWeaker] = useState(false);
  const weakerId = useId();
  const terms = highlightTerms(query);
  const { shown, weaker } = partitionByFloor(hits, calibration);
  const list = (items: readonly CitationHitLike[], label: string) => (
    <ul aria-label={label} className="space-y-0.5">
      {items.map((hit) => (
        <SidebarHit
          key={`${hit.commitSha}:${hit.path}:${hit.chunkIndex}`}
          lang={lang}
          kbId={kbId}
          hit={hit}
          calibration={calibration}
          terms={terms}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
  if (hits.length === 0)
    return (
      <div role="status" className="space-y-1 px-2 py-1 text-sm">
        <p className="text-muted-foreground">{t("search.noResults")}</p>
        <p className="text-xs text-muted-foreground">{t("search.relevance.noCloseHint")}</p>
      </div>
    );
  return (
    <div className="space-y-2">
      {shown.length > 0 ? (
        list(shown, t("workspace.search.results"))
      ) : (
        <div role="status" data-testid="workspace-search-no-close" className="space-y-1 px-2 py-1">
          <p className="text-sm font-medium">{t("search.relevance.noClose")}</p>
          <p className="text-xs text-muted-foreground">{t("search.relevance.noCloseHint")}</p>
        </div>
      )}
      {weaker.length > 0 && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="touch"
            className="w-full justify-start gap-2 px-2 text-xs text-muted-foreground"
            aria-expanded={showWeaker}
            aria-controls={weakerId}
            onClick={() => setShowWeaker((open) => !open)}
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "size-4 transition-transform motion-reduce:transition-none",
                showWeaker && "rotate-180",
              )}
            />
            {t("search.relevance.weaker", { count: weaker.length })}
          </Button>
          <div id={weakerId} hidden={!showWeaker}>
            {showWeaker && list(weaker, t("search.relevance.weaker", { count: weaker.length }))}
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarHit({
  lang,
  kbId,
  hit,
  calibration,
  terms,
  onOpen,
}: {
  lang: string;
  kbId: string;
  hit: CitationHitLike;
  calibration: string | undefined;
  terms: readonly string[];
  onOpen: (hit: CitationHitLike) => void;
}) {
  const { t } = useTranslation("kb");
  const slash = hit.path.lastIndexOf("/");
  const band = hit.relevance ? assessRelevance(hit.relevance, calibration) : null;
  return (
    <li>
      <a
        // Open in a new tab: the version it was cited at, as the KB page's search links.
        href={kbDocumentHref(lang, kbId, { path: hit.path, rev: hit.commitSha })}
        onClick={routerClick(() => onOpen(hit))}
        data-testid="workspace-search-hit"
        className="block min-h-11 space-y-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-mono text-sm font-medium" title={hit.path}>
            {hit.path.slice(slash + 1)}
          </span>
          {band && band.band !== "neutral" && (
            <span
              className="ml-auto shrink-0 text-xs text-muted-foreground"
              data-testid="workspace-search-band"
              data-band={band.band}
            >
              {t(`search.relevance.band.${band.band}`)}
            </span>
          )}
        </span>
        {slash >= 0 && (
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {hit.path.slice(0, slash + 1)}
          </span>
        )}
        <span className="line-clamp-3 block text-xs break-words text-muted-foreground">
          {highlightSnippet(hit.snippet, terms).map((part, at) =>
            part.match ? (
              <mark
                key={at}
                className="rounded-sm bg-amber-200/70 px-0.5 text-foreground dark:bg-amber-400/30"
              >
                {part.text}
              </mark>
            ) : (
              <span key={at}>{part.text}</span>
            ),
          )}
        </span>
      </a>
    </li>
  );
}
