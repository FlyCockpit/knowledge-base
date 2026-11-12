import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  benchId,
  interpolateBound,
  latencyLayout,
  ndcgAt,
  parseArgs,
  percentile,
  rankDocuments,
  ratioMatchedK,
  recallAt,
  runLatency,
  runRecall,
  selectDocuments,
  tiledVector,
  VectorCache,
} from "./bench-index-quantization.mjs";

const scratch = mkdtempSync(join(tmpdir(), "bench-index-quantization-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("rescore depths and metrics", () => {
  assert.equal(ratioMatchedK(0), 0);
  assert.equal(ratioMatchedK(200), 1);
  assert.equal(ratioMatchedK(201), 2);
  assert.equal(ratioMatchedK(57_638), 289);
  assert.equal(ratioMatchedK(400_000), 2000);
  assert.equal(ratioMatchedK(400_001), 2001);
  assert.equal(recallAt([1, 2, 3], [3, 2, 9], 3), 2 / 3);
  assert.equal(recallAt([5, 6], [], 10), 1);
  assert.equal(ndcgAt(["a", "b"], new Set(["a"])), 1);
  assert.equal(ndcgAt(["x", "a"], new Set(["a"])), 1 / Math.log2(3));
  assert.equal(ndcgAt(["x"], new Set()), 0);
  assert.deepEqual(rankDocuments([3, 1, 2, 4], [undefined, "d1", "d1", "d2", "d3"]), [
    "d2",
    "d1",
    "d3",
  ]);
  assert.equal(percentile([5, 1, 4, 2, 3], 95), 5);
  assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
  assert.equal(percentile([], 95), null);
});

test("bound interpolation: crossing, below the smallest N, capped", () => {
  const points = [
    { n: 400_000, p95: 900 },
    { n: 1_000_000, p95: 1500 },
    { n: 2_000_000, p95: 2500 },
  ];
  assert.deepEqual(interpolateBound(points), { bound: 1_500_000, below: false, capped: false });
  assert.deepEqual(interpolateBound([{ n: 400_000, p95: 2100 }]), {
    bound: null,
    below: true,
    capped: false,
  });
  assert.deepEqual(interpolateBound(points.slice(0, 2)), {
    bound: 1_000_000,
    below: false,
    capped: true,
  });
  // Rounded down to 100k.
  assert.equal(
    interpolateBound([
      { n: 500_000, p95: 1000 },
      { n: 1_000_000, p95: 3000 },
    ]).bound,
    700_000,
  );
});

test("latency layout: bounded documents, exact chunk count, ~50% under a/, path order", () => {
  for (const n of [10, 4096, 10_000, 400_000]) {
    const layout = latencyLayout(n, 4096);
    assert.ok(layout.length <= 4096);
    assert.equal(
      layout.reduce((s, d) => s + d.chunks, 0),
      n,
    );
    const a = layout.filter((d) => d.path.startsWith("a/")).length;
    assert.ok(Math.abs(a - layout.length / 2) <= 1);
    const paths = layout.map((d) => d.path);
    assert.deepEqual(paths, [...paths].sort());
  }
});

test("document selection is seeded and keeps required ids first", () => {
  const ids = Array.from({ length: 100 }, (_, i) => String(i));
  const required = new Set(["7", "42", "99"]);
  const one = selectDocuments(ids, required, 20, 7);
  assert.equal(one.length, 20);
  for (const id of required) assert.ok(one.includes(id));
  assert.deepEqual(selectDocuments(ids, required, 20, 7), one);
  assert.equal(selectDocuments(ids, required, 2, 7).length, 2);
  assert.equal(selectDocuments(ids, required, 500, 7).length, 100);
});

test("tiled vectors are unit length, seeded and distinct per id", () => {
  const dims = 16;
  const bases = new Float32Array(2 * dims);
  bases[0] = 1;
  bases[dims + 1] = 1;
  const a = tiledVector(bases, dims, 2, 1, 0.3, 7);
  const norm = Math.hypot(...a);
  assert.ok(Math.abs(norm - 1) < 1e-5);
  assert.deepEqual(tiledVector(bases, dims, 2, 1, 0.3, 7), a);
  assert.notDeepEqual(tiledVector(bases, dims, 2, 3, 0.3, 7), a);
  assert.ok(a[0] > 0.8, "jitter keeps the tile near its base");
});

test("ids and argument parsing", () => {
  assert.match(benchId("kblatb", 4_000_000), /^[a-z0-9]{24}$/);
  assert.deepEqual(parseArgs(["latency", "--n", "1,2", "--keep-files", "--x=y"]), {
    command: "latency",
    options: { n: "1,2", "keep-files": true, x: "y" },
  });
});

test("vector cache drops a partial tail record and resumes aligned", () => {
  const path = join(scratch, "cache", "v.f32");
  const cache = new VectorCache(path, 4);
  cache.append([
    [1, 2, 3, 4],
    [5, 6, 7, 8],
  ]);
  cache.close();
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.alloc(6)]));
  const resumed = new VectorCache(path, 4);
  assert.equal(resumed.count, 2);
  resumed.append([[9, 10, 11, 12]]);
  resumed.close();
  assert.equal(statSync(path).size, 3 * 16);
  const { vectors, count } = VectorCache.readAll(path, 4);
  assert.equal(count, 3);
  assert.deepEqual(Array.from(vectors.subarray(8)), [9, 10, 11, 12]);
});

/** A FiQA-shaped corpus and a filled vector cache, without a model. */
function syntheticRun(dims, root = scratch) {
  const data = join(root, "fiqa");
  const work = join(root, "work");
  mkdirSync(join(data, "qrels"), { recursive: true });
  mkdirSync(work, { recursive: true });
  const words = ["market", "stock", "tax", "loan", "the", "bank", "fund", "rate", "credit", "a"];
  const corpus = Array.from({ length: 120 }, (_, i) => ({
    _id: String(i + 1),
    title: "",
    text: Array.from(
      { length: 30 + (i % 7) * 70 },
      (_, w) => words[(i * 3 + w * 7) % words.length],
    ).join(" "),
  }));
  writeFileSync(join(data, "corpus.jsonl"), corpus.map((row) => JSON.stringify(row)).join("\n"));
  const queries = Array.from({ length: 12 }, (_, i) => ({
    _id: `q${i}`,
    text: `${words[i % 10]} rate`,
  }));
  writeFileSync(join(data, "queries.jsonl"), queries.map((row) => JSON.stringify(row)).join("\n"));
  writeFileSync(
    join(data, "qrels/test.tsv"),
    `query-id\tcorpus-id\tscore\n${queries.map((q, i) => `${q._id}\t${i * 9 + 1}\t1`).join("\n")}\n`,
  );
  return { data, work, corpus, queries, dims };
}

async function fillCache({ work, corpus, queries, dims }) {
  const chunk = await import(new URL("../packages/api/src/lib/kb/chunk.ts", import.meta.url).href);
  const documents = corpus
    .map((doc) => ({ id: doc._id, path: `fiqa/${doc._id}.md`, body: doc.text }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((doc) => {
      const chunked = chunk.chunkBody(doc.body);
      return {
        id: doc.id,
        path: doc.path,
        state: chunked.state,
        originalWindowCount: chunked.originalWindowCount,
        chunks: chunked.chunks,
      };
    });
  const chunkCount = documents.reduce((s, d) => s + d.chunks.length, 0);
  writeFileSync(
    join(work, "chunks.json"),
    JSON.stringify({ config: {}, documentCount: documents.length, chunkCount, documents }),
  );
  writeFileSync(
    join(work, "meta.json"),
    JSON.stringify({ modelId: "synthetic", dimensions: dims, chunkCount }),
  );
  writeFileSync(
    join(work, "queries.json"),
    JSON.stringify(
      queries.map((q, i) => ({ id: q._id, text: q.text, relevant: [String(i * 9 + 1)] })),
    ),
  );
  const vector = (seed) =>
    Array.from({ length: dims }, (_, d) => Math.sin(seed * 12.9898 + d * 78.233));
  const docs = new VectorCache(join(work, "vectors.f32"), dims);
  docs.append(Array.from({ length: chunkCount }, (_, i) => vector(i + 1)));
  docs.close();
  const q = new VectorCache(join(work, "queries.f32"), dims);
  q.append(queries.map((_, i) => vector(i * 13 + 2)));
  q.close();
  return chunkCount;
}

test("smoke: recall through real v1 files and latency through the real reader pool", async () => {
  const run = syntheticRun(32);
  const chunks = await fillCache(run);
  const recall = await runRecall({ work: run.work, kSweep: [50] });
  assert.equal(recall.chunks, chunks);
  assert.deepEqual(Object.keys(recall.quantizations).sort(), ["binary_int8_rescore", "int8"]);
  assert.ok(recall.quantizations.int8.production.recall10 >= 0.95);
  const binary = recall.quantizations.binary_int8_rescore;
  assert.equal(binary.production.k, 200);
  assert.equal(binary.ratioMatched.k, ratioMatchedK(chunks));
  assert.equal(typeof binary.pass, "boolean");
  // K ≥ n: the rescore is exact int8, so it can only match or beat any smaller K.
  assert.ok(binary.production.recall10 >= binary.ratioMatched.recall10);

  const latency = await runLatency({
    vectorsWork: run.work,
    data: run.data,
    workDir: join(scratch, "latency"),
    grid: [300, 600],
    queries: 4,
    terms: 2,
    evict: "none",
    coldTasks: 2,
    allowTmpfs: true,
    requireDims: 32,
    minVectors: 10,
    keepFiles: true,
  });
  for (const quantization of ["int8", "binary_int8_rescore"]) {
    const points = latency.points[quantization];
    assert.deepEqual(
      points.map((p) => p.n),
      [300, 600],
    );
    for (const point of points) {
      assert.equal(point.warm.all.count, 12);
      assert.equal(point.warm.deadlines, 0);
      assert.equal(point.cold.evictedEach.count, 2);
      assert.ok(point.p95 > 0);
    }
    assert.equal(latency.bounds[quantization].capped, true);
  }
  assert.equal(latency.config.terms.length, 2);
  const reused = await runLatency({
    vectorsWork: run.work,
    data: run.data,
    workDir: join(scratch, "latency"),
    grid: [600],
    quantizations: ["int8"],
    queries: 1,
    terms: 0,
    evict: "none",
    coldTasks: 0,
    allowTmpfs: true,
    requireDims: 32,
    minVectors: 10,
    reuseFiles: true,
  });
  assert.equal(reused.points.int8[0].file.reused, true);
  assert.equal(reused.points.int8[0].file.buildSeconds, null);
  const path = join(
    scratch,
    "latency/index",
    benchId("kblati", 600),
    `${benchId("genlati", 600)}.sqlite`,
  );
  assert.ok(statSync(path).size > 0, "reused input is never removed by benchmark cleanup");
});

test("recall reruns reclaim interrupted attempts and journals", async () => {
  const run = syntheticRun(8, join(scratch, "interrupted"));
  const chunks = await fillCache(run);
  for (let rerun = 0; rerun < 2; rerun++) {
    const leftovers = [];
    for (const code of ["i", "b"]) {
      const dir = join(run.work, "index", benchId(`kbrecall${code}`, chunks));
      mkdirSync(dir, { recursive: true });
      const temp = join(dir, `${benchId(`genrecall${code}`, chunks)}.a1.tmp`);
      for (const suffix of ["", "-journal"]) {
        const path = `${temp}${suffix}`;
        writeFileSync(path, "interrupted benchmark copy");
        leftovers.push(path);
      }
    }
    const result = await runRecall({ work: run.work });
    assert.equal(result.chunks, chunks);
    assert.deepEqual(Object.keys(result.quantizations).sort(), ["binary_int8_rescore", "int8"]);
    for (const path of leftovers) assert.equal(existsSync(path), false, path);
  }
});
