/**
 * Read-only access to published SQLite index files (format v1). The server reaches index files
 * only through `openIndexReadOnly` (its single Database construction, decision 5 + 21) and runs
 * every statement inside `runTask` (per-task temp state, CL2-TEMP). Every statement is bounded
 * by a slice; the task control is checked between slices, documents and every 1,024 rows.
 * Statements are only ever run to completion with `.all()` / `.get()` / `.run()`.
 */
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import type { SourceSpan } from "../chunk";
import type { KbDomainCode } from "../errors";
import { HYBRID_CANDIDATES_PER_ARM } from "../rrf";
import {
  matchStructuredDocument,
  type Scalar,
  type StructuredDocument,
  type StructuredFilters,
} from "../structured";
import {
  binaryBits,
  FTS_SLICE_ROWS,
  ftsMatch,
  ftsQuery,
  ftsUnits,
  generationFilePath,
  type IndexedRow,
  type IndexQuantization,
  int8Bytes,
  isIndexQuantization,
  lexicalCoverageFloor,
  quantizeInt8,
  READABLE_INDEX_FORMATS,
  rescoreK,
  SLICE_ROWS,
  sliceBounds,
  unitVector,
  VEC_VERSION,
  VEC0_SLICE_K,
} from "./format";
import { loadSqlite, loadVec, type SqliteDatabase } from "./sqlite";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const ROW_CHECK_INTERVAL = 1024;
/** Keyset batch sizes: no eligibility statement reads more rows than this at once. */
const DOCUMENT_BATCH = 256;
const CHUNK_BATCH = 1024;

/**
 * The Postgres generation row a file must match exactly (else INDEX_UNAVAILABLE). A
 * lexical-only generation has a null fingerprint and dimensions, and so must its file.
 */
export type ExpectedIndexMeta = {
  generationId: string;
  kbId: string;
  commitSha: string;
  fingerprint: string | null;
  dimensions: number | null;
  chunkCount: number;
  documentCount: number;
};

export type IndexFileMeta = ExpectedIndexMeta & {
  /** Null only for a lexical-only file, which has no vector tables. */
  quantization: IndexQuantization | null;
  int8Scale: number | null;
};

export type IndexHandle = {
  readonly db: SqliteDatabase;
  readonly meta: IndexFileMeta;
  readonly path: string;
  /** Set once the handle is closed (a failed ROLLBACK closes it); caches must reopen. */
  closed: boolean;
};

/** A read failure carried across the thread boundary as plain data. */
export class IndexReadError extends Error {
  constructor(
    readonly code: KbDomainCode,
    readonly fileMissing = false,
  ) {
    super(fileMissing ? "Index file missing" : "Index unavailable");
    this.name = "IndexReadError";
  }
}

/** Raised at a check point once the task's abort flag or deadline is reached. */
export class IndexTaskStopped extends Error {
  constructor(readonly status: "aborted" | "deadline") {
    super(status === "aborted" ? "Index read aborted" : "Index read deadline exceeded");
    this.name = "IndexTaskStopped";
  }
}

export type TaskControl = { check(): void };

export const NO_STOP: TaskControl = { check() {} };

/** Abort flag (shared Int32Array, 1 = aborted) plus wall-clock deadline. */
export function taskControl(abortFlag: Int32Array, deadlineAt: number): TaskControl {
  return {
    check() {
      if (Atomics.load(abortFlag, 0) !== 0) throw new IndexTaskStopped("aborted");
      if (Date.now() >= deadlineAt) throw new IndexTaskStopped("deadline");
    },
  };
}

function unavailable(): IndexReadError {
  return new IndexReadError("INDEX_UNAVAILABLE");
}

function sqliteCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/** Reads the 100-byte header: SQLite 3 magic and rollback-journal format (bytes 18-19 = 1). */
function checkHeader(path: string, indexDir: string): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if (sqliteCode(error) === "ENOENT" && existsSync(indexDir))
      throw new IndexReadError("INDEX_UNAVAILABLE", true);
    throw unavailable();
  }
  try {
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, 100, 0) !== 100) throw unavailable();
    if (!header.subarray(0, 16).equals(SQLITE_MAGIC) || header[18] !== 1 || header[19] !== 1)
      throw unavailable();
  } finally {
    closeSync(fd);
  }
}

type MetaRow = {
  format: number;
  generation_id: string;
  kb_id: string;
  commit_sha: string;
  fingerprint: string | null;
  dimensions: number | null;
  quantization: string | null;
  int8_scale: number | null;
  document_count: number;
  chunk_count: number;
  vec_version: string;
};

function readMeta(db: SqliteDatabase, expected: ExpectedIndexMeta): IndexFileMeta {
  const rows = db
    .prepare(
      "SELECT format,generation_id,kb_id,commit_sha,fingerprint,dimensions,quantization,int8_scale,document_count,chunk_count,vec_version FROM meta LIMIT 2",
    )
    .all() as MetaRow[];
  const row = rows[0];
  const lexical = expected.fingerprint === null && expected.dimensions === null;
  if (
    rows.length !== 1 ||
    !row ||
    !READABLE_INDEX_FORMATS.includes(row.format) ||
    !db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='chunk_hash' LIMIT 1")
      .get() ||
    row.vec_version !== VEC_VERSION ||
    (lexical
      ? row.quantization !== null || row.int8_scale !== null
      : !isIndexQuantization(row.quantization) ||
        row.int8_scale === null ||
        !Number.isFinite(row.int8_scale) ||
        row.int8_scale <= 0) ||
    row.generation_id !== expected.generationId ||
    row.kb_id !== expected.kbId ||
    row.commit_sha !== expected.commitSha ||
    row.fingerprint !== expected.fingerprint ||
    row.dimensions !== expected.dimensions ||
    row.chunk_count !== expected.chunkCount ||
    row.document_count !== expected.documentCount
  )
    throw unavailable();
  return {
    ...expected,
    quantization: isIndexQuantization(row.quantization) ? row.quantization : null,
    int8Scale: row.int8_scale,
  };
}

/**
 * The server's only way to open an index file: header check before SQLite sees the file, then a
 * plain-path `readonly` open (no URI, no `immutable`), sqlite-vec, and the `meta` row check.
 * A missing file under an existing index directory reports `fileMissing`.
 */
export function openIndexReadOnly(indexDir: string, expected: ExpectedIndexMeta): IndexHandle {
  let path: string;
  try {
    path = generationFilePath(indexDir, expected.kbId, expected.generationId);
  } catch {
    throw unavailable();
  }
  checkHeader(path, indexDir);
  const Database = loadSqlite();
  let db: SqliteDatabase;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (sqliteCode(error) === "SQLITE_CANTOPEN" && existsSync(indexDir))
      throw new IndexReadError("INDEX_UNAVAILABLE", true);
    throw unavailable();
  }
  try {
    // Runtime enforcement of decision 5/21: whatever constructed it, a writable handle is refused
    // before any statement runs.
    if (db.readonly !== true) throw unavailable();
    loadVec(db);
    db.pragma("temp_store=MEMORY");
    return { db, meta: readMeta(db, expected), path, closed: false };
  } catch (error) {
    db.close();
    if (error instanceof IndexReadError) throw error;
    throw unavailable();
  }
}

export function closeIndexHandle(handle: IndexHandle): void {
  if (handle.closed) return;
  handle.closed = true;
  try {
    handle.db.close();
  } catch {
    /* already unusable */
  }
}

/**
 * The only task entry: `BEGIN` → fn → `ROLLBACK` in `finally`, so temp tables never outlive the
 * task. A ROLLBACK that throws (e.g. a statement still open) closes the handle; the caller's
 * cache must then reopen it for the next task.
 */
export function runTask<T>(handle: IndexHandle, fn: (db: SqliteDatabase) => T): T {
  if (handle.closed) throw unavailable();
  handle.db.exec("BEGIN");
  try {
    return fn(handle.db);
  } finally {
    if (handle.db.inTransaction) {
      try {
        handle.db.exec("ROLLBACK");
      } catch {
        closeIndexHandle(handle);
      }
    }
  }
}

export type ArmHit = { id: number; path: string; chunkIndex: number; score: number };

/** One citation window of the leased file (span/snippet of the matched row when one is linked). */
export type IndexCitationRow = {
  id: number;
  path: string;
  chunkIndex: number;
  documentId: string | null;
  commitSha: string;
  blobSha: string;
  contentHash: string;
  span: SourceSpan;
  snippet: string;
  documentCitations: unknown;
  assetRefs: unknown;
  rowIndex: number;
  matchedRow: Record<string, Scalar> | null;
};

export type EligibilityInput = {
  pathPrefix: string | null;
  documentId: string | null;
  filters: StructuredFilters | null;
};

export type Eligibility = {
  /** False ⇒ every chunk is eligible and no temp table exists. */
  filtered: boolean;
  /** Structured row conditions restrict chunks to those intersecting a matched row. */
  rowFiltered: boolean;
  chunks: number;
};

function decodeJson<T>(raw: unknown): T {
  if (typeof raw !== "string") throw unavailable();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw unavailable();
  }
}

/** First index in sorted `rows` for which `pred` is false (rows partitioned by `pred`). */
function partitionPoint(rows: readonly IndexedRow[], pred: (row: IndexedRow) => boolean): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(rows[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Port of the CLI `prepare_eligible`: documents filtered by path prefix, document id and
 * `matchStructuredDocument` fill `temp.eligible`, `temp.matched_rows` and `temp.row_links`.
 * Must run inside `runTask` (ROLLBACK drops the temp tables).
 */
export function prepareEligible(
  db: SqliteDatabase,
  input: EligibilityInput & { always?: boolean },
  ctl: TaskControl,
): Eligibility {
  const filters = input.filters;
  const rowFiltered = (filters?.structured?.length ?? 0) > 0;
  const filtered =
    input.always === true ||
    input.pathPrefix !== null ||
    input.documentId !== null ||
    (filters !== null && Object.values(filters).some((value) => value !== undefined));
  if (!filtered) return { filtered: false, rowFiltered: false, chunks: -1 };
  ctl.check();
  // matched_rows carries each row's first intersecting chunk (queryless pages read it through
  // the primary key); row_links is keyed by chunk for the per-hit matched-row lookup.
  db.exec(`CREATE TEMP TABLE eligible(id INTEGER PRIMARY KEY);
    CREATE TEMP TABLE matched_rows(path TEXT NOT NULL, row_index INTEGER NOT NULL, raw TEXT, first_chunk INTEGER NOT NULL, PRIMARY KEY(path,row_index));
    CREATE TEMP TABLE row_links(chunk_id INTEGER NOT NULL, row_index INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY(chunk_id,row_index)) WITHOUT ROWID`);
  const metadataFilters: StructuredFilters | null = filters
    ? { ...filters, structured: undefined }
    : null;
  // Every statement is a bounded keyset batch, and the control is checked at least every
  // ROW_CHECK_INTERVAL rows *scanned* (skipped rows count) and written.
  const documentSelect = "SELECT path,metadata_json AS metadata FROM documents";
  const documentFilters =
    "(@prefix IS NULL OR substr(path,1,length(@prefix))=@prefix) AND (@documentId IS NULL OR document_id=@documentId)";
  const firstDocumentBatch = db.prepare(
    `${documentSelect} WHERE ${documentFilters} ORDER BY path LIMIT @limit`,
  );
  const nextDocumentBatch = db.prepare(
    `${documentSelect} WHERE path > @after AND ${documentFilters} ORDER BY path LIMIT @limit`,
  );
  const rowsOf = db.prepare("SELECT rows_json AS rows FROM documents WHERE path=?");
  // Without row conditions the spans are unused (indexed is empty). Keep that scan on the
  // existing covering (path,chunk_index) index instead of reading every chunk's text page.
  const spans = rowFiltered
    ? "start_byte AS startByte,end_byte AS endByte"
    : "0 AS startByte,0 AS endByte";
  const chunkBatch = db.prepare(
    `SELECT id,chunk_index AS chunkIndex,${spans} FROM chunks WHERE path=@path AND chunk_index > @after ORDER BY chunk_index LIMIT @limit`,
  );
  const addChunk = db.prepare("INSERT INTO temp.eligible(id) VALUES(?)");
  const addRow = db.prepare(
    "INSERT INTO temp.matched_rows(path,row_index,raw,first_chunk) VALUES(?,?,?,?)",
  );
  const addLink = db.prepare("INSERT INTO temp.row_links(chunk_id,row_index,path) VALUES(?,?,?)");
  let chunks = 0;
  let work = 0;
  const tick = (rows = 1) => {
    const before = Math.floor(work / ROW_CHECK_INTERVAL);
    work += rows;
    if (Math.floor(work / ROW_CHECK_INTERVAL) !== before) ctl.check();
  };
  let afterPath: string | null = null;
  for (;;) {
    ctl.check();
    const params = {
      prefix: input.pathPrefix,
      documentId: input.documentId,
      limit: DOCUMENT_BATCH,
    };
    const documents = (
      afterPath === null
        ? firstDocumentBatch.all(params)
        : nextDocumentBatch.all({ ...params, after: afterPath })
    ) as Array<{ path: string; metadata: string }>;
    if (documents.length === 0) break;
    afterPath = documents.at(-1)!.path;
    for (const document of documents) {
      ctl.check();
      tick();
      if (metadataFilters) {
        const doc: StructuredDocument = {
          ...decodeJson<Omit<StructuredDocument, "rows">>(document.metadata),
          rows: [],
        };
        if (matchStructuredDocument(doc, metadataFilters).length === 0) continue;
      }
      let indexed: IndexedRow[] = [];
      if (rowFiltered && filters) {
        // rows_json holds at most STRUCTURED_LIMITS.rows (1,024) rows per document.
        const stored = decodeJson<IndexedRow[]>(
          (rowsOf.get(document.path) as { rows: unknown } | undefined)?.rows,
        );
        tick(stored.length);
        const doc: StructuredDocument = {
          ...decodeJson<Omit<StructuredDocument, "rows">>(document.metadata),
          rows: stored.map(({ rowIndex, values, span }) => ({ rowIndex, values, span })),
        };
        const matched = new Set(
          matchStructuredDocument(doc, filters).flatMap((row) => (row ? [row.rowIndex] : [])),
        );
        indexed = stored.filter((row) => matched.has(row.rowIndex));
        if (indexed.length === 0) continue;
      }
      /** Smallest intersecting chunk id per matched row (index = position in `indexed`). */
      const firstChunk: Array<number | undefined> = new Array(indexed.length);
      let documentFirst: number | undefined;
      let afterIndex = -1;
      for (;;) {
        ctl.check();
        const batch = chunkBatch.all({
          path: document.path,
          after: afterIndex,
          limit: CHUNK_BATCH,
        }) as Array<{ id: number; chunkIndex: number; startByte: number; endByte: number }>;
        if (batch.length === 0) break;
        afterIndex = batch.at(-1)!.chunkIndex;
        for (const chunk of batch) {
          tick();
          // Parser rows have disjoint, increasing spans: two binary searches find the overlap.
          const first = partitionPoint(indexed, (row) => row.span.endByte <= chunk.startByte);
          const last = partitionPoint(indexed, (row) => row.span.startByte < chunk.endByte);
          if (rowFiltered && first === last) continue;
          addChunk.run(chunk.id);
          chunks += 1;
          tick();
          if (documentFirst === undefined || chunk.id < documentFirst) documentFirst = chunk.id;
          if (rowFiltered) {
            for (let at = first; at < last; at++) {
              addLink.run(chunk.id, indexed[at]!.rowIndex, document.path);
              const prior = firstChunk[at];
              if (prior === undefined || chunk.id < prior) firstChunk[at] = chunk.id;
              tick();
            }
          }
        }
        if (batch.length < CHUNK_BATCH) break;
      }
      // A row (or a metadata-only document) without any retained chunk can never be cited.
      if (rowFiltered) {
        for (let at = 0; at < indexed.length; at++) {
          const first = firstChunk[at];
          if (first === undefined) continue;
          addRow.run(document.path, indexed[at]!.rowIndex, JSON.stringify(indexed[at]), first);
          tick();
        }
      } else if (documentFirst !== undefined) {
        addRow.run(document.path, -1, null, documentFirst);
        tick();
      }
    }
    if (documents.length < DOCUMENT_BATCH) break;
  }
  ctl.check();
  return { filtered: true, rowFiltered, chunks };
}

type Scored = { id: number; path: string; chunkIndex: number; score: number };

function byScoreThenId(a: Scored, b: Scored): number {
  return a.score - b.score || a.id - b.id;
}

const ELIGIBLE = " AND {col} IN (SELECT id FROM temp.eligible)";

/**
 * Vector arm. int8: per-slice vec0 KNN (`k = 128`), merged by (distance, id) — id order
 * is (path, chunk_index) order — and cut to `limit`. binary_int8_rescore: per-slice hamming to a
 * global K(n), then int8 cosine rescore of those candidates.
 */
export function vectorArm(
  db: SqliteDatabase,
  meta: IndexFileMeta,
  rawQuery: ArrayLike<number>,
  eligibility: Eligibility,
  ctl: TaskControl,
  limit = HYBRID_CANDIDATES_PER_ARM,
  /** Hamming slice size (tests only; vec0 slices are the stored partition key). */
  hammingSliceRows = SLICE_ROWS,
): ArmHit[] {
  // A lexical-only file has no vector arm; callers pass no query vector for it.
  if (meta.dimensions === null || meta.quantization === null) throw unavailable();
  let unit: Float32Array;
  try {
    unit = unitVector(rawQuery, meta.dimensions);
  } catch {
    throw unavailable();
  }
  const filter = (col: string) => (eligibility.filtered ? ELIGIBLE.replace("{col}", col) : "");
  const merged: Scored[] = [];
  if (meta.quantization === "binary_int8_rescore") {
    const n = eligibility.filtered ? eligibility.chunks : meta.chunkCount;
    const k = rescoreK(n);
    const bits = Buffer.from(binaryBits(unit));
    const hamming = db.prepare(
      `SELECT b.id AS id, vec_distance_hamming(vec_bit(b.b), vec_bit(?)) AS score FROM chunk_bits b WHERE b.id BETWEEN ? AND ?${filter("b.id")} ORDER BY score, b.id LIMIT ?`,
    );
    for (const [first, last] of sliceBounds(meta.chunkCount, hammingSliceRows)) {
      ctl.check();
      merged.push(...(hamming.all(bits, first, last, k) as Scored[]));
    }
    ctl.check();
    const candidates = merged
      .sort(byScoreThenId)
      .slice(0, k)
      .map((row) => row.id);
    if (candidates.length === 0 || meta.int8Scale === null) return [];
    return db
      .prepare(
        `WITH ranked AS MATERIALIZED (
          SELECT i.id AS id, vec_distance_cosine(vec_int8(i.e), vec_int8(?)) AS score
          FROM chunk_int8 i WHERE i.id IN (SELECT value FROM json_each(?))
          ORDER BY score, i.id LIMIT ?
        )
        SELECT c.id AS id, c.path AS path, c.chunk_index AS chunkIndex, r.score AS score
        FROM ranked r JOIN chunks c ON c.id = r.id ORDER BY r.score, r.id`,
      )
      .all(
        int8Bytes(quantizeInt8(unit, meta.int8Scale)),
        JSON.stringify(candidates),
        limit,
      ) as ArmHit[];
  }
  if (meta.int8Scale === null) throw unavailable();
  const queryVector = int8Bytes(quantizeInt8(unit, meta.int8Scale));
  const knn = db.prepare(
    `SELECT v.rowid AS id, c.path AS path, c.chunk_index AS chunkIndex, v.distance AS score
    FROM chunk_vec v JOIN chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH vec_int8(?) AND v.k = ? AND v.slice = ?${filter("v.rowid")}`,
  );
  const slices = sliceBounds(meta.chunkCount, SLICE_ROWS).length;
  for (let slice = 0; slice < slices; slice++) {
    ctl.check();
    merged.push(...(knn.all(queryVector, BigInt(VEC0_SLICE_K), BigInt(slice)) as Scored[]));
  }
  ctl.check();
  return merged.sort(byScoreThenId).slice(0, limit);
}

/**
 * FTS5 arm (CLI `fts_arm`): candidates match at least `lexicalCoverageFloor` of the
 * query's units (`ftsUnits`) and rank by the number of distinct units they match, then bm25,
 * then id, so an all-units match ranks above any partial one. Both passes run per
 * 262,144-row slice (`rowid BETWEEN`); bm25 statistics are table-global, so merging the slices'
 * winners by (coverage, bm25, id) and cutting to `limit` is exact up to ties.
 */
export function ftsArm(
  db: SqliteDatabase,
  meta: IndexFileMeta,
  text: string,
  eligibility: Eligibility,
  ctl: TaskControl,
  limit = HYBRID_CANDIDATES_PER_ARM,
  sliceRows = FTS_SLICE_ROWS,
  hybrid = false,
): ArmHit[] {
  const units = ftsUnits(text);
  if (units.length === 0) return [];
  const floor = lexicalCoverageFloor(units.length, hybrid);
  const slices = sliceBounds(meta.chunkCount, sliceRows);
  // Coverage: one posting scan per unit (per slice) counts, in a request-scoped temp table, the
  // distinct units each chunk matches; every unit of the query takes part (no compound-select or
  // parameter limit applies). A single unit needs none (every match covers it).
  const counted = units.length > 1;
  if (counted) {
    db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS fts_coverage(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)",
    );
    db.prepare("DELETE FROM temp.fts_coverage WHERE id IS NOT NULL").run();
    const count = db.prepare(
      `INSERT INTO temp.fts_coverage(id, n) SELECT rowid, 1 FROM chunk_fts
      WHERE chunk_fts MATCH ? AND chunk_fts.rowid BETWEEN ? AND ?
      ON CONFLICT(id) DO UPDATE SET n = n + 1`,
    );
    for (const unit of units)
      for (const [first, last] of slices) {
        ctl.check();
        count.run(unit, first, last);
      }
  }
  // `+rowid`: MATCH drives the scan and eligibility is a membership test. Without it the planner
  // drives from temp.eligible and runs one FTS lookup per eligible id (≈1000× slower).
  // IDs have (path,chunk_index) order in v1 files. Rank before joining chunks so a common
  // term reads metadata only for the bounded winners, not every matching chunk's text page.
  const statement = db.prepare(
    `WITH ranked AS MATERIALIZED (
    SELECT chunk_fts.rowid AS id, bm25(chunk_fts) AS score, ${counted ? "v.n" : "1"} AS coverage
    FROM chunk_fts${counted ? " JOIN temp.fts_coverage v ON v.id = chunk_fts.rowid" : ""}
    WHERE chunk_fts MATCH ? AND chunk_fts.rowid BETWEEN ? AND ?${counted ? " AND v.n >= ?" : ""}${eligibility.filtered ? ELIGIBLE.replace("{col}", "+chunk_fts.rowid") : ""}
    ORDER BY coverage DESC, score, chunk_fts.rowid LIMIT ?
    )
    SELECT c.id AS id, c.path AS path, c.chunk_index AS chunkIndex, r.score AS score, r.coverage AS coverage
    FROM ranked r JOIN chunks c ON c.id = r.id ORDER BY r.coverage DESC, r.score, r.id`,
  );
  const query = ftsMatch(units);
  const merged: Array<Scored & { coverage: number }> = [];
  for (const [first, last] of slices) {
    ctl.check();
    const args = counted ? [query, first, last, floor, limit] : [query, first, last, limit];
    merged.push(...(statement.all(...args) as Array<Scored & { coverage: number }>));
  }
  ctl.check();
  return merged
    .sort((a, b) => b.coverage - a.coverage || byScoreThenId(a, b))
    .slice(0, limit)
    .map(({ id, path, chunkIndex, score }) => ({ id, path, chunkIndex, score }));
}

type ChunkRow = {
  id: number;
  path: string;
  chunkIndex: number;
  startToken: number;
  endToken: number;
  startByte: number;
  endByte: number;
  snippet: string;
  documentId: string | null;
  blobSha: string;
  contentHash: string;
  source: string;
};

type StoredSource = {
  commitSha?: unknown;
  documentCitations?: unknown;
  assetRefs?: unknown;
};

function citationRow(
  meta: IndexFileMeta,
  chunk: ChunkRow,
  row: IndexedRow | null,
): IndexCitationRow {
  const source = decodeJson<StoredSource>(chunk.source);
  if (source.commitSha !== meta.commitSha) throw unavailable();
  return {
    id: chunk.id,
    path: chunk.path,
    chunkIndex: chunk.chunkIndex,
    documentId: chunk.documentId,
    commitSha: meta.commitSha,
    blobSha: chunk.blobSha,
    contentHash: chunk.contentHash,
    span: row?.span ?? {
      startToken: chunk.startToken,
      endToken: chunk.endToken,
      startByte: chunk.startByte,
      endByte: chunk.endByte,
    },
    snippet: row?.snippet ?? chunk.snippet,
    documentCitations: source.documentCitations,
    assetRefs: source.assetRefs,
    rowIndex: row?.rowIndex ?? -1,
    matchedRow: row?.values ?? null,
  };
}

const CHUNK_SELECT = `SELECT c.id AS id, c.path AS path, c.chunk_index AS chunkIndex, c.start_token AS startToken,
  c.end_token AS endToken, c.start_byte AS startByte, c.end_byte AS endByte, c.snippet AS snippet,
  d.document_id AS documentId, d.blob_sha AS blobSha, d.content_hash AS contentHash, d.source_json AS source
  FROM chunks c JOIN documents d ON d.path = c.path`;

/**
 * Citation rows of `ids` (CLI `citation::project` port). With row filters each chunk carries
 * its first linked matched row (lowest row index).
 */
export function projectChunks(
  db: SqliteDatabase,
  meta: IndexFileMeta,
  ids: readonly number[],
  eligibility: Eligibility,
  ctl: TaskControl,
): IndexCitationRow[] {
  if (ids.length === 0) return [];
  ctl.check();
  const chunks = db
    .prepare(`${CHUNK_SELECT} WHERE c.id IN (SELECT value FROM json_each(?)) ORDER BY c.id`)
    .all(JSON.stringify(ids)) as ChunkRow[];
  const matched = eligibility.rowFiltered
    ? db.prepare(
        "SELECT m.raw AS raw FROM temp.row_links l JOIN temp.matched_rows m ON m.path = l.path AND m.row_index = l.row_index WHERE l.chunk_id = ? ORDER BY l.row_index LIMIT 1",
      )
    : null;
  return chunks.map((chunk) => {
    const raw = matched ? (matched.get(chunk.id) as { raw: unknown } | undefined)?.raw : null;
    if (matched && raw === undefined) throw unavailable();
    return citationRow(meta, chunk, raw ? decodeJson<IndexedRow>(raw) : null);
  });
}

export type HybridTaskInput = EligibilityInput & {
  /** Already prepared (redacted) query text. */
  text: string;
  /** Raw query embedding; null ⇒ lexical-only. */
  vector: number[] | null;
};

export type HybridTaskResult = {
  vector: ArmHit[];
  fts: ArmHit[];
  /** Citation rows of every candidate in either arm (fusion runs on the main thread). */
  rows: IndexCitationRow[];
};

export function readHybridTask(
  handle: IndexHandle,
  input: HybridTaskInput,
  ctl: TaskControl,
): HybridTaskResult {
  return runTask(handle, (db) => {
    const eligibility = prepareEligible(db, input, ctl);
    if (eligibility.filtered && eligibility.chunks === 0) return { vector: [], fts: [], rows: [] };
    const vector = input.vector ? vectorArm(db, handle.meta, input.vector, eligibility, ctl) : [];
    const fts = ftsArm(
      db,
      handle.meta,
      input.text,
      eligibility,
      ctl,
      HYBRID_CANDIDATES_PER_ARM,
      FTS_SLICE_ROWS,
      input.vector !== null,
    );
    const ids = [...new Set([...vector, ...fts].map((hit) => hit.id))];
    return { vector, fts, rows: projectChunks(db, handle.meta, ids, eligibility, ctl) };
  });
}

export type QuerylessTaskInput = EligibilityInput & {
  after: { path: string; rowIndex: number } | null;
  /** Rows to return (callers pass page size + 1). */
  limit: number;
};

/**
 * Queryless structured page: matched rows in (path bytes, row index) order after the keyset,
 * each with its first intersecting chunk; metadata-only matches use row index -1.
 */
export function readQuerylessTask(
  handle: IndexHandle,
  input: QuerylessTaskInput,
  ctl: TaskControl,
): IndexCitationRow[] {
  return runTask(handle, (db) => {
    prepareEligible(db, { ...input, always: true }, ctl);
    ctl.check();
    // Primary-key order (path bytes, row index) from the keyset; LIMIT bounds the scan.
    const pageSelect =
      "SELECT path, row_index AS rowIndex, raw, first_chunk AS chunkId FROM temp.matched_rows";
    const firstPage = db.prepare(`${pageSelect} ORDER BY path, row_index LIMIT @limit`);
    const nextPage = db.prepare(
      `${pageSelect} WHERE (path,row_index) > (@path,@rowIndex) ORDER BY path, row_index LIMIT @limit`,
    );
    const page = (
      input.after === null
        ? firstPage.all({ limit: input.limit })
        : nextPage.all({ ...input.after, limit: input.limit })
    ) as Array<{ path: string; rowIndex: number; raw: string | null; chunkId: number }>;
    const chunk = db.prepare(`${CHUNK_SELECT} WHERE c.id = ?`);
    return page.map((entry) => {
      ctl.check();
      const row = chunk.get(entry.chunkId) as ChunkRow | undefined;
      if (!row) throw unavailable();
      return citationRow(
        handle.meta,
        row,
        entry.rowIndex >= 0 ? decodeJson<IndexedRow>(entry.raw) : null,
      );
    });
  });
}

/**
 * Startup self-check on a known file: sqlite-vec version, one FTS5 query, one hamming query, a
 * refused main-database write and a temp table inside `runTask`. Throws on any failure.
 */
export function probeIndexHandle(handle: IndexHandle, ftsTerm: string): void {
  const { db } = handle;
  const version = (db.prepare("SELECT vec_version() AS v").get() as { v: unknown }).v;
  if (version !== VEC_VERSION) throw new Error("sqlite-vec version mismatch");
  const fts = db
    .prepare("SELECT count(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ?")
    .get(ftsQuery(ftsTerm)) as { n: number };
  if (fts.n < 1) throw new Error("FTS5 probe found nothing");
  const hamming = db
    .prepare("SELECT min(vec_distance_hamming(vec_bit(b), vec_bit(b))) AS d FROM chunk_bits")
    .get() as { d: unknown };
  if (hamming.d !== 0) throw new Error("hamming probe failed");
  let refused = false;
  try {
    db.exec("CREATE TABLE main.probe_write(x)");
  } catch (error) {
    refused = sqliteCode(error) === "SQLITE_READONLY";
  }
  if (!refused) throw new Error("index handle accepted a write");
  runTask(handle, (tx) => {
    tx.exec("CREATE TEMP TABLE probe_temp(x INTEGER)");
    tx.prepare("INSERT INTO temp.probe_temp VALUES(1)").run();
  });
  if ((db.prepare("SELECT count(*) AS n FROM temp.sqlite_master").get() as { n: number }).n !== 0)
    throw new Error("temp state outlived its task");
}
