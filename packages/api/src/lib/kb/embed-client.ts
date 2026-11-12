import type { Secret } from "@knowledge-base/env/secret";
import { z } from "zod";
import { kbHttpsRequest, readBoundedResponseBody } from "./egress";

/**
 * Why a provider request failed, for the owner's probe status only. Stable
 * codes plus numbers the provider protocol defines; never provider text.
 */
export type EmbeddingFailureReason =
  | { kind: "unreachable" }
  | { kind: "http_status"; status: number }
  | { kind: "dimension_mismatch"; received: number }
  | { kind: "bad_response" };

const PROBE_FAILURE_PREFIX = "provider_probe:";

/** The `lastError` a failed provider probe attempt records: a stable code, no provider text. */
export function probeFailureCode(reason: EmbeddingFailureReason | undefined): string {
  if (!reason) return "Embedding provider unavailable";
  switch (reason.kind) {
    case "http_status":
      return `${PROBE_FAILURE_PREFIX}http_status:${reason.status}`;
    case "dimension_mismatch":
      return `${PROBE_FAILURE_PREFIX}dimension_mismatch:${reason.received}`;
    default:
      return `${PROBE_FAILURE_PREFIX}${reason.kind}`;
  }
}

/** Inverse of {@link probeFailureCode}; null for any other `lastError`. */
export function parseProbeFailure(lastError: string | null): EmbeddingFailureReason | null {
  if (!lastError?.startsWith(PROBE_FAILURE_PREFIX)) return null;
  const [kind, value] = lastError.slice(PROBE_FAILURE_PREFIX.length).split(":");
  const number = value !== undefined && /^\d{1,4}$/.test(value) ? Number(value) : null;
  if (kind === "unreachable" || kind === "bad_response") return { kind };
  if (kind === "http_status" && number !== null) return { kind, status: number };
  if (kind === "dimension_mismatch" && number !== null) return { kind, received: number };
  return null;
}

export class EmbeddingUnavailableError extends Error {
  readonly code = "INDEX_UNAVAILABLE";
  constructor(readonly reason?: EmbeddingFailureReason) {
    super("Embedding provider unavailable");
  }
}

/**
 * Closed classification: the provider or model call itself failed (transport, HTTP status,
 * invalid reply, model child error). Only the adapters' call boundary raises it; their admission,
 * authority and SQL work never does, so only this is a degradable query-embedding failure.
 */
export class EmbedderCallError extends EmbeddingUnavailableError {}

/** Tokenized input exceeds the model context; never truncated. Not retriable. */
export class EmbeddingInputTooLongError extends Error {
  readonly code = "EMBEDDING_INPUT_TOO_LONG";
  constructor() {
    super("Embedding input too long");
  }
}

/**
 * Closed classification by the caller's purpose: may an embedder error degrade to the lexical
 * arm? Only at the query boundary, and only the embedder's own rejection of this query: a tagged
 * provider/model call failure (`EmbedderCallError`, which includes a provider rate limit or
 * status rejection) or the model rejecting the query as longer than its context. A document
 * embedding (a build) never degrades; every other error is non-degradable by default.
 */
export function degradableEmbedderError(error: unknown, purpose: "query" | "document"): boolean {
  return (
    purpose === "query" &&
    (error instanceof EmbedderCallError || error instanceof EmbeddingInputTooLongError)
  );
}

const responseSchema = z.object({
  data: z.array(
    z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }),
  ),
});

/**
 * Validates a provider/child embedding response and returns the RAW vectors in input order.
 * Callers never receive unit vectors: normalization is the index format's job (§1.4).
 */
export function validateEmbeddings(body: unknown, count: number, dimensions: number): number[][] {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 2000)
    throw new EmbeddingUnavailableError();
  const bad = () => new EmbeddingUnavailableError({ kind: "bad_response" });
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || parsed.data.data.length !== count) throw bad();
  const result: number[][] = Array.from({ length: count });
  const seen = new Set<number>();
  for (const { index, embedding } of parsed.data.data) {
    if (index >= count || seen.has(index)) throw bad();
    if (embedding.length !== dimensions)
      throw new EmbeddingUnavailableError({
        kind: "dimension_mismatch",
        received: embedding.length,
      });
    // Validation only: every component representable as a finite f32 and a non-zero norm. The
    // RAW values are returned; the index writer and the query arm normalize exactly once
    // (u = f32(v / ‖v‖), §1.4), so nothing here may round or normalize.
    const f32 = embedding.map(Math.fround);
    if (f32.some((value) => !Number.isFinite(value))) throw bad();
    const norm = Math.hypot(...f32);
    if (!Number.isFinite(norm) || norm <= 0 || !Number.isFinite(Math.hypot(...embedding)))
      throw bad();
    result[index] = [...embedding];
    seen.add(index);
  }
  return result;
}

/** Only this adapter speaks the provider protocol. The exact registered URL is used once. */
export async function requestOpenAiEmbeddings(
  config: { endpointUrl: string; model: string; dimensions: number; apiKey: Secret<string> },
  texts: readonly string[],
  signal?: AbortSignal,
  request: typeof kbHttpsRequest = kbHttpsRequest,
): Promise<number[][]> {
  // Closed classification: every failure of the provider HTTP exchange itself (transport,
  // status, body, reply validation) is the positive `EmbedderCallError` tag, raised here and only
  // here for providers; the precondition checks before it are not.
  if (signal?.aborted || texts.length > 32) throw new EmbeddingUnavailableError();
  if (!texts.length) return validateEmbeddings({ data: [] }, 0, config.dimensions);
  try {
    // DNS, connect, TLS and deadline failures all surface here.
    const response = await request(
      config.endpointUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        providerBearerToken: config.apiKey.reveal(),
        signal,
        body: Buffer.from(
          JSON.stringify({
            model: config.model,
            input: texts,
            dimensions: config.dimensions,
            encoding_format: "float",
          }),
        ),
      },
      { timeoutMs: 10_000, maxResponseBytes: 8 * 1024 * 1024, maxBodyBytes: 2 * 1024 * 1024 },
    ).catch(() => {
      throw new EmbedderCallError({ kind: "unreachable" });
    });
    if (response.statusCode !== 200) {
      response.destroy();
      const status = response.statusCode;
      throw new EmbedderCallError(
        status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
          ? { kind: "http_status", status }
          : { kind: "bad_response" },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(await readBoundedResponseBody(response)).toString("utf8"));
    } catch {
      throw new EmbedderCallError({ kind: "bad_response" });
    }
    return validateEmbeddings(parsed, texts.length, config.dimensions);
  } catch (error) {
    // Still inside the exchange: an invalid reply or an unexpected body/stream failure.
    if (error instanceof EmbedderCallError) throw error;
    throw new EmbedderCallError(
      error instanceof EmbeddingUnavailableError ? error.reason : undefined,
    );
  }
}
