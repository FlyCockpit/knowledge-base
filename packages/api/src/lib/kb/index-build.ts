/**
 * Index build (worker only; the server must never reach this module — see
 * `apps/server/src/index-file-policy.test.ts`). One attempt writes one SQLite file under
 * `<indexDir>/<kbId>/<gen>.a<attempt>.tmp` and publishes it as `<gen>.sqlite` inside a fenced
 * transaction (§1.2, §1.4, §1.5, §1.8). Every Postgres write runs in a `fenced()` authority
 * transaction; disk is admitted through DISK_VOLUME reservations whose ids live on the
 * generation row and are released (never committed) at publish, failure, the next attempt's
 * reset, cancellation or the retention backstop.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PrismaClient } from "@knowledge-base/db/client";
import { logInternalError } from "@knowledge-base/env/log";
import { Client } from "pg";
import { recordAuditEvent } from "./audit";
import { runLockedOperation } from "./authority-lock";
import { LIVE_JOB_STATES, UNFINISHED_GENERATION_STATES } from "./build-liveness";
import { fitChunksToContext } from "./chunk";
import { convertSource } from "./converter";
import { EmbeddingInputTooLongError } from "./embed-client";
import type { Embedder } from "./embedder";
import { KbDomainError } from "./errors";
import {
  activateIndexBuild,
  buildActor,
  fenceIndexAttempt,
  type HybridIndexBuildSnapshot,
  type IndexAttempt,
  type IndexBuildSnapshot,
  indexBuildSnapshotSchema,
  isLexicalSnapshot,
  selectIndexEmbedder,
  usableIndexProfile,
} from "./generations";
import { hardenedGitEnv, kbBareRepoPath, readBlobsAsync } from "./git-read";
import { removeEarlierAttemptTemps, unlinkIndexFile } from "./index-file/files";
import {
  calibrationIds,
  generationFilePath,
  indexedRowsForDocument,
  int8Scale,
  unitVector,
  VECTOR_REUSE_MIN_FRACTION,
  vectorBytesPerChunk,
} from "./index-file/format";
import { closeIndexHandle, type IndexHandle, openIndexReadOnly } from "./index-file/reader";
import {
  decodeStoredVector,
  type IndexWriter,
  openIndexWriter,
  publishIndexFile,
  type StoredVector,
} from "./index-file/writer";
import { effectiveChunkLimit, loadChunkCeilings } from "./index-settings";
import { withJobAttempt } from "./job-attempt";
import { claimJobAttempt, DurableJobFenceError } from "./jobs";
import { KB_TREE_LIMITS } from "./limits";
import type { LockQuery } from "./lock";
import { parseAssetManifest } from "./manifest";
import { KbAdmissionError } from "./principal";
import { releaseQuota, reserveQuota, statfsDiskMeter } from "./quota";
import { redactForEmbed } from "./redact-for-embed";
import { comparePaths } from "./rrf";

/** Pass-1 initial estimate: four times the largest admitted Markdown tree (§1.8 1). */
export const INDEX_TEXT_RESERVATION_BYTES = 4 * KB_TREE_LIMITS.maxTreeBytes;
/** Reservations are only ever released; the expiry is a ledger backstop, not a lease. */
const DISK_RESERVATION_MS = 6 * 60 * 60 * 1000;
/** Directory/journal slack added to every projection. */
const INDEX_SLACK_BYTES = 16 * 1024 * 1024;
const TOP_UP_EVERY_DOCUMENTS = 64;
const SIZE_CHECK_EVERY_BATCHES = 256;

/** Pass 1 counted more chunks than the KB's effective limit; nothing was embedded. */
export class ChunkLimitError extends Error {
  constructor() {
    super("Index chunk limit exceeded");
    this.name = "ChunkLimitError";
  }
}

export type BuildOptions = {
  connectionString: string;
  reposDir: string;
  /** `<KB_DATA_ROOT>/index`: one `<kbId>/` directory of generation files per KB. */
  indexDir: string;
  masterKey: string | undefined;
  workerId: string;
  durableJobId: string;
  /** Worker-owned forked-child embedder for SYSTEM_BUILTIN profiles. */
  qwenEmbedder?: Embedder;
  // Deterministic test seams; production passes none.
  embedder?: Embedder;
  /** After the fenced reset committed, before any file cleanup. */
  afterReset?: () => Promise<void>;
  /** Inside a fenced reservation transaction, after its ids were appended (before COMMIT). */
  afterReserve?: () => Promise<void>;
  /** Before a fenced reservation transaction opens. */
  beforeReserve?: () => Promise<void>;
  /** Pass-1 initial reservation (default INDEX_TEXT_RESERVATION_BYTES). */
  initialTextReservationBytes?: number;
  /** After pass 1 committed its accounting, before any embedding. */
  afterPass1?: () => Promise<void>;
  /** After the file was finalized under its temp name, before publish. */
  afterChunks?: () => Promise<void>;
  /** Inside the publish transaction, after link and before COMMIT. */
  afterLink?: () => Promise<void>;
  beforeActivation?: () => Promise<void>;
};

async function connect(url: string) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  client.on("error", () => {});
  await client.connect();
  return client;
}

function buildTransaction<T>(url: string, run: (query: LockQuery) => Promise<T>) {
  return runLockedOperation({
    connectionString: url,
    opId: randomUUID(),
    kind: "authority",
    run: (lease) => lease.transaction(run),
  });
}

/** Source blobs read per batched Git process (bounded memory, never one process per document). */
const BUILD_BLOB_BATCH = 256;

async function readBuildBlobs(
  repo: string,
  shas: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Buffer>> {
  try {
    return await readBlobsAsync(
      repo,
      shas,
      { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
      { signal },
    );
  } catch (error) {
    if (signal.aborted) throw new DurableJobFenceError();
    throw error;
  }
}

async function readBuildGit(
  repo: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer = 4 * 1024 * 1024,
): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: repo,
        env: hardenedGitEnv(),
        encoding: "buffer",
        maxBuffer,
        timeout: 10000,
        killSignal: "SIGKILL",
      },
      (error, bytes) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(new DurableJobFenceError());
        else if (error) reject(error);
        else resolve(bytes);
      },
    );
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** `{type,title,titleFolded,tags,timestamp}`; a redaction refusal stores no metadata values. */
function metadataJson(structured: {
  type: string | null;
  title: string | null;
  titleFolded: string | null;
  tags: string[];
  timestamp: string;
}): Record<string, unknown> {
  const metadata = {
    type: structured.type,
    title: structured.title,
    titleFolded: structured.titleFolded,
    tags: structured.tags,
    timestamp: structured.timestamp,
  };
  const redacted = redactForEmbed(JSON.stringify(metadata));
  if (redacted !== null) {
    try {
      return JSON.parse(redacted) as Record<string, unknown>;
    } catch {
      /* redaction changed the JSON shape: fall through */
    }
  }
  return { type: null, title: null, titleFolded: null, tags: [], timestamp: metadata.timestamp };
}

function redactedJson(value: unknown, empty: unknown): unknown {
  const redacted = redactForEmbed(JSON.stringify(value));
  if (redacted === null) return empty;
  try {
    return JSON.parse(redacted);
  } catch {
    return empty;
  }
}

type DocumentRow = {
  path: string;
  blobSha: string;
  contentHash: string;
  originalWindowCount: number;
  retainedWindowCount: number;
  state: "INDEXED" | "EMPTY" | "SKIPPED_REDACTED";
};

function failureCode(error: unknown): string {
  if (error instanceof ChunkLimitError) return "INDEX_CHUNK_LIMIT_EXCEEDED";
  if (error instanceof KbAdmissionError)
    return error.code === "QUOTA_EXCEEDED" ? "INDEX_DISK_FULL" : "INDEX_BUILD_FAILED";
  // Overflow is a visible, user-fixable failure, never truncation, for
  // external providers; the built-in model fits every piece first.
  if (error instanceof EmbeddingInputTooLongError) return "EMBEDDING_INPUT_TOO_LONG";
  return "INDEX_BUILD_FAILED";
}

/** The lexical companion one epoch below a semantic build is still unbuilt. */
export async function companionPending(
  db: Pick<PrismaClient, "indexGeneration">,
  snapshot: { kbId: string; epoch: string },
): Promise<boolean> {
  const pending = await db.indexGeneration.count({
    where: {
      kbId: snapshot.kbId,
      epoch: BigInt(snapshot.epoch) - 1n,
      providerId: null,
      // `inProgressBuildSql`, as a Prisma filter.
      state: { in: [...UNFINISHED_GENERATION_STATES] },
      job: { state: { in: [...LIVE_JOB_STATES] } },
    },
  });
  return pending > 0;
}

/** Session permits protect actual execution, including an expired/late attempt; terminal rows do not. */
export async function runIndexBuildDelivery(db: PrismaClient, options: BuildOptions) {
  const delivery = await db.durableJob.findUnique({ where: { id: options.durableJobId } });
  if (delivery?.kind !== "INDEX_KB") return { skipped: true };
  const snapshot = indexBuildSnapshotSchema.parse(delivery.desired);
  // A semantic build depends on its lexical companion explicitly (whatever order the
  // dispatcher delivers them in): it is not claimed — so never holds the KB permit through
  // embedding — while the companion is unbuilt. The delivery is retried later.
  if (!isLexicalSnapshot(snapshot) && (await companionPending(db, snapshot)))
    return { skipped: true };
  const permits = await connect(options.connectionString);
  const abort = new AbortController();
  permits.on("error", () => abort.abort());
  let released = false;
  const release = async () => {
    if (!released) {
      released = true;
      await permits.end();
    }
  };
  try {
    const kb = await permits.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,24)) AS ok",
      [snapshot.kbId],
    );
    if (!kb.rows[0]?.ok) return { skipped: true };
    // Every built-in executor, including ordinary commit/manual builds, owns this
    // session permit until embeddings, Git children and file writes have drained. A
    // cancelled durable job or retargeted migration row never releases execution ownership.
    if (!isLexicalSnapshot(snapshot) && snapshot.ownerId === null) {
      const builtin = await permits.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock(1262635337,2) AS ok",
      );
      if (!builtin.rows[0]?.ok) return { skipped: true };
    }
    let slot = false;
    for (let i = 0; i < 2; i++) {
      if (
        (
          await permits.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(1262635337,$1) AS ok", [
            i,
          ])
        ).rows[0]?.ok
      ) {
        slot = true;
        break;
      }
    }
    if (!slot) return { skipped: true };
    const job = await claimJobAttempt(db, {
      jobId: delivery.id,
      workerId: options.workerId,
      now: new Date(),
    });
    if (!job) return { skipped: true };
    const attempt = { jobId: job.id, workerId: options.workerId, epoch: job.attemptEpoch };
    const fenced = <T>(run: (query: LockQuery) => Promise<T>) =>
      buildTransaction(options.connectionString, async (query) => {
        abort.signal.throwIfAborted();
        await fenceIndexAttempt(query, snapshot, attempt);
        return run(query);
      });
    return await withJobAttempt(job, { db, workerId: options.workerId }, () =>
      buildAttempt(options, snapshot, attempt, fenced, abort.signal, release),
    );
  } finally {
    abort.abort();
    await release();
  }
}

type Fenced = <T>(run: (query: LockQuery) => Promise<T>) => Promise<T>;

/**
 * Long synchronous build loops (vector reuse, hashing, scans of the previous file) yield to
 * the event loop every this many rows, so the attempt heartbeat keeps the lease alive, and
 * recheck the attempt fence every `REUSE_FENCE_ROWS`, so a lost attempt stops promptly.
 */
const REUSE_YIELD_ROWS = 512;
const REUSE_FENCE_ROWS = 8192;
function yieldToHeartbeat(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The KB's active generation file when it has this build's fingerprint, dimensions and
 * quantization (and at least one chunk): its int8 scale, the first chunk id of every text hash
 * (computed from the stored text in a v1 file) and a reader for its stored vector bytes.
 */
type ReuseSource = {
  handle: IndexHandle;
  scale: number;
  byHash: Map<string, number>;
  stored(id: number): StoredVector;
};

async function openReuseSource(
  indexDir: string,
  snapshot: HybridIndexBuildSnapshot,
  fenced: Fenced,
  signal: AbortSignal,
): Promise<ReuseSource | null> {
  // Also retain the newest retained semantic generation of the same profile, the active one first.
  // A lexical companion of a newer head may serve meanwhile; the hybrid it retired (SUPERSEDED,
  // files kept until retention purges them) still holds vectors. R3-L2 (CLI twin
  // `reuse_source`): candidates are walked in bounded pages until one is usable; a candidate that
  // cannot serve (file gone or unreadable, another quantization, a damaged hash table) falls
  // through to the next, and none at all means re-embedding. Only the build's own abort stops it.
  const PAGE = 16;
  let after: { epoch: string; id: string } | null = null;
  let activeDone = false;
  for (;;) {
    const page = await fenced(
      async (query) =>
        (
          await query<{
            id: string;
            epoch: string;
            commitSha: string;
            chunkCount: number;
            documentCount: number;
          }>(
            `SELECT g.id,g.epoch::text AS epoch,g."commitSha",g."chunkCount",g."documentCount"
               FROM index_generation g JOIN knowledge_base k ON k.id=g."kbId"
             WHERE g."kbId"=$1 AND g.id<>$4 AND g.state IN ('COMPLETE','SUPERSEDED')
               AND g."providerId" IS NOT NULL AND g.fingerprint=$2 AND g.dimensions=$3 AND g."chunkCount">0
               AND ${
                 activeDone
                   ? `g.id IS DISTINCT FROM k."activeGenerationId" AND ($5::bigint IS NULL OR (g.epoch,g.id)<($5::bigint,$6::text))`
                   : `g.id=k."activeGenerationId" AND $5::bigint IS NULL AND $6::text IS NULL`
               }
             ORDER BY g.epoch DESC, g.id DESC LIMIT ${PAGE}`,
            [
              snapshot.kbId,
              snapshot.fingerprint,
              snapshot.dimensions,
              snapshot.generationId,
              after?.epoch ?? null,
              after?.id ?? null,
            ],
          )
        ).rows,
    );
    if (activeDone && page.length === 0) return null;
    for (const candidate of page) {
      // Review r2 #5 (CLI twin): the build's abort is observed between candidates as well as
      // inside each one's paged hash scan (`yieldToHeartbeat`).
      signal.throwIfAborted();
      if (activeDone) after = { epoch: candidate.epoch, id: candidate.id };
      const source = await loadReuseCandidate(indexDir, snapshot, candidate, signal).catch(
        (error: unknown) => {
          if (signal.aborted) throw error;
          // This candidate cannot serve; the next one may.
          return null;
        },
      );
      if (source) return source;
    }
    activeDone = true;
  }
}

/** One candidate's file as a reuse source; any failure belongs to this candidate. */
async function loadReuseCandidate(
  indexDir: string,
  snapshot: HybridIndexBuildSnapshot,
  candidate: { id: string; commitSha: string; chunkCount: number; documentCount: number },
  signal: AbortSignal,
): Promise<ReuseSource | null> {
  const handle = openIndexReadOnly(indexDir, {
    generationId: candidate.id,
    kbId: snapshot.kbId,
    commitSha: candidate.commitSha,
    fingerprint: snapshot.fingerprint,
    dimensions: snapshot.dimensions,
    chunkCount: candidate.chunkCount,
    documentCount: candidate.documentCount,
  });
  try {
    const { meta, db } = handle;
    if (meta.quantization !== snapshot.quantization || meta.int8Scale === null) {
      closeIndexHandle(handle);
      return null;
    }
    const scale = meta.int8Scale;
    const byHash = new Map<string, number>();
    const page = db.prepare("SELECT id, h FROM chunk_hash WHERE id > ? ORDER BY id LIMIT ?");
    for (let after = 0; ; ) {
      const rows = page.all(after, REUSE_YIELD_ROWS) as Array<{ id: number; h: Buffer }>;
      for (const row of rows) {
        const key = row.h.toString("hex");
        if (!byHash.has(key)) byHash.set(key, row.id);
      }
      if (rows.length < REUSE_YIELD_ROWS) break;
      after = rows.at(-1)!.id;
      await yieldToHeartbeat(signal);
    }
    const read = (sql: string) => {
      const statement = db.prepare(sql).pluck();
      return (id: number): unknown => statement.get(id);
    };
    // Review r2 #2: decoded and width-checked once here; a row that fails throws and the
    // chunk is embedded again (reusePass).
    const stored: (id: number) => StoredVector =
      meta.quantization === "int8"
        ? (() => {
            const int8 = read("SELECT embedding FROM chunk_vec WHERE rowid=?");
            return (id) => decodeStoredVector("int8", snapshot.dimensions, null, int8(id));
          })()
        : (() => {
            const bits = read("SELECT b FROM chunk_bits WHERE id=?");
            const int8 = read("SELECT e FROM chunk_int8 WHERE id=?");
            return (id) =>
              decodeStoredVector("binary_int8_rescore", snapshot.dimensions, bits(id), int8(id));
          })();
    return { handle, scale, byHash, stored };
  } catch (error) {
    closeIndexHandle(handle);
    throw error;
  }
}

/**
 * Pass 2 of a hybrid build: when enough chunks are unchanged since the KB's active file of
 * the same layout, the build inherits that file's int8 scale, copies the stored vectors of every
 * unchanged chunk and embeds only the rest. Otherwise: calibration sample first, then every
 * chunk's vector once.
 */
async function embedPass(
  file: IndexWriter,
  snapshot: HybridIndexBuildSnapshot,
  embedder: Embedder,
  kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN",
  chunkCount: number,
  fenced: Fenced,
  topUp: (query: LockQuery, projected: number) => Promise<void>,
  signal: AbortSignal,
  indexDir: string,
): Promise<void> {
  const source = chunkCount > 0 ? await openReuseSource(indexDir, snapshot, fenced, signal) : null;
  try {
    if (source) {
      const hashes: Map<number, string> = new Map();
      for (let first = 1; first <= chunkCount; first += REUSE_YIELD_ROWS) {
        const ids: number[] = [];
        for (let id = first; id <= Math.min(chunkCount, first + REUSE_YIELD_ROWS - 1); id++)
          ids.push(id);
        file.chunkHashes(ids).forEach((hash, at) => {
          hashes.set(ids[at]!, hash.toString("hex"));
        });
        await yieldToHeartbeat(signal);
      }
      let hits = 0;
      for (const hash of hashes.values()) if (source.byHash.has(hash)) hits += 1;
      if (hits >= VECTOR_REUSE_MIN_FRACTION * chunkCount) {
        await reusePass(file, snapshot, embedder, kind, chunkCount, fenced, topUp, signal, {
          source,
          hashes,
        });
        return;
      }
    }
    await freshPass(file, snapshot, embedder, kind, chunkCount, fenced, topUp, signal);
  } finally {
    if (source) closeIndexHandle(source.handle);
  }
}

/** Inherited scale; unchanged chunks copy their stored bytes, the rest is embedded. */
async function reusePass(
  file: IndexWriter,
  snapshot: HybridIndexBuildSnapshot,
  embedder: Embedder,
  kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN",
  chunkCount: number,
  fenced: Fenced,
  topUp: (query: LockQuery, projected: number) => Promise<void>,
  signal: AbortSignal,
  reuse: { source: ReuseSource; hashes: Map<number, string> },
): Promise<void> {
  const perChunk = vectorBytesPerChunk(snapshot.quantization, snapshot.dimensions);
  await fenced((query) =>
    topUp(query, file.sizeBytes() + chunkCount * perChunk + INDEX_SLACK_BYTES),
  );
  file.setInt8Scale(reuse.source.scale);
  const batchSize = kind === "SYSTEM_BUILTIN" ? 1 : 32;
  const pending: number[] = [];
  const embedPending = async () => {
    if (pending.length === 0) return;
    const ids = pending.splice(0);
    // A revoked or retargeted profile stops spending at the next batch.
    await fenced((query) =>
      usableIndexProfile(query, snapshot.providerId, snapshot.revision, "build"),
    );
    const vectors = await embedder.embed(file.chunkTexts(ids), { purpose: "document", signal });
    if (vectors.length !== ids.length) throw new Error("Embedding count");
    file.appendVectors(ids.map((id, i) => ({ id, vector: vectors[i]! })));
  };
  const stored: Array<{ id: number; stored: StoredVector }> = [];
  for (let id = 1; id <= chunkCount; id++) {
    // An all-reused rebuild never awaits an embedding: yield and recheck the attempt here.
    if (id % REUSE_YIELD_ROWS === 0) {
      file.appendStored(stored.splice(0));
      await yieldToHeartbeat(signal);
    }
    if (id % REUSE_FENCE_ROWS === 0) await fenced(async () => {});
    const old = reuse.source.byHash.get(reuse.hashes.get(id)!);
    if (old === undefined) {
      pending.push(id);
      if (pending.length === batchSize) await embedPending();
      continue;
    }
    // A stored vector the source cannot return (a damaged page) is embedded again instead,
    // under the inherited scale.
    let copied: StoredVector;
    try {
      copied = reuse.source.stored(old);
    } catch {
      pending.push(id);
      if (pending.length === batchSize) await embedPending();
      continue;
    }
    stored.push({ id, stored: copied });
  }
  file.appendStored(stored.splice(0));
  await embedPending();
}

/** Pass 2 without reuse: calibration sample first, then every chunk's vector once. */
async function freshPass(
  file: IndexWriter,
  snapshot: HybridIndexBuildSnapshot,
  embedder: Embedder,
  kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN",
  chunkCount: number,
  fenced: Fenced,
  topUp: (query: LockQuery, projected: number) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const perChunk = vectorBytesPerChunk(snapshot.quantization, snapshot.dimensions);
  await fenced((query) =>
    topUp(query, file.sizeBytes() + chunkCount * perChunk + INDEX_SLACK_BYTES),
  );
  const batchSize = kind === "SYSTEM_BUILTIN" ? 1 : 32;
  const embed = async (ids: number[]) => {
    // A revoked or retargeted profile stops spending at the next batch.
    await fenced((query) =>
      usableIndexProfile(query, snapshot.providerId, snapshot.revision, "build"),
    );
    const vectors = await embedder.embed(file.chunkTexts(ids), {
      purpose: "document",
      signal,
    });
    if (vectors.length !== ids.length) throw new Error("Embedding count");
    return vectors;
  };
  // CL2-CALIB: the int8 calibration sample is embedded first and kept, so every chunk is
  // embedded exactly once.
  // The writer takes RAW embeddings and normalizes each exactly once (§1.4); the sample keeps
  // the raw values (exact f64 copies) and only derives its unit vectors to compute the scale.
  const sampled = new Map<number, Float64Array>();
  if (chunkCount > 0) {
    const ids = calibrationIds(chunkCount);
    for (let at = 0; at < ids.length; at += batchSize) {
      const batch = ids.slice(at, at + batchSize);
      const vectors = await embed(batch);
      batch.forEach((id, i) => {
        sampled.set(id, Float64Array.from(vectors[i]!));
      });
    }
    file.setInt8Scale(
      int8Scale([...sampled.values()].map((raw) => unitVector(raw, snapshot.dimensions))),
    );
  }
  let batches = 0;
  for (let first = 1; first <= chunkCount; first += batchSize) {
    const ids: number[] = [];
    for (let id = first; id <= Math.min(chunkCount, first + batchSize - 1); id++) ids.push(id);
    const missing = ids.filter((id) => !sampled.has(id));
    const vectors = missing.length > 0 ? await embed(missing) : [];
    const embedded = new Map(missing.map((id, i) => [id, vectors[i]!]));
    file.appendVectors(ids.map((id) => ({ id, vector: sampled.get(id) ?? embedded.get(id)! })));
    for (const id of ids) sampled.delete(id);
    batches += 1;
    if (batches % SIZE_CHECK_EVERY_BATCHES === 0) {
      const remaining = Math.min(SIZE_CHECK_EVERY_BATCHES * batchSize, chunkCount - first);
      await fenced((query) =>
        topUp(query, file.sizeBytes() + remaining * perChunk * 1.25 + INDEX_SLACK_BYTES),
      );
    }
  }
}

export async function buildAttempt(
  options: BuildOptions,
  snapshot: IndexBuildSnapshot,
  attempt: IndexAttempt,
  fenced: Fenced,
  signal: AbortSignal,
  releasePermits: () => Promise<void>,
) {
  const finalPath = generationFilePath(options.indexDir, snapshot.kbId, snapshot.generationId);
  const kbDir = dirname(finalPath);
  let writer: IndexWriter | null = null;
  let tempPath: string | null = null;
  try {
    // (b) The successor owns all cleanup before any potentially failing source/provider IO:
    // the previous attempt's reservations are released and its rows and files removed.
    const chunkLimit = await fenced(async (query) => {
      const prior =
        (
          await query<{ ids: string[] }>(
            `SELECT "quotaReservationIds" AS ids FROM index_generation WHERE id=$1`,
            [snapshot.generationId],
          )
        ).rows[0]?.ids ?? [];
      if (prior.length > 0) await releaseQuota({ transactionQuery: query }, prior);
      const reset = await query(
        `UPDATE index_generation SET state='BUILDING',attempt=$2,"documentCount"=0,"chunkCount"=0,"errorCode"=NULL,"quotaReservationIds"='{}'
        WHERE id=$1 AND state NOT IN ('COMPLETE','SUPERSEDED')`,
        [snapshot.generationId, attempt.epoch],
      );
      if (reset.rowCount !== 1) throw new DurableJobFenceError();
      await query('DELETE FROM generation_document WHERE "generationId"=$1', [
        snapshot.generationId,
      ]);
      const kb = (
        await query<{ indexChunkLimit: number | null }>(
          `SELECT "indexChunkLimit" FROM knowledge_base WHERE id=$1`,
          [snapshot.kbId],
        )
      ).rows[0];
      return effectiveChunkLimit(
        { indexChunkLimit: kb?.indexChunkLimit ?? null },
        snapshot.quantization,
        await loadChunkCeilings(query),
      );
    });
    await options.afterReset?.();
    // Ownership is structural: only earlier attempts' temps are reclaimed here (a late-running
    // superseded reset can never reach a successor's names); a stale final is replaced only in
    // the fenced publish transaction.
    await removeEarlierAttemptTemps(kbDir, snapshot.generationId, attempt.epoch);
    // A lexical-only generation pins no profile and never embeds.
    const hybrid = isLexicalSnapshot(snapshot) ? null : snapshot;
    const profile = hybrid
      ? await fenced((query) =>
          usableIndexProfile(query, hybrid.providerId, hybrid.revision, "build"),
        )
      : null;
    const repo = kbBareRepoPath(options.reposDir, snapshot.kbId);
    const git = (args: string[], max?: number) => readBuildGit(repo, args, signal, max);
    const entries = (await git(["ls-tree", "-rz", "--full-tree", snapshot.commitSha]))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (entries.length > KB_TREE_LIMITS.maxFiles) throw new Error("Tree budget");
    const documents = entries
      .map((entry) => {
        const parsed = /^(100644) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if (!parsed) throw new Error("Invalid source entry");
        return { blobSha: parsed[2]!, path: parsed[3]! };
      })
      .filter((entry) => entry.path.endsWith(".md"))
      // chunks.id order must equal (path bytes, chunk_index) order (§1.2).
      .sort((a, b) => comparePaths(a.path, b.path));
    const manifest = parseAssetManifest(
      await git(["show", `${snapshot.commitSha}:.assets/manifest.json`]),
    );
    if (!("entries" in manifest)) throw new Error("Invalid manifest");
    const stamp = new Date(
      (await git(["show", "-s", "--format=%cI", snapshot.commitSha])).toString("utf8").trim(),
    ).toISOString();
    const embedder =
      hybrid && profile
        ? (options.embedder ?? selectIndexEmbedder(profile, hybrid, options))
        : null;

    // Disk admission (§1.8): ids are appended to the generation row in the same transaction.
    await mkdir(kbDir, { recursive: true, mode: 0o750 });
    const meter = statfsDiskMeter(kbDir);
    let reservedTotal = 0;
    let reservationCount = 0;
    const reserve = async (query: LockQuery, bytes: number) => {
      reservationCount += 1;
      const lease = await reserveQuota(
        { transactionQuery: query },
        {
          opId: `index-build:${snapshot.generationId}:${attempt.epoch}:${reservationCount}`,
          charges: [],
          disks: [{ path: kbDir, bytes: BigInt(Math.ceil(bytes)), meter }],
          expiresAt: new Date(Date.now() + DISK_RESERVATION_MS),
        },
      );
      const appended = await query(
        `UPDATE index_generation SET "quotaReservationIds"="quotaReservationIds" || $2::text[]
        WHERE id=$1 AND attempt=$3 AND state='BUILDING'`,
        [snapshot.generationId, lease.reservationIds, attempt.epoch],
      );
      if (appended.rowCount !== 1) throw new DurableJobFenceError();
      reservedTotal += Math.ceil(bytes);
      await options.afterReserve?.();
    };
    const topUp = (query: LockQuery, projected: number) =>
      projected > reservedTotal ? reserve(query, projected - reservedTotal) : Promise.resolve();

    await options.beforeReserve?.();
    await fenced((query) =>
      reserve(query, options.initialTextReservationBytes ?? INDEX_TEXT_RESERVATION_BYTES),
    );
    writer = openIndexWriter({
      indexDir: options.indexDir,
      kbId: snapshot.kbId,
      generationId: snapshot.generationId,
      attempt: attempt.epoch,
      commitSha: snapshot.commitSha,
      ...(hybrid
        ? {
            fingerprint: hybrid.fingerprint,
            quantization: hybrid.quantization,
            dimensions: hybrid.dimensions,
          }
        : { lexical: true as const }),
    });
    tempPath = writer.tempPath;
    const file = writer;

    // Pass 1: text, FTS and per-document accounting; the chunk limit is enforced before any
    // embedding spend.
    let documentCount = 0;
    let chunkCount = 0;
    let pending: DocumentRow[] = [];
    const flush = async () => {
      const rows = pending;
      pending = [];
      await fenced(async (query) => {
        if (rows.length > 0) {
          const values: unknown[] = [];
          const placeholders = rows.map((row) => {
            const offset = values.length;
            values.push(
              snapshot.generationId,
              row.path,
              row.blobSha,
              row.contentHash,
              row.originalWindowCount,
              row.retainedWindowCount,
              row.state,
            );
            return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7}::"GenerationDocumentState")`;
          });
          await query(
            `INSERT INTO generation_document ("generationId",path,"blobSha","contentHash","originalWindowCount","retainedWindowCount",state) VALUES ${placeholders.join(",")}`,
            values,
          );
        }
        const counted = await query(
          `UPDATE index_generation SET "documentCount"=$2,"chunkCount"=$3 WHERE id=$1 AND attempt=$4 AND state='BUILDING'`,
          [snapshot.generationId, documentCount, chunkCount, attempt.epoch],
        );
        if (counted.rowCount !== 1) throw new DurableJobFenceError();
        const size = file.sizeBytes();
        const left = documents.length - documentCount;
        const perDocument = documentCount > 0 ? size / documentCount : 0;
        await topUp(
          query,
          size + perDocument * Math.min(TOP_UP_EVERY_DOCUMENTS, left) * 1.25 + INDEX_SLACK_BYTES,
        );
      });
    };
    let bytesRead = 0;
    let batch: ReadonlyMap<string, Buffer> = new Map();
    for (const [index, entry] of documents.entries()) {
      if (index % BUILD_BLOB_BATCH === 0)
        batch = await readBuildBlobs(
          repo,
          documents.slice(index, index + BUILD_BLOB_BATCH).map((next) => next.blobSha),
          signal,
        );
      const bytes = batch.get(entry.blobSha);
      if (!bytes) throw new Error("Source blob missing");
      bytesRead += bytes.length;
      if (bytesRead > KB_TREE_LIMITS.maxTreeBytes) throw new Error("Tree budget");
      const converted = convertSource({
        mediaType: "text/markdown",
        bytes,
        path: entry.path,
        commitSha: snapshot.commitSha,
        commitTimestamp: stamp,
        manifest: { commitSha: snapshot.commitSha, entries: manifest.entries },
      });
      if (converted.source.blobSha !== entry.blobSha) throw new Error("Source blob mismatch");
      // The built-in model fits every piece to its configured context.
      const doc = embedder?.measureInputs
        ? {
            ...converted,
            ...(await fitChunksToContext(converted.source.body, converted, (texts) =>
              embedder!.measureInputs!(texts, { signal }),
            )),
          }
        : converted;
      chunkCount += doc.chunks.length;
      if (chunkCount > chunkLimit) throw new ChunkLimitError();
      file.appendDocument(
        {
          path: doc.source.path,
          blobSha: doc.source.blobSha,
          contentHash: doc.source.contentHash,
          documentId: doc.source.documentId,
          state: doc.state,
          originalWindowCount: doc.originalWindowCount,
          source: {
            commitSha: snapshot.commitSha,
            blobSha: doc.source.blobSha,
            contentHash: doc.source.contentHash,
            documentId: doc.source.documentId,
            documentCitations: redactedJson(doc.source.documentCitations, []),
            assetRefs: doc.source.assetRefs,
          },
          metadata: metadataJson(doc.structured),
          rows:
            doc.state === "INDEXED"
              ? indexedRowsForDocument(doc.source.body, doc.structured.rows)
              : [],
        },
        doc.chunks.map((chunk) => ({
          chunkIndex: chunk.chunkIndex,
          span: chunk.span,
          text: chunk.text,
          snippet: chunk.snippet,
        })),
      );
      documentCount += 1;
      pending.push({
        path: doc.source.path,
        blobSha: doc.source.blobSha,
        contentHash: doc.source.contentHash,
        originalWindowCount: doc.originalWindowCount,
        retainedWindowCount: doc.chunks.length,
        state: doc.state,
      });
      if (pending.length >= TOP_UP_EVERY_DOCUMENTS) await flush();
    }
    await flush();
    await options.afterPass1?.();

    // Pass 2: vectors (hybrid only). The vector estimate is reserved before the first embedding.
    if (hybrid && embedder && profile)
      await embedPass(
        file,
        hybrid,
        embedder,
        profile.kind,
        chunkCount,
        fenced,
        topUp,
        signal,
        options.indexDir,
      );

    // Finalize: meta last, close, fsync, rollback-journal header and no side file.
    const finalized = file.finalize();
    writer = null;
    if (finalized.documentCount !== documentCount || finalized.chunkCount !== chunkCount)
      throw new Error("Index file accounting mismatch");
    await options.afterChunks?.();

    // (a) Publish: link (never clobbers) → unlink temp → chmod → dir fsync, then release the
    // reservations and leave BUILDING in the same statement that clears their ids.
    await fenced(async (query) => {
      const row = (
        await query<{ documentCount: number; chunkCount: number; ids: string[] }>(
          `SELECT "documentCount","chunkCount","quotaReservationIds" AS ids FROM index_generation
          WHERE id=$1 AND attempt=$2 AND state='BUILDING'`,
          [snapshot.generationId, attempt.epoch],
        )
      ).rows[0];
      if (!row) throw new DurableJobFenceError();
      if (row.documentCount !== finalized.documentCount || row.chunkCount !== finalized.chunkCount)
        throw new Error("Index file accounting mismatch");
      await publishIndexFile(finalized.tempPath, finalPath, { replaceStale: true });
      tempPath = null;
      await options.afterLink?.();
      if (row.ids.length > 0) await releaseQuota({ transactionQuery: query }, row.ids);
      const moved = await query(
        `UPDATE index_generation SET state='INDEXING',"quotaReservationIds"='{}' WHERE id=$1 AND attempt=$2 AND state='BUILDING'`,
        [snapshot.generationId, attempt.epoch],
      );
      if (moved.rowCount !== 1) throw new DurableJobFenceError();
    });
    // All costly build work has drained. A newer build may now finish before this CAS.
    await releasePermits();
    await options.beforeActivation?.();
    return await buildTransaction(options.connectionString, (query) =>
      activateIndexBuild(query, snapshot, attempt),
    );
  } catch (error) {
    writer?.abort();
    if (tempPath) {
      await unlinkIndexFile(tempPath).catch(() => {});
      await unlinkIndexFile(`${tempPath}-journal`).catch(() => {});
    }
    if (error instanceof DurableJobFenceError) throw error;
    const reasonCode = failureCode(error);
    // A fixed record: the error class and reason code, never its message (provider/source text).
    logInternalError("kb.index-build", error, { code: reasonCode });
    // (c) Release, then leave BUILDING in the statement that clears the ids (I1).
    await fenced(async (query) => {
      const ids =
        (
          await query<{ ids: string[] }>(
            `SELECT "quotaReservationIds" AS ids FROM index_generation WHERE id=$1 AND attempt=$2`,
            [snapshot.generationId, attempt.epoch],
          )
        ).rows[0]?.ids ?? [];
      if (ids.length > 0) await releaseQuota({ transactionQuery: query }, ids);
      await query(
        `UPDATE index_generation SET state='FAILED',"errorCode"=$3,"quotaReservationIds"='{}' WHERE id=$1 AND attempt=$2 AND state IN ('PENDING','BUILDING','INDEXING')`,
        [snapshot.generationId, attempt.epoch, reasonCode],
      );
      await recordAuditEvent(query, {
        opId: `${attempt.jobId}:${attempt.epoch}`,
        action: "generation_fail",
        outcome: "FAILURE",
        ...buildActor(snapshot),
        kbId: snapshot.kbId,
        metadata: { reasonCode },
      });
    });
    throw new KbDomainError("INDEX_UNAVAILABLE", "Index build failed");
  }
}
