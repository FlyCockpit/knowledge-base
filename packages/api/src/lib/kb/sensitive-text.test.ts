import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/sensitive-text.json" with { type: "json" };
import {
  containsKnownCredentialPatterns,
  knownCredentialRanges,
  redactSensitiveSubstrings,
} from "./sensitive-text";

const caseText = (parts: readonly string[]) => parts.join("");

describe("sensitive-text", () => {
  it("documents the detector as a conservative floor, not complete secret detection", () => {
    expect(containsKnownCredentialPatterns("routine prose without tokens")).toBe(false);
    expect(containsKnownCredentialPatterns("custom api_key=not-in-floor")).toBe(false);
  });

  it("matches known credential patterns", () => {
    expect(
      containsKnownCredentialPatterns("prefix sk-proj-abcdefghijklmnopqrstuvwxyz suffix"),
    ).toBe(true);
    expect(containsKnownCredentialPatterns("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(containsKnownCredentialPatterns("Authorization: Bearer super-secret-value")).toBe(true);
    expect(containsKnownCredentialPatterns("Bearer synthetic-review-token-0123456789")).toBe(true);
    expect(containsKnownCredentialPatterns("authorization=abcdefgh12345678")).toBe(true);
  });

  it("keeps English bearer phrases out of the floor", () => {
    expect(containsKnownCredentialPatterns("the bearer of bad news")).toBe(false);
    expect(containsKnownCredentialPatterns("Bearer authentication is required")).toBe(false);
  });

  it("redacts matched patterns from rejection messages", () => {
    const redacted = redactSensitiveSubstrings("leaked sk-proj-abcdefghijklmnopqrstuvwxyz here");
    expect(redacted).not.toContain("sk-proj");
    expect(redacted).toContain("[redacted]");
  });

  it("redaction consumes the complete bearer token, header prefix included", () => {
    const header = redactSensitiveSubstrings(
      "Authorization: Bearer synthetic-review-token-0123456789",
    );
    expect(header).not.toContain("synthetic-review-token");
    expect(header).not.toContain("Bearer");
    const bare = redactSensitiveSubstrings("token Bearer abcdefgh-1234 tail");
    expect(bare).not.toContain("abcdefgh-1234");
    expect(bare).toContain("tail");
  });

  // The same fixture drives the CLI port (`kb-local/src/sensitive_text.rs`).
  describe("shared provider token fixtures", () => {
    it.each(fixtures.positive)("flags and fully redacts $name", ({ parts, redacted }) => {
      const text = caseText(parts);
      expect(containsKnownCredentialPatterns(text)).toBe(true);
      expect(knownCredentialRanges(text).length).toBeGreaterThan(0);
      expect(redactSensitiveSubstrings(text)).toBe(redacted);
    });

    it.each(fixtures.negative)("leaves $name alone", ({ parts }) => {
      const text = caseText(parts);
      expect(containsKnownCredentialPatterns(text)).toBe(false);
      expect(redactSensitiveSubstrings(text)).toBe(text);
    });
  });

  // Adversarial repeated prefixes, shared with the CLI port: every regex must
  // stay linear (no catastrophic backtracking) on about 1 MiB of each.
  it.each(fixtures.repeatedPrefixes)("stays linear on repeated $name", ({ unit }) => {
    const piece = unit.join("");
    const text = piece.repeat(Math.ceil((1 << 20) / piece.length));
    const started = performance.now();
    containsKnownCredentialPatterns(text);
    knownCredentialRanges(text);
    redactSensitiveSubstrings(text);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
