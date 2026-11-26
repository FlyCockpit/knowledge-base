import { describe, expect, it } from "vitest";

// The server's own chunker, so the snippets are exactly what search returns.
import { chunkBody } from "../../../../../packages/api/src/lib/kb/chunk";

import { headingForSnippet } from "./snippet-heading";

const filler = (word: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${word}${i}`).join(" ");

describe("headingForSnippet", () => {
  it("finds the heading before a later chunk of the document", () => {
    const body = [
      "# Sourdough",
      "",
      `Intro ${filler("alpha", 300)}.`,
      "",
      "## Feeding the **starter**",
      "",
      `Use [whole wheat](https://flour.example/ww) flour ${filler("beta", 300)}.`,
      "",
      "## Baking",
      "",
      `Bake hot ${filler("gamma", 300)}.`,
    ].join("\n");
    const chunks = chunkBody(body).chunks;
    expect(chunks.length).toBeGreaterThan(1);
    const ids = chunks.map((chunk) => headingForSnippet(body, chunk.snippet));
    // Chunk 0 starts at the title; later chunks start inside a section.
    expect(ids[0]).toBe("sourdough");
    const expected = chunks.map((chunk) => {
      const at = chunk.span.startByte;
      const before = Buffer.from(body).subarray(0, at).toString();
      return before.includes("## Baking")
        ? "baking"
        : before.includes("## Feeding")
          ? "feeding-the-starter"
          : "sourdough";
    });
    expect(ids).toEqual(expected);
  });

  it("matches through stripped Markdown and front matter", () => {
    const md =
      "---\ntitle: Bread\n---\n# Bread\n\n## Gluten\n\nThe *gluten* network [forms](x.md) when **flour** meets water.";
    expect(headingForSnippet(md, "The gluten network forms when flour meets water.")).toBe(
      "gluten",
    );
    expect(headingForSnippet(md, "network forms when flour meets water…")).toBe("gluten");
  });

  it("is null when the words are not in the document or come before any heading", () => {
    expect(headingForSnippet("# A\n\ntext here now", "completely different words entirely")).toBe(
      null,
    );
    expect(
      headingForSnippet("Preface words come first\n\n# Later", "Preface words come first"),
    ).toBe(null);
    expect(headingForSnippet("no headings at all here", "no headings at all")).toBe(null);
    expect(headingForSnippet("# A\n\nbody", "")).toBe(null);
  });

  it("uses the rendered ids for duplicate headings", () => {
    const md = "# Notes\n\nfirst body text here\n\n# Notes\n\nsecond body text here";
    expect(headingForSnippet(md, "second body text here")).toBe("notes-1");
  });
});
