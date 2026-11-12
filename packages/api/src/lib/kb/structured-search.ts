import { randomUUID } from "node:crypto";
import { logInternalError } from "@knowledge-base/env/log";
import { Client } from "pg";
import type { z } from "zod";
import { unavailableIndexStatus } from "./attachment";
import { runLockedOperation } from "./authority-lock";
import { projectCitationHit } from "./citation";
import { CURSOR_TTL_MS, type CursorSigner, cursorExpiry, stableFilterHash } from "./cursor";
import { fromAdmissionError, IndexFileMissingError, KbDomainError } from "./errors";
import type { IndexActor } from "./generations";
import { getIndexReader } from "./index-file/pool";
import type { IndexCitationRow } from "./index-file/reader";
import { loadIndexStatus, qwenRebuildReason, servedFreshness } from "./index-status";
import { chargeRate } from "./limits";
import type { LockQuery } from "./lock";
import { authorize, sqlAuthorityStore } from "./permissions";
import { actorKeyFor } from "./principal";
import { kbReadToolSchemas } from "./protocol/reads";
import {
  GENERATION_LEASE_MS,
  LexicalOnlySearchError,
  QUERY_DEADLINE_MS,
  type SearchReadDrain,
  withLexicalSearch,
  withQueryCapacity,
  withQueryEmbedding,
} from "./query-embedding";
import { prepareEmbeddingQuery } from "./redact-for-embed";
import type { FusedChunk } from "./rrf";
import {
  type ArmSource,
  beginIndexRead,
  citationSource,
  classifyMissingIndexFile,
  hybridArms,
  indexNoticesFor,
  pageAfterHybrid,
  retryOnceOnMissingFile,
  type SearchOptions,
  stoppedRead,
} from "./search";
import {
  isoSortKey,
  type NormalizedStructuredFilters,
  normalizeStructuredFilters,
  type StructuredFilters,
} from "./structured";

export { isoSortKey, pageAfterHybrid };

const schemas = kbReadToolSchemas.knowledge_structured_search;
export type StructuredSearchInput = z.input<typeof schemas.input>;
export type StructuredSearchResult = z.infer<typeof schemas.output>;
export type StructuredSearchOptions = SearchOptions & { cursorSigner: CursorSigner };

export const STRUCTURED_PAGE_DEFAULT = 20;
/** Exact filter matches carry one finite, constant score; order is path then row index. */
export const STRUCTURED_SCORE = 1;
/**
 * Minimum time a generation must stay readable after it stops being active. It exceeds every
 * cursor's validity (plus one lease), so a live cursor never observes a half-removed generation;
 * a removed generation is refused as INVALID_CURSOR, never silently repinned.
 */
export const STRUCTURED_GENERATION_RETENTION_MS = CURSOR_TTL_MS + GENERATION_LEASE_MS;

const GENERATION_ID = /^[a-z0-9]{24,32}$/;
const ROW_KEY = /^(-1|0|[1-9]\d{0,8}):(.+)$/s;
const CHUNK_INDEX = /^(0|[1-9]\d{0,8})$/;

function invalidCursor(): KbDomainError {
  return new KbDomainError("INVALID_CURSOR", "Invalid cursor");
}
function unavailable(): KbDomainError {
  return new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
}

export type RowKey = { path: string; rowIndex: number };
export function encodeRowKey(key: RowKey): string {
  return `${key.rowIndex}:${key.path}`;
}
export function decodeRowKey(value: string): RowKey {
  const match = ROW_KEY.exec(value);
  if (!match) throw invalidCursor();
  return { rowIndex: Number(match[1]), path: match[2]! };
}
/**
 * The ranking mode a ranked page was ordered by. Continuation keys carry it (`h:`/`l:`),
 * so later pages keep the first page's order: a keyword-ranked page stays keyword-ranked even
 * after the profile recovered (keyword ranking is allowed while read authority holds); a
 * hybrid-ranked page whose continuation can only rank by keyword is refused as INVALID_CURSOR
 * (the caller restarts the search). Same tags as the CLI.
 */
export type RankMode = "hybrid" | "lexical";
export function encodeRankedKey(mode: RankMode, key: FusedChunk): string {
  return `${mode === "lexical" ? "l" : "h"}:${encodeHybridKey(key)}`;
}
export function decodeRankedKey(value: string): { mode: RankMode; key: FusedChunk } {
  const tag = value.slice(0, 2);
  if (tag !== "h:" && tag !== "l:") throw invalidCursor();
  return { mode: tag === "l:" ? "lexical" : "hybrid", key: decodeHybridKey(value.slice(2)) };
}
export function encodeHybridKey(key: FusedChunk): string {
  return `${key.score}:${key.chunkIndex}:${key.path}`;
}
export function decodeHybridKey(value: string): FusedChunk {
  const first = value.indexOf(":");
  const second = first < 0 ? -1 : value.indexOf(":", first + 1);
  if (second < 0 || second === value.length - 1) throw invalidCursor();
  const scoreText = value.slice(0, first);
  const score = Number(scoreText);
  const chunkText = value.slice(first + 1, second);
  // Canonical number text only: the score must round-trip exactly to compare with the refusion.
  if (!Number.isFinite(score) || String(score) !== scoreText || !CHUNK_INDEX.test(chunkText))
    throw invalidCursor();
  return { score, chunkIndex: Number(chunkText), path: value.slice(second + 1) };
}

/** Schema-validated input plus request filters normalized exactly like indexed documents. */
export function normalizeStructuredQuery(raw: StructuredSearchInput) {
  const parsed = schemas.input.safeParse(raw);
  if (!parsed.success) throw new KbDomainError("INVALID_ARGUMENT", "Invalid structured search");
  const input = parsed.data;
  return {
    input,
    query: input.query ?? null,
    filters: normalizeStructuredFilters(input),
    raw: requestFilters(input),
  };
}

/** Only the filter fields of a request, as plain data for the index reader. */
function requestFilters(input: StructuredFilters): StructuredFilters {
  const filters: StructuredFilters = {};
  if (input.type !== undefined) filters.type = input.type;
  if (input.title !== undefined) filters.title = input.title;
  if (input.tags !== undefined) filters.tags = [...input.tags];
  if (input.timestamp !== undefined) filters.timestamp = { ...input.timestamp };
  if (input.structured !== undefined)
    filters.structured = input.structured.map(({ column, equals }) => ({ column, equals }));
  return filters;
}

type Mode = "structured" | "hybrid";
type Pin = { generationId: string; revision: string; lastKey: string };

/** HMAC binding: actor, KB, mode, query and every normalized filter. The pin and key are signed. */
function cursorBinding(
  actor: IndexActor,
  kbId: string,
  mode: Mode,
  query: string | null,
  filters: NormalizedStructuredFilters,
) {
  const row = filters.row ? Object.entries(filters.row).sort(([a], [b]) => (a < b ? -1 : 1)) : null;
  return {
    actorKey: actorKeyFor(actor.principal),
    kbId,
    filterHash: stableFilterHash({ v: 1, op: "structured_search", mode, query, ...filters, row }),
  };
}

/** The cursor binding for raw filters (tests and callers that must re-derive a signed pin). */
export function structuredCursorBinding(
  actor: IndexActor,
  kbId: string,
  mode: Mode,
  query: string | null,
  filters: StructuredFilters,
) {
  return cursorBinding(actor, kbId, mode, query, normalizeStructuredFilters(filters));
}

function readCursor(
  signer: CursorSigner,
  token: string,
  binding: ReturnType<typeof cursorBinding>,
): Pin {
  const payload = signer.verify(token, { ...binding, sortKey: "*", revision: "*" });
  if (!GENERATION_ID.test(payload.sortKey) || payload.revision === "*" || payload.lastKey === null)
    throw invalidCursor();
  return { generationId: payload.sortKey, revision: payload.revision, lastKey: payload.lastKey };
}

function signCursor(
  signer: CursorSigner,
  binding: ReturnType<typeof cursorBinding>,
  generationId: string,
  revision: string,
  lastKey: string,
) {
  return signer.sign({
    v: 1,
    ...binding,
    // The pinned generation is the sort space: keys are only meaningful inside it.
    sortKey: generationId,
    revision,
    lastKey,
    exp: cursorExpiry(),
  });
}

async function admitRead(q: LockQuery, actor: IndexActor, kbId: string) {
  const auth = await authorize({
    ...actor,
    kbId,
    operation: "read",
    store: sqlAuthorityStore(q),
    query: q,
  });
  if (auth.state !== "ACTIVE") throw unavailable();
}

/**
 * The explicit queryless operation. Each page takes its own read lease (a KEY SHARE row lock on
 * the pinned generation inside one REPEATABLE READ snapshot) before touching chunks, and live read
 * authority is checked before the read and again before the reply.
 */
async function queryless(
  options: StructuredSearchOptions,
  actor: IndexActor,
  input: {
    kbId: string;
    limit: number;
    filters: NormalizedStructuredFilters;
    raw: StructuredFilters;
  },
  binding: ReturnType<typeof cursorBinding>,
  pin: (Pin & { after: RowKey }) | null,
  signal?: AbortSignal,
  drainRead?: SearchReadDrain,
): Promise<StructuredSearchResult> {
  const applicationName = `kb-search-${randomUUID()}`;
  const deadlineAt = options.deadlineAt!;
  const client = new Client({
    connectionString: options.connectionString,
    application_name: applicationName,
    options: "-c client_connection_check_interval=100ms",
    connectionTimeoutMillis: Math.max(1, Math.min(5000, deadlineAt - Date.now())),
    statement_timeout: Math.max(1, deadlineAt - Date.now()),
  });
  client.on("error", () => {});
  // While a file read is in flight the client (and its FOR KEY SHARE) stays open; `finally`
  // ends it after the reader thread acknowledged (§1.5 CL-INTERLOCK).
  const reading = { active: false };
  const stop = () => {
    if (!reading.active) void client.end().catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  const q: LockQuery = async (text, values) => {
    signal?.throwIfAborted();
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded");
    await client.query(`SET statement_timeout = ${remaining}`);
    signal?.throwIfAborted();
    return client.query(text, values);
  };
  try {
    await options.hooks?.beforeRead?.();
    signal?.throwIfAborted();
    try {
      await client.connect();
    } catch {
      throw unavailable();
    }
    await drainRead?.inherit(q, "session");
    await admitRead(q, actor, input.kbId);
    await chargeRate(options.ratePort, {
      kind: "query",
      key: `${actor.principal.userId}:${input.kbId}`,
    });
    await beginIndexRead(q, deadlineAt);
    const { index } = await loadIndexStatus(q, input.kbId);
    let generationId: string;
    if (pin) generationId = pin.generationId;
    else if (
      index.activeGenerationId &&
      index.activeState === "COMPLETE" &&
      index.freshness !== "unavailable"
    )
      generationId = index.activeGenerationId;
    else throw unavailable();
    const lease = (
      await q<{
        commitSha: string;
        name: string;
        providerId: string | null;
        providerVersion: number | null;
        fingerprint: string | null;
        dimensions: number | null;
        chunkCount: number;
        documentCount: number;
        state: "COMPLETE" | "SUPERSEDED";
      }>(
        `SELECT g."commitSha",k.name,g."providerId",g."providerVersion",g.fingerprint,g.dimensions,
          g."chunkCount",g."documentCount",g.state
        FROM index_generation g JOIN knowledge_base k ON k.id=g."kbId"
        WHERE g.id=$1 AND g."kbId"=$2 AND g.state IN ('COMPLETE','SUPERSEDED') FOR KEY SHARE OF g`,
        [generationId, input.kbId],
      )
    ).rows[0];
    if (!lease) throw pin ? invalidCursor() : unavailable();
    if (pin && lease.commitSha !== pin.revision) throw invalidCursor();
    let rows: IndexCitationRow[];
    reading.active = true;
    try {
      const outcome = await getIndexReader().read({
        task: {
          kind: "queryless",
          input: {
            pathPrefix: null,
            documentId: null,
            filters: input.raw,
            after: pin ? { path: pin.after.path, rowIndex: pin.after.rowIndex } : null,
            limit: input.limit + 1,
          },
        },
        expected: {
          generationId,
          kbId: input.kbId,
          commitSha: lease.commitSha,
          fingerprint: lease.fingerprint,
          dimensions: lease.dimensions,
          chunkCount: lease.chunkCount,
          documentCount: lease.documentCount,
        },
        active: generationId === index.activeGenerationId,
        deadlineAt,
        signal,
      });
      reading.active = false;
      if (outcome.status !== "ok") throw stoppedRead(outcome.status);
      rows = outcome.result as IndexCitationRow[];
    } catch (error) {
      reading.active = false;
      if (error instanceof IndexFileMissingError)
        await classifyMissingIndexFile(
          () => client.query("COMMIT"),
          { state: lease.state, generationId, kbId: input.kbId },
          pin !== null,
        );
      throw error;
    }
    await client.query("COMMIT");
    await options.hooks?.afterRead?.();
    signal?.throwIfAborted();
    // Revocation is independent of the cursor: the reply needs live read authority.
    const page = rows.slice(0, input.limit);
    const freshness = servedFreshness(index, generationId);
    const items = page.map((row) =>
      projectCitationHit(citationSource(input.kbId, generationId, row), {
        knowledgeBaseName: lease.name,
        generationId,
        commitSha: lease.commitSha,
        freshness,
        score: STRUCTURED_SCORE,
        mode: "structured",
        matchedRow: row.rowIndex < 0 ? null : row.matchedRow,
      }),
    );
    const last = page.at(-1);
    const result = schemas.output.parse({
      items,
      nextCursor:
        rows.length > input.limit && last
          ? signCursor(
              options.cursorSigner,
              binding,
              generationId,
              lease.commitSha,
              encodeRowKey({ path: last.path, rowIndex: last.rowIndex }),
            )
          : null,
      generationId,
      freshness,
      indexedCommitSha: lease.commitSha,
      headSha: index.headSha,
      // Exact filters rank no vectors: a lexical-only generation needs no notice here.
      indexNotices: indexNoticesFor(input.kbId, {
        rebuildPending:
          lease.providerId === null || lease.providerVersion === null
            ? null
            : ((await qwenRebuildReason(q, lease.providerId, lease.providerVersion)) ??
              index.rebuildPending),
      }),
    });
    // Recency is shared with hybrid/lexical admission and serialized with config
    // retargeting. Failed SQL reads and revoked continuations never change priority.
    await runLockedOperation({
      connectionString: options.connectionString,
      opId: randomUUID(),
      kind: "authority",
      signal,
      mutationDeadlineAt: deadlineAt,
      run: (lease) =>
        lease.transaction(async (query) => {
          await admitRead(query, actor, input.kbId);
          await query(
            `UPDATE knowledge_base SET "lastQueriedAt"=statement_timestamp() WHERE id=$1`,
            [input.kbId],
          );
        }),
    });
    return result;
  } catch (error) {
    if (error instanceof KbDomainError) throw error;
    const admission = fromAdmissionError(error);
    if (admission) throw admission;
    if (signal?.aborted) throw new KbDomainError("CANCELLED", "Cancelled");
    logInternalError("kb.search", error, { stage: "structured-read" });
    throw unavailable();
  } finally {
    signal?.removeEventListener("abort", stop);
    if (drainRead) await drainRead(client, applicationName);
    else await client.end().catch(() => {});
  }
}

/**
 * knowledge_structured_search. With a query: hybrid search whose exact filters apply inside both
 * candidate arms before RRF (a failed embed is INDEX_UNAVAILABLE, never a queryless fallback).
 * Without one: the explicit queryless structured operation. Both page under a signed cursor that
 * pins actor, KB, filters, generation and its commit.
 */
export async function structuredSearchKnowledgeBase(
  options: StructuredSearchOptions,
  actor: IndexActor,
  raw: StructuredSearchInput,
  signal?: AbortSignal,
): Promise<StructuredSearchResult> {
  options = {
    ...options,
    deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + QUERY_DEADLINE_MS),
  };
  const { input, query, filters, raw: rawFilters } = normalizeStructuredQuery(raw);
  const mode: Mode = query === null ? "structured" : "hybrid";
  const text = query === null ? null : prepareEmbeddingQuery(query);
  const limit = input.limit ?? STRUCTURED_PAGE_DEFAULT;
  const binding = cursorBinding(actor, input.kbId, mode, query, filters);
  const pin = input.cursor ? readCursor(options.cursorSigner, input.cursor, binding) : null;
  if (query === null || text === null) {
    return retryOnceOnMissingFile(() =>
      withQueryCapacity(
        options,
        actor,
        (stop, drainRead) =>
          queryless(
            options,
            actor,
            { kbId: input.kbId, limit, filters, raw: rawFilters },
            binding,
            pin && { ...pin, after: decodeRowKey(pin.lastKey) },
            stop,
            drainRead,
          ),
        signal,
      ),
    );
  }
  const ranked = pin && decodeRankedKey(pin.lastKey);
  const after = ranked?.key ?? null;
  const consume = async (leased: ArmSource, stop: AbortSignal, drainRead?: SearchReadDrain) => {
    const servedMode: RankMode = "lexical" in leased ? "lexical" : "hybrid";
    if (ranked && ranked.mode !== servedMode) throw invalidCursor();
    const read = await hybridArms(
      options,
      leased,
      { kbId: input.kbId, text, limit, pathPrefix: null, documentId: null },
      stop,
      { filters, raw: rawFilters, after },
      drainRead,
    );
    if (pin && read.commitSha !== pin.revision) throw invalidCursor();
    const freshness = servedFreshness(leased.index, leased.generationId);
    return schemas.output.parse({
      items: read.hits.map((hit) => ({ ...hit, freshness })),
      nextCursor:
        read.hasMore && read.last
          ? signCursor(
              options.cursorSigner,
              binding,
              leased.generationId,
              read.commitSha,
              encodeRankedKey(servedMode, read.last),
            )
          : null,
      generationId: leased.generationId,
      freshness,
      indexedCommitSha: read.commitSha,
      headSha: leased.index.headSha,
      indexNotices: indexNoticesFor(input.kbId, leased.index, leased),
    });
  };
  const embedInput = {
    kbId: input.kbId,
    query,
    ...(pin ? { generationId: pin.generationId } : {}),
  };
  // A keyword-pinned continuation never embeds: it reads the pinned generation's FTS5 arm.
  if (ranked?.mode === "lexical" && pin)
    return retryOnceOnMissingFile(() =>
      withLexicalSearch(
        options,
        actor,
        { kbId: input.kbId },
        new LexicalOnlySearchError(
          pin.generationId,
          unavailableIndexStatus(null),
          true,
          options.deadlineAt ?? Date.now() + QUERY_DEADLINE_MS,
          false,
          "CURSOR_PINNED",
        ),
        consume,
        signal,
      ),
    );
  return retryOnceOnMissingFile(() =>
    withQueryEmbedding(options, actor, embedInput, consume, signal, consume),
  );
}
