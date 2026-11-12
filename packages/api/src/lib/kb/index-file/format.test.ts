import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import normalization from "../../../../../test-utils/src/kb/embedding-normalization.json" with {
  type: "json",
};
import ftsCorpus from "../fixtures/fts-query.json" with { type: "json" };
import cases from "../fixtures/index-quantization-cases.json" with { type: "json" };
import {
  attemptTempPath,
  binaryBits,
  bitDimensions,
  calibrationIds,
  chunkTextHash,
  float32Bytes,
  ftsMatch,
  ftsUnits,
  generationFilePath,
  INDEX_FORMAT,
  INDEX_QUANTIZATIONS,
  indexedRowsForDocument,
  indexPragmas,
  int8Scale,
  pad8,
  perChunkBytes,
  quantizeInt8,
  READABLE_INDEX_FORMATS,
  renderIndexDdl,
  rescoreK,
  rowBytes,
  sliceBounds,
  sliceOf,
  unitVector,
  VECTOR_REUSE_MIN_FRACTION,
  vectorBytesPerChunk,
} from "./format";
import { ftsArm, NO_STOP } from "./reader";
import { loadSqlite, loadVec } from "./sqlite";
import { buildTestIndex, testVector } from "./testing";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-index-format-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hex = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");

describe("index format DDL", () => {
  it("renders one schema per quantization from validated integers only", () => {
    expect(indexPragmas()).toEqual([
      "PRAGMA page_size=4096",
      "PRAGMA journal_mode=DELETE",
      "PRAGMA synchronous=OFF",
    ]);
    expect(renderIndexDdl("int8", 12).at(-1)).toContain(
      "embedding int8[12] distance_metric=cosine",
    );
    const binary = renderIndexDdl("binary_int8_rescore", 12);
    expect(binary.slice(-2)).toEqual([
      "CREATE TABLE chunk_bits(id INTEGER PRIMARY KEY, b BLOB NOT NULL) STRICT",
      "CREATE TABLE chunk_int8(id INTEGER PRIMARY KEY, e BLOB NOT NULL) STRICT",
    ]);
    for (const quantization of INDEX_QUANTIZATIONS)
      for (const sql of renderIndexDdl(quantization, 7)) expect(sql).not.toMatch(/\{\w+\}/);
    for (const dims of [0, 2001, 1.5, Number.NaN])
      expect(() => renderIndexDdl("int8", dims)).toThrow();
    expect(() => renderIndexDdl("float16" as never, 8)).toThrow();
    expect(() => renderIndexDdl("float32" as never, 8)).toThrow();
  });

  it("executes on a fresh database and creates every table", () => {
    const Database = loadSqlite();
    for (const quantization of INDEX_QUANTIZATIONS) {
      const db = new Database(":memory:");
      loadVec(db);
      for (const sql of renderIndexDdl(quantization, 12)) db.exec(sql);
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(names).toEqual(expect.arrayContaining(["chunk_fts", "chunks", "documents", "meta"]));
      expect(names).toEqual(
        expect.arrayContaining(
          quantization === "binary_int8_rescore" ? ["chunk_bits", "chunk_int8"] : ["chunk_vec"],
        ),
      );
      db.close();
    }
  });

  it("builds paths only from validated ids", () => {
    const kb = "a".repeat(24);
    const gen = "b".repeat(32);
    expect(generationFilePath("/d/index", kb, gen)).toBe(`/d/index/${kb}/${gen}.sqlite`);
    expect(attemptTempPath("/d/index", kb, gen, 3)).toBe(`/d/index/${kb}/${gen}.a3.tmp`);
    for (const bad of ["../x", "A".repeat(24), "a".repeat(23), "a".repeat(33)]) {
      expect(() => generationFilePath("/d", bad, gen)).toThrow();
      expect(() => generationFilePath("/d", kb, bad)).toThrow();
    }
    expect(() => attemptTempPath("/d", kb, gen, 0)).toThrow();
  });
});

describe("slices and the rescore K rule", () => {
  it("K(n) = min(2000, max(200, ceil(n/200)))", () => {
    expect(
      [0, 1, 40_000, 40_001, 80_000, 200_000, 399_800, 399_801, 400_000, 400_001, 4_000_000].map(
        rescoreK,
      ),
    ).toEqual([200, 200, 200, 201, 400, 1000, 1999, 2000, 2000, 2000, 2000]);
  });

  it("slice = (id-1) >> 16 and bounds cover 1..n", () => {
    expect([1, 65_536, 65_537, 131_073].map(sliceOf)).toEqual([0, 0, 1, 2]);
    expect(sliceBounds(0, 65_536)).toEqual([]);
    expect(sliceBounds(65_537, 65_536)).toEqual([
      [1, 65_536],
      [65_537, 65_537],
    ]);
  });
});

describe("quantization (§1.4)", () => {
  it("normalizes to f32 unit vectors and refuses invalid input", () => {
    expect([...unitVector([3, -4], 2)]).toEqual([Math.fround(0.6), Math.fround(-0.8)]);
    expect(() => unitVector([1, 2], 3)).toThrow();
    expect(() => unitVector([0, 0], 2)).toThrow();
    expect(() => unitVector([1, Number.NaN], 2)).toThrow();
    expect(() => unitVector([1, Number.POSITIVE_INFINITY], 2)).toThrow();
  });

  it("normalizes recorded real built-in model output to the bytes the CLI also produces", () => {
    // Raw pooled vectors (norms ~100-1200) from the real Qwen and Gemma runtimes; the CLI's
    // index_format::unit_vector asserts the same bytes (server/CLI normalization parity).
    const models = Object.entries(normalization.models);
    expect(models.map(([id]) => id).sort()).toEqual([
      "embeddinggemma-2-q8_0",
      "qwen3-embedding-0.6b-q8_0",
    ]);
    for (const [, rows] of models)
      for (const row of rows) {
        expect(Math.hypot(...row.raw)).toBeGreaterThan(10);
        const unit = unitVector(row.raw, row.raw.length);
        expect(Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength).toString("hex")).toBe(
          row.unitF32Hex,
        );
      }
  });

  it("samples calibration ids deterministically", () => {
    expect(calibrationIds(0)).toEqual([]);
    expect(calibrationIds(5)).toEqual([1, 2, 3, 4, 5]);
    expect(calibrationIds(4096)).toHaveLength(4096);
    const stride2 = calibrationIds(4097);
    expect(stride2.slice(0, 3)).toEqual([1, 3, 5]);
    expect(stride2).toHaveLength(2049);
    expect(calibrationIds(1_000_000)).toEqual(calibrationIds(1_000_000));
    expect(calibrationIds(1_000_000)[1]).toBe(1 + Math.ceil(1_000_000 / 4096));
  });

  it("computes the 0.999 quantile scale deterministically and refuses a zero scale", () => {
    const units = [1, 2, 3, 4, 5].map((id) => unitVector(testVector(id, 64), 64));
    expect(int8Scale(units)).toBe(int8Scale([...units].reverse()));
    expect(() => int8Scale([])).toThrow();
    expect(() => int8Scale([new Float32Array(4)])).toThrow();
  });

  it("falls back to the sample maximum when the 0.999 quantile is 0 (very sparse vectors)", () => {
    const raw = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 3 : i === 1000 ? -4 : 0));
    const unit = unitVector(raw, 1024);
    expect(int8Scale([unit])).toBe(Math.fround(0.8));
    expect(cases.cases.map((testCase) => testCase.name)).toContain(
      "dims1024-sparse-quantile-zero-max-fallback",
    );
  });

  it("rounds half away from zero and clamps to ±127", () => {
    // scale 127 makes q = u exactly, so the halves are exact.
    const unit = new Float32Array([0.5, -0.5, 1.5, 2.5, -2.5, 200, -200]);
    expect([...quantizeInt8(unit, 127)]).toEqual([1, -1, 2, 3, -3, 127, -127]);
    expect(() => quantizeInt8(unit, 0)).toThrow();
  });

  it("pads bits with zeros to a multiple of 8 (dims=12 → bit[16])", () => {
    expect(bitDimensions(12)).toBe(16);
    expect(bitDimensions(1024)).toBe(1024);
    const unit = unitVector([1, -1, 1, -1, 1, -1, 1, -1, 1, 1, 1, 1], 12);
    expect(pad8(unit)).toHaveLength(16);
    expect(hex(binaryBits(unit))).toBe("550f");
  });

  it("matches sqlite-vec vec_quantize_binary for every fixture vector", () => {
    const db = new (loadSqlite())(":memory:");
    loadVec(db);
    const quantize = db.prepare("SELECT vec_quantize_binary(vec_f32(?)) AS b");
    for (const testCase of cases.cases)
      for (const raw of testCase.vectors) {
        const unit = unitVector(raw, testCase.dims);
        const sql = (quantize.get(float32Bytes(pad8(unit))) as { b: Buffer }).b;
        expect(hex(sql)).toBe(hex(binaryBits(unit)));
      }
    db.close();
  });

  it("reproduces the shared TS/Rust quantization cases", () => {
    expect(cases.cases.map((testCase) => testCase.dims)).toContain(12);
    for (const testCase of cases.cases) {
      const units = testCase.vectors.map((raw) => unitVector(raw, testCase.dims));
      expect(units.map((unit) => hex(new Uint8Array(unit.buffer)))).toEqual(testCase.unitF32LeHex);
      const scale = int8Scale(units);
      expect(scale).toBe(testCase.int8Scale);
      expect(units.map((unit) => [...quantizeInt8(unit, scale)])).toEqual(testCase.int8);
      expect(units.map((unit) => hex(binaryBits(unit)))).toEqual(testCase.bitsHex);
    }
  });
});

describe("format 1 chunk hashes", () => {
  it("hashes the stored chunk text exactly as the shared cases (CLI twin)", () => {
    for (const { text, sha256Hex } of cases.chunkHashCases)
      expect(chunkTextHash(text).toString("hex")).toBe(sha256Hex);
    expect(INDEX_FORMAT).toBe(1);
    expect(READABLE_INDEX_FORMATS).toEqual([1]);
    expect(VECTOR_REUSE_MIN_FRACTION).toBe(0.5);
    expect(
      renderIndexDdl("int8", 4).some((sql) => sql.startsWith("CREATE TABLE chunk_hash(")),
    ).toBe(true);
  });
});

describe("ftsUnits / ftsArm", () => {
  it("matches the shared corpus: units, exact phrases, AND inside punctuated words, stopwords", () => {
    for (const { query, units } of ftsCorpus.queries) expect(ftsUnits(query), query).toEqual(units);
    expect(ftsMatch([])).toBe('""');
  });

  it("ranks by units matched then bm25, with the hybrid majority floor, exactly as the shared corpus (CLI twin)", () => {
    const Database = loadSqlite();
    const db = new Database(":memory:");
    try {
      const fts = renderIndexDdl("int8", 1).find((sql) => sql.includes("USING fts5"))!;
      db.exec(
        "CREATE TABLE chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL)",
      );
      db.exec(fts);
      const insert = db.prepare("INSERT INTO chunks VALUES(?,?,0,?)");
      const paths = Object.keys(ftsCorpus.ranking.documents).sort();
      paths.forEach((path, at) => {
        insert.run(
          at + 1,
          path,
          ftsCorpus.ranking.documents[path as keyof typeof ftsCorpus.ranking.documents],
        );
      });
      db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')");
      const meta = { chunkCount: paths.length } as Parameters<typeof ftsArm>[1];
      const unfiltered = { filtered: false, rowFiltered: false, chunks: paths.length };
      for (const { query, expected, hybrid } of ftsCorpus.ranking.cases) {
        expect(
          ftsArm(db, meta, query, unfiltered, NO_STOP).map((hit) => hit.path),
          query,
        ).toEqual(expected);
        expect(
          ftsArm(db, meta, query, unfiltered, NO_STOP, 80, 2, true).map((hit) => hit.path),
          `${query} (hybrid, sliced)`,
        ).toEqual(hybrid);
      }
    } finally {
      db.close();
    }
  });
});

describe("indexedRowsForDocument", () => {
  it("keeps safe rows with a citation snippet and drops credential-bearing rows", () => {
    const body = "| k | v |\n|---|---|\n| a | 1 |\n| b | sk-proj-abcdefghijklmnopqrstuvwxyz |\n";
    const span = (start: number, end: number) => ({
      startToken: 0,
      endToken: 1,
      startByte: start,
      endByte: end,
    });
    const first = body.indexOf("| a");
    const second = body.indexOf("| b");
    const rows = indexedRowsForDocument(body, [
      { rowIndex: 0, values: { k: "a", v: 1 }, span: span(first, first + 9) },
      { rowIndex: 1, values: { k: "b", v: "x" }, span: span(second, body.length - 1) },
      {
        rowIndex: 2,
        values: { "sk-proj-abcdefghijklmnopqrstuvwxyz": 1 },
        span: span(first, first + 9),
      },
    ]);
    expect(rows).toEqual([
      { rowIndex: 0, values: { k: "a", v: 1 }, span: span(first, first + 9), snippet: "a 1" },
    ]);
  });
});

describe("byte estimates", () => {
  it("rowBytes covers the measured plain-table rows (128 B → 141.8, 1024 B → 1368.8)", () => {
    expect(rowBytes(128)).toBeGreaterThanOrEqual(142);
    expect(rowBytes(1024)).toBeGreaterThanOrEqual(1369);
    expect(vectorBytesPerChunk("int8", 1024)).toBeGreaterThanOrEqual(1052);
  });

  it.each(INDEX_QUANTIZATIONS)("perChunkBytes bounds a real %s file", async (quantization) => {
    const dims = 64;
    const text = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do";
    const documents = Array.from({ length: 40 }, (_, d) => ({
      path: `d/${String(d).padStart(3, "0")}.md`,
      chunks: Array.from({ length: 50 }, (_, c) => `${text} ${d} ${c}`),
    }));
    const built = await buildTestIndex({
      indexDir: tempDir(),
      documents,
      quantization,
      dimensions: dims,
    });
    const chunks = built.expected.chunkCount;
    const estimate = chunks * perChunkBytes(quantization, dims, Buffer.byteLength(`${text} 00 00`));
    expect(statSync(built.path).size).toBeLessThanOrEqual(estimate + 64 * 4096);
  });
});
