import { describe, expect, it } from "vitest";
import conformance from "./fixtures/yaml-conformance.json";
import {
  bodyByteOffsetAfterFrontMatter,
  decodeUtf8Fatal,
  KB_MARKDOWN_LIMITS,
  parseMarkdownDocument,
  splitFrontMatter,
} from "./parse-markdown";
import { frontMatterSchema } from "./protocol/common";

describe("parseMarkdownDocument", () => {
  it("keeps CRLF body byte offsets exact after the front matter delimiter", () => {
    const bytes = Buffer.from("---\ntitle: crlf\r\n---\r\n\r\nline\r\n", "utf8");
    const { body } = splitFrontMatter(bytes);
    expect(body.toString("utf8")).toBe("\r\nline\r\n");
    expect(bodyByteOffsetAfterFrontMatter(bytes)).toBe(bytes.byteLength - body.byteLength);
    const parsed = parseMarkdownDocument(bytes);
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.body).toBe("\r\nline\r\n");
    }
  });

  it("keeps multibyte front matter body byte offsets exact", () => {
    const bytes = Buffer.from("---\ntitle: über\n---\n\nbody\n", "utf8");
    expect(bodyByteOffsetAfterFrontMatter(bytes)).toBe(21);
    const { body } = splitFrontMatter(bytes);
    expect(body.toString("utf8")).toBe("\nbody\n");
    const parsed = parseMarkdownDocument(bytes);
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.body).toBe("\nbody\n");
      expect(parsed.bodyBytes.equals(body)).toBe(true);
    }
  });

  it("does not truncate emoji front matter into the body", () => {
    const bytes = Buffer.from("---\ntitle: é\ntopic: 😊\n---\nBODY\n", "utf8");
    const { body } = splitFrontMatter(bytes);
    expect(body.toString("utf8")).toBe("BODY\n");
    const parsed = parseMarkdownDocument(bytes);
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.body).toBe("BODY\n");
      expect(parsed.frontMatter.topic).toBe("😊");
    }
  });

  it("parses bounded citations from YAML front matter", () => {
    const bytes = Buffer.from(
      "---\ncitations:\n  - label: cite\n    target: https://example.com\n---\n\nok\n",
      "utf8",
    );
    const parsed = parseMarkdownDocument(bytes);
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.citations).toEqual([{ label: "cite", target: "https://example.com" }]);
    }
  });

  it("rejects anchors, aliases, tags and merge keys", () => {
    const cases = [
      "id: &x shared\nother: *x\n",
      "id: !!str tagged\n",
      "<<: *base\n",
      "items:\n  - &anch a\n",
      "flow: [&a 1, *a]\n",
    ];
    for (const yaml of cases) {
      const parsed = parseMarkdownDocument(Buffer.from(`---\n${yaml}---\nx\n`, "utf8"));
      expect(`code` in parsed).toBe(true);
    }
  });

  it("rejects duplicate keys after decoding", () => {
    for (const yaml of [
      'id: first\n"id": second\n',
      "meta: {a: 1, a: 2}\n",
      "id: one\nid: two\n",
    ]) {
      const parsed = parseMarkdownDocument(Buffer.from(`---\n${yaml}---\nx\n`, "utf8"));
      expect("code" in parsed).toBe(true);
      if ("code" in parsed) expect(parsed.code).toBe("MARKDOWN_YAML_DUPLICATE");
    }
  });

  it("accepts comments, block scalars and quote-aware flow collections", () => {
    const yaml = [
      "# leading comment",
      "title: ok # trailing comment",
      "desc: |",
      "  line one",
      "  line two",
      "folded: >",
      "  a",
      "  b",
      'tags: ["one,two", three]',
      "meta: {a: 1, b: [x, y]}",
    ].join("\n");
    const parsed = parseMarkdownDocument(Buffer.from(`---\n${yaml}\n---\nx\n`, "utf8"));
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.frontMatter.title).toBe("ok");
      expect(parsed.frontMatter.desc).toBe("line one\nline two\n");
      expect(parsed.frontMatter.folded).toBe("a b\n");
      expect(parsed.frontMatter.tags).toEqual(["one,two", "three"]);
      expect(parsed.frontMatter.meta).toEqual({ a: 1, b: ["x", "y"] });
    }
  });

  it("preserves Unicode whitespace in plain and quoted values and mapping keys", () => {
    expect(parseMarkdownDocument(Buffer.from("---\n\ufeffid: shared\n---\n"))).toMatchObject({
      documentId: "shared",
    });
    // These are scalar content in YAML, even where JavaScript trim() removes them.
    for (const whitespace of [
      "\u00a0",
      "\u1680",
      ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)),
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
      "\ufeff",
    ]) {
      const value = `${whitespace}shared${whitespace}`;
      for (const scalar of [value, `"${value}"`, `'${value}'`]) {
        const yaml = [
          `id: \t${scalar} \t# comment`,
          `meta: { ${scalar}: ${scalar} }`,
          `tags: [ ${scalar}, ${whitespace} ]`,
          "rows:",
          `  - ${scalar}: ${scalar}`,
          `  - ${scalar}`,
          `${scalar}: value`,
        ].join("\n");
        expect(parseMarkdownDocument(Buffer.from(`---\n${yaml}\n---\n`))).toMatchObject({
          documentId: value,
          frontMatter: {
            meta: { [value]: value },
            tags: [value, whitespace],
            rows: [{ [value]: value }, value],
            [value]: "value",
          },
        });
      }
      for (const yaml of [
        // Keep a key's leading U+FEFF away from the YAML stream marker position.
        `title: document\n${value}: first\n"${value}": second`,
        `meta: {${value}: first, "${value}": second}`,
      ]) {
        expect(parseMarkdownDocument(Buffer.from(`---\n${yaml}\n---\n`))).toMatchObject({
          code: "MARKDOWN_YAML_DUPLICATE",
        });
      }
    }
  });

  it("does not treat Unicode whitespace as blank lines or comment separation", () => {
    expect(
      parseMarkdownDocument(Buffer.from("---\nid: \u00a0#content\u00a0\n---\n")),
    ).toMatchObject({ documentId: "\u00a0#content\u00a0" });
    for (const yaml of [
      "\u00a0",
      "\u00a0# not a comment",
      "meta:\n  \u00a0\nid: next",
      'id: "quoted" \u00a0# not a comment',
      "tags: [value] \u00a0# not a comment",
    ]) {
      expect(parseMarkdownDocument(Buffer.from(`---\n${yaml}\n---\n`))).toMatchObject({
        code: "MARKDOWN_YAML",
      });
    }
  });

  it("applies keep chomping without the split-line artifact newline", () => {
    // `|+` keeps real trailing blank lines; the line terminator before the
    // closing delimiter is not one of them.
    const keep = parseMarkdownDocument(Buffer.from("---\nid: |+\n  shared\n---\n\nbody\n", "utf8"));
    expect("code" in keep).toBe(false);
    if (!("code" in keep)) expect(keep.documentId).toBe("shared\n");
    const keepBlank = parseMarkdownDocument(
      Buffer.from("---\nid: |+\n  shared\n\n---\nx\n", "utf8"),
    );
    expect("code" in keepBlank).toBe(false);
    if (!("code" in keepBlank)) expect(keepBlank.documentId).toBe("shared\n\n");
    const strip = parseMarkdownDocument(Buffer.from("---\nid: |-\n  shared\n---\nx\n", "utf8"));
    expect("code" in strip).toBe(false);
    if (!("code" in strip)) expect(strip.documentId).toBe("shared");
  });

  it("resolves YAML core-schema scalars instead of stringifying them", () => {
    const parsed = parseMarkdownDocument(
      Buffer.from(
        "---\nscore: 1e3\nratio: .5\nflag: True\nnothing: Null\nsigned: +7\nexp: 1.5e-3\n---\nx\n",
        "utf8",
      ),
    );
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.frontMatter.score).toBe(1000);
      expect(parsed.frontMatter.ratio).toBe(0.5);
      expect(parsed.frontMatter.flag).toBe(true);
      expect(parsed.frontMatter.nothing).toBe(null);
      expect(parsed.frontMatter.signed).toBe(7);
      expect(parsed.frontMatter.exp).toBe(0.0015);
    }
    // A numeric document id must fail the string-id check, not pass as "1e3".
    const numericId = parseMarkdownDocument(Buffer.from("---\nid: 1e3\n---\nx\n", "utf8"));
    expect("code" in numericId).toBe(true);
    if ("code" in numericId) expect(numericId.code).toBe("MARKDOWN_DOCUMENT_ID");
    const inf = parseMarkdownDocument(Buffer.from("---\nscore: .inf\n---\nx\n", "utf8"));
    expect("code" in inf).toBe(true);
    if ("code" in inf) expect(inf.code).toBe("MARKDOWN_JSON_VALUE");
  });

  it("preserves folded leading blanks and breaks around more-indented text", () => {
    const cases = [
      ["\n  shared\n", "\nshared"],
      ["\n\n  shared\n", "\n\nshared"],
      ["  first\n  second\n", "first second"],
      ["  first\n\n  second\n", "first\nsecond"],
      ["  first\n\n    indented\n\n  last\n", "first\n\n  indented\n\nlast"],
      ["  first\n    \n  last\n", "first\n  \nlast"],
      ["  first\n  \t\n  last\n", "first\n\t\nlast"],
      ["  first\n  \u00a0\n  last\n", "first \u00a0 last"],
    ];
    for (const [source, decoded] of cases) {
      for (const [header, suffix] of [
        [">-", ""],
        [">", "\n"],
        [">+", "\n"],
      ]) {
        const parsed = parseMarkdownDocument(Buffer.from(`---\nid: ${header}\n${source}---\n`));
        expect(parsed).toMatchObject({ documentId: decoded! + suffix });
      }
    }
    expect(parseMarkdownDocument(Buffer.from("---\nid: >-\n    \n  shared\n---\n"))).toMatchObject({
      code: "MARKDOWN_YAML",
    });
  });

  it("resolves hexadecimal and octal numbers before validating ids and JSON safety", () => {
    for (const [source, value] of [
      ["0x10", 16],
      ["0o20", 16],
      ["0xFf", 255],
    ]) {
      expect(parseMarkdownDocument(Buffer.from(`---\nvalue: ${source}\n---\n`))).toMatchObject({
        frontMatter: { value },
      });
      expect(parseMarkdownDocument(Buffer.from(`---\nid: ${source}\n---\n`))).toMatchObject({
        code: "MARKDOWN_DOCUMENT_ID",
      });
    }
    for (const source of ["0x20000000000000", "9007199254740992", "1e999"]) {
      expect(parseMarkdownDocument(Buffer.from(`---\nvalue: ${source}\n---\n`))).toMatchObject({
        code: "MARKDOWN_JSON_VALUE",
      });
    }
  });

  it("accepts indentationless sequence values and closes them at sibling keys", () => {
    const parsed = parseMarkdownDocument(
      Buffer.from(
        [
          "---",
          "citations:",
          "- label: cite",
          "  target: https://example.com",
          "- label: other",
          "  target: docs/other.md",
          "meta:",
          "  rows:",
          "  - tags:",
          "    - one",
          "    - two",
          "    name: row",
          "  next: value",
          "id: document",
          "---",
        ].join("\n"),
      ),
    );
    expect(parsed).toMatchObject({
      documentId: "document",
      citations: [
        { label: "cite", target: "https://example.com" },
        { label: "other", target: "docs/other.md" },
      ],
      frontMatter: { meta: { rows: [{ tags: ["one", "two"], name: "row" }], next: "value" } },
    });
  });

  it("counts each block or flow container once, including the root, at the depth limit", () => {
    const arrays = (count: number): string => "[".repeat(count) + "value" + "]".repeat(count);
    const max = KB_MARKDOWN_LIMITS.maxFrontmatterDepth;
    for (const source of [
      `rows: ${arrays(9)}`,
      `rows: ${arrays(max - 1)}`,
      `meta:\n  rows: ${arrays(max - 2)}`,
      `rows:\n- ${arrays(max - 2)}`,
      Array.from(
        { length: max },
        (_, i) => `${"  ".repeat(i)}key:${i === max - 1 ? " value" : ""}`,
      ).join("\n"),
    ]) {
      expect(parseMarkdownDocument(Buffer.from(`---\n${source}\n---\n`))).not.toHaveProperty(
        "code",
      );
    }
    for (const source of [
      `rows: ${arrays(max)}`,
      `meta:\n  rows: ${arrays(max - 1)}`,
      `rows:\n- ${arrays(max - 1)}`,
      Array.from(
        { length: max + 1 },
        (_, i) => `${"  ".repeat(i)}key:${i === max ? " value" : ""}`,
      ).join("\n"),
    ]) {
      expect(parseMarkdownDocument(Buffer.from(`---\n${source}\n---\n`))).toMatchObject({
        code: "MARKDOWN_YAML_DEPTH",
      });
    }
  });

  it("accepts flow mappings as sequence items", () => {
    const parsed = parseMarkdownDocument(
      Buffer.from(
        "---\ncitations:\n  - {label: cite, target: https://example.com}\n---\nok\n",
        "utf8",
      ),
    );
    expect("code" in parsed).toBe(false);
    if (!("code" in parsed)) {
      expect(parsed.citations).toEqual([{ label: "cite", target: "https://example.com" }]);
    }
  });

  it("rejects escape-decoded control characters and lone surrogates in scalars", () => {
    for (const yaml of [
      'id: "a\\0b"\n',
      'id: "x\\u0000y"\n',
      'tags: ["c\\x01d"]\n',
      'id: "a\\u007fb"\n',
      'tags: ["a\\x7fb"]\n',
      '"a\\U0000007Fb": value\n',
      'id: "lone \\ud800 surrogate"\n',
    ]) {
      const parsed = parseMarkdownDocument(Buffer.from(`---\n${yaml}---\nx\n`, "utf8"));
      expect("code" in parsed).toBe(true);
      if ("code" in parsed) expect(parsed.code).toBe("MARKDOWN_YAML");
    }
    // An escaped surrogate pair decodes to a valid astral character: accepted.
    const pair = parseMarkdownDocument(
      Buffer.from('---\ntopic: "\\ud83d\\ude0a"\n---\nx\n', "utf8"),
    );
    expect("code" in pair).toBe(false);
    if (!("code" in pair)) expect(pair.frontMatter.topic).toBe("😊");
    expect(parseMarkdownDocument(Buffer.from("body\u007f"))).toMatchObject({
      code: "MARKDOWN_CONTROL",
    });
  });

  it("returns YAML issues for malformed or out-of-range Unicode escapes", () => {
    for (const encoded of ["\\U00110000", "\\UFFFFFFFF", "\\U0001", "\\u123", "\\x1", "\\u12xz"]) {
      for (const source of [`id: "${encoded}"`, `"${encoded}": value`, `tags: ["${encoded}"]`]) {
        expect(parseMarkdownDocument(Buffer.from(`---\n${source}\n---\n`))).toMatchObject({
          code: "MARKDOWN_YAML",
        });
      }
    }
    expect(parseMarkdownDocument(Buffer.from('---\nid: "\\U0010FFFF"\n---\n'))).toMatchObject({
      documentId: String.fromCodePoint(0x10ffff),
    });
  });

  it("rejects unsupported YAML instead of reinterpreting it as strings", () => {
    const cases = [
      "t: a: b\n", // mapping colon inside a plain scalar
      "t: value\n  continued\n", // multi-line plain scalar
      "\ttabbed: 1\n", // tab indentation
      't: "unterminated\n', // unclosed quote
      't: "bad \\q escape"\n', // unknown escape
      "- a\n", // root must be a mapping
    ];
    for (const yaml of cases) {
      const parsed = parseMarkdownDocument(Buffer.from(`---\n${yaml}---\nx\n`, "utf8"));
      expect("code" in parsed).toBe(true);
    }
  });

  it("rejects front matter deeper than the depth budget", () => {
    let yaml = "a:";
    for (let depth = 0; depth < 20; depth += 1) yaml += `\n${" ".repeat(depth + 1)}b${depth}:`;
    const parsed = parseMarkdownDocument(Buffer.from(`---\n${yaml}\n---\nx\n`, "utf8"));
    expect("code" in parsed).toBe(true);
    if ("code" in parsed) expect(parsed.code).toBe("MARKDOWN_YAML_DEPTH");
  });

  it("decodes UTF-8 byte-faithfully, preserving a leading byte order mark", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x", "utf8")]);
    expect(decodeUtf8Fatal(bom)).toBe("﻿x");
    expect(Buffer.from(decodeUtf8Fatal(bom), "utf8").equals(bom)).toBe(true);
    // A BOM in front of the opening delimiter means there is no front matter.
    const doc = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("---\nx: 1\n", "utf8"),
    ]);
    expect(splitFrontMatter(doc).yaml).toBeNull();
  });
});

describe("restricted YAML conformance", () => {
  it.each(conformance)("$name", (fixture) => {
    const parsed = parseMarkdownDocument(Buffer.from(`---\n${fixture.yaml}\n---\nbody\n`));
    if ("error" in fixture) {
      expect(parsed).toMatchObject({ code: fixture.error });
    } else {
      expect("code" in parsed).toBe(false);
      if (!("code" in parsed)) expect(parsed.frontMatter).toEqual(fixture.value);
    }
  });
});

describe("final frontMatter JSON byte limit", () => {
  it.each(["\t", '"', "\\", "é", "😊"])("checks the exact encoded boundary for %j", (character) => {
    // Single quotes preserve these source characters. All chosen values
    // expand to two or four JSON bytes and keep YAML source below its cap.
    const width = Buffer.byteLength(JSON.stringify(character)) - 2;
    const value = character.repeat((64 * 1024 - 8) / width);
    expect(Buffer.byteLength(JSON.stringify({ k: value }))).toBe(64 * 1024);
    for (const suffix of ["", "a"]) {
      const parsed = parseMarkdownDocument(Buffer.from(`---\nk: '${value}${suffix}'\n---\nbody\n`));
      if (suffix) expect(parsed).toMatchObject({ code: "MARKDOWN_FRONTMATTER_SIZE" });
      else {
        expect("code" in parsed).toBe(false);
        if (!("code" in parsed)) {
          expect(parsed.frontMatter).toEqual({ k: value });
          expect(frontMatterSchema.safeParse(parsed.frontMatter).success).toBe(true);
        }
      }
    }
  });

  it("includes all keys and structure in the final charge", () => {
    const map = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, "a"]));
    const padding = 64 * 1024 - Buffer.byteLength(JSON.stringify({ ...map, padding: "" }));
    const prefix = Object.entries(map)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    for (const extra of [0, 1]) {
      const parsed = parseMarkdownDocument(
        Buffer.from(`---\n${prefix}\npadding: '${"a".repeat(padding + extra)}'\n---\n`),
      );
      if (extra) expect(parsed).toMatchObject({ code: "MARKDOWN_FRONTMATTER_SIZE" });
      else {
        expect("code" in parsed).toBe(false);
        if (!("code" in parsed))
          expect(frontMatterSchema.safeParse(parsed.frontMatter).success).toBe(true);
      }
    }
  });
});

it("charges canonical JSON decimal number spelling at the exact byte boundary", () => {
  const entries = Array.from({ length: 3000 }, (_, i) => [`n${i}`, 1e-6] as const);
  const value = Object.fromEntries(entries);
  const padding = 64 * 1024 - Buffer.byteLength(JSON.stringify({ ...value, padding: "" }));
  const yaml = entries.map(([key]) => `${key}: 1e-6`).join("\n");
  for (const extra of [0, 1]) {
    const parsed = parseMarkdownDocument(
      Buffer.from(`---\n${yaml}\npadding: '${"a".repeat(padding + extra)}'\n---\n`),
    );
    if (extra) expect(parsed).toMatchObject({ code: "MARKDOWN_FRONTMATTER_SIZE" });
    else {
      expect("code" in parsed).toBe(false);
      if (!("code" in parsed)) {
        expect(Buffer.byteLength(JSON.stringify(parsed.frontMatter))).toBe(64 * 1024);
        expect(frontMatterSchema.safeParse(parsed.frontMatter).success).toBe(true);
      }
    }
  }
});
