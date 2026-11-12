/**
 * Shared SQLite index file format v1 (server writer/reader; the CLI reads the same
 * fixture). Pure: no SQLite, no filesystem access beyond path construction.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { citationSnippet, type SourceSpan } from "../chunk";
import spec from "../fixtures/index-format.json" with { type: "json" };
import cases from "../fixtures/index-quantization-cases.json" with { type: "json" };
import stopwords from "../fixtures/stopwords.json" with { type: "json" };
import { KB_INDEX_RESCORE } from "../limits";
import { redactForEmbed } from "../redact-for-embed";
import { containsKnownCredentialPatterns } from "../sensitive-text";
import type { Scalar, StructuredRow } from "../structured";

/** The single format written by every writer, including `chunk_hash`. */
export const INDEX_FORMAT = spec.format;
/** The single format every reader accepts. */
export const READABLE_INDEX_FORMATS: readonly number[] = spec.readableFormats;
/**
 * A build inherits the active file's int8 scale and copies its stored vectors only when at
 * least this fraction of its chunks has an unchanged twin (same text hash) there.
 */
export const VECTOR_REUSE_MIN_FRACTION = spec.vectorReuse.minReusedFraction;

/** `chunk_hash.h`: SHA-256 of the chunk's stored text (the embedder input), CLI `chunk_hash`. */
export function chunkTextHash(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}
export const VEC_VERSION = spec.vecVersion;
/** vec0 partition / hamming slice size: `slice = (id - 1) >> 16`. */
export const SLICE_ROWS = spec.sliceRows;
export const FTS_SLICE_ROWS = spec.ftsSliceRows;
const MAX_INDEX_DIMENSIONS = 2000;
/** Per-slice KNN depth for vec0 arms (merged, then cut to the arm budget). */
export const VEC0_SLICE_K = 128;
/** Calibration sample size target: stride = max(1, ceil(chunkCount / 4096)). */
const INT8_CALIBRATION_TARGET = 4096;
const INT8_CALIBRATION_QUANTILE = 0.999;
const UNIT_TOLERANCE = 1e-4;

export const INDEX_QUANTIZATIONS = ["int8", "binary_int8_rescore"] as const;
export type IndexQuantization = (typeof INDEX_QUANTIZATIONS)[number];

/** Generation and KB ids (cuid2-shaped). Only these ever become path components. */
const INDEX_ID = /^[a-z0-9]{24,32}$/;

function assertDimensions(dims: number): void {
  if (!Number.isSafeInteger(dims) || dims < 1 || dims > MAX_INDEX_DIMENSIONS)
    throw new Error("Invalid index dimensions");
}

export function isIndexQuantization(value: unknown): value is IndexQuantization {
  return (INDEX_QUANTIZATIONS as readonly unknown[]).includes(value);
}

export function bitDimensions(dims: number): number {
  assertDimensions(dims);
  return Math.ceil(dims / 8) * 8;
}

/** Every writer pragma, in order (page_size before the first table; never WAL). */
export function indexPragmas(): readonly string[] {
  return spec.pragmas;
}

/** DDL of one file, `{dims}`/`{bitDims}` substituted only from a validated integer. */
export function renderIndexDdl(quantization: IndexQuantization, dims: number): string[] {
  assertDimensions(dims);
  if (!isIndexQuantization(quantization)) throw new Error("Invalid index quantization");
  const bits = String(bitDimensions(dims));
  return [...spec.statements, ...spec.vectorStatements[quantization]].map((sql) =>
    sql.replaceAll("{dims}", String(dims)).replaceAll("{bitDims}", bits),
  );
}

/**
 * DDL of a lexical-only (FTS5) file: the shared documents/chunks/FTS tables, no vector
 * tables, and a `meta` whose profile columns (fingerprint, dimensions, quantization, int8
 * scale) must be null. Readers tell the two kinds apart by the expected generation row.
 */
export function renderLexicalIndexDdl(): string[] {
  return spec.statements.map((sql) =>
    sql.startsWith("CREATE TABLE meta(") ? spec.lexicalMetaStatement : sql,
  );
}

function assertId(id: string): void {
  if (!INDEX_ID.test(id)) throw new Error("Invalid index id");
}

function kbIndexDir(indexDir: string, kbId: string): string {
  assertId(kbId);
  return join(indexDir, kbId);
}

export function generationFilePath(indexDir: string, kbId: string, generationId: string): string {
  assertId(generationId);
  return join(kbIndexDir(indexDir, kbId), `${generationId}.sqlite`);
}

/** `<gen>.a<attempt>.tmp`: every byte of an attempt is written under this name until publish. */
export function attemptTempPath(
  indexDir: string,
  kbId: string,
  generationId: string,
  attempt: number,
): string {
  assertId(generationId);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid index attempt");
  return join(kbIndexDir(indexDir, kbId), `${generationId}.a${attempt}.tmp`);
}

/** Global rescore candidate count for `n` eligible chunks (binary_int8_rescore). */
export function rescoreK(n: number): number {
  return Math.min(
    KB_INDEX_RESCORE.maxCandidates,
    Math.max(KB_INDEX_RESCORE.minCandidates, Math.ceil(n / KB_INDEX_RESCORE.chunksPerCandidate)),
  );
}

export function sliceOf(id: number): number {
  return (id - 1) >> 16;
}

/** Inclusive `[first, last]` chunk-id bounds of each slice of `sliceRows` ids. */
export function sliceBounds(chunkCount: number, sliceRows: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let first = 1; first <= chunkCount; first += sliceRows)
    out.push([first, Math.min(chunkCount, first + sliceRows - 1)]);
  return out;
}

/**
 * Quantizer input `u = f32(v / ‖v‖₂)`: the norm is computed in f64 and every component is
 * rounded to f32 (the bytes passed to `vec_f32`). Refuses wrong length, non-finite values and a
 * result whose f64 norm is not 1 within 1e-4.
 */
export function unitVector(raw: ArrayLike<number>, dims: number): Float32Array {
  assertDimensions(dims);
  if (raw.length !== dims) throw new Error("Vector has the wrong dimensions");
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    const value = raw[i]!;
    if (!Number.isFinite(value)) throw new Error("Vector is not finite");
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("Vector has no direction");
  const unit = new Float32Array(dims);
  let check = 0;
  for (let i = 0; i < dims; i++) {
    unit[i] = raw[i]! / norm;
    check += unit[i]! * unit[i]!;
  }
  if (!unit.every(Number.isFinite) || Math.abs(Math.sqrt(check) - 1) > UNIT_TOLERANCE)
    throw new Error("Vector is not unit length");
  return unit;
}

/** Calibration sample ids: `r` with `(r - 1) % stride == 0`, ascending. */
export function calibrationIds(chunkCount: number): number[] {
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) throw new Error("Invalid chunk count");
  const stride = Math.max(1, Math.ceil(chunkCount / INT8_CALIBRATION_TARGET));
  const ids: number[] = [];
  for (let id = 1; id <= chunkCount; id += stride) ids.push(id);
  return ids;
}

/**
 * `meta.int8_scale` of an int8 / binary_int8_rescore file with zero chunks (nothing to sample;
 * the column must still be > 0). Carried by the shared quantization fixture for the CLI.
 */
export const EMPTY_INDEX_INT8_SCALE = cases.emptyIndexInt8Scale;

/**
 * `values[floor(0.999 * (n - 1))]` of every sampled |u_i|, ascending. A very sparse sample (e.g.
 * one chunk with two non-zero components out of 1,024) has a 0 quantile; the scale then falls back
 * to the sample maximum `values[n - 1]`, which is > 0 for any validated unit vector.
 */
export function int8Scale(samples: readonly Float32Array[]): number {
  const values: number[] = [];
  for (const unit of samples) for (const value of unit) values.push(Math.abs(value));
  if (values.length === 0) throw new Error("No int8 calibration sample");
  values.sort((a, b) => a - b);
  let scale = values[Math.floor(INT8_CALIBRATION_QUANTILE * (values.length - 1))]!;
  if (scale === 0) scale = values[values.length - 1]!;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid int8 scale");
  return scale;
}

function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** `clamp(roundHalfAwayFromZero(u_i * 127 / scale), -127, 127)`. */
export function quantizeInt8(unit: Float32Array, scale: number): Int8Array {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid int8 scale");
  const out = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i++) {
    const q = roundHalfAwayFromZero((unit[i]! * 127) / scale);
    out[i] = Math.max(-127, Math.min(127, q));
  }
  return out;
}

/** Appends `ceil(dims / 8) * 8 - dims` zeros (zero pad bits; hamming unchanged). */
export function pad8(unit: Float32Array): Float32Array {
  const padded = new Float32Array(bitDimensions(unit.length));
  padded.set(unit);
  return padded;
}

/** Bytes `vec_quantize_binary(vec_f32(pad8(u)))` stores: bit i = u_i > 0, LSB first. */
export function binaryBits(unit: Float32Array): Uint8Array {
  const padded = pad8(unit);
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < padded.length; i++) if (padded[i]! > 0) out[i >> 3]! |= 1 << (i & 7);
  return out;
}

export function float32Bytes(values: Float32Array): Buffer {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

export function int8Bytes(values: Int8Array): Buffer {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

/** FTS5 string literal: double quotes inside are doubled. */
function ftsString(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

const ALNUM_RUN = /[\p{Alphabetic}\p{N}]+/gu;
const WHITE_SPACE = /\p{White_Space}+/u;
const STOPWORDS: ReadonlySet<string> = new Set([...stopwords["en-US"], ...stopwords["es-MX"]]);
const isStopword = (run: string) => STOPWORDS.has(run.toLowerCase());

/**
 * The lexical arm's query units (shared corpus `fixtures/fts-query.json`, CLI
 * `fts_units`), each an FTS5 MATCH expression:
 * - text between a pair of ASCII double quotes (curly quotes count as straight ones) is one
 *   exact phrase of its alphanumeric runs, stopwords included; an unpaired quote is ignored;
 * - elsewhere each whitespace-separated word is one unit: a single alphanumeric run is one
 *   term, a punctuated word (`e-mail`, `3.14`) requires all of its runs (AND);
 * - unquoted runs that are stopwords (`fixtures/stopwords.json`, every locale) are
 *   dropped, and a word left with no run is dropped; if that leaves no unit at all, the
 *   units are kept with their stopwords (`to be or not to be` still matches);
 * - units are de-duplicated case-insensitively (first occurrence kept); every unit of the
 *   query (at most 1024 scalars) takes part, so recall and the coverage floor see the whole query.
 * Alphanumeric = Rust `char::is_alphanumeric` (Alphabetic or Numeric), whitespace = White_Space.
 * Every term is a quoted FTS5 string, so operators and syntax in the query are plain words.
 */
export function ftsUnits(text: string): string[] {
  const parse = (dropStopwords: boolean) => {
    const units: string[] = [];
    const parts = text.replace(/[\u201c\u201d]/gu, '"').split('"');
    parts.forEach((part, at) => {
      // An odd segment is quoted unless it is the tail after an unpaired quote.
      if (at % 2 === 1 && at < parts.length - 1) {
        const runs = part.match(ALNUM_RUN) ?? [];
        if (runs.length > 0) units.push(ftsString(runs.join(" ")));
        return;
      }
      for (const word of part.split(WHITE_SPACE)) {
        let runs: string[] = word.match(ALNUM_RUN) ?? [];
        if (dropStopwords) runs = runs.filter((run) => !isStopword(run));
        if (runs.length === 1) units.push(ftsString(runs[0]!));
        else if (runs.length > 1) units.push(`(${runs.map(ftsString).join(" AND ")})`);
      }
    });
    const seen = new Set<string>();
    return units.filter((unit) => {
      const key = unit.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const units = parse(true);
  return units.length > 0 ? units : parse(false);
}

/** Any-unit FTS5 MATCH text of `units`; no unit ⇒ `""` (matches nothing). */
export function ftsMatch(units: readonly string[]): string {
  return units.length === 0 ? '""' : units.join(" OR ");
}

/** FTS5 MATCH text of a query: any of its units. */
export function ftsQuery(text: string): string {
  return ftsMatch(ftsUnits(text));
}

/**
 * (CLI `coverage_floor`): the fewest distinct units a lexical candidate must match. A
 * lexical-only search keeps every any-unit match; in a hybrid search the lexical arm keeps only
 * chunks matching a strict majority of the units, so a chunk sharing one incidental word with the
 * query cannot outrank the vector arm's best hit in the fusion.
 */
export function lexicalCoverageFloor(units: number, hybrid: boolean): number {
  return hybrid ? Math.floor(units / 2) + 1 : 1;
}

/** One stored structured row: its parser row plus the redacted citation snippet. */
export type IndexedRow = {
  rowIndex: number;
  values: Record<string, Scalar>;
  span: SourceSpan;
  snippet: string;
};

/**
 * TS twin of the CLI `kb-local/src/index.rs` rows projection: a row whose keys or string
 * values carry a known credential pattern, or whose source slice cannot be embedded safely,
 * is never stored.
 */
export function indexedRowsForDocument(body: string, rows: readonly StructuredRow[]): IndexedRow[] {
  const bytes = Buffer.from(body, "utf8");
  const out: IndexedRow[] = [];
  for (const row of rows) {
    if (
      Object.entries(row.values).some(
        ([key, value]) =>
          containsKnownCredentialPatterns(key) ||
          (typeof value === "string" && containsKnownCredentialPatterns(value)),
      )
    )
      continue;
    const text = redactForEmbed(
      bytes.subarray(row.span.startByte, row.span.endByte).toString("utf8"),
    );
    if (text === null) continue;
    out.push({
      rowIndex: row.rowIndex,
      values: row.values,
      span: row.span,
      snippet: citationSnippet(text),
    });
  }
  return out;
}

/** Conservative on-disk bytes of one plain-table BLOB row (B-tree page fit at 4 KiB). */
export function rowBytes(payloadBytes: number): number {
  return Math.ceil(payloadBytes * 1.4) + 32;
}

/** Conservative on-disk vector bytes per chunk for a quantization (measured ×1.01–1.34). */
export function vectorBytesPerChunk(quantization: IndexQuantization, dims: number): number {
  assertDimensions(dims);
  switch (quantization) {
    case "int8":
      return Math.ceil(dims * 1.1) + 64;
    case "binary_int8_rescore":
      return rowBytes(bitDimensions(dims) / 8) + rowBytes(dims);
  }
}

/**
 * Conservative on-disk bytes per chunk: vectors, the chunk row (text + snippet + span) and its
 * FTS5 postings (bounded by a small multiple of the text).
 */
export function perChunkBytes(
  quantization: IndexQuantization,
  dims: number,
  textBytes: number,
): number {
  return vectorBytesPerChunk(quantization, dims) + textBytes * 4 + 512;
}
