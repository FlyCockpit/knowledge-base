import { describe, expect, it } from "vitest";

import { documentTitle, joinProvenanceStamp, splitProvenanceStamp } from "./document-text";

describe("splitProvenanceStamp", () => {
  it("hides front matter that is only the server's provenance stamp", () => {
    const text = "---\nprovenance: human\n---\n# Sourdough\n\nFeed it.\n";
    const { stamp, body } = splitProvenanceStamp(text);
    expect(stamp).toBe("---\nprovenance: human\n---\n");
    expect(body).toBe("# Sourdough\n\nFeed it.\n");
    expect(stamp + body).toBe(text);
  });

  it("keeps CRLF stamps and a stamp with an empty body", () => {
    expect(splitProvenanceStamp("---\r\nprovenance: agent\r\n---\r\nx")).toEqual({
      stamp: "---\r\nprovenance: agent\r\n---\r\n",
      body: "x",
    });
    expect(splitProvenanceStamp("---\nprovenance: human\n---\n")).toEqual({
      stamp: "---\nprovenance: human\n---\n",
      body: "",
    });
  });

  it("shows a stamp that ends the file without a line ending, so typing can't break it", () => {
    const text = "---\nprovenance: human\n---";
    expect(splitProvenanceStamp(text)).toEqual({ stamp: "", body: text });
    expect(joinProvenanceStamp("", `${text}\nHello`)).toBe(`${text}\nHello`);
  });

  it("shows front matter the person wrote, provenance included", () => {
    for (const text of [
      "---\ntitle: A\nprovenance: human\n---\nbody",
      "---\nprovenance: human\ntags: [a]\n---\nbody",
      "# No front matter\n",
      "---\nprovenance: human\n---more\n",
      // The body's own leading `---` line would read as front matter if shown first.
      "---\nprovenance: human\n---\n---\n# Heading\n---\nText",
    ]) {
      expect(splitProvenanceStamp(text)).toEqual({ stamp: "", body: text });
    }
  });
});

describe("joinProvenanceStamp", () => {
  const stamp = "---\nprovenance: human\n---\n";

  it("puts the hidden stamp back, so an unchanged body is the same bytes", () => {
    expect(joinProvenanceStamp(stamp, "# A\n")).toBe(`${stamp}# A\n`);
    expect(joinProvenanceStamp("", "# A\n")).toBe("# A\n");
  });

  it("drops it when the person starts front matter of their own", () => {
    expect(joinProvenanceStamp(stamp, "---\ntitle: A\n---\n# A")).toBe("---\ntitle: A\n---\n# A");
  });
});

describe("documentTitle", () => {
  it("reads the first level-1 heading after front matter", () => {
    expect(
      documentTitle("---\nprovenance: human\n---\n# Sourdough starter care\n\ntext", "notes/s.md"),
    ).toBe("Sourdough starter care");
    expect(documentTitle("Intro\n\n## Sub\n\n#  Main title  ##\n", "a.md")).toBe("Main title");
  });

  it("reads a Setext H1 (a paragraph underlined with ===)", () => {
    expect(documentTitle("Meeting notes\n=============\n\nText", "m.md")).toBe("Meeting notes");
    expect(documentTitle("Intro text\n\nTwo line\ntitle\n===\n", "m.md")).toBe("Two line title");
    // A level-2 underline, or === with nothing above, is no title.
    expect(documentTitle("Sub\n---\n\n===\n", "dir/m.md")).toBe("m");
    expect(documentTitle("Sub\n---\n===\n", "dir/m.md")).toBe("m");
  });

  it("skips headings inside code fences", () => {
    expect(documentTitle("```md\n# Not this\n```\n# This\n", "a.md")).toBe("This");
    expect(documentTitle("~~~\n# no\n```\n# still code\n~~~\n", "dir/b.md")).toBe("b");
  });

  it("falls back to the file name without .md", () => {
    expect(documentTitle("no heading", "notes/sourdough.md")).toBe("sourdough");
    expect(documentTitle(null, "README.MD")).toBe("README");
    expect(documentTitle("#hashtag is not a heading", "x.md")).toBe("x");
  });
});
