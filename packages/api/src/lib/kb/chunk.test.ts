import { describe, expect, it } from "vitest";
import {
  CHUNK_OVERLAP,
  CHUNK_WORDS,
  type ChunkedBody,
  chunkBody,
  citationSnippet,
  fitChunksToContext,
  type InputMeasure,
  type SourceChunk,
  type SourceSpan,
  type SourceToken,
  sourceTokens,
} from "./chunk";
import golden from "./fixtures/chunks.json";
import snippetCorpus from "./fixtures/plain-snippet.json";
import { parseMarkdownDocument } from "./parse-markdown";
import { redactForEmbed, SEALED_PLACEHOLDER } from "./redact-for-embed";

describe("source-preserving chunks", () => {
  it.each(golden.cases)("golden: $name", (fixture) => {
    const parsed = parseMarkdownDocument(Buffer.from(fixture.markdown));
    if (!("body" in parsed)) throw new Error(parsed.code);
    expect(parsed.body).toBe(fixture.body);
    const result = chunkBody(parsed.body);
    expect(result.state).toBe(fixture.state);
    expect(result.originalWindowCount).toBe(fixture.originalWindowCount);
    expect(
      result.chunks.map(({ chunkIndex, span, text, snippet }) => ({
        chunkIndex,
        span,
        source: parsed.bodyBytes.subarray(span.startByte, span.endByte).toString("utf8"),
        text,
        snippet,
      })),
    ).toEqual(fixture.windows);
    expect(JSON.stringify(result)).not.toContain("sk-fixture-canary");
    for (const chunk of result.chunks) {
      expect(chunk.text).not.toContain("{{sealed:");
      expect([...chunk.snippet].length).toBeLessThanOrEqual(240);
    }
  });

  it.each(snippetCorpus.stressCases)("projects admitted single-word chunks: $name", (fixture) => {
    const input = fixture.head + fixture.unit.repeat(fixture.repeat) + fixture.tail;
    const parsed = parseMarkdownDocument(Buffer.from(input));
    if (!("body" in parsed)) throw new Error(parsed.code);
    // Formatter timing is asserted separately, excluding credential scanning.
    const result = chunkBody(parsed.body);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.snippet).toBe(fixture.snippet);
  });

  it.each([
    [1, 1],
    [400, 1],
    [401, 2],
    [720, 2],
    [721, 3],
  ])("%i words have %i windows", (words, windows) => {
    const result = chunkBody(Array(words).fill("word").join(" "));
    expect(result.originalWindowCount).toBe(windows);
    expect(result.chunks.at(-1)?.span.endToken).toBe(words);
  });

  it("uses all Rust White_Space scalars but neither BOM nor zero width space", () => {
    const whitespace =
      "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
    expect(sourceTokens(`a${whitespace}b`)).toHaveLength(2);
    expect(sourceTokens("a\ufeffb\u200bc")).toHaveLength(1);
  });

  it("drops both windows when a bearer credential crosses the first window end", () => {
    const body = [
      ...Array(399).fill("word"),
      "Bearer",
      "synthetic-canary-12345678",
      ...Array(50).fill("word"),
    ].join(" ");
    expect(chunkBody(body)).toEqual({
      state: "SKIPPED_REDACTED",
      originalWindowCount: 2,
      chunks: [],
    });
  });

  it.each([true, false])("rejects every PEM continuation window (closed=%s)", (closed) => {
    const body = `-----BEGIN PRIVATE KEY-----\n${Array(1000).fill("opaque-canary").join(" ")}\n${closed ? "-----END PRIVATE KEY-----" : ""}`;
    expect(chunkBody(body)).toEqual({
      state: "SKIPPED_REDACTED",
      originalWindowCount: 3,
      chunks: [],
    });
  });
  it("detects headers across Unicode whitespace before whitespace normalization", () => {
    expect(chunkBody("Authorization:\u0085Bearer\u0085abcdefghijk").state).toBe("SKIPPED_REDACTED");
    expect(chunkBody("Bearer\u0085synthetic-canary-12345678").chunks).toEqual([]);
  });

  it("caps snippets by scalars with the ellipsis inside the cap", () => {
    expect(citationSnippet("")).toBe("");
    expect(citationSnippet("😀".repeat(240))).toBe("😀".repeat(240));
    expect(citationSnippet("😀".repeat(241))).toBe(`${"😀".repeat(239)}…`);
    expect(citationSnippet("e\u0301".repeat(121))).toBe(`${"e\u0301".repeat(119)}e…`);
  });
});

/**
 * Context-fit chunking for the built-in model. The measure port stands in
 * for the model tokenizer (the real one is the child's; see qwen-child tests):
 * here one token per UTF-16 code unit plus EOS, i.e. "dense" text.
 */
describe("context-fit chunking", () => {
  const perChar = (limit: number) => {
    const calls: string[][] = [];
    const measure = async (texts: string[]) => {
      calls.push(texts);
      return { counts: texts.map((text) => text.length + 1), limit };
    };
    return { measure, calls };
  };
  const bytesOf = (body: string, chunk: SourceChunk) =>
    Buffer.from(body, "utf8").subarray(chunk.span.startByte, chunk.span.endByte).toString("utf8");
  const normalized = (text: string) => text.replace(/\p{White_Space}+/gu, " ");
  /** Deterministic dense words (8-11 chars, no whitespace). */
  const denseWord = (i: number) =>
    `${"qzxkvbjw"[i % 8]}${(i * 7919).toString(36)}${"Xy9Q".slice(0, (i % 4) + 1)}${i}`;

  function expectExact(body: string, chunks: SourceChunk[]) {
    const tokens = sourceTokens(body);
    for (const chunk of chunks) {
      const source = bytesOf(body, chunk);
      // Byte span round-trips to the exact source text the piece was built from.
      expect(normalized(source)).toBe(chunk.text);
      expect(source).toBe(source.trim());
      // Word span covers the byte span.
      expect(tokens[chunk.span.startToken]!.startByte).toBeLessThanOrEqual(chunk.span.startByte);
      expect(tokens[chunk.span.endToken - 1]!.endByte).toBeGreaterThanOrEqual(chunk.span.endByte);
      expect(chunk.span.endToken).toBeGreaterThan(chunk.span.startToken);
    }
  }

  it("at contextTokens 1024 a dense 400-word window is split into overlapping pieces that all fit", async () => {
    const words = Array.from({ length: 400 }, (_, i) => denseWord(i));
    const body = `${words.join(" ")}\n`;
    const base = chunkBody(body);
    expect(base.chunks).toHaveLength(1);
    expect(base.chunks[0]!.text.length + 1).toBeGreaterThan(1024); // does not fit as one window
    const { measure } = perChar(1024);
    const fitted = await fitChunksToContext(body, base, measure);
    expect(fitted.state).toBe("INDEXED");
    expect(fitted.chunks.length).toBeGreaterThan(1);
    for (const chunk of fitted.chunks) expect(chunk.text.length + 1).toBeLessThanOrEqual(1024);
    // Sequential indexes inside the (grown) window count; the DB guard needs index < count.
    expect(fitted.chunks.map((c) => c.chunkIndex)).toEqual(fitted.chunks.map((_, i) => i));
    expect(fitted.originalWindowCount).toBe(fitted.chunks.length);
    // Adjacent split pieces overlap (the 400/80 convention: ~20% of a piece).
    for (const [i, next] of fitted.chunks.slice(1).entries()) {
      const prev = fitted.chunks[i]!;
      expect(next.span.startByte).toBeLessThan(prev.span.endByte);
      expect(next.span.startToken).toBeLessThan(prev.span.endToken);
      expect(next.span.startByte).toBeGreaterThan(prev.span.startByte);
    }
    // Together the pieces cover every word of the window.
    expect(fitted.chunks[0]!.span.startByte).toBe(0);
    expect(fitted.chunks.at(-1)!.span.endByte).toBe(Buffer.byteLength(body.trimEnd()));
    expectExact(body, fitted.chunks);
  });

  it("keeps the existing windows unchanged when every window fits", async () => {
    const body = Array.from({ length: 900 }, (_, i) => `w${i % 10}`).join(" ");
    const base = chunkBody(body);
    const fitted = await fitChunksToContext(body, base, perChar(4096).measure);
    expect(fitted).toEqual(base);
  });

  it("splits a single over-long word by characters with overlap and exact multi-byte offsets", async () => {
    const word = Array.from({ length: 3000 }, (_, i) =>
      i % 3 === 0 ? "é" : i % 5 === 0 ? "😀" : "k",
    ).join("");
    const body = `lead ${word} tail`;
    const base = chunkBody(body);
    const fitted = await fitChunksToContext(body, base, perChar(1024).measure);
    expect(fitted.chunks.length).toBeGreaterThan(3);
    for (const chunk of fitted.chunks) {
      expect(chunk.text.length + 1).toBeLessThanOrEqual(1024);
      // Never a lone surrogate half.
      expect(chunk.text).toBe(Buffer.from(chunk.text, "utf8").toString("utf8"));
    }
    for (const [i, next] of fitted.chunks.slice(1).entries())
      expect(next.span.startByte).toBeLessThan(fitted.chunks[i]!.span.endByte);
    expectExact(body, fitted.chunks);
  });

  it("never cuts a sealed placeholder in half (it stays one unit, redacted as a whole)", async () => {
    const marker =
      "{{sealed:v1:knowledge_base:11111111-2222-3333-4444-555555555555:66666666-7777-8888-9999-000000000000}}";
    const body = Array.from({ length: 40 }, () => `x${marker}`).join("");
    const base = chunkBody(body);
    const fitted = await fitChunksToContext(body, base, perChar(400).measure);
    expect(fitted.chunks.length).toBeGreaterThan(1);
    for (const chunk of fitted.chunks) {
      expect(chunk.text).not.toMatch(/sealed:v1|\{\{|\}\}/);
      expect(chunk.text.length + 1).toBeLessThanOrEqual(400);
    }
  });

  it("keeps credential-bearing windows out and still counts them in the window total", async () => {
    const dense = Array.from({ length: CHUNK_WORDS }, (_, i) => denseWord(i)).join(" ");
    const body = `${dense} ${Array.from({ length: CHUNK_WORDS - CHUNK_OVERLAP }, (_, i) => `sk-fixture-canary${i}abcdefghijklmnopqrstuvwxyz0123456789`).join(" ")}`;
    const base = chunkBody(body);
    const fitted = await fitChunksToContext(body, base, perChar(1024).measure);
    expect(JSON.stringify(fitted)).not.toContain("sk-fixture-canary");
    expect(fitted.chunks.length).toBeLessThanOrEqual(fitted.originalWindowCount);
    for (const chunk of fitted.chunks)
      expect(chunk.chunkIndex).toBeLessThan(fitted.originalWindowCount);
    expectExact(body, fitted.chunks);
  });

  it.each([
    { name: "long ASCII word", body: "x".repeat(500), limit: 64 },
    { name: "partial multibyte words", body: `lead ${"é😀猫".repeat(200)} tail`, limit: 64 },
    {
      name: "exact word boundaries across windows",
      body: Array.from({ length: 725 }, (_, i) => `word${i}`).join("\u0085"),
      limit: 80,
    },
    {
      name: "late long word and mixed split units",
      body: [...Array(399).fill("猫"), "é😀".repeat(200), ...Array(400).fill("tail")].join("\n"),
      limit: 128,
    },
  ])("matches the original linear-scan algorithm: $name", async ({ body, limit }) => {
    const base = chunkBody(body);
    const expected = await fitChunksToContextReference(body, base, perChar(limit).measure);
    const actual = await fitChunksToContext(body, base, perChar(limit).measure);
    expect(actual.chunks.length).toBeGreaterThan(base.chunks.length);
    expect(actual).toEqual(expected);
    expectExact(body, actual.chunks);
  });

  it("rejects a measure reply that does not match the request", async () => {
    const body = Array.from({ length: 400 }, (_, i) => denseWord(i)).join(" ");
    await expect(
      fitChunksToContext(body, chunkBody(body), async () => ({ counts: [], limit: 1024 })),
    ).rejects.toThrow();
  });
});

// Reference snapshot before W02: keep the full-token scans in splitUnits/spanOf so
// recursive splitting, redaction and partial-word byte spans can be compared end to end.
function embedText(source: string): string | null {
  const safe = redactForEmbed(source);
  return safe === null ? null : safe.replace(/\p{White_Space}+/gu, " ");
}

type Piece = {
  /** UTF-16 source range, trimmed to non-whitespace at both ends. */
  start: number;
  end: number;
  text: string | null;
  count?: number;
};

const MEASURE_BATCH = 32;

async function measurePieces(pieces: Piece[], measure: InputMeasure): Promise<number> {
  const open = pieces.filter((piece) => piece.text !== null && piece.count === undefined);
  let limit = Number.POSITIVE_INFINITY;
  for (let offset = 0; offset < open.length; offset += MEASURE_BATCH) {
    const batch = open.slice(offset, offset + MEASURE_BATCH);
    const reply = await measure(batch.map((piece) => piece.text!));
    if (
      reply.counts.length !== batch.length ||
      !Number.isSafeInteger(reply.limit) ||
      reply.limit < 2 ||
      !reply.counts.every((n) => Number.isSafeInteger(n) && n > 0)
    )
      throw new Error("Invalid input measurement");
    for (const [i, piece] of batch.entries()) piece.count = reply.counts[i];
    limit = Math.min(limit, reply.limit);
  }
  return limit;
}

/** Word ranges (sourceTokens indexes) when there are 3+ words, else code-point units. */
function splitUnits(body: string, tokens: SourceToken[], piece: Piece): Array<[number, number]> {
  const words: Array<[number, number]> = [];
  for (const token of tokens)
    if (token.start >= piece.start && token.end <= piece.end) words.push([token.start, token.end]);
  if (words.length >= 3) return words;
  // Code points; a sealed placeholder is one indivisible unit so it is always
  // redacted as a whole (never cut into an unrecognizable fragment).
  const units: Array<[number, number]> = [];
  const sealed = [...body.slice(piece.start, piece.end).matchAll(SEALED_PLACEHOLDER)].map(
    (m) => [piece.start + m.index, piece.start + m.index + m[0].length] as const,
  );
  let sealedIndex = 0;
  for (let at = piece.start; at < piece.end; ) {
    const marker = sealed[sealedIndex];
    if (marker && marker[0] === at) {
      units.push([marker[0], marker[1]]);
      at = marker[1];
      sealedIndex++;
      continue;
    }
    const width = (body.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
    units.push([at, at + width]);
    at += width;
  }
  return units;
}

function trimmed(body: string, start: number, end: number): Piece | null {
  while (start < end && /\p{White_Space}/u.test(body[start]!)) start++;
  while (end > start && /\p{White_Space}/u.test(body[end - 1]!)) end--;
  return start < end ? { start, end, text: embedText(body.slice(start, end)) } : null;
}

/**
 * Splits an over-long piece into overlapping sub-pieces sized from the measured
 * ratio, reusing the window overlap convention (CHUNK_OVERLAP / CHUNK_WORDS of
 * a piece, at least one unit).
 */
function splitPiece(body: string, tokens: SourceToken[], piece: Piece, limit: number): Piece[] {
  const units = splitUnits(body, tokens, piece);
  if (units.length < 2) throw new Error("Unsplittable embedding input");
  const estimate = Math.floor((units.length * limit * 0.9) / (piece.count ?? limit + 1));
  const size = Math.min(units.length - 1, Math.max(units.length >= 3 ? 2 : 1, estimate));
  const overlap = size >= 2 ? Math.max(1, Math.floor((size * CHUNK_OVERLAP) / CHUNK_WORDS)) : 0;
  const pieces: Piece[] = [];
  for (let first = 0; ; first += size - overlap) {
    const last = Math.min(first + size, units.length) - 1;
    const next = trimmed(body, units[first]![0], units[last]![1]);
    if (next) pieces.push(next);
    if (last === units.length - 1) break;
  }
  return pieces;
}

function spanOf(body: string, tokens: SourceToken[], piece: Piece): SourceSpan {
  // A trimmed piece starts and ends inside source words.
  const startToken = tokens.findIndex((token) => token.end > piece.start);
  let endToken = startToken;
  while (endToken < tokens.length && tokens[endToken]!.start < piece.end) endToken++;
  const first = tokens[startToken]!;
  const last = tokens[endToken - 1]!;
  return {
    startToken,
    endToken,
    startByte: first.startByte + Buffer.byteLength(body.slice(first.start, piece.start)),
    endByte: last.endByte - Buffer.byteLength(body.slice(piece.end, last.end)),
  };
}

/**
 * Fits every embedding input of a body to the built-in model's
 * context. Windows that fit (by the model's own token count) are unchanged; an
 * over-long window is split into overlapping pieces (recursively, down to
 * code points for a single over-long word), so a build never fails for input
 * length. Every piece keeps an exact source span. Chunk indexes are renumbered
 * sequentially over windows and pieces; `originalWindowCount` counts every
 * window/piece, including ones withheld by redaction.
 */
async function fitChunksToContextReference(
  body: string,
  chunked: ChunkedBody,
  measure: InputMeasure,
): Promise<ChunkedBody> {
  if (chunked.chunks.length === 0) return chunked;
  const tokens = sourceTokens(body);
  const windows: Piece[] = chunked.chunks.map((chunk) => ({
    start: tokens[chunk.span.startToken]!.start,
    end: tokens[chunk.span.endToken - 1]!.end,
    text: chunk.text,
  }));
  const limit = await measurePieces(windows, measure);
  if (windows.every((piece) => piece.count! <= limit)) return chunked;
  const byWindow = new Map<number, Piece[]>();
  for (const [i, chunk] of chunked.chunks.entries()) {
    let pending = [windows[i]!];
    const done: Piece[] = [];
    while (pending.length > 0) {
      const next: Piece[] = [];
      for (const piece of pending)
        if (piece.text === null || piece.count! <= limit) done.push(piece);
        else next.push(...splitPiece(body, tokens, piece, limit));
      if (next.length > 0 && (await measurePieces(next, measure)) < limit)
        throw new Error("Embedding input limit changed");
      pending = next;
    }
    byWindow.set(
      chunk.chunkIndex,
      done.sort((a, b) => a.start - b.start || a.end - b.end),
    );
  }
  const chunks: SourceChunk[] = [];
  let index = 0;
  for (let window = 0; window < chunked.originalWindowCount; window++) {
    const pieces = byWindow.get(window);
    if (!pieces) {
      index++; // withheld window: still counted
      continue;
    }
    for (const piece of pieces) {
      const chunkIndex = index++;
      if (piece.text === null) continue;
      chunks.push({
        chunkIndex,
        span: spanOf(body, tokens, piece),
        text: piece.text,
        snippet: citationSnippet(piece.text),
      });
    }
  }
  return {
    state: chunks.length ? "INDEXED" : "SKIPPED_REDACTED",
    originalWindowCount: index,
    chunks,
  };
}
