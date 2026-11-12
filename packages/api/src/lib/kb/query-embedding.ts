import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { Client } from "pg";
import { z } from "zod";
import { createGrantCredentialVerifier } from "../mcp-token-access";
import { type IndexStatus, isLexicalOnlyReason } from "./attachment";
import { runLockedOperation } from "./authority-lock";
import {
  type BreakerTicket,
  QUERY_EMBEDDING_DEADLINE_MS,
  queryEmbedBreaker,
} from "./embed-breaker";
import { EmbeddingUnavailableError, validateEmbeddings } from "./embed-client";
import {
  decryptKbSecretWithEnvKey,
  encryptKbSecretWithEnvKey,
  type KbEncryptedRecord,
} from "./envelope";
import { fromAdmissionError, KbDomainError } from "./errors";
import { type IndexActor, type IndexAttempt } from "./generations";
import {
  fallbackNoticeFor,
  lexicalNoticeFor,
  loadIndexStatus,
  queryAvailability,
  qwenRebuildReason,
} from "./index-status";
import { DurableJobFenceError, enqueueDurableJobOnQuery } from "./jobs";
import { chargeRate, KB_LIMITS, type RatePort } from "./limits";
import type { LockQuery } from "./lock";
import { authorize, sqlAuthorityStore } from "./permissions";
import {
  actorKeyFor,
  type CredentialVerifier,
  demandToolGroups,
  type Principal,
} from "./principal";
import { type IndexNotice, unicodeBoundedString } from "./protocol/common";
import { prepareEmbeddingQuery, SensitiveQueryError } from "./redact-for-embed";

export const QUERY_DEADLINE_MS = 60_000;
export const GENERATION_LEASE_MS = 90_000;
export const QUERY_SCRUB_MS = 300_000;
type Failure = "CANCELLED" | "DEADLINE_EXCEEDED" | "INDEX_UNAVAILABLE";
/** Request closure reasons: a failure, or the one degradable closure. */
type Closure = Failure | "EMBEDDING_UNAVAILABLE";
export type QueryEmbeddingOptions = {
  connectionString: string;
  masterKey: string | undefined;
  verifier?: CredentialVerifier;
  /** Bounds API database waits as well as its polling/consumer wait. */
  deadlineAt?: number;
  /** Internal capacity inheritance; never supplied by protocol input. */
  searchReadDrain?: SearchReadDrain;
};
type Snapshot = {
  kbOwnerId: string | null;
  providerId: string;
  revision: number;
  /** Selects the worker adapter: SYSTEM_BUILTIN runs in the forked child, never the server. */
  kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN";
  /** Null only for the system SYSTEM_BUILTIN provider. */
  ownerId: string | null;
  fingerprint: string;
  dimensions: number;
  index: IndexStatus;
  /** Set only when a signed page cursor pins a retained (possibly superseded) generation. */
  pinnedGenerationId?: string;
};
type RequestRow = {
  id: string;
  kbId: string;
  generationId: string;
  userId: string;
  actorKey: string;
  principal: unknown;
  snapshot: Snapshot;
  state: string;
  deadline: Date;
  queryCiphertext: string | null;
  resultCiphertext: string | null;
  live: boolean;
  leased: boolean;
  generationState: string;
  fingerprint: string;
  dimensions: number;
  providerId: string;
  providerVersion: number;
  jobState: string;
  workerOwner: string | null;
  attemptEpoch: number;
  jobLive: boolean;
};
const principalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser"), userId: z.string().min(1) }),
  z
    .object({
      kind: z.literal("token"),
      userId: z.string().min(1),
      grantId: z.string(),
      grantGeneration: z.string(),
      scopes: z.array(z.string()),
      expiresAt: z
        .union([z.iso.datetime({ offset: true }).pipe(z.coerce.date()), z.date()])
        .nullable(),
      credential: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("PAT"),
          clientId: z.string().min(1),
          resource: z.url(),
          tokenId: z.string().min(1),
        }),
        z.object({ kind: z.literal("OAUTH"), clientId: z.string().min(1), resource: z.url() }),
      ]),
      storedAcl: z.array(z.tuple([z.string(), z.array(z.string())])),
      // Required: a persisted token principal without its tool-group demands
      // fails closed instead of being restored with fewer requirements.
      toolGroupDemands: z
        .array(z.array(z.enum(MCP_TOOL_GROUPS)).min(1).max(MCP_TOOL_GROUPS.length))
        .max(16),
    })
    .refine((p) => p.credential.kind !== "OAUTH" || p.expiresAt !== null),
]);
/**
 * The durable principal, with every persisted tool-group demand. A query
 * embedding is search work, so a token additionally demands `read` at
 * dispatch and at completion whatever the persisted record says.
 */
function restorePrincipal(value: unknown): Principal {
  const p = principalSchema.parse(value);
  return p.kind === "browser"
    ? p
    : demandToolGroups({ ...p, storedAcl: new Map(p.storedAcl) }, ["read"]);
}
function failure(code: Failure) {
  return new KbDomainError(code, "Query embedding unavailable");
}

/**
 * The generation to search was built by an older built-in MODEL IDENTITY,
 * so no query vector is compatible with it; or no built-in child can
 * serve query vectors during a stop-then-probe gap. Callers that provide a
 * lexical consumer continue under the same capacity owner; every other caller sees
 * INDEX_UNAVAILABLE. `charged` is true when the failed semantic attempt already
 * charged this search's query budget, so the lexical arm does not charge twice.
 * The continuation retains the admission's absolute deadline, including cleanup
 * time spent before this error reaches the caller.
 */
export class LexicalOnlySearchError extends KbDomainError {
  constructor(
    readonly generationId: string,
    readonly index: IndexStatus,
    readonly pinned: boolean,
    readonly deadlineAt: number,
    readonly charged = false,
    /**
     * A hybrid generation searched over its FTS5 arm because its profile cannot embed
     * queries now (`PROFILE_UNUSABLE`: built-in disabled or removed, provider revoked or its
     * owner gone) or because this query's embedding could not be produced (`EMBEDDING_FAILED`).
     */
    readonly fallback: LexicalFallback | null = null,
  ) {
    super("INDEX_UNAVAILABLE", "Index unavailable");
  }
}
export type LexicalFallback = "PROFILE_UNUSABLE" | "EMBEDDING_FAILED" | "CURSOR_PINNED";

/**
 * Failure classification: the request's embedding profile can no longer serve query vectors
 * (revoked, disabled, retargeted). This — and only this — may degrade a search to the keyword
 * arm; authorization, lease, generation and SQL failures still fail it.
 */
export class ProfileLostError extends KbDomainError {
  constructor() {
    super("INDEX_UNAVAILABLE", "Embedding profile unavailable");
    this.name = "ProfileLostError";
  }
}

/**
 * Closed classification: the only failures a search degrades to its keyword arm. Anything
 * else — lease, request, generation, authorization, fence or SQL failures — always propagates.
 */
export type DegradableKind = "PROFILE_LOST" | "EMBEDDING_FAILED" | "EMBEDDING_TIMEOUT";
export class EmbeddingFailedError extends KbDomainError {
  constructor() {
    super("INDEX_UNAVAILABLE", "Query embedding failed");
    this.name = "EmbeddingFailedError";
  }
}
export function degradableKind(error: unknown): DegradableKind | null {
  if (error instanceof ProfileLostError) return "PROFILE_LOST";
  if (error instanceof EmbeddingFailedError) return "EMBEDDING_FAILED";
  if (error instanceof EmbeddingPhaseExpired) return "EMBEDDING_TIMEOUT";
  return null;
}

/**
 * The query embedding's share of the search budget. It leaves at most 10 s (and at most a
 * quarter of what is left) for the lexical fallback when the embedding fails or never arrives.
 */
export const LEXICAL_FALLBACK_RESERVE_MS = 10_000;
function embeddingDeadline(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  return deadlineAt - Math.min(LEXICAL_FALLBACK_RESERVE_MS, Math.max(0, remaining) / 4);
}
/** The query embedding did not arrive within its share of the budget. */
export class EmbeddingPhaseExpired extends Error {
  constructor() {
    super("Query embedding share of the budget spent");
    this.name = "EmbeddingPhaseExpired";
  }
}
function transaction<T>(
  options: QueryEmbeddingOptions,
  run: (q: LockQuery) => Promise<T>,
  signal?: AbortSignal,
) {
  return runLockedOperation({
    connectionString: options.connectionString,
    opId: randomUUID(),
    kind: "authority",
    mutationDeadlineAt: options.deadlineAt,
    signal,
    run: (lease) =>
      lease.transaction(async (q) => {
        await options.searchReadDrain?.inherit(q, "transaction");
        return run(q);
      }),
  });
}
function identity(row: Pick<RequestRow, "id" | "userId">, part: "query" | "result") {
  return {
    aadVersion: 1,
    purpose: "query-text" as const,
    userId: row.userId,
    objectId: row.id,
    revision: part,
  };
}
function encrypt(
  options: QueryEmbeddingOptions,
  row: Pick<RequestRow, "id" | "userId">,
  part: "query" | "result",
  data: unknown,
) {
  return JSON.stringify(
    encryptKbSecretWithEnvKey(JSON.stringify(data), identity(row, part), options.masterKey),
  );
}
function decrypt(
  options: QueryEmbeddingOptions,
  row: RequestRow,
  part: "query" | "result",
): unknown {
  const text = part === "query" ? row.queryCiphertext : row.resultCiphertext;
  if (!text) throw failure("INDEX_UNAVAILABLE");
  return JSON.parse(
    decryptKbSecretWithEnvKey(
      JSON.parse(text) as KbEncryptedRecord,
      identity(row, part),
      options.masterKey,
    ),
  );
}

/** The authority lock serializes generation activation, admission, and live authority changes. */
export async function beginQueryEmbedding(
  options: QueryEmbeddingOptions & { ratePort: RatePort },
  actor: IndexActor,
  input: { kbId: string; query: string; timeoutMs?: number; generationId?: string },
  signal?: AbortSignal,
) {
  const parsed = z
    .object({
      kbId: z.string().regex(/^[a-z0-9]{24,32}$/),
      // Unicode scalars, as the public knowledge_search contract counts them (not UTF-16 units).
      query: unicodeBoundedString({ min: 1, max: 1024, postgresText: true }),
      generationId: z
        .string()
        .regex(/^[a-z0-9]{24,32}$/)
        .optional(),
      timeoutMs: z.number().int().min(1).max(QUERY_DEADLINE_MS).default(QUERY_DEADLINE_MS),
    })
    .safeParse(input);
  if (!parsed.success) throw new KbDomainError("INVALID_ARGUMENT", "Invalid query");
  const safe = prepareEmbeddingQuery(parsed.data.query);
  const deadline = new Date(
    Math.min(Date.now() + parsed.data.timeoutMs, options.deadlineAt ?? Infinity),
  );
  const id = randomUUID();
  if (signal?.aborted) throw failure("CANCELLED");
  if (deadline.getTime() <= Date.now()) throw failure("DEADLINE_EXCEEDED");
  // R3-L4: the embedding target's breaker ticket (kept across a retried transaction).
  let ticket: BreakerTicket | null = null;
  try {
    const admission = await transaction(
      { ...options, deadlineAt: deadline.getTime() },
      async (q) => {
        const auth = await authorize({
          ...actor,
          kbId: input.kbId,
          operation: "read",
          store: sqlAuthorityStore(q),
          query: q,
        });
        if (auth.state !== "ACTIVE") throw failure("INDEX_UNAVAILABLE");
        const pinned = parsed.data.generationId;
        const { index } = await loadIndexStatus(q, input.kbId);
        // An FTS5-only generation is searched lexically, never embedded against.
        if (
          !pinned &&
          index.activeGenerationId &&
          index.activeState === "COMPLETE" &&
          (await isLexicalGeneration(q, index.activeGenerationId, input.kbId))
        )
          return new LexicalOnlySearchError(
            index.activeGenerationId,
            index,
            false,
            deadline.getTime(),
          );
        if (
          !pinned &&
          (!index.activeGenerationId ||
            index.activeState !== "COMPLETE" ||
            index.freshness === "unavailable")
        )
          throw failure("INDEX_UNAVAILABLE");
        const generationId = pinned ?? index.activeGenerationId!;
        const g = (
          await q<{
            providerId: string | null;
            providerVersion: number | null;
            fingerprint: string | null;
            dimensions: number | null;
          }>(
            `SELECT "providerId","providerVersion",fingerprint,dimensions FROM index_generation
            WHERE id=$1 AND "kbId"=$2 AND state IN ('COMPLETE','SUPERSEDED')`,
            [generationId, input.kbId],
          )
        ).rows[0];
        // A cursor-pinned generation that is no longer retained never silently repins.
        if (!g)
          throw pinned
            ? new KbDomainError("INVALID_CURSOR", "Invalid cursor")
            : failure("INDEX_UNAVAILABLE");
        if (g.providerId === null || g.providerVersion === null) {
          if (pinned) return new LexicalOnlySearchError(pinned, index, true, deadline.getTime());
          throw failure("INDEX_UNAVAILABLE");
        }
        // Effective query availability (`queryAvailability`, one predicate): a
        // reloading or other-model built-in serves its FTS5 arm with its notice; a profile
        // that can no longer embed queries too. Query compatibility: same model
        // identity, any build parameters.
        const availability = await queryAvailability(q, g.providerId, g.providerVersion);
        if (!availability.available)
          return availability.reason === "PROFILE_UNUSABLE"
            ? new LexicalOnlySearchError(
                generationId,
                index,
                pinned !== undefined,
                deadline.getTime(),
                false,
                "PROFILE_UNUSABLE",
              )
            : new LexicalOnlySearchError(
                generationId,
                index,
                pinned !== undefined,
                deadline.getTime(),
              );
        const profile = availability.profile;
        // R3-L4: a target whose last query embedding timed out is not tried again
        // until its cooldown ends; the search serves the keyword arm at once (notice).
        const key = `${profile.providerId}:${profile.revision}`;
        if (ticket?.key !== key) {
          if (ticket) queryEmbedBreaker.release(ticket);
          ticket = null;
          const admitted = queryEmbedBreaker.admit(key);
          if (admitted === "open")
            return new LexicalOnlySearchError(
              generationId,
              index,
              pinned !== undefined,
              deadline.getTime(),
              false,
              "EMBEDDING_FAILED",
            );
          ticket = admitted;
        }
        const count = (
          await q<{ count: number }>(
            `SELECT count(*)::int AS count FROM query_embedding_request WHERE "userId"=$1 AND deadline>clock_timestamp() AND state IN ('PENDING','RUNNING','READY','DELIVERED') AND EXISTS(SELECT 1 FROM generation_lease l WHERE l."requestId"=query_embedding_request.id AND l."expiresAt">clock_timestamp())`,
            [actor.principal.userId],
          )
        ).rows[0]!.count;
        if (count >= KB_LIMITS.queryInFlightPerUser)
          throw new KbDomainError("RATE_LIMITED", "Query capacity exhausted", 1);
        await chargeRate(options.ratePort, {
          kind: "query",
          key: `${actor.principal.userId}:${input.kbId}`,
        });
        // Orders built-in re-embedding after a config change.
        await q(`UPDATE knowledge_base SET "lastQueriedAt"=statement_timestamp() WHERE id=$1`, [
          input.kbId,
        ]);
        const snapshot: Snapshot = {
          kbOwnerId: auth.ownerId,
          providerId: profile.providerId,
          revision: profile.revision,
          kind: profile.kind,
          ownerId: profile.ownerId,
          fingerprint: profile.fingerprint,
          dimensions: profile.dimensions,
          index,
          ...(pinned ? { pinnedGenerationId: pinned } : {}),
        };
        if (snapshot.fingerprint !== g.fingerprint || snapshot.dimensions !== g.dimensions)
          throw failure("INDEX_UNAVAILABLE");
        const principal =
          actor.principal.kind === "browser"
            ? { kind: "browser", userId: actor.principal.userId }
            : {
                ...demandToolGroups(actor.principal, ["read"]),
                storedAcl: [[input.kbId, actor.principal.storedAcl.get(input.kbId) ?? []]],
              };
        await enqueueDurableJobOnQuery(q, {
          jobId: id,
          kind: "QUERY_EMBEDDING",
          dedupKey: `query:${id}`,
          desired: { requestId: id },
        });
        const inserted = await q(
          `INSERT INTO query_embedding_request (id,"kbId","generationId","actorKey","userId",principal,snapshot,"queryCiphertext",state,deadline,"createdAt","scrubAt")
        SELECT $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,'PENDING',$9::timestamptz,statement_timestamp(),statement_timestamp()+($10*interval '1 millisecond') WHERE $9::timestamptz>clock_timestamp()`,
          [
            id,
            input.kbId,
            generationId,
            actorKeyFor(actor.principal),
            actor.principal.userId,
            JSON.stringify(principal),
            JSON.stringify(snapshot),
            encrypt(options, { id, userId: actor.principal.userId }, "query", safe),
            deadline.toISOString(),
            QUERY_SCRUB_MS,
          ],
        );
        if (inserted.rowCount !== 1) throw failure("DEADLINE_EXCEEDED");
        await q(
          `INSERT INTO generation_lease ("requestId","generationId","expiresAt") SELECT id,"generationId","createdAt"+($3*interval '1 millisecond') FROM query_embedding_request WHERE id=$1 AND "generationId"=$2`,
          [id, generationId, GENERATION_LEASE_MS],
        );
        return { id, deadline, generationId, pinned: pinned !== undefined, ticket };
      },
      signal,
    );
    // Lexical admission is a successful transaction: commit serving reconciliation
    // before signalling the keyword continuation to the caller.
    if (admission instanceof LexicalOnlySearchError) throw admission;
    return admission;
  } catch (error) {
    if (ticket) queryEmbedBreaker.release(ticket);
    await cancelQueryEmbedding(options, actor, id).catch(() => {});
    if (signal?.aborted) throw failure("CANCELLED");
    if (error instanceof KbDomainError || error instanceof SensitiveQueryError) throw error;
    const admission = fromAdmissionError(error);
    if (admission) throw admission;
    throw failure("INDEX_UNAVAILABLE");
  }
}

/** Authority -> request/job rows; heartbeat/dispatcher only take job rows. No IO under locks. */
async function loadRequest(q: LockQuery, id: string) {
  return (
    await q<RequestRow>(
      `SELECT r.*,g.state AS "generationState",g.fingerprint,g.dimensions,g."providerId",g."providerVersion",
    (r.deadline>clock_timestamp()) AS live,EXISTS(SELECT 1 FROM generation_lease l WHERE l."requestId"=r.id AND l."generationId"=r."generationId" AND l."expiresAt">clock_timestamp()) AS leased,
    j.state AS "jobState",j."workerOwner",j."attemptEpoch",(j."cancelledAt" IS NULL AND j."leaseUntil">clock_timestamp()) AS "jobLive"
    FROM query_embedding_request r JOIN index_generation g ON g.id=r."generationId" AND g."kbId"=r."kbId" JOIN durable_job j ON j.id=r.id WHERE r.id=$1 FOR UPDATE OF r,j`,
      [id],
    )
  ).rows[0];
}
async function closeRequest(q: LockQuery, id: string, code: Closure) {
  await q(
    `UPDATE query_embedding_request SET state=$2::"QueryEmbeddingState","queryCiphertext"=NULL,"resultCiphertext"=NULL WHERE id=$1 AND state IN ('PENDING','RUNNING','READY','DELIVERED')`,
    [id, code],
  );
  await q(
    `UPDATE durable_job SET state='CANCELLED',"cancelledAt"=clock_timestamp(),"workerOwner"=NULL,"leaseUntil"=NULL WHERE id=$1 AND state NOT IN ('COMPLETE','CANCELLED')`,
    [id],
  );
  await q('DELETE FROM generation_lease WHERE "requestId"=$1', [id]);
}

type PeekProgress =
  | { phase: "pending" }
  | { phase: "ready" }
  | { phase: "terminal"; code: Failure }
  /** The embedder failed or the profile was lost (degradable). */
  | { phase: "embedding-unavailable" };

type PeekSession = {
  connectionString: string;
  applicationName: string;
  drain?: SearchReadDrain;
  closing?: Promise<void>;
  client: Client | null;
  /** Set while `connect()` is in flight so abort/teardown can end the client before assignment. */
  connecting: Client | null;
};

function peekRemainingMs(deadlineAt: number): number {
  return deadlineAt - Date.now();
}

function peekTimeoutMs(deadlineAt: number): number {
  return Math.max(1, peekRemainingMs(deadlineAt));
}

async function closePeekSession(session: PeekSession) {
  if (session.closing) return session.closing;
  const clients = new Set([session.connecting, session.client]);
  session.connecting = null;
  session.client = null;
  const closing = (async () => {
    for (const client of clients) {
      if (!client) continue;
      if (session.drain) await session.drain(client, session.applicationName);
      else await client.end().catch(() => {});
    }
  })();
  session.closing = closing;
  try {
    await closing;
  } finally {
    if (session.closing === closing) session.closing = undefined;
  }
}

async function ensurePeekClient(
  session: PeekSession,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<Client> {
  if (session.client) return session.client;
  if (signal.aborted) throw failure("CANCELLED");

  const remainingMs = peekTimeoutMs(deadlineAt);
  const client = new Client({
    connectionString: session.connectionString,
    application_name: session.applicationName,
    options: "-c client_connection_check_interval=100ms",
    connectionTimeoutMillis: Math.max(1, Math.min(5000, remainingMs)),
    statement_timeout: remainingMs,
  });
  client.on("error", () => {});
  session.connecting = client;
  try {
    await client.connect();
  } catch (error) {
    if (session.connecting === client) session.connecting = null;
    throw error;
  }
  const closedDuringConnect = session.connecting !== client;
  if (!closedDuringConnect) session.connecting = null;
  if (closedDuringConnect || signal.aborted) {
    await client.end().catch(() => {});
    throw failure("CANCELLED");
  }
  session.client = client;
  try {
    await session.drain?.inherit((text, values) => client.query(text, values), "session");
    signal.throwIfAborted();
    return client;
  } catch (error) {
    await closePeekSession(session);
    throw error;
  }
}

/** Read-only wait hint; does not take the authority advisory lock. */
async function peekQueryEmbeddingProgress(
  session: PeekSession,
  id: string,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<PeekProgress> {
  if (signal.aborted) throw failure("CANCELLED");
  if (peekRemainingMs(deadlineAt) <= 0) throw new EmbeddingPhaseExpired();

  const run = async (): Promise<PeekProgress> => {
    const client = await ensurePeekClient(session, deadlineAt, signal);
    await client.query(`SET statement_timeout = '${peekTimeoutMs(deadlineAt)}ms'`);
    const { rows } = await client.query<{ state: string; live: boolean; jobState: string }>(
      `SELECT r.state,(r.deadline>clock_timestamp()) AS live,j.state AS "jobState"
       FROM query_embedding_request r JOIN durable_job j ON j.id=r.id WHERE r.id=$1`,
      [id],
    );
    const row = rows[0];
    if (!row) return { phase: "terminal", code: "INDEX_UNAVAILABLE" };
    if (!row.live) return { phase: "terminal", code: "DEADLINE_EXCEEDED" };
    if (row.state === "READY") return { phase: "ready" };
    if (row.state === "EMBEDDING_UNAVAILABLE") return { phase: "embedding-unavailable" };
    if (
      row.state === "CANCELLED" ||
      row.state === "DEADLINE_EXCEEDED" ||
      row.state === "INDEX_UNAVAILABLE"
    )
      return { phase: "terminal", code: row.state as Failure };
    // Without the explicit degradable closure the source is unknown (for example,
    // adapter admission failed and cleanup could not acquire the authority lock).
    if (row.jobState === "FAILED") return { phase: "terminal", code: "INDEX_UNAVAILABLE" };
    if (row.jobState === "CANCELLED") return { phase: "terminal", code: "INDEX_UNAVAILABLE" };
    return { phase: "pending" };
  };

  const abortWait = new Promise<never>((_, reject) => {
    const onAbort = () => {
      void closePeekSession(session).catch(() => {});
      reject(new Error("aborted"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([run(), abortWait]);
  } catch (error) {
    if (signal.aborted) throw failure("CANCELLED");
    await closePeekSession(session);
    // A failed peek is not a pending embedding. Retrying SQL/connection failures until
    // the embedding share expires would turn a storage failure into lexical success.
    throw error;
  }
}

async function liveRequest(options: QueryEmbeddingOptions, q: LockQuery, row: RequestRow) {
  if (!row.live) throw failure("DEADLINE_EXCEEDED");
  // A newer activation supersedes the leased generation; its rows stay queryable until the lease ends.
  if (!row.leased || !["COMPLETE", "SUPERSEDED"].includes(row.generationState))
    throw failure("INDEX_UNAVAILABLE");
  const principal = restorePrincipal(row.principal);
  if (principal.userId !== row.userId || actorKeyFor(principal) !== row.actorKey)
    throw failure("INDEX_UNAVAILABLE");
  const auth = await authorize({
    principal,
    // The worker restores the durable principal; a token principal is rechecked against
    // its live grant generation, exactly as the server's own lock-session recheck does.
    verifier:
      options.verifier ??
      (principal.kind === "token" ? createGrantCredentialVerifier(q) : undefined),
    kbId: row.kbId,
    operation: "read",
    store: sqlAuthorityStore(q),
    query: q,
  });
  if (auth.state !== "ACTIVE") throw failure("INDEX_UNAVAILABLE");
  const s = row.snapshot;
  if (
    auth.ownerId !== s.kbOwnerId ||
    row.fingerprint !== s.fingerprint ||
    row.dimensions !== s.dimensions ||
    (s.pinnedGenerationId ?? s.index.activeGenerationId) !== row.generationId
  )
    throw failure("INDEX_UNAVAILABLE");
  // Profile liveness last, classified on its own: losing it only ever degrades to keywords.
  const availability = await queryAvailability(q, row.providerId, row.providerVersion);
  if (!availability.available) throw new ProfileLostError();
  const p = availability.profile;
  if (
    p.providerId !== s.providerId ||
    p.revision !== s.revision ||
    p.kind !== s.kind ||
    p.ownerId !== s.ownerId ||
    p.fingerprint !== s.fingerprint ||
    p.dimensions !== s.dimensions
  )
    throw new ProfileLostError();
}

async function access<T>(
  options: QueryEmbeddingOptions,
  id: string,
  operation: (q: LockQuery, row: RequestRow) => Promise<T>,
  guard: { actor?: IndexActor; attempt?: IndexAttempt; signal?: AbortSignal } = {},
) {
  const outcome = await transaction(
    options,
    async (q) => {
      const row = await loadRequest(q, id);
      if (!row) return { error: "INDEX_UNAVAILABLE" as Failure };
      if (
        guard.actor &&
        (row.actorKey !== actorKeyFor(guard.actor.principal) ||
          row.userId !== guard.actor.principal.userId)
      )
        throw failure("INDEX_UNAVAILABLE");
      if (
        guard.attempt &&
        (row.jobState !== "RUNNING" ||
          !row.jobLive ||
          row.workerOwner !== guard.attempt.workerId ||
          row.attemptEpoch !== guard.attempt.epoch ||
          row.id !== guard.attempt.jobId)
      )
        throw new DurableJobFenceError();
      if (guard.actor) {
        try {
          await authorize({
            ...guard.actor,
            kbId: row.kbId,
            operation: "read",
            store: sqlAuthorityStore(q),
            query: q,
          });
        } catch (error) {
          const admission = fromAdmissionError(error);
          if (admission?.code === "NOT_FOUND" || admission?.code === "FORBIDDEN") {
            await closeRequest(q, id, "INDEX_UNAVAILABLE");
            return { denied: admission };
          }
          throw failure("INDEX_UNAVAILABLE");
        }
      }
      // The degradable closure surfaces as its tagged error, never as a wire code.
      if (row.state === "EMBEDDING_UNAVAILABLE") return { embeddingFailed: true as const };
      if (!["PENDING", "RUNNING", "READY", "DELIVERED"].includes(row.state))
        return { error: row.state as Failure };
      try {
        await liveRequest(options, q, row);
        return { value: await operation(q, row) };
      } catch (error) {
        if (error instanceof DurableJobFenceError) throw error;
        if (error instanceof ProfileLostError) {
          await closeRequest(q, id, "EMBEDDING_UNAVAILABLE");
          return { profileLost: true as const };
        }
        // An invalid embedding (completeQueryEmbedding's validation) is the embedder failing.
        if (error instanceof EmbeddingUnavailableError) {
          await closeRequest(q, id, "EMBEDDING_UNAVAILABLE");
          return { embeddingFailed: true as const };
        }
        const code =
          error instanceof KbDomainError && error.code === "DEADLINE_EXCEEDED"
            ? "DEADLINE_EXCEEDED"
            : "INDEX_UNAVAILABLE";
        await closeRequest(q, id, code);
        return { error: code as Failure };
      }
    },
    guard.signal,
  );
  if ("denied" in outcome && outcome.denied) throw outcome.denied;
  if ("profileLost" in outcome) throw new ProfileLostError();
  if ("embeddingFailed" in outcome) throw new EmbeddingFailedError();
  if (outcome.error) throw failure(outcome.error);
  return outcome.value as T;
}

export async function cancelQueryEmbedding(
  options: QueryEmbeddingOptions,
  actor: IndexActor,
  id: string,
  code: Failure = "CANCELLED",
) {
  await transaction(
    { ...options, searchReadDrain: undefined, deadlineAt: Date.now() + 5_000 },
    async (q) => {
      const row = await loadRequest(q, id);
      if (row?.actorKey === actorKeyFor(actor.principal) && row.userId === actor.principal.userId)
        await closeRequest(q, id, code);
    },
  );
}

/** Durable dispatch reservation. Called again by the external adapter immediately before IO. */
export function dispatchQueryEmbedding(options: QueryEmbeddingOptions, attempt: IndexAttempt) {
  return access(
    options,
    attempt.jobId,
    async (q, row) => {
      if (!["PENDING", "RUNNING"].includes(row.state)) throw new DurableJobFenceError();
      const text = z
        .string()
        .min(1)
        .parse(decrypt(options, row, "query"));
      const reserved = await q(
        `UPDATE query_embedding_request SET state='RUNNING' WHERE id=$1 AND deadline>clock_timestamp() AND EXISTS(SELECT 1 FROM durable_job j WHERE j.id=$1 AND j."leaseUntil">clock_timestamp())`,
        [row.id],
      );
      if (reserved.rowCount !== 1) throw failure("DEADLINE_EXCEEDED");
      return { text: prepareEmbeddingQuery(text), ...row.snapshot, deadline: row.deadline };
    },
    { attempt },
  );
}
export function completeQueryEmbedding(
  options: QueryEmbeddingOptions,
  attempt: IndexAttempt,
  vectors: number[][],
) {
  return access(
    options,
    attempt.jobId,
    async (q, row) => {
      if (row.state !== "RUNNING") throw new DurableJobFenceError();
      const vector = validateEmbeddings(
        { data: vectors.map((embedding, index) => ({ index, embedding })) },
        1,
        row.dimensions,
      )[0]!;
      const accepted = await q(
        `UPDATE query_embedding_request SET state='READY',"queryCiphertext"=NULL,"resultCiphertext"=$2 WHERE id=$1 AND state='RUNNING' AND deadline>clock_timestamp() AND EXISTS(SELECT 1 FROM durable_job j WHERE j.id=$1 AND j."leaseUntil">clock_timestamp())`,
        [
          row.id,
          encrypt(options, row, "result", {
            generationId: row.generationId,
            fingerprint: row.fingerprint,
            vector,
          }),
        ],
      );
      if (accepted.rowCount !== 1) throw failure("DEADLINE_EXCEEDED");
      await q(
        `UPDATE durable_job SET state='COMPLETE',"completedAt"=clock_timestamp(),"workerOwner"=NULL,"leaseUntil"=NULL WHERE id=$1`,
        [row.id],
      );
      return { accepted: true };
    },
    { attempt },
  );
}
/**
 * Worker-side closure of a request it could not complete. `embedder` is true only when the
 * embedder itself failed (or returned an invalid embedding) — the one degradable closure;
 * any request/lease/fence failure closes it as INDEX_UNAVAILABLE.
 */
export function failQueryEmbedding(
  options: QueryEmbeddingOptions,
  attempt: IndexAttempt,
  cause: { embedder: boolean } = { embedder: false },
) {
  return access(
    options,
    attempt.jobId,
    async (q, row) =>
      closeRequest(q, row.id, cause.embedder ? "EMBEDDING_UNAVAILABLE" : "INDEX_UNAVAILABLE"),
    { attempt },
  );
}
export type LeasedQueryVector = {
  /** Request/lease identity; search SQL re-verifies this lease before reading chunks. */
  requestId: string;
  generationId: string;
  fingerprint: string;
  vector: number[];
  index: IndexStatus;
  /** True when a page cursor pinned this retained generation instead of the active one. */
  pinned: boolean;
};
export function takeQueryEmbedding(
  options: QueryEmbeddingOptions,
  actor: IndexActor,
  id: string,
  signal?: AbortSignal,
) {
  return access<LeasedQueryVector | null>(
    options,
    id,
    async (q, row) => {
      if (row.state === "DELIVERED") throw new DurableJobFenceError();
      if (row.state !== "READY") {
        if (row.jobState === "FAILED") throw failure("INDEX_UNAVAILABLE");
        if (row.jobState === "CANCELLED") throw failure("INDEX_UNAVAILABLE");
        return null;
      }
      const result = z
        .object({
          generationId: z.literal(row.generationId),
          fingerprint: z.literal(row.fingerprint),
          vector: z.array(z.number().finite()).length(row.dimensions),
        })
        .parse(decrypt(options, row, "result"));
      const taken = await q(
        `UPDATE query_embedding_request SET state='DELIVERED',"queryCiphertext"=NULL,"resultCiphertext"=NULL WHERE id=$1 AND deadline>clock_timestamp()`,
        [id],
      );
      if (taken.rowCount !== 1) throw failure("DEADLINE_EXCEEDED");
      return {
        ...result,
        requestId: row.id,
        index: row.snapshot.index,
        pinned: row.snapshot.pinnedGenerationId !== undefined,
      };
    },
    { actor, signal },
  );
}

/**
 * An admitted request whose embedding could not be produced (the worker failed
 * it — the model or provider is erroring, unreachable, or the built-in child was stopped for
 * an exclusive config probe — or it did not arrive within its share of the budget) degrades to
 * the lexical arm of what serves the KB now: unpinned, the active generation (re-admitted, with
 * the status read alongside it); pinned, its retained generation. Otherwise the original failure
 * stands.
 */
async function lexicalFallbackFor(
  options: QueryEmbeddingOptions,
  kbId: string,
  request: { generationId: string; pinned: boolean; deadline: Date },
  signal: AbortSignal,
): Promise<LexicalOnlySearchError | null> {
  return transaction(
    options,
    async (q) => {
      // Serve invariant (generations.ts `serveRankSql`): an unpinned search serves what
      // serves the KB now, read together with its status in this one transaction, never the
      // admitted generation paired with a newer status. A pinned one keeps its generation.
      const { index } = await loadIndexStatus(q, kbId);
      const generationId = request.pinned ? request.generationId : index.activeGenerationId;
      if (!generationId || (!request.pinned && index.activeState !== "COMPLETE")) return null;
      const g = (
        await q<{ providerId: string | null; providerVersion: number | null }>(
          `SELECT "providerId","providerVersion" FROM index_generation
            WHERE id=$1 AND "kbId"=$2 AND state IN ('COMPLETE','SUPERSEDED')`,
          [generationId, kbId],
        )
      ).rows[0];
      if (!g) return null;
      // Transition reasons keep their EMBEDDING_REBUILD_PENDING notice; any other failed
      // embedding is the model erroring. A lexical generation carries its own notice.
      const transition =
        g.providerId !== null &&
        g.providerVersion !== null &&
        isLexicalOnlyReason(await qwenRebuildReason(q, g.providerId, g.providerVersion));
      return new LexicalOnlySearchError(
        generationId,
        index,
        request.pinned,
        request.deadline.getTime(),
        true,
        g.providerId === null || transition ? null : "EMBEDDING_FAILED",
      );
    },
    signal,
  );
}

/** Whether a generation is lexical-only (FTS5, no pinned profile). */
async function isLexicalGeneration(q: LockQuery, generationId: string, kbId: string) {
  const row = (
    await q<{ lexical: boolean }>(
      `SELECT ("providerId" IS NULL) AS lexical FROM index_generation WHERE id=$1 AND "kbId"=$2`,
      [generationId, kbId],
    )
  ).rows[0];
  return row?.lexical === true;
}

/**
 * Common per-user capacity for every live search, across processes and transports.
 * One dedicated session acquires one of four namespaced advisory locks before
 * authority/generation admission. Working SQL backends inherit shared ownership,
 * so loss of the original connection cannot admit a fifth search during drain.
 * New admissions always require an exclusive lock. Cleanup joins the actual
 * uniquely named reader backend before the owning session releases its lock.
 * The durable request count below additionally bounds abandoned embedding work.
 */
export type SearchReadDrain = {
  (client: Client, applicationName: string): Promise<void>;
  inherit(q: LockQuery, mode: "transaction" | "session"): Promise<void>;
};

export async function withQueryCapacity<T>(
  options: QueryEmbeddingOptions,
  actor: IndexActor,
  consume: (signal: AbortSignal, drainRead: SearchReadDrain) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + QUERY_DEADLINE_MS);
  if (signal?.aborted) throw failure("CANCELLED");
  if (deadlineAt <= Date.now()) throw failure("DEADLINE_EXCEEDED");
  const controller = new AbortController();
  let timedOut = false;
  let acquiring = true;
  let connectionFailed = false;
  const ownerName = `kb-query-capacity-${randomUUID()}`;
  const client = new Client({
    connectionString: options.connectionString,
    application_name: ownerName,
    connectionTimeoutMillis: Math.max(1, Math.min(5000, deadlineAt - Date.now())),
    statement_timeout: Math.max(1, deadlineAt - Date.now()),
  });
  client.on("error", () => {
    connectionFailed = true;
    controller.abort();
  });
  const abort = () => {
    controller.abort();
    // After admission the owner must retain its slot until the consumer joins.
    if (acquiring) void client.end().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => {
      timedOut = true;
      abort();
    },
    Math.max(1, deadlineAt - Date.now()),
  );
  try {
    await client.connect();
    for (let slot = 0; slot < KB_LIMITS.queryInFlightPerUser; slot++) {
      controller.signal.throwIfAborted();
      const key = `kb:query-slot:${actor.principal.userId}:${slot}`;
      const result = await client.query<{ acquired: boolean; ownerPid: number }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired, pg_backend_pid() AS "ownerPid"',
        [key],
      );
      if (result.rows[0]?.acquired) {
        acquiring = false;
        const ownerPid = result.rows[0].ownerPid;
        let sharing: Promise<unknown> | undefined;
        const drainRead: SearchReadDrain = Object.assign(
          async (readClient: Client, applicationName: string) => {
            await readClient.end().catch(() => {});
            // Frontend close does not acknowledge backend drain. Use an independent
            // cleanup session: the capacity owner's connection may itself have failed.
            const cleanup = new Client({
              connectionString: options.connectionString,
              application_name: `kb-search-drain-${randomUUID()}`,
              connectionTimeoutMillis: 5000,
              statement_timeout: 1000,
            });
            cleanup.on("error", () => {});
            const cleanupDeadline = Date.now() + 5000;
            try {
              await cleanup.connect();
              for (;;) {
                // Terminate only this operation's reader in this database and role.
                // This also drains a backend whose frontend close was lost in transit.
                const live = await cleanup.query(
                  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                   WHERE datname=current_database() AND usename=current_user AND application_name=$1`,
                  [applicationName],
                );
                if (live.rowCount === 0) break;
                if (Date.now() >= cleanupDeadline) throw failure("INDEX_UNAVAILABLE");
                await delay(10);
              }
            } finally {
              await cleanup.end().catch(() => {});
            }
          },
          {
            inherit: async (q: LockQuery, mode: "transaction" | "session") => {
              controller.signal.throwIfAborted();
              // Acquire shared ownership before releasing exclusive ownership: there
              // is no empty-slot interval. A promise serializes concurrent inheritors.
              sharing ??= client
                .query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [key])
                .then(() =>
                  client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]),
                );
              await sharing;
              controller.signal.throwIfAborted();
              const lock =
                mode === "transaction"
                  ? "pg_try_advisory_xact_lock_shared"
                  : "pg_try_advisory_lock_shared";
              const inherited = await q<{ acquired: boolean }>(
                `SELECT ${lock}(hashtextextended($1,0)) AS acquired`,
                [key],
              );
              if (!inherited.rows[0]?.acquired) throw failure("INDEX_UNAVAILABLE");
              // A lost owner could have let a new operation reuse the same key.
              // Validate the original session after inheriting, before private SQL.
              const live = await q<{ live: boolean }>(
                `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
                 WHERE l.pid=$2 AND a.application_name=$3 AND l.locktype='advisory'
                 AND l.granted AND l.mode='ShareLock' AND l.objsubid=1
                 AND l.classid=((hashtextextended($1,0)>>32)&4294967295)::oid
                 AND l.objid=(hashtextextended($1,0)&4294967295)::oid) AS live`,
                [key, ownerPid, ownerName],
              );
              if (!live.rows[0]?.live) throw failure("INDEX_UNAVAILABLE");
              controller.signal.throwIfAborted();
            },
          },
        );
        const value = await consume(controller.signal, drainRead);
        controller.signal.throwIfAborted();
        return value;
      }
    }
    throw new KbDomainError("RATE_LIMITED", "Query capacity exhausted", 1);
  } catch (error) {
    if (controller.signal.aborted)
      throw failure(
        timedOut ? "DEADLINE_EXCEEDED" : connectionFailed ? "INDEX_UNAVAILABLE" : "CANCELLED",
      );
    if (error instanceof KbDomainError || error instanceof SensitiveQueryError) throw error;
    const admission = fromAdmissionError(error);
    if (admission) throw admission;
    throw failure("INDEX_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    // consume has settled, including the search read connection's finally/drain.
    await client.end().catch(() => {});
  }
}

/** Search consumes the pinned vector under its lease; private return rechecks live authority. */
export async function withQueryEmbedding<T>(
  options: QueryEmbeddingOptions & { ratePort: RatePort },
  actor: IndexActor,
  input: { kbId: string; query: string; timeoutMs?: number; generationId?: string },
  consume: (
    vector: LeasedQueryVector,
    signal: AbortSignal,
    drainRead?: SearchReadDrain,
  ) => Promise<T>,
  signal?: AbortSignal,
  lexicalConsume?: (
    source: LexicalGeneration,
    signal: AbortSignal,
    drainRead?: SearchReadDrain,
  ) => Promise<T>,
): Promise<T> {
  options = {
    ...options,
    deadlineAt: Math.min(
      options.deadlineAt ?? Infinity,
      Date.now() + (input.timeoutMs ?? QUERY_DEADLINE_MS),
    ),
  };
  return withQueryCapacity(
    options,
    actor,
    async (stop, drainRead) => {
      const ownedOptions = { ...options, searchReadDrain: drainRead };
      try {
        return await consumeQueryEmbedding(
          ownedOptions,
          actor,
          input,
          (vector, signal) => consume(vector, signal, drainRead),
          stop,
        );
      } catch (error) {
        if (!(error instanceof LexicalOnlySearchError) || !lexicalConsume) throw error;
        // A permitted continuation is still this operation: retain its slot and
        // deadline through lexical admission, final authorization and SQL drain.
        return consumeLexicalSearch(
          ownedOptions,
          actor,
          { kbId: input.kbId },
          error,
          (source, signal) => lexicalConsume(source, signal, drainRead),
          stop,
        );
      }
    },
    signal,
  );
}

/** Search consumes the pinned vector under its lease; private return rechecks live authority. */
async function consumeQueryEmbedding<T>(
  options: QueryEmbeddingOptions & { ratePort: RatePort },
  actor: IndexActor,
  input: { kbId: string; query: string; timeoutMs?: number; generationId?: string },
  consume: (vector: LeasedQueryVector, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadlineAt = Math.min(
    options.deadlineAt ?? Infinity,
    Date.now() + (input.timeoutMs ?? QUERY_DEADLINE_MS),
  );
  options = { ...options, deadlineAt };
  if (signal?.aborted) throw failure("CANCELLED");
  if (deadlineAt <= Date.now()) throw failure("DEADLINE_EXCEEDED");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let delivered = false;
  let consuming = false;
  let consumer: Promise<T> | undefined;
  let request: Awaited<ReturnType<typeof beginQueryEmbedding>> | undefined;
  const timer = setTimeout(
    () => {
      timedOut = true;
      abort();
    },
    Math.max(1, deadlineAt - Date.now()),
  );
  const peekSession: PeekSession = {
    connectionString: options.connectionString,
    applicationName: `kb-search-peek-${randomUUID()}`,
    drain: options.searchReadDrain,
    client: null,
    connecting: null,
  };
  let embedDeadlineAt = embeddingDeadline(deadlineAt);
  let fullBound = false;
  let verdict = false;
  try {
    request = await beginQueryEmbedding(options, actor, input, controller.signal);
    // R3-L4: the embedding's own bound starts when the embedding does, after admission (authority,
    // SQL, rate limit); only a timeout of that full bound blames the target, never the search's
    // own short budget or slow admission.
    const budgetDeadlineAt = embeddingDeadline(deadlineAt);
    embedDeadlineAt = Math.min(budgetDeadlineAt, Date.now() + QUERY_EMBEDDING_DEADLINE_MS);
    fullBound = embedDeadlineAt < budgetDeadlineAt;
    for (;;) {
      if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
      if (Date.now() >= embedDeadlineAt) throw new EmbeddingPhaseExpired();
      const progress = await peekQueryEmbeddingProgress(
        peekSession,
        request.id,
        Math.min(request.deadline.getTime(), embedDeadlineAt),
        controller.signal,
      );
      if (progress.phase === "embedding-unavailable") throw new EmbeddingFailedError();
      if (progress.phase === "terminal") throw failure(progress.code);
      if (progress.phase === "ready") {
        const vector = await takeQueryEmbedding(options, actor, request.id, controller.signal);
        if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
        if (!vector) continue;
        if (request.ticket) queryEmbedBreaker.succeed(request.ticket);
        verdict = true;
        consuming = true;
        // Consumers must observe this signal; the race bounds delivery even if they don't.
        const stopped = delay(Math.max(1, request.deadline.getTime() - Date.now()), undefined, {
          signal: controller.signal,
        }).then(() => {
          throw failure("DEADLINE_EXCEEDED");
        });
        consumer = consume(vector, controller.signal);
        const result = await Promise.race([consumer, stopped]);
        if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
        await access(
          options,
          request.id,
          async (q, row) => {
            await q('DELETE FROM generation_lease WHERE "requestId"=$1', [row.id]);
          },
          { actor, signal: controller.signal },
        );
        if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
        delivered = true;
        return result;
      }
      await delay(50, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
    // One effective mode, closed classification (`degradableKind`): before a vector is
    // consumed a failed or timed-out embedding, and at any point a lost profile, degrades to the
    // keyword arm — once the consumer has drained. Nothing else ever does.
    const kind = degradableKind(error);
    if (request?.ticket && !verdict && kind === "EMBEDDING_TIMEOUT" && fullBound) {
      queryEmbedBreaker.fail(request.ticket);
      verdict = true;
    }
    if (request && (kind === "PROFILE_LOST" || (!consuming && kind !== null))) {
      await consumer?.catch(() => {});
      const lexical = await lexicalFallbackFor(
        options,
        input.kbId,
        request,
        controller.signal,
      ).catch(() => null);
      if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
      if (lexical) throw lexical;
    }
    if (error instanceof DurableJobFenceError) throw failure("INDEX_UNAVAILABLE");
    if (error instanceof EmbeddingPhaseExpired) throw failure("DEADLINE_EXCEEDED");
    if (error instanceof KbDomainError || error instanceof SensitiveQueryError) throw error;
    const admission = fromAdmissionError(error);
    if (admission) throw admission;
    throw failure("INDEX_UNAVAILABLE");
  } finally {
    if (request?.ticket && !verdict) queryEmbedBreaker.release(request.ticket);
    clearTimeout(timer);
    abort();
    signal?.removeEventListener("abort", abort);
    await consumer?.catch(() => {});
    await closePeekSession(peekSession);
    if (request && !delivered)
      await cancelQueryEmbedding(
        options,
        actor,
        request.id,
        timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED",
      ).catch(() => {});
  }
}

export type LexicalGeneration = {
  lexical: true;
  generationId: string;
  index: IndexStatus;
  pinned: boolean;
  /** Why a lexical-only generation is served (null for the built-in cases). */
  notice: IndexNotice | null;
};

/** Standalone lexical admission; embedding continuations retain their existing owner. */
export async function withLexicalSearch<T>(
  options: QueryEmbeddingOptions & { ratePort: RatePort },
  actor: IndexActor,
  input: { kbId: string; timeoutMs?: number },
  target: LexicalOnlySearchError,
  consume: (
    source: LexicalGeneration,
    signal: AbortSignal,
    drainRead?: SearchReadDrain,
  ) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  options = {
    ...options,
    deadlineAt: Math.min(
      target.deadlineAt,
      options.deadlineAt ?? Infinity,
      Date.now() + (input.timeoutMs ?? QUERY_DEADLINE_MS),
    ),
  };
  return withQueryCapacity(
    options,
    actor,
    (stop, drainRead) =>
      consumeLexicalSearch(
        { ...options, searchReadDrain: drainRead },
        actor,
        input,
        target,
        (source, signal) => consume(source, signal, drainRead),
        stop,
      ),
    signal,
  );
}

/**
 * Lexical-only search over a generation of an older built-in model identity.
 * Same admission as a hybrid search (live read authority, the shared
 * query budget) and the same final authorization before the reply; the
 * generation is re-verified to still be lexical-only under the authority lock.
 */
async function consumeLexicalSearch<T>(
  options: QueryEmbeddingOptions & { ratePort: RatePort },
  actor: IndexActor,
  input: { kbId: string; timeoutMs?: number },
  target: LexicalOnlySearchError,
  consume: (source: LexicalGeneration, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const deadlineAt = Math.min(
    target.deadlineAt,
    options.deadlineAt ?? Infinity,
    Date.now() + (input.timeoutMs ?? QUERY_DEADLINE_MS),
  );
  options = { ...options, deadlineAt };
  if (signal?.aborted) throw failure("CANCELLED");
  if (deadlineAt <= Date.now()) throw failure("DEADLINE_EXCEEDED");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(
    () => {
      timedOut = true;
      abort();
    },
    Math.max(1, deadlineAt - Date.now()),
  );
  const check = (q: LockQuery) =>
    authorize({
      ...actor,
      kbId: input.kbId,
      operation: "read",
      store: sqlAuthorityStore(q),
      query: q,
    });
  try {
    const source = await transaction(
      options,
      async (q) => {
        const auth = await check(q);
        if (auth.state !== "ACTIVE") throw failure("INDEX_UNAVAILABLE");
        if (!target.charged)
          await chargeRate(options.ratePort, {
            kind: "query",
            key: `${actor.principal.userId}:${input.kbId}`,
          });
        // One record: the served generation and its status come from this transaction. An
        // unpinned target follows the active generation (it may have moved since the target
        // was chosen); a pinned one keeps its generation.
        const { index } = await loadIndexStatus(q, input.kbId);
        const generationId = target.pinned
          ? target.generationId
          : index.activeState === "COMPLETE"
            ? index.activeGenerationId
            : null;
        const g = generationId
          ? (
              await q<{ providerId: string | null; providerVersion: number | null }>(
                `SELECT "providerId","providerVersion" FROM index_generation
              WHERE id=$1 AND "kbId"=$2 AND state IN ('COMPLETE','SUPERSEDED')`,
                [generationId, input.kbId],
              )
            ).rows[0]
          : undefined;
        // A lexical-only generation has no profile; a fallback serves any retained
        // generation's FTS5 arm, as does an unpinned target the active pointer moved past (the
        // keyword ranking was already decided); otherwise the built-in reason must still make it
        // lexical-only now.
        const lexicalGeneration = g?.providerId === null;
        if (
          !g ||
          (!lexicalGeneration &&
            target.fallback === null &&
            generationId === target.generationId &&
            (g.providerId === null ||
              g.providerVersion === null ||
              !isLexicalOnlyReason(await qwenRebuildReason(q, g.providerId, g.providerVersion))))
        )
          throw target.pinned
            ? new KbDomainError("INVALID_CURSOR", "Invalid cursor")
            : failure("INDEX_UNAVAILABLE");
        await q(`UPDATE knowledge_base SET "lastQueriedAt"=statement_timestamp() WHERE id=$1`, [
          input.kbId,
        ]);
        return {
          lexical: true as const,
          generationId: generationId!,
          index,
          pinned: target.pinned,
          notice: lexicalGeneration
            ? await lexicalNoticeFor(q, input.kbId)
            : target.fallback && g.providerId
              ? await fallbackNoticeFor(q, input.kbId, g.providerId)
              : null,
        };
      },
      controller.signal,
    );
    const result = await consume(source, controller.signal);
    if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
    // Private return: live read authority is rechecked before the reply.
    await transaction(options, async (q) => check(q), controller.signal);
    if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw failure(timedOut ? "DEADLINE_EXCEEDED" : "CANCELLED");
    if (error instanceof KbDomainError || error instanceof SensitiveQueryError) throw error;
    const admission = fromAdmissionError(error);
    if (admission) throw admission;
    throw failure("INDEX_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    abort();
    signal?.removeEventListener("abort", abort);
  }
}
