import { describe, expect, it } from "vitest";

import { casefoldPathKey, normalizeKbPath, registerPath } from "./paths";

describe("normalizeKbPath", () => {
  it("rejects absolute, dotdot, and reserved Windows segments", () => {
    expect(normalizeKbPath("/abs").ok).toBe(false);
    expect(normalizeKbPath("a/../b").ok).toBe(false);
    expect(normalizeKbPath("con/report.md").ok).toBe(false);
  });

  it("detects case-fold collisions", () => {
    const seen = new Map();
    expect(registerPath(seen, "Docs/A.md", "file")).toBeNull();
    expect(registerPath(seen, "docs/a.md", "file")?.code).toBe("PATH_CASE_COLLISION");
    expect(casefoldPathKey("Docs/A.md")).toBe(casefoldPathKey("docs/a.md"));
  });

  it("rejects Git metadata names and filesystem aliases at every path depth", () => {
    for (const name of [
      ".git",
      ".GIT",
      "git~1",
      "GIT~1",
      ".git. ",
      "GIT~1...",
      ".git::$INDEX_ALLOCATION",
      "git~1:stream",
      ".g\u200cit",
      ".git\u206f",
    ]) {
      for (const path of [name, `${name}/hidden.md`, `docs/${name}/hidden.md`]) {
        expect(normalizeKbPath(path)).toMatchObject({
          ok: false,
          issue: { code: "PATH_GIT_RESERVED" },
        });
      }
    }
    for (const path of [".gitignore", ".git.md", "git~10/notes.md", "legit/readme.md"]) {
      expect(normalizeKbPath(path).ok).toBe(true);
    }
  });

  it("folds Cherokee case pairs to uppercase and keeps all Unicode fold results stable", () => {
    for (let cp = 0x13a0; cp <= 0x13f5; cp += 1) {
      const upper = String.fromCodePoint(cp);
      const lower = upper.toLowerCase();
      expect(casefoldPathKey(upper)).toBe(upper);
      expect(casefoldPathKey(lower)).toBe(upper);
    }
    // Exercise the public result across the Unicode space, including identity
    // mappings omitted by an expansion-only generator and runtime ICU changes.
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const folded = casefoldPathKey(String.fromCodePoint(cp));
      if (casefoldPathKey(folded) !== folded) {
        throw new Error(`non-idempotent case fold at U+${cp.toString(16)}`);
      }
    }
  });

  it("folds final sigma and capital sharp s onto the same key", () => {
    expect(casefoldPathKey("Σ.md")).toBe(casefoldPathKey("ς.md"));
    expect(casefoldPathKey("Straße.md")).toBe(casefoldPathKey("STRAẞE.md"));
    const seen = new Map();
    expect(registerPath(seen, "Σ.md", "file")).toBeNull();
    expect(registerPath(seen, "ς.md", "file")?.code).toBe("PATH_CASE_COLLISION");
    expect(registerPath(seen, "Straße.md", "file")).toBeNull();
    expect(registerPath(seen, "STRAẞE.md", "file")?.code).toBe("PATH_CASE_COLLISION");
  });

  it("implements full Unicode case folding, including Greek ypogegrammeni compositions", () => {
    // U+1F80 (precomposed with ypogegrammeni) full-casefolds to U+1F00 U+03B9,
    // which plain lowercasing never detects.
    expect(casefoldPathKey("ᾀ.md")).toBe(casefoldPathKey("ἀι.md"));
    const seen = new Map();
    expect(registerPath(seen, "ᾀ.md", "file")).toBeNull();
    expect(registerPath(seen, "ἀι.md", "file")?.code).toBe("PATH_CASE_COLLISION");
  });

  it("treats a file/dir clash at one path as a collision but allows repeated dir prefixes", () => {
    const seen = new Map();
    expect(registerPath(seen, "docs", "dir")).toBeNull();
    expect(registerPath(seen, "docs", "dir")).toBeNull(); // sibling-leaf prefix repeat
    expect(registerPath(seen, "docs", "file")?.code).toBe("PATH_CASE_COLLISION");
    const fileFirst = new Map();
    expect(registerPath(fileFirst, "x.md", "file")).toBeNull();
    expect(registerPath(fileFirst, "x.md", "dir")?.code).toBe("PATH_CASE_COLLISION");
    expect(registerPath(fileFirst, "x.md", "file")?.code).toBe("PATH_CASE_COLLISION");
  });

  it("rejects the byte order mark inside path segments", () => {
    const bom = normalizeKbPath("doc\uFEFFs/a.md");
    expect(bom.ok).toBe(false);
    if (!bom.ok) expect(bom.issue.code).toBe("PATH_BOM");
  });
});
