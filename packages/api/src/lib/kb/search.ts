import { randomUUID } from "node:crypto";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import { Client } from "pg";
import type { z } from "zod";
import type { IndexStatus } from "./attachment";
import { type CitationHit, type CitationSourceRow, projectCitationHit } from "./citation";
import { IndexFileMissingError, KbDomainError } from "./errors";
import type { IndexActor } from "./generations";
import { getIndexReader } from "./index-file/pool";
import type { HybridTaskResult, IndexCitationRow } from "./index-file/reader";
import { servedFreshness } from "./index-status";
import type { RatePort } from "./limits";
import type { LockQuery } from "./lock";
import type { IndexNotice } from "./protocol/common";
import { kbReadToolSchemas } from "./protocol/reads";
import {
  type LeasedQueryVector,
  type LexicalGeneration,
  QUERY_DEADLINE_MS,
  type QueryEmbeddingOptions,
  type SearchReadDrain,
  withQueryEmbedding,
} from "./query-embedding";
import { prepareEmbeddingQuery } from "./redact-for-embed";
import { type FusedChunk, fuseReciprocalRanks, normalizedRrfScore } from "./rrf";
import type { NormalizedStructuredFilters, StructuredFilters } from "./structured";

export const SEARCH_DEFAULT_LIMIT = 6;
const searchSchemas = kbReadToolSchemas.knowledge_search;
export type SearchInput = z.input<typeof searchSchemas.input>;
export type SearchResult = z.infer<typeof searchSchemas.output>;
export type SearchArm = "vector" | "fts";
export type SearchOptions = QueryEmbeddingOptions & {
  ratePort: RatePort;
  /** Deterministic test barriers/faults only; production passes none. */
  hooks?: {
    beforeRead?: () => Promise<void>;
    beforeArm?: (arm: SearchArm) => Promise<void>;
    /** After the page's read transaction, before the final authorization (structured only). */
    afterRead?: () => Promise<void>;
  };
};

/**
 * A search that ranked with a KB's index built under previous built-in
 * embedder settings says so, machine-readably, on every transport.
 */
export function indexNoticesFor(
  kbId: string,
  index: Pick<IndexStatus, "rebuildPending">,
  source?: ArmSource,
): IndexNotice[] {
  // A lexical-only generation says why it is lexical-only.
  if (source && "lexical" in source && source.notice) return [source.notice];
  return index.rebuildPending
    ? [{ kbId, code: "EMBEDDING_REBUILD_PENDING" as const, detail: index.rebuildPending }]
    : [];
}

function unavailable(): KbDomainError {
  return new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
}

type Filters = { pathPrefix: string | null; documentId: string | null };
/** knowledge_structured_search: exact filters inside both arms, then a keyset page of the fusion. */
export type HybridStructured = {
  filters: NormalizedStructuredFilters;
  /** The request filters as given; the reader matches them like indexed documents. */
  raw: StructuredFilters;
  after: FusedChunk | null;
};
export type HybridRead = {
  hits: CitationHit[];
  hasMore: boolean;
  last: FusedChunk | null;
  commitSha: string;
};

/**
 * One keyset page of an already total fused order. The key must still be present with the same
 * score; otherwise the pinned ordering drifted and the cursor is refused instead of skipping rows.
 */
export function pageAfterHybrid(fused: FusedChunk[], after: FusedChunk | null, limit: number) {
  let start = 0;
  if (after) {
    const at = fused.findIndex(
      (hit) => hit.path === after.path && hit.chunkIndex === after.chunkIndex,
    );
    if (at < 0 || fused[at]!.score !== after.score)
      throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
    start = at + 1;
  }
  return { page: fused.slice(start, start + limit), hasMore: fused.length > start + limit };
}
type LeasedGeneration = {
  dimensions: number | null;
  commitSha: string;
  name: string;
  fingerprint: string | null;
  chunkCount: number;
  documentCount: number;
  state: "COMPLETE" | "SUPERSEDED";
  active: boolean;
};

/**
 * A KB whose active generation was built by an older built-in MODEL
 * IDENTITY cannot rank semantically (query vectors live in another space); its
 * search runs the lexical arm alone over that generation until it is rebuilt.
 */
export type ArmSource = LeasedQueryVector | LexicalGeneration;

/**
 * Extra idle-in-transaction allowance past the deadline: the reading transaction holds its
 * `FOR KEY SHARE` until the reader thread acknowledged an abort (one slice of overrun).
 */
export const READER_ACK_SLACK_MS = 5000;

const GENERATION_COLUMNS = `g.dimensions,g."commitSha",k.name,g.fingerprint,g."chunkCount",g."documentCount",g.state,
  (k."activeGenerationId" IS NOT DISTINCT FROM g.id) AS active`;

/** Opens the read transaction every index file read runs in (§1.5 CL-INTERLOCK). */
export async function beginIndexRead(q: LockQuery, deadlineAt: number): Promise<void> {
  await q("BEGIN ISOLATION LEVEL REPEATABLE READ");
  const remaining = Math.max(1, deadlineAt - Date.now());
  await q(`SET LOCAL statement_timeout = ${remaining}`);
  await q(`SET LOCAL idle_in_transaction_session_timeout = ${remaining + READER_ACK_SLACK_MS}`);
}

/**
 * §1.7: a missing file is classified only after the reading transaction committed. A COMMIT
 * failure (lost session) is INDEX_UNAVAILABLE without any integrity log or retry; a missing file
 * of a COMPLETE generation is an integrity failure (logged, retried once by the outermost
 * operation); a cursor-pinned retained generation is INVALID_CURSOR.
 */
export async function classifyMissingIndexFile(
  commit: () => Promise<unknown>,
  generation: { state: string; generationId: string; kbId: string },
  pinned: boolean,
): Promise<never> {
  try {
    await commit();
  } catch {
    throw unavailable();
  }
  if (generation.state === "COMPLETE") {
    logEvent("kb.index-missing", {
      kbId: generation.kbId,
      generationId: generation.generationId,
    });
    throw new IndexFileMissingError();
  }
  if (pinned) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  throw new IndexFileMissingError();
}

/** A settled non-ok pool outcome: the caller's stop signal or the deadline ended the read. */
export function stoppedRead(status: "aborted" | "deadline"): KbDomainError {
  return status === "deadline"
    ? new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded")
    : new KbDomainError("CANCELLED", "Cancelled");
}

/** Projects one leased-file citation row (reader thread output) for the reply. */
export function citationSource(
  kbId: string,
  generationId: string,
  row: IndexCitationRow,
): CitationSourceRow {
  return {
    kbId,
    generationId,
    path: row.path,
    chunkIndex: row.chunkIndex,
    documentId: row.documentId,
    commitSha: row.commitSha,
    blobSha: row.blobSha,
    contentHash: row.contentHash,
    startToken: row.span.startToken,
    endToken: row.span.endToken,
    startByte: row.span.startByte,
    endByte: row.span.endByte,
    snippet: row.snippet,
    documentCitations: row.documentCitations,
    assetRefs: row.assetRefs,
    matchedRow: row.matchedRow,
  };
}

/**
 * Both arms and the projection read one immutable file of the leased generation, never the
 * active pointer. The generation row is held `FOR KEY SHARE` from before the reader thread opens
 * the file until the read settled, so retention cannot purge it underneath (§1.5).
 */
async function readHybrid(
  client: Client,
  leased: ArmSource,
  input: { kbId: string; text: string; limit: number } & Filters,
  hooks: SearchOptions["hooks"],
  deadlineAt: number,
  signal: AbortSignal,
  reading: { active: boolean },
  structured?: HybridStructured,
): Promise<HybridRead> {
  // Recompute the remaining budget before every statement, including after hooks/arms.
  const q: LockQuery = async (text, values) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded");
    await client.query(`SET statement_timeout = ${remaining}`);
    return client.query(text, values);
  };
  const lexical = "lexical" in leased;
  await beginIndexRead(q, deadlineAt);
  const generation = (
    lexical
      ? await q<LeasedGeneration>(
          `SELECT ${GENERATION_COLUMNS} FROM index_generation g
          JOIN knowledge_base k ON k.id=g."kbId"
          WHERE g.id=$1 AND g."kbId"=$2 AND g.state IN ('COMPLETE','SUPERSEDED') FOR KEY SHARE OF g`,
          [leased.generationId, input.kbId],
        )
      : await q<LeasedGeneration>(
          `SELECT ${GENERATION_COLUMNS} FROM generation_lease l
      JOIN index_generation g ON g.id=l."generationId" JOIN knowledge_base k ON k.id=g."kbId"
      WHERE l."requestId"=$1 AND l."generationId"=$2 AND g."kbId"=$3 AND g.fingerprint=$4
        AND l."expiresAt">clock_timestamp() AND g.state IN ('COMPLETE','SUPERSEDED') FOR KEY SHARE OF g`,
          [leased.requestId, leased.generationId, input.kbId, leased.fingerprint],
        )
  ).rows[0];
  if (!generation)
    throw leased.pinned ? new KbDomainError("INVALID_CURSOR", "Invalid cursor") : unavailable();
  // A cursor-pinned retained generation is checked against the cursor revision by its caller.
  if (!leased.pinned && generation.commitSha !== leased.index.indexedCommitSha) throw unavailable();
  if (!lexical) await hooks?.beforeArm?.("vector");
  await hooks?.beforeArm?.("fts");
  let result: HybridTaskResult;
  reading.active = true;
  try {
    const outcome = await getIndexReader().read({
      task: {
        kind: "hybrid",
        input: {
          pathPrefix: input.pathPrefix,
          documentId: input.documentId,
          filters: structured?.raw ?? null,
          text: input.text,
          vector: lexical ? null : leased.vector,
        },
      },
      expected: {
        generationId: leased.generationId,
        kbId: input.kbId,
        commitSha: generation.commitSha,
        fingerprint: generation.fingerprint,
        dimensions: generation.dimensions,
        chunkCount: generation.chunkCount,
        documentCount: generation.documentCount,
      },
      active: generation.active,
      deadlineAt,
      signal,
    });
    reading.active = false;
    if (outcome.status !== "ok") throw stoppedRead(outcome.status);
    result = outcome.result;
  } catch (error) {
    reading.active = false;
    if (error instanceof IndexFileMissingError)
      await classifyMissingIndexFile(
        () => q("COMMIT"),
        { state: generation.state, generationId: leased.generationId, kbId: input.kbId },
        leased.pinned,
      );
    throw error;
  }
  await q("COMMIT");
  const { page: fused, hasMore } = pageAfterHybrid(
    fuseReciprocalRanks([result.vector, result.fts]),
    structured?.after ?? null,
    input.limit,
  );
  const byKey = new Map(result.rows.map((row) => [`${row.chunkIndex}\0${row.path}`, row]));
  const rowFiltered = structured?.filters.row != null;
  const hits = fused.map((hit) => {
    const row = byKey.get(`${hit.chunkIndex}\0${hit.path}`);
    if (!row) throw unavailable();
    return projectCitationHit(citationSource(input.kbId, leased.generationId, row), {
      knowledgeBaseName: generation.name,
      generationId: leased.generationId,
      commitSha: generation.commitSha,
      freshness: servedFreshness(leased.index, leased.generationId),
      score: normalizedRrfScore(hit.score, lexical ? 1 : 2),
      matchedRow: rowFiltered ? row.matchedRow : null,
      ...(lexical ? { mode: "lexical" as const } : {}),
    });
  });
  // Row predicates admitted the chunk inside both arms; its projection must still carry the row.
  if (rowFiltered && hits.some((hit) => hit.matchedRow === null)) throw unavailable();
  return { hits, hasMore, last: fused.at(-1) ?? null, commitSha: generation.commitSha };
}

export async function hybridArms(
  options: SearchOptions,
  leased: ArmSource,
  input: { kbId: string; text: string; limit: number } & Filters,
  signal: AbortSignal,
  structured?: HybridStructured,
  drainRead?: SearchReadDrain,
): Promise<HybridRead> {
  const applicationName = `kb-search-${randomUUID()}`;
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + QUERY_DEADLINE_MS);
  const client = new Client({
    connectionString: options.connectionString,
    application_name: applicationName,
    options: "-c client_connection_check_interval=100ms",
    connectionTimeoutMillis: Math.max(1, Math.min(5000, deadlineAt - Date.now())),
    statement_timeout: Math.max(1, deadlineAt - Date.now()),
  });
  client.on("error", () => {});
  /** Set while `connect()` is in flight so abort/teardown can end the client before assignment. */
  let connecting: Client | null = null;
  // While a file read is in flight the client (and its FOR KEY SHARE) stays open: the reader
  // thread is told to stop through the pool, and `finally` ends the client after it settled.
  const reading = { active: false };
  const stop = () => {
    if (connecting) void connecting.end().catch(() => {});
    if (!reading.active) void client.end().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    await options.hooks?.beforeRead?.();
    signal.throwIfAborted();
    connecting = client;
    try {
      await client.connect();
    } catch (error) {
      if (connecting === client) connecting = null;
      logInternalError("kb.search", error, { stage: "hybrid-connect" });
      throw unavailable();
    }
    const closedDuringConnect = connecting !== client;
    if (!closedDuringConnect) connecting = null;
    if (closedDuringConnect || signal.aborted) {
      await client.end().catch(() => {});
      throw unavailable();
    }
    await drainRead?.inherit((text, values) => client.query(text, values), "session");
    return await readHybrid(
      client,
      leased,
      input,
      options.hooks,
      deadlineAt,
      signal,
      reading,
      structured,
    );
  } catch (error) {
    if (error instanceof KbDomainError) throw error;
    // Either arm (or the projection) failing fails the whole search: no keyword-only fallback.
    logInternalError("kb.search", error, { stage: "hybrid-read" });
    throw unavailable();
  } finally {
    signal.removeEventListener("abort", stop);
    if (drainRead) await drainRead(client, applicationName);
    else await client.end().catch(() => {});
  }
}

/**
 * §1.7 retry-once: a missing index file is re-admitted exactly once from the outermost
 * operation (re-authorization, a fresh index status and a new lease). A second miss is
 * INDEX_UNAVAILABLE. The retry charges the query rate again (damage-only path).
 */
export async function retryOnceOnMissingFile<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof IndexFileMissingError)) throw error;
  }
  try {
    return await run();
  } catch (error) {
    if (error instanceof IndexFileMissingError) throw unavailable();
    throw error;
  }
}

/**
 * knowledge_search for every transport. Quotas, the generation lease, its release on every branch
 * and the final read authorization before the reply are owned by withQueryEmbedding.
 */
export async function searchKnowledgeBase(
  options: SearchOptions,
  actor: IndexActor,
  raw: SearchInput,
  signal?: AbortSignal,
): Promise<SearchResult> {
  options = {
    ...options,
    deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + QUERY_DEADLINE_MS),
  };
  const parsed = searchSchemas.input.safeParse(raw);
  if (!parsed.success) throw new KbDomainError("INVALID_ARGUMENT", "Invalid search");
  const input = parsed.data;
  const text = prepareEmbeddingQuery(input.query);
  const consume = async (leased: ArmSource, stop: AbortSignal, drainRead?: SearchReadDrain) => {
    const { hits: results, commitSha } = await hybridArms(
      options,
      leased,
      {
        kbId: input.kbId,
        text,
        limit: input.limit ?? SEARCH_DEFAULT_LIMIT,
        pathPrefix: input.pathPrefix ?? null,
        documentId: input.documentId ?? null,
      },
      stop,
      undefined,
      drainRead,
    );
    return searchSchemas.output.parse({
      results,
      generationId: leased.generationId,
      // Every field derives from the generation served (and the status read with it).
      freshness: servedFreshness(leased.index, leased.generationId),
      indexedCommitSha: commitSha,
      headSha: leased.index.headSha,
      indexNotices: indexNoticesFor(input.kbId, leased.index, leased),
    });
  };
  return retryOnceOnMissingFile(() =>
    withQueryEmbedding(
      options,
      actor,
      { kbId: input.kbId, query: input.query },
      consume,
      signal,
      consume,
    ),
  );
}
