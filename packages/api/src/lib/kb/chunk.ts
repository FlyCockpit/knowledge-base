import { plainSnippet } from "./plain-snippet";
import { CITATION_SNIPPET_MAX_SCALARS } from "./protocol/common";
import { redactForEmbed, SEALED_PLACEHOLDER } from "./redact-for-embed";
import { knownCredentialRanges } from "./sensitive-text";

export const CHUNK_WORDS = 400;
export const CHUNK_OVERLAP = 80;
export type SourceSpan = {
  startToken: number;
  endToken: number;
  startByte: number;
  endByte: number;
};
export type SourceToken = { start: number; end: number; startByte: number; endByte: number };

/** Rust split_whitespace uses White_Space: JS \s wrongly includes BOM and omits NEL. */
export function sourceTokens(body: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let cursor = 0;
  let byte = 0;
  for (const match of body.matchAll(/[^\p{White_Space}]+/gu)) {
    byte += Buffer.byteLength(body.slice(cursor, match.index));
    const endByte = byte + Buffer.byteLength(match[0]);
    cursor = match.index + match[0].length;
    tokens.push({ start: match.index, end: cursor, startByte: byte, endByte });
    byte = endByte;
  }
  return tokens;
}

export function citationSnippet(text: string): string {
  // A word can occupy the whole 2 MiB document. Bound scalar-safe Markdown
  // lookahead while retaining context beyond the final snippet cap.
  const window: string[] = [];
  for (const scalar of text) {
    if (window.length === CITATION_SNIPPET_MAX_SCALARS + 1024) break;
    window.push(scalar);
  }
  const plain = plainSnippet(window.join(""));
  const scalars = [...plain];
  return scalars.length <= CITATION_SNIPPET_MAX_SCALARS
    ? plain
    : `${scalars.slice(0, CITATION_SNIPPET_MAX_SCALARS - 1).join("")}…`;
}

export type SourceChunk = { chunkIndex: number; span: SourceSpan; text: string; snippet: string };
export type ChunkedBody = {
  state: "INDEXED" | "EMPTY" | "SKIPPED_REDACTED";
  originalWindowCount: number;
  chunks: SourceChunk[];
};

/** The safe embedding projection of a source slice, or null when it must not be embedded. */
function embedText(source: string): string | null {
  const safe = redactForEmbed(source);
  return safe === null ? null : safe.replace(/\p{White_Space}+/gu, " ");
}

/** Only body bytes enter here; source text is never overwritten by the safe projection. */
export function chunkBody(body: string): ChunkedBody {
  const tokens = sourceTokens(body);
  const rejected = knownCredentialRanges(body);
  const chunks: SourceChunk[] = [];
  let originalWindowCount = 0;
  let rangeIndex = 0;
  for (let startToken = 0; startToken < tokens.length; startToken += CHUNK_WORDS - CHUNK_OVERLAP) {
    const endToken = Math.min(startToken + CHUNK_WORDS, tokens.length);
    const first = tokens[startToken]!;
    const last = tokens[endToken - 1]!;
    const chunkIndex = originalWindowCount++;
    while (rejected[rangeIndex] && rejected[rangeIndex]!.end <= first.start) rangeIndex++;
    const overlaps = rejected[rangeIndex] && rejected[rangeIndex]!.start < last.end;
    if (!overlaps) {
      const text = embedText(body.slice(first.start, last.end));
      if (text !== null)
        chunks.push({
          chunkIndex,
          span: { startToken, endToken, startByte: first.startByte, endByte: last.endByte },
          text,
          snippet: citationSnippet(text),
        });
    }
    if (endToken === tokens.length) break;
  }
  return {
    state: tokens.length === 0 ? "EMPTY" : chunks.length ? "INDEXED" : "SKIPPED_REDACTED",
    originalWindowCount,
    chunks,
  };
}

/**
 * Model token counts of embedding inputs (prefix/EOS included, exactly as the
 * model will be fed) and the model's input limit.
 */
export type InputMeasure = (texts: string[]) => Promise<{ counts: number[]; limit: number }>;

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

/** First token for which the monotone predicate is false. */
function tokenPartitionPoint(
  tokens: SourceToken[],
  before: (token: SourceToken) => boolean,
): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (before(tokens[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Word ranges (sourceTokens indexes) when there are 3+ words, else code-point units. */
function splitUnits(body: string, tokens: SourceToken[], piece: Piece): Array<[number, number]> {
  const words: Array<[number, number]> = [];
  const first = tokenPartitionPoint(tokens, (token) => token.start < piece.start);
  for (let at = first; at < tokens.length && tokens[at]!.start < piece.end; at++) {
    const token = tokens[at]!;
    if (token.end <= piece.end) words.push([token.start, token.end]);
  }
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
  const startToken = tokenPartitionPoint(tokens, (token) => token.end <= piece.start);
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
export async function fitChunksToContext(
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
