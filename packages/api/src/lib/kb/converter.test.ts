import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type ConversionInput, convertMarkdownSource, convertSource } from "./converter";
import { documentSchema } from "./protocol/common";

const sha = "a".repeat(40);
const asset = {
  path: "images/a b.png",
  hash: `sha256:${"b".repeat(64)}`,
  size: 12,
  mime: "image/png",
};
function input(markdown = ""): ConversionInput {
  return {
    mediaType: "text/markdown",
    bytes: Buffer.from(markdown),
    path: "docs/note.md",
    commitSha: sha,
    commitTimestamp: "2026-09-24T00:00:00Z",
    manifest: {
      commitSha: sha,
      entries: [asset, { ...asset, path: "images/a%20b.png" }, { ...asset, path: "unused.png" }],
    },
  };
}
describe("Markdown converter seam", () => {
  it("returns an EMPTY source with no chunks or synthetic vector", () => {
    const value = convertSource(input());
    expect(value.state).toBe("EMPTY");
    expect(value.originalWindowCount).toBe(0);
    expect(value.chunks).toEqual([]);
    expect(value.source.documentCitations).toEqual([]);
  });
  it("preserves source/hash/blob identity and explicit citations at the manifest's pinned SHA", () => {
    const args = input(
      '---\nid: doc-1\ntitle: "metadata [fake](../unused.png)"\ncitations:\n  - label: episode\n    target: "cockpit:episode/42"\n---\n猫 ![image](../images/a%20b.png) [inline](https://example.com)\n',
    );
    const value = convertSource(args);
    expect(value.source.markdown).toBe(args.bytes.toString());
    expect(value.source.commitSha).toBe(sha);
    expect(value.source.contentHash).toBe(
      `sha256:${createHash("sha256").update(args.bytes).digest("hex")}`,
    );
    expect(value.source.blobSha).toBe(
      createHash("sha1")
        .update(Buffer.concat([Buffer.from(`blob ${args.bytes.length}\0`), args.bytes]))
        .digest("hex"),
    );
    expect(value.source.documentCitations).toEqual([
      { label: "episode", target: "cockpit:episode/42" },
    ]);
    expect(value.source.assetRefs).toEqual([asset]);
    expect(value.chunks[0]?.text).not.toContain("metadata");
    const { body: _body, ...wire } = value.source;
    expect(documentSchema.safeParse(wire).success).toBe(true);
    expect(() =>
      convertSource({ ...args, manifest: { ...args.manifest, commitSha: "c".repeat(40) } }),
    ).toThrowError("Invalid source snapshot");
    const next = convertSource({
      ...args,
      commitSha: "c".repeat(40),
      manifest: { commitSha: "c".repeat(40), entries: [] },
    });
    expect(next.source.assetRefs).toEqual([]);
    expect(value.source.assetRefs).toEqual([asset]);
  });
  it.each(["../images/a&#32;b.png", "../images/a%20b.png", "../images/a&NewLine;b.png"])(
    "matches decoded destinations before manifest filtering: %s",
    (destination) => {
      const args = input(`![image](${destination})`);
      const value = convertSource(args);
      expect(value.source.assetRefs).toEqual(destination.includes("NewLine") ? [] : [asset]);
      expect(
        convertSource({ ...args, manifest: { commitSha: sha, entries: [] } }).source.assetRefs,
      ).toEqual([]);
    },
  );
  it.each(["plain text", "`![code](../images/a%20b.png)`", "[external](https://example.com)"])(
    "does not scan the manifest when no asset paths are referenced: %s",
    (markdown) => {
      const args = input(markdown);
      const filter = vi.spyOn(args.manifest.entries, "filter");
      try {
        expect(convertSource(args).source.assetRefs).toEqual([]);
        expect(filter).not.toHaveBeenCalled();
      } finally {
        filter.mockRestore();
      }
    },
  );
  it("preserves manifest order, duplicate entries and cloned asset references", () => {
    const args = input("![unused](../unused.png) ![image](../images/a%20b.png)");
    const duplicate = { ...asset, size: 99 };
    args.manifest.entries = [asset, { ...asset, path: "unused.png" }, duplicate];
    const refs = convertSource(args).source.assetRefs;
    expect(refs).toEqual(args.manifest.entries);
    for (const [i, ref] of refs.entries()) expect(ref).not.toBe(args.manifest.entries[i]);
    expect(refs[0]).not.toBe(refs[2]);
  });
  it("does not embed credential-bearing frontmatter or return canaries in failures", () => {
    const canary = "sk-fixture-canary-0123456789";
    expect(convertSource(input(`---\nprivate: ${canary}\n---\nsafe`)).chunks[0]?.text).toBe("safe");
    const rejected = convertSource(input(canary));
    expect(rejected).toMatchObject({
      state: "SKIPPED_REDACTED",
      originalWindowCount: 1,
      chunks: [],
    });
    try {
      convertSource(input(`---\ncitations: ${canary}\n---\nbody`));
      throw new Error("must reject");
    } catch (error) {
      expect(String(error)).not.toContain(canary);
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });
  it.each([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png",
  ])("rejects %s internally and maps to the fixed protocol error", (mediaType) => {
    expect(() => convertSource({ ...input(), mediaType })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_MEDIA" }),
    );
    try {
      convertMarkdownSource({ ...input(), mediaType });
      throw new Error("must reject");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });
  it("uses scalar citation limits consistently with the protocol", () => {
    const make = (n: number) =>
      input(
        `---\ncitations:\n  - label: "${"😀".repeat(n)}"\n    target: "${"猫".repeat(2048)}"\n---\nbody`,
      );
    const { body: _body, ...wire } = convertSource(make(240)).source;
    expect(documentSchema.safeParse(wire).success).toBe(true);
    expect(() => convertSource(make(241))).toThrowError("Invalid Markdown");
    expect(() =>
      convertSource(input('---\ncitations:\n  - label: "\\uD800"\n    target: target\n---\nbody')),
    ).toThrowError("Invalid Markdown");
  });
});
