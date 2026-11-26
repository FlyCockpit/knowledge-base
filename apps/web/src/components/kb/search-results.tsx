import { refineUnicodeScalarBounds } from "@knowledge-base/api/lib/schemas";
import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { isAdminRole } from "@knowledge-base/auth/roles";
import { Button } from "@knowledge-base/ui/components/button";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@knowledge-base/ui/components/popover";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Info } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { kbDocumentHref } from "@/components/kb/kb-links";
import { routerClick } from "@/components/kb/kb-list";
import { LoadMore } from "@/components/load-more";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import {
  assessRelevance,
  type HitRelevance,
  highlightSnippet,
  highlightTerms,
  partitionByFloor,
} from "@/lib/search-relevance";
import { orpc } from "@/utils/orpc";
import { formatRelativeTime } from "@/utils/relative-time";

type HybridOutput = Awaited<ReturnType<AppRouterClient["search"]["hybrid"]>>;
/** A citation hit; hybrid (browser) hits also carry their `relevance`. */
export type CitationHitLike = Omit<HybridOutput["results"][number], "relevance"> & {
  relevance?: HitRelevance;
};
type Freshness = HybridOutput["freshness"];
type SearchMeta = {
  freshness: Freshness;
  indexedCommitSha: string | null;
  headSha: string;
  /** This KB was searched using an index awaiting re-embedding. */
  indexNotices: HybridOutput["indexNotices"];
  /** Hybrid only: which threshold table the relevance bands use. */
  calibration?: string;
  /** Hybrid only: when the indexed commit was saved (ISO 8601), when known. */
  indexedCommittedAt?: string | null;
};

export type SearchView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; unavailable: boolean }
  | ({ kind: "results"; hits: readonly CitationHitLike[]; query?: string } & SearchMeta);

const errorKbCode = (error: unknown) => (error as { data?: { code?: unknown } } | null)?.data?.code;

/**
 * An error always wins over cached data: TanStack keeps the last page on a
 * failed refetch, and showing it would be a substitute result.
 */
export function searchView(state: {
  enabled: boolean;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hits?: readonly CitationHitLike[];
  meta?: SearchMeta;
  /** The submitted query, for highlighting its words in snippets. */
  query?: string;
}): SearchView {
  if (!state.enabled) return { kind: "idle" };
  if (state.isError) {
    return { kind: "error", unavailable: errorKbCode(state.error) === "INDEX_UNAVAILABLE" };
  }
  if (state.isPending || !state.hits || !state.meta) return { kind: "loading" };
  return {
    kind: "results",
    hits: state.hits,
    freshness: state.meta.freshness,
    indexedCommitSha: state.meta.indexedCommitSha,
    headSha: state.meta.headSha,
    indexNotices: state.meta.indexNotices,
    ...(state.meta.calibration !== undefined ? { calibration: state.meta.calibration } : {}),
    ...(state.meta.indexedCommittedAt !== undefined
      ? { indexedCommittedAt: state.meta.indexedCommittedAt }
      : {}),
    ...(state.query ? { query: state.query } : {}),
  };
}

/** Citation navigation always opens the cited immutable commit, never current HEAD. */
export const citationTarget = (hit: Pick<CitationHitLike, "path" | "commitSha">) => ({
  path: hit.path,
  rev: hit.commitSha,
});

export function parseTags(raw: string): string[] {
  const tags = raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  // Invalid filters are rejected before submission, never silently dropped.
  return [...new Set(tags)];
}

const scalarField = (max: number) =>
  z
    .string()
    .trim()
    .superRefine((value, ctx) => refineUnicodeScalarBounds(value, ctx, { max }));
export const searchDraftSchema = z.object({
  query: scalarField(1024),
  type: scalarField(256),
  title: scalarField(256),
  tags: z
    .string()
    .transform(parseTags)
    .pipe(z.array(scalarField(64)).max(16)),
});

type Filters = { type: string; title: string; tags: string };
export const hasStructuredFilters = (f: Filters) =>
  f.type.trim() !== "" || f.title.trim() !== "" || parseTags(f.tags).length > 0;

const short = (sha: string) => sha.slice(0, 12);

/** Index freshness as a status pill tone (search results and the KB header). */
export const FRESHNESS_TONE: Record<Freshness, PillTone> = {
  current: "good",
  stale: "busy",
  building: "info",
  failed: "bad",
  unavailable: "muted",
};

type IndexNotice = HybridOutput["indexNotices"][number];

/**
 * Why this KB was searched by keywords only, with where to fix it: the KB's settings, and
 * for instance admins the built-in model in admin settings.
 */
function LexicalOnlyNotice({
  lang,
  kbId,
  notice,
  isAdmin,
}: {
  lang: string;
  kbId: string;
  notice: IndexNotice;
  isAdmin: boolean;
}) {
  const { t } = useTranslation("kb");
  return (
    <p role="note" data-testid="search-index-notice" className="text-xs text-muted-foreground">
      {t(`search.indexNotice.${notice.detail}`)}
      {/* A semantic index that is still building needs no action. */}
      {notice.detail !== "SEMANTIC_INDEX_BUILDING" && (
        <>
          {" "}
          <Link
            to="/$lang/kbs/$kbId/settings"
            params={{ lang, kbId }}
            className="underline underline-offset-4"
          >
            {t("search.lexicalSettingsLink")}
          </Link>
        </>
      )}
      {isAdmin && notice.detail !== "SEMANTIC_INDEX_BUILDING" && (
        <>
          {" · "}
          <Link
            to="/$lang/admin/settings"
            params={{ lang }}
            className="underline underline-offset-4"
          >
            {t("search.lexicalAdminLink")}
          </Link>
        </>
      )}
    </p>
  );
}

export function SearchResultList({
  lang,
  kbId,
  view,
  onRetry,
  onOpen,
  isAdmin = false,
}: {
  lang: string;
  kbId: string;
  view: SearchView;
  onRetry: () => void;
  onOpen?: (target: { path: string; rev: string }) => void;
  /** Instance admins also get a link to the built-in model settings. */
  isAdmin?: boolean;
}) {
  const { t } = useTranslation("kb");
  if (view.kind === "idle") return null;
  if (view.kind === "loading") {
    return (
      <ul className="space-y-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="space-y-2 rounded-md border p-3">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-full" />
          </li>
        ))}
      </ul>
    );
  }
  if (view.kind === "error") {
    return (
      <InlineRetry
        variant="destructive"
        message={view.unavailable ? t("search.indexUnavailable") : t("search.error")}
        onRetry={onRetry}
      />
    );
  }
  return (
    <div className="min-w-0 space-y-3">
      <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusPill tone={FRESHNESS_TONE[view.freshness]}>
          {t(`search.freshness.${view.freshness}`)}
        </StatusPill>
        {view.indexedCommitSha
          ? t("search.indexed", {
              indexed: short(view.indexedCommitSha),
              head: short(view.headSha),
            })
          : t("search.notIndexed")}
      </p>
      {view.indexNotices.map((notice) =>
        notice.code === "LEXICAL_ONLY" ? (
          <LexicalOnlyNotice
            key={`${notice.kbId}:${notice.detail}`}
            lang={lang}
            kbId={kbId}
            notice={notice}
            isAdmin={isAdmin}
          />
        ) : (
          <p
            key={`${notice.kbId}:${notice.detail}`}
            role="note"
            data-testid="search-index-notice"
            className="text-xs text-muted-foreground"
          >
            {t(`search.indexNotice.${notice.detail}`)}
          </p>
        ),
      )}
      <SearchHits lang={lang} kbId={kbId} view={view} onOpen={onOpen} />
    </div>
  );
}

/**
 * The hits above the relevance floor, then the weaker ones collapsed under
 * "Weaker matches". When none is close: "No close matches" and what to try.
 */
function SearchHits({
  lang,
  kbId,
  view,
  onOpen,
}: {
  lang: string;
  kbId: string;
  view: Extract<SearchView, { kind: "results" }>;
  onOpen?: (target: { path: string; rev: string }) => void;
}) {
  const { t } = useTranslation("kb");
  const [showWeaker, setShowWeaker] = useState(false);
  const weakerId = useId();
  const { shown, weaker } = partitionByFloor(view.hits, view.calibration);
  const terms = highlightTerms(view.query ?? "");
  const list = (hits: readonly CitationHitLike[], testId: string) => (
    <ul
      data-testid={testId}
      className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
    >
      {hits.map((hit) => (
        <SearchHitRow
          key={`${hit.commitSha}:${hit.path}:${hit.chunkIndex}:${hit.span.startByte}`}
          lang={lang}
          kbId={kbId}
          hit={hit}
          view={view}
          terms={terms}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
  if (view.hits.length === 0)
    return (
      <div role="status" className="space-y-1 text-sm">
        <p className="text-muted-foreground">{t("search.noResults")}</p>
        <p className="text-xs text-muted-foreground">{t("search.relevance.noCloseHint")}</p>
      </div>
    );
  return (
    <div className="min-w-0 space-y-3">
      {shown.length > 0 ? (
        list(shown, "search-hits")
      ) : (
        <div
          role="status"
          data-testid="search-no-close"
          className="space-y-1 rounded-md border p-4 text-sm"
        >
          <p className="font-medium">{t("search.relevance.noClose")}</p>
          <p className="text-muted-foreground">{t("search.relevance.noCloseHint")}</p>
        </div>
      )}
      {weaker.length > 0 && (
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            className="min-h-[44px] gap-2 px-2"
            aria-expanded={showWeaker}
            aria-controls={weakerId}
            onClick={() => setShowWeaker((open) => !open)}
          >
            <ChevronDown
              aria-hidden
              className={`size-4 transition-transform motion-reduce:transition-none ${showWeaker ? "rotate-180" : ""}`}
            />
            {t("search.relevance.weaker", { count: weaker.length })}
          </Button>
          <div id={weakerId} hidden={!showWeaker}>
            {showWeaker && list(weaker, "search-weaker-hits")}
          </div>
        </div>
      )}
    </div>
  );
}

const BAND_TONE = {
  strong: "bg-emerald-600 dark:bg-emerald-400",
  related: "bg-sky-600 dark:bg-sky-400",
  keyword: "bg-sky-600 dark:bg-sky-400",
  weak: "bg-amber-600 dark:bg-amber-400",
} as const;

/** A small three-step meter, its band in words, and the honest numbers on request. */
function RelevanceMeter({
  relevance,
  calibration,
}: {
  relevance: HitRelevance;
  calibration: string | undefined;
}) {
  const { t } = useTranslation("kb");
  const { band, level } = assessRelevance(relevance, calibration);
  const label = t(`search.relevance.band.${band}`);
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="search-relevance">
      <span
        role="meter"
        aria-label={t("search.relevance.meterLabel")}
        aria-valuemin={0}
        aria-valuemax={3}
        aria-valuenow={level}
        aria-valuetext={label}
        className="inline-flex items-end gap-0.5"
      >
        {[1, 2, 3].map((step) => (
          <span
            key={step}
            aria-hidden
            className={`w-1.5 rounded-sm ${step === 1 ? "h-1.5" : step === 2 ? "h-2.5" : "h-3.5"} ${
              step <= level ? BAND_TONE[band] : "bg-muted-foreground/25"
            }`}
          />
        ))}
      </span>
      <Popover>
        <PopoverTrigger
          className="relative inline-flex min-h-6 items-center gap-1 rounded-md px-1 font-medium pointer-coarse:min-h-11 text-foreground after:absolute after:-inset-y-3 after:-inset-x-1 after:content-[''] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("search.relevance.detailsLabel", { band: label })}
        >
          {label}
          <Info aria-hidden className="size-3.5 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent className="w-72 max-w-[calc(100vw-2rem)] text-xs leading-relaxed">
          {/* Names the details dialog (the trigger's label does not label the popup). */}
          <PopoverTitle className="text-xs font-semibold">
            {t("search.relevance.meterLabel")}
          </PopoverTitle>
          <RelevanceDetails relevance={relevance} calibration={calibration} />
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** The honest numbers behind a band (the meter's details popover). */
export function RelevanceDetails({
  relevance,
  calibration,
}: {
  relevance: HitRelevance;
  calibration: string | undefined;
}) {
  const { t } = useTranslation("kb");
  const semantic = relevance.semantic;
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("search.relevance.semantic")}</dt>
        <dd className="font-mono tabular-nums" data-testid="search-relevance-semantic">
          {semantic === null
            ? t(
                calibration === "lexical"
                  ? "search.relevance.semanticUnavailable"
                  : "search.relevance.semanticNotRanked",
              )
            : semantic.toFixed(2)}
        </dd>
        <dt className="text-muted-foreground">{t("search.relevance.keyword")}</dt>
        <dd data-testid="search-relevance-keyword">
          {relevance.keyword
            ? t(
                // A keyword-only search admits a passage on any one word of
                // the search; hybrid search needs most of them.
                calibration === "lexical"
                  ? "search.relevance.keywordYesLexical"
                  : "search.relevance.keywordYes",
              )
            : t("search.relevance.keywordNo")}
        </dd>
      </dl>
      <p className="text-muted-foreground">
        {t(
          calibration === "lexical"
            ? "search.relevance.explainLexical"
            : "search.relevance.explain",
        )}
      </p>
    </>
  );
}

function SearchHitRow({
  lang,
  kbId,
  hit,
  view,
  terms,
  onOpen,
}: {
  lang: string;
  kbId: string;
  hit: CitationHitLike;
  view: Extract<SearchView, { kind: "results" }>;
  terms: readonly string[];
  onOpen?: (target: { path: string; rev: string }) => void;
}) {
  const { t, i18n } = useTranslation("kb");
  const target = citationTarget(hit);
  const committedAt =
    hit.commitSha === view.indexedCommitSha && view.indexedCommittedAt
      ? Date.parse(view.indexedCommittedAt)
      : Number.NaN;
  const when = Number.isNaN(committedAt)
    ? null
    : formatRelativeTime(committedAt, i18n.language || lang);
  const latest = hit.commitSha === view.headSha;
  const version = when
    ? t(latest ? "search.relevance.versionLatestAt" : "search.relevance.versionAt", { when })
    : t(latest ? "search.relevance.versionLatest" : "search.relevance.versionEarlier");
  return (
    <li className="px-4 py-3">
      <a
        href={kbDocumentHref(lang, kbId, target)}
        onClick={routerClick(onOpen && (() => onOpen(target)))}
        className="-mx-2 block min-h-[44px] space-y-1.5 rounded-md px-2 py-1 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="block truncate font-mono text-sm font-medium text-primary">
          {hit.path}
        </span>
        <span className="line-clamp-3 block text-sm break-words" data-testid="search-snippet">
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
      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {hit.relevance && (
          <RelevanceMeter relevance={hit.relevance} calibration={view.calibration} />
        )}
        <span>{t("search.chunk", { index: hit.chunkIndex + 1 })}</span>
        <span
          title={t("search.citedAt", { sha: short(hit.commitSha) })}
          data-testid="search-version"
        >
          {version}
        </span>
      </span>
    </li>
  );
}

type Submitted = { query: string } & Filters;

/** Per-KB search: hybrid for a plain query, the structured service when filters are set. */
export function SearchPanel({
  lang,
  kbId,
  onOpen,
}: {
  lang: string;
  kbId: string;
  onOpen?: (target: { path: string; rev: string }) => void;
}) {
  const { t } = useTranslation("kb");
  const queryId = useId();
  const typeId = useId();
  const titleId = useId();
  const tagsId = useId();
  const [draft, setDraft] = useState<Submitted>({ query: "", type: "", title: "", tags: "" });
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [invalid, setInvalid] = useState<ReadonlySet<keyof Submitted>>(new Set());
  const structured = submitted !== null && hasStructuredFilters(submitted);
  const hybridInput =
    submitted && !structured && submitted.query.trim() !== ""
      ? { kbId, query: submitted.query.trim() }
      : skipToken;
  const hybrid = useQuery(orpc.search.hybrid.queryOptions({ input: hybridInput, retry: false }));
  const structuredBase = submitted && structured ? structuredInput(kbId, submitted) : null;
  const paged = useInfiniteQuery(
    orpc.search.structured.infiniteOptions({
      input: structuredBase
        ? (cursor: string | null) => ({ ...structuredBase, limit: 20, cursor })
        : skipToken,
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
      retry: false,
    }),
  );
  const lost = useKbAccessLoss(kbId, [hybrid.error, paged.error]);
  const authSession = useAuthSession();
  const isAdmin =
    authSession.state.status === "authenticated" &&
    isAdminRole(authSession.state.session.user.role);
  const view = structured
    ? searchView({
        enabled: true,
        isPending: paged.isPending,
        isError: paged.isError,
        error: paged.error,
        hits: paged.data?.pages.flatMap((page) => page.items),
        meta: paged.data?.pages.at(-1),
        query: submitted?.query.trim(),
      })
    : searchView({
        enabled: hybridInput !== skipToken,
        isPending: hybrid.isPending,
        isError: hybrid.isError,
        error: hybrid.error,
        hits: hybrid.data?.results,
        meta: hybrid.data,
        query: submitted?.query.trim(),
      });

  if (lost) return null;
  return (
    <section className="min-w-0 space-y-4" aria-labelledby={`${queryId}-title`}>
      <h2 id={`${queryId}-title`} className="text-lg font-semibold">
        {t("search.title")}
      </h2>
      <form
        className="min-w-0 space-y-3"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const validated = searchDraftSchema.safeParse(draft);
          const fields = new Set<keyof Submitted>();
          if (!validated.success) {
            for (const issue of validated.error.issues) {
              const field = issue.path[0];
              if (field === "query" || field === "type" || field === "title" || field === "tags")
                fields.add(field);
            }
          }
          setInvalid(fields);
          if (validated.success) setSubmitted({ ...draft });
        }}
      >
        <div className="min-w-0 space-y-2">
          <Label htmlFor={queryId}>{t("search.queryLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id={queryId}
              type="search"
              value={draft.query}
              // HTML counts UTF-16 units; validation counts Unicode scalars.
              maxLength={2048}
              aria-invalid={invalid.has("query")}
              aria-describedby={invalid.has("query") ? `${queryId}-error` : undefined}
              autoComplete="off"
              onChange={(e) => setDraft({ ...draft, query: e.target.value })}
            />
            <Button type="submit" className="min-h-[44px]">
              {t("search.submit")}
            </Button>
          </div>
          {invalid.has("query") && (
            <p id={`${queryId}-error`} role="alert" className="text-sm text-destructive">
              {t("search.queryInvalid")}
            </p>
          )}
        </div>
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-medium">{t("search.filters")}</legend>
          {(
            [
              [typeId, "type", "search.typeLabel"],
              [titleId, "title", "search.titleLabel"],
              [tagsId, "tags", "search.tagsLabel"],
            ] as const
          ).map(([id, key, label]) => (
            <div key={key} className="min-w-0 space-y-2">
              <Label htmlFor={id}>{t(label)}</Label>
              <Input
                id={id}
                value={draft[key]}
                maxLength={key === "tags" ? 4096 : 512}
                aria-invalid={invalid.has(key)}
                aria-describedby={invalid.has(key) ? `${id}-error` : undefined}
                autoComplete="off"
                inputMode="text"
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
              {invalid.has(key) && (
                <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
                  {t(`search.${key}Invalid`)}
                </p>
              )}
            </div>
          ))}
        </fieldset>
      </form>
      <SearchResultList
        lang={lang}
        kbId={kbId}
        view={view}
        onOpen={onOpen}
        isAdmin={isAdmin}
        onRetry={() => (structured ? paged.refetch() : hybrid.refetch())}
      />
      {structured && view.kind === "results" && (
        <LoadMore
          hasNextPage={paged.hasNextPage}
          isFetchingNextPage={paged.isFetchingNextPage}
          onLoadMore={() => paged.fetchNextPage()}
        />
      )}
    </section>
  );
}

function structuredInput(kbId: string, submitted: Submitted) {
  const tags = parseTags(submitted.tags);
  return {
    kbId,
    ...(submitted.query.trim() ? { query: submitted.query.trim() } : {}),
    ...(submitted.type.trim() ? { type: submitted.type.trim() } : {}),
    ...(submitted.title.trim() ? { title: submitted.title.trim() } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
}
