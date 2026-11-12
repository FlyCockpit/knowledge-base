import { z } from "zod";
import type { Freshness } from "./attachment";
import { assetRefSchema, citationHitSchema, docCitationSchema } from "./protocol/common";

export type CitationHit = z.infer<typeof citationHitSchema>;

/** One immutable leased-generation citation window, read from the generation's index file. */
export type CitationSourceRow = {
  kbId: string;
  generationId: string;
  path: string;
  chunkIndex: number;
  documentId: string | null;
  commitSha: string;
  blobSha: string;
  contentHash: string;
  startToken: number;
  endToken: number;
  startByte: number;
  endByte: number;
  /** The stored, already redacted plain citation snippet (chunk or matched row). */
  snippet: string;
  documentCitations: unknown;
  assetRefs: unknown;
  /** The exact stored table row resolved from this chunk's structured-row references. */
  matchedRow?: unknown;
};

const storedCitations = z.array(docCitationSchema).max(100);
const storedAssetRefs = z.array(assetRefSchema);

/**
 * Pure projection of stored index data; nothing is re-read from the current HEAD. Citation targets
 * stay untrusted metadata (any scheme is returned verbatim); renderers decide what is clickable.
 */
export function projectCitationHit(
  row: CitationSourceRow,
  context: {
    knowledgeBaseName: string;
    generationId: string;
    commitSha: string;
    freshness: Freshness;
    score: number;
    /**
     * "structured" only for the explicit queryless filter operation; "lexical" only
     * for a query over an index of an older built-in model identity.
     */
    mode?: "hybrid" | "structured" | "lexical";
    matchedRow?: unknown;
  },
): CitationHit {
  if (
    row.generationId !== context.generationId ||
    row.commitSha !== context.commitSha ||
    !Number.isFinite(context.score)
  )
    throw new Error("Citation outside the leased generation");
  return citationHitSchema.parse({
    knowledgeBaseId: row.kbId,
    knowledgeBaseName: context.knowledgeBaseName,
    path: row.path,
    documentId: row.documentId,
    commitSha: row.commitSha,
    blobSha: row.blobSha,
    contentHash: row.contentHash,
    chunkIndex: row.chunkIndex,
    span: {
      startToken: row.startToken,
      endToken: row.endToken,
      startByte: row.startByte,
      endByte: row.endByte,
    },
    // R2-27: plain text on every transport (MCP included); the span stays exact.
    snippet: row.snippet,
    score: context.score,
    mode: context.mode ?? "hybrid",
    indexGenerationId: row.generationId,
    freshness: context.freshness,
    documentCitations: storedCitations.parse(row.documentCitations),
    assetRefs: storedAssetRefs.parse(row.assetRefs),
    // Bounded by the structured row schema; never re-derived from the current HEAD.
    matchedRow: context.matchedRow ?? null,
  });
}
