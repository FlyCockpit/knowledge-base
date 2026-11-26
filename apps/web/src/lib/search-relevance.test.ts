import { describe, expect, it } from "vitest";

import {
  assessRelevance,
  highlightSnippet,
  highlightTerms,
  partitionByFloor,
  RELEVANCE_THRESHOLDS,
  thresholdsFor,
} from "./search-relevance";

const rel = (semantic: number | null, keyword = false) => ({
  semantic,
  semanticRank: semantic === null ? null : 1,
  keyword,
  keywordRank: keyword ? 1 : null,
});
const GEMMA = "embeddinggemma-2-q8_0";
const QWEN = "qwen3-embedding-0.6b-q8_0";

describe("relevance bands", () => {
  it("keeps every table ordered: floor <= related <= strong", () => {
    for (const row of Object.values(RELEVANCE_THRESHOLDS)) {
      expect(row.floor).toBeLessThanOrEqual(row.related);
      expect(row.related).toBeLessThanOrEqual(row.strong);
    }
  });

  it("maps cosine similarity per model at the band edges", () => {
    const g = RELEVANCE_THRESHOLDS[GEMMA]!;
    expect(assessRelevance(rel(g.strong), GEMMA)).toEqual({
      band: "strong",
      passes: true,
      level: 3,
    });
    expect(assessRelevance(rel(g.strong - 0.001), GEMMA).band).toBe("related");
    expect(assessRelevance(rel(g.related), GEMMA).band).toBe("related");
    expect(assessRelevance(rel(g.related - 0.001), GEMMA)).toMatchObject({
      band: "weak",
      passes: true,
      level: 1,
    });
    expect(assessRelevance(rel(g.floor - 0.001), GEMMA)).toMatchObject({
      band: "weak",
      passes: false,
    });
    // The same cosine means different things under different models.
    // (measured: an unrelated pair is ~0.14 on Qwen but ~0.55 on Gemma).
    expect(assessRelevance(rel(0.6), QWEN).band).toBe("strong");
    expect(assessRelevance(rel(0.6), GEMMA)).toMatchObject({ band: "weak", passes: false });
  });

  it("falls back to the conservative external table for unknown calibrations", () => {
    expect(thresholdsFor("some-model")).toBe(RELEVANCE_THRESHOLDS.external);
    expect(thresholdsFor(undefined)).toBe(RELEVANCE_THRESHOLDS.external);
    expect(thresholdsFor("__proto__")).toBe(RELEVANCE_THRESHOLDS.external);
  });

  it("lets a keyword match lift a hit and pass the floor", () => {
    expect(assessRelevance(rel(0.1, true), GEMMA)).toMatchObject({
      band: "related",
      passes: true,
    });
    expect(assessRelevance(rel(null, true), GEMMA)).toMatchObject({
      band: "related",
      passes: true,
    });
    expect(assessRelevance(rel(RELEVANCE_THRESHOLDS[GEMMA]!.related, true), GEMMA).band).toBe(
      "strong",
    );
    // Without a keyword match and without a semantic score there is nothing to show it for.
    expect(assessRelevance(rel(null), GEMMA)).toMatchObject({ band: "weak", passes: false });
  });

  it("says only 'keyword match' for a keyword-only search", () => {
    expect(assessRelevance(rel(null, true), "lexical")).toEqual({
      band: "keyword",
      passes: true,
      level: 2,
    });
  });
});

describe("relevance floor", () => {
  it("collapses hits below the floor, keeping the server's order in each group", () => {
    const hits = [
      { id: "a", relevance: rel(0.7) },
      { id: "b", relevance: rel(0.1) },
      { id: "c", relevance: rel(0.2, true) },
      { id: "d", relevance: rel(0.05) },
    ];
    const { shown, weaker } = partitionByFloor(hits, GEMMA);
    expect(shown.map((h) => h.id)).toEqual(["a", "c"]);
    expect(weaker.map((h) => h.id)).toEqual(["b", "d"]);
  });

  it("reports no close match when nothing passes", () => {
    const { shown, weaker } = partitionByFloor(
      [{ relevance: rel(0.1) }, { relevance: rel(0.12) }],
      QWEN,
    );
    expect(shown).toHaveLength(0);
    expect(weaker).toHaveLength(2);
  });

  it("shows every hit that carries no relevance (structured search)", () => {
    expect(partitionByFloor([{}, {}], GEMMA).shown).toHaveLength(2);
  });
});

describe("snippet highlighting", () => {
  it("picks the query's words without stopwords, longest first", () => {
    expect(highlightTerms("Flour and gluten")).toEqual(["gluten", "flour"]);
    expect(highlightTerms("the a of")).toEqual([]);
    expect(highlightTerms("harina y gluten")).toEqual(["harina", "gluten"]);
  });

  it("marks word-start matches case-insensitively and keeps every character", () => {
    const parts = highlightSnippet("Flours vary; cauliflour has no GLUTEN.", ["flour", "gluten"]);
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["Flour", "GLUTEN"]);
    expect(parts.map((p) => p.text).join("")).toBe("Flours vary; cauliflour has no GLUTEN.");
  });

  it("treats terms as text, never as a pattern", () => {
    const parts = highlightSnippet("a.b and axb", ["a.b"]);
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(["a.b"]);
  });

  it("returns the snippet whole without terms", () => {
    expect(highlightSnippet("plain", [])).toEqual([{ text: "plain", match: false }]);
  });
});
