import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import type { RecentChange } from "@/lib/kb-workspace/agent-activity";
import { agentReference, DocumentReferenceBody, documentLink } from "./document-reference";
import { RecentChangesList } from "./recent-changes-panel";

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
const escapeHtml = (text: string) => renderToStaticMarkup(<span>{text}</span>).slice(6, -7);

const NOW = Date.parse("2026-11-26T12:00:00Z");
const KB = "k".repeat(24);
const item = (over: Partial<RecentChange>): RecentChange => ({
  sha: "a".repeat(40),
  at: new Date(NOW - 5 * 60_000).toISOString(),
  subject: "Update notes",
  actor: { kind: "agent", label: "Ana", via: "Claude Code" },
  paths: [{ path: "notes/a.md", change: "modified" }],
  morePaths: 0,
  pathsUnknown: false,
  ...over,
});

describe("recent changes rows", () => {
  it("has its strings in the kb namespace", () => {
    for (const key of [
      "workspace.activity.agentNamed",
      "workspace.activity.person",
      "workspace.activity.unknown",
      "workspace.activity.change.renamed",
      "workspace.reference.agentTitle",
    ])
      expect(i18n.exists(key), key).toBe(true);
  });

  it("tells an agent, a person and an unknown pusher apart", () => {
    const html = render(
      <RecentChangesList
        lang="en-US"
        now={NOW}
        onOpen={() => {}}
        items={[
          item({ sha: "1".repeat(40) }),
          item({ sha: "2".repeat(40), actor: { kind: "human", label: null, via: null } }),
          item({ sha: "3".repeat(40), actor: { kind: "unknown", label: null, via: null } }),
        ]}
      />,
    );
    expect(html).toContain('data-actor="agent"');
    expect(html).toContain(
      escapeHtml(i18n.t("workspace.activity.agentNamed", { name: "Claude Code" })),
    );
    expect(html).toContain(escapeHtml(i18n.t("workspace.activity.person")));
    expect(html).toContain(escapeHtml(i18n.t("workspace.activity.unknown")));
    expect(html).toContain("5 minutes ago");
  });

  it("opens added, edited and renamed files; a deleted one is not a button", () => {
    const html = render(
      <RecentChangesList
        lang="en-US"
        now={NOW}
        onOpen={() => {}}
        items={[
          item({
            paths: [
              { path: "b.md", change: "renamed", from: "a.md" },
              { path: "gone.md", change: "deleted" },
            ],
            morePaths: 3,
          }),
        ]}
      />,
    );
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain("a.md");
    expect(buttons[0]).toContain("b.md");
    expect(html).toContain("line-through");
    expect(html).toContain(escapeHtml(i18n.t("workspace.activity.morePaths", { count: 3 })));
  });
});

describe("document reference", () => {
  it("links the document and gives agents the exact MCP read", () => {
    expect(documentLink("https://kb.example/", "en-US", KB, "notes/a b.md")).toBe(
      `https://kb.example/en-US/kbs/${KB}/documents?path=notes%2Fa+b.md`,
    );
    expect(agentReference(KB, "notes/a.md")).toBe(
      `knowledge_documents_get {\n  "kbId": "${KB}",\n  "path": "notes/a.md"\n}`,
    );
    const html = render(
      <DocumentReferenceBody
        origin="https://kb.example"
        lang="en-US"
        kbId={KB}
        kbName="Team notes"
        path="notes/a.md"
      />,
    );
    expect(html).toContain(`https://kb.example/en-US/kbs/${KB}/documents?path=notes%2Fa.md`);
    expect(html).toContain("knowledge_documents_get");
    expect(html).toContain(escapeHtml(i18n.t("workspace.reference.agentTitle")));
  });
});
