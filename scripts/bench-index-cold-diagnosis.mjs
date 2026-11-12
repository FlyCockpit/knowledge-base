#!/usr/bin/env node
/** Opt-in Linux diagnosis. Build with bench-index-quantization latency --keep-files first.
 * Calls readHybridTask unchanged, timing its stages at SQL prepare boundaries. Cold means the
 * target file is evicted before each task; earlier stages can warm pages for later stages.
 * /proc/self/io read_bytes counts physical reads including kernel readahead, not logical bytes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  closeIndexHandle,
  NO_STOP,
  openIndexReadOnly,
  readHybridTask,
} from "../packages/api/src/lib/kb/index-file/reader.ts";
import { redactForEmbed } from "../packages/api/src/lib/kb/redact-for-embed.ts";
import {
  benchId,
  createEvictor,
  frequentTerms,
  hostRecord,
  loadFiqa,
  parseArgs,
  percentile,
  summarize,
  VectorCache,
} from "./bench-index-quantization.mjs";

const { options } = parseArgs(["diagnose", ...process.argv.slice(2)]);
for (const key of ["index-dir", "vectors", "data", "out"])
  if (!options[key]) throw new Error(`--${key} is required`);
const indexDir = resolve(options["index-dir"]);
const vectorsDir = resolve(options.vectors);
const samples = Number(options.samples ?? 3);
const repeats = Number(options.repeats ?? 2);
const termCount = Number(options.terms ?? samples);
const queryStep = Number(options["query-step"] ?? 200 / samples);
const latency = JSON.parse(readFileSync(join(indexDir, "..", "latency-results.json"), "utf8"));
const quantization = String(options.quantization ?? "binary_int8_rescore");
const code = { binary_int8_rescore: "b", int8: "i" }[quantization];
if (
  !code ||
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 20 ||
  !Number.isInteger(termCount) ||
  termCount < 0 ||
  termCount > 20 ||
  !Number.isFinite(queryStep) ||
  queryStep <= 0 ||
  Math.floor((samples - 1) * queryStep) >= 200 ||
  !Number.isInteger(repeats) ||
  repeats < 1
)
  throw new Error("Expected int8|binary_int8_rescore, 1..20 samples and positive repeats");
const kbId = benchId(`kblat${code}`, 400000);
const expected = {
  kbId,
  generationId: benchId(`genlat${code}`, 400000),
  commitSha: "b".repeat(40),
  fingerprint: "bench-index-quantization",
  dimensions: 1024,
  chunkCount: 400000,
  documentCount: 4096,
};
const queries = JSON.parse(readFileSync(join(vectorsDir, "queries.json"), "utf8"));
const cache = VectorCache.readAll(join(vectorsDir, "queries.f32"), 1024);
const fiqa = loadFiqa(options.data);
const terms = frequentTerms(
  fiqa.corpus.map((d) => `${d.title ?? ""}\n\n${d.text}`),
  termCount,
);
const tasks = [];
for (const pathPrefix of [null, "a/"])
  for (const kind of ["query", "term"])
    for (let i = 0; i < (kind === "query" ? samples : terms.length); i++) {
      const q = Math.floor((kind === "term" ? i % samples : i) * queryStep);
      tasks.push({
        kind,
        filtered: pathPrefix !== null,
        input: {
          text: kind === "query" ? redactForEmbed(queries[q].text) : terms[i],
          vector: Array.from(cache.vectors.subarray(q * 1024, (q + 1) * 1024)),
          pathPrefix,
          documentId: null,
          filters: null,
        },
      });
    }
const readBytes = () =>
  Number(readFileSync("/proc/self/io", "utf8").match(/^read_bytes: (\d+)/m)[1]);
const stageOf = (sql) => {
  if (sql.includes("vec_distance_") || sql.includes("embedding MATCH")) return "vector";
  if (sql.includes("bm25(")) return "fts";
  if (sql.includes("c.start_token AS startToken")) return "hydration";
  return "filter";
};
const evictor = createEvictor({ mode: "fadvise", workDir: join(indexDir, ".."), log() {} });
const record = {
  host: hostRecord(indexDir),
  quantization,
  build: latency.points[quantization]?.[0]?.file,
  methodology:
    "Sequential production readHybridTask stages, persistent handle, target-only eviction before EVERY task; wall ms and /proc/self/io physical read_bytes. EXPLAIN performed before each statement's first execution. No pool overhead.",
  plans: {},
  tasks: [],
};
const openedAt = performance.now();
const handle = openIndexReadOnly(indexDir, expected);
record.openMs = performance.now() - openedAt;
// Optional reproduction of a pool cold pass: exercise the persistent SQLite handle with
// the same 440 warm tasks before target eviction. Opens/extension init are outside the pass.
const primePasses = Number(options["prime-passes"] ?? 0);
if (!Number.isInteger(primePasses) || primePasses < 0 || primePasses > 2)
  throw new Error("Expected 0..2 prime passes");
const primeTerms =
  primePasses > 0
    ? frequentTerms(
        fiqa.corpus.map((d) => `${d.title ?? ""}\n\n${d.text}`),
        20,
      )
    : [];
for (let pass = 0; pass < primePasses; pass++)
  for (const pathPrefix of [null, "a/"])
    for (let q = 0; q < 200 + primeTerms.length; q++)
      readHybridTask(
        handle,
        {
          text: q < 200 ? redactForEmbed(queries[q].text) : primeTerms[q - 200],
          vector: Array.from(cache.vectors.subarray((q % 200) * 1024, ((q % 200) + 1) * 1024)),
          pathPrefix,
          documentId: null,
          filters: null,
        },
        NO_STOP,
      );
record.primePasses = primePasses;
const targetStat = statSync(handle.path);
record.openFile = {
  path: handle.path,
  size: targetStat.size,
  inode: targetStat.ino,
  matchingFds: readdirSync("/proc/self/fd").filter((fd) => {
    try {
      const s = statSync(`/proc/self/fd/${fd}`);
      return s.ino === targetStat.ino && s.dev === targetStat.dev;
    } catch {
      return false;
    }
  }),
  pageSize: handle.db.pragma("page_size", { simple: true }),
  mmapSize: handle.db.pragma("mmap_size", { simple: true }),
};
const prepare = handle.db.prepare.bind(handle.db);
// Prove DONTNEED is file scoped: an unrelated, fully resident 8 MiB control stays resident.
const control = join(indexDir, "..", "eviction-control.bin");
writeFileSync(control, Buffer.alloc(8 * 2 ** 20, 0x5a), { flag: "wx" });
const controlFd = openSync(control, "r+");
fsyncSync(controlFd);
closeSync(controlFd);
const resident = (path) => {
  const result = spawnSync(
    "fincore",
    ["--bytes", "--noheadings", "--raw", "--output", "RES,SIZE", path],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("fincore failed");
  return result.stdout.trim();
};
record.evictionControl = {
  before: resident(control),
  target: evictor.evict(handle.path),
  after: resident(control),
};
unlinkSync(control);
try {
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const task of tasks) {
      const eviction = evictor.evict(handle.path);
      if (eviction.method !== "fadvise" || eviction.residentAfter > 0.01)
        throw new Error("Target eviction failed");
      const stages = {};
      const statements = {};
      const prepares = {};
      let stage = "filter";
      let at = performance.now();
      let bytes = readBytes();
      const finish = () => {
        const next = performance.now();
        const io = readBytes();
        const value = stages[stage] ?? { ms: 0, bytes: 0 };
        value.ms += next - at;
        value.bytes += io - bytes;
        stages[stage] = value;
        at = next;
        bytes = io;
      };
      handle.db.prepare = (sql) => {
        const next = stageOf(sql);
        if (stage !== next) {
          finish();
          stage = next;
        }
        const preparedAt = performance.now();
        const prepareBytes = readBytes();
        const statement = prepare(sql);
        const prepared = prepares[sql] ?? { ms: 0, bytes: 0, calls: 0 };
        prepared.ms += performance.now() - preparedAt;
        prepared.bytes += readBytes() - prepareBytes;
        prepared.calls++;
        prepares[sql] = prepared;
        if (!/^(SELECT|WITH)\b/.test(sql)) return statement;
        return new Proxy(statement, {
          get(target, key) {
            if (key !== "all" && key !== "get") {
              const v = Reflect.get(target, key);
              return typeof v === "function" ? v.bind(target) : v;
            }
            return (...args) => {
              if (!(sql in record.plans))
                record.plans[sql] = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
              if (stage === "filter") return target[key](...args);
              const io = readBytes();
              const started = performance.now();
              const result = target[key](...args);
              const value = statements[sql] ?? { ms: 0, bytes: 0, calls: 0 };
              value.ms += performance.now() - started;
              value.bytes += readBytes() - io;
              value.calls++;
              statements[sql] = value;
              return result;
            };
          },
        });
      };
      const result = readHybridTask(handle, task.input, NO_STOP);
      finish();
      handle.db.prepare = prepare;
      const entry = {
        repeat,
        kind: task.kind,
        filtered: task.filtered,
        text: task.input.text,
        eviction,
        stages,
        statements,
        prepares,
        counts: { vector: result.vector.length, fts: result.fts.length, rows: result.rows.length },
        resultHash: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      };
      record.tasks.push(entry);
      writeFileSync(options.out, `${JSON.stringify(record, null, 2)}\n`);
      console.log(JSON.stringify(entry));
    }
  if (options.layout) {
    // Diagnostic only, after all timed tasks. Bounded by this immutable file's page count.
    const pageCount = handle.db.pragma("page_count", { simple: true });
    record.layout = {};
    const tables = prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all();
    for (const { name: table } of tables) {
      const pages = prepare(
        "SELECT pageno,ncell,payload FROM dbstat WHERE name=? AND pagetype='leaf' ORDER BY path LIMIT ?",
      ).all(table, pageCount);
      const gaps = pages.slice(1).map((p, i) => Math.abs(p.pageno - pages[i].pageno));
      let storagePages = 0;
      let overflowPages = 0;
      let previousPage = null;
      const storageGaps = [];
      for (const page of prepare(
        "SELECT pageno,pagetype FROM dbstat WHERE name=? ORDER BY path LIMIT ?",
      ).iterate(table, pageCount)) {
        if (previousPage !== null) storageGaps.push(Math.abs(page.pageno - previousPage));
        previousPage = page.pageno;
        storagePages++;
        if (page.pagetype === "overflow") overflowPages++;
      }
      record.layout[table] = {
        storagePages,
        overflowPages,
        storageBytes: storagePages * record.openFile.pageSize,
        consecutiveStorageFraction:
          storageGaps.filter((gap) => gap === 1).length / storageGaps.length,
        storagePageGap: { p50: percentile(storageGaps, 50), p95: percentile(storageGaps, 95) },
        leafPages: pages.length,
        leafBytes: pages.length * record.openFile.pageSize,
        payloadBytes: pages.reduce((sum, p) => sum + p.payload, 0),
        cells: pages.reduce((sum, p) => sum + p.ncell, 0),
        consecutiveLeafFraction: gaps.filter((gap) => gap === 1).length / gaps.length,
        pageOrder: "B-tree leaf path (ID order); absolute page-number gaps",
        pageGap: {
          count: gaps.length,
          p50: percentile(gaps, 50),
          p95: percentile(gaps, 95),
          max: gaps.reduce((max, gap) => Math.max(max, gap), 0),
          mean: gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length,
        },
        firstLeafPages: pages.slice(0, 32).map((p) => p.pageno),
      };
    }
  }
} finally {
  handle.db.prepare = prepare;
  closeIndexHandle(handle);
}
record.summary = [];
for (const filtered of [false, true])
  for (const kind of ["query", "term"])
    for (const stage of ["filter", "vector", "fts", "hydration"]) {
      const rows = record.tasks
        .filter((t) => t.filtered === filtered && t.kind === kind)
        .map((t) => t.stages[stage]);
      record.summary.push({
        filtered,
        kind,
        stage,
        ms: summarize(rows.map((r) => r?.ms ?? 0)),
        bytes: summarize(rows.map((r) => r?.bytes ?? 0)),
      });
    }
writeFileSync(options.out, `${JSON.stringify(record, null, 2)}\n`);
