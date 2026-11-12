import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { createInstance } from "i18next";
import {
  Children,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useState,
} from "react";
import { I18nextProvider } from "react-i18next";
import type { Components } from "react-markdown";
import { beforeAll, describe, expect, it } from "vitest";
import {
  citationHref,
  KbRenderedDocument,
  kbUrlTransform,
  type MarkdownContext,
  MarkdownView,
  safeExternalHref,
} from "@/components/kb/markdown-view";
import { renderWithTestRouter as renderToStaticMarkup } from "@/lib/router-test-utils";
import assetReferenceCases from "../../../../../packages/api/src/lib/kb/fixtures/asset-reference-cases.json";

const KB = "a".repeat(24);
const REV = "9".repeat(40);
const PNG = `sha256:${"1".repeat(64)}`;
const MP4 = `sha256:${"2".repeat(64)}`;
const WAV = `sha256:${"3".repeat(64)}`;

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

const context: MarkdownContext = {
  lang: "en-US",
  kbId: KB,
  rev: REV,
  documentPath: "notes/page.md",
  assets: [
    { path: "media/pic.png", hash: PNG, size: 10, mime: "image/png" },
    { path: "media/clip.mp4", hash: MP4, size: 20, mime: "video/mp4" },
    { path: "media/sound.wav", hash: WAV, size: 30, mime: "audio/wav" },
  ],
};

function html(markdown: string, ctx: MarkdownContext = context) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <MarkdownView markdown={markdown} context={ctx} />
    </I18nextProvider>,
  );
}

/** Every href/src attribute value in rendered HTML. */
function urls(out: string): string[] {
  return [...out.matchAll(/\s(?:href|src|srcset|poster|action|formaction)="([^"]*)"/g)].map(
    (match) => match[1]!,
  );
}

// The Node-only harness uses a render-phase update to retain real React hook
// state across two renders, without adding a DOM or a client renderer dependency.
function RenderTwiceHarness<P>({
  useRender,
  renders,
}: {
  useRender: (pass: number) => ReactElement<P>;
  renders: ReactElement<P>[];
}) {
  const [pass, setPass] = useState(0);
  const element = useRender(pass);
  renders.push(element);
  if (pass === 0) setPass(1);
  return element;
}

function renderTwice<P>(useRender: (pass: number) => ReactElement<P>) {
  const renders: ReactElement<P>[] = [];
  const out = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <RenderTwiceHarness useRender={useRender} renders={renders} />
    </I18nextProvider>,
  );
  expect(renders).toHaveLength(2);
  return { renders, out };
}

const useMarkdownView = (
  MarkdownView as unknown as {
    type: (
      props: ComponentProps<typeof MarkdownView>,
    ) => ReactElement<{ children: ReactElement<{ components: Components }> }>;
  }
).type;
const useRenderedDocument = KbRenderedDocument;

function viewContext(element: ReactElement<{ children: ReactNode }>) {
  const view = Children.toArray(element.props.children).find(
    (child) => isValidElement(child) && child.type === MarkdownView,
  );
  if (!isValidElement<ComponentProps<typeof MarkdownView>>(view))
    throw new Error("Missing MarkdownView");
  return view.props.context;
}

describe("Markdown memoization", () => {
  it("memoizes the view and retains image/code component types while Markdown changes", () => {
    expect(MarkdownView).toMatchObject({ $$typeof: Symbol.for("react.memo") });
    const { renders, out } = renderTwice((pass) =>
      useMarkdownView({ markdown: pass === 0 ? "old" : "new", context }),
    );
    const before = renders[0]!.props.children.props.components;
    const after = renders[1]!.props.children.props.components;
    expect(after).toBe(before);
    expect(after.img).toBe(before.img);
    expect(after.pre).toBe(before.pre);
    expect(out).toContain("new");
  });

  it("refreshes media renderers when the revision context changes", () => {
    const next = { ...context, rev: "8".repeat(40) };
    const { renders, out } = renderTwice((pass) =>
      useMarkdownView({
        markdown: "![pic](../media/pic.png)",
        context: pass === 0 ? context : next,
      }),
    );
    expect(renders[1]!.props.children.props.components).not.toBe(
      renders[0]!.props.children.props.components,
    );
    expect(out).toContain(`?rev=${next.rev}`);
    expect(out).not.toContain(`?rev=${REV}`);
  });

  it("refreshes code renderers when the translated copy label changes", () => {
    const original = i18n.t("common:actions.copy");
    try {
      const { renders, out } = renderTwice((pass) => {
        if (pass === 1) i18n.addResource("en-US", "common", "actions.copy", "Copy translated");
        return useMarkdownView({ markdown: "```\ncode\n```", context });
      });
      expect(renders[1]!.props.children.props.components.pre).not.toBe(
        renders[0]!.props.children.props.components.pre,
      );
      expect(out).toContain("Copy translated");
    } finally {
      i18n.addResource("en-US", "common", "actions.copy", original);
    }
  });

  const document = {
    path: context.documentPath,
    markdown: "[next](next.md)",
    commitSha: REV,
    documentCitations: [],
    assetRefs: [...context.assets],
  };

  it("retains viewer context when a new document wrapper has unchanged context fields", () => {
    const { renders } = renderTwice((pass) =>
      useRenderedDocument({
        lang: context.lang,
        kbId: KB,
        document: pass === 0 ? document : { ...document, markdown: "new body" },
        showRevision: pass === 0,
      }),
    );
    expect(viewContext(renders[1]!)).toBe(viewContext(renders[0]!));
  });

  it.each(["lang", "kbId", "commitSha", "path", "assetRefs"] as const)(
    "refreshes viewer context when %s changes",
    (field) => {
      const { renders } = renderTwice((pass) =>
        useRenderedDocument({
          lang: pass === 1 && field === "lang" ? "de-DE" : context.lang,
          kbId: pass === 1 && field === "kbId" ? "b".repeat(24) : KB,
          document:
            pass === 0
              ? document
              : {
                  ...document,
                  commitSha: field === "commitSha" ? "8".repeat(40) : document.commitSha,
                  path: field === "path" ? "other.md" : document.path,
                  assetRefs: field === "assetRefs" ? [] : document.assetRefs,
                },
        }),
      );
      expect(viewContext(renders[1]!)).not.toBe(viewContext(renders[0]!));
    },
  );
});

describe("GFM block rendering", () => {
  it("renders headings, lists, code and tables", () => {
    const out = html(
      [
        "# Title",
        "",
        "## Sub *emph* **strong** ~~gone~~ `code`",
        "",
        "- one",
        "- two",
        "  - nested",
        "",
        "1. first",
        "2. second",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "```ts",
        "const a = '<b>';",
        "```",
        "",
        "| Left | Right |",
        "| :--- | ----: |",
        "| a | b |",
        "",
        "> quoted",
        "",
        "---",
        "",
        "Setext",
        "======",
      ].join("\n"),
    );
    expect(out).toContain('<h2 id="title" class="md-h1">Title</h2>');
    expect(out).toContain(
      '<h3 id="sub-emph-strong-gone-code" class="md-h2">Sub <em>emph</em> <strong>strong</strong> <del>gone</del> <code>code</code></h3>',
    );
    expect(out).toMatch(
      /<ul[^>]*>\s*<li>one<\/li>\s*<li>two\s*<ul[^>]*>\s*<li>nested<\/li>\s*<\/ul>\s*<\/li>\s*<\/ul>/,
    );
    expect(out).toMatch(/<ol[^>]*>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("checked");
    expect(out).toContain("const a = &#x27;&lt;b&gt;&#x27;;");
    expect(out).toContain('data-slot="code-snippet"');
    expect(out).toMatch(/<table>[\s\S]*<th[^>]*style="text-align:left"[^>]*>Left<\/th>/);
    expect(out).toMatch(/<td[^>]*style="text-align:right"[^>]*>b<\/td>/);
    expect(out).toContain("<blockquote");
    expect(out).toContain("<hr");
    expect(out).toContain('<h2 id="setext" class="md-h1">Setext</h2>');
  });

  it("renders headings one level below the page's own h1 (R2-19)", () => {
    const out = html("# One\n\n###### Six\n");
    expect(out).not.toContain("<h1");
    expect(out).toContain('<h2 id="one" class="md-h1">One</h2>');
    expect(out).toContain('<h6 id="six" class="md-h6">Six</h6>');
  });

  it("strips YAML front matter from the rendered body", () => {
    const out = html("---\ntitle: Secret front matter\n---\n# Body\n");
    expect(out).not.toContain("Secret front matter");
    expect(out).toContain('<h2 id="body" class="md-h1">Body</h2>');
  });

  it("renders an empty document as an empty article", () => {
    expect(html("")).not.toContain("<p");
  });
});

describe("hostile Markdown never becomes markup, handlers or unsafe URLs", () => {
  const payloads = [
    "<script>window.__pwned = 1</script>",
    '<img src="https://attacker.example/raw.png" onerror="window.__pwned=1">',
    '<a href="javascript:alert(1)">raw</a>',
    '<svg onload="window.__pwned=1"><circle r="1"/></svg>',
    '<iframe src="https://attacker.example"></iframe>',
    "<style>body{display:none}</style>",
  ];
  it.each(payloads)("raw HTML is inert text: %s", (payload) => {
    const out = html(`before ${payload} after\n\n${payload}\n`);
    expect(out).not.toMatch(/<(script|img|svg|iframe|style|a)\b/i);
    // No real tag carries an event-handler attribute (escaped text may mention one).
    expect(out).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    expect(out).toContain("&lt;");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "//attacker.example/path",
    "https://user:pass@attacker.example/",
    "ftp://attacker.example/x",
  ])("link destination %s is never clickable", (target) => {
    const out = html(`[click](<${target}>) and [again](${target.trim()})`);
    for (const url of urls(out)) {
      expect(url.toLowerCase()).not.toMatch(/^(javascript|vbscript|data|file|mailto):/);
      expect(url).not.toContain("attacker.example");
    }
  });

  it("mailto links are the only non-http(s) scheme allowed and open in place", () => {
    const out = html("[mail](mailto:someone@example.com) <mailto:other@example.com>");
    expect(urls(out)).toEqual(["mailto:someone@example.com", "mailto:other@example.com"]);
    expect(out).not.toMatch(/<a[^>]*href="mailto:[^"]*"[^>]*target=/);
  });

  it("the strict URL transform allows only http(s)/mailto and KB-relative destinations", () => {
    for (const key of ["href", "src"]) {
      for (const bad of [
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
        "vbscript:x",
        "file:///etc/passwd",
        "//attacker.example/x",
        "blob:https://example.com/x",
      ])
        expect(kbUrlTransform(bad, key)).toBe("");
      expect(kbUrlTransform("../media/pic.png", key)).toBe("../media/pic.png");
    }
    expect(kbUrlTransform("https://example.com/a", "href")).toBe("https://example.com/a");
    expect(kbUrlTransform("mailto:a@example.com", "href")).toBe("mailto:a@example.com");
    // Images never leave the KB: no remote fetch even over https, and no mailto.
    expect(kbUrlTransform("https://example.com/a.png", "src")).toBe("");
    expect(kbUrlTransform("mailto:a@example.com", "src")).toBe("");
    // Any other URL-bearing attribute is dropped outright.
    expect(kbUrlTransform("https://example.com/a", "cite")).toBe("");
  });

  it("GFM autolink literals obey the same policy", () => {
    const out = html("see www.example.com/x and someone@example.com and javascript:alert(1)");
    expect(urls(out)).toEqual(["http://www.example.com/x", "mailto:someone@example.com"]);
  });

  it("no raw-HTML plugin and no dangerouslySetInnerHTML anywhere in the render path", () => {
    const dir = resolve(import.meta.dirname);
    for (const file of ["markdown-view.tsx", "media.tsx", "document-editor.tsx", "pr-diff.tsx"]) {
      const source = readFileSync(resolve(dir, file), "utf8");
      expect(source, file).not.toContain("dangerouslySetInnerHTML");
      expect(source, file).not.toMatch(/rehype-raw|allowDangerousHtml/);
    }
    const pkg = readFileSync(resolve(dir, "../../../package.json"), "utf8");
    expect(pkg).not.toContain("rehype-raw");
    expect(pkg).toMatch(/"react-markdown": "catalog:"/);
    expect(pkg).toMatch(/"remark-gfm": "catalog:"/);
  });

  it("autolinks only http/https", () => {
    const out = html("<javascript:alert(1)> <https://example.com/ok> <file:///x>");
    expect(urls(out)).toEqual(["https://example.com/ok"]);
  });

  it.each([
    "https://attacker.example/pixel.png",
    "http://attacker.example/pixel.png",
    "//attacker.example/pixel.png",
    "data:image/png;base64,iVBORw0KGgo=",
    "javascript:alert(1)",
    "file:///etc/passwd",
  ])("image %s is never fetched", (src) => {
    const out = html(`![alt text](${src})`);
    expect(out).not.toMatch(/<img\b/);
    expect(out).not.toContain("attacker.example");
    expect(urls(out)).toEqual([]);
    expect(out).toContain("External image not loaded");
  });

  it("reference-style images and links obey the same policy", () => {
    const out = html(
      "![a][pic] [b][evil] [c][ok]\n\n[pic]: https://attacker.example/x.png\n[evil]: javascript:alert(1)\n[ok]: https://example.com/\n",
    );
    expect(out).not.toMatch(/<img\b/);
    expect(urls(out)).toEqual(["https://example.com/"]);
  });

  it("http/https links carry noopener noreferrer", () => {
    const out = html("[docs](https://example.com/a?b=1)");
    expect(out).toContain('href="https://example.com/a?b=1"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it("an SVG asset (never trusted) is not rendered inline", () => {
    const out = html("![logo](../media/logo.svg)", {
      ...context,
      assets: [
        {
          path: "media/logo.svg",
          hash: `sha256:${"4".repeat(64)}`,
          size: 1,
          mime: "image/svg+xml",
        },
      ],
    });
    expect(out).not.toMatch(/<(img|svg|object|embed|iframe)\b/);
    expect(urls(out)).toEqual([]);
  });
});

describe("relative links and media resolve against the pinned document", () => {
  it.each(assetReferenceCases.slice(9))(
    "matches the server/local decoded inventory: $markdown",
    ({ markdown, paths }) => {
      const ctx = {
        ...context,
        documentPath: "index.md",
        assets: paths.map((path) => ({ path, hash: PNG, size: 10, mime: "image/png" })),
      };
      const out = html(markdown, ctx);
      expect(out).not.toContain("Missing asset");
      expect(urls(out).length).toBe(paths.length === 0 ? 0 : markdown.split("![").length - 1);
      for (const url of urls(out)) expect(url).toBe(`/kb-assets/${KB}/${PNG}?rev=${REV}`);
    },
  );
  it("indexes the inventory once; images, links and citations use exact path lookups", () => {
    const assets = new Proxy(context.assets, {
      get(target, key, receiver) {
        if (key === "find") throw new Error("per-destination inventory scan");
        return Reflect.get(target, key, receiver);
      },
    });
    const out = html("![pic](../media/pic.png) [sound](../media/sound.wav) [missing](../none.md)", {
      ...context,
      assets,
    });
    expect(urls(out)).toHaveLength(3);
    expect(citationHref("../media/pic.png", { ...context, assets })).toBeNull();
    expect(citationHref("../none.md", { ...context, assets })).toContain(`rev=${REV}`);
  });

  it("renders image, video and audio from the manifest at the document revision", () => {
    const out = html(
      "![A picture](../media/pic.png)\n\n![A clip](../media/clip.mp4)\n\n![A sound](/media/sound.wav)\n",
    );
    expect(out).toContain(`src="/kb-assets/${KB}/${PNG}?rev=${REV}"`);
    expect(out).toContain('alt="A picture"');
    expect(out).toMatch(
      new RegExp(`<video[^>]*controls[^>]*src="/kb-assets/${KB}/${MP4}\\?rev=${REV}"`),
    );
    expect(out).toMatch(
      new RegExp(`<audio[^>]*controls[^>]*src="/kb-assets/${KB}/${WAV}\\?rev=${REV}"`),
    );
  });

  it("a missing asset is a visible error, not silently omitted", () => {
    const out = html("![Gone](../media/gone.png)");
    expect(out).toContain('role="alert"');
    expect(out).toContain("Missing asset: media/gone.png");
    expect(urls(out)).toEqual([]);
  });

  it("relative document links stay pinned to the viewed revision", () => {
    const out = html("[other](other.md) [up](../top.md#part)");
    expect(out).toContain(`href="/en-US/kbs/${KB}/documents?path=notes%2Fother.md&amp;rev=${REV}"`);
    expect(out).toContain(`href="/en-US/kbs/${KB}/documents?path=top.md&amp;rev=${REV}#part"`);
  });

  it("a relative link escaping the KB root is plain text", () => {
    const out = html("[bad](../../../etc/passwd.md)");
    expect(urls(out)).toEqual([]);
    expect(out).toContain("bad");
  });
});

describe("citations", () => {
  it("only http/https or safe relative documents are clickable", () => {
    expect(safeExternalHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeExternalHref("http://example.com/x")).toBe("http://example.com/x");
    for (const bad of ["javascript:alert(1)", "data:,x", "file:///x", "ftp://x", "//x.example"])
      expect(safeExternalHref(bad)).toBeNull();
    expect(citationHref("mailto:someone@example.com", context)).toBeNull();
    expect(citationHref("episode:1234", context)).toBeNull();
    expect(citationHref("javascript:alert(1)", context)).toBeNull();
    expect(citationHref("sibling.md", context)).toBe(
      `/en-US/kbs/${KB}/documents?path=notes%2Fsibling.md&rev=${REV}`,
    );
    expect(citationHref("https://example.com/src", context)).toBe("https://example.com/src");
  });

  it("renders citation labels as text and unsafe targets unlinked", () => {
    const out = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <KbRenderedDocument
          lang="en-US"
          kbId={KB}
          document={{
            path: "notes/page.md",
            markdown: "# Doc\n",
            commitSha: REV,
            documentCitations: [
              { label: "<b>Source</b>", target: "https://example.com/src" },
              { label: "Mail", target: "mailto:someone@example.com" },
              { label: "Evil", target: "javascript:alert(1)" },
              { label: "Episode", target: "cockpit-episode:42" },
            ],
            assetRefs: [],
          }}
        />
      </I18nextProvider>,
    );
    expect(out).toContain("&lt;b&gt;Source&lt;/b&gt;");
    expect(urls(out)).toEqual(["https://example.com/src"]);
    expect(out).toContain("javascript:alert(1)");
    expect(out).toContain("cockpit-episode:42");
  });
});

describe("section links", () => {
  it("assigns duplicate suffixes per document, with stable IDs across renders", () => {
    const markdown = "# Setup!\n\n## Setup!\n\n### Setup!\n\n# Café *rápido*\n";
    const first = html(markdown);
    expect(first).toContain('id="setup"');
    expect(first).toContain('id="setup-1"');
    expect(first).toContain('id="setup-2"');
    expect(first).toContain('id="café-rápido"');
    expect(html(markdown)).toBe(first);
  });

  it("keeps both sides of GFM footnote navigation reachable", () => {
    const out = html("A note[^one].\n\n[^one]: Body");
    expect(out).toContain('id="user-content-fnref-one"');
    expect(out).toContain('href="#user-content-fnref-one"');
    expect(out).toContain('id="user-content-fn-one"');
  });

  it("preserves encoded fragments on citations without changing revision pinning", () => {
    expect(citationHref("other.md#caf%C3%A9", context)).toBe(
      `/en-US/kbs/${KB}/documents?path=notes%2Fother.md&rev=${REV}#caf%C3%A9`,
    );
  });

  it("contains horizontal table gestures with WideContent", () => {
    const out = html("| Name | Value |\n| --- | --- |\n| A | B |");
    expect(out).toContain("overscroll-x-contain");
    expect(out).toContain("max-w-full");
  });
});

it("namespaces preview headings and footnotes without changing cross-document fragments", () => {
  const out = html(
    "# Setup\n\n[section](#setup) [other](other.md#setup)\n\nNote[^a]\n\n[^a]: Body",
    { ...context, fragmentPrefix: "preview-" },
  );
  expect(out).toContain('id="preview-setup"');
  expect(out).toContain('href="#preview-setup"');
  expect(out).toContain(`#setup"`);
  expect(out).toContain('id="preview-user-content-fnref-a"');
  expect(out).toContain('href="#preview-user-content-fnref-a"');
  expect(out).toContain('aria-describedby="preview-footnote-label"');
});
