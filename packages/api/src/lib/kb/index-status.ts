import { randomUUID } from "node:crypto";
import {
  type IndexRebuildReason,
  type IndexState,
  type IndexStatus,
  isLexicalOnlyReason,
} from "./attachment";
import { inProgressBuildSql, LIVE_JOB_STATES } from "./build-liveness";
import { builtinModel, QWEN_MODEL } from "./builtin-model";
import { KbDomainError } from "./errors";
import { builtinEmbeddingFingerprint, builtinModelIdentity } from "./fingerprint";
import type { IndexActor } from "./generations";
import { usableIndexProfile } from "./generations";
import type { LockQuery } from "./lock";
import { QWEN_ARTIFACT } from "./model-artifact";
import { authorize, sqlAuthorityStore } from "./permissions";
import type { IndexNotice } from "./protocol/common";
import { qwenRuntimeConfigSchema } from "./qwen-runtime-config";
import type { KbRuntimeConfig } from "./runtime";

type StatusRow = {
  activeGenerationId: string | null;
  desiredGenerationId: string | null;
  desiredEpoch: string;
  activeState: IndexState | null;
  desiredState: IndexState | "PURGED" | null;
  indexedCommitSha: string | null;
  headSha: string;
  dimensions: number | null;
  fingerprint: string | null;
  errorCode: string | null;
  activeProviderId: string | null;
  activeVersion: number | null;
  profileProviderId: string | null;
  profileVersion: number | null;
  jobState: string | null;
};
/**
 * Effective query availability, the one predicate search admission uses: can this profile
 * embed a query right now? Not while a built-in runtime is reloading under an exclusive probe claim or serves another model (a lexical-only
 * reason), nor when the profile is unusable (disabled, revoked, owner gone, unready).
 */
export async function queryAvailability(
  query: LockQuery,
  providerId: string,
  revision: number,
): Promise<
  | { available: true; profile: Awaited<ReturnType<typeof usableIndexProfile>> }
  | { available: false; reason: "PROFILE_UNUSABLE" | IndexRebuildReason }
> {
  const rebuild = await qwenRebuildReason(query, providerId, revision);
  if (isLexicalOnlyReason(rebuild)) return { available: false, reason: rebuild! };
  try {
    return {
      available: true,
      profile: await usableIndexProfile(query, providerId, revision, "query"),
    };
  } catch (error) {
    if (error instanceof KbDomainError && error.code === "INDEX_UNAVAILABLE")
      return { available: false, reason: "PROFILE_UNUSABLE" };
    throw error;
  }
}

/**
 * Freshness of the generation a reply actually served, from the status read with it: the KB's
 * status for its active generation; a retained non-active one (a cursor pin) is stale, under the
 * failed > building precedence.
 */
export function servedFreshness(
  index: Pick<IndexStatus, "activeGenerationId" | "freshness">,
  generationId: string,
): IndexStatus["freshness"] {
  if (generationId === index.activeGenerationId) return index.freshness;
  return index.freshness === "failed" || index.freshness === "building" ? index.freshness : "stale";
}

export function projectIndexStatus(
  row: StatusRow,
  usable: boolean,
  rebuildPending: IndexRebuildReason | null = null,
): IndexStatus {
  const {
    activeGenerationId,
    desiredGenerationId,
    desiredEpoch,
    activeState,
    indexedCommitSha,
    headSha,
    dimensions,
    fingerprint,
  } = row;
  // PURGED is an internal storage tombstone. The permanent job still identifies
  // the build's lifecycle outcome; retention must not change the closed wire enum.
  const desiredState =
    row.desiredState === "PURGED"
      ? ["FAILED", "CANCELLED"].includes(row.jobState ?? "")
        ? "FAILED"
        : "SUPERSEDED"
      : row.desiredState;
  const failed = desiredState === "FAILED" || row.jobState === "FAILED";
  const building = (LIVE_JOB_STATES as readonly string[]).includes(row.jobState ?? "");
  return {
    activeGenerationId,
    desiredGenerationId,
    desiredEpoch,
    activeState,
    desiredState,
    indexedCommitSha,
    headSha,
    dimensions,
    fingerprint,
    freshness:
      activeGenerationId && !usable
        ? "unavailable"
        : failed
          ? "failed"
          : building
            ? "building"
            : !usable
              ? "unavailable"
              : indexedCommitSha !== headSha
                ? "stale"
                : "current",
    errorCode:
      activeGenerationId && !usable
        ? "INDEX_UNAVAILABLE"
        : failed
          ? "INDEX_BUILD_FAILED"
          : !usable && !building
            ? "INDEX_UNAVAILABLE"
            : null,
    rebuildPending,
  };
}

/**
 * Why a SYSTEM_BUILTIN active generation awaits re-embedding, or null. Only
 * meaningful while the model is READY (otherwise the index is simply unavailable).
 */
export async function qwenRebuildReason(
  query: LockQuery,
  providerId: string,
  revision: number,
): Promise<IndexRebuildReason | null> {
  const row = (
    await query<{
      activeModelId?: string;
      fingerprint: string;
      modelIdentity: string | null;
      contextTokens: number;
      kvKeyType: string;
      kvValueType: string;
      reloading: boolean;
    }>(
      `SELECT m."modelId" AS "activeModelId", r.fingerprint, r."modelIdentity", m."contextTokens", m."kvKeyType", m."kvValueType",
              COALESCE(m."probeMode" = 'EXCLUSIVE' AND m."probeLeaseUntil" > clock_timestamp(), false)
                AS reloading
         FROM provider_revision r JOIN embedding_provider p ON p.id = r."providerId"
         JOIN kb_local_model m ON m.id = $3 AND m.state = 'READY'
        WHERE r."providerId" = $1 AND r.version = $2 AND p.kind = 'SYSTEM_BUILTIN'`,
      [providerId, revision, QWEN_ARTIFACT.modelId],
    )
  ).rows[0];
  if (!row) return null;
  const model = builtinModel(row.activeModelId ?? QWEN_MODEL.modelId);
  if (row.modelIdentity !== builtinModelIdentity(model)) return "EMBEDDING_MODEL_CHANGED";
  // Stop-then-probe: no child serves query vectors while the claim is live.
  if (row.reloading) return "EMBEDDING_RUNTIME_RELOADING";
  const config = qwenRuntimeConfigSchema.safeParse({
    contextTokens: row.contextTokens,
    kvKeyType: row.kvKeyType,
    kvValueType: row.kvValueType,
  });
  if (!config.success) return null;
  return row.fingerprint === builtinEmbeddingFingerprint(model, config.data)
    ? null
    : "EMBEDDING_SETTINGS_CHANGED";
}

/**
 * Why a KB is searched over a lexical-only generation, as its search notice. Read under
 * the caller's lock: no profile at all, a revoked provider, a hybrid build still running for
 * the desired epoch, or any other unusable profile.
 */
export async function lexicalNoticeFor(query: LockQuery, kbId: string): Promise<IndexNotice> {
  const row = (
    await query<{ providerId: string | null; revoked: boolean | null; building: boolean }>(
      `SELECT k."profileProviderId" AS "providerId",(p."revokedAt" IS NOT NULL) AS revoked,
              EXISTS (SELECT 1 FROM index_generation g JOIN durable_job j ON j.id=g."jobId"
                       WHERE g."kbId"=k.id AND g.epoch=k."desiredEpoch" AND g."providerId" IS NOT NULL
                         AND ${inProgressBuildSql("g", "j")}) AS building
         FROM knowledge_base k LEFT JOIN embedding_provider p ON p.id=k."profileProviderId"
        WHERE k.id=$1`,
      [kbId],
    )
  ).rows[0];
  const detail = !row?.providerId
    ? "NO_EMBEDDING_PROFILE"
    : row.revoked
      ? "EMBEDDING_PROFILE_REVOKED"
      : // A healthy profile whose hybrid build is still running is not failing.
        row.building
        ? "SEMANTIC_INDEX_BUILDING"
        : "EMBEDDING_PROFILE_UNAVAILABLE";
  return { kbId, code: "LEXICAL_ONLY", detail };
}

/**
 * The notice of a hybrid generation searched over its FTS5 arm because its profile cannot
 * embed queries now or the query embedding failed: a revoked provider says so, anything else is
 * the model erroring (unavailable).
 */
export async function fallbackNoticeFor(
  query: LockQuery,
  kbId: string,
  providerId: string,
): Promise<IndexNotice> {
  const row = (
    await query<{ revoked: boolean }>(
      `SELECT ("revokedAt" IS NOT NULL) AS revoked FROM embedding_provider WHERE id=$1`,
      [providerId],
    )
  ).rows[0];
  return {
    kbId,
    code: "LEXICAL_ONLY",
    detail: row?.revoked ? "EMBEDDING_PROFILE_REVOKED" : "EMBEDDING_PROFILE_UNAVAILABLE",
  };
}

export async function loadIndexStatus(query: LockQuery, kbId: string) {
  const row = (
    await query<StatusRow>(
      `SELECT k."activeGenerationId",g.id AS "desiredGenerationId",k."desiredEpoch"::text,
    a.state AS "activeState",g.state AS "desiredState",a."commitSha" AS "indexedCommitSha",k."headSha",a.dimensions,a.fingerprint,g."errorCode",
    a."providerId" AS "activeProviderId",a."providerVersion" AS "activeVersion",k."profileProviderId",k."profileVersion",j.state AS "jobState"
    FROM knowledge_base k LEFT JOIN index_generation a ON a.id=k."activeGenerationId"
    LEFT JOIN index_generation g ON g."kbId"=k.id AND g.epoch=k."desiredEpoch"
    LEFT JOIN durable_job j ON j.id=g."jobId" WHERE k.id=$1`,
      [kbId],
    )
  ).rows[0];
  if (!row) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  let usable = false;
  let rebuildPending: IndexRebuildReason | null = null;
  // A lexical-only generation pins no profile: it serves whenever it is COMPLETE.
  if (row.activeGenerationId && row.activeProviderId === null && row.activeState === "COMPLETE")
    usable = true;
  else if (row.activeProviderId && row.activeVersion !== null && row.activeState === "COMPLETE") {
    // A COMPLETE hybrid generation always serves: semantically while its profile can embed
    // queries (an index built under previous built-in settings keeps serving until its
    // re-embedding lands), otherwise over its FTS5 arm with a LEXICAL_ONLY notice.
    usable = true;
    rebuildPending = await qwenRebuildReason(query, row.activeProviderId, row.activeVersion);
  }
  let profile = null;
  if (row.profileProviderId && row.profileVersion !== null) {
    const p = (
      await query<{
        providerId: string;
        revision: number;
        kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN";
        name: string;
        model: string;
        dimensions: number;
        contextTokens: number | null;
        status: "ready" | "revoked" | "unavailable";
      }>(
        `SELECT p.id AS "providerId",r.version AS revision,p.kind,p.name,r.model,r.dimensions,
       (SELECT m."contextTokens" FROM kb_local_model m WHERE m.id=$3 AND p.kind='SYSTEM_BUILTIN') AS "contextTokens",
       CASE WHEN p."revokedAt" IS NOT NULL THEN 'revoked' ELSE 'ready' END AS status
       FROM embedding_provider p JOIN provider_revision r ON r."providerId"=p.id JOIN durable_job j ON j.id=r."jobId" WHERE p.id=$1 AND r.version=$2`,
        [row.profileProviderId, row.profileVersion, QWEN_ARTIFACT.modelId],
      )
    ).rows[0];
    profile = p ?? null;
    // usableIndexProfile is the only eligibility rule (both kinds); it downgrades "ready".
    if (profile?.status === "ready") {
      try {
        await usableIndexProfile(query, profile.providerId, profile.revision, "build");
      } catch (error) {
        if (!(error instanceof KbDomainError)) throw error;
        profile.status = "unavailable";
      }
    }
  }
  return { profile, index: projectIndexStatus(row, usable, rebuildPending) };
}

export function getIndexProfile(runtime: KbRuntimeConfig, actor: IndexActor, kbId: string) {
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        await authorize({
          ...actor,
          kbId,
          operation: "read",
          store: sqlAuthorityStore(query),
          query,
        });
        return loadIndexStatus(query, kbId);
      }),
  });
}
