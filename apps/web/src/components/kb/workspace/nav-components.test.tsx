import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import type { CitationHitLike } from "@/components/kb/search-results";
import { documentOutline } from "@/lib/kb-workspace/outline";
import { renderWithTestRouter } from "@/lib/router-test-utils";

import { OutlineList, OutlinePanel } from "./outline-panel";
import { SidebarHits, SidebarSearch } from "./sidebar-search";
import { WorkspaceSidebar } from "./workspace-sidebar";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
const render = (node: ReactNode) =>
  renderWithTestRouter(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
const noop = () => {};

describe("navigation locale keys", () => {
  it("exist in every shipped locale", () => {
    for (const block of ["sidebar", "outline", "search"] as const) {
      expect(Object.keys(esKb.workspace[block]).sort()).toEqual(
        Object.keys(enKb.workspace[block]).sort(),
      );
    }
  });
});

describe("outline", () => {
  it("links each heading to its id on the same document, indented by level", () => {
    const headings = documentOutline("# Guide\n\n## Install\n\n### On *Linux*\n\n## Install");
    const html = render(<OutlineList lang="en-US" kbId="kb1" headings={headings} />);
    expect(html).toContain('href="/en-US/kbs/kb1/documents#guide"');
    expect(html).toContain('href="/en-US/kbs/kb1/documents#install"');
    expect(html).toContain('href="/en-US/kbs/kb1/documents#install-1"');
    expect(html).toContain('href="/en-US/kbs/kb1/documents#on-linux"');
    expect(html).toMatch(/class="[^"]*pl-8[^"]*"[^>]*>|pl-8/);
    expect(html).toContain('title="On Linux"');
  });

  it("is a labelled navigation landmark with empty states", () => {
    const none = render(<OutlinePanel lang="en-US" kbId="kb1" path="a.md" markdown={null} />);
    expect(none).toContain("<nav");
    expect(none).toContain(`aria-label="${enKb.workspace.outline.label}"`);
    expect(none).toContain(enKb.workspace.outline.noDocument);
    const empty = render(
      <OutlinePanel lang="en-US" kbId="kb1" path="a.md" markdown="Just text, no heading." />,
    );
    expect(empty).toContain(enKb.workspace.outline.empty);
  });
});

const hit = (path: string, semantic: number | null, keyword = false): CitationHitLike =>
  ({
    path,
    commitSha: "a".repeat(40),
    chunkIndex: 0,
    snippet: "Flour and water make a gluten network.",
    span: { startByte: 0, endByte: 10, startToken: 0, endToken: 5 },
    score: 0.5,
    relevance: { semantic, semanticRank: 1, keyword, keywordRank: keyword ? 1 : null },
  }) as unknown as CitationHitLike;

describe("sidebar search hits", () => {
  it("shows close hits with highlighted terms and their band, weaker ones collapsed", () => {
    const html = render(
      <SidebarHits
        lang="en-US"
        kbId="kb1"
        hits={[hit("bread/sourdough.md", 0.7, true), hit("cars.md", 0.1)]}
        calibration="external"
        query="flour gluten"
        onOpen={noop}
      />,
    );
    expect(html).toContain("sourdough.md");
    expect(html).toContain("bread/");
    // A new tab opens the cited version (its heading and passage are there).
    expect(html).toContain(
      `href="/en-US/kbs/kb1/documents?path=bread%2Fsourdough.md&amp;rev=${"a".repeat(40)}"`,
    );
    expect(html).toMatch(/<mark[^>]*>Flour<\/mark>/);
    expect(html).toMatch(/<mark[^>]*>gluten<\/mark>/);
    expect(html).toContain('data-band="strong"');
    expect(html).toContain(enKb.search.relevance.band.strong);
    // The weaker hit is behind a collapsed disclosure, not rendered.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("cars.md");
  });

  it('says "No close matches" when nothing passes the floor', () => {
    const html = render(
      <SidebarHits
        lang="en-US"
        kbId="kb1"
        hits={[hit("cars.md", 0.05)]}
        calibration="external"
        query="flour"
        onOpen={noop}
      />,
    );
    expect(html).toContain('data-testid="workspace-search-no-close"');
    expect(html).toContain(enKb.search.relevance.noClose);
  });

  it("explains an empty reply", () => {
    const html = render(
      <SidebarHits
        lang="en-US"
        kbId="kb1"
        hits={[]}
        calibration="external"
        query="x"
        onOpen={noop}
      />,
    );
    expect(html).toContain(enKb.search.noResults);
  });

  it("starts idle with a labelled search box", () => {
    const html = render(<SidebarSearch lang="en-US" kbId="kb1" onOpen={noop} />);
    expect(html).toContain('role="search"');
    expect(html).toContain('type="search"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain(enKb.workspace.search.idle);
  });
});

describe("workspace sidebar", () => {
  it("shows the selected view and hides the others; no Outline without a document", () => {
    const html = render(
      <WorkspaceSidebar
        files={<p>FILES</p>}
        search={<p>SEARCH</p>}
        outline={null}
        activity={<p>ACTIVITY</p>}
        view="outline"
        onViewChange={noop}
      />,
    );
    expect(html).toContain('data-view="files"');
    expect(html).not.toContain(enKb.workspace.sidebar.outline);
    expect(html).toMatch(/<div class="[^"]*"><p>FILES<\/p>/);
    expect(html).toMatch(/hidden=""><p>SEARCH<\/p>/);
  });

  it("offers Outline with a document open", () => {
    const html = render(
      <WorkspaceSidebar
        files={<p>FILES</p>}
        search={<p>SEARCH</p>}
        outline={<p>OUTLINE</p>}
        activity={<p>ACTIVITY</p>}
        view="outline"
        onViewChange={noop}
      />,
    );
    expect(html).toContain('data-view="outline"');
    expect(html).toContain(enKb.workspace.sidebar.outline);
    expect(html).toMatch(/hidden=""><p>FILES<\/p>/);
    expect(html).not.toMatch(/hidden=""><p>OUTLINE<\/p>/);
    expect(html).toMatch(/hidden=""><p>ACTIVITY<\/p>/);
  });

  it("shows recent activity when chosen", () => {
    const html = render(
      <WorkspaceSidebar
        files={<p>FILES</p>}
        search={<p>SEARCH</p>}
        outline={null}
        activity={<p>ACTIVITY</p>}
        view="activity"
        onViewChange={noop}
      />,
    );
    expect(html).toContain('data-view="activity"');
    expect(html).toContain(enKb.workspace.sidebar.activity);
    expect(html).not.toMatch(/hidden=""><p>ACTIVITY<\/p>/);
  });
});
