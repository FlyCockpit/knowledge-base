/**
 * Index file writer (worker only; the server must never reach this module — see
 * `apps/server/src/index-file-policy.test.ts` and the `__KB_INDEX_WRITER__` image marker).
 *
 * Every byte of an attempt is written under `<gen>.a<attempt>.tmp` in `journal_mode=DELETE`
 * (never WAL). `finalize()` inserts the single `meta` row last, closes, fsyncs and asserts a
 * rollback-journal header and no `-journal` side file before returning the temp path;
 * `publishIndexFile` then links it to its final name without ever replacing a file.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { chmod, link, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { SourceSpan } from "../chunk";
import { comparePaths } from "../rrf";
import {
  attemptTempPath,
  bitDimensions,
  chunkTextHash,
  EMPTY_INDEX_INT8_SCALE,
  float32Bytes,
  INDEX_FORMAT,
  type IndexedRow,
  type IndexQuantization,
  indexPragmas,
  int8Bytes,
  isIndexQuantization,
  pad8,
  quantizeInt8,
  renderIndexDdl,
  renderLexicalIndexDdl,
  sliceOf,
  unitVector,
} from "./format";
import { loadSqlite, loadVec, type SqliteDatabase, type SqliteStatement } from "./sqlite";

type VectorLayout = { fingerprint: string; quantization: IndexQuantization; dimensions: number };
export type IndexWriterOptions = {
  indexDir: string;
  kbId: string;
  generationId: string;
  attempt: number;
  commitSha: string;
  /** CLI snapshot JSON; the server writes `{}`. */
  hostSnapshot?: string;
} & (
  | VectorLayout
  /** A lexical-only (FTS5) file: no profile, no vector tables. */
  | { lexical: true }
);

function vectorLayout(options: IndexWriterOptions): VectorLayout | null {
  return "lexical" in options ? null : options;
}

export type IndexDocumentInput = {
  path: string;
  blobSha: string;
  contentHash: string;
  documentId: string | null;
  state: "INDEXED" | "EMPTY" | "SKIPPED_REDACTED";
  originalWindowCount: number;
  /** `{commitSha, blobSha, contentHash, documentId, documentCitations, assetRefs}`. */
  source: { commitSha: string } & Record<string, unknown>;
  /** `{type, title, titleFolded, tags, timestamp}`. */
  metadata: Record<string, unknown>;
  rows: IndexedRow[];
};

export type IndexChunkInput = {
  chunkIndex: number;
  span: SourceSpan;
  text: string;
  snippet: string;
};

/** The stored vector bytes of an unchanged chunk, copied from a file of the same layout and int8 scale. */
export type StoredVector = { readonly bits: Buffer | null; readonly int8: Buffer };

/**
 * Review r2 #2 (CLI twin `StoredVector::decode`): the one typed decoding of stored vector bytes
 * at the read/reuse boundary. `int8` holds exactly `dimensions` values and `bits`
 * (binary_int8_rescore only) exactly the padded bit width; anything else (a damaged or foreign
 * row) throws, so the chunk is embedded again instead of copied on.
 */
export function decodeStoredVector(
  quantization: IndexQuantization,
  dimensions: number,
  bits: unknown,
  int8: unknown,
): StoredVector {
  if (!Buffer.isBuffer(int8) || int8.length !== dimensions)
    throw new Error("Index reuse: stored int8 vector of another width");
  if (quantization === "binary_int8_rescore") {
    if (!Buffer.isBuffer(bits) || bits.length !== bitDimensions(dimensions) / 8)
      throw new Error("Index reuse: stored bit vector of another width");
    return { bits, int8 };
  }
  if (bits !== null) throw new Error("Index reuse: bit vector in an int8 file");
  return { bits: null, int8 };
}
type BufferedVector = { id: number; unit: Float32Array } | { id: number; stored: StoredVector };

export type FinalizedIndexFile = { tempPath: string; documentCount: number; chunkCount: number };

function fail(message: string): never {
  throw new Error(`Index writer: ${message}`);
}

/** Bytes 0-15 are the SQLite magic; 18-19 = 1 is the rollback-journal (non-WAL) format. */
function assertRollbackHeader(path: string): void {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    if (
      readSync(fd, header, 0, 100, 0) !== 100 ||
      header.toString("latin1", 0, 16) !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      fail("finalized file is not in rollback-journal format");
  } finally {
    closeSync(fd);
  }
}

// Independent of provider batching; at 2000 dimensions this holds at most 32 MiB.
const VECTOR_WRITE_BATCH_ROWS = 4096;

export class IndexWriter {
  readonly tempPath: string;
  private readonly db: SqliteDatabase;
  private readonly options: IndexWriterOptions;
  private readonly vectorLayout: VectorLayout | null;
  private readonly vecVersion: string;
  private readonly insertDocument: SqliteStatement;
  private readonly insertChunk: SqliteStatement;
  private readonly insertFts: SqliteStatement;
  private readonly insertHash: SqliteStatement;
  private readonly selectChunkTexts: SqliteStatement;
  private readonly selectChunkHashes: SqliteStatement;
  private readonly insertVectors: Array<(id: number, unit: Float32Array) => void>;
  private readonly insertStored: Array<(id: number, stored: StoredVector) => void>;
  private int8Scale: number | null = null;
  private lastPath: string | null = null;
  private documentCount = 0;
  private chunkCount = 0;
  private vectorsWritten: Uint8Array | null = null;
  private vectorCount = 0;
  private vectorBatch: BufferedVector[] = [];
  private closed = false;

  /** @internal use `openIndexWriter`. */
  constructor(options: IndexWriterOptions, tempPath: string, db: SqliteDatabase) {
    this.options = options;
    this.tempPath = tempPath;
    this.db = db;
    for (const pragma of indexPragmas()) {
      const result = db.pragma(pragma.replace(/^PRAGMA\s+/i, ""), { simple: true });
      if (/^PRAGMA journal_mode=/i.test(pragma) && result !== "delete")
        fail("journal_mode is not delete");
    }
    if (db.pragma("journal_mode", { simple: true }) !== "delete")
      fail("journal_mode is not delete");
    this.vecVersion = loadVec(db);
    this.vectorLayout = vectorLayout(options);
    const ddl = this.vectorLayout
      ? renderIndexDdl(this.vectorLayout.quantization, this.vectorLayout.dimensions)
      : renderLexicalIndexDdl();
    for (const sql of ddl) db.exec(sql);
    this.insertDocument = db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?)");
    this.insertChunk = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)");
    this.insertFts = db.prepare("INSERT INTO chunk_fts(rowid, text) VALUES(?,?)");
    this.insertHash = db.prepare("INSERT INTO chunk_hash(id, h) VALUES(?,?)");
    this.selectChunkTexts = db.prepare(
      "SELECT id, text FROM chunks WHERE id IN (SELECT value FROM json_each(?))",
    );
    this.selectChunkHashes = db.prepare(
      "SELECT id, h FROM chunk_hash WHERE id IN (SELECT value FROM json_each(?))",
    );
    this.insertVectors = this.vectorInserts();
    this.insertStored = this.storedInserts();
  }

  private storedInserts(): Array<(id: number, stored: StoredVector) => void> {
    const { db } = this;
    if (!this.vectorLayout) return [];
    switch (this.vectorLayout.quantization) {
      case "int8": {
        const vec = db.prepare(
          "INSERT INTO chunk_vec(rowid, slice, embedding) VALUES(?,?,vec_int8(?))",
        );
        return [(id, stored) => vec.run(BigInt(id), BigInt(sliceOf(id)), stored.int8)];
      }
      case "binary_int8_rescore": {
        const bits = db.prepare("INSERT INTO chunk_bits(id, b) VALUES(?,?)");
        const int8 = db.prepare("INSERT INTO chunk_int8(id, e) VALUES(?,?)");
        return [
          (id, stored) => {
            if (!stored.bits) fail("stored vector without bits");
            bits.run(id, stored.bits);
          },
          (id, stored) => int8.run(id, stored.int8),
        ];
      }
    }
  }

  private vectorInserts(): Array<(id: number, unit: Float32Array) => void> {
    const { db } = this;
    if (!this.vectorLayout) return [];
    switch (this.vectorLayout.quantization) {
      case "int8": {
        const vec = db.prepare(
          "INSERT INTO chunk_vec(rowid, slice, embedding) VALUES(?,?,vec_int8(?))",
        );
        return [
          (id, unit) =>
            vec.run(BigInt(id), BigInt(sliceOf(id)), int8Bytes(quantizeInt8(unit, this.scale()))),
        ];
      }
      case "binary_int8_rescore": {
        const bits = db.prepare(
          "INSERT INTO chunk_bits(id, b) VALUES(?, vec_quantize_binary(vec_f32(?)))",
        );
        const int8 = db.prepare("INSERT INTO chunk_int8(id, e) VALUES(?,?)");
        return [
          (id, unit) => bits.run(id, float32Bytes(pad8(unit))),
          (id, unit) => int8.run(id, int8Bytes(quantizeInt8(unit, this.scale()))),
        ];
      }
    }
  }

  private scale(): number {
    if (this.int8Scale === null) fail("int8 scale not set");
    return this.int8Scale;
  }

  private assertOpen(): void {
    if (this.closed) fail("closed");
  }

  /** The calibrated scale (§1.4); required before any vector of an int8 quantization. */
  setInt8Scale(scale: number): void {
    this.assertOpen();
    if (this.int8Scale !== null) fail("int8 scale already set");
    if (!Number.isFinite(scale) || scale <= 0) fail("invalid int8 scale");
    this.int8Scale = scale;
  }

  /**
   * Pass 1. Documents arrive in bytewise path order and chunks in `chunk_index` order, so
   * `chunks.id` (1..n, insertion order) equals `compareChunkKeys` order. Returns the id range.
   */
  appendDocument(
    document: IndexDocumentInput,
    chunks: readonly IndexChunkInput[],
  ): { firstId: number; lastId: number } {
    this.assertOpen();
    if (this.vectorsWritten) fail("documents after vectors");
    if (this.lastPath !== null && comparePaths(this.lastPath, document.path) >= 0)
      fail("documents out of path order");
    if (document.source.commitSha !== this.options.commitSha) fail("foreign commit");
    if (document.state !== "INDEXED" && chunks.length > 0) fail("chunks on a non-indexed document");
    if (!Number.isSafeInteger(document.originalWindowCount) || document.originalWindowCount < 0)
      fail("invalid window count");
    let previous = -1;
    for (const chunk of chunks) {
      if (
        !Number.isSafeInteger(chunk.chunkIndex) ||
        chunk.chunkIndex <= previous ||
        chunk.chunkIndex >= document.originalWindowCount
      )
        fail("invalid chunk index");
      previous = chunk.chunkIndex;
    }
    const firstId = this.chunkCount + 1;
    this.db.transaction(() => {
      this.insertDocument.run(
        document.path,
        document.blobSha,
        document.contentHash,
        document.documentId,
        document.state,
        document.originalWindowCount,
        JSON.stringify(document.source),
        JSON.stringify(document.metadata),
        JSON.stringify(document.rows),
      );
      let id = firstId;
      for (const chunk of chunks) {
        this.insertChunk.run(
          id,
          document.path,
          chunk.chunkIndex,
          chunk.span.startToken,
          chunk.span.endToken,
          chunk.span.startByte,
          chunk.span.endByte,
          chunk.text,
          chunk.snippet,
        );
        id += 1;
      }
      chunks.forEach((chunk, at) => {
        this.insertFts.run(firstId + at, chunk.text);
        this.insertHash.run(firstId + at, chunkTextHash(chunk.text));
      });
    })();
    this.lastPath = document.path;
    this.documentCount += 1;
    this.chunkCount += chunks.length;
    return { firstId, lastId: this.chunkCount };
  }

  /** Pass-2 input: the stored text of each chunk id, in the order given. */
  chunkTexts(ids: readonly number[]): string[] {
    this.assertOpen();
    if (ids.length === 0) return [];
    const rows = this.selectChunkTexts.all(JSON.stringify(ids)) as Array<{
      id: number;
      text: string;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row.text]));
    return ids.map((id) => {
      const text = byId.get(id);
      if (text === undefined) fail("unknown chunk id");
      return text;
    });
  }

  /** Reuse key of each chunk id, in the order given (format 1 `chunk_hash`). */
  chunkHashes(ids: readonly number[]): Buffer[] {
    this.assertOpen();
    if (ids.length === 0) return [];
    const rows = this.selectChunkHashes.all(JSON.stringify(ids)) as Array<{
      id: number;
      h: Buffer;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row.h]));
    return ids.map((id) => {
      const hash = byId.get(id);
      if (hash === undefined) fail("unknown chunk id");
      return hash;
    });
  }

  /** Bytes currently allocated by the temp file (disk admission top-ups). */
  sizeBytes(): number {
    this.assertOpen();
    return statSync(this.tempPath).size;
  }

  /**
   * Pass 2. Input contract: RAW embeddings (as the provider returned them), never unit vectors;
   * each is normalized here exactly once, `u = f32(v / ‖v‖)` (§1.4). One per chunk id; each is validated (length, finite, unit norm after
   * `f32(v/‖v‖)`) before entering the bounded write buffer. A throw fails the attempt.
   */
  appendVectors(entries: ReadonlyArray<{ id: number; vector: ArrayLike<number> }>): void {
    this.assertOpen();
    const layout = this.vectorLayout;
    if (!layout) fail("vectors in a lexical-only file");
    this.scale();
    // Reserve ids as they enter the buffer, including across provider calls. A failed
    // append fails the attempt; buffered embeddings are never requested a second time.
    for (const { id, vector } of entries) {
      if (!Number.isSafeInteger(id) || id < 1 || id > this.chunkCount) fail("unknown chunk id");
      if (this.vectorsWritten?.[id] === 1) fail("duplicate vector");
      const unit = unitVector(vector, layout.dimensions);
      this.reserve(id);
      this.vectorBatch.push({ id, unit });
      if (this.vectorBatch.length === VECTOR_WRITE_BATCH_ROWS) this.flushVectors();
    }
  }

  /**
   * Vectors of unchanged chunks copied byte for byte from the active file of the same
   * layout. Only valid with that file's int8 scale (`setInt8Scale(source scale)`).
   */
  appendStored(entries: ReadonlyArray<{ id: number; stored: StoredVector }>): void {
    this.assertOpen();
    if (!this.vectorLayout) fail("vectors in a lexical-only file");
    this.scale();
    const layout = this.vectorLayout;
    for (const { id, stored } of entries) {
      // Only typed, full-width vectors are written (review r2 #2).
      decodeStoredVector(layout.quantization, layout.dimensions, stored.bits, stored.int8);
      this.reserve(id);
      this.vectorBatch.push({ id, stored });
      if (this.vectorBatch.length === VECTOR_WRITE_BATCH_ROWS) this.flushVectors();
    }
  }

  private reserve(id: number): void {
    this.vectorsWritten ??= new Uint8Array(this.chunkCount + 1);
    const written = this.vectorsWritten;
    if (!Number.isSafeInteger(id) || id < 1 || id > this.chunkCount) fail("unknown chunk id");
    if (written[id] === 1) fail("duplicate vector");
    written[id] = 1;
    this.vectorCount += 1;
  }

  private flushVectors(): void {
    this.db.transaction(() => {
      // Allocate long runs of pages for each table instead of alternating bits/int8
      // at every row. The bounded write batch is independent of embedder batch size.
      this.insertVectors.forEach((insert, at) => {
        const stored = this.insertStored[at]!;
        for (const row of this.vectorBatch)
          if ("unit" in row) insert(row.id, row.unit);
          else stored(row.id, row.stored);
      });
    })();
    this.vectorBatch = [];
  }

  /** Inserts `meta` last, closes, fsyncs, and asserts the published-file invariants. */
  finalize(): FinalizedIndexFile {
    this.assertOpen();
    const layout = this.vectorLayout;
    if (layout && this.vectorCount !== this.chunkCount) fail("missing vectors");
    if (layout) this.flushVectors();
    // An empty int8 file has nothing to calibrate; it stores the fixed EMPTY_INDEX_INT8_SCALE.
    if (layout && this.chunkCount === 0 && this.int8Scale === null)
      this.int8Scale = EMPTY_INDEX_INT8_SCALE;
    const scale = layout ? this.scale() : null;
    this.db
      .prepare("INSERT INTO meta VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        INDEX_FORMAT,
        this.options.generationId,
        this.options.kbId,
        this.options.commitSha,
        layout?.fingerprint ?? null,
        layout?.dimensions ?? null,
        layout?.quantization ?? null,
        scale,
        this.documentCount,
        this.chunkCount,
        this.vecVersion,
        this.options.hostSnapshot ?? "{}",
      );
    this.closed = true;
    this.db.close();
    const fd = openSync(this.tempPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertRollbackHeader(this.tempPath);
    if (existsSync(`${this.tempPath}-journal`)) fail("journal beside the finalized file");
    return {
      tempPath: this.tempPath,
      documentCount: this.documentCount,
      chunkCount: this.chunkCount,
    };
  }

  /** Closes without finalizing. Leftover `<tmp>` / `<tmp>-journal` belong to the next reset. */
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* already unusable */
    }
  }
}

export function openIndexWriter(options: IndexWriterOptions): IndexWriter {
  if (!Number.isSafeInteger(options.attempt) || options.attempt < 1)
    throw new Error("__KB_INDEX_WRITER__: invalid attempt");
  const layout = vectorLayout(options);
  if (layout && !isIndexQuantization(layout.quantization)) fail("invalid quantization");
  const tempPath = attemptTempPath(
    options.indexDir,
    options.kbId,
    options.generationId,
    options.attempt,
  );
  mkdirSync(dirname(tempPath), { recursive: true });
  // `wx`: an attempt never adopts bytes it did not create.
  closeSync(openSync(tempPath, "wx", 0o600));
  const Database = loadSqlite();
  const db = new Database(tempPath, { fileMustExist: true });
  try {
    return new IndexWriter(options, tempPath, db);
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Publish: `link(tmp, final)` (EEXIST never clobbers) → `unlink(tmp)` → `chmod 0444` →
 * directory fsync. With `replaceStale` (only inside the build's fenced publish transaction, which
 * has just proven that this attempt owns the generation) an earlier attempt's final is unlinked
 * first; both steps are synchronous, in the same tick as that proof.
 */
export async function publishIndexFile(
  tempPath: string,
  finalPath: string,
  options: { replaceStale?: boolean } = {},
): Promise<void> {
  if (dirname(tempPath) !== dirname(finalPath)) fail("publish across directories");
  if (options.replaceStale) {
    try {
      unlinkSync(finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    linkSync(tempPath, finalPath);
  } else await link(tempPath, finalPath);
  await unlink(tempPath);
  await chmod(finalPath, 0o444);
  const dir = await open(dirname(finalPath), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
