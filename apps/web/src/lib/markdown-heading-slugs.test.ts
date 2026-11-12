import { describe, expect, it } from "vitest";
import { createHeadingSlugger } from "./markdown-heading-slugs";

describe("Markdown heading slugs", () => {
  it("retains Unicode letters, accents, underscores and hyphens", () => {
    const slug = createHeadingSlugger();
    expect(slug("Café: Guía / 中文! _ok-test_")).toBe("café-guía--中文-_ok-test_");
    expect(slug("Hello, world! (v2) 🚀")).toBe("hello-world-v2-");
  });
  it("uses -1/-2 suffixes and avoids collisions with literal suffixed headings", () => {
    const slug = createHeadingSlugger();
    expect(["Setup", "Setup", "Setup-1", "Setup", "Setup-1"].map(slug)).toEqual([
      "setup",
      "setup-1",
      "setup-1-1",
      "setup-2",
      "setup-1-2",
    ]);
  });
  it("suffixes headings that collide with shell IDs", () => {
    const slug = createHeadingSlugger();
    expect(
      ["Main content", "App main", "Root", "Main content", "Main content-1"].map(slug),
    ).toEqual(["main-content-1", "app-main-1", "root-1", "main-content-2", "main-content-1-1"]);
  });
  it("scopes duplicates to one document, including empty slugs", () => {
    const slug = createHeadingSlugger();
    expect([slug("!!!"), slug("???")]).toEqual(["", "-1"]);
    expect(createHeadingSlugger()("Setup")).toBe("setup");
  });
});
