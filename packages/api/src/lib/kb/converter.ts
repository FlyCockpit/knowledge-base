import { createHash } from "node:crypto";
import { chunkBody } from "./chunk";
import { resolveMarkdownAssetReferences } from "./documents-read";
import { KbDomainError } from "./errors";
import { KB_TREE_LIMITS } from "./limits";
import type { AssetManifestEntry } from "./manifest";
import { parseMarkdownDocument } from "./parse-markdown";
import { extractStructuredDocument } from "./structured";

export class UnsupportedMediaError extends Error {
  readonly code = "UNSUPPORTED_MEDIA";
  constructor() {
    super("Unsupported media");
  }
}
export type ConversionInput = {
  mediaType: string;
  bytes: Buffer;
  path: string;
  commitSha: string;
  commitTimestamp: string;
  manifest: { commitSha: string; entries: readonly AssetManifestEntry[] };
};

/** Caller supplies admitted immutable source + manifest from the same reachable commit. */
export function convertSource(input: ConversionInput) {
  if (input.mediaType !== "text/markdown") throw new UnsupportedMediaError();
  if (
    input.bytes.length > KB_TREE_LIMITS.maxMarkdownBytes ||
    !/^[0-9a-f]{40}$/.test(input.commitSha) ||
    input.manifest.commitSha !== input.commitSha
  )
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid source snapshot");
  const parsed = parseMarkdownDocument(input.bytes);
  if (!("body" in parsed)) throw new KbDomainError("INVALID_ARGUMENT", "Invalid Markdown");
  const refs = resolveMarkdownAssetReferences(parsed.body, input.path);
  return {
    source: {
      path: input.path,
      commitSha: input.commitSha,
      blobSha: createHash("sha1")
        .update(`blob ${input.bytes.length}\0`)
        .update(input.bytes)
        .digest("hex"),
      contentHash: `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`,
      markdown: input.bytes.toString("utf8"),
      body: parsed.body,
      frontMatter: parsed.frontMatter,
      documentId: parsed.documentId,
      documentCitations: parsed.citations,
      assetRefs:
        refs.size === 0
          ? []
          : input.manifest.entries
              .filter((entry) => refs.has(entry.path))
              .map((entry) => ({ ...entry })),
    },
    ...chunkBody(parsed.body),
    structured: extractStructuredDocument(parsed, input.commitTimestamp),
  };
}

/** Transport adapters use the common INVALID_ARGUMENT code, never leak an internal media code. */
export function convertMarkdownSource(input: ConversionInput) {
  try {
    return convertSource(input);
  } catch (error) {
    if (error instanceof UnsupportedMediaError)
      throw new KbDomainError("INVALID_ARGUMENT", "Unsupported media");
    throw error;
  }
}
