import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ComponentProps } from "react";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { kbDocumentHref } from "@/components/kb/kb-links";
import { PrActionsView, type PrConflictPath, PrConflictsView } from "@/components/kb/pr-actions";
import type { PrSummary } from "@/hooks/use-pr-review";
import { renderWithTestRouter as renderToStaticMarkup } from "@/lib/router-test-utils";

const HEAD = "2".repeat(40);
const TARGET = "3".repeat(40);
const MERGE = "6".repeat(40);

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

const pr = (overrides: Partial<PrSummary> = {}): PrSummary => ({
  number: 3,
  title: "Proposal",
  sourceBranch: "refs/heads/pr/3",
  targetBranch: "main",
  baseSha: "1".repeat(40),
  headSha: HEAD,
  targetSha: TARGET,
  status: "OPEN",
  authorActorKey: "user:a",
  version: 1,
  mergeCommitSha: null,
  ...overrides,
});

/** The opening tag of the element carrying `data-testid`, whatever the attribute order. */
const tag = (html: string, id: string) =>
  html.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";

function render(overrides: Partial<ComponentProps<typeof PrActionsView>> = {}) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PrActionsView
        pr={pr()}
        controls={{ showMerge: true, canMerge: true, canClose: true, mergeBlocked: false }}
        mergeReady
        closeReady
        outcome={null}
        pending={false}
        onMerge={() => {}}
        onClose={() => {}}
        onRefresh={() => {}}
        {...overrides}
      />
    </I18nextProvider>,
  );
}

describe("PrActionsView", () => {
  it("names the exact displayed revisions the action will submit", () => {
    const html = render();
    expect(tag(html, "pr-merge")).not.toContain(' disabled=""');
    expect(html).toContain(HEAD.slice(0, 12));
    expect(html).toContain(TARGET.slice(0, 12));
  });

  it("propose-only author: Close shown, Merge absent", () => {
    const html = render({
      controls: { showMerge: false, canMerge: false, canClose: true, mergeBlocked: false },
    });
    expect(html).not.toContain('data-testid="pr-merge"');
    expect(html).toContain('data-testid="pr-close"');
  });

  it("merge is disabled until the full diff is displayed", () => {
    const html = render({ mergeReady: false });
    expect(tag(html, "pr-merge")).toContain(' disabled=""');
    expect(html).toContain("Load every change before merging");
  });

  it("changed revisions require viewing the new diff", () => {
    const html = render({ outcome: { kind: "changed", targetMoved: true, headMoved: false } });
    expect(html).toContain('data-testid="pr-refresh"');
    expect(tag(html, "pr-merge")).toContain(' disabled=""');
  });

  it("base moved, head moved and content conflict render distinct messages from server details", () => {
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const base = render({ outcome: { kind: "changed", targetMoved: true, headMoved: false } });
    const head = render({ outcome: { kind: "changed", targetMoved: false, headMoved: true } });
    const both = render({ outcome: { kind: "changed", targetMoved: true, headMoved: true } });
    const content = render({ outcome: { kind: "conflict" } });
    const closed = render({ outcome: { kind: "stateChanged" } });
    expect(base).toContain('data-reason="target"');
    expect(text(base)).toContain("Main changed after this diff was shown");
    expect(head).toContain('data-reason="head"');
    expect(text(head)).toContain("The proposal was updated after this diff was shown");
    expect(both).toContain('data-reason="both"');
    expect(text(content)).toContain("conflicts with main");
    expect(content).not.toContain('data-testid="pr-refresh"');
    expect(text(closed)).toContain("closed or merged");
    expect(closed).toContain('data-testid="pr-refresh"');
    const messages = [base, head, both, content, closed].map((html) => {
      const alert = /<(?:p|div)[^>]*role="alert"[^>]*>([\s\S]*?)<\/(?:p|div)>/.exec(html);
      return alert ? text(alert[1]!) : "";
    });
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("real conflicts explain themselves, and a reviewer sees Merge disabled", () => {
    const why = "This pull request conflicts with main, so it can";
    expect(render({ outcome: { kind: "conflict" } })).toContain(why);
    const html = render({
      pr: pr({ status: "CONFLICT" }),
      controls: { showMerge: true, canMerge: false, canClose: true, mergeBlocked: true },
    });
    expect(html).toContain(why);
    expect(tag(html, "pr-merge")).toContain(' disabled=""');
    expect(tag(html, "pr-merge")).toContain('aria-describedby="pr-conflict"');
  });

  it("a merged PR shows its durable recorded merge commit and no actions", () => {
    const html = render({
      pr: pr({ status: "MERGED", mergeCommitSha: MERGE }),
      controls: { showMerge: true, canMerge: false, canClose: false, mergeBlocked: false },
    });
    expect(html).toContain(MERGE);
    expect(html).not.toContain('data-testid="pr-merge"');
    expect(html).not.toContain('data-testid="pr-close"');
  });
});

describe("PrConflictsView (R3-W6)", () => {
  const KB = "a".repeat(24);
  const paths: PrConflictPath[] = [
    { path: "notes/a.md", kind: "document", recorded: true, standing: false },
    { path: "notes/b.md", kind: "document", recorded: true, standing: true },
    { path: "assets/x.png", kind: "asset", recorded: false, standing: false },
  ];
  const view = (overrides: Partial<ComponentProps<typeof PrConflictsView>> = {}) =>
    renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <PrConflictsView
          lang="en-US"
          kbId={KB}
          number={3}
          paths={paths}
          truncated={false}
          canResolve
          isDream={false}
          {...overrides}
        />
      </I18nextProvider>,
    );

  it("lists every path still to resolve with its kind", () => {
    const html = view();
    expect(html.match(/data-testid="pr-conflict-path"/g)).toHaveLength(3);
    expect(html).toContain("Conflicts (3)");
    expect(html).toContain('data-kind="asset"');
    expect(html).toContain("it resolves together with the other conflicts");
    expect(html).toContain("assetPut or assetRemove over MCP");
    expect(html).not.toContain('data-testid="pr-conflicts-truncated"');
  });

  it("the author gets a Resolve link per document into PR mode; never for assets", () => {
    const html = view();
    const links = html.match(/data-testid="pr-conflict-resolve"[^>]*href="([^"]+)"/g) ?? [];
    expect(links).toHaveLength(2);
    expect(html).toContain(
      kbDocumentHref("en-US", KB, { path: "notes/a.md", mode: "edit", pr: 3 }).replace(
        /&/g,
        "&amp;",
      ),
    );
    expect(html).toContain("Resolve notes/a.md");
    expect(kbDocumentHref("en-US", KB, { path: "notes/a.md", mode: "edit", pr: 3 })).toContain(
      "mode=edit&pr=3",
    );
  });

  it("a reviewer or other reader sees the list without Resolve links", () => {
    const html = view({ canResolve: false });
    expect(html).not.toContain('data-testid="pr-conflict-resolve"');
    expect(html).toContain(enKb.pr.conflicts.bodyReviewer);
  });

  it("a dream's PR offers no Resolve links, and says why", () => {
    const html = view({ isDream: true });
    expect(html).not.toContain('data-testid="pr-conflict-resolve"');
    expect(html).toContain('data-testid="pr-conflicts-dream"');
    expect(view()).not.toContain('data-testid="pr-conflicts-dream"');
  });

  it("notes a truncated list, and renders nothing for a PR that merges", () => {
    expect(view({ truncated: true })).toContain('data-testid="pr-conflicts-truncated"');
    expect(view({ paths: [] })).toBe("");
  });
});
