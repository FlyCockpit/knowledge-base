import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { lineDiff, PrAssetDeltaRow, PrDiffProgress, PrRenderedPair } from "@/components/kb/pr-diff";

const KB = "e".repeat(24);
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const H1 = `sha256:${"a".repeat(64)}`;
const H2 = `sha256:${"b".repeat(64)}`;

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
const render = (node: ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("lineDiff", () => {
  it("empty/default: identical text has no changed lines", () => {
    expect(lineDiff("a\nb", "a\nb").every((l) => l.kind === "same")).toBe(true);
  });
  it("marks removed and added lines around a common prefix/suffix", () => {
    expect(lineDiff("# T\nold\nend", "# T\nnew\nmore\nend")).toEqual([
      { kind: "same", text: "# T" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "added", text: "more" },
      { kind: "same", text: "end" },
    ]);
  });
  it("added and deleted files are all-added / all-removed", () => {
    expect(lineDiff(null, "x\ny").map((l) => l.kind)).toEqual(["added", "added"]);
    expect(lineDiff("x", null).map((l) => l.kind)).toEqual(["removed"]);
  });
});

describe("PrAssetDeltaRow", () => {
  const png = (hash: string) => ({ path: "media/pic.png", hash, size: 10, mime: "image/png" });

  it("replacement shows both exact hashes with revision-bound previews", () => {
    const html = render(
      <PrAssetDeltaRow
        kbId={KB}
        baseSha={BASE}
        headSha={HEAD}
        delta={{ path: "media/pic.png", before: png(H1), after: png(H2) }}
      />,
    );
    expect(html).toContain("Replaced");
    expect(html).toContain(H1);
    expect(html).toContain(H2);
    expect(html).toContain(`src="/kb-assets/${KB}/${H1}?rev=${BASE}"`);
    expect(html).toContain(`src="/kb-assets/${KB}/${H2}?rev=${HEAD}"`);
  });

  it("addition previews only the head revision; removal only the base", () => {
    const added = render(
      <PrAssetDeltaRow
        kbId={KB}
        baseSha={BASE}
        headSha={HEAD}
        delta={{ path: "media/pic.png", before: null, after: png(H2) }}
      />,
    );
    expect(added).toContain("Added");
    expect(added).toContain(`?rev=${HEAD}`);
    expect(added).not.toContain(`?rev=${BASE}`);
    const removed = render(
      <PrAssetDeltaRow
        kbId={KB}
        baseSha={BASE}
        headSha={HEAD}
        delta={{ path: "media/pic.png", before: png(H1), after: null }}
      />,
    );
    expect(removed).toContain("Removed");
    expect(removed).toContain(`?rev=${BASE}`);
    expect(removed).not.toContain(`?rev=${HEAD}`);
  });

  it("an untrusted MIME (SVG) is listed by hash but never requested", () => {
    const html = render(
      <PrAssetDeltaRow
        kbId={KB}
        baseSha={BASE}
        headSha={HEAD}
        delta={{
          path: "media/x.svg",
          before: null,
          after: { path: "media/x.svg", hash: H2, size: 3, mime: "image/svg+xml" },
        }}
      />,
    );
    expect(html).toContain(H2);
    expect(html).not.toContain("/kb-assets/");
  });
});

describe("PrRenderedPair", () => {
  const doc = (markdown: string, commitSha: string) => ({
    path: "notes/a.md",
    markdown,
    commitSha,
    documentCitations: [],
    assetRefs: [],
  });

  it("renders before and after at their own revisions; raw HTML stays inert text", () => {
    const html = render(
      <PrRenderedPair
        lang="en-US"
        kbId={KB}
        before={doc("plain", BASE)}
        after={doc("**bold**\n\n<script>window.x=1</script>", HEAD)}
      />,
    );
    expect(html).toContain("Before");
    expect(html).toContain("After");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain(BASE.slice(0, 12));
    expect(html).toContain(HEAD.slice(0, 12));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("gives each before/after document and each file its own fragment IDs", () => {
    const markdown =
      "# Install\n\n[Section](#install)\n\n# Main content\n\n[Main section](#main-content)";
    const html = render(
      <>
        <PrRenderedPair
          lang="en-US"
          kbId={KB}
          before={doc(markdown, BASE)}
          after={doc(markdown, HEAD)}
        />
        <PrRenderedPair
          lang="en-US"
          kbId={KB}
          before={doc(markdown, BASE)}
          after={doc(markdown, HEAD)}
        />
      </>,
    );
    const ids = [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((match) => match[1]!);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids).not.toContain("main-content");
    const links = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    expect(links).toHaveLength(8);
    for (const id of links) expect(ids).toContain(id);
  });

  it("an added file has no before side", () => {
    const html = render(
      <PrRenderedPair lang="en-US" kbId={KB} before={null} after={doc("x", HEAD)} />,
    );
    expect(html).toContain("Not present before");
  });
});

describe("PrDiffProgress", () => {
  it("uses singular copy for one loaded change", () => {
    expect(render(<PrDiffProgress count={1} complete drift={false} />)).toContain(
      "1 change loaded.",
    );
  });

  it("never claims completeness before the final page", () => {
    const partial = render(<PrDiffProgress count={150} complete={false} drift={false} />);
    expect(partial).not.toContain('data-testid="pr-diff-complete"');
    expect(partial).toContain('data-testid="pr-diff-incomplete"');
    const done = render(<PrDiffProgress count={205} complete drift={false} />);
    expect(done).toContain('data-testid="pr-diff-complete"');
    expect(done).toContain("205");
  });
  it("drift is reported instead of completeness", () => {
    const html = render(<PrDiffProgress count={50} complete={false} drift />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-testid="pr-diff-complete"');
  });
});
