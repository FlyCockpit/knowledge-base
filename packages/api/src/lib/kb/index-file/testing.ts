/** Test support: deterministic index files built through the real writer. Never imported by app code. */

import retrieval from "../fixtures/retrieval-quality.json" with { type: "json" };
import { fuseReciprocalRanks } from "../rrf";
import {
  calibrationIds,
  generationFilePath,
  type IndexedRow,
  type IndexQuantization,
  int8Scale,
  unitVector,
} from "./format";
import { configureIndexReader, createIndexReaderPool, type IndexReaderPool } from "./pool";
import {
  closeIndexHandle,
  type ExpectedIndexMeta,
  NO_STOP,
  openIndexReadOnly,
  readHybridTask,
} from "./reader";
import { loadSqlite, loadVec } from "./sqlite";
import { openIndexWriter, publishIndexFile } from "./writer";

export { attemptTempPath, generationFilePath, unitVector } from "./format";
export { loadSqlite } from "./sqlite";

export const TEST_KB_ID = "kbtestkbtestkbtestkbtest";
export const TEST_GENERATION_ID = "gentestgentestgentestgen";
export const TEST_COMMIT = "a".repeat(40);
export const TEST_FINGERPRINT = "fp-test";

export type TestDocument = {
  path: string;
  chunks: string[];
  documentId?: string | null;
  /** Defaults to INDEXED with chunks, EMPTY without. */
  state?: "INDEXED" | "EMPTY" | "SKIPPED_REDACTED";
  metadata?: Record<string, unknown>;
  rows?: IndexedRow[];
  /** Byte spans per chunk (defaults to consecutive 10-byte windows). */
  spans?: Array<{ startByte: number; endByte: number }>;
};

/** Deterministic pseudo-random raw vector for chunk `id` (xorshift; not unit length). */
export function testVector(id: number, dims: number): number[] {
  let state = (id * 2654435761) >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out.push((state / 0xffffffff) * 2 - 1);
  }
  return out;
}

export type BuiltIndex = { path: string; expected: ExpectedIndexMeta; int8Scale: number | null };

export async function buildTestIndex(options: {
  indexDir: string;
  documents: TestDocument[];
  quantization?: IndexQuantization;
  dimensions?: number;
  kbId?: string;
  generationId?: string;
  attempt?: number;
  vectorFor?: (id: number, dims: number) => number[];
  vectorBatch?: number;
  /** Generation row identity the file must match (defaults: TEST_COMMIT, TEST_FINGERPRINT). */
  commitSha?: string;
  fingerprint?: string;
  /** A lexical-only (FTS5) file: no profile, no vectors. */
  lexical?: boolean;
}): Promise<BuiltIndex> {
  const quantization = options.quantization ?? "binary_int8_rescore";
  const dimensions = options.dimensions ?? 8;
  const kbId = options.kbId ?? TEST_KB_ID;
  const generationId = options.generationId ?? TEST_GENERATION_ID;
  const vectorFor = options.vectorFor ?? testVector;
  const commitSha = options.commitSha ?? TEST_COMMIT;
  const fingerprint = options.fingerprint ?? TEST_FINGERPRINT;
  const lexical = options.lexical === true;
  const writer = openIndexWriter({
    indexDir: options.indexDir,
    kbId,
    generationId,
    attempt: options.attempt ?? 1,
    commitSha,
    ...(lexical ? { lexical: true as const } : { fingerprint, quantization, dimensions }),
  });
  try {
    for (const document of options.documents) {
      writer.appendDocument(
        {
          path: document.path,
          blobSha: "b".repeat(40),
          contentHash: `sha256:${"c".repeat(64)}`,
          documentId: document.documentId ?? null,
          state: document.state ?? (document.chunks.length > 0 ? "INDEXED" : "EMPTY"),
          originalWindowCount: document.chunks.length,
          source: {
            commitSha,
            blobSha: "b".repeat(40),
            contentHash: `sha256:${"c".repeat(64)}`,
            documentId: document.documentId ?? null,
            documentCitations: [],
            assetRefs: [],
          },
          metadata: document.metadata ?? {
            type: null,
            title: null,
            titleFolded: null,
            tags: [],
            timestamp: "2026-01-01T00:00:00Z",
          },
          rows: document.rows ?? [],
        },
        document.chunks.map((text, chunkIndex) => {
          const span = document.spans?.[chunkIndex] ?? {
            startByte: chunkIndex * 10,
            endByte: chunkIndex * 10 + 10,
          };
          return {
            chunkIndex,
            span: { startToken: chunkIndex, endToken: chunkIndex + 1, ...span },
            text,
            snippet: text.slice(0, 40),
          };
        }),
      );
    }
    const chunkCount = options.documents.reduce((n, d) => n + d.chunks.length, 0);
    let scale: number | null = null;
    if (chunkCount > 0 && !lexical) {
      scale = int8Scale(
        calibrationIds(chunkCount).map((id) => unitVector(vectorFor(id, dimensions), dimensions)),
      );
      writer.setInt8Scale(scale);
    }
    const batch = options.vectorBatch ?? 4096;
    for (let first = 1; !lexical && first <= chunkCount; first += batch) {
      const entries = [];
      for (let id = first; id < Math.min(chunkCount + 1, first + batch); id++)
        entries.push({ id, vector: vectorFor(id, dimensions) });
      writer.appendVectors(entries);
    }
    const finalized = writer.finalize();
    const path = generationFilePath(options.indexDir, kbId, generationId);
    await publishIndexFile(finalized.tempPath, path);
    return {
      path,
      int8Scale: scale,
      expected: {
        generationId,
        kbId,
        commitSha,
        fingerprint: lexical ? null : fingerprint,
        dimensions: lexical ? null : dimensions,
        chunkCount: finalized.chunkCount,
        documentCount: finalized.documentCount,
      },
    };
  } catch (error) {
    writer.abort();
    throw error;
  }
}

/**
 * Starts and registers a real reader pool over `indexDir` (thread entry from source under tsx),
 * as the server's `kb-runtime.ts` does. Integration suites stop it in `afterAll`.
 */
export async function startTestIndexReader(
  indexDir: string,
  options: { checkDelayMs?: number } = {},
): Promise<IndexReaderPool> {
  const pool = createIndexReaderPool({
    entry: new URL("./reader-thread.ts", import.meta.url),
    execArgv: ["--import", "tsx"],
    indexDir,
    ...(options.checkDelayMs ? { testHooks: { checkDelayMs: options.checkDelayMs } } : {}),
  });
  await pool.start();
  configureIndexReader(pool);
  return pool;
}

export type IndexFileContents = {
  meta: Record<string, unknown>;
  documents: Array<{ path: string; state: string; source: Record<string, unknown> }>;
  chunks: Array<{
    id: number;
    path: string;
    chunkIndex: number;
    startToken: number;
    endToken: number;
    startByte: number;
    endByte: number;
    text: string;
    snippet: string;
  }>;
  vectors: number;
  journalMode: string;
};

/** Reads a published (or temp) index file read-only, for assertions. */
export function readIndexFile(path: string): IndexFileContents {
  const Database = loadSqlite();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    loadVec(db);
    const meta = db.prepare("SELECT * FROM meta").get() as Record<string, unknown>;
    const documents = (
      db
        .prepare("SELECT path, state, source_json AS source FROM documents ORDER BY path")
        .all() as Array<{
        path: string;
        state: string;
        source: string;
      }>
    ).map((row) => ({ ...row, source: JSON.parse(row.source) as Record<string, unknown> }));
    const chunks = db
      .prepare(
        "SELECT id, path, chunk_index AS chunkIndex, start_token AS startToken, end_token AS endToken, start_byte AS startByte, end_byte AS endByte, text, snippet FROM chunks ORDER BY id",
      )
      .all() as IndexFileContents["chunks"];
    const quantization = meta.quantization;
    const table = quantization === "binary_int8_rescore" ? "chunk_int8" : "chunk_vec";
    const vectors = (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const journalMode = String(db.pragma("journal_mode", { simple: true }));
    return { meta, documents, chunks, vectors, journalMode };
  } finally {
    db.close();
  }
}

/** Stored vector bytes of one chunk (int8 values, plus bit bytes hex for binary files). */
export function readStoredVector(
  path: string,
  id: number,
): { int8: number[]; bitsHex: string | null } {
  const Database = loadSqlite();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    loadVec(db);
    const { quantization } = db.prepare("SELECT quantization FROM meta").get() as {
      quantization: IndexQuantization;
    };
    const int8 = (
      db
        .prepare(
          quantization === "int8"
            ? "SELECT embedding AS e FROM chunk_vec WHERE rowid = ?"
            : "SELECT e FROM chunk_int8 WHERE id = ?",
        )
        .get(id) as { e: Buffer }
    ).e;
    const bits =
      quantization === "binary_int8_rescore"
        ? (db.prepare("SELECT b FROM chunk_bits WHERE id = ?").get(id) as { b: Buffer }).b
        : null;
    return {
      int8: [...new Int8Array(int8.buffer, int8.byteOffset, int8.length)],
      bitsHex: bits?.toString("hex") ?? null,
    };
  } finally {
    db.close();
  }
}

/** Shared retrieval-quality corpus (`fixtures/retrieval-quality.json`, CLI twin `tests/support/retrieval.rs`). */
export const retrievalCorpus = retrieval;
export type RetrievalScore = {
  semanticHit1: number;
  semanticHit3: number;
  keywordHit1: number;
  misses: string[];
};
const retrievalPaths = () => Object.keys(retrieval.documents).sort();

/** One-hot document vector: with `replayQueryVector`, cosine order is the recorded order. */
export function replayDocumentVector(path: string): number[] {
  const paths = retrievalPaths();
  return paths.map((p) => (p === path ? 1 : 0));
}

/** Query vector weighted by the recorded Gemma vector rank (distinct after int8). */
export function replayQueryVector(query: string): number[] {
  const paths = retrievalPaths();
  const ranking = (retrieval.vectorRanking as Record<string, string[]>)[query];
  if (!ranking || ranking.length !== paths.length) throw new Error(`no recorded ranking: ${query}`);
  return paths.map((p) => paths.length - ranking.indexOf(p));
}

/**
 * Builds the corpus through the real writer (one chunk per note) and runs every query through
 * the real hybrid read task and fusion, scoring hit@1/hit@3. `vectors` null ⇒ a lexical-only file.
 */
export async function scoreRetrieval(
  indexDir: string,
  vectors: {
    dimensions: number;
    document: (path: string, text: string) => Promise<number[]>;
    query: (text: string) => Promise<number[]>;
  } | null,
): Promise<RetrievalScore> {
  const paths = retrievalPaths();
  const texts = retrieval.documents as Record<string, string>;
  const stored: number[][] = [];
  if (vectors) for (const path of paths) stored.push(await vectors.document(path, texts[path]!));
  const built = await buildTestIndex({
    indexDir,
    documents: paths.map((path) => ({
      path,
      chunks: [texts[path]!],
      spans: [{ startByte: 0, endByte: Buffer.byteLength(texts[path]!) }],
    })),
    ...(vectors
      ? { dimensions: vectors.dimensions, vectorFor: (id: number) => stored[id - 1]! }
      : { lexical: true }),
  });
  const handle = openIndexReadOnly(indexDir, built.expected);
  const score: RetrievalScore = { semanticHit1: 0, semanticHit3: 0, keywordHit1: 0, misses: [] };
  try {
    const sets = [
      ...retrieval.semantic.map((q) => ({ ...q, semantic: true })),
      ...retrieval.keyword.map((q) => ({ ...q, semantic: false })),
    ];
    for (const { query, target, semantic } of sets) {
      const vector = vectors ? await vectors.query(query) : null;
      const arms = readHybridTask(
        handle,
        { pathPrefix: null, documentId: null, filters: null, text: query, vector },
        NO_STOP,
      );
      const got = fuseReciprocalRanks(vector ? [arms.vector, arms.fts] : [arms.fts])
        .slice(0, 10)
        .map((hit) => hit.path);
      const hit1 = got[0] === target;
      if (semantic) {
        score.semanticHit1 += Number(hit1);
        score.semanticHit3 += Number(got.slice(0, 3).includes(target));
      } else score.keywordHit1 += Number(hit1);
      if (!hit1) score.misses.push(`${query} -> ${JSON.stringify(got.slice(0, 3))}`);
    }
  } finally {
    closeIndexHandle(handle);
  }
  return score;
}
