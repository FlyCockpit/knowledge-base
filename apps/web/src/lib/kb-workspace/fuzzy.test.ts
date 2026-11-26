import { describe, expect, it } from "vitest";

import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

const text = (target: string, ranges: [number, number][]) =>
  ranges.map(([a, b]) => target.slice(a, b)).join("|");

describe("quick-open fuzzy match", () => {
  it("matches a case-insensitive subsequence and reports its ranges", () => {
    const match = fuzzyMatch("RdMe", "docs/readme.md");
    expect(match).not.toBeNull();
    expect(text("docs/readme.md", match!.ranges)).toBe("r|dme");
    expect(fuzzyMatch("xyz", "docs/readme.md")).toBeNull();
    expect(fuzzyMatch("  ", "a.md")).toEqual({ score: 0, ranges: [] });
  });

  it("prefers the file name over folders, and word starts", () => {
    const ranked = fuzzyFilter("guide", ["guide/intro.md", "docs/user-guide.md", "g/u/i/d/e.md"]);
    expect(ranked.map((r) => r.path)).toEqual([
      "docs/user-guide.md",
      "guide/intro.md",
      "g/u/i/d/e.md",
    ]);
    const word = fuzzyMatch("sg", "setup-guide.md");
    expect(text("setup-guide.md", word!.ranges)).toBe("s|g");
  });

  it("ranks consecutive runs and shorter paths first among equals", () => {
    const ranked = fuzzyFilter("api", ["a/p/i.md", "api.md", "deep/folder/api.md"]);
    expect(ranked[0]!.path).toBe("api.md");
    expect(ranked[1]!.path).toBe("deep/folder/api.md");
  });

  it("keeps the order for an empty query and honours the limit", () => {
    expect(fuzzyFilter("", ["b.md", "a.md"], 1)).toEqual([{ path: "b.md", score: 0, ranges: [] }]);
  });

  it("filters 10k paths fast", () => {
    const paths = Array.from(
      { length: 10_000 },
      (_, i) => `area-${i % 40}/topic-${i % 300}/notes-${i}.md`,
    );
    fuzzyFilter("warm", paths);
    const start = performance.now();
    const out = fuzzyFilter("tpc12nts", paths);
    const took = performance.now() - start;
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(50);
    // ~50 ms on a quiet machine. The bound only catches a pathological
    // (super-linear) regression; it must hold on a heavily loaded runner too.
    expect(took).toBeLessThan(2000);
  });
});
