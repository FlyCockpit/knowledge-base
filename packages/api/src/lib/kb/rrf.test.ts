import { describe, expect, it } from "vitest";
import { comparePaths, fuseReciprocalRanks, normalizedRrfScore, RRF_K } from "./rrf";

const k = (path: string, chunkIndex = 0) => ({ path, chunkIndex });

describe("reciprocal rank fusion", () => {
  it("returns nothing for empty arms", () => {
    expect(fuseReciprocalRanks([[], []])).toEqual([]);
  });
  it("weights the first rank exactly 1/61 and sums both arms for the same chunk", () => {
    expect(RRF_K).toBe(60);
    const fused = fuseReciprocalRanks([
      [k("a.md"), k("b.md")],
      [k("b.md"), k("c.md")],
    ]);
    expect(fused).toEqual([
      { path: "b.md", chunkIndex: 0, score: 1 / 62 + 1 / 61 },
      { path: "a.md", chunkIndex: 0, score: 1 / 61 },
      { path: "c.md", chunkIndex: 0, score: 1 / 62 },
    ]);
  });
  it("deduplicates one chunk inside an arm without advancing its rank", () => {
    const fused = fuseReciprocalRanks([[k("a.md"), k("a.md"), k("b.md")]]);
    expect(fused).toEqual([
      { path: "a.md", chunkIndex: 0, score: 1 / 61 },
      { path: "b.md", chunkIndex: 0, score: 1 / 62 },
    ]);
  });
  it("breaks equal scores by bytewise path then chunk index, independent of arm order", () => {
    const one = fuseReciprocalRanks([[k("z.md", 1)], [k("é.md", 0)], [k("z.md", 0)]]);
    const two = fuseReciprocalRanks([[k("z.md", 0)], [k("z.md", 1)], [k("é.md", 0)]]);
    expect(one).toEqual(two);
    expect(one.map((h) => `${h.path}#${h.chunkIndex}`)).toEqual(["z.md#0", "z.md#1", "é.md#0"]);
    // Supplementary-plane path sorts after BMP in UTF-8 but before U+FFFD in UTF-16.
    expect(comparePaths("\u{1F600}.md", "�.md")).toBeGreaterThan(0);
  });
  it("keeps chunks of one path distinct", () => {
    expect(fuseReciprocalRanks([[k("a.md", 0), k("a.md", 1)]])).toHaveLength(2);
  });
});

describe("golden search fixture", () => {
  it("encodes a ranking that the fusion function reproduces exactly", async () => {
    const golden = (await import("./fixtures/search.json")).default;
    for (const { expected } of golden.queries) {
      const arm = (key: "vectorRank" | "ftsRank") =>
        expected
          .filter((row) => row[key] !== null)
          .sort((a, b) => Number(a[key]) - Number(b[key]))
          .map(({ path, chunkIndex }) => ({ path, chunkIndex }));
      const fused = fuseReciprocalRanks([arm("vectorRank"), arm("ftsRank")]);
      expect(fused.map(({ path }) => path)).toEqual(expected.map(({ path }) => path));
    }
  });
  it("normalizes the fused sum by its maximum for the arms that ran (L-25)", () => {
    expect(normalizedRrfScore(1 / 61, 1)).toBe(1);
    expect(normalizedRrfScore(1 / 61, 2)).toBe(0.5);
    expect(normalizedRrfScore(1 / 61 + 1 / 61, 2)).toBe(1);
    const fused = fuseReciprocalRanks([
      [k("a.md"), k("b.md")],
      [k("b.md"), k("c.md")],
    ]).map((hit) => normalizedRrfScore(hit.score, 2));
    expect(fused).toEqual([...fused].sort((a, b) => b - a));
    expect(fused.every((score) => score > 0 && score <= 1)).toBe(true);
  });
});
