import { logInternalError } from "@knowledge-base/env/log";
import type { z } from "zod";
import { prismaAssetQuery } from "./asset-authz";
import type { IndexStatus } from "./attachment";
import { listKnowledgeBases, mapKbDomainError } from "./bases";
import { authorizeDocumentRead } from "./documents-read";
import { KbDomainError } from "./errors";
import type { IndexActor } from "./generations";
import { loadIndexStatus } from "./index-status";
import type { LockQuery } from "./lock";
import { authorize, prismaAuthorityStore } from "./permissions";
import {
  KB_PAGE_MAX,
  SEARCH_ALL_DEFAULT_BASES,
  SEARCH_ALL_DEFAULT_PER_BASE,
  SEARCH_ALL_MAX_BASES,
  SEARCH_ALL_MAX_RESULTS,
} from "./protocol/common";
import { tooManyBasesMessage } from "./protocol/envelope";
import { kbReadToolSchemas, type SEARCH_ALL_BASE_STATUSES } from "./protocol/reads";
import { QUERY_DEADLINE_MS } from "./query-embedding";
import { prepareEmbeddingQuery, SensitiveQueryError } from "./redact-for-embed";
import type { KbRuntimeConfig } from "./runtime";
import { type SearchResult, searchKnowledgeBaseServed } from "./search";

const schemas = kbReadToolSchemas.knowledge_search_all;
type SearchAllInput = z.input<typeof schemas.input>;
type SearchAllResult = z.infer<typeof schemas.output>;
type BaseRow = SearchAllResult["knowledgeBases"][number];
type BaseStatus = (typeof SEARCH_ALL_BASE_STATUSES)[number];
type Hit = SearchResult["results"][number];

/** Bases searched at once by one call: each holds one of the user's query slots. */
export const SEARCH_ALL_LANES = 2;
/** Final per-base authorization checks in flight at once (short authority reads). */
export const SEARCH_ALL_FINAL_CHECKS = 4;

/** The instance-admin "all I can read" limit (AppSetting key; integer 1..64). */
const SEARCH_ALL_LIMIT_SETTING_KEY = "kb.searchAll.limit";

/** A stored limit is a decimal integer 1..64; anything else (or no row) is the default. */
export function searchAllLimitFrom(stored: string | null | undefined): number {
  if (typeof stored !== "string" || !/^[1-9]\d?$/.test(stored)) return SEARCH_ALL_DEFAULT_BASES;
  const limit = Number(stored);
  return limit <= SEARCH_ALL_MAX_BASES ? limit : SEARCH_ALL_DEFAULT_BASES;
}

export async function readSearchAllLimit(query: LockQuery): Promise<number> {
  // Bounded by the one compile-time setting key.
  const { rows } = await query<{ value: string }>(`SELECT value FROM app_setting WHERE key = $1`, [
    SEARCH_ALL_LIMIT_SETTING_KEY,
  ]);
  return searchAllLimitFrom(rows[0]?.value);
}

/** Instance-admin write, in the caller's live-admin authority transaction. */
export async function writeSearchAllLimit(query: LockQuery, limit: number): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_ALL_MAX_BASES)
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid search-all limit");
  await query(
    `INSERT INTO app_setting (key, value, "createdAt", "updatedAt") VALUES ($1, $2, now(), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
    [SEARCH_ALL_LIMIT_SETTING_KEY, String(limit)],
  );
  return readSearchAllLimit(query);
}

/** `min(requested ?? 4, max(1, floor(100 / n)))`: the merged list never needs truncating. */
export function effectiveLimitPerBase(requested: number | undefined, bases: number): number {
  const fit = bases > 0 ? Math.max(1, Math.floor(SEARCH_ALL_MAX_RESULTS / bases)) : Infinity;
  return Math.min(requested ?? SEARCH_ALL_DEFAULT_PER_BASE, fit);
}

type SearchAllOptions = KbRuntimeConfig & {
  masterKey: string | undefined;
  /** A caller's absolute deadline; the call's own is at most 60 s from now. */
  deadlineAt?: number;
};
/** The connection's admission: per-base checks use its principal, the final check rechecks it. */
type SearchAllActor = IndexActor & { recheck(): Promise<unknown> };

function readInput(options: SearchAllOptions, actor: SearchAllActor, kbId: string) {
  return {
    principal: actor.principal,
    verifier: actor.verifier,
    kbId,
    operation: "read" as const,
    store: prismaAuthorityStore(options.prisma),
    query: prismaAssetQuery(options.prisma),
  };
}

/** Every row that was not searched (or lost access) carries no index facts. */
function bareRow(kbId: string, status: BaseStatus, retryAfterSeconds: number | null = null) {
  return {
    kbId,
    status,
    hitCount: 0,
    generationId: null,
    freshness: null,
    indexedCommitSha: null,
    headSha: null,
    indexNotices: [],
    retryAfterSeconds,
  } satisfies BaseRow;
}

/** No servable generation while a first or next build is pending or running. */
function isRebuilding(index: IndexStatus): boolean {
  const servable =
    index.activeGenerationId !== null &&
    index.activeState === "COMPLETE" &&
    index.freshness !== "unavailable";
  return (
    !servable &&
    (index.desiredState === "PENDING" ||
      index.desiredState === "BUILDING" ||
      index.desiredState === "INDEXING")
  );
}

/**
 * The "rebuilding" diagnostic: one index-status read bounded by what is left of the shared
 * deadline (connection wait plus transaction time fit in it; the statement timeout is what is
 * left when it starts), skipped once it passed or the call was cancelled. A cancel during the
 * read does not interrupt it; the deadline bounds it. The caller already re-authorized the base, and the final check authorizes it again
 * before the row is shown.
 */
async function rebuildingWithin(
  options: SearchAllOptions,
  kbId: string,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<boolean> {
  const remaining = deadlineAt - Date.now();
  if (remaining < 2 || signal.aborted) return false;
  // Waiting for a connection and running the transaction together fit in what is left.
  const maxWait = Math.ceil(remaining / 2);
  try {
    const { index } = await options.prisma.$transaction(
      async (tx) => {
        const left = deadlineAt - Date.now();
        if (left <= 0) throw new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded");
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${left}`);
        return loadIndexStatus(prismaAssetQuery(tx), kbId);
      },
      { maxWait, timeout: remaining - maxWait },
    );
    return !signal.aborted && isRebuilding(index);
  } catch {
    return false;
  }
}

/** "All I can read": the knowledge_bases_list listing, at most `limit` bases or refused. */
async function listReadableBases(
  options: SearchAllOptions,
  actor: SearchAllActor,
  limit: number,
  signal: AbortSignal,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  // Bounded: stops at limit + 1 listed bases (each page at most KB_PAGE_MAX).
  do {
    signal.throwIfAborted();
    const page: Awaited<ReturnType<typeof listKnowledgeBases>> = await listKnowledgeBases(
      options,
      actor.principal,
      { limit: Math.min(KB_PAGE_MAX, limit + 1 - ids.length), cursor },
      actor.verifier,
    );
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null && ids.length <= limit);
  if (ids.length > limit)
    throw new KbDomainError("INVALID_ARGUMENT", tooManyBasesMessage(limit), undefined, {
      reason: "TOO_MANY_BASES",
      max: limit,
    });
  return [...new Set(ids)];
}

type Outcome =
  | { kind: "searched"; result: SearchResult; lexical: boolean }
  | { kind: "status"; row: BaseRow }
  | { kind: "fatal"; error: unknown };

/** Fails the whole call: the query or the input itself is refused, whatever the base. */
function isWholeCallFailure(error: unknown): boolean {
  if (error instanceof SensitiveQueryError) return true;
  const mapped = mapKbDomainError(error);
  return mapped?.code === "INVALID_ARGUMENT";
}

/** The status a failed single-base search maps to, before the existence check. */
function failureStatus(error: unknown): {
  status: BaseStatus;
  retryAfterSeconds?: number | null;
  index?: true;
} {
  if (error instanceof DOMException && error.name === "TimeoutError") return { status: "deadline" };
  const mapped = mapKbDomainError(error);
  switch (mapped?.code) {
    case "NOT_FOUND":
    case "FORBIDDEN":
    case "UNRESOLVED_REFERENCE":
      return { status: "not_found" };
    case "RATE_LIMITED": {
      const retry = mapped.retryAfterSeconds;
      return {
        status: "rate_limited",
        retryAfterSeconds:
          typeof retry === "number" && Number.isFinite(retry)
            ? Math.max(1, Math.ceil(retry))
            : null,
      };
    }
    case "DEADLINE_EXCEEDED":
      return { status: "deadline" };
    case "INDEX_UNAVAILABLE":
      return { status: "unavailable", index: true };
    default:
      return { status: "unavailable" };
  }
}

/** Codes that mean the server failed, not the caller: the operator sees the cause (never the query). */
function logFailure(error: unknown, kbId: string) {
  const code = mapKbDomainError(error)?.code ?? "INTERNAL";
  if (code === "INTERNAL" || code === "STORAGE_UNAVAILABLE")
    // The fields a failed knowledge_search logs through dispatchTool; never the query.
    logInternalError("mcp.tool", error, { tool: "knowledge_search_all", kbId, code });
}

/**
 * knowledge_search_all: the bases named (or every base this credential lists, up to the
 * instance limit), each searched by searchKnowledgeBase unchanged, two at a time, under one
 * shared deadline. A base's failure is its row's status; its existence is told only to a caller
 * who can still read it. Hits interleave by per-base rank, never by score.
 */
export async function searchKnowledgeBases(
  options: SearchAllOptions,
  actor: SearchAllActor,
  raw: SearchAllInput,
  ctx: {
    signal: AbortSignal;
    /** Deterministic test barrier: runs as a lane starts a base. */
    beforeBase?: (kbId: string) => Promise<void>;
  },
): Promise<SearchAllResult> {
  const { signal } = ctx;
  const parsed = schemas.input.safeParse(raw);
  if (!parsed.success) throw new KbDomainError("INVALID_ARGUMENT", "Invalid search");
  const input = parsed.data;
  // The whole call fails on a sensitive query, before any base is touched.
  prepareEmbeddingQuery(input.query);
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + QUERY_DEADLINE_MS);
  signal.throwIfAborted();

  const kbIds = input.kbIds
    ? [...new Set(input.kbIds)]
    : await listReadableBases(
        options,
        actor,
        await readSearchAllLimit(prismaAssetQuery(options.prisma)),
        signal,
      );
  const limitPerBase = effectiveLimitPerBase(input.limitPerBase, kbIds.length);
  const outcomes: Array<Outcome | undefined> = new Array(kbIds.length);
  let stop = false;

  /** dispatchTool's error-path re-authorization, per base: any failure reads as not_found. */
  const stillReadable = async (kbId: string) => {
    try {
      signal.throwIfAborted();
      await actor.recheck();
      await authorize(readInput(options, actor, kbId));
      signal.throwIfAborted();
      return true;
    } catch {
      return false;
    }
  };

  const runBase = async (kbId: string): Promise<Outcome> => {
    try {
      await ctx.beforeBase?.(kbId);
      const { result, lexical } = await searchKnowledgeBaseServed(
        { ...options, deadlineAt },
        actor,
        { kbId, query: input.query, limit: limitPerBase },
        signal,
      );
      return { kind: "searched", result, lexical };
    } catch (error) {
      if (signal.aborted) return { kind: "status", row: bareRow(kbId, "unavailable") };
      if (isWholeCallFailure(error)) return { kind: "fatal", error };
      const failed = failureStatus(error);
      if (failed.status === "not_found") return { kind: "status", row: bareRow(kbId, "not_found") };
      if (!(await stillReadable(kbId))) return { kind: "status", row: bareRow(kbId, "not_found") };
      // As dispatchTool: a server-side failure is logged only once the base is still readable.
      logFailure(error, kbId);
      let status = failed.status;
      // A pending/running build with nothing to serve is "rebuilding"; anything else,
      // including this read failing or running out of the shared deadline, stays unavailable.
      if (failed.index && (await rebuildingWithin(options, kbId, deadlineAt, signal)))
        status = "rebuilding";
      return {
        kind: "status",
        row: bareRow(
          kbId,
          status,
          status === "rate_limited" ? (failed.retryAfterSeconds ?? null) : null,
        ),
      };
    }
  };

  let next = 0;
  const lane = async () => {
    for (;;) {
      if (stop || signal.aborted) return;
      const index = next++;
      if (index >= kbIds.length) return;
      const kbId = kbIds[index]!;
      // A base not started before the shared deadline does not run.
      if (Date.now() >= deadlineAt) {
        outcomes[index] = { kind: "status", row: bareRow(kbId, "deadline") };
        continue;
      }
      const outcome = await runBase(kbId);
      outcomes[index] = outcome;
      if (outcome.kind === "fatal") stop = true;
    }
  };
  // Every lane settles before the call returns, whatever happened: slots, leases and reads are
  // released by each single-base search's own `finally`.
  await Promise.allSettled(Array.from({ length: SEARCH_ALL_LANES }, lane));
  if (signal.aborted) throw new KbDomainError("CANCELLED", "Cancelled");
  const fatal = outcomes.find((outcome) => outcome?.kind === "fatal");
  if (fatal?.kind === "fatal") throw fatal.error;

  // Final check before the reply: the connection, then every base still shown as more than
  // not_found. Searched bases pass content read admission (as dispatchTool's success path).
  signal.throwIfAborted();
  await actor.recheck();
  // The final checks run SEARCH_ALL_FINAL_CHECKS at a time, so 64 bases cost a few round trips.
  const settled: Array<{ row: BaseRow; hits: Hit[] } | undefined> = new Array(kbIds.length);
  let nextCheck = 0;
  const finalLane = async () => {
    for (;;) {
      const index = nextCheck++;
      if (index >= kbIds.length) return;
      settled[index] = await finalRow(kbIds[index]!, outcomes[index]);
    }
  };
  const finalRow = async (
    kbId: string,
    found: Outcome | undefined,
  ): Promise<{ row: BaseRow; hits: Hit[] }> => {
    const outcome = found ?? { kind: "status" as const, row: bareRow(kbId, "deadline") };
    if (outcome.kind === "fatal") throw outcome.error;
    if (outcome.kind === "status" && outcome.row.status === "not_found")
      return { row: outcome.row, hits: [] };
    let readable = true;
    try {
      signal.throwIfAborted();
      if (outcome.kind === "searched") await authorizeDocumentRead(readInput(options, actor, kbId));
      else await authorize(readInput(options, actor, kbId));
    } catch {
      readable = false;
    }
    if (!readable || signal.aborted) return { row: bareRow(kbId, "not_found"), hits: [] };
    if (outcome.kind === "status") return { row: outcome.row, hits: [] };
    const { result, lexical } = outcome;
    return {
      row: {
        kbId,
        status: lexical ? "lexical_only" : "ok",
        hitCount: result.results.length,
        generationId: result.generationId,
        freshness: result.freshness,
        indexedCommitSha: result.indexedCommitSha,
        headSha: result.headSha,
        indexNotices: result.indexNotices,
        retryAfterSeconds: null,
      },
      hits: result.results,
    };
  };
  // Every check settles before anything is answered or thrown.
  const checks = await Promise.allSettled(
    Array.from({ length: Math.min(SEARCH_ALL_FINAL_CHECKS, kbIds.length) }, finalLane),
  );
  const failedCheck = checks.find((check) => check.status === "rejected");
  if (failedCheck?.status === "rejected") throw failedCheck.reason;
  if (signal.aborted) throw new KbDomainError("CANCELLED", "Cancelled");
  const rows: BaseRow[] = settled.map((entry) => entry!.row);
  const hits: Hit[][] = settled.map((entry) => entry!.hits);

  // Rank 1 of every base in row order, then rank 2, ...; scores are never compared across bases.
  const results: SearchAllResult["results"] = [];
  for (let rank = 0; rank < limitPerBase; rank++)
    for (const list of hits) {
      const hit = list[rank];
      if (hit) results.push({ ...hit, rank: rank + 1 });
    }
  return schemas.output.parse({
    results,
    order: "rank_interleaved",
    limitPerBase,
    knowledgeBases: rows,
  });
}
