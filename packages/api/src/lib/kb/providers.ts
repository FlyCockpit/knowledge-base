import { createHmac, randomUUID } from "node:crypto";
import type { Prisma } from "@knowledge-base/db/client";
import { z } from "zod";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../pagination";
import { recordAuditEvent } from "./audit";
import { canonicalizeHttpsEndpointUrl } from "./egress";
import { type EmbeddingFailureReason, parseProbeFailure } from "./embed-client";
import { encryptKbSecret, requireKbMasterKey } from "./envelope";
import { KbDomainError } from "./errors";
import { embeddingFingerprint } from "./fingerprint";
import {
  cancelIndexBuildJobs,
  currentBuiltinConfiguration,
  scheduleIndexBuild,
  usableIndexProfile,
} from "./generations";
import { EXPIRED_LEASE_ERROR, enqueueDurableJobOnQuery } from "./jobs";
import { chargeRate, KB_LIMITS } from "./limits";
import { SYSTEM_BUILTIN_PROVIDER_ID } from "./local-model";
import type { LockQuery } from "./lock";
import { sqlAuthorityStore } from "./permissions";
import { assertLiveIdentity } from "./principal";
import { providerSummarySchema } from "./protocol/common";
import type { KbRuntimeConfig } from "./runtime";

const id = z.string().regex(/^[a-z0-9]{24}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const configuration = {
  endpointUrl: z.string().min(1).max(2048),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !value.includes("\0")),
  dimensions: z.number().int().min(1).max(2000),
  apiKey: z
    .string()
    .min(1)
    .max(16384)
    .regex(/^[\x21-\x7e]+$/),
  idempotencyKey: key,
};
export const providerCreateInput = z.strictObject({
  ...configuration,
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => !value.includes("\0")),
});
export const providerProbeInput = z.strictObject({ ...configuration, providerId: id });
export const providerRevokeInput = z.strictObject({ providerId: id });
type ProviderRuntime = Pick<KbRuntimeConfig, "coordinator" | "prisma" | "ratePort">;
type Summary = z.infer<typeof providerSummarySchema>;

const summarySelect = {
  id: true,
  createdAt: true,
  name: true,
  kind: true,
  revokedAt: true,
  revisions: {
    orderBy: { version: "desc" },
    take: 1,
    select: {
      version: true,
      model: true,
      dimensions: true,
      job: { select: { state: true, lastError: true } },
    },
  },
} satisfies Prisma.EmbeddingProviderSelect;

/**
 * A provider probe that makes no progress for this long is stuck (no worker,
 * lost dispatch, a wedged attempt). One initial 10 s HTTP attempt plus five
 * retries and 31 s of backoff fits this window. A running attempt advances
 * lastHeartbeatAt;
 * a new/retried attempt sets nextRunAt. Dispatch metadata cannot advance the
 * non-progress clock.
 */
export const PROVIDER_PROBE_STALL_MS = 120_000;
/** `lastError` of a probe the owner's read timed out (terminal FAILED). */
export const PROVIDER_PROBE_TIMEOUT_ERROR = "probe timed out";

export type ProviderProbeState = {
  state: "pending" | "ready" | "failed" | "timeout";
  /** Stable reason code for a terminal failure; never provider/raw error text. */
  reason: "provider_error" | "worker_lost" | "cancelled" | "timeout" | null;
  /**
   * What the provider request itself did on the last failed attempt (stable
   * codes and protocol numbers only): the cause of a terminal `provider_error`,
   * or, while still pending, why the probe is retrying.
   */
  failure: EmbeddingFailureReason | null;
};

/** The latest revision's probe as the owner sees it: pending, or terminal with a reason. */
export function providerProbeState(job: {
  state: string;
  lastError: string | null;
}): ProviderProbeState {
  const failure = parseProbeFailure(job.lastError);
  switch (job.state) {
    case "COMPLETE":
      return { state: "ready", reason: null, failure: null };
    case "CANCELLED":
      return { state: "failed", reason: "cancelled", failure: null };
    case "FAILED":
      if (job.lastError === PROVIDER_PROBE_TIMEOUT_ERROR)
        return { state: "timeout", reason: "timeout", failure: null };
      return {
        state: "failed",
        reason: job.lastError === EXPIRED_LEASE_ERROR ? "worker_lost" : "provider_error",
        failure,
      };
    default:
      return { state: "pending", reason: null, failure };
  }
}

/**
 * Makes the owner's stuck probes terminal: a non-terminal PROVIDER_PROBE job
 * with no progress for PROVIDER_PROBE_STALL_MS becomes FAILED with the timeout
 * reason. Progress is a worker heartbeat, or the due time of a new/retried
 * attempt. Dispatch claims/publication only update scheduling metadata and
 * must not renew this clock. The attempt epoch is bumped and claims cleared,
 * so a late worker can neither claim it (claims need PUBLISHED) nor complete
 * it (completion is fenced on epoch + RUNNING): a timed-out probe never later
 * turns into "ready". Returns the number of probes timed out.
 */
export async function expireStalledProviderProbes(
  prisma: Pick<ProviderRuntime["prisma"], "$executeRaw">,
  userId: string,
  stallMs = PROVIDER_PROBE_STALL_MS,
): Promise<number> {
  return prisma.$executeRaw`
    UPDATE durable_job j
       SET state = 'FAILED',
           "lastError" = ${PROVIDER_PROBE_TIMEOUT_ERROR},
           "attemptEpoch" = j."attemptEpoch" + 1,
           "workerOwner" = NULL,
           "leaseUntil" = NULL,
           "lastHeartbeatAt" = NULL,
           "dispatchOwner" = NULL,
           "dispatchClaimUntil" = NULL,
           "updatedAt" = now()
      FROM provider_revision r
      JOIN embedding_provider p ON p.id = r."providerId"
     WHERE j.id = r."jobId"
       AND p."ownerId" = ${userId}
       AND j.kind = 'PROVIDER_PROBE'
       AND j.state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRY')
       AND COALESCE(j."lastHeartbeatAt", j."nextRunAt") < ${new Date(Date.now() - stallMs)}`;
}

function publicSummary(
  row: Prisma.EmbeddingProviderGetPayload<{ select: typeof summarySelect }>,
): Summary {
  const revision = row.revisions[0];
  if (!revision) throw new KbDomainError("INTERNAL", "Provider unavailable");
  return {
    providerId: row.id,
    revision: revision.version,
    kind: row.kind,
    name: row.name,
    model: revision.model,
    dimensions: revision.dimensions,
    contextTokens: null,
    status: row.revokedAt ? "revoked" : revision.job.state === "COMPLETE" ? "ready" : "unavailable",
  };
}

/** All human operations, including reads/replays, join the authority lock and live identity gate. */
function asOwner<T>(
  runtime: ProviderRuntime,
  userId: string,
  run: (query: LockQuery) => Promise<T>,
): Promise<T> {
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        assertLiveIdentity(await sqlAuthorityStore(query).loadIdentity(userId));
        return run(query);
      }),
  });
}

export async function listMyProviders(
  runtime: ProviderRuntime,
  userId: string,
  input: z.input<typeof cursorPageInput> = {},
) {
  const pageInput = cursorPageInput.parse(input);
  return asOwner(runtime, userId, async () => {
    // Reading the list is what bounds a stuck probe: it becomes terminal here.
    await expireStalledProviderProbes(runtime.prisma, userId);
    const rows = await runtime.prisma.embeddingProvider.findMany({
      where: withCursor({ ownerId: userId }, "createdAt", pageInput.cursor, "desc"),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageTake(pageInput.limit),
      select: summarySelect,
    });
    const page = cursorPage(rows, pageInput.limit, "createdAt");
    return {
      items: page.items.map((row) => ({
        ...publicSummary(row),
        probe: providerProbeState(row.revisions[0]!.job),
      })),
      nextCursor: page.nextCursor,
    };
  });
}

/**
 * Built-in system providers every signed-in user may attach to a KB they manage.
 * Bounded by construction: the single SYSTEM_BUILTIN provider, one revision: the one
 * for the CURRENT admin runtime config, else the latest.
 * `ready` is decided by the same `usableIndexProfile` rule attach/build/query use
 * (READY model = verified artifact + verified runtime, current fingerprint).
 */
export async function listSystemProviders(
  runtime: ProviderRuntime,
  userId: string,
): Promise<{ items: Summary[] }> {
  return asOwner(runtime, userId, async (query) => {
    const { fingerprint: current, contextTokens } = await currentBuiltinConfiguration(query);
    const rows = await query<{
      providerId: string;
      revision: number;
      name: string;
      model: string;
      dimensions: number;
      revoked: boolean;
    }>(
      `SELECT p.id AS "providerId", r.version AS revision, p.name, r.model, r.dimensions,
              (p."revokedAt" IS NOT NULL) AS revoked
         FROM embedding_provider p JOIN provider_revision r ON r."providerId" = p.id
        WHERE p.id = $1 AND p.kind = 'SYSTEM_BUILTIN' AND p."ownerId" IS NULL
        ORDER BY (r.fingerprint = $2) DESC, r.version DESC LIMIT 1`,
      [SYSTEM_BUILTIN_PROVIDER_ID, current],
    );
    const row = rows.rows[0];
    if (!row) return { items: [] };
    let status: Summary["status"] = row.revoked ? "revoked" : "unavailable";
    if (!row.revoked) {
      try {
        await usableIndexProfile(query, row.providerId, row.revision, "build");
        status = "ready";
      } catch (error) {
        if (!(error instanceof KbDomainError)) throw error;
      }
    }
    return {
      items: [
        {
          providerId: row.providerId,
          revision: row.revision,
          kind: "SYSTEM_BUILTIN",
          name: row.name,
          model: row.model,
          dimensions: row.dimensions,
          contextTokens,
          status,
        },
      ],
    };
  });
}

export async function createProvider(
  runtime: ProviderRuntime,
  userId: string,
  raw: z.input<typeof providerCreateInput>,
  masterKey: string | undefined,
) {
  return registerRevision(runtime, userId, providerCreateInput.parse(raw), masterKey);
}
export async function probeProvider(
  runtime: ProviderRuntime,
  userId: string,
  raw: z.input<typeof providerProbeInput>,
  masterKey: string | undefined,
) {
  return registerRevision(runtime, userId, providerProbeInput.parse(raw), masterKey);
}

async function registerRevision(
  runtime: ProviderRuntime,
  userId: string,
  input: z.infer<typeof providerCreateInput> | z.infer<typeof providerProbeInput>,
  keyValue: string | undefined,
): Promise<{ provider: Summary; jobId: string }> {
  const masterKey = requireKbMasterKey(keyValue);
  let endpointUrl: string;
  try {
    endpointUrl = canonicalizeHttpsEndpointUrl(input.endpointUrl);
  } catch {
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid provider endpoint");
  }
  // A keyed receipt digest detects changed credentials without making the key part of the
  // public/index fingerprint or storing an offline dictionary oracle for low-entropy keys.
  const requestHash = createHmac("sha256", masterKey)
    .update(
      JSON.stringify([
        "kb/provider-request/1",
        userId,
        "providerId" in input ? input.providerId : input.name,
        "providerId" in input ? "probe" : "create",
        endpointUrl,
        input.model,
        input.dimensions,
        input.apiKey,
      ]),
    )
    .digest("hex");
  try {
    return await asOwner(runtime, userId, async (query) => {
      const replay = await query<{
        providerId: string;
        version: number;
        jobId: string;
        requestHash: string;
      }>(
        `SELECT "providerId", version, "jobId", "requestHash" FROM provider_revision WHERE "ownerSnapshot"=$1 AND "idempotencyKey"=$2`,
        [userId, input.idempotencyKey],
      );
      const prior = replay.rows[0];
      if (prior && prior.requestHash !== requestHash)
        throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
      const providerId =
        prior?.providerId ??
        ("providerId" in input
          ? input.providerId
          : `p${randomUUID().replaceAll("-", "").slice(0, 23)}`);
      const creating = !("providerId" in input) && !prior;
      if (!creating) {
        const owned = await query<{ id: string }>(
          `SELECT id FROM embedding_provider WHERE id=$1 AND "ownerId"=$2 AND "revokedAt" IS NULL`,
          [providerId, userId],
        );
        if (!owned.rows.length) throw new KbDomainError("NOT_FOUND", "Provider not found");
      }
      let version = prior?.version ?? 1;
      const jobId = prior?.jobId ?? randomUUID();
      if (!prior) {
        if (creating) {
          const count = await query<{ count: string }>(
            `SELECT count(*)::text AS count FROM embedding_provider WHERE "ownerId"=$1 AND "revokedAt" IS NULL`,
            [userId],
          );
          if (Number(count.rows[0]!.count) >= KB_LIMITS.providersPerUser)
            throw new KbDomainError("QUOTA_EXCEEDED", "Provider quota exceeded");
        } else {
          const latest = await query<{ version: number }>(
            `SELECT version FROM provider_revision WHERE "providerId"=$1 ORDER BY version DESC LIMIT 1`,
            [providerId],
          );
          version = (latest.rows[0]?.version ?? 0) + 1;
        }
        const revisionCount = await query<{ count: string }>(
          `SELECT count(*)::text AS count FROM provider_revision WHERE "providerId"=$1`,
          [providerId],
        );
        if (Number(revisionCount.rows[0]!.count) >= KB_LIMITS.providerRevisionsPerProvider)
          throw new KbDomainError("QUOTA_EXCEEDED", "Provider revision quota exceeded");
        const userRevisionCount = await query<{ count: string }>(
          `SELECT count(*)::text AS count FROM provider_revision WHERE "ownerSnapshot"=$1`,
          [userId],
        );
        if (Number(userRevisionCount.rows[0]!.count) >= KB_LIMITS.providerRevisionsPerUser)
          throw new KbDomainError("QUOTA_EXCEEDED", "User provider revision quota exceeded");
        await chargeRate(runtime.ratePort, { kind: "probe", key: userId });
        if (creating)
          await query(
            `INSERT INTO embedding_provider (id, "ownerId", name, kind, "createdAt") VALUES ($1,$2,$3,'OPENAI_COMPAT',now())`,
            [providerId, userId, "name" in input ? input.name : ""],
          );
        const ciphertext = JSON.stringify(
          encryptKbSecret(
            input.apiKey,
            {
              aadVersion: 1,
              purpose: "provider-secret",
              userId,
              objectId: providerId,
              revision: String(version),
            },
            masterKey,
          ),
        );
        await enqueueDurableJobOnQuery(query, {
          jobId,
          kind: "PROVIDER_PROBE",
          dedupKey: `provider:${providerId}:${version}`,
          desired: { providerId, revision: version, ownerId: userId },
        });
        await query(
          `INSERT INTO provider_revision ("providerId",version,"endpointUrl",model,dimensions,ciphertext,"aadVersion","keyVersion","ownerSnapshot",fingerprint,"idempotencyKey","requestHash","jobId") VALUES ($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9,$10,$11)`,
          [
            providerId,
            version,
            endpointUrl,
            input.model,
            input.dimensions,
            ciphertext,
            userId,
            embeddingFingerprint({ ...input, endpointUrl }),
            input.idempotencyKey,
            requestHash,
            jobId,
          ],
        );
        await recordAuditEvent(query, {
          opId: jobId,
          action: creating ? "provider_create" : "provider_probe",
          outcome: "SUCCESS",
          actorKey: `user:${userId}`,
          actorUserIdSnapshot: userId,
          actorUserId: userId,
          revision: String(version),
          metadata: { requestId: providerId },
        });
      }
      const row = await query<{ name: string; state: string }>(
        `SELECT p.name,j.state FROM embedding_provider p JOIN durable_job j ON j.id=$2 WHERE p.id=$1`,
        [providerId, jobId],
      );
      return {
        jobId,
        provider: {
          providerId,
          revision: version,
          kind: "OPENAI_COMPAT",
          name: row.rows[0]!.name,
          model: input.model,
          dimensions: input.dimensions,
          contextTokens: null,
          status: row.rows[0]!.state === "COMPLETE" ? "ready" : "unavailable",
        },
      };
    });
  } finally {
    masterKey.fill(0);
  }
}

/** Caller owns the authority transaction. Scope is an exact provider or all providers of a deleted account. */
export async function destroyProviderCredentials(
  query: LockQuery,
  userId: string,
  providerId: string | null = null,
): Promise<void> {
  await query(
    `UPDATE embedding_provider SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "ownerId"=$1 AND ($2::text IS NULL OR id=$2)`,
    [userId, providerId],
  );
  await query(
    `UPDATE provider_revision r SET ciphertext=NULL FROM embedding_provider p WHERE r."providerId"=p.id AND p."ownerId"=$1 AND ($2::text IS NULL OR p.id=$2)`,
    [userId, providerId],
  );
  // Index builds release their disk reservations before they are cancelled (§1.8 (d)).
  await cancelIndexBuildJobs(query, { providerOwnerId: userId, providerId });
  await query(
    `UPDATE durable_job j SET state='CANCELLED',"cancelledAt"=now(),"workerOwner"=NULL,"leaseUntil"=NULL WHERE j.id IN (SELECT r."jobId" FROM provider_revision r JOIN embedding_provider p ON p.id=r."providerId" WHERE p."ownerId"=$1 AND ($2::text IS NULL OR p.id=$2)) AND j.state NOT IN ('COMPLETE','CANCELLED')`,
    [userId, providerId],
  );
}

/**
 * L-7: in the revocation transaction, every live KB on the provider gets a lexical-only
 * generation (the revoked profile can no longer build); its hybrid generation keeps serving
 * its FTS5 arm until that one is active. Keyset pages of 100 KBs.
 */
async function scheduleLexicalRebuilds(query: LockQuery, providerId: string): Promise<void> {
  let after = "";
  for (;;) {
    const page = (
      await query<{ id: string }>(
        `SELECT id FROM knowledge_base WHERE "profileProviderId"=$1 AND state='ACTIVE' AND id>$2
          ORDER BY id LIMIT 100`,
        [providerId, after],
      )
    ).rows;
    for (const { id } of page) await scheduleIndexBuild(query, id);
    if (page.length < 100) return;
    after = page.at(-1)!.id;
  }
}

export async function revokeProvider(
  runtime: ProviderRuntime,
  userId: string,
  raw: z.input<typeof providerRevokeInput>,
) {
  const { providerId } = providerRevokeInput.parse(raw);
  return asOwner(runtime, userId, async (query) => {
    const rows = await query<{ revokedAt: Date | null }>(
      `SELECT "revokedAt" FROM embedding_provider WHERE id=$1 AND "ownerId"=$2`,
      [providerId, userId],
    );
    if (!rows.rows[0]) throw new KbDomainError("NOT_FOUND", "Provider not found");
    if (!rows.rows[0].revokedAt) {
      await destroyProviderCredentials(query, userId, providerId);
      await scheduleLexicalRebuilds(query, providerId);
      await recordAuditEvent(query, {
        opId: randomUUID(),
        action: "provider_revoke",
        outcome: "SUCCESS",
        actorKey: `user:${userId}`,
        actorUserIdSnapshot: userId,
        actorUserId: userId,
        metadata: { requestId: providerId },
      });
    }
    return { revoked: true as const };
  });
}
