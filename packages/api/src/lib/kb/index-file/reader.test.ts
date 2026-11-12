import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ftsQuery,
  generationFilePath,
  type IndexedRow,
  int8Bytes,
  quantizeInt8,
  rescoreK,
  unitVector,
} from "./format";
import {
  closeIndexHandle,
  type Eligibility,
  ftsArm,
  IndexReadError,
  IndexTaskStopped,
  NO_STOP,
  openIndexReadOnly,
  prepareEligible,
  readHybridTask,
  readQuerylessTask,
  runTask,
  type TaskControl,
  vectorArm,
} from "./reader";
import { createReaderThreadState } from "./reader-thread";
import * as sqlite from "./sqlite";
import { buildTestIndex, TEST_KB_ID, testVector } from "./testing";

vi.mock("./sqlite", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sqlite")>();
  return { ...original, loadSqlite: vi.fn(original.loadSqlite) };
});

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-index-reader-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const UNFILTERED: Eligibility = { filtered: false, rowFiltered: false, chunks: -1 };
const sideFiles = (path: string) =>
  readdirSync(dirname(path)).filter((name) => /-(journal|wal|shm)$/.test(name));

function hybrid(
  text: string,
  vector: number[] | null,
  extra: Partial<Parameters<typeof readHybridTask>[1]> = {},
) {
  return { text, vector, pathPrefix: null, documentId: null, filters: null, ...extra };
}

function tableRow(
  rowIndex: number,
  values: Record<string, string | number>,
  startByte: number,
): IndexedRow {
  return {
    rowIndex,
    values,
    span: { startToken: rowIndex, endToken: rowIndex + 1, startByte, endByte: startByte + 5 },
    snippet: `row ${rowIndex}`,
  };
}

/** Three documents; `b.md` carries two table rows that intersect chunks 0 and 1. */
async function smallIndex(quantization: "int8" | "binary_int8_rescore" = "binary_int8_rescore") {
  const indexDir = tempDir();
  const built = await buildTestIndex({
    indexDir,
    quantization,
    documents: [
      {
        path: "a/one.md",
        chunks: ["alpha bravo", "charlie delta"],
        documentId: "doc-one",
        metadata: {
          type: "note",
          title: "One",
          titleFolded: "one",
          tags: ["x"],
          timestamp: "2026-01-01T00:00:00Z",
        },
      },
      {
        path: "b/two.md",
        chunks: ["alpha table", "bravo table", "echo"],
        metadata: {
          type: "table",
          title: "Two",
          titleFolded: "two",
          tags: [],
          timestamp: "2026-02-01T00:00:00Z",
        },
        rows: [tableRow(0, { k: "red", n: 1 }, 2), tableRow(1, { k: "blue", n: 2 }, 12)],
      },
      { path: "c/empty.md", chunks: [] },
    ],
  });
  return { indexDir, ...built };
}

describe("lexical-only files", () => {
  const documents = [
    { path: "a/one.md", chunks: ["alpha bravo", "charlie delta"] },
    { path: "b/two.md", chunks: ["bravo echo"] },
  ];
  it("opens only as a lexical generation and answers the FTS arm without vectors", async () => {
    const indexDir = tempDir();
    const { expected } = await buildTestIndex({ indexDir, documents, lexical: true });
    expect(expected).toMatchObject({ fingerprint: null, dimensions: null });
    const handle = openIndexReadOnly(indexDir, expected);
    try {
      expect(handle.meta).toMatchObject({ quantization: null, int8Scale: null });
      const result = readHybridTask(handle, hybrid("bravo", null), NO_STOP);
      expect(result.vector).toEqual([]);
      expect(result.fts.map((hit) => hit.path).sort()).toEqual(["a/one.md", "b/two.md"]);
      // A query vector against a file without vector tables fails closed.
      expect(() => readHybridTask(handle, hybrid("bravo", testVector(1, 8)), NO_STOP)).toThrow(
        expect.objectContaining({ code: "INDEX_UNAVAILABLE" }),
      );
    } finally {
      closeIndexHandle(handle);
    }
    // A hybrid generation row never accepts the lexical file.
    expect(() =>
      openIndexReadOnly(indexDir, {
        ...expected,
        fingerprint: `sha256:${"0".repeat(64)}`,
        dimensions: 8,
      }),
    ).toThrow(expect.objectContaining({ code: "INDEX_UNAVAILABLE" }));
  });
  it("a lexical generation row never accepts a hybrid file", async () => {
    const indexDir = tempDir();
    const { expected } = await buildTestIndex({ indexDir, documents });
    expect(() =>
      openIndexReadOnly(indexDir, { ...expected, fingerprint: null, dimensions: null }),
    ).toThrow(expect.objectContaining({ code: "INDEX_UNAVAILABLE" }));
  });
});

describe("openIndexReadOnly", () => {
  it("refuses a file missing the required chunk_hash table", async () => {
    const { indexDir, path, expected } = await smallIndex();
    chmodSync(path, 0o644);
    const db = new (sqlite.loadSqlite())(path);
    try {
      db.exec("ALTER TABLE chunk_hash RENAME TO absent_chunk_hash");
    } finally {
      db.close();
    }
    expect(() => openIndexReadOnly(indexDir, expected)).toThrow(
      expect.objectContaining({ code: "INDEX_UNAVAILABLE", fileMissing: false }),
    );
  });

  it.each([0, 2, 3])("refuses unsupported format %s", async (format) => {
    const { indexDir, path, expected } = await smallIndex();
    chmodSync(path, 0o644);
    const db = new (sqlite.loadSqlite())(path);
    try {
      db.exec("ALTER TABLE meta RENAME TO original_meta");
      db.exec("CREATE TABLE meta AS SELECT * FROM original_meta");
      db.prepare("UPDATE meta SET format = ?").run(format);
    } finally {
      db.close();
    }
    expect(() => openIndexReadOnly(indexDir, expected)).toThrow(
      expect.objectContaining({ code: "INDEX_UNAVAILABLE", fileMissing: false }),
    );
  });

  it("refuses a meta that differs from the generation row", async () => {
    const { indexDir, expected } = await smallIndex();
    for (const change of [
      { commitSha: "f".repeat(40) },
      { fingerprint: "other" },
      { chunkCount: 4 },
      { documentCount: 2 },
      { dimensions: 9 },
    ]) {
      expect(() => openIndexReadOnly(indexDir, { ...expected, ...change })).toThrow(
        expect.objectContaining({ code: "INDEX_UNAVAILABLE", fileMissing: false }),
      );
    }
  });

  it.each([
    ["float32", null],
    ["float32", 1],
    ["int8", null],
    ["binary_int8_rescore", 0],
  ])("refuses unsupported quantization or invalid scale (%s, %s)", async (quantization, scale) => {
    const { indexDir, path, expected } = await smallIndex();
    chmodSync(path, 0o644);
    const db = new (sqlite.loadSqlite())(path);
    try {
      // Model an externally produced file without relying on the current writer's CHECKs.
      db.exec("ALTER TABLE meta RENAME TO original_meta");
      db.exec("CREATE TABLE meta AS SELECT * FROM original_meta");
      db.prepare("UPDATE meta SET quantization = ?, int8_scale = ?").run(quantization, scale);
    } finally {
      db.close();
    }
    expect(() => openIndexReadOnly(indexDir, expected)).toThrow(
      expect.objectContaining({ code: "INDEX_UNAVAILABLE", fileMissing: false }),
    );
  });

  it("reports a missing file as fileMissing only under an existing index directory", async () => {
    const { indexDir, expected } = await smallIndex();
    const missing = { ...expected, generationId: "zzzzzzzzzzzzzzzzzzzzzzzz" };
    expect(() => openIndexReadOnly(indexDir, missing)).toThrow(
      expect.objectContaining({ code: "INDEX_UNAVAILABLE", fileMissing: true }),
    );
    expect(() => openIndexReadOnly(join(indexDir, "absent"), expected)).toThrow(
      expect.objectContaining({ fileMissing: false }),
    );
  });

  it("refuses a WAL-format header before SQLite opens the file", async () => {
    const { indexDir, path, expected } = await smallIndex();
    const copyDir = tempDir();
    const copy = generationFilePath(copyDir, expected.kbId, expected.generationId);
    mkdirSync(dirname(copy), { recursive: true });
    const bytes = readFileSync(path);
    bytes[18] = 2;
    bytes[19] = 2;
    writeFileSync(copy, bytes);
    vi.mocked(sqlite.loadSqlite).mockClear();
    expect(() => openIndexReadOnly(copyDir, expected)).toThrow(IndexReadError);
    expect(sqlite.loadSqlite).not.toHaveBeenCalled();
    expect(sideFiles(copy)).toEqual([]);
    // Control: the unmodified file opens.
    closeIndexHandle(openIndexReadOnly(indexDir, expected));
  });

  it("refuses and closes a handle the constructor opened writable", async () => {
    const { indexDir, path, expected } = await smallIndex();
    const Real = (await vi.importActual<typeof import("./sqlite")>("./sqlite")).loadSqlite();
    let opened: InstanceType<typeof Real> | null = null;
    // A constructor that ignores the options and opens read-write.
    const Writable = function (this: unknown, file: string) {
      opened = new Real(file);
      return opened;
    } as unknown as typeof Real;
    vi.mocked(sqlite.loadSqlite).mockImplementationOnce(() => Writable);
    const before = readFileSync(path);
    expect(() => openIndexReadOnly(indexDir, expected)).toThrow(
      expect.objectContaining({ code: "INDEX_UNAVAILABLE", fileMissing: false }),
    );
    expect(opened).not.toBeNull();
    expect(opened!.readonly).toBe(false);
    expect(opened!.open).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(sideFiles(path)).toEqual([]);
  });

  it("refuses writes through an opened handle and leaves no side file during or after a task", async () => {
    const { indexDir, path, expected } = await smallIndex();
    const handle = openIndexReadOnly(indexDir, expected);
    expect(handle.db.readonly).toBe(true);
    for (const sql of [
      "INSERT INTO meta SELECT * FROM meta",
      "CREATE TABLE main.x(y)",
      "PRAGMA journal_mode=WAL",
    ])
      expect(() => handle.db.exec(sql)).toThrow(
        expect.objectContaining({ code: "SQLITE_READONLY" }),
      );
    runTask(handle, (db) => {
      db.exec("CREATE TEMP TABLE scratch(x)");
      db.prepare("INSERT INTO temp.scratch VALUES(1)").run();
      expect(sideFiles(path)).toEqual([]);
    });
    readHybridTask(handle, hybrid("alpha", testVector(9, 8), { pathPrefix: "b/" }), NO_STOP);
    expect(sideFiles(path)).toEqual([]);
    closeIndexHandle(handle);
    expect(sideFiles(path)).toEqual([]);
    expect(readdirSync(dirname(path))).toEqual([`${expected.generationId}.sqlite`]);
  });

  it("hot journal: a stray non-empty -journal beside a final file is refused, never rolled back", async () => {
    const { indexDir, path, expected } = await smallIndex();
    // A real hot journal, captured from an uncommitted write to a scratch copy.
    const scratch = join(tempDir(), "w.sqlite");
    copyFileSync(path, scratch);
    chmodSync(scratch, 0o644);
    const writable = new (sqlite.loadSqlite())(scratch);
    writable.pragma("cache_size=1");
    writable.exec("BEGIN");
    writable.exec("UPDATE documents SET metadata_json = metadata_json || ' '");
    writable.exec("CREATE TABLE junk(x)");
    const insert = writable.prepare("INSERT INTO junk VALUES(randomblob(500))");
    for (let i = 0; i < 500; i++) insert.run();
    const hot = readFileSync(`${scratch}-journal`);
    writable.exec("ROLLBACK");
    writable.close();
    expect(hot.length).toBeGreaterThan(0);
    const before = readFileSync(path);
    for (const journal of [hot, Buffer.alloc(4096, 7)]) {
      writeFileSync(`${path}-journal`, journal);
      expect(() => openIndexReadOnly(indexDir, expected)).toThrow(
        expect.objectContaining({ code: "INDEX_UNAVAILABLE", fileMissing: false }),
      );
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(readFileSync(`${path}-journal`).equals(journal)).toBe(true);
    }
    // An empty stray journal is not hot: the file reads normally.
    writeFileSync(`${path}-journal`, "");
    const handle = openIndexReadOnly(indexDir, expected);
    expect(readHybridTask(handle, hybrid("alpha", null), NO_STOP).fts.length).toBeGreaterThan(0);
    closeIndexHandle(handle);
  });
});

describe("tasks", () => {
  it("filters by prefix, document id and structured rows, and cites the matched row", async () => {
    const { indexDir, expected } = await smallIndex();
    const handle = openIndexReadOnly(indexDir, expected);
    const vector = testVector(3, 8);
    const all = readHybridTask(handle, hybrid("alpha", vector), NO_STOP);
    expect(all.vector).toHaveLength(5);
    expect(all.fts.map((hit) => hit.path)).toEqual(["a/one.md", "b/two.md"]);
    const prefixed = readHybridTask(handle, hybrid("alpha", vector, { pathPrefix: "b/" }), NO_STOP);
    expect(new Set(prefixed.vector.map((hit) => hit.path))).toEqual(new Set(["b/two.md"]));
    const byDoc = readHybridTask(
      handle,
      hybrid("alpha", vector, { documentId: "doc-one" }),
      NO_STOP,
    );
    expect(byDoc.rows.map((row) => row.path)).toEqual(["a/one.md", "a/one.md"]);
    const rowFiltered = readHybridTask(
      handle,
      hybrid("table", vector, { filters: { structured: [{ column: "k", equals: "blue" }] } }),
      NO_STOP,
    );
    expect(rowFiltered.fts.map((hit) => hit.chunkIndex)).toEqual([1]);
    expect(rowFiltered.rows).toEqual([
      expect.objectContaining({
        path: "b/two.md",
        chunkIndex: 1,
        rowIndex: 1,
        matchedRow: { k: "blue", n: 2 },
        snippet: "row 1",
        span: { startToken: 1, endToken: 2, startByte: 12, endByte: 17 },
        commitSha: expected.commitSha,
      }),
    ]);
    const metadata = readHybridTask(
      handle,
      hybrid("alpha", vector, { filters: { type: "note" } }),
      NO_STOP,
    );
    expect(new Set(metadata.rows.map((row) => row.path))).toEqual(new Set(["a/one.md"]));
    expect(
      (handle.db.prepare("SELECT count(*) AS n FROM temp.sqlite_master").get() as { n: number }).n,
    ).toBe(0);
    closeIndexHandle(handle);
  });

  it("two consecutive filtered tasks on one handle; temp state is gone after each", async () => {
    const { indexDir, expected } = await smallIndex();
    const handle = openIndexReadOnly(indexDir, expected);
    const temp = () =>
      (handle.db.prepare("SELECT count(*) AS n FROM temp.sqlite_master").get() as { n: number }).n;
    const first = readHybridTask(
      handle,
      hybrid("alpha", testVector(1, 8), { pathPrefix: "a/" }),
      NO_STOP,
    );
    expect(temp()).toBe(0);
    const second = readHybridTask(
      handle,
      hybrid("alpha", testVector(1, 8), { pathPrefix: "b/" }),
      NO_STOP,
    );
    expect(temp()).toBe(0);
    expect(first.rows.every((row) => row.path === "a/one.md")).toBe(true);
    expect(second.rows.every((row) => row.path === "b/two.md")).toBe(true);
    closeIndexHandle(handle);
  });

  it("a filtered task aborted mid-eligibility, then an unfiltered task returns unfiltered results", async () => {
    const { indexDir, expected } = await smallIndex();
    const handle = openIndexReadOnly(indexDir, expected);
    let checks = 0;
    const stopAfterTwo: TaskControl = {
      check() {
        checks += 1;
        if (checks > 2) throw new IndexTaskStopped("aborted");
      },
    };
    expect(() =>
      readHybridTask(handle, hybrid("alpha", testVector(1, 8), { pathPrefix: "b/" }), stopAfterTwo),
    ).toThrow(IndexTaskStopped);
    expect(handle.db.inTransaction).toBe(false);
    const unfiltered = readHybridTask(handle, hybrid("alpha", testVector(1, 8)), NO_STOP);
    expect(new Set(unfiltered.vector.map((hit) => hit.path))).toEqual(
      new Set(["a/one.md", "b/two.md"]),
    );
    closeIndexHandle(handle);
  });

  it("deadline and abort flag stop a task at its next check", async () => {
    const { indexDir, expected } = await smallIndex();
    const handle = openIndexReadOnly(indexDir, expected);
    const flag = new Int32Array(new SharedArrayBuffer(4));
    Atomics.store(flag, 0, 1);
    const { taskControl } = await import("./reader");
    expect(() =>
      readHybridTask(handle, hybrid("alpha", null), taskControl(flag, Date.now() + 60_000)),
    ).toThrow(expect.objectContaining({ status: "aborted" }));
    expect(() =>
      readHybridTask(
        handle,
        hybrid("alpha", null),
        taskControl(new Int32Array(new SharedArrayBuffer(4)), 0),
      ),
    ).toThrow(expect.objectContaining({ status: "deadline" }));
    closeIndexHandle(handle);
  });

  it("queryless pages matched rows in (path, row index) order after the keyset", async () => {
    const { indexDir, expected } = await smallIndex();
    const handle = openIndexReadOnly(indexDir, expected);
    const rows = readQuerylessTask(
      handle,
      {
        pathPrefix: null,
        documentId: null,
        filters: { structured: [{ column: "n", equals: 2 }] },
        after: null,
        limit: 5,
      },
      NO_STOP,
    );
    expect(rows.map((row) => [row.path, row.rowIndex, row.chunkIndex])).toEqual([
      ["b/two.md", 1, 1],
    ]);
    const metadata = readQuerylessTask(
      handle,
      { pathPrefix: null, documentId: null, filters: {}, after: null, limit: 2 },
      NO_STOP,
    );
    expect(metadata.map((row) => [row.path, row.rowIndex, row.chunkIndex])).toEqual([
      ["a/one.md", -1, 0],
      ["b/two.md", -1, 0],
    ]);
    const after = readQuerylessTask(
      handle,
      {
        pathPrefix: null,
        documentId: null,
        filters: {},
        after: { path: "a/one.md", rowIndex: -1 },
        limit: 5,
      },
      NO_STOP,
    );
    // c/empty.md matches the metadata filter but has no chunk, so it never appears.
    expect(after.map((row) => row.path)).toEqual(["b/two.md"]);
    closeIndexHandle(handle);
  });

  it("a ROLLBACK forced to fail closes the handle; the thread cache reopens it for the next task", async () => {
    const { indexDir, expected } = await smallIndex();
    const opened: Array<import("./reader").IndexHandle> = [];
    const state = createReaderThreadState(
      { kbIndexReader: true, indexDir, handleConfirmMs: 600_000, maxHandles: 16 },
      { opened: (handle) => opened.push(handle) },
    );
    const task = (id: number) => ({
      type: "task" as const,
      id,
      task: { kind: "hybrid" as const, input: hybrid("alpha", null) },
      expected,
      active: true,
      abort: new Int32Array(new SharedArrayBuffer(4)),
      deadlineAt: Date.now() + 60_000,
      now: 0,
    });
    expect(state.handle(task(1))).toMatchObject({ status: "ok" });
    const handle = opened[0]!;
    // Test seam: an unfinished cursor makes ROLLBACK throw "busy".
    expect(() =>
      runTask(handle, (db) => {
        db.prepare("SELECT id FROM chunks").iterate().next();
      }),
    ).not.toThrow();
    expect(handle.closed).toBe(true);
    expect(state.handle(task(2))).toMatchObject({ status: "ok" });
    expect(opened).toHaveLength(2);
    expect(state.handle({ type: "stats" })).toEqual({
      type: "stats",
      opens: 2,
      handles: [expected.generationId],
    });
    state.close();
  });

  it("reader.ts never uses .iterate( and has exactly one new Database(", () => {
    const source = readFileSync(new URL("./reader.ts", import.meta.url), "utf8");
    expect(source).not.toContain(".iterate(");
    expect(source.match(/new Database\(/g)).toHaveLength(1);
  });
});

describe("queryless paging at scale", () => {
  it("seeks across document batches and row boundaries without gaps or repeats", async () => {
    const indexDir = tempDir();
    const documents = Array.from({ length: 258 }, (_, i) => ({
      path: `docs/${String(i).padStart(3, "0")}.md`,
      documentId: "shared",
      chunks: ["first", "second"],
      rows: [tableRow(0, { kind: "cell" }, 0), tableRow(1, { kind: "cell" }, 10)],
    }));
    const built = await buildTestIndex({
      indexDir,
      lexical: true,
      documents: [
        ...documents,
        { ...documents[0]!, path: "docs/other.md", documentId: "other" },
        { ...documents[0]!, path: "outside.md" },
      ],
    });
    const handle = openIndexReadOnly(indexDir, built.expected);
    const prepare = vi.spyOn(handle.db, "prepare");
    const input = {
      pathPrefix: "docs/",
      documentId: "shared",
      filters: { structured: [{ column: "kind", equals: "cell" }] },
    };
    try {
      const all = readQuerylessTask(handle, { ...input, after: null, limit: 1000 }, NO_STOP);
      expect(all.map((row) => [row.path, row.rowIndex])).toEqual(
        documents.flatMap((doc) => [
          [doc.path, 0],
          [doc.path, 1],
        ]),
      );
      // End immediately before the document-batch boundary, inside docs/255.md.
      const first = readQuerylessTask(handle, { ...input, after: null, limit: 511 }, NO_STOP);
      const tail = first.at(-1)!;
      expect([tail.path, tail.rowIndex]).toEqual(["docs/255.md", 0]);
      const rest = readQuerylessTask(
        handle,
        { ...input, after: { path: tail.path, rowIndex: tail.rowIndex }, limit: 1000 },
        NO_STOP,
      );
      expect(rest[0]).toMatchObject({ path: "docs/255.md", rowIndex: 1 });
      expect([...first, ...rest]).toEqual(all);
      expect(
        readQuerylessTask(handle, { ...input, after: all.at(-1)!, limit: 10 }, NO_STOP),
      ).toEqual([]);
      const statements = prepare.mock.calls.map(([sql]) => sql);
      prepare.mockRestore();
      const documentNext = statements.find((sql) => sql.includes("WHERE path > @after"));
      const rowNext = statements.find((sql) => sql.includes("WHERE (path,row_index) >"));
      expect(documentNext).toBeDefined();
      expect(rowNext).toBeDefined();
      runTask(handle, (db) => {
        prepareEligible(db, input, NO_STOP);
        for (const [sql, params] of [
          [
            documentNext!,
            { after: tail.path, prefix: input.pathPrefix, documentId: "shared", limit: 256 },
          ],
          [rowNext!, { path: tail.path, rowIndex: tail.rowIndex, limit: 10 }],
        ] as const) {
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{
            detail: string;
          }>;
          expect(plan.some(({ detail }) => detail.startsWith("SEARCH "))).toBe(true);
          expect(plan.some(({ detail }) => detail.startsWith("SCAN "))).toBe(false);
        }
      });
    } finally {
      prepare.mockRestore();
      closeIndexHandle(handle);
    }
  });

  it("400k row links, 5,000 matched rows, limit 101: bounded check gaps and exact keyset pages", async () => {
    const indexDir = tempDir();
    // 20 documents x 400 overlapping 1,000-byte chunks; 250 disjoint 10-byte rows per document,
    // so every chunk intersects ~50 rows (≈400k links) and every row matches.
    const rowsPerDoc = 250;
    const documents = Array.from({ length: 20 }, (_, d) => ({
      path: `t/${String(d).padStart(2, "0")}.md`,
      chunks: Array.from({ length: 400 }, (_, c) => `cell ${d} ${c}`),
      spans: Array.from({ length: 400 }, (_, c) => ({ startByte: c * 10, endByte: c * 10 + 1000 })),
      rows: Array.from({ length: rowsPerDoc }, (_, r) => tableRow(r, { kind: "cell", r }, r * 20)),
    }));
    const built = await buildTestIndex({ indexDir, documents, vectorBatch: 8000 });
    const handle = openIndexReadOnly(indexDir, built.expected);
    const filters = { structured: [{ column: "kind", equals: "cell" }] };
    const links = runTask(handle, (db) => {
      prepareEligible(db, { pathPrefix: null, documentId: null, filters }, NO_STOP);
      return (db.prepare("SELECT count(*) AS n FROM temp.row_links").get() as { n: number }).n;
    });
    expect(links).toBeGreaterThan(380_000);
    let last = Date.now();
    let maxGap = 0;
    let checks = 0;
    const timed: TaskControl = {
      check() {
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        checks += 1;
      },
    };
    const page = (after: { path: string; rowIndex: number } | null, ctl: TaskControl = NO_STOP) =>
      readQuerylessTask(
        handle,
        { pathPrefix: null, documentId: null, filters, after, limit: 101 },
        ctl,
      );
    last = Date.now();
    const first = page(null, timed);
    maxGap = Math.max(maxGap, Date.now() - last);
    expect(checks).toBeGreaterThan(300);
    // Every statement between two cancellation checks stays short (was one 8 s statement).
    expect(maxGap).toBeLessThan(1000);
    expect(first).toHaveLength(101);
    expect(first.slice(0, 3).map((row) => [row.path, row.rowIndex, row.chunkIndex])).toEqual([
      ["t/00.md", 0, 0],
      ["t/00.md", 1, 0],
      ["t/00.md", 2, 0],
    ]);
    // Row r (bytes [20r, 20r+5)) first intersects chunk max(0, ceil((20r + 5 - 1000) / 10)).
    for (const row of first)
      expect(row.chunkIndex).toBe(Math.max(0, Math.floor((row.rowIndex * 20 + 5 - 1000) / 10) + 1));
    // Keyset continuation crosses a document boundary without gaps or repeats.
    const seen: string[] = [];
    let after: { path: string; rowIndex: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const rows = page(after);
      seen.push(...rows.map((row) => `${row.path}:${row.rowIndex}`));
      const tail = rows.at(-1)!;
      after = { path: tail.path, rowIndex: tail.rowIndex };
    }
    expect(seen).toEqual(
      Array.from(
        { length: 303 },
        (_, i) => `t/0${Math.floor(i / rowsPerDoc)}.md:${i % rowsPerDoc}`,
      ),
    );
    // Cancellation during eligibility stops the task.
    let n = 0;
    expect(() =>
      page(null, {
        check() {
          n += 1;
          if (n === 200) throw new IndexTaskStopped("aborted");
        },
      }),
    ).toThrow(IndexTaskStopped);
    expect(handle.db.inTransaction).toBe(false);
    closeIndexHandle(handle);
  }, 120_000);
});

describe("eligibility cancellation gaps", () => {
  it("very large, mostly non-matching documents are scanned in bounded batches with checks", async () => {
    const indexDir = tempDir();
    // 3 documents x 100,000 chunks; the only matching row intersects each document's first chunk.
    const perDoc = 100_000;
    const documents = Array.from({ length: 3 }, (_, d) => ({
      path: `big/${d}.md`,
      chunks: Array.from({ length: perDoc }, (_, c) => `c${c % 13}`),
      rows: [tableRow(0, { hit: "yes" }, 0), tableRow(1, { hit: "no" }, 20)],
    }));
    const built = await buildTestIndex({ indexDir, documents, vectorBatch: 20_000 });
    const handle = openIndexReadOnly(indexDir, built.expected);
    for (const [name, filters] of [
      ["row filter", { structured: [{ column: "hit", equals: "yes" }] }],
      ["metadata filter", { tags: [] }],
    ] as const) {
      let last = Date.now();
      let maxGap = 0;
      let checks = 0;
      const timed: TaskControl = {
        check() {
          const now = Date.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
          checks += 1;
        },
      };
      last = Date.now();
      const eligibility = runTask(handle, (db) =>
        prepareEligible(db, { pathPrefix: null, documentId: null, filters }, timed),
      );
      maxGap = Math.max(maxGap, Date.now() - last);
      // ≥ one check per 1,024 scanned chunks, skipped chunks included.
      expect(checks, name).toBeGreaterThanOrEqual((3 * perDoc) / 1024);
      expect(maxGap, name).toBeLessThan(250);
      expect(eligibility.chunks, name).toBe(name === "row filter" ? 3 : 3 * perDoc);
    }
    // Cancellation mid-document stops promptly.
    let n = 0;
    expect(() =>
      readHybridTask(
        handle,
        hybrid("c1", null, { filters: { structured: [{ column: "hit", equals: "yes" }] } }),
        {
          check() {
            n += 1;
            if (n === 100) throw new IndexTaskStopped("aborted");
          },
        },
      ),
    ).toThrow(IndexTaskStopped);
    closeIndexHandle(handle);
  }, 180_000);
});

describe("slices", () => {
  it("FTS winners equal the full metadata-joined ranking across ties, slices and filters", async () => {
    const indexDir = tempDir();
    const built = await buildTestIndex({
      indexDir,
      dimensions: 8,
      documents: ["a/one.md", "a/two.md", "b/one.md", "b/two.md"].map((path) => ({
        path,
        chunks: Array.from({ length: 100 }, (_, i) =>
          i % 3 === 0 ? "alpha alpha beta" : i % 3 === 1 ? "alpha beta" : "beta gamma gamma",
        ),
      })),
    });
    const handle = openIndexReadOnly(indexDir, built.expected);
    try {
      for (const pathPrefix of [null, "a/"]) {
        runTask(handle, (db) => {
          const eligible = prepareEligible(
            db,
            { pathPrefix, documentId: null, filters: null },
            NO_STOP,
          );
          for (const text of ["alpha", "gamma", "absent"]) {
            // Reference ranking uses the old full join and explicit path/index tie order.
            const expected = db
              .prepare(
                `SELECT c.id AS id,c.path AS path,c.chunk_index AS chunkIndex,bm25(chunk_fts) AS score
                FROM chunk_fts JOIN chunks c ON c.id=chunk_fts.rowid WHERE chunk_fts MATCH ?
                ${eligible.filtered ? "AND +chunk_fts.rowid IN (SELECT id FROM temp.eligible)" : ""}
                ORDER BY score,c.path,c.chunk_index LIMIT ?`,
              )
              .all(ftsQuery(text), 17);
            expect(ftsArm(db, handle.meta, text, eligible, NO_STOP, 17, 31)).toEqual(expected);
          }
        });
      }
    } finally {
      closeIndexHandle(handle);
    }
  });

  it("vec0 per-slice KNN merged equals the unsliced KNN (70,000 chunks, 2 partitions)", async () => {
    const indexDir = tempDir();
    const documents = Array.from({ length: 70 }, (_, d) => ({
      path: `d/${String(d).padStart(3, "0")}.md`,
      chunks: Array.from({ length: 1000 }, (_, c) => `w${c % 7} t${d}`),
    }));
    const built = await buildTestIndex({
      indexDir,
      documents,
      quantization: "int8",
      dimensions: 8,
      vectorBatch: 10_000,
    });
    const handle = openIndexReadOnly(indexDir, built.expected);
    const query = testVector(424_242, 8);
    const sliced = vectorArm(handle.db, handle.meta, query, UNFILTERED, NO_STOP);
    const unsliced = handle.db
      .prepare(
        "SELECT v.rowid AS id, v.distance AS score FROM chunk_vec v WHERE v.embedding MATCH vec_int8(?) AND v.k = 80",
      )
      .all(int8Bytes(quantizeInt8(unitVector(query, 8), handle.meta.int8Scale!))) as Array<{
      id: number;
      score: number;
    }>;
    unsliced.sort((a, b) => a.score - b.score || a.id - b.id);
    expect(sliced.map((hit) => hit.id)).toEqual(unsliced.map((hit) => hit.id));
    expect(new Set(sliced.map((hit) => (hit.id - 1) >> 16)).size).toBe(2);
    // FTS: forced small slices merge to the same order as one slice.
    const oneSlice = ftsArm(handle.db, handle.meta, "w3", UNFILTERED, NO_STOP, 80, 1_000_000);
    const manySlices = ftsArm(handle.db, handle.meta, "w3", UNFILTERED, NO_STOP, 80, 7_001);
    expect(manySlices).toEqual(oneSlice);
    expect(ftsQuery("w3")).toBe('"w3"');
    closeIndexHandle(handle);
  });

  it("binary hamming per slice merged equals one slice; rescore ranks by int8 cosine", async () => {
    const indexDir = tempDir();
    const documents = Array.from({ length: 30 }, (_, d) => ({
      path: `d/${String(d).padStart(3, "0")}.md`,
      chunks: Array.from({ length: 100 }, (_, c) => `x${c}`),
    }));
    const built = await buildTestIndex({
      indexDir,
      documents,
      quantization: "binary_int8_rescore",
      dimensions: 12,
    });
    const handle = openIndexReadOnly(indexDir, built.expected);
    const query = testVector(31_337, 12);
    const whole = vectorArm(handle.db, handle.meta, query, UNFILTERED, NO_STOP, 80, 1_000_000);
    const sliced = vectorArm(handle.db, handle.meta, query, UNFILTERED, NO_STOP, 80, 97);
    expect(sliced).toEqual(whole);
    expect(whole).toHaveLength(80);
    for (let i = 1; i < whole.length; i++)
      expect(
        whole[i]!.score > whole[i - 1]!.score ||
          (whole[i]!.score === whole[i - 1]!.score && whole[i]!.id > whole[i - 1]!.id),
      ).toBe(true);
    closeIndexHandle(handle);
  });
});

describe("binary_int8_rescore oracle", () => {
  it("with K >= n the arm equals an exact dequantized int8 cosine ranking, ties by id", async () => {
    const dims = 16;
    // 60 chunks; ids 1-3, 10-12 and 40-41 share vectors, so their distances tie exactly.
    const groups = new Map([
      [2, 1],
      [3, 1],
      [11, 10],
      [12, 10],
      [41, 40],
    ]);
    const vectorFor = (id: number, d: number) => testVector(groups.get(id) ?? id, d);
    const indexDir = tempDir();
    const built = await buildTestIndex({
      indexDir,
      quantization: "binary_int8_rescore",
      dimensions: dims,
      vectorFor,
      documents: Array.from({ length: 6 }, (_, d) => ({
        path: `o/${d}.md`,
        chunks: Array.from({ length: 10 }, (_, c) => `o ${d} ${c}`),
      })),
    });
    const handle = openIndexReadOnly(indexDir, built.expected);
    const n = built.expected.chunkCount;
    expect(rescoreK(n)).toBeGreaterThanOrEqual(n);
    const scale = handle.meta.int8Scale!;
    // Independent oracle: stored int8 bytes from the file, query quantized here from the
    // spec formula, cosine over the dequantized (x * scale / 127) components in f64.
    const stored = handle.db.prepare("SELECT id, e FROM chunk_int8 ORDER BY id").all() as Array<{
      id: number;
      e: Buffer;
    }>;
    const raw = testVector(777, dims);
    const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0));
    const query = raw.map((x) => {
      const q = (Math.fround(x / norm) * 127) / scale;
      return Math.max(-127, Math.min(127, Math.sign(q) * Math.round(Math.abs(q))));
    });
    const dequantize = (values: ArrayLike<number>) =>
      Array.from(values, (value) => (value * scale) / 127);
    const cosineDistance = (a: number[], b: number[]) => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return 1 - dot / Math.sqrt(na * nb);
    };
    const q = dequantize(query);
    const oracle = stored
      .map(({ id, e }) => ({
        id,
        distance: cosineDistance(
          q,
          dequantize(new Int8Array(e.buffer, e.byteOffset, e.byteLength)),
        ),
      }))
      .sort((a, b) => a.distance - b.distance || a.id - b.id);
    const arm = vectorArm(handle.db, handle.meta, raw, UNFILTERED, NO_STOP, n);
    expect(arm.map((hit) => hit.id)).toEqual(oracle.map((row) => row.id));
    for (const [i, hit] of arm.entries()) expect(hit.score).toBeCloseTo(oracle[i]!.distance, 5);
    // The tied groups really tie and keep ascending id order.
    for (const [first, rest] of [
      [1, [2, 3]],
      [10, [11, 12]],
      [40, [41]],
    ] as const) {
      const at = arm.findIndex((hit) => hit.id === first);
      rest.forEach((id, k) => {
        expect(arm[at + k + 1]!.id).toBe(id);
        expect(arm[at + k + 1]!.score).toBe(arm[at]!.score);
      });
    }
    closeIndexHandle(handle);
  });
});

describe("kb id layout", () => {
  it("files live under <indexDir>/<kbId>/", async () => {
    const { indexDir } = await smallIndex();
    expect(readdirSync(indexDir)).toEqual([TEST_KB_ID]);
  });
});
