import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  documentDisplayTitle,
  groupDocumentsByFolder,
  KbDocumentFolder,
  KbDocumentList,
  toggleFolder,
} from "@/components/kb/document-list";

const KB = "a".repeat(24);
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
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

const doc = (path: string, title: string | null = null) => ({ path, title });

describe("documents grouped by folder", () => {
  it("puts root documents first, then folders by path, each in path order", () => {
    const groups = groupDocumentsByFolder([
      doc("runbooks/b.md"),
      doc("z.md"),
      doc("adr/2026/one.md"),
      doc("runbooks/a.md"),
      doc("a.md"),
      doc("adr/zero.md"),
    ]);
    expect(groups.map((group) => [group.folder, group.items.map((item) => item.path)])).toEqual([
      ["", ["a.md", "z.md"]],
      ["adr/", ["adr/zero.md"]],
      ["adr/2026/", ["adr/2026/one.md"]],
      ["runbooks/", ["runbooks/a.md", "runbooks/b.md"]],
    ]);
    expect(groupDocumentsByFolder([])).toEqual([]);
  });

  it("shows the document's title, else its file name without .md", () => {
    expect(documentDisplayTitle(doc("notes/pg.md", "Postgres failover"))).toBe("Postgres failover");
    expect(documentDisplayTitle(doc("notes/meeting-notes.md"))).toBe("meeting-notes");
    expect(documentDisplayTitle(doc("index.md", ""))).toBe("index");
  });

  it("renders the title first and the path second, folders as disclosure buttons", () => {
    const html = render(
      <KbDocumentList
        lang="en-US"
        kbId={KB}
        items={[doc("readme.md", "Read me"), doc("runbooks/pg.md", "Postgres failover")]}
        onOpen={() => {}}
      />,
    );
    // Root documents come before any folder.
    expect(html.indexOf("Read me")).toBeLessThan(html.indexOf("runbooks"));
    // Within a row the title precedes the path, which is in small muted text.
    const row = html.slice(html.indexOf("Postgres failover"));
    expect(row.indexOf("Postgres failover")).toBeLessThan(row.indexOf("runbooks/pg.md"));
    expect(html).toMatch(/text-xs text-muted-foreground">runbooks\/pg\.md</);
    expect(html).toContain(`href="/en-US/kbs/${KB}/documents?path=runbooks%2Fpg.md"`);
    // The folder toggle: an expanded disclosure button naming its list, 44px tall.
    expect(html).toMatch(/<button type="button" aria-expanded="true" aria-controls="[^"]+"/);
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain("1 document");
    // Long names truncate instead of widening the page.
    expect(html).toContain("truncate");
  });

  it("collapses a folder: its toggle says so and its documents are not rendered", () => {
    const html = render(
      <KbDocumentFolder
        folder="runbooks/"
        open={false}
        onToggle={() => {}}
        countLabel="2 documents"
      >
        <li>hidden row</li>
      </KbDocumentFolder>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("runbooks");
    expect(html).not.toContain("hidden row");
    const once = toggleFolder(new Set(), "runbooks/");
    expect([...once]).toEqual(["runbooks/"]);
    expect([...toggleFolder(once, "runbooks/")]).toEqual([]);
  });
});
