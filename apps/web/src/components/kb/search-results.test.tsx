import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type CitationHitLike,
  citationTarget,
  hasStructuredFilters,
  parseTags,
  RelevanceDetails,
  SearchResultList,
  searchDraftSchema,
  searchView,
} from "@/components/kb/search-results";
import { renderWithTestRouter as renderToStaticMarkup } from "@/lib/router-test-utils";
import type { HitRelevance } from "@/lib/search-relevance";

const KB = "a".repeat(24);
const CITED = "7".repeat(40);
const HEAD = "8".repeat(40);

const hit: CitationHitLike = {
  knowledgeBaseId: KB,
  knowledgeBaseName: "Team notes",
  path: "guides/setup.md",
  documentId: null,
  commitSha: CITED,
  blobSha: "b".repeat(40),
  contentHash: `sha256:${"c".repeat(64)}`,
  chunkIndex: 2,
  span: { startToken: 0, endToken: 10, startByte: 0, endByte: 40 },
  snippet: "install the thing",
  score: 0.5,
  mode: "hybrid",
  indexGenerationId: "g".repeat(24),
  freshness: "stale",
  documentCitations: [],
  assetRefs: [],
  matchedRow: null,
};
const data = {
  results: [hit],
  generationId: "g".repeat(24),
  freshness: "stale" as const,
  indexedCommitSha: CITED,
  headSha: HEAD,
  indexNotices: [] as Array<
    | {
        kbId: string;
        code: "EMBEDDING_REBUILD_PENDING";
        detail:
          | "EMBEDDING_SETTINGS_CHANGED"
          | "EMBEDDING_MODEL_CHANGED"
          | "EMBEDDING_RUNTIME_RELOADING";
      }
    | {
        kbId: string;
        code: "LEXICAL_ONLY";
        detail:
          | "NO_EMBEDDING_PROFILE"
          | "EMBEDDING_PROFILE_REVOKED"
          | "EMBEDDING_PROFILE_UNAVAILABLE";
      }
  >,
};

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const html = (node: ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("searchView", () => {
  it("idle before a query", () => {
    expect(searchView({ enabled: false, isPending: true, isError: false, error: null })).toEqual({
      kind: "idle",
    });
  });
  it("an error hides previously cached results (no substitute results)", () => {
    const view = searchView({
      enabled: true,
      isPending: false,
      isError: true,
      error: { code: "SERVICE_UNAVAILABLE", data: { code: "INDEX_UNAVAILABLE" } },
      hits: [hit],
      meta: data,
    });
    expect(view).toEqual({ kind: "error", unavailable: true });
  });
  it("results carry freshness and head", () => {
    const view = searchView({
      enabled: true,
      isPending: false,
      isError: false,
      error: null,
      hits: [hit],
      meta: data,
    });
    expect(view).toMatchObject({ kind: "results", freshness: "stale", headSha: HEAD });
  });
});

describe("SearchResultList", () => {
  it("old citation navigation passes the cited commit SHA", () => {
    const out = html(
      <SearchResultList
        lang="en-US"
        kbId={KB}
        view={searchView({
          enabled: true,
          isPending: false,
          isError: false,
          error: null,
          hits: [hit],
          meta: data,
        })}
        onRetry={() => {}}
      />,
    );
    expect(out).toContain(`rev=${CITED}`);
    expect(out).toContain("path=guides%2Fsetup.md");
    expect(out).toContain(enKb.search.freshness.stale);
    expect(out).toContain("install the thing");
  });
  it("renders the transport's plain snippet as it is (converted once, by the server)", () => {
    // `**hello**` is what the server's plain-text reduction leaves of a code span
    // (`` `**hello**` ``); a second conversion here would turn it into `hello`.
    const out = html(
      <SearchResultList
        lang="en-US"
        kbId={KB}
        view={searchView({
          enabled: true,
          isPending: false,
          isError: false,
          error: null,
          hits: [{ ...hit, snippet: "run **hello** now" }],
          meta: data,
        })}
        onRetry={() => {}}
      />,
    );
    expect(out).toContain("run **hello** now");
  });
  it("failed index displays an error and no results", () => {
    const out = html(
      <SearchResultList
        lang="en-US"
        kbId={KB}
        view={{ kind: "error", unavailable: true }}
        onRetry={() => {}}
      />,
    );
    expect(out).toContain(enKb.search.indexUnavailable);
    expect(out).not.toContain("install the thing");
    expect(out).toContain(enCommon.actions.tryAgain);
  });
  it("loading renders a skeleton, not results", () => {
    const out = html(
      <SearchResultList lang="en-US" kbId={KB} view={{ kind: "loading" }} onRetry={() => {}} />,
    );
    expect(out).toContain('data-slot="skeleton"');
  });
  it("empty result says so", () => {
    const out = html(
      <SearchResultList
        lang="en-US"
        kbId={KB}
        view={{
          ...searchView({
            enabled: true,
            isPending: false,
            isError: false,
            error: null,
            hits: [],
            meta: data,
          }),
        }}
        onRetry={() => {}}
      />,
    );
    expect(out).toContain(enKb.search.noResults);
  });
});

describe("relevance meter and floor", () => {
  const GEMMA = "embeddinggemma-2-q8_0";
  const rel = (semantic: number | null, keyword = false) => ({
    semantic,
    semanticRank: semantic === null ? null : 1,
    keyword,
    keywordRank: keyword ? 1 : null,
  });
  const view = (hits: CitationHitLike[], extra: Record<string, unknown> = {}) =>
    searchView({
      enabled: true,
      isPending: false,
      isError: false,
      error: null,
      hits,
      meta: { ...data, calibration: GEMMA, indexedCommittedAt: null, ...extra },
      query: "flour and gluten",
    });
  const render = (v: ReturnType<typeof view>) =>
    html(<SearchResultList lang="en-US" kbId={KB} view={v} onRetry={() => {}} />);
  const sourdough = {
    ...hit,
    path: "sourdough.md",
    snippet: "Strong flour has more gluten.",
    relevance: rel(0.68, true),
  };
  const unrelated = (path: string, semantic: number) => ({
    ...hit,
    path,
    snippet: "Quarterly budget review notes.",
    relevance: rel(semantic),
  });

  it("shows a meter with the band in words, never the fused score as a percentage", () => {
    const out = render(view([sourdough]));
    expect(out).toContain('role="meter"');
    expect(out).toContain('aria-valuenow="3"');
    expect(out).toContain(`aria-valuetext="${i18n.t("search.relevance.band.strong")}"`);
    // The hit's fused score (0.5) appears nowhere as text.
    expect(out).not.toMatch(/>[^<]*(?:50\s?%|0\.5\b)[^<]*</);
  });

  it("keeps uncalibrated results in rank order without labels or folding", () => {
    for (const calibration of ["unknown", "external"]) {
      const out = render(
        view([unrelated("first.md", 0.01), unrelated("second.md", 0.02)], { calibration }),
      );
      expect(out.indexOf("first.md")).toBeGreaterThan(-1);
      expect(out.indexOf("second.md")).toBeGreaterThan(out.indexOf("first.md"));
      expect(out).not.toContain('role="meter"');
      expect(out).not.toContain('data-testid="search-no-close"');
      expect(out).not.toContain(i18n.t("search.relevance.weaker", { count: 2 }));
      for (const label of Object.values(enKb.search.relevance.band))
        expect(out).not.toContain(label);
    }
  });

  it("highlights the query's words in the snippet", () => {
    const out = render(view([sourdough]));
    expect(out).toMatch(/<mark[^>]*>flour<\/mark>/);
    expect(out).toMatch(/<mark[^>]*>gluten<\/mark>/);
    expect(out).not.toMatch(/<mark[^>]*>and<\/mark>/);
  });

  it("collapses hits below the floor under 'Weaker matches'", () => {
    const out = render(view([sourdough, unrelated("budget.md", 0.12), unrelated("q3.md", 0.1)]));
    expect(out).toContain('data-testid="search-hits"');
    expect(out).toContain("sourdough.md");
    // The weaker list stays collapsed until asked for.
    expect(out).not.toContain("budget.md");
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain(i18n.t("search.relevance.weaker", { count: 2 }));
    expect(out).not.toContain('data-testid="search-no-close"');
  });

  it("says 'No close matches' with a hint when nothing passes the floor", () => {
    const out = render(view([unrelated("budget.md", 0.12), unrelated("q3.md", 0.1)]));
    expect(out).toContain('data-testid="search-no-close"');
    expect(out).toContain(i18n.t("search.relevance.noClose"));
    expect(out).toContain(i18n.t("search.relevance.noCloseHint"));
    expect(out).not.toContain('data-testid="search-hits"');
    expect(out).toContain(i18n.t("search.relevance.weaker", { count: 2 }));
  });

  it("says which version a hit is from in plain words, with the commit in the tooltip", () => {
    const savedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const out = render(view([sourdough], { indexedCommittedAt: savedAt }));
    expect(out).toContain(i18n.t("search.relevance.versionAt", { when: "5 minutes ago" }));
    expect(out).toContain(`title="${i18n.t("search.citedAt", { sha: CITED.slice(0, 12) })}"`);
    const latest = render(view([{ ...sourdough, commitSha: HEAD }], { indexedCommitSha: HEAD }));
    expect(latest).toContain(i18n.t("search.relevance.versionLatest"));
  });

  it("shows no meter for hits without relevance (structured search) and hides none", () => {
    const out = render(
      searchView({
        enabled: true,
        isPending: false,
        isError: false,
        error: null,
        hits: [hit],
        meta: data,
      }),
    );
    expect(out).not.toContain('role="meter"');
    expect(out).toContain("guides/setup.md");
  });
});

describe("structured filters", () => {
  it("citationTarget pins rev to the cited commit", () => {
    expect(citationTarget(hit)).toEqual({ path: "guides/setup.md", rev: CITED });
  });
  it("tags are exact and deduplicated; invalid filters are rejected rather than discarded", () => {
    expect(parseTags(" a, b ,a,,")).toEqual(["a", "b"]);
    const draft = { query: "", type: "", title: "", tags: "" };
    expect(searchDraftSchema.safeParse({ ...draft, tags: "a,b,a" }).success).toBe(true);
    expect(
      searchDraftSchema.safeParse({
        ...draft,
        tags: Array.from({ length: 16 }, (_, i) => `t${i}`).join(","),
      }).success,
    ).toBe(true);
    expect(
      searchDraftSchema.safeParse({
        ...draft,
        tags: Array.from({ length: 17 }, (_, i) => `t${i}`).join(","),
      }).success,
    ).toBe(false);
    expect(parseTags("x".repeat(65))).toEqual(["x".repeat(65)]);
    expect(searchDraftSchema.safeParse({ ...draft, tags: "x".repeat(65) }).success).toBe(false);
  });
  it.each(["query", "type", "title", "tags"] as const)(
    "%s uses scalar bounds and rejects unpaired surrogates",
    (field) => {
      const max = field === "query" ? 1024 : field === "tags" ? 64 : 256;
      const draft = { query: "", type: "", title: "", tags: "" };
      expect(searchDraftSchema.safeParse({ ...draft, [field]: "🧭".repeat(max) }).success).toBe(
        true,
      );
      expect(searchDraftSchema.safeParse({ ...draft, [field]: "🧭".repeat(max + 1) }).success).toBe(
        false,
      );
      expect(searchDraftSchema.safeParse({ ...draft, [field]: "\ud800" }).success).toBe(false);
    },
  );
  it("any filter switches to the structured service", () => {
    expect(hasStructuredFilters({ type: "", title: "", tags: "" })).toBe(false);
    expect(hasStructuredFilters({ type: "note", title: "", tags: "" })).toBe(true);
  });
});

describe("EMBEDDING_REBUILD_PENDING notice", () => {
  const render = (indexNotices: typeof data.indexNotices) =>
    html(
      <SearchResultList
        lang="en-US"
        kbId={KB}
        view={searchView({
          enabled: true,
          isPending: false,
          isError: false,
          error: null,
          hits: [hit],
          meta: { ...data, indexNotices },
        })}
        onRetry={() => {}}
      />,
    );
  it("shows the previous-settings warning next to the results", () => {
    const out = render([
      { kbId: KB, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_SETTINGS_CHANGED" },
    ]);
    expect(out).toContain('data-testid="search-index-notice"');
    expect(out).toContain(enKb.search.indexNotice.EMBEDDING_SETTINGS_CHANGED);
    expect(out).toContain("install the thing");
  });
  it("queryless structured and empty pages warn without claiming semantic or keyword ranking was used", () => {
    const indexNotices = (
      [
        "EMBEDDING_SETTINGS_CHANGED",
        "EMBEDDING_MODEL_CHANGED",
        "EMBEDDING_RUNTIME_RELOADING",
      ] as const
    ).map((detail) => ({ kbId: KB, code: "EMBEDDING_REBUILD_PENDING" as const, detail }));
    for (const hits of [[], [{ ...hit, mode: "structured" as const }]]) {
      const out = html(
        <SearchResultList
          lang="en-US"
          kbId={KB}
          view={searchView({
            enabled: true,
            isPending: false,
            isError: false,
            error: null,
            hits,
            meta: { ...data, indexNotices },
          })}
          onRetry={() => {}}
        />,
      );
      for (const notice of indexNotices)
        expect(out).toContain(enKb.search.indexNotice[notice.detail]);
      expect(out).not.toMatch(/semantic ranking used|lexical-only|keyword-only/i);
    }
  });
  it("shows unavailable semantic ranking after a model change and nothing without notices", () => {
    expect(
      render([{ kbId: KB, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_MODEL_CHANGED" }]),
    ).toContain(enKb.search.indexNotice.EMBEDDING_MODEL_CHANGED);
    // Stop-then-probe gap.
    expect(
      render([
        { kbId: KB, code: "EMBEDDING_REBUILD_PENDING", detail: "EMBEDDING_RUNTIME_RELOADING" },
      ]),
    ).toContain(enKb.search.indexNotice.EMBEDDING_RUNTIME_RELOADING);
    expect(render([])).not.toContain('data-testid="search-index-notice"');
  });
});

describe("LEXICAL_ONLY notice", () => {
  const render = (
    detail: "NO_EMBEDDING_PROFILE" | "EMBEDDING_PROFILE_REVOKED" | "SEMANTIC_INDEX_BUILDING",
    isAdmin: boolean,
  ) =>
    html(
      <SearchResultList
        lang="en-US"
        kbId={KB}
        isAdmin={isAdmin}
        view={searchView({
          enabled: true,
          isPending: false,
          isError: false,
          error: null,
          hits: [{ ...hit, mode: "lexical" as const }],
          meta: { ...data, indexNotices: [{ kbId: KB, code: "LEXICAL_ONLY" as const, detail }] },
        })}
        onRetry={() => {}}
      />,
    );
  it("says why search is keyword-only and links to KB settings", () => {
    const out = render("NO_EMBEDDING_PROFILE", false);
    expect(out).toContain(enKb.search.indexNotice.NO_EMBEDDING_PROFILE);
    expect(out).toContain(`href="/en-US/kbs/${KB}/settings"`);
    expect(out).not.toContain("/admin/settings");
  });
  it("names a failing model and links admins to the built-in model too", () => {
    const out = render("EMBEDDING_PROFILE_REVOKED", true);
    expect(out).toContain(enKb.search.indexNotice.EMBEDDING_PROFILE_REVOKED);
    expect(out).toContain('href="/en-US/admin/settings"');
  });
  it("a building semantic index is not a failure and needs no settings link", () => {
    const out = render("SEMANTIC_INDEX_BUILDING", true);
    expect(out).toContain(enKb.search.indexNotice.SEMANTIC_INDEX_BUILDING);
    expect(out).not.toContain(enKb.search.indexNotice.EMBEDDING_PROFILE_UNAVAILABLE);
    expect(out).not.toContain("/settings");
  });
});

describe("relevance details (the meter's popover)", () => {
  const renderDetails = (relevance: HitRelevance, calibration: string) =>
    html(<RelevanceDetails relevance={relevance} calibration={calibration} />);
  const relevance = (over: Partial<HitRelevance>): HitRelevance => ({
    semantic: null,
    semanticRank: null,
    keyword: false,
    keywordRank: null,
    ...over,
  });
  it("says what a keyword match means for the kind of search that found it", () => {
    const hybridHtml = renderDetails(relevance({ semantic: 0.71, keyword: true }), "external");
    expect(hybridHtml).toContain(enKb.search.relevance.keywordYes);
    expect(hybridHtml).toContain("0.71");
    expect(hybridHtml).toContain(enKb.search.relevance.explain);
    const lexicalHtml = renderDetails(relevance({ keyword: true }), "lexical");
    expect(lexicalHtml).toContain(enKb.search.relevance.keywordYesLexical);
    expect(lexicalHtml).not.toContain(enKb.search.relevance.keywordYes);
    expect(lexicalHtml).toContain(enKb.search.relevance.semanticUnavailable);
    expect(lexicalHtml).toContain(enKb.search.relevance.explainLexical);
  });
  it("shows a negative similarity with an explanation that allows it", () => {
    const html = renderDetails(relevance({ semantic: -0.12 }), "external");
    expect(html).toContain("-0.12");
    expect(enKb.search.relevance.explain).toMatch(/0 or less/);
  });
});
