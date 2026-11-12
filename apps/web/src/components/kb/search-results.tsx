import { refineUnicodeScalarBounds } from "@knowledge-base/api/lib/schemas";
import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { isAdminRole } from "@knowledge-base/auth/roles";
import { Button } from "@knowledge-base/ui/components/button";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { orpc } from "@/utils/orpc";

type HybridOutput = Awaited<ReturnType<AppRouterClient["search"]["hybrid"]>>;
export type CitationHitLike = HybridOutput["results"][number];
type Freshness = HybridOutput["freshness"];
type SearchMeta = {
  freshness: Freshness;
  indexedCommitSha: string | null;
  headSha: string;
  /** This KB was searched using an index awaiting re-embedding. */
  indexNotices: HybridOutput["indexNotices"];
};

export type SearchView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; unavailable: boolean }
  | ({ kind: "results"; hits: readonly CitationHitLike[] } & SearchMeta);

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
      {view.hits.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("search.noResults")}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {view.hits.map((hit) => {
            const target = citationTarget(hit);
            return (
              <li key={`${hit.commitSha}:${hit.path}:${hit.chunkIndex}:${hit.span.startByte}`}>
                <a
                  href={kbDocumentHref(lang, kbId, target)}
                  onClick={routerClick(onOpen && (() => onOpen(target)))}
                  className="block min-h-[44px] space-y-1.5 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <span className="block truncate font-mono text-sm font-medium text-primary">
                    {hit.path}
                  </span>
                  <span className="line-clamp-3 block text-sm break-words">{hit.snippet}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("search.chunk", { index: hit.chunkIndex + 1 })}</span>
                    <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">
                      {t("search.citedAt", { sha: short(hit.commitSha) })}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
      })
    : searchView({
        enabled: hybridInput !== skipToken,
        isPending: hybrid.isPending,
        isError: hybrid.isError,
        error: hybrid.error,
        hits: hybrid.data?.results,
        meta: hybrid.data,
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
