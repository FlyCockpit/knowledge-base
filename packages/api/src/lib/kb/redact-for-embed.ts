import type { Embedder } from "./embedder";
import { containsKnownCredentialPatterns } from "./sensitive-text";

export const SEALED_EMBED_MARKER = "[sealed value redacted]";
const SEALED = /\{\{sealed:v1:knowledge_base:[0-9a-f-]{36}:[0-9a-f-]{36}\}\}/gi;
/** Sealed placeholder syntax (global): chunk splitting keeps each one whole. */
export const SEALED_PLACEHOLDER = SEALED;

export class SensitiveQueryError extends Error {
  readonly code = "SENSITIVE_QUERY";
  constructor() {
    super("Sensitive query rejected");
  }
}

export class SensitiveDocumentError extends Error {
  readonly code = "SENSITIVE_QUERY";
  constructor() {
    super("Sensitive document text rejected");
  }
}

/** No resolver or decryption capability is involved in this projection. */
export function redactForEmbed(text: string): string | null {
  if (containsKnownCredentialPatterns(text)) return null;
  return text.replace(SEALED, SEALED_EMBED_MARKER);
}

export function prepareEmbeddingQuery(query: string): string {
  const safe = redactForEmbed(query);
  if (safe === null) throw new SensitiveQueryError();
  return safe;
}

export function prepareEmbeddingDocument(text: string): string {
  const safe = redactForEmbed(text);
  if (safe === null) throw new SensitiveDocumentError();
  return safe;
}

/** Validate before invoking even a local embedder; callers authorize first. */
export function embedQuery(embedder: Embedder, query: string, signal?: AbortSignal) {
  return embedder.embed([prepareEmbeddingQuery(query)], { purpose: "query", signal });
}
