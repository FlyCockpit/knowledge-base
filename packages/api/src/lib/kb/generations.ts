import { randomUUID } from "node:crypto";
import { z } from "zod";
import { invalidArgument, reasonedConflict } from "./argument-reasons";
import { recordAuditEvent } from "./audit";
import { inProgressBuildSql } from "./build-liveness";
import { builtinModel, QWEN_MODEL } from "./builtin-model";
import { EmbeddingUnavailableError } from "./embed-client";
import { createProviderEmbedder, type Embedder } from "./embedder";
import { KbDomainError } from "./errors";
import {
  builtinEmbeddingFingerprint,
  builtinModelIdentity,
  embeddingFingerprint,
} from "./fingerprint";
import { INDEX_QUANTIZATIONS } from "./index-file/format";
import { DurableJobFenceError, enqueueDurableJobOnQuery } from "./jobs";
import { chargeRate } from "./limits";
import { SYSTEM_BUILTIN_PROVIDER_ID } from "./local-model";
import type { LockQuery } from "./lock";
import { QWEN_ARTIFACT } from "./model-artifact";
import {
  canonicalRequestHash,
  findFinalizedReceiptForUpdate,
  recordFinalizedReceipt,
} from "./operation-intent";
import { authorize, sqlAuthorityStore } from "./permissions";
import {
  actorKeyFor,
  assertLiveIdentity,
  type CredentialVerifier,
  KbAdmissionError,
  type Principal,
} from "./principal";
import { canonicalProviderRef } from "./protocol/common";
import { kbWriteToolSchemas } from "./protocol/writes";
import { releaseQuota } from "./quota";
import { DEFAULT_QWEN_RUNTIME_CONFIG, qwenRuntimeConfigSchema } from "./qwen-runtime-config";
import type { KbRuntimeConfig } from "./runtime";

const generationSnapshotBase = {
  generationId: z.string().regex(/^[a-z0-9]{24,32}$/),
  kbId: z.string().regex(/^[a-z0-9]{24,32}$/),
  epoch: z.string().regex(/^\d+$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** Frozen per generation (§1.4); the file `meta` row repeats it (hybrid) and it sets the
   * KB's chunk ceiling (both modes). */
  quantization: z.enum(INDEX_QUANTIZATIONS),
};
const hybridSnapshotSchema = z.strictObject({
  ...generationSnapshotBase,
  providerId: z.string(),
  revision: z.number().int().positive(),
  /** Provider owner; null only for the system SYSTEM_BUILTIN provider. */
  ownerId: z.string().nullable(),
  dimensions: z.number().int().min(1).max(2000),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
/**
 * A KB without a usable embedding profile still gets an FTS5-only
 * generation, so search works from its first document. It pins no profile and stores no
 * vectors; search over it is always `mode: "lexical"`.
 */
const lexicalSnapshotSchema = z.strictObject({
  ...generationSnapshotBase,
  mode: z.literal("lexical"),
});
export const indexBuildSnapshotSchema = z.union([hybridSnapshotSchema, lexicalSnapshotSchema]);
export type IndexBuildSnapshot = z.infer<typeof indexBuildSnapshotSchema>;
export type HybridIndexBuildSnapshot = z.infer<typeof hybridSnapshotSchema>;
export function isLexicalSnapshot(
  snapshot: IndexBuildSnapshot,
): snapshot is z.infer<typeof lexicalSnapshotSchema> {
  return "mode" in snapshot && snapshot.mode === "lexical";
}
export type IndexActor = { principal: Principal; verifier?: CredentialVerifier };
export type IndexAttempt = { jobId: string; workerId: string; epoch: number };

/** Audit actor of work done under a pinned profile: its owner, or the system model. */
export function profileActor(ownerId: string | null) {
  return ownerId === null
    ? { actorKey: "system:qwen", actorUserIdSnapshot: "system:qwen" }
    : { actorKey: `user:${ownerId}`, actorUserIdSnapshot: ownerId };
}

/** Audit actor of a build: the profile's (hybrid) or the system indexer (lexical, no profile). */
export function buildActor(snapshot: IndexBuildSnapshot) {
  return isLexicalSnapshot(snapshot)
    ? { actorKey: "system:index", actorUserIdSnapshot: "system:index" }
    : profileActor(snapshot.ownerId);
}

/**
 * Authority lock held. A specific immutable revision is the only configuration source.
 * OPENAI_COMPAT: live owner, credential present, completed probe. SYSTEM_BUILTIN: the
 * ownerless system provider, usable only while the local model row is READY (verified
 * artifact + verified child runtime). Disable leaves READY, so every recheck of this
 * function fails closed.
 *
 * `purpose`: a SYSTEM_BUILTIN revision is usable for a BUILD only when its
 * fingerprint is the CURRENT one (model identity + the admin runtime config), so a
 * generation never mixes vectors across configs. For a QUERY it is enough that its
 * model identity is the current one: vectors of the same identity share one space,
 * so a KB waiting for re-embedding keeps serving hybrid search from its old
 * generation with query vectors from the single current-config child. A model
 * identity change is never query-compatible. `buildCurrent` tells callers whether
 * the revision is also current for builds.
 */
export async function usableIndexProfile(
  query: LockQuery,
  providerId: string,
  revision: number,
  purpose: "build" | "query",
) {
  const row = (
    await query<{
      endpointUrl: string;
      providerId: string;
      revision: number;
      ownerId: string | null;
      dimensions: number;
      fingerprint: string;
      modelIdentity: string | null;
      name: string;
      kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN";
      model: string;
      currentModelId?: string;
      currentRuntimeIdentity?: string | null;
      currentContextTokens: number | null;
      currentKvKeyType: string | null;
      currentKvValueType: string | null;
    }>(
      `SELECT p.id AS "providerId",r.version AS revision,p."ownerId",r.dimensions,r.fingerprint,r."modelIdentity",p.name,p.kind,r.model,r."endpointUrl",
      cm."modelId" AS "currentModelId",cm."runtimeIdentity" AS "currentRuntimeIdentity",cm."contextTokens" AS "currentContextTokens",cm."kvKeyType" AS "currentKvKeyType",cm."kvValueType" AS "currentKvValueType"
    FROM embedding_provider p JOIN provider_revision r ON r."providerId"=p.id JOIN durable_job j ON j.id=r."jobId"
    LEFT JOIN kb_local_model cm ON p.kind='SYSTEM_BUILTIN' AND cm.id=$3 AND cm.state='READY'
    WHERE p.id=$1 AND r.version=$2 AND p."revokedAt" IS NULL
      AND ((p.kind='OPENAI_COMPAT' AND r.ciphertext IS NOT NULL AND j.state='COMPLETE')
        OR (p.kind='SYSTEM_BUILTIN' AND p."ownerId" IS NULL
          AND EXISTS (SELECT 1 FROM kb_local_model m WHERE m.id=$3 AND m.state='READY' AND m."runtimeIdentity" IS NOT NULL)))`,
      [providerId, revision, QWEN_ARTIFACT.modelId],
    )
  ).rows[0];
  if (!row) throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
  const {
    currentModelId,
    currentRuntimeIdentity,
    currentContextTokens: contextTokens,
    currentKvKeyType: kvKeyType,
    currentKvValueType: kvValueType,
    ...profile
  } = row;
  if (profile.kind === "SYSTEM_BUILTIN") {
    const model = builtinModel(currentModelId ?? QWEN_MODEL.modelId);
    const identity = builtinModelIdentity(model);
    const config = qwenRuntimeConfigSchema.safeParse({ contextTokens, kvKeyType, kvValueType });
    if (
      !config.success ||
      profile.ownerId !== null ||
      profile.dimensions !== model.dimensions ||
      (currentRuntimeIdentity !== undefined && currentRuntimeIdentity !== identity) ||
      profile.modelIdentity !== identity
    )
      throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
    const buildCurrent = profile.fingerprint === builtinEmbeddingFingerprint(model, config.data);
    if (purpose === "build" && !buildCurrent)
      throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
    return { ...profile, buildCurrent };
  }
  if (
    profile.kind !== "OPENAI_COMPAT" ||
    profile.ownerId === null ||
    embeddingFingerprint(profile) !== profile.fingerprint
  )
    throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
  try {
    assertLiveIdentity(await sqlAuthorityStore(query).loadIdentity(profile.ownerId));
  } catch (error) {
    if (error instanceof KbAdmissionError)
      throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
    throw error;
  }
  return { ...profile, buildCurrent: true };
}

/**
 * Worker-side routing. The Qwen embedder exists only in the worker (forked child);
 * without it (API server, dev without the guard) SYSTEM_BUILTIN is unavailable.
 */
export function selectIndexEmbedder(
  profile: { kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN"; ownerId: string | null },
  snapshot: Pick<HybridIndexBuildSnapshot, "providerId" | "revision">,
  options: { connectionString: string; masterKey: string | undefined; qwenEmbedder?: Embedder },
): Embedder {
  if (profile.kind === "SYSTEM_BUILTIN") {
    if (!options.qwenEmbedder) throw new EmbeddingUnavailableError();
    return options.qwenEmbedder;
  }
  if (profile.ownerId === null) throw new EmbeddingUnavailableError();
  return createProviderEmbedder(options, {
    providerId: snapshot.providerId,
    revision: snapshot.revision,
    ownerId: profile.ownerId,
  });
}

async function isBuiltinProvider(query: LockQuery, providerId: string): Promise<boolean> {
  const row = (
    await query<{ kind: string }>(`SELECT kind::text AS kind FROM embedding_provider WHERE id=$1`, [
      providerId,
    ])
  ).rows[0];
  return row?.kind === "SYSTEM_BUILTIN";
}

/**
 * Serve invariant, the one definition on the server. What serves a KB is the best
 * activatable generation in this preference order: its desired generation (what the configuration
 * asks for: semantic, or lexical when no usable profile is attached) > semantic@head >
 * lexical@head > the newest generation of an older commit. Ranks, as SQL over a generation `g`
 * and its KB `k`: 4 = desired, 3 = semantic of the head commit, 2 = lexical of the head commit,
 * 1 = any older commit. After a commit, the new head's lexical companion serves as soon as it completes and
 * stays until semantic@head activates; an older generation serves only while nothing of the head
 * is servable yet.
 *
 * Scheduling covers lexical@head whenever nothing of the head commit is active (`serveGapSql`);
 * any finished build activates when it outranks the active one (`outranksActiveSql`); search
 * falls back to the active generation's keyword arm.
 */
export const SERVE_LEXICAL_AT_HEAD = 2;
/**
 * One serving order, used for scheduling, preservation and activation:
 * desired@head (4) > semantic@head (3) > lexical@head (2) > an older commit (1),
 * ties broken by epoch (newer wins). "Desired" is the head build at the KB's
 * desired epoch: with the KB's current profile, or lexical when the
 * configuration asks for no (usable) profile.
 */
export function serveRankSql(g: string, k: string): string {
  return `(CASE WHEN ${g}."commitSha"<>${k}."headSha" THEN 1
    WHEN ${g}.epoch=${k}."desiredEpoch" AND (${g}."providerId" IS NULL
      OR (${g}."providerId"=${k}."profileProviderId" AND ${g}."providerVersion"=${k}."profileVersion")) THEN 4
    WHEN ${g}."providerId" IS NOT NULL THEN 3 ELSE 2 END)`;
}
/** `g` outranks whatever `k` serves now (nothing active is below everything). */
function outranksActiveSql(g: string, k: string): string {
  return `NOT EXISTS (SELECT 1 FROM index_generation a WHERE a.id=${k}."activeGenerationId"
    AND (${serveRankSql("a", k)}, a.epoch) >= (${serveRankSql(g, k)}, ${g}.epoch))`;
}
/** Nothing of the head commit is active: lexical@head must exist or be in flight. */
function serveGapSql(k: string): string {
  return `NOT EXISTS (SELECT 1 FROM index_generation a WHERE a.id=${k}."activeGenerationId"
    AND ${serveRankSql("a", k)}>=${SERVE_LEXICAL_AT_HEAD})`;
}
/** One PENDING lexical-only (FTS5) generation and its durable job at `epoch`. */
async function insertLexicalGeneration(
  query: LockQuery,
  kb: { kbId: string; epoch: string; commitSha: string; quantization: string },
) {
  const generationId = `g${randomUUID().replaceAll("-", "").slice(0, 23)}`;
  const jobId = randomUUID();
  const desired = indexBuildSnapshotSchema.parse({
    generationId,
    kbId: kb.kbId,
    epoch: kb.epoch,
    commitSha: kb.commitSha,
    quantization: kb.quantization,
    mode: "lexical",
  });
  await enqueueDurableJobOnQuery(query, {
    jobId,
    kind: "INDEX_KB",
    dedupKey: `index:${kb.kbId}:${kb.epoch}`,
    desired,
  });
  await query(
    `INSERT INTO index_generation (id,"kbId",epoch,"commitSha",attempt,state,"documentCount","chunkCount","jobId")
      VALUES ($1,$2,$3,$4,1,'PENDING',0,0,$5)`,
    [generationId, kb.kbId, kb.epoch, kb.commitSha, jobId],
  );
  return { generationId, jobId, state: "PENDING" as const };
}

/**
 * Called inside journal/control metadata finalize, before its receipt commits. No Redis IO.
 *
 * "always keep a lexical index" (`serveRankSql`): whenever nothing of the head commit is
 * active (no active generation, or any generation, hybrid included, of an older commit), a
 * semantic build is preceded by a cheap lexical-only generation of the same commit (one epoch
 * below the desired one) that activates as soon as it is built and serves until the semantic
 * one replaces it. An older active hybrid stays the vector-reuse source. A built-in profile that
 * is not build-current gets that lexical generation alone instead of no index of the head.
 */
export async function scheduleIndexBuild(query: LockQuery, kbId: string) {
  const kb = (
    await query<{
      epoch: string;
      commitSha: string;
      providerId: string | null;
      revision: number | null;
      quantization: string;
      lexicalGap: boolean;
    }>(
      `UPDATE knowledge_base k SET "desiredEpoch"=k."desiredEpoch"+1 WHERE k.id=$1 AND k.state='ACTIVE'
     RETURNING k."desiredEpoch"::text AS epoch,k."headSha" AS "commitSha",k."profileProviderId" AS "providerId",k."profileVersion" AS revision,
       lower(k."indexQuantization"::text) AS quantization,
       ${serveGapSql("k")} AS "lexicalGap"`,
      [kbId],
    )
  ).rows[0];
  if (!kb) throw new KbDomainError("CONFLICT", "Knowledge base unavailable");
  let profile: Awaited<ReturnType<typeof usableIndexProfile>> | null = null;
  if (kb.providerId && kb.revision !== null) {
    try {
      profile = await usableIndexProfile(query, kb.providerId, kb.revision, "build");
    } catch (error) {
      if (!(error instanceof KbDomainError) || error.code !== "INDEX_UNAVAILABLE") throw error;
      // A built-in profile that is not build-current (settings change, model loading or
      // disabled) is the built-in lifecycle's to rebuild; a generation of the head commit
      // keeps serving meanwhile, never replaced by a lexical one. Without one (a new commit
      // over an older hybrid included), lexical@head covers the head.
      if (await isBuiltinProvider(query, kb.providerId))
        return kb.lexicalGap ? insertLexicalGeneration(query, { kbId, ...kb }) : null;
    }
  }
  // No profile, or a user provider that can no longer embed (revoked, owner gone): an
  // FTS5-only generation, never fake vectors.
  if (!profile) return insertLexicalGeneration(query, { kbId, ...kb });
  let epoch = kb.epoch;
  if (kb.lexicalGap) {
    await insertLexicalGeneration(query, { kbId, ...kb });
    epoch = (
      await query<{ epoch: string }>(
        `UPDATE knowledge_base SET "desiredEpoch"="desiredEpoch"+1 WHERE id=$1
         RETURNING "desiredEpoch"::text AS epoch`,
        [kbId],
      )
    ).rows[0]!.epoch;
  }
  const generationId = `g${randomUUID().replaceAll("-", "").slice(0, 23)}`;
  const jobId = randomUUID();
  const desired = indexBuildSnapshotSchema.parse({
    generationId,
    kbId,
    epoch,
    commitSha: kb.commitSha,
    providerId: profile.providerId,
    revision: profile.revision,
    ownerId: profile.ownerId,
    dimensions: profile.dimensions,
    fingerprint: profile.fingerprint,
    quantization: kb.quantization,
  });
  await enqueueDurableJobOnQuery(query, {
    jobId,
    kind: "INDEX_KB",
    dedupKey: `index:${kbId}:${epoch}`,
    desired,
  });
  await query(
    `INSERT INTO index_generation (id,"kbId",epoch,"commitSha","providerId","providerVersion",fingerprint,dimensions,attempt,state,"documentCount","chunkCount","jobId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'PENDING',0,0,$9)`,
    [
      generationId,
      kbId,
      epoch,
      kb.commitSha,
      profile.providerId,
      profile.revision,
      profile.fingerprint,
      profile.dimensions,
      jobId,
    ],
  );
  return { generationId, jobId, state: "PENDING" as const };
}

/**
 * The fingerprint of the system built-in's CURRENT model and runtime
 * configuration (`kb_local_model`, defaults when unset). One definition for
 * `listSystemProviders` and the `builtin` alias: a switch back to an earlier
 * configuration reuses that configuration's older revision, so the newest
 * revision is not necessarily the current one.
 */
export async function currentBuiltinConfiguration(
  query: LockQuery,
): Promise<{ fingerprint: string; contextTokens: number | null }> {
  const model = (
    await query<{
      modelId: string;
      contextTokens: number;
      kvKeyType: string;
      kvValueType: string;
    }>(
      `SELECT "modelId", "contextTokens", "kvKeyType", "kvValueType" FROM kb_local_model WHERE id = $1`,
      [QWEN_ARTIFACT.modelId],
    )
  ).rows[0];
  const config = qwenRuntimeConfigSchema.safeParse(
    model
      ? {
          contextTokens: model.contextTokens,
          kvKeyType: model.kvKeyType,
          kvValueType: model.kvValueType,
        }
      : DEFAULT_QWEN_RUNTIME_CONFIG,
  );
  return {
    fingerprint: builtinEmbeddingFingerprint(
      builtinModel(model?.modelId ?? QWEN_MODEL.modelId),
      config.success ? config.data : DEFAULT_QWEN_RUNTIME_CONFIG,
    ),
    contextTokens: config.success ? config.data.contextTokens : null,
  };
}

/**
 * `builtin` names the system built-in provider: without a revision, the
 * revision of its CURRENT configuration (resolved by fingerprint inside the
 * caller's authority transaction, never the newest revision); a registered
 * provider always needs its exact revision.
 */
async function resolveProviderRef(
  query: LockQuery,
  input: { providerId: string; revision?: number | undefined },
): Promise<{ providerId: string; revision: number }> {
  if (input.providerId !== "builtin") {
    if (input.revision === undefined)
      throw invalidArgument("Provider revision required", "MISSING_ARGUMENT", "/revision");
    return { providerId: input.providerId, revision: input.revision };
  }
  if (input.revision !== undefined)
    return { providerId: SYSTEM_BUILTIN_PROVIDER_ID, revision: input.revision };
  const current = (
    await query<{ version: number }>(
      `SELECT version FROM provider_revision WHERE "providerId"=$1 AND fingerprint=$2
        ORDER BY version DESC LIMIT 1`,
      [SYSTEM_BUILTIN_PROVIDER_ID, (await currentBuiltinConfiguration(query)).fingerprint],
    )
  ).rows[0]?.version;
  if (current === undefined) throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
  return { providerId: SYSTEM_BUILTIN_PROVIDER_ID, revision: current };
}

/**
 * The usable profile a `profile_set` names, classified by one contract the
 * local store shares (docs/mcp.md):
 * - a provider the actor can't attach (unknown, revoked, or another user's)
 *   is NOT_FOUND, without saying which;
 * - a revision the provider never had, or one that is obsolete (a built-in
 *   revision of an earlier model configuration; an external revision that a
 *   newer one replaced and that is no longer usable), is CONFLICT
 *   `REVISION_NOT_CURRENT` on `/revision`: retrying can't help;
 * - the provider's current revision that is not usable yet (built-in model
 *   not READY or disabled, a probe pending or failing) stays the retryable
 *   INDEX_UNAVAILABLE outage.
 */
async function profileForSet(
  query: LockQuery,
  providerId: string,
  revision: number,
  userId: string,
) {
  const notCurrent = () =>
    reasonedConflict("Provider revision is not current", "REVISION_NOT_CURRENT", "/revision");
  // The built-in exists logically even before its registry row is created.
  if (providerId === SYSTEM_BUILTIN_PROVIDER_ID) {
    const { fingerprint } = await currentBuiltinConfiguration(query);
    const current = (
      await query<{ version: number | null }>(
        `SELECT max(version)::int AS version FROM provider_revision WHERE "providerId"=$1 AND fingerprint=$2`,
        [providerId, fingerprint],
      )
    ).rows[0]?.version;
    if (revision !== (current ?? 1)) throw notCurrent();
    if (current == null) throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
    return usableIndexProfile(query, providerId, revision, "build");
  }
  const known = (
    await query<{ fingerprint: string | null; latest: number }>(
      `SELECT
              (SELECT r.fingerprint FROM provider_revision r WHERE r."providerId"=p.id AND r.version=$3) AS fingerprint,
              (SELECT max(r.version) FROM provider_revision r WHERE r."providerId"=p.id)::int AS latest
         FROM embedding_provider p
        WHERE p.id=$1 AND p."revokedAt" IS NULL AND p."ownerId"=$2`,
      [providerId, userId, revision],
    )
  ).rows[0];
  if (!known) throw new KbDomainError("NOT_FOUND", "Provider not found");
  if (known.fingerprint === null) throw notCurrent();
  try {
    return await usableIndexProfile(query, providerId, revision, "build");
  } catch (error) {
    if (!(error instanceof KbDomainError) || error.code !== "INDEX_UNAVAILABLE") throw error;
    if (revision < known.latest) throw notCurrent();
    throw error;
  }
}

/**
 * The semantic generation already doing what a `profile_set` of this exact
 * profile would start: same provider, revision and fingerprint, of the head
 * commit at the desired epoch, and either the active COMPLETE one
 * (`CURRENT`) or still in flight (`PENDING`: an in-progress build whose
 * durable job is live, see `inProgressBuildSql`). A generation whose job
 * already failed or was cancelled is not work. A lexical generation never
 * counts, whatever the KB's freshness says.
 */
async function sameSemanticWork(
  query: LockQuery,
  kbId: string,
  profile: { providerId: string; revision: number; fingerprint: string },
): Promise<{ generationId: string; jobId: string; state: "PENDING" | "CURRENT" } | null> {
  const row = (
    await query<{ generationId: string; jobId: string; active: boolean }>(
      `SELECT g.id AS "generationId", g."jobId", (g.state='COMPLETE') AS active
         FROM knowledge_base k JOIN index_generation g ON g."kbId"=k.id
         JOIN durable_job j ON j.id=g."jobId"
        WHERE k.id=$1 AND k.state='ACTIVE'
          AND k."profileProviderId"=$2 AND k."profileVersion"=$3
          AND g."providerId"=$2 AND g."providerVersion"=$3 AND g.fingerprint=$4
          AND g."commitSha"=k."headSha" AND g.epoch=k."desiredEpoch"
          AND ((g.state='COMPLETE' AND k."activeGenerationId"=g.id)
            OR ${inProgressBuildSql("g", "j")})
        ORDER BY (g.state='COMPLETE') DESC LIMIT 1`,
      [kbId, profile.providerId, profile.revision, profile.fingerprint],
    )
  ).rows[0];
  if (!row) return null;
  return {
    generationId: row.generationId,
    jobId: row.jobId,
    state: row.active ? "CURRENT" : "PENDING",
  };
}

export async function requestIndexBuild(
  runtime: KbRuntimeConfig,
  actor: IndexActor,
  raw: {
    kbId: string;
    idempotencyKey: string;
    confirm: "RUN";
    providerId?: string;
    revision?: number;
  },
) {
  const profileInput =
    raw.providerId === undefined
      ? null
      : kbWriteToolSchemas.knowledge_embedding_profile_set.input.parse(raw);
  if (profileInput) profileInput.providerId = canonicalProviderRef(profileInput.providerId);
  const input = profileInput ?? kbWriteToolSchemas.knowledge_index_rebuild.input.parse(raw);
  const operation = profileInput ? "INDEX_PROFILE_SET" : "INDEX_REBUILD";
  const actorKey = actorKeyFor(actor.principal);
  const requestHash = canonicalRequestHash(input);
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        const auth = await authorize({
          ...actor,
          kbId: input.kbId,
          operation: "manage",
          store: sqlAuthorityStore(query),
          query,
        });
        if (auth.state !== "ACTIVE")
          throw new KbDomainError("CONFLICT", "Knowledge base unavailable");
        const prior = await findFinalizedReceiptForUpdate(query, {
          actorKey,
          kbId: input.kbId,
          operation,
          idempotencyKey: input.idempotencyKey,
        });
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
          return (
            profileInput
              ? kbWriteToolSchemas.knowledge_embedding_profile_set.output
              : kbWriteToolSchemas.knowledge_index_rebuild.output
          ).parse(prior.responseBody);
        }
        let response: z.infer<
          typeof kbWriteToolSchemas.knowledge_embedding_profile_set.output
        > | null = null;
        if (profileInput) {
          const { providerId, revision } = await resolveProviderRef(query, profileInput);
          // The READY system model is attachable by any manager; user providers
          // only by their owner (anyone else's is NOT_FOUND, see profileForSet).
          const profile = await profileForSet(query, providerId, revision, actor.principal.userId);
          // Re-attaching the profile a semantic generation of the head already
          // serves (or is building) at the desired epoch starts nothing (R3-L12).
          const same = await sameSemanticWork(query, input.kbId, profile);
          if (same) response = { operationId: randomUUID(), ...same };
          else
            await query(
              `UPDATE knowledge_base SET "profileProviderId"=$2,"profileVersion"=$3 WHERE id=$1`,
              [input.kbId, providerId, revision],
            );
        }
        if (!response) {
          await chargeRate(runtime.ratePort, { kind: "rebuild", key: input.kbId });
          const build = await scheduleIndexBuild(query, input.kbId);
          if (!build) throw new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable");
          response = { operationId: randomUUID(), ...build };
        }
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
          kbId: input.kbId,
          actorKey,
          actorUserIdSnapshot: actor.principal.userId,
          actorUserId: actor.principal.userId,
          action: operation === "INDEX_PROFILE_SET" ? "provider_attach" : "generation_retry",
          outcome: "SUCCESS",
        });
        return response;
      }),
  });
}

/** Generation fence BEFORE job row. All build writes and accounting run in this transaction. */
export async function fenceIndexAttempt(
  query: LockQuery,
  snapshot: IndexBuildSnapshot,
  attempt: IndexAttempt,
) {
  await query("SELECT public.kb_lock_generation($1)", [snapshot.generationId]);
  const row = await query(
    `SELECT j.id FROM durable_job j JOIN index_generation g ON g."jobId"=j.id
    WHERE j.id=$1 AND j."workerOwner"=$2 AND j."attemptEpoch"=$3 AND j.state='RUNNING'
      AND j."cancelledAt" IS NULL AND j."leaseUntil">clock_timestamp() AND g.id=$4
    FOR UPDATE OF j`,
    [attempt.jobId, attempt.workerId, attempt.epoch, snapshot.generationId],
  );
  if (row.rowCount !== 1) throw new DurableJobFenceError();
}

/**
 * Which unfinished index builds to cancel. Each scope is one of the four canceller predicates,
 * with that caller's own job-state exclusion list.
 */
export type IndexBuildCancelScope =
  | { kbId: string }
  | { providerOwnerId: string; providerId: string | null }
  | { generationId: string }
  | { builtinFingerprintNot: string };

function cancelScopeSql(scope: IndexBuildCancelScope): {
  join: string;
  where: string;
  values: unknown[];
} {
  if ("kbId" in scope)
    return {
      join: "",
      where: `g."kbId"=$1 AND j.state NOT IN ('COMPLETE','CANCELLED')`,
      values: [scope.kbId],
    };
  if ("providerOwnerId" in scope)
    return {
      join: `JOIN embedding_provider p ON p.id=g."providerId"`,
      where: `p."ownerId"=$1 AND ($2::text IS NULL OR p.id=$2) AND j.state NOT IN ('COMPLETE','CANCELLED')`,
      values: [scope.providerOwnerId, scope.providerId],
    };
  if ("generationId" in scope)
    return {
      join: "",
      where: `g.id=$1 AND j.state NOT IN ('COMPLETE','CANCELLED')`,
      values: [scope.generationId],
    };
  return {
    join: `JOIN embedding_provider p ON p.id=g."providerId"`,
    where: `p.kind='SYSTEM_BUILTIN' AND g.fingerprint<>$1 AND ${inProgressBuildSql("g", "j")}`,
    values: [scope.builtinFingerprintNot],
  };
}

/**
 * The only index-build canceller (§1.8 (d)); runs on the caller's authority transaction, which
 * serializes it with every worker fenced/activation transaction. It locks the jobs, reads the
 * generations' reservation ids fresh, releases them, then cancels; it never takes the
 * generation advisory lock and never writes `index_generation` (the RELEASED ids stay as
 * references until the backstop clears them). Returns the cancelled job ids.
 */
export async function cancelIndexBuildJobs(
  query: LockQuery,
  scope: IndexBuildCancelScope,
): Promise<string[]> {
  const isolation = (
    await query<{ isolation: string }>(
      "SELECT current_setting('transaction_isolation') AS isolation",
    )
  ).rows[0]?.isolation;
  if (isolation !== "read committed")
    throw new Error("Index build cancellation requires READ COMMITTED");
  const { join, where, values } = cancelScopeSql(scope);
  const jobs = (
    await query<{ id: string }>(
      `SELECT j.id FROM durable_job j JOIN index_generation g ON g."jobId"=j.id ${join}
      WHERE ${where} ORDER BY j.id FOR NO KEY UPDATE OF j`,
      values,
    )
  ).rows.map((row) => row.id);
  if (jobs.length === 0) return [];
  const ids = (
    await query<{ quotaReservationIds: string[] }>(
      `SELECT "quotaReservationIds" FROM index_generation WHERE "jobId" = ANY($1::text[])`,
      [jobs],
    )
  ).rows.flatMap((row) => row.quotaReservationIds);
  if (ids.length > 0) await releaseQuota({ transactionQuery: query }, [...new Set(ids)]);
  await query(
    `UPDATE durable_job SET state='CANCELLED',"cancelledAt"=now(),"updatedAt"=now(),"workerOwner"=NULL,
      "leaseUntil"=NULL,"dispatchOwner"=NULL,"dispatchClaimUntil"=NULL WHERE id = ANY($1::text[])`,
    [jobs],
  );
  return jobs;
}

/** Lifecycle registry calls this within its authority transaction. Rows remain for history. */
export async function cancelIndexBuilds(query: LockQuery, kbId: string) {
  await cancelIndexBuildJobs(query, { kbId });
}

/**
 * Authority transaction. Every COMPLETE generation of this KB that is no longer its active pointer
 * becomes SUPERSEDED. The SQL guard still refuses a generation any KB points at, and
 * SUPERSEDED rows stay readable for queries whose lease predates the switch.
 */
export async function supersedeInactiveGenerations(query: LockQuery, kbId: string) {
  await query(
    `UPDATE index_generation g SET state='SUPERSEDED' WHERE g."kbId"=$1 AND g.state='COMPLETE'
    AND NOT EXISTS (SELECT FROM knowledge_base k WHERE k."activeGenerationId"=g.id)`,
    [kbId],
  );
}

/** Authority transaction + current attempt required; old completions never replace a newer desired epoch. */
export async function activateIndexBuild(
  query: LockQuery,
  snapshot: IndexBuildSnapshot,
  attempt: IndexAttempt,
) {
  await fenceIndexAttempt(query, snapshot, attempt);
  const lexical = isLexicalSnapshot(snapshot);
  // One order decides: the build serves when it outranks what serves now
  // (`serveRankSql`), e.g. lexical@head over an older commit, or a newer older
  // commit over an older fallback while nothing of the head is ready.
  const kb = (
    await query<{ current: boolean; desired: boolean }>(
      `SELECT (k.state='ACTIVE' AND ${outranksActiveSql("g", "k")}) AS current,
              (${serveRankSql("g", "k")}=4) AS desired
         FROM knowledge_base k JOIN index_generation g ON g.id=$2 AND g."kbId"=k.id
        WHERE k.id=$1 FOR UPDATE OF k`,
      [snapshot.kbId, snapshot.generationId],
    )
  ).rows[0];
  let usable = lexical;
  if (!lexical) {
    try {
      await usableIndexProfile(query, snapshot.providerId, snapshot.revision, "build");
      usable = true;
    } catch (error) {
      if (!(error instanceof KbDomainError)) throw error;
    }
  }
  // Still-desired work whose profile is momentarily unusable (e.g. the built-in
  // disabled) is an attempt failure: the durable job retries it, never a
  // terminal verdict on the generation. Anything else unusable never serves.
  if (kb?.current && kb.desired && !usable)
    throw new KbDomainError("INDEX_UNAVAILABLE", "Profile unusable");
  const current = Boolean(kb?.current && usable);
  const state = current ? "COMPLETE" : "SUPERSEDED";
  const changed = await query(
    `UPDATE index_generation SET state=$3::"IndexGenerationState","errorCode"=NULL WHERE id=$1 AND attempt=$2 AND state='INDEXING'`,
    [snapshot.generationId, attempt.epoch, state],
  );
  if (changed.rowCount !== 1) throw new DurableJobFenceError();
  if (state === "COMPLETE") {
    await query(`UPDATE knowledge_base SET "activeGenerationId"=$2 WHERE id=$1`, [
      snapshot.kbId,
      snapshot.generationId,
    ]);
    // Same CAS transaction: the pointer moved first, so the guard permits COMPLETE->SUPERSEDED.
    await supersedeInactiveGenerations(query, snapshot.kbId);
  }
  await query(
    `UPDATE durable_job SET state='COMPLETE',"completedAt"=now(),"workerOwner"=NULL,"leaseUntil"=NULL WHERE id=$1`,
    [attempt.jobId],
  );
  await recordAuditEvent(query, {
    opId: attempt.jobId,
    action: "generation_activate",
    outcome: "SUCCESS",
    ...buildActor(snapshot),
    kbId: snapshot.kbId,
    revision: snapshot.commitSha,
    metadata: { reasonCode: state },
  });
  return state;
}
