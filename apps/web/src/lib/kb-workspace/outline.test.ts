import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { rehypeHeadingIds } from "@/lib/markdown-heading-slugs";

import { documentOutline } from "./outline";

/** The ids the canonical renderer gives headings (same plugins as `MarkdownView`). */
function renderedIds(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  const body = close < 0 ? markdown : lines.slice(close + 1).join("\n");
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeHeadingIds] },
      body,
    ),
  );
  // The GFM footnotes heading is sr-only and already has its id; not an outline entry.
  return [...html.matchAll(/<h[1-6][^>]*\bid="([^"]*)"/g)]
    .map((m) => m[1]!)
    .filter((id) => id !== "footnote-label")
    .map((id) => id.replace(/&amp;/g, "&"));
}

const ids = (markdown: string) => documentOutline(markdown).map((h) => h.id);

describe("documentOutline", () => {
  it("lists ATX and setext headings with levels, text and lines", () => {
    expect(
      documentOutline("# Title\n\nSome text\n\n## Part one ##\n\nIntro\n===\n\nNext\n---\n"),
    ).toEqual([
      { level: 1, text: "Title", id: "title", line: 0 },
      { level: 2, text: "Part one", id: "part-one", line: 4 },
      { level: 1, text: "Intro", id: "intro", line: 6 },
      { level: 2, text: "Next", id: "next", line: 9 },
    ]);
  });

  it("skips front matter and fenced code, counts lines from the file start", () => {
    const md =
      "---\ntitle: x\n# not a heading\n---\n# Real\n```sh\n# comment\n```\n~~~\n## also code\n~~~\n## After";
    expect(documentOutline(md)).toEqual([
      { level: 1, text: "Real", id: "real", line: 4 },
      { level: 2, text: "After", id: "after", line: 11 },
    ]);
  });

  it("numbers duplicates and avoids the shell's reserved ids", () => {
    expect(ids("# Notes\n# Notes\n# Notes\n# Main content\n# Root")).toEqual([
      "notes",
      "notes-1",
      "notes-2",
      "main-content-1",
      "root-1",
    ]);
  });

  it("reduces inline Markdown to the rendered text", () => {
    const outline = documentOutline(
      "# *Emphasis* and **strong** ~~gone~~\n## A [link](https://x.example/a_b) here\n### Use `npm i` now\n#### ![Logo](logo.png) brand\n##### snake_case_name 2 * 3\n###### Tom &amp; Jerry \\*literal\\*",
    );
    expect(outline.map((h) => h.text)).toEqual([
      "Emphasis and strong gone",
      "A link here",
      "Use npm i now",
      "Logo brand",
      "snake_case_name 2 * 3",
      "Tom & Jerry *literal*",
    ]);
  });

  it("finds headings in block quotes and list items, but not in indented code or HTML blocks", () => {
    expect(
      ids("> # Quoted\n\n- ## Listed\n\n    # indented code\n\n<div>\n# in html\n</div>\n\n# Last"),
    ).toEqual(["quoted", "listed", "last"]);
  });

  it("does not take a thematic break after a blank line for a setext heading", () => {
    expect(ids("Para\n\n---\n\nText\n***\n")).toEqual([]);
  });

  const corpus: Record<string, string> = {
    basic: "# Sourdough starter\n\nFlour and water.\n\n## Feeding schedule\n\n### Day 1 — mix\n",
    duplicates: "# A\n## A\n### A\n# a\n# A-1\n# A",
    inline:
      "# *Em* **Strong** ***both*** ~~del~~ ~single~\n## [Link](https://e.example) and [ref][r]\n### `code span` and ``a`b``\n#### ![alt *text*](x.png)\n##### Tom &amp; Jerry &copy; &#65;\n###### \\# escaped \\[brackets\\]\n\n[r]: https://r.example",
    punctuation:
      "# What's new? (v2.0)!\n## C++ / C# — notes\n### 100% done: yes/no\n#### Ünïcödé Straße 東京\n",
    emphasisEdges:
      "# 2 * 3 * 4\n## snake_case_name\n### __init__ method\n#### *unclosed\n##### **a** b**\n###### _a_b_",
    rawHtml:
      "# Hello <b>bold</b> world\n## <https://auto.example/link>\n### a@b.example <span>x</span>",
    setext: "Multi\nline\n===\n\nSecond\n---\n\n- item\n---\n",
    fences: "```\n# no\n```\n# yes\n````md\n```\n# still code\n````\n# after",
    frontMatter: "---\ntitle: T\n---\n# Body title\n## Next",
    footnotes: "# Footnote label\n\nText[^1].\n\n[^1]: Note.\n",
    containers: "> # Quote heading\n> ## Second\n\n1. # Ordered\n- ## Bullet\n",
    lists: "- one\n- two\n---\n\n> quoted\nlazy\n===\n\n- item\n  more\n  ---\n",
    reserved: "# Main content\n# App main\n# root\n# Root",
    // Named references beyond any short list, decoded as the renderer's parser does.
    entities:
      "# Caf&eacute; &Agrave; la carte\n## &frac12; &euro;5 &hearts; &notanentity;\n### &AMP; &Eacute;t&eacute;",
  };
  for (const [name, md] of Object.entries(corpus)) {
    it(`matches the rendered ids: ${name}`, () => {
      expect(ids(md)).toEqual(renderedIds(md));
    });
  }
});
