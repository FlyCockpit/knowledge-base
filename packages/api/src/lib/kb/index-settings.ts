import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recordAuditEvent } from "./audit";
import { KbDomainError } from "./errors";
import { type IndexActor, scheduleIndexBuild } from "./generations";
import { chargeKbMutation, chargeRate, KB_LIMITS } from "./limits";
import type { LockQuery } from "./lock";
import {
  canonicalRequestHash,
  findFinalizedReceiptForUpdate,
  recordFinalizedReceipt,
} from "./operation-intent";
import { type Authorization, authorize, sqlAuthorityStore } from "./permissions";
import { actorKeyFor } from "./principal";
import { kbReadToolSchemas } from "./protocol/reads";
import { kbWriteToolSchemas } from "./protocol/writes";
import type { KbRuntimeConfig } from "./runtime";

/**
 * §1.9 (decisions 14, 22): the only module that reads or writes the index chunk
 * limit, the per-quantization admin ceilings and the KB quantization. Every write
 * validates against the hard bound; every read clamps (a stored value above a
 * later-lowered bound is never effective). Web/oRPC only — never an MCP tool.
 */

export const INDEX_QUANTIZATIONS = ["int8", "binary_int8_rescore"] as const;
export type IndexQuantizationName = (typeof INDEX_QUANTIZATIONS)[number];
const indexQuantizationSchema = z.enum(INDEX_QUANTIZATIONS);

/** Prisma `IndexQuantization` enum value per wire name. */
const STORED_QUANTIZATION = {
  int8: "INT8",
  binary_int8_rescore: "BINARY_INT8_RESCORE",
} as const satisfies Record<IndexQuantizationName, string>;

function quantizationFromStored(value: string): IndexQuantizationName {
  const found = INDEX_QUANTIZATIONS.find((q) => STORED_QUANTIZATION[q] === value);
  if (!found) throw new KbDomainError("INTERNAL", "Unknown index quantization");
  return found;
}

export const CHUNK_CEILING_SETTING_KEYS = {
  int8: "kb.index.chunkCeiling.int8",
  binary_int8_rescore: "kb.index.chunkCeiling.binary_int8_rescore",
} as const satisfies Record<IndexQuantizationName, string>;

export type IndexSettingsRefusal =
  | "INVALID_AMOUNT"
  | "CHUNK_CEILING_ABOVE_BOUND"
  | "CHUNK_LIMIT_ABOVE_CEILING"
  | "CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND"
  | "ACTIVE_INDEX_TOO_LARGE";

function refuse(reason: IndexSettingsRefusal): never {
  throw new KbDomainError("INVALID_ARGUMENT", "Index settings refused", undefined, { reason });
}

/** The refusal reason a settings error carries, or null. */
export function indexSettingsRefusal(error: unknown): IndexSettingsRefusal | null {
  if (!(error instanceof KbDomainError) || error.code !== "INVALID_ARGUMENT") return null;
  const reason = (error.details as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? (reason as IndexSettingsRefusal) : null;
}

export type ChunkCeilings = Readonly<Record<IndexQuantizationName, number>>;

/** A stored ceiling is a positive decimal integer string; anything else reads as absent. */
function parseStoredCeiling(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : null;
}

/** `min(stored ?? default, bound[q])`: the read clamp. */
export function chunkCeilingFrom(q: IndexQuantizationName, stored: string | null | undefined) {
  return Math.min(
    parseStoredCeiling(stored) ?? KB_LIMITS.indexChunksDefault,
    KB_LIMITS.indexChunkBound[q],
  );
}

/** The largest limit an owner may store under `q`, clamped to its measured bound. */
function maxOwnerLimit(q: IndexQuantizationName, ceilings: ChunkCeilings): number {
  return Math.min(ceilings[q], KB_LIMITS.indexChunkBound[q]);
}

/** `min(limit ?? default, ceiling[q], bound[q])`; the build reads exactly this (P4). */
export function effectiveChunkLimit(
  kb: { indexChunkLimit: number | null },
  q: IndexQuantizationName,
  ceilings: ChunkCeilings,
): number {
  return Math.min(
    kb.indexChunkLimit ?? KB_LIMITS.indexChunksDefault,
    maxOwnerLimit(q, ceilings),
    KB_LIMITS.indexChunkBound[q],
  );
}

function positiveInteger(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 1) refuse("INVALID_AMOUNT");
  return amount;
}

/** Admin ceiling: integer `1..bound[q]`. Lowering below stored KB limits is allowed (clamped on read). */
export function validateChunkCeiling(q: IndexQuantizationName, amount: number): number {
  positiveInteger(amount);
  if (amount > KB_LIMITS.indexChunkBound[q]) refuse("CHUNK_CEILING_ABOVE_BOUND");
  return amount;
}

/** Owner limit: integer `1..maxOwnerLimit(q)`; `null` resets to the default. */
export function validateChunkLimit(
  amount: number | null,
  q: IndexQuantizationName,
  ceilings: ChunkCeilings,
): number | null {
  if (amount === null) return null;
  positiveInteger(amount);
  if (amount > maxOwnerLimit(q, ceilings)) refuse("CHUNK_LIMIT_ABOVE_CEILING");
  return amount;
}

/** Refusals for switching to `next`; the owner lowers the stored limit first. */
export function assertQuantizationChange(
  kb: { indexChunkLimit: number | null; activeChunkCount: number | null },
  next: IndexQuantizationName,
  ceilings: ChunkCeilings,
): void {
  if (kb.indexChunkLimit !== null && kb.indexChunkLimit > maxOwnerLimit(next, ceilings))
    refuse("CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND");
  // A rebuild would certainly fail INDEX_CHUNK_LIMIT_EXCEEDED.
  if (kb.activeChunkCount !== null && kb.activeChunkCount > effectiveChunkLimit(kb, next, ceilings))
    refuse("ACTIVE_INDEX_TOO_LARGE");
}

export type IndexBuildFailure = "CHUNK_LIMIT" | "DISK_FULL";

/** Desired generation `errorCode` → settings explanation; kb/1 stays `INDEX_BUILD_FAILED`. */
export function buildFailureOf(errorCode: string | null): IndexBuildFailure | null {
  if (errorCode === "INDEX_CHUNK_LIMIT_EXCEEDED") return "CHUNK_LIMIT";
  if (errorCode === "INDEX_DISK_FULL") return "DISK_FULL";
  return null;
}

// ---- storage ---------------------------------------------------------------------

export async function loadChunkCeilings(query: LockQuery): Promise<ChunkCeilings> {
  const keys = INDEX_QUANTIZATIONS.map((q) => CHUNK_CEILING_SETTING_KEYS[q]);
  // Bounded by the two compile-time setting keys.
  const { rows } = await query<{ key: string; value: string }>(
    `SELECT key, value FROM app_setting WHERE key = ANY($1::text[])`,
    [keys],
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return {
    int8: chunkCeilingFrom("int8", stored.get(CHUNK_CEILING_SETTING_KEYS.int8)),
    binary_int8_rescore: chunkCeilingFrom(
      "binary_int8_rescore",
      stored.get(CHUNK_CEILING_SETTING_KEYS.binary_int8_rescore),
    ),
  };
}

export type ChunkCeilingView = Record<IndexQuantizationName, { ceiling: number; bound: number }>;

function ceilingView(ceilings: ChunkCeilings): ChunkCeilingView {
  return {
    int8: { ceiling: ceilings.int8, bound: KB_LIMITS.indexChunkBound.int8 },
    binary_int8_rescore: {
      ceiling: ceilings.binary_int8_rescore,
      bound: KB_LIMITS.indexChunkBound.binary_int8_rescore,
    },
  };
}

export async function readChunkCeilings(query: LockQuery): Promise<ChunkCeilingView> {
  return ceilingView(await loadChunkCeilings(query));
}

/**
 * Instance-admin write. The caller supplies the live-admin authority transaction
 * (`liveAdminOr404Procedure`); this upserts the AppSetting row and audits in it.
 */
export async function setChunkCeiling(
  query: LockQuery,
  actor: { userId: string },
  input: { quantization: IndexQuantizationName; amount: number },
): Promise<ChunkCeilingView> {
  const amount = validateChunkCeiling(input.quantization, input.amount);
  await query(
    `INSERT INTO app_setting (key, value, "createdAt", "updatedAt") VALUES ($1, $2, now(), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
    [CHUNK_CEILING_SETTING_KEYS[input.quantization], String(amount)],
  );
  await recordAuditEvent(query, {
    opId: randomUUID(),
    action: "index_chunk_ceiling_set",
    outcome: "SUCCESS",
    actorKey: `user:${actor.userId}`,
    actorUserIdSnapshot: actor.userId,
    actorUserId: actor.userId,
    metadata: { state: input.quantization, amount: String(amount) },
  });
  return readChunkCeilings(query);
}

type KbIndexRow = {
  quantization: string;
  indexChunkLimit: number | null;
  activeChunkCount: number | null;
  errorCode: string | null;
};

async function loadKbIndexRow(query: LockQuery, kbId: string, lock: boolean): Promise<KbIndexRow> {
  const row = (
    await query<KbIndexRow>(
      `SELECT k."indexQuantization"::text AS quantization, k."indexChunkLimit",
              a."chunkCount" AS "activeChunkCount", g."errorCode"
         FROM knowledge_base k
         LEFT JOIN index_generation a ON a.id = k."activeGenerationId"
         LEFT JOIN index_generation g ON g."kbId" = k.id AND g.epoch = k."desiredEpoch"
        WHERE k.id = $1${lock ? " FOR UPDATE OF k" : ""}`,
      [kbId],
    )
  ).rows[0];
  if (!row) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  return row;
}

export type IndexSettingsView = {
  quantization: IndexQuantizationName;
  /** Stored owner limit; null means the default. */
  limit: number | null;
  effectiveLimit: number;
  /** Largest storable limit under the current quantization. */
  maxLimit: number;
  /** Largest storable limit per quantization (for the quantization select). */
  caps: Record<IndexQuantizationName, number>;
  /** Base default; target-quantization previews clamp it to caps[q]. */
  defaultLimit: number;
  activeChunkCount: number | null;
  canConfigureLimit: boolean;
  buildFailure: IndexBuildFailure | null;
};

function projectSettings(
  row: KbIndexRow,
  ceilings: ChunkCeilings,
  auth: Authorization,
): IndexSettingsView {
  const quantization = quantizationFromStored(row.quantization);
  return {
    quantization,
    limit: row.indexChunkLimit,
    effectiveLimit: effectiveChunkLimit(row, quantization, ceilings),
    maxLimit: maxOwnerLimit(quantization, ceilings),
    caps: { ...ceilings },
    defaultLimit: KB_LIMITS.indexChunksDefault,
    activeChunkCount: row.activeChunkCount,
    canConfigureLimit:
      auth.ownerId !== null &&
      auth.ownerId === auth.principal.userId &&
      auth.bits.includes("manage"),
    buildFailure: buildFailureOf(row.errorCode),
  };
}

function inAuthority<T>(runtime: KbRuntimeConfig, work: (query: LockQuery) => Promise<T>) {
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) => lease.transaction(work),
  });
}

export function getIndexSettings(
  runtime: KbRuntimeConfig,
  actor: IndexActor,
  kbId: string,
): Promise<IndexSettingsView> {
  return inAuthority(runtime, async (query) => {
    const auth = await authorize({
      ...actor,
      kbId,
      operation: "read",
      store: sqlAuthorityStore(query),
      query,
    });
    return projectSettings(
      await loadKbIndexRow(query, kbId, false),
      await loadChunkCeilings(query),
      auth,
    );
  });
}

/** Owner-only (`configure_index_limit`); no rebuild. Validated under the KB row lock. */
export function setIndexChunkLimit(
  runtime: KbRuntimeConfig,
  actor: IndexActor,
  input: { kbId: string; amount: number | null },
): Promise<IndexSettingsView> {
  const actorKey = actorKeyFor(actor.principal);
  return inAuthority(runtime, async (query) => {
    const auth = await authorize({
      ...actor,
      kbId: input.kbId,
      operation: "configure_index_limit",
      store: sqlAuthorityStore(query),
      query,
    });
    if (auth.state !== "ACTIVE") throw new KbDomainError("CONFLICT", "Knowledge base unavailable");
    const row = await loadKbIndexRow(query, input.kbId, true);
    const ceilings = await loadChunkCeilings(query);
    const amount = validateChunkLimit(
      input.amount,
      quantizationFromStored(row.quantization),
      ceilings,
    );
    await chargeKbMutation(runtime.ratePort, actorKey, input.kbId);
    await query(`UPDATE knowledge_base SET "indexChunkLimit" = $2 WHERE id = $1`, [
      input.kbId,
      amount,
    ]);
    await recordAuditEvent(query, {
      opId: randomUUID(),
      action: "index_chunk_limit_set",
      outcome: "SUCCESS",
      kbId: input.kbId,
      actorKey,
      actorUserIdSnapshot: actor.principal.userId,
      actorUserId: actor.principal.userId,
      metadata: { kbId: input.kbId, amount: amount === null ? "default" : String(amount) },
    });
    return projectSettings({ ...row, indexChunkLimit: amount }, ceilings, auth);
  });
}

export const setQuantizationInputSchema = kbWriteToolSchemas.knowledge_index_rebuild.input.extend({
  quantization: indexQuantizationSchema,
});
export const setChunkLimitInputSchema = kbReadToolSchemas.knowledge_index_status.input.extend({
  /** Range is validated by the service so each refusal carries its reason. */
  amount: z.number().finite().nullable(),
});
export const setChunkCeilingInputSchema = z.strictObject({
  quantization: indexQuantizationSchema,
  amount: z.number().finite(),
});
const setQuantizationOutputSchema = kbWriteToolSchemas.knowledge_index_rebuild.output;
export type SetQuantizationOutput = z.infer<typeof setQuantizationOutputSchema>;

/**
 * Manager-level, like `knowledge_embedding_profile_set`: idempotent, RUN-confirmed,
 * charged as a rebuild, and the build is scheduled in the same authority
 * transaction as the refusal checks (§1.9).
 */
export async function setIndexQuantization(
  runtime: KbRuntimeConfig,
  actor: IndexActor,
  raw: z.input<typeof setQuantizationInputSchema>,
): Promise<SetQuantizationOutput> {
  const input = setQuantizationInputSchema.parse(raw);
  const operation = "INDEX_QUANTIZATION_SET";
  const actorKey = actorKeyFor(actor.principal);
  const requestHash = canonicalRequestHash(input);
  return inAuthority(runtime, async (query) => {
    const auth = await authorize({
      ...actor,
      kbId: input.kbId,
      operation: "manage",
      store: sqlAuthorityStore(query),
      query,
    });
    if (auth.state !== "ACTIVE") throw new KbDomainError("CONFLICT", "Knowledge base unavailable");
    const prior = await findFinalizedReceiptForUpdate(query, {
      actorKey,
      kbId: input.kbId,
      operation,
      idempotencyKey: input.idempotencyKey,
    });
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
      return setQuantizationOutputSchema.parse(prior.responseBody);
    }
    const row = await loadKbIndexRow(query, input.kbId, true);
    assertQuantizationChange(row, input.quantization, await loadChunkCeilings(query));
    await query(
      `UPDATE knowledge_base SET "indexQuantization" = $2::"IndexQuantization" WHERE id = $1`,
      [input.kbId, STORED_QUANTIZATION[input.quantization]],
    );
    await chargeRate(runtime.ratePort, { kind: "rebuild", key: input.kbId });
    const build = await scheduleIndexBuild(query, input.kbId);
    if (!build) throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
    const response = { operationId: randomUUID(), ...build };
    await recordFinalizedReceipt(query, {
      actorKey,
      actorUserId: actor.principal.userId,
      kbId: input.kbId,
      operation,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      opId: response.operationId,
      responseBody: response,
    });
    await recordAuditEvent(query, {
      opId: response.operationId,
      action: "index_quantization_set",
      outcome: "SUCCESS",
      kbId: input.kbId,
      actorKey,
      actorUserIdSnapshot: actor.principal.userId,
      actorUserId: actor.principal.userId,
      metadata: { kbId: input.kbId, state: input.quantization },
    });
    return response;
  });
}
