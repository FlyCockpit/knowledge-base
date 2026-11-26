import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import {
  actorLine,
  DocumentHistory,
  ProvenanceBadge,
  visibleHistoryRows,
} from "@/components/kb/document-history";
import { renderWithTestRouter } from "@/lib/router-test-utils";
import { orpc } from "@/utils/orpc";

describe("provenance badge and history actors", () => {
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
  const render = (node: React.ReactNode) =>
    renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

  it("says who wrote it: a person, an agent, a dream or unspecified", () => {
    for (const [value, label] of [
      ["human", "By a person"],
      ["agent", "By an agent"],
      ["dream", "By a dream"],
      ["absent", "Unspecified"],
    ] as const) {
      const markup = render(<ProvenanceBadge provenance={value} />);
      expect(markup).toContain(`>${label}<`);
      expect(markup).toContain(`data-provenance="${value}"`);
    }
    expect(render(<ProvenanceBadge provenance="agent" prefix="Before" />)).toContain(
      "Before: By an agent",
    );
  });

  it("says who acted: a person via web, via a credential, or unattributed", () => {
    const t = i18n.getFixedT("en-US", "kb");
    expect(actorLine(t, { kind: "web", name: "Ana", via: null })).toBe("Ana in the web app");
    expect(actorLine(t, { kind: "credential", name: "Ana", via: "laptop" })).toBe(
      "Ana via credential “laptop”",
    );
    // A credential named "web" never reads like the browser.
    expect(actorLine(t, { kind: "credential", name: "Ana", via: "web" })).toBe(
      "Ana via credential “web”",
    );
    expect(actorLine(t, { kind: "credential", name: null, via: null })).toBe(
      "Unknown person via a credential",
    );
    expect(actorLine(t, { kind: "unattributed", name: "x", via: "y" })).toBe(
      enKb.history.unattributed,
    );
  });

  it("has Spanish text for every new key", () => {
    expect(Object.keys(esKb.provenance).sort()).toEqual(Object.keys(enKb.provenance).sort());
    expect(esKb.provenance.human.label).toBe("Por una persona");
    expect(Object.keys(esKb.history).sort()).toEqual(Object.keys(enKb.history).sort());
    expect(esKb.pr.files.writtenBy).toBeTruthy();
    const es = i18n.cloneInstance({ lng: "es-MX" });
    es.addResourceBundle("es-MX", "kb", esKb);
    const tEs = es.getFixedT("es-MX", "kb");
    expect(actorLine(tEs, { kind: "web", name: "Ana", via: null })).toBe(
      "Ana en la aplicación web",
    );
    expect(actorLine(tEs, { kind: "credential", name: "Ana", via: "web" })).toBe(
      "Ana mediante la credencial “web”",
    );
  });
});

describe("history rows after a denial", () => {
  it("hides every loaded row once access is denied, and keeps them on other errors", () => {
    const pages = [{ items: [1, 2] }, { items: [3] }];
    expect(visibleHistoryRows(pages, false)).toEqual([1, 2, 3]);
    expect(visibleHistoryRows(pages, true)).toEqual([]);
    expect(visibleHistoryRows(undefined, false)).toEqual([]);
  });
});

describe("history across a rename", () => {
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

  it("opens each revision at the path the document had then, and says so", () => {
    const kbId = "k".repeat(24);
    const row = (sha: string, path: string) => ({
      sha: sha.repeat(40),
      path,
      committedAt: "2026-11-20T10:00:00.000Z",
      subject: `Commit ${sha}`,
      provenance: "human" as const,
      deleted: false,
      actor: { kind: "unattributed" as const, name: null, via: null },
    });
    const client = new QueryClient();
    client.setQueryData(
      orpc.documents.history.infiniteKey({
        input: (cursor: string | undefined) => ({ kbId, path: "archive/b.md", limit: 20, cursor }),
        initialPageParam: undefined,
      }),
      {
        pages: [{ items: [row("1", "archive/b.md"), row("2", "notes/a.md")], nextCursor: null }],
        pageParams: [undefined],
      },
    );
    const html = renderWithTestRouter(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <DocumentHistory lang="en-US" kbId={kbId} path="archive/b.md" />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    // The test router JSON-encodes search values (`%22…%22`).
    expect(html).toContain(`path=archive%2Fb.md&amp;rev=%22${"1".repeat(40)}%22`);
    expect(html).toContain(`path=notes%2Fa.md&amp;rev=%22${"2".repeat(40)}%22`);
    // A row from before the rename restores to the document's name now.
    expect(html).toMatch(/path=notes%2Fa\.md&amp;rev=%222{40}%22&amp;restoreTo=archive%2Fb\.md"/);
    expect(html.match(/restoreTo=/g)).toHaveLength(1);
    expect(html.match(/data-testid="history-former-path"/g)).toHaveLength(1);
    expect(html).toContain("Then at notes/a.md");
  });
});
