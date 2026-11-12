import { describe, expect, it, vi } from "vitest";
import { citationSnippet } from "./chunk";
import corpus from "./fixtures/plain-snippet.json" with { type: "json" };
import * as formatter from "./plain-snippet";
import { plainSnippet } from "./plain-snippet";

describe("plainSnippet (R2-27, CLI twin plain_snippet.rs)", () => {
  it("reduces every shared corpus case exactly", () => {
    expect(corpus.cases.length).toBeGreaterThan(300);
    for (const { input, plain } of corpus.cases) expect(plainSnippet(input), input).toBe(plain);
  });
  it("formats with source context before clipping, preserving code literals", () => {
    for (const { input, plain } of corpus.clippedCases)
      expect(citationSnippet(input), input).toBe(plain);
  });
  it.each(corpus.stressCases)("formats the complete near-limit input: $name", (fixture) => {
    const input = fixture.head + fixture.unit.repeat(fixture.repeat) + fixture.tail;
    const expected =
      fixture.plainHead + fixture.plainUnit.repeat(fixture.repeat) + fixture.plainTail;
    const plain = plainSnippet(input);
    expect(plain === expected, fixture.name).toBe(true);
    expect(citationSnippet(input)).toBe(fixture.snippet);
  });
  it.each(corpus.stressCases)("keeps citation source work bounded: $name", (fixture) => {
    const limit = corpus.maxCitationSourceScalars;
    const nearLimit = Math.floor(limit / [...fixture.unit].length) + 1;
    for (const count of [nearLimit, fixture.repeat]) {
      const input = fixture.head + fixture.unit.repeat(count) + fixture.tail;
      let visited = 0;
      const iterate = String.prototype[Symbol.iterator];
      const format = vi.spyOn(formatter, "plainSnippet");
      const iterator = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (
        this: string,
      ) {
        const iterator = iterate.call(this);
        if (String(this) === input) {
          const next = iterator.next.bind(iterator);
          iterator.next = () => {
            visited++;
            return next();
          };
        }
        return iterator;
      });
      let snippet: string;
      let window: string | undefined;
      try {
        snippet = citationSnippet(input);
        window = format.mock.calls[0]?.[0];
      } finally {
        iterator.mockRestore();
        format.mockRestore();
      }
      expect(snippet).toBe(fixture.snippet);
      // One lookahead next() is permitted by for..of. Traversing or formatting
      // the complete document would grow this work from 1,264 to ~2M scalars.
      expect(visited).toBeLessThanOrEqual(limit + 1);
      expect(window).toBeDefined();
      expect([...window!]).toHaveLength(limit);
    }
  });
});
