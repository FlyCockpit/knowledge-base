import { describe, expect, it } from "vitest";

import { cursorToken, entityId, longText, pathOnlyUrl, shortText } from "./schemas";

describe("pathOnlyUrl", () => {
  it("accepts same-origin paths", () => {
    expect(pathOnlyUrl.parse("/")).toBe("/");
    expect(pathOnlyUrl.parse("/dashboard")).toBe("/dashboard");
    expect(pathOnlyUrl.parse("/en-US/settings?tab=push")).toBe("/en-US/settings?tab=push");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(pathOnlyUrl.safeParse("https://evil.example/phish").success).toBe(false);
    expect(pathOnlyUrl.safeParse("http://evil.example").success).toBe(false);
    expect(pathOnlyUrl.safeParse("//evil.example/phish").success).toBe(false);
    expect(pathOnlyUrl.safeParse("dashboard").success).toBe(false);
  });

  it("rejects backslash and control-character smuggling", () => {
    // The WHATWG URL parser normalizes `\` to `/`, so `/\evil.example`
    // resolves to the protocol-relative `//evil.example`.
    expect(pathOnlyUrl.safeParse("/\\evil.example").success).toBe(false);
    expect(pathOnlyUrl.safeParse("/\\/evil.example").success).toBe(false);
    // Browsers strip C0 control chars (incl. tab/newline) before parsing, which
    // can turn `/\t/evil.example` into a protocol-relative URL.
    expect(pathOnlyUrl.safeParse("/\t/evil.example").success).toBe(false);
    expect(pathOnlyUrl.safeParse("/\n/evil.example").success).toBe(false);
  });
});

describe("bounded strings", () => {
  it("caps entityId / shortText / longText / cursorToken", () => {
    expect(entityId.safeParse("").success).toBe(false);
    expect(entityId.safeParse("a".repeat(65)).success).toBe(false);
    expect(shortText.safeParse("a".repeat(201)).success).toBe(false);
    expect(longText.safeParse("a".repeat(10_001)).success).toBe(false);
  });

  it("rejects blank text schemas and trims what they keep", () => {
    expect(shortText.safeParse("").success).toBe(false);
    expect(shortText.safeParse("   ").success).toBe(false);
    expect(longText.safeParse("").success).toBe(false);
    expect(longText.safeParse("\n\t ").success).toBe(false);
    expect(shortText.parse("  Title  ")).toBe("Title");
    expect(longText.parse("  Body  ")).toBe("Body");
    expect(cursorToken.safeParse("").success).toBe(false);
    expect(cursorToken.safeParse("   ").success).toBe(false);
    expect(cursorToken.safeParse("a".repeat(129)).success).toBe(false);
  });
});
