import { describe, expect, it } from "vitest";
import { citationSnippet } from "./chunk";
import { type CitationSourceRow, projectCitationHit } from "./citation";

const row: CitationSourceRow = {
  kbId: "k".repeat(24),
  generationId: "g".repeat(24),
  path: "notes/ünïcode.md",
  chunkIndex: 2,
  documentId: "doc-1",
  commitSha: "a".repeat(40),
  blobSha: "b".repeat(40),
  contentHash: `sha256:${"c".repeat(64)}`,
  startToken: 640,
  endToken: 1040,
  startByte: 10,
  endByte: 99,
  snippet: citationSnippet("😀 ".repeat(300).trim()),
  documentCitations: [{ label: "x", target: "javascript:alert(1)" }],
  assetRefs: [
    { path: ".assets/a.png", hash: `sha256:${"d".repeat(64)}`, size: 3, mime: "image/png" },
  ],
};
const context = {
  knowledgeBaseName: "Fixture",
  generationId: row.generationId,
  commitSha: row.commitSha,
  freshness: "stale" as const,
  score: 1 / 61,
};

describe("citation projection", () => {
  it("projects the stored span, hashes and metadata without reinterpretation", () => {
    const hit = projectCitationHit(row, context);
    expect(hit).toMatchObject({
      knowledgeBaseId: row.kbId,
      chunkIndex: 2,
      span: { startToken: 640, endToken: 1040, startByte: 10, endByte: 99 },
      mode: "hybrid",
      matchedRow: null,
      freshness: "stale",
      score: 1 / 61,
      indexGenerationId: row.generationId,
      blobSha: row.blobSha,
      contentHash: row.contentHash,
    });
    // Unsafe schemes stay inert metadata for the renderer to refuse, never rewritten here.
    expect(hit.documentCitations).toEqual([{ label: "x", target: "javascript:alert(1)" }]);
    expect(hit.assetRefs).toEqual(row.assetRefs);
    expect([...hit.snippet]).toHaveLength(240);
    expect(hit.snippet.endsWith("…")).toBe(true);
  });
  it("R2-27: preserves a plain snippet formatted before clipping, on every transport", () => {
    expect(
      projectCitationHit(
        {
          ...row,
          snippet: citationSnippet("## Filter Replace the **MERV 11** [filter](x.md) `monthly`"),
        },
        context,
      ).snippet,
    ).toBe("Filter Replace the MERV 11 filter monthly");
  });

  it("does not reinterpret literal code contents as Markdown", () => {
    const snippet = citationSnippet("Use `*literal*` and `*.md`.");
    expect(projectCitationHit({ ...row, snippet }, context).snippet).toBe(
      "Use *literal* and *.md.",
    );
  });
  it("passes a stored snippet through, bounded", () => {
    expect(projectCitationHit({ ...row, snippet: "short snippet" }, context).snippet).toBe(
      "short snippet",
    );
  });
  it("rejects rows from another generation or commit and non-finite scores", () => {
    expect(() => projectCitationHit({ ...row, generationId: "h".repeat(24) }, context)).toThrow();
    expect(() => projectCitationHit({ ...row, commitSha: "e".repeat(40) }, context)).toThrow();
    expect(() => projectCitationHit(row, { ...context, score: Number.NaN })).toThrow();
  });
  it("rejects malformed stored citation metadata", () => {
    expect(() =>
      projectCitationHit({ ...row, documentCitations: [{ label: 1 }] }, context),
    ).toThrow();
    expect(() => projectCitationHit({ ...row, assetRefs: [{ path: "x" }] }, context)).toThrow();
  });
});
