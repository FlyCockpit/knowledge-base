import { ACTIVE_ELEVATION_SQL, createGrantCredentialVerifier } from "../mcp-token-access";
import { actedByTrailer, withTrailer } from "./actors";
import { buildKbAttachment } from "./attachment";
import { recordAuditEvent } from "./audit";
import { type AuthorityBarrier, type AuthorityBarrierContext } from "./authority-lock";
import { KbDomainError } from "./errors";
import { scheduleIndexBuild } from "./generations";
import { kbBareRepoPath } from "./git-read";
import {
  type GitMutatingExecutor,
  initBareKbRepo,
  publishInitialMainRef,
  writeInitialMainCommitLoose,
} from "./git-write";
import { chargeRate, createMemoryRatePort, type RatePort } from "./limits";
import type { HeldLockLease, LockQuery } from "./lock";
import {
  applyJournalTestPublishDelta,
  canonicalRequestHash,
  finalizeIntent,
  OperationIntentError,
  replayFinalizedIntent,
  reserveKbCreateIntent,
} from "./operation-intent";
import {
  authorize,
  expandBits,
  type LiveAuthorityStore,
  PERMISSIONS,
  type Permission,
  sqlAuthorityStore,
} from "./permissions";
import {
  actorKeyFor,
  assertLiveIdentity,
  assertTokenAdmissible,
  type BrowserPrincipal,
  KbAdmissionError,
  type TokenPrincipal,
  tokenHasOauthScope,
} from "./principal";
import { commitQuota, type DiskMeter, reserveQuota, statfsDiskMeter } from "./quota";

export const KB_UPDATE_OPERATION = "KB_UPDATE";
export const KB_DELETE_OPERATION = "KB_DELETE";

/**
 * A concurrent create with the same actor/key reserved a different KB id after
 * this call's pre-lookup. Nothing was mutated; the caller retries once and
 * resolves the persisted reservation instead.
 */
export class ConcurrentKbCreateReservationError extends Error {
  readonly name = "ConcurrentKbCreateReservationError";
  constructor(readonly reservedKbId: string) {
    super("concurrent kb create reservation");
  }
}

export type KbCreatePreparedDelta = {
  kind: "kb_create";
  headSha: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string;
  quotaReservationId: string;
  canonicalOrigin: string;
  /** Creating grant generation (token creates only) and its approved expanded ceiling. */
  grantId?: string;
  createdKbBits?: Permission[];
};

export async function applyKbCreateDelta(
  query: LockQuery,
  intent: {
    opId: string;
    kbId: string | null;
    reservedKbId: string | null;
    actorKey: string;
    actorUserIdSnapshot: string;
    actorUserId: string | null;
    preparedDelta: unknown;
  },
): Promise<{ responseBody: Record<string, unknown>; resultRevision: string }> {
  const delta = intent.preparedDelta as KbCreatePreparedDelta;
  if (delta?.kind !== "kb_create") {
    throw new OperationIntentError("INVALID_STATE", "unexpected prepared delta");
  }
  const kbId = intent.reservedKbId ?? intent.kbId;
  if (!kbId) throw new OperationIntentError("INVALID_STATE", "missing kb id");
  const activated = await query(
    `UPDATE "knowledge_base"
        SET state = 'ACTIVE'::"KnowledgeBaseState",
            "headSha" = $2,
            "updatedAt" = now()
      WHERE id = $1 AND state = 'CREATING'::"KnowledgeBaseState"`,
    [kbId, delta.headSha],
  );
  if (activated.rowCount !== 1) {
    throw new OperationIntentError("INVALID_STATE", "knowledge base is not creating");
  }
  await scheduleIndexBuild(query, kbId);
  if (delta.grantId) {
    // Journal finalization is the only writer of a creator ACL row: exactly the
    // new KB and the creating grant's approved bits. Recovery re-finalization
    // is idempotent on the (grant, kb) key; no other grant is touched, and
    // ownership never widens this ceiling.
    await query(
      `INSERT INTO "grant_kb_acl" ("grantId", "kbId", bits, "createdAt")
       VALUES ($1::uuid, $2, $3::text[], now())
       ON CONFLICT ("grantId", "kbId") DO NOTHING`,
      [delta.grantId, kbId, expandBits(delta.createdKbBits ?? [])],
    );
  }
  await commitQuota({ transactionQuery: query }, [delta.quotaReservationId]);
  await recordAuditEvent(query, {
    opId: intent.opId,
    action: "kb_create",
    outcome: "SUCCESS",
    actorKey: intent.actorKey,
    actorUserIdSnapshot: intent.actorUserIdSnapshot,
    actorUserId: intent.actorUserId,
    kbId,
    revision: delta.headSha,
    metadata: { slug: delta.slug },
  });
  const kbRow = {
    id: kbId,
    name: delta.name,
    slug: delta.slug,
    description: delta.description,
    headSha: delta.headSha,
    metadataVersion: 1,
    state: "ACTIVE",
    activeGenerationId: null,
  };
  const responseBody = {
    operationId: intent.opId,
    kb: buildKbAttachment(
      kbRow,
      delta.grantId ? expandBits(delta.createdKbBits ?? []) : [...PERMISSIONS],
      delta.canonicalOrigin,
    ),
  };
  return { responseBody, resultRevision: delta.headSha };
}

export async function applyPreparedPublicationDelta(
  query: LockQuery,
  intent: {
    opId: string;
    kbId: string | null;
    reservedKbId: string | null;
    actorKey: string;
    actorUserIdSnapshot: string;
    actorUserId: string | null;
    operation: string;
    preparedDelta: unknown;
  },
): Promise<{ responseBody: Record<string, unknown>; resultRevision: string }> {
  const delta = intent.preparedDelta as { kind?: string };
  if (delta?.kind === "git_push") {
    return applyPushDelta(query, intent);
  }
  if (delta?.kind === "kb_create") return applyKbCreateDelta(query, intent);
  if (delta?.kind === "journal_test_publish") {
    return applyJournalTestPublishDelta(query, intent as never);
  }
  if (delta?.kind === "pr_merge") {
    const { applyPrMergeDelta } = await import("./pull-requests.js");
    return applyPrMergeDelta(query, intent as never);
  }
  if (delta?.kind === "changes_apply") {
    const { applyChangesApplyDelta } = await import("./changes.js");
    return applyChangesApplyDelta(query, intent as never);
  }
  throw new OperationIntentError("INVALID_STATE", "unexpected prepared delta");
}

export type KbCreateRequest = {
  name: string;
  slug: string;
  description: string;
  idempotencyKey: string;
};

export type KbCreatePublicationInput = {
  store: LiveAuthorityStore;
  principal: BrowserPrincipal | TokenPrincipal;
  reposDir: string;
  canonicalOrigin: string;
  reservedKbId: string;
  request: KbCreateRequest;
  ratePort?: RatePort;
  diskMeter?: DiskMeter;
};

export function createKbCreatePublication(input: KbCreatePublicationInput): {
  barrier: AuthorityBarrier;
  publish(lease: HeldLockLease, gitExecutor: GitMutatingExecutor): Promise<Record<string, unknown>>;
} {
  let prepared:
    | {
        intent: Awaited<ReturnType<typeof reserveKbCreateIntent>>;
        fresh: boolean;
        kbId: string;
        publication: {
          headSha: string;
          binding: Awaited<ReturnType<typeof writeInitialMainCommitLoose>>["binding"];
        };
      }
    | undefined;
  let reservationMade = false;
  const ratePort = input.ratePort ?? createMemoryRatePort();
  const diskMeter = input.diskMeter ?? statfsDiskMeter(input.reposDir);
  const kbId = input.reservedKbId;
  return {
    barrier: {
      async prepare(lease) {
        lease.assertHeldKb(kbId);
        const requestHash = canonicalRequestHash(input.request);
        const actorKey = actorKeyFor(input.principal);
        // Token creates: the creating grant must be live with allowCreate and a
        // read-bearing ceiling BEFORE any intent or CREATING row exists.
        const createdKbBits =
          input.principal.kind === "token"
            ? await assertGrantMayCreate(lease.query, input.principal)
            : undefined;
        const existing = await reserveKbCreateIntent(lease.query, {
          actorKey,
          actorUserIdSnapshot: input.principal.userId,
          actorUserId: input.principal.userId,
          idempotencyKey: input.request.idempotencyKey,
          requestHash,
          reservedKbId: kbId,
        });
        if (existing.requestHash !== requestHash) {
          throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "request body mismatch");
        }
        if (existing.reservedKbId !== kbId) {
          // A concurrent same-key create reserved a different id after this
          // call's pre-lookup. Retargeting would publish under one id while
          // the journal finalizes under another; retry against the winner.
          throw new ConcurrentKbCreateReservationError(existing.reservedKbId ?? kbId);
        }
        if (existing.phase === "FINALIZED" && existing.responseBody) {
          prepared = {
            intent: existing,
            fresh: false,
            kbId,
            publication: { headSha: "", binding: {} as never },
          };
          return;
        }
        if (existing.phase !== "PREPARED") {
          throw new OperationIntentError("INTENT_CONFLICT", existing.abortReason ?? "conflict");
        }
        const identity = await input.store.loadIdentity(input.principal.userId);
        assertLiveIdentity(identity);
        const priorDelta = existing.preparedDelta as KbCreatePreparedDelta | null;
        if (priorDelta?.kind === "kb_create") {
          // An earlier attempt already committed the CREATING row, quota
          // reservation, and prepared delta. Resuming must never re-reserve
          // or re-target; the reservation transaction below is idempotent
          // on the journal side, so skip straight to reauthorization.
          prepared = {
            intent: existing,
            fresh: true,
            kbId,
            publication: { headSha: "", binding: {} as never },
          };
          return;
        }
        await chargeRate(ratePort, { kind: "create", key: input.principal.userId });
        await lease.transaction(async (query) => {
          const slugClash = await query<{ id: string }>(
            `SELECT id FROM "knowledge_base"
              WHERE "ownerId" = $1 AND slug = $2
                AND state <> 'TOMBSTONED'::"KnowledgeBaseState"
              LIMIT 1`,
            [input.principal.userId, input.request.slug],
          );
          if (slugClash.rows[0]) {
            throw new KbDomainError("CONFLICT", "Slug already exists");
          }
          try {
            await query(
              `INSERT INTO "knowledge_base"
                (id, "ownerId", name, slug, description, state, "updatedAt")
               VALUES ($1, $2, $3, $4, $5, 'CREATING'::"KnowledgeBaseState", now())
               ON CONFLICT (id) DO NOTHING`,
              [
                kbId,
                input.principal.userId,
                input.request.name,
                input.request.slug,
                input.request.description,
              ],
            );
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new KbDomainError("CONFLICT", "Slug already exists");
            }
            throw error;
          }
          const quota = await reserveQuota(
            { transactionQuery: query },
            {
              opId: existing.opId,
              charges: [
                { dimension: "OWNER_LIVE_KB", subjectId: input.principal.userId, amount: 1n },
              ],
              disks: [{ path: input.reposDir, bytes: 0n, meter: diskMeter }],
              expiresAt: new Date(Date.now() + 3_600_000),
              heldForPublication: true,
            },
          );
          const linked = await query(
            `UPDATE "operation_intent"
                SET "kbId" = $2,
                    "refName" = $3,
                    "oldRef" = $4,
                    "newRef" = $5,
                    "preparedDelta" = $6::jsonb,
                    "updatedAt" = now()
              WHERE "opId" = $1 AND phase = 'PREPARED'::"OperationIntentPhase"`,
            [
              existing.opId,
              kbId,
              "refs/heads/main",
              "0000000000000000000000000000000000000000",
              "0000000000000000000000000000000000000000",
              JSON.stringify({
                kind: "kb_create",
                headSha: "0000000000000000000000000000000000000000",
                ownerId: input.principal.userId,
                name: input.request.name,
                slug: input.request.slug,
                description: input.request.description,
                quotaReservationId: quota.reservationIds[0]!,
                canonicalOrigin: input.canonicalOrigin,
                ...(input.principal.kind === "token"
                  ? { grantId: input.principal.grantId, createdKbBits }
                  : {}),
              }),
            ],
          );
          // Phase-conditional link: if the intent left PREPARED between the
          // reservation insert and this transaction (sweep abort, tombstone),
          // rolling back keeps the CREATING row and its held quota from ever
          // becoming visible without a resumable journal entry.
          if ((linked.rowCount ?? 0) !== 1) {
            throw new OperationIntentError("INTENT_CONFLICT", "create reservation changed");
          }
        });
        prepared = {
          intent: existing,
          fresh: true,
          kbId,
          publication: { headSha: "", binding: {} as never },
        };
      },
      async reauthorize(context) {
        if (!prepared?.fresh) return;
        await assertLiveCreateIdentity(context.query, input.principal.userId);
        if (input.principal.kind === "token") {
          await assertGrantMayCreate(context.query, input.principal);
        }
      },
      async reservePublication(context: AuthorityBarrierContext) {
        if (!prepared?.fresh) return;
        await assertLiveCreateIdentity(context.query, input.principal.userId);
        if (input.principal.kind === "token") {
          const ceiling = await assertGrantMayCreate(context.query, input.principal);
          // Re-read the persisted selection on the reservation session. A
          // PREPARED retry has no right to publish bits removed by re-consent.
          // COMMITTING recovery deliberately retains its reserved selection.
          const saved = await context.query<{ preparedDelta: KbCreatePreparedDelta }>(
            `SELECT "preparedDelta" FROM operation_intent WHERE "opId" = $1 AND phase = 'PREPARED'`,
            [prepared.intent.opId],
          );
          const delta = saved.rows[0]?.preparedDelta;
          if (
            delta?.grantId !== input.principal.grantId ||
            !expandBits(delta.createdKbBits ?? []).includes("read") ||
            !expandBits(delta.createdKbBits ?? []).every((bit) => ceiling.includes(bit))
          ) {
            throw new KbDomainError("FORBIDDEN", "Forbidden");
          }
        }
        const updated = await context.query(
          `UPDATE "operation_intent"
              SET phase = 'COMMITTING'::"OperationIntentPhase", "updatedAt" = now()
            WHERE "opId" = $1 AND phase = 'PREPARED'::"OperationIntentPhase"`,
          [prepared.intent.opId],
        );
        if (updated.rowCount !== 1) {
          throw new OperationIntentError("INVALID_STATE", "intent is not prepared");
        }
        reservationMade = true;
      },
    },
    async publish(lease, gitExecutor) {
      if (!prepared) throw new OperationIntentError("INVALID_STATE", "not prepared");
      lease.assertHeldKb(kbId);
      if (!prepared.fresh) {
        return liveKbCreateReceiptBody(
          lease.query,
          input.principal,
          kbId,
          prepared.intent.opId,
          input.canonicalOrigin,
        );
      }
      if (!reservationMade) throw new OperationIntentError("INVALID_STATE", "not reserved");
      lease.assertCanReceiveNetworkBody("publish kb create ref");
      await initBareKbRepo({ reposDir: input.reposDir, kbId, executor: gitExecutor });
      const repo = kbBareRepoPath(input.reposDir, kbId);
      // The system author, and a trailer naming who created it and how.
      const message = withTrailer(
        "Initial commit",
        await actedByTrailer(lease.query, actorKeyFor(input.principal)),
      );
      const readOptions = { signal: lease.scope.signal, deadlineAt: lease.scope.deadlineAt };
      const publication = await writeInitialMainCommitLoose(
        repo,
        { message, description: input.request.description },
        readOptions,
      );
      await lease.query(
        `UPDATE "operation_intent"
            SET "newRef" = $2,
                "preparedDelta" = jsonb_set("preparedDelta", '{headSha}', to_jsonb($2::text)),
                "updatedAt" = now()
          WHERE "opId" = $1 AND phase = 'COMMITTING'::"OperationIntentPhase"`,
        [prepared.intent.opId, publication.headSha],
      );
      await publishInitialMainRef(
        { reposDir: input.reposDir, kbId, executor: gitExecutor },
        publication,
        readOptions,
      );
      const finalized = await lease.transaction((query) =>
        finalizeIntent(query, prepared!.intent.opId),
      );
      if (input.principal.kind === "token") {
        // Private receipt for a token: live grant-bounded authority, derived
        // from the live row (never the stored body's capabilities).
        return liveKbCreateReceiptBody(
          lease.query,
          input.principal,
          kbId,
          finalized.opId,
          input.canonicalOrigin,
        );
      }
      return replayFinalizedIntent(input.store, input.principal, finalized, lease.query);
    },
  };
}

/**
 * Creation capability of a token: the exact live grant generation (full
 * validity callback on this session), literal mcp:write on both the presented
 * token and the grant, allowCreate, and a read-bearing createdKbBits ceiling.
 * Returns the expanded ceiling to append. Throws FORBIDDEN otherwise.
 */
export async function assertGrantMayCreate(
  query: LockQuery,
  principal: TokenPrincipal,
): Promise<Permission[]> {
  const forbidden = () => new KbAdmissionError("FORBIDDEN", "Forbidden");
  await assertTokenAdmissible(principal, createGrantCredentialVerifier(query));
  if (!tokenHasOauthScope(principal.scopes, true)) throw forbidden();
  // The base grant united with every creation-granting elevation in force now
  // (database clock), read on this same session: an expired or ended elevation
  // denies creation at the next check, including the lock-held one.
  const rows = await query<{
    allowCreate: boolean;
    createdKbBits: string[] | null;
    scopes: string[] | null;
    elevatedCreate: boolean;
    elevatedKbBits: string[] | null;
  }>(
    `SELECT g."allowCreate", g."createdKbBits", g.scopes,
            EXISTS (SELECT 1 FROM "mcp_grant_elevation" e
                     WHERE e."grantId" = g.id AND e."allowCreate" AND ${ACTIVE_ELEVATION_SQL})
              AS "elevatedCreate",
            ARRAY(SELECT DISTINCT eb FROM "mcp_grant_elevation" e, unnest(e."createdKbBits") AS eb
                   WHERE e."grantId" = g.id AND e."allowCreate" AND ${ACTIVE_ELEVATION_SQL})
              AS "elevatedKbBits"
       FROM "mcp_grant" g
      WHERE g.id = $1::uuid AND g."userId" = $2 AND g."revokedAt" IS NULL
      FOR SHARE OF g`,
    [principal.grantId, principal.userId],
  );
  const grant = rows.rows[0];
  if (!grant || !tokenHasOauthScope(grant.scopes ?? [], true)) throw forbidden();
  if (!grant.allowCreate && grant.elevatedCreate !== true) throw forbidden();
  const ceiling = expandBits([
    ...(grant.allowCreate ? (grant.createdKbBits ?? []) : []),
    ...(grant.elevatedCreate === true ? (grant.elevatedKbBits ?? []) : []),
  ]);
  if (!ceiling.includes("read")) throw forbidden();
  return ceiling;
}

/**
 * Live admission for KB creation: ban, forced-2FA state, and instance
 * enablement are read on the reservation's own pinned session, so a mid-flight
 * enforcement change (e.g. forced 2FA enabled after browser admission) blocks
 * COMMITTING and publication, not just receipt delivery.
 */
async function assertLiveCreateIdentity(query: LockQuery, userId: string): Promise<void> {
  const identity = await sqlAuthorityStore(query).loadIdentity(userId);
  assertLiveIdentity(identity);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Replay rule for private create receipts: the retry reauthorizes
 * live against the KB (same "write" level as replayFinalizedIntent) on the
 * pinned session, and the returned attachment — capabilities included — is
 * re-derived from the live row instead of the stored response body, so a
 * creator who lost the KB never receives the cached private attachment.
 */
export async function liveKbCreateReceiptBody(
  query: LockQuery,
  principal: BrowserPrincipal | TokenPrincipal,
  kbId: string,
  operationId: string,
  canonicalOrigin: string,
): Promise<Record<string, unknown>> {
  // Browser replays keep the create-level "write" check. A token's receipt is
  // bounded by its grant ceiling (which may be read-only), so it needs live
  // read through the full grant validity callback plus mcp:write scope.
  const admission = {
    store: sqlAuthorityStore(query),
    principal,
    kbId,
    operation: principal.kind === "token" ? ("read" as const) : ("write" as const),
    query,
    verifier: principal.kind === "token" ? createGrantCredentialVerifier(query) : undefined,
  };
  if (principal.kind === "token" && !tokenHasOauthScope(principal.scopes, true)) {
    throw new KbAdmissionError("FORBIDDEN", "Forbidden");
  }
  await authorize(admission);
  const rows = await query<{
    id: string;
    name: string;
    slug: string;
    description: string;
    headSha: string | null;
    metadataVersion: number;
    state: string;
    ownerId: string | null;
    activeGenerationId: string | null;
  }>(
    `SELECT id, name, slug, description, "headSha", "metadataVersion",
            state::text AS state, "ownerId", "activeGenerationId"
       FROM "knowledge_base" WHERE id = $1`,
    [kbId],
  );
  const row = rows.rows[0];
  if (!row) throw new OperationIntentError("NOT_FOUND", "knowledge base not found");
  const auth = await authorize(admission);
  return {
    operationId,
    kb: buildKbAttachment({ ...row, state: auth.state }, auth.bits, canonicalOrigin),
  };
}

/** A pushed ref's publication. Invoked only inside finalizeIntent's locked
 * transaction; replay never re-applies. It lives here, not in push-validation,
 * so the pre-receive hook's graph never reaches the publication machinery. */
async function applyPushDelta(
  query: LockQuery,
  intent: {
    opId: string;
    kbId: string | null;
    actorKey: string;
    actorUserIdSnapshot: string;
    actorUserId: string | null;
    preparedDelta: unknown;
  },
) {
  const delta = intent.preparedDelta as {
    kind: string;
    headSha: string;
    refName: string;
    newBranch: boolean;
    quotaReservationIds: string[];
    touched?: { kind: "document" | "asset"; path: string }[];
  };
  if (delta.kind !== "git_push" || !intent.kbId) throw new Error("PUSH_REJECTED");
  let indexJobId: string | null = null;
  if (delta.refName === "refs/heads/main") {
    await query(`UPDATE knowledge_base SET "headSha"=$2, "updatedAt"=now() WHERE id=$1`, [
      intent.kbId,
      delta.headSha,
    ]);
    indexJobId = (await scheduleIndexBuild(query, intent.kbId))?.jobId ?? null;
  } else {
    if (delta.newBranch) {
      const { insertBranchOwner } = await import("./branch-owner.js");
      await insertBranchOwner(query, {
        kbId: intent.kbId,
        refName: delta.refName,
        ownerActorKey: intent.actorKey,
        purpose: "USER",
      });
    }
    const [{ refreshPushedProposal }, { parsePushTouched }] = await Promise.all([
      import("./proposals.js"),
      import("./push-validation.js"),
    ]);
    await refreshPushedProposal(
      query,
      intent.kbId,
      delta.refName,
      delta.headSha,
      parsePushTouched(delta.touched ?? []),
    );
  }
  await commitQuota({ transactionQuery: query }, delta.quotaReservationIds);
  await recordAuditEvent(query, {
    ...intent,
    kbId: intent.kbId,
    action: "git_push",
    outcome: "SUCCESS",
    revision: delta.headSha,
    metadata: { headSha: delta.headSha },
  });
  return {
    responseBody: { operationId: intent.opId, headSha: delta.headSha, indexJobId },
    resultRevision: delta.headSha,
  };
}
