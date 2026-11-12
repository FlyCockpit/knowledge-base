import { describe, expect, it } from "vitest";
import { chunkBody, fitChunksToContext } from "./chunk";
import numbers from "./fixtures/structured-numbers.json";
import { parseMarkdownDocument } from "./parse-markdown";
import {
  extractStructuredDocument,
  extractTableRows,
  matchStructuredDocument,
  STRUCTURED_LIMITS,
  structuredRowsForChunks,
} from "./structured";

const timestamp = "2026-09-24T12:00:00.000000002Z";
function document(markdown: string) {
  const parsed = parseMarkdownDocument(Buffer.from(markdown));
  if (!("body" in parsed)) throw new Error(parsed.code);
  return extractStructuredDocument(parsed, timestamp);
}
describe("structured Markdown extraction", () => {
  it.each(numbers.cases)(
    "preserves JavaScript numeric cells and exact filters: $cell",
    (fixture) => {
      const doc = document(`n|other\n-|-----\n${fixture.cell}|ok`);
      const value = doc.rows[0]!.values.n;
      expect(value).toBe(fixture.value);
      if (fixture.bits !== null) {
        const bytes = Buffer.alloc(8);
        bytes.writeDoubleBE(value as number);
        expect(bytes.toString("hex")).toBe(fixture.bits);
        for (const raw of [fixture.cell, JSON.stringify(fixture.value)]) {
          const equals = JSON.parse(raw);
          expect(
            matchStructuredDocument(doc, { structured: [{ column: "n", equals }] }),
          ).toHaveLength(1);
        }
        expect(
          matchStructuredDocument(doc, { structured: [{ column: "n", equals: fixture.cell }] }),
        ).toEqual([]);
        const wrong = (value as number) + 1;
        if (Number.isFinite(wrong) && wrong !== value)
          expect(
            matchStructuredDocument(doc, { structured: [{ column: "n", equals: wrong }] }),
          ).toEqual([]);
      }
    },
  );
  it("handles empty/default documents and requires a row for row predicates", () => {
    const value = document("");
    expect(value).toEqual({
      type: null,
      title: null,
      titleFolded: null,
      tags: [],
      timestamp,
      rows: [],
    });
    expect(matchStructuredDocument(value, { timestamp: { after: timestamp } })).toEqual([null]);
    expect(matchStructuredDocument(value, { structured: [{ column: "x", equals: null }] })).toEqual(
      [],
    );
  });
  it("types only JSON scalars and preserves exact CRLF/multibyte row spans", () => {
    const body =
      '猫\r\n\r\n| name | n | yes | nothing | object | code |\r\n|---|---:|:---|:---:|---|---|\r\n| café | 1.25 | true | null | {"x":1} | a\\|b |\r\n| "quoted" | 1e30 | false | "null" | [1] | `c\\|d` |\r\n';
    const rows = extractTableRows(body);
    expect(rows.map((row) => row.values)).toEqual([
      { name: "café", n: 1.25, yes: true, nothing: null, object: '{"x":1}', code: "a|b" },
      { name: "quoted", n: 1e30, yes: false, nothing: "null", object: "[1]", code: "`c|d`" },
    ]);
    expect(rows.map((row) => row.rowIndex)).toEqual([0, 1]);
    for (const row of rows) {
      const source = Buffer.from(body).subarray(row.span.startByte, row.span.endByte).toString();
      expect(source).toBe(body.split("\r\n")[row.rowIndex + 4]);
      expect(
        body
          .match(/[^\p{White_Space}]+/gu)
          ?.slice(row.span.startToken, row.span.endToken)
          .join(" "),
      ).toBe(source.split(/\p{White_Space}+/u).join(" "));
    }
  });
  it("ANDs all conditions on one row with typed equality and own-property columns", () => {
    const value = document("a | b | __proto__\n-|-|-\n1 | false | ok\n2 | true | other\n");
    const conditions = [
      { column: "a", equals: 1 },
      { column: "b", equals: true },
    ];
    expect(matchStructuredDocument(value, { structured: conditions })).toEqual([]);
    expect(matchStructuredDocument(value, { structured: [{ column: "a", equals: "1" }] })).toEqual(
      [],
    );
    expect(
      matchStructuredDocument(value, { structured: [{ column: "toString", equals: null }] }),
    ).toEqual([]);
    expect(
      matchStructuredDocument(value, {
        structured: [
          { column: "a", equals: 2 },
          { column: "b", equals: true },
        ],
      }),
    ).toEqual([value.rows[1]]);
    expect(
      matchStructuredDocument(value, { structured: [{ column: "__proto__", equals: "ok" }] }),
    ).toEqual([value.rows[0]]);
  });
  it("preserves Unicode cell whitespace and ends tables at pipe-free lines", () => {
    expect(
      extractTableRows("a|b\n-|-\n\u00a0true\u00a0|false\nplain\n# heading\nignored").map(
        (row) => row.values,
      ),
    ).toEqual([{ a: "\u00a0true\u00a0", b: false }]);
    expect(
      extractTableRows("a|b\n-|-\nx|y\nThis is prose, not a row.\nMore prose here.\n").map(
        (row) => row.values,
      ),
    ).toEqual([{ a: "x", b: "y" }]);
    expect(extractTableRows("a|b\n-|-\nx|y\n---\n").map((row) => row.values)).toEqual([
      { a: "x", b: "y" },
    ]);
  });
  it("splits GFM cells on unescaped pipes after even backslash runs", () => {
    expect(extractTableRows("a|b\n-|-\na\\\\|b\n").map((row) => row.values)).toEqual([
      { a: "a\\", b: "b" },
    ]);
  });
  it("normalizes metadata, casefolds titles and uses exact normalized tags/type", () => {
    const value = document(
      '---\ntype: " Report "\ntitle: "Straße Σ ᾀ"\ntags: [" café ", "café", "Work", 1]\nvalid_from: "2026-01-01T00:00:00Z"\n---\nbody',
    );
    expect(value.tags).toEqual(["café", "Work"]);
    expect(value.timestamp).toBe("2026-01-01T00:00:00Z");
    for (const title of ["STRASSE", "ς", "ἀι"])
      expect(matchStructuredDocument(value, { title, type: "Report", tags: ["café"] })).toEqual([
        null,
      ]);
    expect(matchStructuredDocument(value, { type: "report" })).toEqual([]);
    expect(matchStructuredDocument(value, { tags: ["work"] })).toEqual([]);
  });
  it("uses inclusive after/exclusive before, nanoseconds, and rejects invalid/inverted ranges", () => {
    const value = document("body");
    expect(matchStructuredDocument(value, { timestamp: { after: timestamp } })).toEqual([null]);
    expect(matchStructuredDocument(value, { timestamp: { before: timestamp } })).toEqual([]);
    expect(
      matchStructuredDocument(value, { timestamp: { before: "2026-09-24T12:00:00.000000003Z" } }),
    ).toEqual([null]);
    for (const range of [
      { after: timestamp, before: timestamp },
      { after: "2027-01-01T00:00:00Z", before: timestamp },
      { after: "bad" },
    ])
      expect(() => matchStructuredDocument(value, { timestamp: range })).toThrowError(
        "Invalid structured",
      );
    expect(() => document("---\nvalid_from: bad\n---\nbody")).toThrowError("Invalid structured");
  });
  it("ignores code, supports optional outer pipes, pads short rows and ignores extra cells", () => {
    const body =
      "```md\na|b\n-|-\nx|y\n```` trailing does not close\na|b\n-|-\nx|y\n```\n\na|b\n-|-\nx|\ny|z|extra\n\n    a|b\n    -|-\n    x|y\n";
    expect(extractTableRows(body).map((row) => row.values)).toEqual([
      { a: "x", b: "" },
      { a: "y", b: "z" },
    ]);
  });
  it("enforces row, header and cell bounds without partial results or truncation", () => {
    expect(extractTableRows(`a|b\n-|-\n${"x|y\n".repeat(STRUCTURED_LIMITS.rows)}`)).toHaveLength(
      STRUCTURED_LIMITS.rows,
    );
    for (const body of [
      `a|b\n-|-\n${"x|y\n".repeat(STRUCTURED_LIMITS.rows + 1)}`,
      `a|b\n-|-\n${"😀".repeat(1025)}|y`,
      `${"a".repeat(257)}|b\n-|-\nx|y`,
      "a|a\n-|-\nx|y",
      `${Array.from({ length: 65 }, (_, i) => `h${i}`).join("|")}\n${Array(65).fill("-").join("|")}`,
    ])
      expect(() => extractTableRows(body)).toThrowError("Invalid structured");
    expect(extractTableRows(`a|b\n-|-\n${JSON.stringify("😀".repeat(1024))}|y`)[0]?.values.a).toBe(
      "😀".repeat(1024),
    );
  });
});

describe("structured row windows", () => {
  it("stores one full row and small immutable references for every context piece", async () => {
    const body = `| name | detail |\n| --- | --- |\n| target | ${"x ".repeat(512).trim()} |\n`;
    const rows = extractTableRows(body);
    const fitted = await fitChunksToContext(body, chunkBody(body), async (texts) => ({
      counts: texts.map((text) => [...text].length),
      limit: 128,
    }));
    const stored = structuredRowsForChunks(Buffer.from(body), rows, fitted.chunks);
    const entries = [...stored.values()].flat();
    const full = entries.filter((entry) => "values" in entry);
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ values: rows[0]!.values, citation: rows[0]!.span });
    const anchor = [...stored.entries()].find(([, entries]) =>
      entries.some((entry) => "values" in entry),
    )![0];
    for (const ref of entries.filter((entry) => !("values" in entry)))
      expect(ref).toEqual({ rowIndex: 0, chunkIndex: anchor });
    expect(fitted.chunks.every((chunk) => [...chunk.text].length <= 128)).toBe(true);
    expect(entries.length).toBeGreaterThan(1);
  });
  it("withholds a credential-bearing full row even when split pieces would be safe", () => {
    const body = `| name | detail |\n| --- | --- |\n| target | sk-${"a".repeat(40)} |\n`;
    const rows = extractTableRows(body);
    const safePartial = {
      chunkIndex: 7,
      span: { ...rows[0]!.span, endByte: rows[0]!.span.startByte + 8 },
      text: "target",
      snippet: "target",
    };
    expect(structuredRowsForChunks(Buffer.from(body), rows, [safePartial]).size).toBe(0);
  });
});
