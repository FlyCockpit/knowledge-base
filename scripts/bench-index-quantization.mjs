#!/usr/bin/env node
/**
 * Opt-in P7 benchmark for the SQLite index quantizations (plan §1.4, P7). Never part of the
 * gate: it downloads nothing, but it embeds a public corpus with the built-in models for hours
 * and writes multi-gigabyte index files. Run it with `pnpm bench:index-quantization <command>`.
 *
 *   embed    FiQA-2018 (BEIR layout: corpus.jsonl, queries.jsonl, qrels/test.tsv) through the
 *            real worker embedding runtime (`createQwenSupervisor` + `createQwenEmbedder`, the
 *            built `apps/worker/dist/qwen-child.mjs`, the patched native runtime) with the
 *            production chunker and context fitting. f32 vectors are cached on disk in chunk-id
 *            order; a restart resumes after the last complete record.
 *   recall   Real v1 files through `writer.ts` for every quantization; recall@10 of the vector
 *            arm against exact float32 and nDCG@10 against the FiQA test qrels, for
 *            binary_int8_rescore at (a) the production K(n) and (b) the production candidate
 *            ratio, K = ceil(n / chunksPerCandidate), without the floor or cap.
 *   latency  Decision-22 bound measurement: tiled 1024-d files at N chunks per quantization,
 *            200 real queries + the 20 most frequent corpus terms through the real `pool.read`
 *            path (one reader thread), unfiltered and with a ~50% pathPrefix filter, warm and
 *            cold page cache. Reports p95 per N and the interpolated bound per quantization.
 *   host     Prints the host record (CPU, cores, RAM, disk, kernel, Node).
 *
 * `latency --reuse-files` reopens retained files without rebuilding or deleting them. Keep
 * corpus, vector cache, jitter and seed unchanged: meta validates layout, not those inputs.
 *
 * Downloaded data is untrusted: it is only parsed as JSON/TSV text, never executed. The
 * cold-cache command `echo 3 > /proc/sys/vm/drop_caches` needs root; this script never escalates.
 * Without root it drops the index file's pages with `dd iflag=nocache` (posix_fadvise
 * DONTNEED), verifies with `fincore`, and falls back to re-reading a file larger than RAM.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { availableParallelism, cpus, homedir, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KB_SRC = new URL("../packages/api/src/lib/kb/", import.meta.url);
const WORKER_SRC = new URL("../apps/worker/src/lib/", import.meta.url);
const { KB_INDEX_RESCORE } = await import(new URL("limits.ts", KB_SRC).href);

export const BUDGET_MS = 2000;
export const DEFAULT_GRID = [400_000, 500_000, 800_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000];
const QUANTIZATIONS = ["int8", "binary_int8_rescore"];
const QUERY_DEADLINE_MS = 60_000;
const TMPFS_MAGIC = 0x01021994;
const RECALL_AT = 10;
const COMMIT = "b".repeat(40);
const FINGERPRINT = "bench-index-quantization";
const ROOT_DROP_COMMAND = "sync && echo 3 > /proc/sys/vm/drop_caches   # as root";

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the script test)
// ---------------------------------------------------------------------------------------------

/** Ratio-matched rescore depth: the production candidate ratio, without the floor or cap. */
export function ratioMatchedK(n) {
  return Math.ceil(n / KB_INDEX_RESCORE.chunksPerCandidate);
}

/** Fraction of `exact` (first `k`) found in the first `k` of `approx`. */
export function recallAt(approx, exact, k = RECALL_AT) {
  const truth = exact.slice(0, k);
  if (truth.length === 0) return 1;
  const got = new Set(approx.slice(0, k));
  return truth.filter((id) => got.has(id)).length / truth.length;
}

/** Binary-relevance nDCG@k over a ranked list of distinct document ids. */
export function ndcgAt(rankedDocs, relevant, k = RECALL_AT) {
  let dcg = 0;
  rankedDocs.slice(0, k).forEach((doc, i) => {
    if (relevant.has(doc)) dcg += 1 / Math.log2(i + 2);
  });
  let ideal = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

/** Distinct documents in rank order (a document ranks at its best chunk). */
export function rankDocuments(chunkIds, docOfChunk) {
  const seen = new Set();
  const out = [];
  for (const id of chunkIds) {
    const doc = docOfChunk[id];
    if (doc === undefined || seen.has(doc)) continue;
    seen.add(doc);
    out.push(doc);
  }
  return out;
}

/** Nearest-rank percentile (p in 0..100) of a non-empty list. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function summarize(values) {
  if (values.length === 0) return { count: 0 };
  const round = (x) => Math.round(x * 10) / 10;
  return {
    count: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((s, v) => s + v, 0) / values.length),
  };
}

/**
 * Bound[q] (P7): the largest N whose p95 ≤ budget, by linear interpolation between measured
 * points at the first crossing, rounded down to 100k. `{ bound: null, below: true }` when even
 * the smallest measured N is over budget; `capped` when no measured N exceeds it.
 */
export function interpolateBound(points, budget = BUDGET_MS, step = 100_000) {
  const sorted = [...points].sort((a, b) => a.n - b.n);
  if (sorted.length === 0) return { bound: null, below: false, capped: false };
  if (sorted[0].p95 > budget) return { bound: null, below: true, capped: false };
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (next.p95 > budget) {
      const n =
        next.p95 === prev.p95
          ? prev.n
          : prev.n + ((budget - prev.p95) * (next.n - prev.n)) / (next.p95 - prev.p95);
      return { bound: Math.floor(n / step) * step, below: false, capped: false };
    }
  }
  return {
    bound: Math.floor(sorted.at(-1).n / step) * step,
    below: false,
    capped: true,
  };
}

/** Seeded PRNG (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Tiled vector for chunk `id`: the cached unit vector `bases[(id - 1) % count]` plus seeded
 * Gaussian noise of relative norm `jitter`, renormalized. Deterministic in (seed, id).
 */
export function tiledVector(bases, dims, count, id, jitter, seed) {
  const base = ((id - 1) % count) * dims;
  const rand = prng((seed ^ Math.imul(id, 0x9e3779b1)) >>> 0);
  const sigma = jitter / Math.sqrt(dims);
  const out = new Float32Array(dims);
  let sum = 0;
  for (let i = 0; i < dims; i++) {
    const v = bases[base + i] + sigma * gaussian(rand);
    out[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < dims; i++) out[i] /= norm;
  return out;
}

/**
 * Document layout of a tiled file: at most `maxFiles` documents (`KB_TREE_LIMITS.maxFiles`),
 * chunk counts spread evenly. Half the documents live under `a/`, half under `b/`, so the
 * pathPrefix `a/` covers ~50% of documents and chunks.
 */
export function latencyLayout(n, maxFiles) {
  const docs = Math.min(maxFiles, n);
  const base = Math.floor(n / docs);
  const extra = n % docs;
  const width = String(docs).length;
  const out = [];
  for (let i = 0; i < docs; i++)
    out.push({
      path: `${i % 2 === 0 ? "a" : "b"}/doc-${String(i).padStart(width, "0")}.md`,
      chunks: base + (i < extra ? 1 : 0),
    });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Seeded subset: required ids first (all of them when `count` allows), then the rest. */
export function selectDocuments(allIds, required, count, seed) {
  if (count >= allIds.length) return [...allIds];
  const rand = prng(seed);
  const shuffle = (ids) => {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
  };
  const order = [
    ...shuffle(allIds.filter((id) => required.has(id))),
    ...shuffle(allIds.filter((id) => !required.has(id))),
  ];
  const chosen = new Set(order.slice(0, count));
  return allIds.filter((id) => chosen.has(id));
}

/** Most frequent FTS terms (the same alphanumeric runs `ftsQuery` quotes), case-folded. */
export function frequentTerms(texts, count) {
  const freq = new Map();
  for (const text of texts)
    for (const term of text.toLowerCase().match(/[\p{Alphabetic}\p{N}]+/gu) ?? [])
      freq.set(term, (freq.get(term) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, count)
    .map(([term]) => term);
}

/** Fixed-width id (≥ 24 chars of [a-z0-9]) for bench KB / generation ids. */
export function benchId(prefix, n) {
  return `${prefix}${String(n).padStart(24 - prefix.length, "0")}`;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf("=");
    if (eq > 0) options[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"))
      options[arg.slice(2)] = rest[++i];
    else options[arg.slice(2)] = true;
  }
  return { command, options };
}

function list(value, fallback) {
  if (value === undefined || value === true) return fallback;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid integer: ${value}`);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Host record
// ---------------------------------------------------------------------------------------------

function sh(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function hostRecord(dir = process.cwd()) {
  const cpu = cpus()[0]?.model ?? "unknown";
  const source = sh("findmnt", ["-n", "-o", "SOURCE,FSTYPE", "-T", dir]);
  const device = source?.split(/\s+/)[0] ?? null;
  const disk = device?.startsWith("/dev/")
    ? sh("lsblk", [
        "-n",
        "-d",
        "-o",
        "MODEL,ROTA,SIZE",
        `/dev/${sh("lsblk", ["-n", "-o", "PKNAME", device]) ?? ""}`,
      ])
    : null;
  return {
    cpu,
    logicalCpus: cpus().length,
    availableParallelism: availableParallelism(),
    threadsPerCore: sh("sh", ["-c", "lscpu | sed -n 's/^Thread(s) per core: *//p'"]),
    coresPerSocket: sh("sh", ["-c", "lscpu | sed -n 's/^Core(s) per socket: *//p'"]),
    ramBytes: totalmem(),
    kernel: release(),
    node: process.version,
    dir,
    filesystem: source,
    disk,
  };
}

// ---------------------------------------------------------------------------------------------
// Module loading (TypeScript sources through tsx: `node --import tsx`)
// ---------------------------------------------------------------------------------------------

async function loadKb() {
  const at = (path) => import(new URL(path, KB_SRC).href);
  const [format, writer, reader, pool, chunk, rrf, limits, redact] = await Promise.all([
    at("index-file/format.ts"),
    at("index-file/writer.ts"),
    at("index-file/reader.ts"),
    at("index-file/pool.ts"),
    at("chunk.ts"),
    at("rrf.ts"),
    at("limits.ts"),
    at("redact-for-embed.ts"),
  ]);
  return { format, writer, reader, pool, chunk, rrf, limits, redact };
}

// ---------------------------------------------------------------------------------------------
// FiQA (untrusted text: parsed, never executed)
// ---------------------------------------------------------------------------------------------

function readJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    out.push(JSON.parse(line));
  }
  return out;
}

export function loadFiqa(dir) {
  const corpus = readJsonl(join(dir, "corpus.jsonl")).map((row) => {
    if (typeof row._id !== "string" || typeof row.text !== "string")
      throw new Error("Unexpected corpus row");
    return { id: row._id, title: typeof row.title === "string" ? row.title : "", text: row.text };
  });
  const queries = new Map(
    readJsonl(join(dir, "queries.jsonl")).map((row) => {
      if (typeof row._id !== "string" || typeof row.text !== "string")
        throw new Error("Unexpected query row");
      return [row._id, row.text];
    }),
  );
  const qrels = new Map();
  const lines = readFileSync(join(dir, "qrels/test.tsv"), "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (line.trim() === "") continue;
    const [query, doc, score] = line.split("\t");
    if (!query || !doc || Number(score) <= 0) continue;
    if (!qrels.has(query)) qrels.set(query, new Set());
    qrels.get(query).add(doc);
  }
  const test = [...qrels.keys()]
    .filter((id) => queries.has(id))
    .map((id) => ({ id, text: queries.get(id), relevant: [...qrels.get(id)] }));
  return { corpus, test };
}

export function documentPath(id) {
  return `fiqa/${id}.md`;
}

function documentBody(doc) {
  return doc.title ? `${doc.title}\n\n${doc.text}` : doc.text;
}

// ---------------------------------------------------------------------------------------------
// Vector cache: fixed-width f32 records, resumable
// ---------------------------------------------------------------------------------------------

export class VectorCache {
  constructor(path, dims) {
    this.path = path;
    this.dims = dims;
    this.record = dims * 4;
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, existsSync(path) ? "r+" : "w+");
    const size = fstatSync(this.fd).size;
    this.count = Math.floor(size / this.record);
    // A crash mid-record leaves a partial tail: drop it so appends stay aligned.
    if (size !== this.count * this.record) ftruncateSync(this.fd, this.count * this.record);
    this.unsynced = 0;
  }

  append(vectors) {
    const buffer = Buffer.alloc(vectors.length * this.record);
    vectors.forEach((vector, i) => {
      if (vector.length !== this.dims) throw new Error("Vector cache: wrong dimensions");
      for (let d = 0; d < this.dims; d++) buffer.writeFloatLE(vector[d], i * this.record + d * 4);
    });
    writeSync(this.fd, buffer, 0, buffer.length, this.count * this.record);
    this.count += vectors.length;
    this.unsynced += vectors.length;
    if (this.unsynced >= 256) this.sync();
  }

  sync() {
    fsyncSync(this.fd);
    this.unsynced = 0;
  }

  close() {
    this.sync();
    closeSync(this.fd);
  }

  /** All complete records as one Float32Array (raw, as the model returned them). */
  static readAll(path, dims, limit = Number.POSITIVE_INFINITY) {
    const bytes = readFileSync(path);
    const count = Math.min(limit, Math.floor(bytes.length / (dims * 4)));
    const out = new Float32Array(count * dims);
    for (let i = 0; i < count * dims; i++) out[i] = bytes.readFloatLE(i * 4);
    return { vectors: out, count };
  }
}

function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function log(message, detail) {
  const line = `[bench ${new Date().toISOString()}] ${message}${detail ? ` ${JSON.stringify(detail)}` : ""}`;
  console.log(line);
}

// ---------------------------------------------------------------------------------------------
// embed: the real worker embedding runtime
// ---------------------------------------------------------------------------------------------

const MODELS = {
  gemma: { modelIdKey: "GEMMA_MODEL", env: "KB_GEMMA_MODEL_PATH" },
  qwen: { modelIdKey: "QWEN_MODEL", env: "KB_QWEN_MODEL_PATH" },
};

async function createRuntimeEmbedder({ model, modelPath, childEntry, guardPath, contextTokens }) {
  const [{ createQwenSupervisor, createQwenEmbedder }, builtin] = await Promise.all([
    import(new URL("qwen-lifecycle.ts", WORKER_SRC).href),
    import(new URL("builtin-model.ts", KB_SRC).href),
  ]);
  const descriptor = builtin[MODELS[model].modelIdKey];
  if (!descriptor.contextTiers.includes(contextTokens))
    throw new Error(`Unsupported context ${contextTokens} for ${descriptor.modelId}`);
  const supervisor = createQwenSupervisor({
    childEntry,
    modelPath,
    guardPath,
    lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
  });
  const runtime = {
    modelId: descriptor.modelId,
    epoch: 1,
    config: { contextTokens, kvKeyType: "f16", kvValueType: "f16" },
  };
  const embedder = createQwenEmbedder({ supervisor, readReadyRuntime: async () => runtime });
  return { descriptor, supervisor, embedder };
}

/** A crashed or timed-out child is respawned by the supervisor; give it a few chances. */
async function withRetry(run, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts) throw error;
      log("embedding call failed; retrying", { attempt, error: error?.name ?? "Error" });
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

/** Chunk records of one model's run, written once (atomically) and reused on resume. */
async function prepareChunks({ kb, fiqa, selected, embedder, chunksPath, config }) {
  if (existsSync(chunksPath)) {
    const cached = JSON.parse(readFileSync(chunksPath, "utf8"));
    if (JSON.stringify(cached.config) !== JSON.stringify(config))
      throw new Error(`${chunksPath} was prepared with a different configuration`);
    return cached;
  }
  const byId = new Map(fiqa.corpus.map((doc) => [doc.id, doc]));
  const docs = selected
    .map((id) => ({ id, path: documentPath(id) }))
    .sort((a, b) => kb.rrf.comparePaths(a.path, b.path));
  const documents = [];
  let chunkCount = 0;
  const started = performance.now();
  for (const [index, entry] of docs.entries()) {
    const body = documentBody(byId.get(entry.id));
    const chunked = kb.chunk.chunkBody(body);
    const fitted = await kb.chunk.fitChunksToContext(body, chunked, (texts) =>
      embedder.measureInputs(texts, {}),
    );
    documents.push({
      id: entry.id,
      path: entry.path,
      state: fitted.state,
      originalWindowCount: fitted.originalWindowCount,
      chunks: fitted.chunks,
    });
    chunkCount += fitted.chunks.length;
    if ((index + 1) % 2000 === 0)
      log("chunking", {
        documents: index + 1,
        of: docs.length,
        chunks: chunkCount,
        seconds: Math.round((performance.now() - started) / 1000),
      });
  }
  const prepared = { config, documentCount: documents.length, chunkCount, documents };
  writeJsonAtomic(chunksPath, prepared);
  return prepared;
}

async function commandEmbed(options) {
  const model = options.model;
  if (!MODELS[model]) throw new Error("--model gemma|qwen is required");
  const data = resolve(String(options.data ?? ""));
  const work = resolve(String(options.work ?? ""));
  if (!options.data || !options.work)
    throw new Error("--data <fiqa dir> and --work <dir> are required");
  const modelPath = String(options["model-path"] ?? process.env[MODELS[model].env] ?? "");
  if (!modelPath) throw new Error(`--model-path or ${MODELS[model].env} is required`);
  const guardPath = options["child-guard"] ? resolve(String(options["child-guard"])) : null;
  if (!guardPath || !existsSync(guardPath))
    throw new Error(
      "--child-guard <path> is required (gcc -std=c11 -O2 -D_GNU_SOURCE -o <path> apps/worker/src/native/child-guard.c)",
    );
  const childEntry = resolve(
    String(options["child-entry"] ?? join(ROOT, "apps/worker/dist/qwen-child.mjs")),
  );
  if (!existsSync(childEntry)) throw new Error(`${childEntry} missing: pnpm --filter worker build`);
  const kb = await loadKb();
  const builtinDefaults = JSON.parse(
    readFileSync(new URL("fixtures/builtin-models.json", KB_SRC), "utf8"),
  );
  const contextTokens = int(options.context, builtinDefaults.defaultContext);
  const batch = int(options.batch, 4);
  const seed = int(options.seed, 7);
  mkdirSync(work, { recursive: true });
  const fiqa = loadFiqa(data);
  const required = new Set(fiqa.test.flatMap((query) => query.relevant));
  const wanted =
    options.docs === undefined || options.docs === "all" ? fiqa.corpus.length : int(options.docs);
  const selected = selectDocuments(
    fiqa.corpus.map((doc) => doc.id),
    required,
    wanted,
    seed,
  );
  const { descriptor, supervisor, embedder } = await createRuntimeEmbedder({
    model,
    modelPath,
    childEntry,
    guardPath,
    contextTokens,
  });
  const meta = {
    model,
    modelId: descriptor.modelId,
    dimensions: descriptor.dimensions,
    contextTokens,
    documents: selected.length,
    seed,
    threads: availableParallelism(),
    data,
  };
  log("embed start", meta);
  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const prepared = await prepareChunks({
      kb,
      fiqa,
      selected,
      embedder,
      chunksPath: join(work, "chunks.json"),
      config: { modelId: descriptor.modelId, contextTokens, seed, documents: selected.length },
    });
    writeJsonAtomic(join(work, "meta.json"), { ...meta, chunkCount: prepared.chunkCount });
    // Queries first (needed by both recall and latency), then documents in chunk-id order.
    writeJsonAtomic(join(work, "queries.json"), fiqa.test);
    const queryCache = new VectorCache(join(work, "queries.f32"), descriptor.dimensions);
    try {
      for (let at = queryCache.count; at < fiqa.test.length && !stop; at++) {
        const text = kb.redact.redactForEmbed(fiqa.test[at].text) ?? "";
        const [vector] = await withRetry(() => embedder.embed([text], { purpose: "query" }));
        queryCache.append([vector]);
      }
    } finally {
      queryCache.close();
    }
    const texts = prepared.documents.flatMap((doc) => doc.chunks.map((chunk) => chunk.text));
    const cache = new VectorCache(join(work, "vectors.f32"), descriptor.dimensions);
    const started = performance.now();
    const startCount = cache.count;
    try {
      while (cache.count < texts.length && !stop) {
        const slice = texts.slice(cache.count, cache.count + batch);
        const vectors = await withRetry(() => embedder.embed(slice, { purpose: "document" }));
        if (vectors.length !== slice.length) throw new Error("Embedding count");
        cache.append(vectors);
        if (cache.count % 200 < batch || cache.count === texts.length) {
          const rate = (cache.count - startCount) / ((performance.now() - started) / 1000);
          const progress = {
            done: cache.count,
            total: texts.length,
            perSecond: Math.round(rate * 100) / 100,
            etaHours: Math.round(((texts.length - cache.count) / rate / 3600) * 100) / 100,
            at: new Date().toISOString(),
          };
          writeJsonAtomic(join(work, "progress.json"), progress);
          log("embedding", progress);
        }
      }
    } finally {
      cache.close();
    }
    log(stop ? "embed interrupted (resumable)" : "embed complete", {
      vectors: cache.count,
      total: texts.length,
    });
  } finally {
    await supervisor.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Index building through the real writer
// ---------------------------------------------------------------------------------------------

/**
 * Builds and publishes one v1 file. `documents` arrive in path order with chunk text; `rawVector`
 * returns chunk `id`'s raw vector. Calibration follows index-build.ts: sample ids first, scale,
 * then every vector exactly once.
 */
async function buildIndexFile(
  kb,
  { indexDir, kbId, generationId, quantization, dims, documents, rawVector, reuseExpected },
) {
  const final = kb.format.generationFilePath(indexDir, kbId, generationId);
  if (reuseExpected) {
    const expected = {
      generationId,
      kbId,
      commitSha: COMMIT,
      fingerprint: FINGERPRINT,
      dimensions: dims,
      ...reuseExpected,
    };
    const handle = kb.reader.openIndexReadOnly(indexDir, expected);
    try {
      if (handle.meta.quantization !== quantization)
        throw new Error("Reused quantization mismatch");
      return {
        path: final,
        bytes: statSync(final).size,
        buildSeconds: null,
        reused: true,
        expected,
      };
    } finally {
      kb.reader.closeIndexHandle(handle);
    }
  }
  rmSync(final, { force: true });
  const temp = kb.format.attemptTempPath(indexDir, kbId, generationId, 1);
  // These deterministic names belong to this benchmark point; reclaim interrupted
  // attempts and rollback journals before rebuilding.
  for (const suffix of ["", "-journal"]) rmSync(`${temp}${suffix}`, { force: true });
  const writer = kb.writer.openIndexWriter({
    indexDir,
    kbId,
    generationId,
    attempt: 1,
    commitSha: COMMIT,
    fingerprint: FINGERPRINT,
    quantization,
    dimensions: dims,
  });
  const started = performance.now();
  let chunkCount = 0;
  try {
    for (const doc of documents()) {
      const blobSha = createHash("sha1").update(doc.path).digest("hex");
      writer.appendDocument(
        {
          path: doc.path,
          blobSha,
          contentHash: blobSha,
          documentId: null,
          state: doc.chunks.length > 0 ? "INDEXED" : (doc.state ?? "EMPTY"),
          originalWindowCount: doc.originalWindowCount,
          source: {
            commitSha: COMMIT,
            blobSha,
            contentHash: blobSha,
            documentId: null,
            documentCitations: [],
            assetRefs: [],
          },
          metadata: { type: null, title: null, titleFolded: null, tags: [], timestamp: null },
          rows: [],
        },
        doc.chunks,
      );
      chunkCount += doc.chunks.length;
    }
    if (chunkCount > 0)
      writer.setInt8Scale(
        kb.format.int8Scale(
          kb.format
            .calibrationIds(chunkCount)
            .map((id) => kb.format.unitVector(rawVector(id), dims)),
        ),
      );
    const BATCH = 2048;
    for (let first = 1; first <= chunkCount; first += BATCH) {
      const entries = [];
      for (let id = first; id <= Math.min(chunkCount, first + BATCH - 1); id++)
        entries.push({ id, vector: rawVector(id) });
      writer.appendVectors(entries);
    }
    const finalized = writer.finalize();
    await kb.writer.publishIndexFile(finalized.tempPath, final);
    return {
      path: final,
      buildSeconds: Math.round((performance.now() - started) / 100) / 10,
      bytes: statSync(final).size,
      expected: {
        generationId,
        kbId,
        commitSha: COMMIT,
        fingerprint: FINGERPRINT,
        dimensions: dims,
        chunkCount: finalized.chunkCount,
        documentCount: finalized.documentCount,
      },
    };
  } catch (error) {
    writer.abort();
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------------------------

/** Exact float32 cosine top-k over unit vectors, ties by id (ids are 1-based). */
function exactTopK(units, count, dims, query, k) {
  const scores = new Float64Array(count);
  for (let r = 0; r < count; r++) {
    let dot = 0;
    const base = r * dims;
    for (let d = 0; d < dims; d++) dot += units[base + d] * query[d];
    scores[r] = dot;
  }
  const top = [];
  for (let r = 0; r < count; r++) {
    const s = scores[r];
    if (top.length < k || s > top[top.length - 1].s) {
      let at = top.length;
      while (at > 0 && top[at - 1].s < s) at--;
      top.splice(at, 0, { id: r + 1, s });
      if (top.length > k) top.pop();
    }
  }
  return top.map((entry) => entry.id);
}

/**
 * binary_int8_rescore with an explicit global K: the same two statements `vectorArm` runs
 * (per-slice hamming, merged to K; int8 cosine rescore), so (b) differs from (a) only in K.
 * Checked against `vectorArm` at K = rescoreK(n) for every query.
 */
function rescoreWithK(kb, db, meta, unit, k, limit) {
  const bits = Buffer.from(kb.format.binaryBits(unit));
  const hamming = db.prepare(
    "SELECT b.id AS id, vec_distance_hamming(vec_bit(b.b), vec_bit(?)) AS score FROM chunk_bits b WHERE b.id BETWEEN ? AND ? ORDER BY score, b.id LIMIT ?",
  );
  const merged = [];
  for (const [first, last] of kb.format.sliceBounds(meta.chunkCount, kb.format.SLICE_ROWS))
    merged.push(...hamming.all(bits, first, last, k));
  const candidates = merged
    .sort((a, b) => a.score - b.score || a.id - b.id)
    .slice(0, k)
    .map((row) => row.id);
  return db
    .prepare(
      `SELECT i.id AS id, vec_distance_cosine(vec_int8(i.e), vec_int8(?)) AS score
      FROM chunk_int8 i WHERE i.id IN (SELECT value FROM json_each(?)) ORDER BY score, i.id LIMIT ?`,
    )
    .all(
      kb.format.int8Bytes(kb.format.quantizeInt8(unit, meta.int8Scale)),
      JSON.stringify(candidates),
      limit,
    )
    .map((row) => row.id);
}

function round4(x) {
  return Math.round(x * 10_000) / 10_000;
}

export async function runRecall({
  work,
  quantizations = QUANTIZATIONS,
  allowPartial = false,
  kSweep = [],
}) {
  const kb = await loadKb();
  const meta = JSON.parse(readFileSync(join(work, "meta.json"), "utf8"));
  const prepared = JSON.parse(readFileSync(join(work, "chunks.json"), "utf8"));
  const queries = JSON.parse(readFileSync(join(work, "queries.json"), "utf8"));
  const dims = meta.dimensions;
  const { vectors: raw, count } = VectorCache.readAll(join(work, "vectors.f32"), dims);
  if (count < prepared.chunkCount && !allowPartial)
    throw new Error(
      `Only ${count} of ${prepared.chunkCount} vectors cached; embedding not complete`,
    );
  // Whole documents only: a partially embedded document is dropped (smoke runs only).
  const documents = [];
  let n = 0;
  for (const doc of prepared.documents) {
    if (n + doc.chunks.length > count) break;
    documents.push(doc);
    n += doc.chunks.length;
  }
  const { vectors: queryRaw, count: queryCount } = VectorCache.readAll(
    join(work, "queries.f32"),
    dims,
  );
  const units = new Float32Array(n * dims);
  for (let id = 1; id <= n; id++)
    units.set(
      kb.format.unitVector(raw.subarray((id - 1) * dims, id * dims), dims),
      (id - 1) * dims,
    );
  const docOfChunk = [];
  let next = 1;
  for (const doc of documents) for (const _chunk of doc.chunks) docOfChunk[next++] = doc.id;
  const presentDocs = new Set(documents.map((doc) => doc.id));
  const evalQueries = queries
    .slice(0, queryCount)
    .map((query, i) => ({
      ...query,
      vector: queryRaw.subarray(i * dims, (i + 1) * dims),
      relevantPresent: new Set(query.relevant.filter((id) => presentDocs.has(id))),
    }))
    .filter((query) => query.relevantPresent.size > 0);
  log("recall start", {
    model: meta.modelId,
    chunks: n,
    documents: documents.length,
    queries: evalQueries.length,
  });

  const exact = evalQueries.map((query) =>
    exactTopK(
      units,
      n,
      dims,
      kb.format.unitVector(query.vector, dims),
      kb.rrf.HYBRID_CANDIDATES_PER_ARM,
    ),
  );
  const indexDir = join(work, "index");
  const results = {
    model: meta.modelId,
    dimensions: dims,
    chunks: n,
    documents: documents.length,
    queries: evalQueries.length,
    exactFloat32: {
      ndcg10: round4(
        evalQueries.reduce(
          (s, q, i) => s + ndcgAt(rankDocuments(exact[i], docOfChunk), q.relevantPresent),
          0,
        ) / evalQueries.length,
      ),
    },
    quantizations: {},
  };
  for (const quantization of quantizations) {
    const code = { int8: "i", binary_int8_rescore: "b" }[quantization];
    const built = await buildIndexFile(kb, {
      indexDir,
      kbId: benchId(`kbrecall${code}`, n),
      generationId: benchId(`genrecall${code}`, n),
      quantization,
      dims,
      documents: () => documents,
      rawVector: (id) => raw.subarray((id - 1) * dims, id * dims),
    });
    const handle = kb.reader.openIndexReadOnly(indexDir, built.expected);
    try {
      const unfiltered = { filtered: false, rowFiltered: false, chunks: -1 };
      const production = {
        k: quantization === "binary_int8_rescore" ? kb.format.rescoreK(n) : null,
        recall: 0,
        ndcg: 0,
      };
      const ratio = { k: ratioMatchedK(n), recall: 0, ndcg: 0 };
      const sweep = new Map(kSweep.map((k) => [k, 0]));
      const started = performance.now();
      evalQueries.forEach((query, i) => {
        const arm = kb.reader
          .runTask(handle, (db) =>
            kb.reader.vectorArm(db, handle.meta, query.vector, unfiltered, kb.reader.NO_STOP),
          )
          .map((hit) => hit.id);
        production.recall += recallAt(arm, exact[i]);
        production.ndcg += ndcgAt(rankDocuments(arm, docOfChunk), query.relevantPresent);
        if (quantization !== "binary_int8_rescore") return;
        const unit = kb.format.unitVector(query.vector, dims);
        const limit = kb.rrf.HYBRID_CANDIDATES_PER_ARM;
        const replica = rescoreWithK(kb, handle.db, handle.meta, unit, production.k, limit);
        if (JSON.stringify(replica) !== JSON.stringify(arm))
          throw new Error("rescore replica diverges from vectorArm at the production K");
        const matched = rescoreWithK(kb, handle.db, handle.meta, unit, ratio.k, limit);
        ratio.recall += recallAt(matched, exact[i]);
        ratio.ndcg += ndcgAt(rankDocuments(matched, docOfChunk), query.relevantPresent);
        for (const k of sweep.keys())
          sweep.set(
            k,
            sweep.get(k) +
              recallAt(rescoreWithK(kb, handle.db, handle.meta, unit, k, limit), exact[i]),
          );
      });
      const q = evalQueries.length;
      const entry = {
        file: {
          bytes: built.bytes,
          buildSeconds: built.buildSeconds,
          int8Scale: handle.meta.int8Scale,
        },
        queryMsMean: Math.round(((performance.now() - started) / q) * 10) / 10,
        production: {
          k: production.k,
          recall10: round4(production.recall / q),
          ndcg10: round4(production.ndcg / q),
        },
      };
      if (quantization === "binary_int8_rescore") {
        entry.ratioMatched = {
          k: ratio.k,
          recall10: round4(ratio.recall / q),
          ndcg10: round4(ratio.ndcg / q),
        };
        if (sweep.size > 0)
          entry.kSweepRecall10 = Object.fromEntries([...sweep].map(([k, v]) => [k, round4(v / q)]));
        entry.pass = entry.production.recall10 >= 0.95 && entry.ratioMatched.recall10 >= 0.95;
      }
      results.quantizations[quantization] = entry;
      log("recall", { quantization, ...entry });
    } finally {
      kb.reader.closeIndexHandle(handle);
    }
  }
  return results;
}

async function commandRecall(options) {
  if (!options.work) throw new Error("--work <dir> is required");
  const work = resolve(String(options.work));
  const results = await runRecall({
    work,
    quantizations: list(options.quantizations, QUANTIZATIONS),
    allowPartial: options["allow-partial"] === true,
    kSweep: list(options["k-sweep"], []).map((k) => int(k)),
  });
  const record = { kind: "recall", at: new Date().toISOString(), host: hostRecord(work), results };
  const out = resolve(String(options.out ?? join(work, "recall-results.json")));
  writeJsonAtomic(out, record);
  console.log(JSON.stringify(record, null, 2));
  const binary = results.quantizations.binary_int8_rescore;
  if (binary)
    console.log(
      `binary_int8_rescore recall@10 ≥ 95% at (a) and (b): ${binary.pass ? "PASS" : "FAIL"}`,
    );
}

// ---------------------------------------------------------------------------------------------
// latency
// ---------------------------------------------------------------------------------------------

/** Words of the FiQA passages, cycled forever (text tiling keeps term statistics realistic). */
function* passageWords(passages) {
  for (;;)
    for (const passage of passages) {
      for (const word of passage.match(/[^\p{White_Space}]+/gu) ?? []) yield word;
      yield "\n\n";
    }
}

/**
 * Tiled documents through the production chunker: each body holds exactly enough FiQA words
 * for its target number of 400-word windows (80-word overlap).
 */
function* tiledDocuments(kb, layout, passages) {
  const words = passageWords(passages);
  const { CHUNK_WORDS, CHUNK_OVERLAP } = kb.chunk;
  for (const doc of layout) {
    const target =
      doc.chunks <= 1
        ? CHUNK_WORDS
        : CHUNK_WORDS + (doc.chunks - 1) * (CHUNK_WORDS - CHUNK_OVERLAP);
    const parts = [];
    let count = 0;
    while (count < target) {
      const word = words.next().value;
      if (word === "\n\n") {
        if (parts.length > 0 && parts.at(-1) !== "\n\n") parts.push("\n\n");
        continue;
      }
      parts.push(word);
      count++;
    }
    const body = parts.join(" ").replaceAll(" \n\n ", "\n\n");
    const chunked = kb.chunk.chunkBody(body);
    // A credential-like run in a passage can withhold a window; pad so the count stays exact.
    const chunks = chunked.chunks.slice(0, doc.chunks);
    while (chunks.length < doc.chunks) {
      const filler = {
        ...(chunks.at(-1) ?? {
          chunkIndex: -1,
          span: { startToken: 0, endToken: 1, startByte: 0, endByte: 1 },
          text: "x",
          snippet: "x",
        }),
      };
      filler.chunkIndex += 1;
      chunks.push(filler);
    }
    yield {
      path: doc.path,
      state: "INDEXED",
      originalWindowCount: Math.max(chunked.originalWindowCount, chunks.at(-1).chunkIndex + 1),
      chunks,
    };
  }
}

function fincoreResident(path) {
  const out = sh("fincore", ["--bytes", "--noheadings", "--raw", "--output", "RES,SIZE", path]);
  if (!out) return null;
  const [res, size] = out.split(/\s+/).map(Number);
  return size > 0 ? res / size : null;
}

/** Page-cache eviction for the cold pass; never escalates privileges. */
export function createEvictor({ mode, workDir, evictFile, log: say = log }) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const chosen = mode === "auto" ? (isRoot ? "drop-caches" : "fadvise") : mode;
  if (!isRoot && chosen === "drop-caches")
    throw new Error(
      `drop-caches needs root; run as root or use --evict fadvise|reread. Root command: ${ROOT_DROP_COMMAND}`,
    );
  if (!isRoot)
    say("cold cache without root; the exact root alternative is", { command: ROOT_DROP_COMMAND });
  const rereadPath = evictFile ?? join(workDir, "evict.bin");
  const ensureEvictFile = () => {
    const want = Math.ceil(totalmem() * 1.1);
    if (existsSync(rereadPath) && statSync(rereadPath).size >= want) return;
    const free = statfsSync(dirname(rereadPath));
    if (Number(free.bavail) * Number(free.bsize) < want + 4 * 2 ** 30)
      throw new Error(`Not enough disk for a ${want}-byte eviction file at ${rereadPath}`);
    say("writing eviction file", { path: rereadPath, bytes: want });
    const fd = openSync(rereadPath, "w");
    const block = Buffer.alloc(16 * 2 ** 20, 0x5a);
    try {
      for (let at = 0; at < want; at += block.length) writeSync(fd, block, 0, block.length, at);
    } finally {
      closeSync(fd);
    }
  };
  const reread = () => {
    ensureEvictFile();
    const fd = openSync(rereadPath, "r");
    const block = Buffer.alloc(16 * 2 ** 20);
    try {
      for (let at = 0; readSync(fd, block, 0, block.length, at) > 0; at += block.length);
    } finally {
      closeSync(fd);
    }
  };
  return {
    mode: chosen,
    /** Evicts `file` and reports the method used and the residency left behind. */
    evict(file) {
      let used = chosen;
      if (chosen === "drop-caches") {
        spawnSync("sync");
        writeFileSync("/proc/sys/vm/drop_caches", "3\n");
      } else if (chosen === "fadvise") {
        const result = spawnSync("dd", [`if=${file}`, "iflag=nocache", "count=0", "status=none"]);
        const left = fincoreResident(file);
        if (result.status !== 0 || left === null || left > 0.05) {
          used = "reread";
          reread();
        }
      } else if (chosen === "reread") reread();
      else if (chosen !== "none") throw new Error(`Unknown eviction mode ${chosen}`);
      return { method: used, residentAfter: fincoreResident(file) };
    },
  };
}

async function runTasks(pool, expected, tasks) {
  const times = [];
  let deadlines = 0;
  for (const task of tasks) {
    const started = performance.now();
    const outcome = await pool.read({
      task: { kind: "hybrid", input: task },
      expected,
      active: true,
      deadlineAt: Date.now() + QUERY_DEADLINE_MS,
    });
    times.push(performance.now() - started);
    if (outcome.status !== "ok") deadlines++;
    if (tasks.length >= 100 && times.length % 50 === 0)
      log("latency progress", {
        completed: times.length,
        total: tasks.length,
        lastMs: Math.round(times.at(-1)),
      });
  }
  return { times, deadlines };
}

export async function runLatency(options) {
  const {
    vectorsWork,
    data,
    workDir,
    grid = DEFAULT_GRID,
    quantizations = QUANTIZATIONS,
    queries: queryCount = 200,
    terms: termCount = 20,
    jitter = 0.3,
    seed = 7,
    evict = "auto",
    evictFile,
    coldTasks = 20,
    keepFiles = false,
    reuseFiles = false,
    stopOverBudget = false,
    allowTmpfs = false,
    requireDims = 1024,
    minVectors = 1000,
    onPoint,
  } = options;
  const kb = await loadKb();
  mkdirSync(workDir, { recursive: true });
  if (statfsSync(workDir).type === TMPFS_MAGIC && !allowTmpfs)
    throw new Error(
      `${workDir} is tmpfs (RAM): cold-cache and size results would be meaningless; use a disk directory`,
    );
  const meta = JSON.parse(readFileSync(join(vectorsWork, "meta.json"), "utf8"));
  const dims = meta.dimensions;
  if (requireDims && dims !== requireDims)
    throw new Error(`Latency vectors must be ${requireDims}-d (largest built-in); got ${dims}`);
  const cached = VectorCache.readAll(join(vectorsWork, "vectors.f32"), dims);
  if (cached.count < minVectors)
    throw new Error(
      `Need at least ${minVectors} cached vectors to tile from; ${cached.count} cached`,
    );
  const bases = new Float32Array(cached.count * dims);
  for (let r = 0; r < cached.count; r++)
    bases.set(
      kb.format.unitVector(cached.vectors.subarray(r * dims, (r + 1) * dims), dims),
      r * dims,
    );
  const queryText = JSON.parse(readFileSync(join(vectorsWork, "queries.json"), "utf8"));
  const queryVectors = VectorCache.readAll(join(vectorsWork, "queries.f32"), dims);
  const nQueries = Math.min(queryCount, queryVectors.count);
  const fiqa = loadFiqa(data);
  const passages = fiqa.corpus.map(documentBody);
  const topTerms = frequentTerms(passages, termCount);
  const vectorOf = (i) => Array.from(queryVectors.vectors.subarray(i * dims, (i + 1) * dims));
  const textOf = (text) => kb.redact.redactForEmbed(text) ?? "";
  const base = [];
  for (let i = 0; i < nQueries; i++)
    base.push({ kind: "query", text: textOf(queryText[i].text), vector: vectorOf(i) });
  for (const [i, term] of topTerms.entries())
    base.push({ kind: "term", text: term, vector: vectorOf(i % nQueries) });
  const tasks = [];
  for (const filter of [null, "a/"])
    for (const entry of base)
      tasks.push({
        filter: filter ? "pathPrefix~50%" : "none",
        kind: entry.kind,
        input: {
          text: entry.text,
          vector: entry.vector,
          pathPrefix: filter,
          documentId: null,
          filters: null,
        },
      });
  const evictor = createEvictor({ mode: evict, workDir, evictFile });
  const step = Math.max(1, Math.floor(tasks.length / Math.max(1, coldTasks)));
  const coldSample =
    coldTasks > 0 ? tasks.filter((_, i) => i % step === 0).slice(0, coldTasks) : [];
  const record = {
    kind: "latency",
    at: new Date().toISOString(),
    host: hostRecord(workDir),
    config: {
      vectors: { model: meta.modelId, dims, cached: cached.count },
      grid,
      quantizations,
      queries: nQueries,
      terms: topTerms,
      tasksPerPass: tasks.length,
      jitter,
      seed,
      evict: evictor.mode,
      coldTasks: coldSample.length,
      budgetMs: BUDGET_MS,
      reuseFiles,
      timing: "pool.read round trip on the main thread (in-thread work + one postMessage each way)",
    },
    points: {},
    bounds: {},
  };
  const indexDir = join(workDir, "index");
  for (const quantization of quantizations) {
    const code = { int8: "i", binary_int8_rescore: "b" }[quantization];
    record.points[quantization] = [];
    for (const n of grid) {
      const layout = latencyLayout(n, kb.limits.KB_TREE_LIMITS.maxFiles);
      log("latency build", { quantization, n, documents: layout.length });
      const built = await buildIndexFile(kb, {
        indexDir,
        kbId: benchId(`kblat${code}`, n),
        generationId: benchId(`genlat${code}`, n),
        quantization,
        dims,
        documents: () => tiledDocuments(kb, layout, passages),
        rawVector: (id) => tiledVector(bases, dims, cached.count, id, jitter, seed),
        reuseExpected: reuseFiles ? { chunkCount: n, documentCount: layout.length } : undefined,
      });
      const pool = kb.pool.createIndexReaderPool({
        entry: new URL("index-file/reader-thread.ts", KB_SRC),
        execArgv: ["--import", "tsx"],
        indexDir,
        threads: 1,
      });
      await pool.start();
      const point = {
        n,
        quantization,
        file: {
          bytes: built.bytes,
          buildSeconds: built.buildSeconds,
          ...(built.reused ? { reused: true } : {}),
        },
      };
      try {
        log("latency warm-up", { quantization, n, tasks: tasks.length });
        await runTasks(
          pool,
          built.expected,
          tasks.map((t) => t.input),
        ); // warm-up, untimed
        log("latency warm pass", { quantization, n });
        const warm = await runTasks(
          pool,
          built.expected,
          tasks.map((t) => t.input),
        );
        const by = (pred) => warm.times.filter((_, i) => pred(tasks[i]));
        point.warm = {
          all: summarize(warm.times),
          unfiltered: summarize(by((t) => t.filter === "none")),
          filtered: summarize(by((t) => t.filter !== "none")),
          queries: summarize(by((t) => t.kind === "query")),
          terms: summarize(by((t) => t.kind === "term")),
          deadlines: warm.deadlines,
        };
        log("latency cold pass", { quantization, n });
        const handlesBeforePass = await pool.threadStats();
        const evicted = evictor.evict(built.path);
        const coldPass = await runTasks(
          pool,
          built.expected,
          tasks.map((t) => t.input),
        );
        const handlesAfterPass = await pool.threadStats();
        const coldEach = [];
        log("latency evicted-each", { quantization, n, tasks: coldSample.length });
        let method = evicted.method;
        for (const task of coldSample) {
          method = evictor.evict(built.path).method;
          coldEach.push(...(await runTasks(pool, built.expected, [task.input])).times);
        }
        point.cold = {
          eviction: { ...evicted, lastMethod: method },
          handlesBeforePass,
          handlesAfterPass,
          pass: {
            ...summarize(coldPass.times),
            firstTaskMs: Math.round(coldPass.times[0] * 10) / 10,
            deadlines: coldPass.deadlines,
          },
          evictedEach: summarize(coldEach),
        };
        point.p95 = Math.max(
          point.warm.all.p95,
          point.cold.pass.p95 ?? 0,
          point.cold.evictedEach.p95 ?? 0,
        );
      } finally {
        await pool.stop();
        if (!keepFiles && !reuseFiles) rmSync(built.path, { force: true });
      }
      record.points[quantization].push(point);
      log("latency point", {
        quantization,
        n,
        p95: point.p95,
        warm: point.warm.all,
        cold: point.cold.pass,
      });
      onPoint?.(record);
      if (stopOverBudget && point.p95 > BUDGET_MS) {
        log("over budget; larger N skipped", { quantization, n });
        break;
      }
    }
    record.bounds[quantization] = interpolateBound(record.points[quantization]);
  }
  return record;
}

async function commandLatency(options) {
  for (const key of ["vectors", "data", "work-dir"])
    if (!options[key]) throw new Error(`--${key} is required`);
  const workDir = resolve(String(options["work-dir"]));
  const out = resolve(String(options.out ?? join(workDir, "latency-results.json")));
  const record = await runLatency({
    vectorsWork: resolve(String(options.vectors)),
    data: resolve(String(options.data)),
    workDir,
    grid: list(options.n, DEFAULT_GRID).map((n) => int(n)),
    quantizations: list(options.quantizations, QUANTIZATIONS),
    queries: int(options.queries, 200),
    terms: int(options.terms, 20),
    jitter: options.jitter === undefined ? 0.3 : Number(options.jitter),
    seed: int(options.seed, 7),
    evict: String(options.evict ?? "auto"),
    evictFile: options["evict-file"] ? resolve(String(options["evict-file"])) : undefined,
    coldTasks: int(options["cold-tasks"], 20),
    keepFiles: options["keep-files"] === true,
    reuseFiles: options["reuse-files"] === true,
    stopOverBudget: options["stop-over-budget"] === true,
    allowTmpfs: options["allow-tmpfs"] === true,
    minVectors: int(options["min-vectors"], 1000),
    onPoint: (partial) => writeJsonAtomic(out, partial),
  });
  writeJsonAtomic(out, record);
  console.log(JSON.stringify({ bounds: record.bounds, out }, null, 2));
  for (const [quantization, bound] of Object.entries(record.bounds))
    if (bound.below)
      console.log(
        `STOP: ${quantization} is over budget at the smallest measured N — ask the user (decision 22).`,
      );
}

// ---------------------------------------------------------------------------------------------

const USAGE = `Usage (node --import tsx scripts/bench-index-quantization.mjs <command> …):
  embed   --model gemma|qwen --data <fiqa dir> --work <dir> --child-guard <bin>
          [--model-path <gguf>] [--docs all|N] [--context 1024] [--batch 4] [--seed 7]
  recall  --work <dir> [--quantizations int8,binary_int8_rescore] [--k-sweep 100,200]
  latency --vectors <qwen work dir> --data <fiqa dir> --work-dir <disk dir>
          [--n ${DEFAULT_GRID.join(",")}] [--queries 200] [--terms 20] [--evict auto|fadvise|reread|drop-caches|none]
          [--evict-file <path>] [--cold-tasks 20] [--keep-files] [--reuse-files] [--stop-over-budget] [--min-vectors 1000]
  host`;

async function main(argv) {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case "embed":
      return commandEmbed(options);
    case "recall":
      return commandRecall(options);
    case "latency":
      return commandLatency(options);
    case "host":
      console.log(JSON.stringify(hostRecord(resolve(String(options.dir ?? homedir()))), null, 2));
      return;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
