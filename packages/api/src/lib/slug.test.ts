import { describe, expect, it } from "vitest";

import { slugify, uniqueSlug } from "./slug.js";

describe("slugify", () => {
  it("produces a readable slug from a title", () => {
    expect(slugify("How We Cut Load Times")).toBe("how-we-cut-load-times");
  });

  it("folds diacritics instead of dropping the characters", () => {
    expect(slugify("Café Culture in Zürich")).toBe("cafe-culture-in-zurich");
  });

  it("collapses punctuation and whitespace runs into single dashes", () => {
    expect(slugify("  Hello --- World!!  ")).toBe("hello-world");
    expect(slugify("A/B testing: what's next?")).toBe("a-b-testing-what-s-next");
  });

  it("never leaves a leading or trailing dash, even after truncation", () => {
    const slug = slugify(`${"a".repeat(118)} bbbb`);
    expect(slug.length).toBeLessThanOrEqual(120);
    expect(slug.startsWith("-")).toBe(false);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty string when nothing usable remains", () => {
    // Callers must handle this; uniqueSlug is where the fallback lives.
    expect(slugify("🎉🎉🎉")).toBe("");
  });

  it("matches the required slug shape", () => {
    const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    for (const title of ["Hello World", "Café", "A/B testing", "  spaced  out  "]) {
      expect(slugify(title)).toMatch(pattern);
    }
  });
});

describe("uniqueSlug", () => {
  it("returns the base when it is free", async () => {
    expect(await uniqueSlug("welcome", async () => false)).toBe("welcome");
  });

  it("appends an incrementing suffix on collision", async () => {
    // Two posts titled "Welcome" is not an edge case — without this the second
    // create fails on the unique constraint.
    const taken = new Set(["welcome", "welcome-2"]);
    expect(await uniqueSlug("welcome", async (c) => taken.has(c))).toBe("welcome-3");
  });

  it("falls back when the title yields no usable characters", async () => {
    expect(await uniqueSlug(slugify("🎉🎉🎉"), async () => false)).toBe("untitled");
    expect(await uniqueSlug("", async () => false, "post")).toBe("post");
  });

  it("keeps the suffixed slug within the length limit", async () => {
    const long = "a".repeat(120);
    const result = await uniqueSlug(long, async (c) => c === long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith("-2")).toBe(true);
  });

  it("terminates with a random suffix when every numbered candidate is taken", async () => {
    // Guards against spinning forever on a pathological `exists`.
    const result = await uniqueSlug("popular", async (c) => /^popular(-\d+)?$/.test(c));
    expect(result).toMatch(/^popular-[a-z0-9]+$/);
    expect(result).not.toMatch(/^popular-\d+$/);
  });
});
