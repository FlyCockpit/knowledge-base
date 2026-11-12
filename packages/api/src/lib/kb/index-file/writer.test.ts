import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import cases from "../fixtures/index-quantization-cases.json" with { type: "json" };
import { removeEarlierAttemptTemps } from "./files";
import {
  chunkTextHash,
  EMPTY_INDEX_INT8_SCALE,
  generationFilePath,
  INDEX_QUANTIZATIONS,
  renderIndexDdl,
} from "./format";
import { PROBE_EXPECTED, PROBE_FTS_TERM, PROBE_INDEX_GZIP_BASE64 } from "./probe-fixture";
import {
  closeIndexHandle,
  NO_STOP,
  openIndexReadOnly,
  probeIndexHandle,
  readHybridTask,
  readQuerylessTask,
} from "./reader";
import { loadSqlite } from "./sqlite";
import {
  buildTestIndex,
  TEST_COMMIT,
  TEST_FINGERPRINT,
  TEST_GENERATION_ID,
  TEST_KB_ID,
  testVector,
} from "./testing";
import { decodeStoredVector, IndexWriter, openIndexWriter, publishIndexFile } from "./writer";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-index-writer-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const base = {
  kbId: TEST_KB_ID,
  generationId: TEST_GENERATION_ID,
  commitSha: TEST_COMMIT,
  fingerprint: TEST_FINGERPRINT,
  dimensions: 8,
};

function document(path: string, chunks: number) {
  return {
    path,
    blobSha: "b".repeat(40),
    contentHash: "sha256:x",
    documentId: null,
    state: chunks > 0 ? ("INDEXED" as const) : ("EMPTY" as const),
    originalWindowCount: chunks,
    source: { commitSha: TEST_COMMIT, documentCitations: [], assetRefs: [] },
    metadata: {
      type: null,
      title: null,
      titleFolded: null,
      tags: [],
      timestamp: "2026-01-01T00:00:00Z",
    },
    rows: [],
  };
}

function chunk(chunkIndex: number, text = `text ${chunkIndex}`) {
  return {
    chunkIndex,
    span: {
      startToken: chunkIndex,
      endToken: chunkIndex + 1,
      startByte: chunkIndex,
      endByte: chunkIndex + 1,
    },
    text,
    snippet: text,
  };
}

describe("index writer", () => {
  it("prepares chunk lookups once and preserves order, duplicates and unknown-id errors", () => {
    const db = new (loadSqlite())(join(tempDir(), "lookups.sqlite"));
    const prepare = vi.spyOn(db, "prepare");
    const writer = new IndexWriter(
      { ...base, indexDir: tempDir(), attempt: 1, lexical: true },
      "unused",
      db,
    );
    try {
      writer.appendDocument(document("a.md", 2), [chunk(0, "alpha"), chunk(1, "猫")]);
      expect(prepare.mock.calls.filter(([sql]) => sql.startsWith("SELECT id,"))).toHaveLength(2);
      prepare.mockClear();
      for (const ids of [[], [2, 1, 2], [1], [2]]) {
        expect(writer.chunkTexts(ids)).toEqual(ids.map((id) => (id === 1 ? "alpha" : "猫")));
        expect(writer.chunkHashes(ids)).toEqual(
          ids.map((id) => chunkTextHash(id === 1 ? "alpha" : "猫")),
        );
      }
      expect(() => writer.chunkTexts([1, 999])).toThrow("unknown chunk id");
      expect(() => writer.chunkHashes([999])).toThrow("unknown chunk id");
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      writer.abort();
    }
    expect(db.open).toBe(false);
    expect(() => writer.chunkTexts([])).toThrow("closed");
    expect(() => writer.chunkHashes([])).toThrow("closed");
  });

  it.each([1, 32, 777])(
    "groups vector pages independently of provider batches of %i",
    (providerBatch) => {
      const count = 20_537; // Multiple full write batches plus a partial final batch.
      const dimensions = 256;
      const writer = openIndexWriter({
        ...base,
        dimensions,
        indexDir: tempDir(),
        attempt: 1,
        quantization: "binary_int8_rescore",
      });
      writer.appendDocument(
        document("a.md", count),
        Array.from({ length: count }, (_, i) => chunk(i)),
      );
      writer.setInt8Scale(1 / Math.sqrt(dimensions));
      const vector = new Float32Array(dimensions).fill(1);
      for (let first = 1; first <= count; first += providerBatch)
        writer.appendVectors(
          Array.from({ length: Math.min(providerBatch, count - first + 1) }, (_, at) => ({
            id: first + at,
            vector,
          })),
        );
      writer.finalize();
      const db = new (loadSqlite())(writer.tempPath, { readonly: true });
      try {
        for (const [table, column, bytes] of [
          ["chunk_bits", "b", dimensions / 8],
          ["chunk_int8", "e", dimensions],
        ] as const) {
          const leaves = (
            db
              .prepare("SELECT pageno FROM dbstat WHERE name=? AND pagetype='leaf' ORDER BY path")
              .all(table) as { pageno: number }[]
          ).map((r) => r.pageno);
          expect(leaves.length).toBeGreaterThan(100);
          const consecutive = leaves.slice(1).filter((page, at) => page === leaves[at]! + 1).length;
          expect(consecutive / (leaves.length - 1)).toBeGreaterThanOrEqual(0.95);
          expect(
            db.prepare(`SELECT count(*) AS n FROM ${table} WHERE length(${column})=?`).get(bytes),
          ).toEqual({ n: count });
          const expected = Buffer.alloc(bytes, table === "chunk_bits" ? 255 : 127);
          for (const id of [1, 4096, 4097, count])
            expect(
              db.prepare(`SELECT ${column} AS vector FROM ${table} WHERE id=?`).get(id),
            ).toEqual({ vector: expected });
        }
        expect(readdirSync(dirname(writer.tempPath))).toEqual([writer.tempPath.split("/").at(-1)]);
      } finally {
        db.close();
      }
    },
  );

  it.each(INDEX_QUANTIZATIONS)(
    "%s: finalized file is rollback-journal format, journal_mode delete, no side files",
    async (quantization) => {
      const indexDir = tempDir();
      const built = await buildTestIndex({
        indexDir,
        quantization,
        documents: [
          { path: "a.md", chunks: ["alpha", "beta"] },
          { path: "b.md", chunks: [] },
          { path: "c.md", chunks: ["gamma"] },
        ],
      });
      const header = readFileSync(built.path).subarray(0, 100);
      expect(header.toString("latin1", 0, 16)).toBe("SQLite format 3\0");
      expect([header[18], header[19]]).toEqual([1, 1]);
      expect(readdirSync(dirname(built.path))).toEqual([`${TEST_GENERATION_ID}.sqlite`]);
      expect(statSync(built.path).mode & 0o777).toBe(0o444);
      const db = new (loadSqlite())(built.path, { readonly: true });
      try {
        expect(db.pragma("journal_mode", { simple: true })).toBe("delete");
        expect(db.pragma("page_size", { simple: true })).toBe(4096);
        expect(db.prepare("SELECT id,path,chunk_index AS c FROM chunks ORDER BY id").all()).toEqual(
          [
            { id: 1, path: "a.md", c: 0 },
            { id: 2, path: "a.md", c: 1 },
            { id: 3, path: "c.md", c: 0 },
          ],
        );
        expect(db.prepare("SELECT count(*) AS n FROM meta").get()).toEqual({ n: 1 });
        expect(
          db
            .prepare(
              "SELECT quantization, (int8_scale IS NULL) AS noScale, chunk_count, document_count FROM meta",
            )
            .get(),
        ).toEqual({
          quantization,
          noScale: 0,
          chunk_count: 3,
          document_count: 3,
        });
      } finally {
        db.close();
      }
    },
  );

  it("a writer failing mid-batch leaves only <tmp> / <tmp>-journal named for the attempt", () => {
    const indexDir = tempDir();
    const writer = openIndexWriter({ ...base, indexDir, attempt: 7, quantization: "int8" });
    writer.appendDocument(document("a.md", 3), [chunk(0), chunk(1), chunk(2)]);
    writer.setInt8Scale(1);
    expect(() =>
      writer.appendVectors([
        { id: 1, vector: testVector(1, 8) },
        { id: 2, vector: [1, 2, 3, 4, 5, 6, 7, Number.NaN] },
      ]),
    ).toThrow();
    expect(() => writer.appendVectors([{ id: 1, vector: [1, 2] }])).toThrow();
    writer.abort();
    const left = readdirSync(join(indexDir, TEST_KB_ID));
    expect(left.length).toBeGreaterThan(0);
    for (const name of left)
      expect([`${TEST_GENERATION_ID}.a7.tmp`, `${TEST_GENERATION_ID}.a7.tmp-journal`]).toContain(
        name,
      );
  });

  it.each([
    ["full", 4096, 2048, 0],
    ["final partial", 4099, 4098, 4096],
  ] as const)(
    "rolls back a SQLite failure inside a %s vector flush",
    async (_, count, failId, committed) => {
      const indexDir = tempDir();
      const previous = await buildTestIndex({
        indexDir,
        documents: [{ path: "old.md", chunks: ["previous active"] }],
      });
      const previousBytes = readFileSync(previous.path);
      const generationId = "failedgenfailedgenfailedgen";
      const writer = openIndexWriter({
        ...base,
        indexDir,
        generationId,
        attempt: 7,
        quantization: "binary_int8_rescore",
      });
      writer.appendDocument(
        document("a.md", count),
        Array.from({ length: count }, (_, i) => chunk(i)),
      );
      writer.setInt8Scale(1);
      const db = new (loadSqlite())(writer.tempPath, { fileMustExist: true });
      try {
        // The marker proves every bits row of this batch and some int8 rows were inserted.
        db.exec(`CREATE TRIGGER fail_grouped_flush BEFORE INSERT ON chunk_int8
        WHEN new.id=${failId} AND (SELECT count(*) FROM chunk_bits)=${count}
          AND (SELECT count(*) FROM chunk_int8)=${failId - 1}
        BEGIN SELECT RAISE(ABORT, 'injected grouped flush failure'); END`);
        const append = () =>
          writer.appendVectors(
            Array.from({ length: count }, (_, i) => ({
              id: i + 1,
              vector: testVector(i + 1, 8),
            })),
          );
        if (committed === 0) expect(append).toThrow("injected grouped flush failure");
        else append();
        expect(() => writer.finalize()).toThrow("injected grouped flush failure");
        for (const table of ["chunk_bits", "chunk_int8"])
          expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: committed });
        expect(db.prepare("SELECT count(*) AS n FROM meta").get()).toEqual({ n: 0 });
      } finally {
        db.close();
        writer.abort();
      }
      expect(() => writer.finalize()).toThrow("closed");
      expect(existsSync(generationFilePath(indexDir, TEST_KB_ID, generationId))).toBe(false);
      const leftovers = readdirSync(dirname(writer.tempPath)).filter((name) =>
        name.startsWith(generationId),
      );
      expect(leftovers).toContain(`${generationId}.a7.tmp`);
      for (const name of leftovers)
        expect([`${generationId}.a7.tmp`, `${generationId}.a7.tmp-journal`]).toContain(name);
      expect(await removeEarlierAttemptTemps(dirname(writer.tempPath), generationId, 8)).toBe(
        leftovers.length,
      );
      expect(readFileSync(previous.path)).toEqual(previousBytes);
      const handle = openIndexReadOnly(indexDir, previous.expected);
      closeIndexHandle(handle);
    },
  );

  it("enforces path order, chunk order, window counts and complete vectors", () => {
    const indexDir = tempDir();
    const writer = openIndexWriter({ ...base, indexDir, attempt: 1, quantization: "int8" });
    writer.appendDocument(document("b.md", 2), [chunk(0), chunk(1)]);
    expect(() => writer.appendDocument(document("a.md", 1), [chunk(0)])).toThrow(/path order/);
    expect(() => writer.appendDocument(document("c.md", 1), [chunk(1)])).toThrow(/chunk index/);
    expect(() => writer.appendDocument(document("c.md", 2), [chunk(1), chunk(0)])).toThrow(
      /chunk index/,
    );
    expect(() =>
      writer.appendDocument({ ...document("c.md", 0), state: "EMPTY" }, [chunk(0)]),
    ).toThrow(/non-indexed/);
    expect(() =>
      writer.appendDocument({ ...document("c.md", 1), source: { commitSha: "f".repeat(40) } }, [
        chunk(0),
      ]),
    ).toThrow(/foreign commit/);
    expect(() => writer.appendVectors([{ id: 1, vector: testVector(1, 8) }])).toThrow(/scale/);
    writer.setInt8Scale(0.5);
    writer.appendVectors([{ id: 1, vector: testVector(1, 8) }]);
    expect(() => writer.appendVectors([{ id: 1, vector: testVector(1, 8) }])).toThrow(/duplicate/);
    expect(() => writer.appendVectors([{ id: 3, vector: testVector(3, 8) }])).toThrow(/unknown/);
    expect(() => writer.appendDocument(document("d.md", 1), [chunk(0)])).toThrow(/after vectors/);
    expect(() => writer.finalize()).toThrow(/missing vectors/);
    writer.abort();
  });

  it("a lexical-only file has no vector tables and a null profile in meta", () => {
    const indexDir = tempDir();
    const writer = openIndexWriter({
      kbId: TEST_KB_ID,
      generationId: TEST_GENERATION_ID,
      commitSha: TEST_COMMIT,
      indexDir,
      attempt: 1,
      lexical: true,
    });
    writer.appendDocument(document("a.md", 1), [chunk(0, "alpha")]);
    expect(() => writer.appendVectors([{ id: 1, vector: testVector(1, 8) }])).toThrow(/lexical/);
    const finalized = writer.finalize();
    const db = new (loadSqlite())(finalized.tempPath, { readonly: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(tables).not.toContain("chunk_bits");
      expect(tables).not.toContain("chunk_int8");
      expect(
        db.prepare("SELECT fingerprint,dimensions,quantization,int8_scale FROM meta").get(),
      ).toEqual({ fingerprint: null, dimensions: null, quantization: null, int8_scale: null });
    } finally {
      db.close();
    }
  });

  it("never adopts an existing temp file and refuses an invalid attempt with the marker", () => {
    const indexDir = tempDir();
    mkdirSync(join(indexDir, TEST_KB_ID));
    writeFileSync(join(indexDir, TEST_KB_ID, `${TEST_GENERATION_ID}.a1.tmp`), "");
    expect(() => openIndexWriter({ ...base, indexDir, attempt: 1, quantization: "int8" })).toThrow(
      /EEXIST/,
    );
    expect(() => openIndexWriter({ ...base, indexDir, attempt: 0, quantization: "int8" })).toThrow(
      "__KB_INDEX_WRITER__: invalid attempt",
    );
  });

  it("publish never replaces an existing final file", async () => {
    const indexDir = tempDir();
    const built = await buildTestIndex({ indexDir, documents: [{ path: "a.md", chunks: ["x"] }] });
    const writer = openIndexWriter({ ...base, indexDir, attempt: 2, quantization: "int8" });
    writer.appendDocument(document("a.md", 1), [chunk(0)]);
    writer.setInt8Scale(1);
    writer.appendVectors([{ id: 1, vector: testVector(1, 8) }]);
    const { tempPath } = writer.finalize();
    const before = readFileSync(built.path);
    await expect(publishIndexFile(tempPath, built.path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(built.path).equals(before)).toBe(true);
    expect(existsSync(tempPath)).toBe(true);
  });
});

describe("empty indexes", () => {
  const variants: Array<[string, Parameters<typeof buildTestIndex>[0]["documents"]]> = [
    ["no documents", []],
    [
      "only empty and redacted documents",
      [
        { path: "a.md", chunks: [] },
        { path: "b.md", chunks: [], state: "SKIPPED_REDACTED" },
      ],
    ],
  ];
  for (const quantization of INDEX_QUANTIZATIONS)
    for (const [name, documents] of variants)
      it(`${quantization}: ${name} finalizes, opens and reads empty`, async () => {
        const indexDir = tempDir();
        const built = await buildTestIndex({ indexDir, documents, quantization });
        expect(built.expected.chunkCount).toBe(0);
        expect(built.expected.documentCount).toBe(documents.length);
        const handle = openIndexReadOnly(indexDir, built.expected);
        try {
          expect(handle.meta.int8Scale).toBe(EMPTY_INDEX_INT8_SCALE);
          const hybrid = readHybridTask(
            handle,
            {
              text: "alpha",
              vector: [1, 2, 3, 4, 5, 6, 7, 8],
              pathPrefix: null,
              documentId: null,
              filters: null,
            },
            NO_STOP,
          );
          expect(hybrid).toEqual({ vector: [], fts: [], rows: [] });
          expect(
            readQuerylessTask(
              handle,
              { pathPrefix: null, documentId: null, filters: {}, after: null, limit: 5 },
              NO_STOP,
            ),
          ).toEqual([]);
        } finally {
          closeIndexHandle(handle);
        }
      });

  it("the empty-index scale is the shared fixture value", () => {
    expect(EMPTY_INDEX_INT8_SCALE).toBe(cases.emptyIndexInt8Scale);
    expect(EMPTY_INDEX_INT8_SCALE).toBeGreaterThan(0);
  });
});

describe("reader pool probe fixture", () => {
  it("opens read-only, passes the probe and matches the rendered format", () => {
    const indexDir = tempDir();
    const path = generationFilePath(indexDir, PROBE_EXPECTED.kbId, PROBE_EXPECTED.generationId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, gunzipSync(Buffer.from(PROBE_INDEX_GZIP_BASE64, "base64")), {
      mode: 0o444,
    });
    const handle = openIndexReadOnly(indexDir, PROBE_EXPECTED);
    try {
      probeIndexHandle(handle, PROBE_FTS_TERM);
      const schema = (
        handle.db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'chunk_fts_%' ORDER BY rowid",
          )
          .all() as { sql: string }[]
      ).map((row) => row.sql);
      // Every DDL statement must match the shared format.
      expect(schema.sort()).toEqual(
        renderIndexDdl("binary_int8_rescore", PROBE_EXPECTED.dimensions).sort(),
      );
    } finally {
      closeIndexHandle(handle);
    }
    expect(readdirSync(dirname(path))).toEqual([`${PROBE_EXPECTED.generationId}.sqlite`]);
  });
});

describe("decodeStoredVector (review r2 #2)", () => {
  it("accepts only full-width stored vectors of the file's quantization", () => {
    const int8 = Buffer.alloc(12);
    const bits = Buffer.alloc(2);
    expect(decodeStoredVector("binary_int8_rescore", 12, bits, int8)).toEqual({ bits, int8 });
    expect(decodeStoredVector("int8", 12, null, int8)).toEqual({ bits: null, int8 });
    for (const [q, b, e] of [
      ["binary_int8_rescore", bits, Buffer.alloc(11)],
      ["binary_int8_rescore", Buffer.alloc(1), int8],
      ["binary_int8_rescore", null, int8],
      ["int8", bits, int8],
      ["int8", null, "not bytes"],
    ] as const)
      expect(() => decodeStoredVector(q, 12, b, e)).toThrow();
  });
});
