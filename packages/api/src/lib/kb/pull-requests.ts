import { randomUUID } from "node:crypto";
import { countMergeabilityFailure, logInternalError } from "@knowledge-base/env/log";
import type { z } from "zod";
import { actedByTrailer, sameActorPerson, withTrailer } from "./actors";
import { assetValidationContext, manifestAtCommitAsync } from "./asset-authz";
import { recordAuditEvent } from "./audit";
import { type AuthorityBarrier, assertAuthorityReservation } from "./authority-lock";
import { loadBranchOwner } from "./branch-owner";
import { type CursorSigner, cursorExpiry, stableFilterHash } from "./cursor";
import { diffAtRevisions } from "./diff";
import { authorizeDocumentRead } from "./documents-read";
import { KbDomainError } from "./errors";
import { scheduleIndexBuild } from "./generations";
import {
  assertGitReadActive,
  type GitReadOptions,
  gitReadOptions,
  kbBareRepoPath,
  readCommitBlobsAsync,
  readRefShaAsync,
  runGitAsync,
} from "./git-read";
import {
  bindValidatedTreeForPublication,
  fsyncRefUpdate,
  type GitMutatingExecutor,
  removeLooseObjectsAsync,
  writeStagedObjectsAsync,
} from "./git-write";
import { chargeKbMutation, type RatePort } from "./limits";
import { type HeldLockLease, isRolledBackTransactionError, type LockQuery } from "./lock";
import { changedLogicalPaths } from "./logical-diff";
import {
  canonicalRequestHash,
  finalizeIntent,
  findOperationIntent,
  type IntentRow,
  OperationIntentError,
  type PublicationBarrier,
  reconcileKbIntents,
  recordFinalizedReceipt,
  reservePublicationIntent,
} from "./operation-intent";
import {
  authorize,
  type LiveAuthorityStore,
  type Permission,
  prismaAuthorityStore,
} from "./permissions";
import { PrConflictError } from "./pr-conflict";
import { type ConflictItem, mergeProposalOntoMain, planReviewedMerge } from "./pr-merge";
import {
  actorKeyFor,
  type CredentialVerifier,
  type Principal,
  tokenHasOauthScope,
} from "./principal";
import {
  allocateNextPrNumber,
  findActiveAutoPrForActor,
  findPullRequest,
  isActivePrStatus,
  mergeabilityKey,
  type PullRequestRow,
  toPrSummary,
  upsertPullRequestHead,
} from "./proposals";
import { PROPOSAL_CONFLICT_MAX_PATHS } from "./protocol/envelope";
import { kbReadToolSchemas } from "./protocol/reads";
import { kbWriteToolSchemas } from "./protocol/writes";
import { commitQuota, type DiskMeter, releaseQuota, reserveQuota, statfsDiskMeter } from "./quota";
import type { KbRuntimeConfig } from "./runtime";
import { loadSealedTreeValidator } from "./sealed-reference";
import { stagedNewObjectBytesAsync } from "./staged-tree";
import type { TreeValidationOptions } from "./validate-tree";

export type PrMutationRequest =
  | ({ kind: "create" } & z.infer<typeof kbWriteToolSchemas.knowledge_pull_requests_create.input>)
  | ({ kind: "review" } & z.infer<typeof kbWriteToolSchemas.knowledge_pull_requests_review.input>);
type PrResult = z.infer<typeof kbWriteToolSchemas.knowledge_pull_requests_review.output>;
type ReadInput = {
  /** The runtime's origin, for the sealed-reference rules the merge planner applies. */
  canonicalOrigin?: string;
  store: LiveAuthorityStore;
  principal: Principal;
  verifier?: CredentialVerifier;
  query: LockQuery;
  reposDir: string;
  cursorSigner: CursorSigner;
} & GitReadOptions;
const missing = () => new KbDomainError("NOT_FOUND", "Pull request not found");
const stale = () => new KbDomainError("CONFLICT", "Reviewed revision changed");
/** The PR is no longer open (closed or merged by someone else). */
const stateChanged = () =>
  new PrConflictError("Reviewed revision changed", { kind: "state_changed" });

/**
 * Merge needs `review`; close needs `review`, or the PR's author with
 * `propose`. The author is the person: any of their credentials that
 * can propose here, or their web session, not only the one that opened it.
 */
export function assertReviewPermission(
  bits: readonly Permission[],
  isAuthor: boolean,
  decision: "merge" | "close",
): void {
  if (bits.includes("review") || (decision === "close" && isAuthor && bits.includes("propose")))
    return;
  throw new KbDomainError("FORBIDDEN", "Pull request permission required");
}

/** Most stale open PRs one list call rechecks; a page past that budget ends early. */
const MERGEABILITY_LIST_BUDGET = 50;
const MERGEABILITY_BATCH = 10;
/**
 * Share of a list's remaining read time its rechecks may start in: past it no
 * recheck starts, so a page of slow (near-limit) rechecks ends early with a
 * cursor instead of failing the whole read at the deadline.
 */
const MERGEABILITY_LIST_TIME_SHARE = 2 / 3;
/** Recomputations of one PR when main keeps moving under the check. */
const MERGEABILITY_ATTEMPTS = 3;

type MergeabilityScope = { kbId: string; force?: boolean } & (
  | { number: number }
  | { after: number; through: number | null }
);

/** The main snapshot a derived PR status is computed against. */
export type MainSnapshot = { mainHead: string; epoch: string; policyGeneration: string };

/**
 * The current main as the database records it, with its monotonic epoch
 * (`desiredEpoch`, bumped by every publication that moves main). Results
 * computed against an older epoch or sealed-policy generation never replace
 * newer ones.
 */
export async function readMainSnapshot(
  query: LockQuery,
  kbId: string,
): Promise<MainSnapshot | null> {
  const row = (
    await query<{ headSha: string | null; epoch: string; policyGeneration: string }>(
      `SELECT "headSha", "desiredEpoch"::text AS epoch, "sealedPolicyGeneration"::text AS "policyGeneration" FROM knowledge_base WHERE id=$1`,
      [kbId],
    )
  ).rows[0];
  return row?.headSha && /^[a-f0-9]{40}$/.test(row.headSha)
    ? { mainHead: row.headSha, epoch: row.epoch, policyGeneration: row.policyGeneration }
    : null;
}

/**
 * Whether a proposal head merges into main, decided by the reviewed-merge
 * planner itself: the same textual merge, manifest merge, whole-tree
 * validation with live asset trust and sealed references, and dream guard
 * that a merge enforces. CONFLICT exactly when that merge would refuse.
 */
export async function proposalMergeStatus(
  input: {
    query: LockQuery;
    reposDir: string;
    kbId: string;
    canonicalOrigin?: string;
    mainHead: string;
    headSha: string;
    dream: PullRequestRow["dreamMetadata"];
    /**
     * Assets the publication being planned introduces: trusted like the
     * lineage they become at finalize, so the planned head is judged as the
     * merge will judge it once published.
     */
    pendingAssets?: Pick<TreeValidationOptions, "trustedBlobs" | "lineageHashes">;
    /** Conflicts the PR recorded and has not resolved: the planner refuses them. */
    pendingConflicts?: PullRequestRow["pendingConflicts"];
  } & GitReadOptions,
): Promise<"OPEN" | "CONFLICT"> {
  const options = gitReadOptions(input);
  const repoPath = kbBareRepoPath(input.reposDir, input.kbId);
  try {
    await planReviewedMerge({
      ...options,
      repoPath,
      scratchRoot: input.reposDir,
      mainHead: input.mainHead,
      sourceHead: input.headSha,
      dream: input.dream,
      pendingConflicts: input.pendingConflicts,
      validation: withPendingAssets(
        await reviewedMergeValidation({ ...input, ...options, repoPath }),
        input.pendingAssets,
      ),
    });
    return "OPEN";
  } catch (error) {
    if (error instanceof PrConflictError) return "CONFLICT";
    throw error;
  }
}

function withPendingAssets(
  validation: Omit<TreeValidationOptions, "repoPath">,
  pending?: Pick<TreeValidationOptions, "trustedBlobs" | "lineageHashes">,
): Omit<TreeValidationOptions, "repoPath"> {
  if (!pending) return validation;
  return {
    ...validation,
    trustedBlobs: new Map([...(validation.trustedBlobs ?? []), ...(pending.trustedBlobs ?? [])]),
    lineageHashes: new Set([...(validation.lineageHashes ?? []), ...(pending.lineageHashes ?? [])]),
  };
}

/** The validation context of a reviewed merge: both sides' asset lineage and live sealed references. */
async function reviewedMergeValidation(
  input: {
    query: LockQuery;
    kbId: string;
    repoPath: string;
    canonicalOrigin?: string;
    mainHead: string;
    headSha: string;
  } & GitReadOptions,
): Promise<Omit<TreeValidationOptions, "repoPath">> {
  const hashes = [
    ...(await manifestAtCommitAsync(input.repoPath, input.headSha, input)),
    ...(await manifestAtCommitAsync(input.repoPath, input.mainHead, input)),
  ].map((a) => a.hash);
  return {
    ...(await assetValidationContext(input.query, input.kbId, [...new Set(hashes)])),
    validateSealedReferences: await loadSealedTreeValidator(
      input.query,
      input.kbId,
      input.canonicalOrigin,
    ),
    // L-8: only paths the merge changes on main need live records.
    baseBlobs: await readCommitBlobsAsync(input.repoPath, input.mainHead, input),
  };
}

/**
 * An open PR is CONFLICT exactly while it no longer merges into the
 * current main, and OPEN again once it does. The status is derived and
 * cached by the main snapshot, PR head/version, sealed-policy generation and
 * configured origin (`mergeCheckedKey`), so reads recheck when any input changes — the one PR requested, or the open PRs in a list page's
 * number range. A result is stored only for the same head, an open state,
 * and a snapshot no older than the stored one (a slow check can never
 * overwrite a newer result); the PR's version is left alone. Returns the
 * numbers it attempted and which could not be checked (they keep their
 * cached status).
 */
export async function refreshPrMergeability(
  input: {
    query: LockQuery;
    reposDir: string;
    canonicalOrigin?: string;
    /** No recheck starts at or after this time; the rest are left unattempted. */
    stopAt?: number;
  } & GitReadOptions,
  scope: MergeabilityScope,
  take = MERGEABILITY_BATCH,
  skip: ReadonlySet<number> = new Set(),
  /** Test seam: runs after a result is computed, before it is stored. */
  beforeStore?: () => Promise<void>,
): Promise<{ attempted: number[]; failed: number[]; outOfTime: boolean }> {
  const options = gitReadOptions(input);
  const snapshot = await readMainSnapshot(input.query, scope.kbId);
  if (!snapshot) return { attempted: [], failed: [], outOfTime: false };
  const single = "number" in scope;
  const stale = (
    await input.query<{
      number: number;
      version: number;
      headSha: string;
      dreamMetadata: PullRequestRow["dreamMetadata"];
      pendingConflicts: PullRequestRow["pendingConflicts"];
    }>(
      `SELECT number, version, "headSha", "dreamMetadata", "pendingConflicts" FROM pull_request
        WHERE "kbId"=$1 AND status IN ('OPEN','CONFLICT')
          AND ($2::text IS NULL OR "mergeCheckedKey" IS DISTINCT FROM $2 || ':' || "headSha" || ':' || version::text)
          AND ${single ? "number=$3::bigint" : "number>$3 AND ($4::int IS NULL OR number<=$4)"}
          AND NOT (number = ANY($${single ? 4 : 5}::int[]))
        ORDER BY number LIMIT $${single ? 5 : 6}`,
      single
        ? [
            scope.kbId,
            scope.force ? null : mergeabilityKey(snapshot, undefined, input.canonicalOrigin),
            scope.number,
            [...skip],
            1,
          ]
        : [
            scope.kbId,
            mergeabilityKey(snapshot, undefined, input.canonicalOrigin),
            scope.after,
            scope.through,
            [...skip],
            take,
          ],
    )
  ).rows;
  const failed: number[] = [];
  const attempted: number[] = [];
  for (const pr of stale) {
    if (input.stopAt !== undefined && Date.now() >= input.stopAt)
      return { attempted, failed, outOfTime: true };
    attempted.push(pr.number);
    // Store only for the main that is still current; if main moved while the
    // planner ran, compute again for the new snapshot (bounded).
    let current: MainSnapshot | null = snapshot;
    for (let attempt = 0; current && attempt < MERGEABILITY_ATTEMPTS; attempt += 1) {
      let status: "OPEN" | "CONFLICT";
      try {
        status = await proposalMergeStatus({
          ...input,
          ...options,
          kbId: scope.kbId,
          mainHead: current.mainHead,
          headSha: pr.headSha,
          dream: pr.dreamMetadata,
          pendingConflicts: pr.pendingConflicts,
        });
      } catch (error) {
        // The status is a cache: an unmergeable repository keeps the last one.
        // Cancellation and the deadline still end the read.
        assertGitReadActive(options);
        failed.push(pr.number);
        // A stale status is otherwise silent (R3-W3): log every failure with a
        // process-lifetime count, so a check that always fails stands out.
        logInternalError("pr-mergeability", error, {
          kbId: scope.kbId,
          pr: pr.number,
          failures: countMergeabilityFailure(),
        });
        break;
      }
      await beforeStore?.();
      if (
        await storeMergeStatus(input.query, {
          kbId: scope.kbId,
          number: pr.number,
          headSha: pr.headSha,
          status,
          snapshot: current,
          version: pr.version,
          canonicalOrigin: input.canonicalOrigin,
        })
      )
        break;
      const next = await readMainSnapshot(input.query, scope.kbId);
      // A changed head or closed PR ends the attempt; changed policy/main retries.
      current =
        next && (next.epoch !== current.epoch || next.policyGeneration !== current.policyGeneration)
          ? next
          : null;
    }
  }
  return { attempted, failed, outOfTime: false };
}

/**
 * Compare-and-set of a derived status: same head, open, no newer snapshot
 * stored, and the snapshot still current for the KB in the same statement.
 * Whether the result was stored.
 */
async function storeMergeStatus(
  query: LockQuery,
  input: {
    kbId: string;
    number: number;
    headSha: string;
    status: "OPEN" | "CONFLICT";
    snapshot: MainSnapshot;
    version: number;
    canonicalOrigin?: string;
  },
): Promise<boolean> {
  const result = await query(
    `UPDATE pull_request
        SET status=$4::"PullRequestStatus", "mergeCheckedSha"=$3, "mergeCheckedEpoch"=$6::bigint, "mergeCheckedKey"=$7,
            "updatedAt"=now()
      WHERE "kbId"=$1 AND number=$2 AND "headSha"=$5 AND status IN ('OPEN','CONFLICT')
        AND version=$8 AND ("mergeCheckedEpoch" IS NULL OR "mergeCheckedEpoch" <= $6::bigint)
        AND EXISTS (SELECT 1 FROM knowledge_base k
                     WHERE k.id=$1 AND k."desiredEpoch"=$6::bigint AND k."headSha"=$3 AND k."sealedPolicyGeneration"=$9::bigint)`,
    [
      input.kbId,
      input.number,
      input.snapshot.mainHead,
      input.status,
      input.headSha,
      input.snapshot.epoch,
      mergeabilityKey(input.snapshot, input, input.canonicalOrigin),
      input.version,
      input.snapshot.policyGeneration,
    ],
  );
  return result.rowCount === 1;
}

/** The first open PR in range still unchecked against current main (none: null). */
async function firstUncheckedPr(
  input: { query: LockQuery; reposDir: string; canonicalOrigin?: string } & GitReadOptions,
  kbId: string,
  after: number,
  through: number | null,
  skip: ReadonlySet<number>,
): Promise<number | null> {
  const snapshot = await readMainSnapshot(input.query, kbId);
  if (!snapshot) return null;
  const row = (
    await input.query<{ number: number }>(
      `SELECT number FROM pull_request
        WHERE "kbId"=$1 AND status IN ('OPEN','CONFLICT') AND "mergeCheckedKey" IS DISTINCT FROM $2 || ':' || "headSha" || ':' || version::text
          AND number>$3 AND ($4::int IS NULL OR number<=$4) AND NOT (number = ANY($5::int[]))
        ORDER BY number LIMIT 1`,
      [
        kbId,
        mergeabilityKey(snapshot, undefined, input.canonicalOrigin),
        after,
        through,
        [...skip],
      ],
    )
  ).rows[0];
  return row?.number ?? null;
}

async function readAuth(input: ReadInput, kbId: string) {
  return authorizeDocumentRead({
    store: input.store,
    principal: input.principal,
    verifier: input.verifier,
    kbId,
    operation: "read",
  });
}
export async function listPullRequests(
  input: ReadInput,
  raw: z.input<typeof kbReadToolSchemas.knowledge_pull_requests_list.input>,
) {
  // One request lifetime for every recheck batch: the caller's cancellation
  // and a single deadline pinned here, never a fresh one per batch.
  const lifetime = { ...input, ...gitReadOptions(input) };
  assertGitReadActive(lifetime);
  const request = kbReadToolSchemas.knowledge_pull_requests_list.input.parse(raw);
  await readAuth(input, request.kbId);
  const binding = {
    actorKey: actorKeyFor(input.principal),
    kbId: request.kbId,
    filterHash: stableFilterHash({ status: request.status ?? null }),
    sortKey: "pr:number",
    revision: "*",
  };
  const pin = request.cursor ? input.cursorSigner.verify(request.cursor, binding) : null;
  const after = pin?.lastKey ? Number(pin.lastKey) : 0;
  if (!Number.isSafeInteger(after) || after < 0)
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const limit = request.limit ?? 20;
  const page = async () =>
    (
      await input.query<PullRequestRow>(
        `SELECT number,title,"sourceBranch","baseSha","headSha","targetSha",status::text AS status,"authorActorKey",version,"mergeCommitSha","mergeCheckedSha"
    FROM pull_request WHERE "kbId"=$1 AND number>$2 AND ($3::text IS NULL OR status::text=$3) ORDER BY number LIMIT $4`,
        [request.kbId, after, request.status ?? null, limit + 1],
      )
    ).rows;
  // No page presents an unchecked OPEN/CONFLICT status as current. Every
  // open PR the page could contain (up to its last row, or beyond for a short
  // page) is rechecked first; past the budget the page ends before the first
  // unchecked PR and the cursor resumes there. Closed/merged never change.
  let rows = await page();
  let stopBefore: number | null = null;
  if (request.status !== "CLOSED" && request.status !== "MERGED") {
    const failed = new Set<number>();
    let budget = MERGEABILITY_LIST_BUDGET;
    const started = Date.now();
    const stopAt = started + (lifetime.deadlineAt - started) * MERGEABILITY_LIST_TIME_SHARE;
    for (;;) {
      const through = rows.length > limit ? rows[limit]!.number : null;
      // A lapsed deadline or a cancellation ends the read; spent recheck time
      // only ends the page.
      assertGitReadActive(lifetime);
      if (budget <= 0 || Date.now() >= stopAt) {
        stopBefore = await firstUncheckedPr(lifetime, request.kbId, after, through, failed);
        break;
      }
      const refreshed = await refreshPrMergeability(
        { ...lifetime, stopAt },
        { kbId: request.kbId, after, through },
        Math.min(MERGEABILITY_BATCH, budget),
        failed,
      );
      for (const number of refreshed.failed) failed.add(number);
      if (refreshed.attempted.length === 0 && !refreshed.outOfTime) break;
      budget -= refreshed.attempted.length;
      rows = await page();
    }
  }
  const visible = stopBefore === null ? rows : rows.filter((row) => row.number < stopBefore!);
  const items = visible.slice(0, limit).map(toPrSummary);
  await readAuth(input, request.kbId);
  const lastKey =
    stopBefore !== null && visible.length <= limit
      ? String(stopBefore - 1)
      : rows.length > limit
        ? String(items.at(-1)!.number)
        : null;
  const nextCursor =
    lastKey !== null
      ? input.cursorSigner.sign({
          ...binding,
          v: 1,
          lastKey,
          exp: pin?.exp ?? cursorExpiry(),
        })
      : null;
  return { items, nextCursor };
}
const CODE_OF_STATUS: Record<PullRequestRow["status"], string> = {
  OPEN: "O",
  CONFLICT: "C",
  CLOSED: "X",
  MERGED: "M",
};
const STATUS_OF_CODE: Record<string, PullRequestRow["status"]> = Object.fromEntries(
  Object.entries(CODE_OF_STATUS).map(([status, code]) => [
    code,
    status as PullRequestRow["status"],
  ]),
);

export async function getPullRequest(
  input: ReadInput,
  raw: z.input<typeof kbReadToolSchemas.knowledge_pull_requests_get.input>,
) {
  const options = gitReadOptions(input);
  assertGitReadActive(options);
  const request = kbReadToolSchemas.knowledge_pull_requests_get.input.parse(raw);
  await readAuth(input, request.kbId);
  // One verified snapshot: the status and the target come from the same
  // stored check, made current against main when it can be.
  let row: PullRequestRow | null = null;
  let currentCheck = false;
  for (let attempt = 0; attempt < MERGEABILITY_ATTEMPTS; attempt += 1) {
    const refreshed = await refreshPrMergeability(
      { ...input, ...options },
      { kbId: request.kbId, number: request.number },
    );
    if (refreshed.failed.includes(request.number))
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Pull request status unavailable");
    row = await findPullRequest(input.query, request.kbId, request.number);
    if (!row || !isActivePrStatus(row.status)) break;
    const snapshot = await readMainSnapshot(input.query, request.kbId);
    if (snapshot && row.mergeCheckedKey === mergeabilityKey(snapshot, row, input.canonicalOrigin)) {
      currentCheck = true;
      break;
    }
  }
  if (!row) throw missing();
  const repo = kbBareRepoPath(input.reposDir, request.kbId);
  const binding = {
    actorKey: actorKeyFor(input.principal),
    kbId: request.kbId,
    // Base, head, target, status and version are pinned in the cursor itself:
    // a PR moved onto main keeps serving the snapshot its first page showed.
    filterHash: stableFilterHash({ number: row.number }),
    sortKey: "pr:diff",
    revision: "*",
  };
  const pin = request.page?.cursor ? input.cursorSigner.verify(request.page.cursor, binding) : null;
  const headSha = pin?.revision ?? row.headSha;
  if (!pin && isActivePrStatus(row.status) && !currentCheck)
    // Never an unchecked status as current: the merge planner could not run.
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Pull request status unavailable");
  // Git readers and the protocol require SHA-1. Pack its 20 raw bytes as
  // canonical base64url so a grant actor and a 512-byte path fit the cursor.
  // `<target>:<status>:<base>:<version in base36>:<after>` pins one snapshot.
  const snapshot = pin?.lastKey?.match(
    /^([A-Za-z0-9_-]{27}):([OCXM]):([A-Za-z0-9_-]{27}):([0-9a-z]+):([fa]:[\s\S]+)$/,
  );
  const targetSha = pin
    ? snapshot && Buffer.from(snapshot[1]!, "base64url").toString("hex")
    : isActivePrStatus(row.status)
      ? row.mergeCheckedSha!
      : row.targetSha;
  const baseSha = pin
    ? snapshot && Buffer.from(snapshot[3]!, "base64url").toString("hex")
    : row.baseSha;
  const version = pin ? (snapshot ? Number.parseInt(snapshot[4]!, 36) : NaN) : row.version;
  if (
    !/^[a-f0-9]{40}$/.test(headSha) ||
    !targetSha ||
    !/^[a-f0-9]{40}$/.test(targetSha) ||
    !baseSha ||
    !/^[a-f0-9]{40}$/.test(baseSha) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    (pin &&
      (!snapshot ||
        Buffer.from(targetSha, "hex").toString("base64url") !== snapshot[1] ||
        Buffer.from(baseSha, "hex").toString("base64url") !== snapshot[3] ||
        version.toString(36) !== snapshot[4]))
  )
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const status = snapshot ? STATUS_OF_CODE[snapshot[2]!]! : row.status;
  if (request.expectedHeadSha && request.expectedHeadSha !== headSha) throw stale();
  const page = await diffAtRevisions({
    ...options,
    repoPath: repo,
    baseSha,
    headSha,
    limit: request.page?.limit ?? 20,
    after: snapshot?.[5],
  });
  await readAuth(input, request.kbId);
  assertGitReadActive(options);
  return {
    pr: {
      ...toPrSummary(row),
      baseSha,
      headSha,
      targetSha,
      status,
      version,
      // A snapshot pinned while active never shows a merge that happened later.
      mergeCommitSha: isActivePrStatus(status) ? null : row.mergeCommitSha,
    },
    files: page.files,
    touchedAssets: page.touchedAssets,
    nextCursor: page.nextAfter
      ? input.cursorSigner.sign({
          ...binding,
          revision: headSha,
          v: 1,
          lastKey: `${Buffer.from(targetSha, "hex").toString("base64url")}:${CODE_OF_STATUS[status]}:${Buffer.from(baseSha, "hex").toString("base64url")}:${version.toString(36)}:${page.nextAfter}`,
          exp: pin?.exp ?? cursorExpiry(),
        })
      : null,
  };
}

export type PrMergeDelta = {
  kind: "pr_merge";
  number: number;
  version: number;
  headSha: string;
  targetSha: string;
  quotaReservationIds: string[];
};
export async function applyPrMergeDelta(query: LockQuery, intent: IntentRow) {
  const delta = intent.preparedDelta as PrMergeDelta;
  if (delta?.kind !== "pr_merge" || !intent.kbId)
    throw new OperationIntentError("INVALID_STATE", "Invalid PR merge delta");
  const result = await query(
    `UPDATE pull_request SET status='MERGED',"mergeCommitSha"=$3,"mergedByActorKey"=$4,"targetSha"=$5,version=version+1,"updatedAt"=now()
    WHERE "kbId"=$1 AND number=$2 AND version=$6 AND status IN ('OPEN','CONFLICT')`,
    [intent.kbId, delta.number, delta.headSha, intent.actorKey, delta.targetSha, delta.version],
  );
  if (result.rowCount !== 1)
    throw new OperationIntentError("INVALID_STATE", "PR merge state changed");
  await query(`UPDATE knowledge_base SET "headSha"=$2,"updatedAt"=now() WHERE id=$1`, [
    intent.kbId,
    delta.headSha,
  ]);
  await scheduleIndexBuild(query, intent.kbId);
  if (delta.quotaReservationIds.length)
    await commitQuota({ transactionQuery: query }, delta.quotaReservationIds);
  await recordAuditEvent(query, {
    ...intent,
    action: "pr_merge",
    outcome: "SUCCESS",
    revision: delta.headSha,
    metadata: { headSha: delta.headSha },
  });
  const row = await findPullRequest(query, intent.kbId, delta.number);
  if (!row) throw missing();
  return {
    responseBody: { operationId: intent.opId, pr: toPrSummary(row) },
    resultRevision: delta.headSha,
  };
}

/** Shared browser/domain publication entry. Authority -> KB -> quota locks; Git CAS
 * occurs only after durable COMMITTING and authority release, retaining the KB lease. */
export function createPullRequestPublication(input: {
  canonicalOrigin?: string;
  store: LiveAuthorityStore;
  principal: Principal;
  verifier?: CredentialVerifier;
  reposDir: string;
  request: PrMutationRequest;
  ratePort?: RatePort;
  diskMeter?: DiskMeter;
  barrier?: PublicationBarrier;
  signal?: AbortSignal;
}): {
  barrier: AuthorityBarrier;
  publish(lease: HeldLockLease, executor: GitMutatingExecutor): Promise<PrResult>;
} {
  const { kind, ...body } = input.request;
  const request: PrMutationRequest =
    kind === "create"
      ? { kind, ...kbWriteToolSchemas.knowledge_pull_requests_create.input.parse(body) }
      : { kind, ...kbWriteToolSchemas.knowledge_pull_requests_review.input.parse(body) };
  const kbId = request.kbId;
  const actorKey = actorKeyFor(input.principal);
  const operation =
    request.kind === "create"
      ? "PR_CREATE"
      : request.decision === "merge"
        ? "PR_MERGE"
        : "PR_CLOSE";
  const requestHash = canonicalRequestHash(request);
  const lookup = { actorKey, kbId, operation, idempotencyKey: request.idempotencyKey };
  const repo = kbBareRepoPath(input.reposDir, kbId);
  let held: HeldLockLease | undefined;
  let row: PullRequestRow | null = null;
  let intent: IntentRow | null = null;
  let receipt: PrResult | undefined;
  let reserved = false;
  let plan: Awaited<ReturnType<typeof planReviewedMerge>> | undefined;
  let validation: Omit<TreeValidationOptions, "repoPath"> | undefined;
  let createStatus:
    | { status: "OPEN" | "CONFLICT"; checkedSha: string; epoch: string; key: string }
    | undefined;
  async function admission(query: LockQuery) {
    const auth = await authorize({
      store: input.store,
      principal: input.principal,
      verifier: input.verifier,
      kbId,
      operation: request.kind === "create" ? "propose" : "read",
      query,
    });
    if (auth.state !== "ACTIVE")
      throw new KbDomainError("REPAIR_REQUIRED", "Knowledge base requires repair");
    if (input.principal.kind === "token" && !tokenHasOauthScope(input.principal.scopes, true))
      throw new KbDomainError("FORBIDDEN", "Forbidden");
    if (request.kind === "review") {
      row = await findPullRequest(query, kbId, request.number);
      if (!row) throw missing();
      assertReviewPermission(
        auth.bits,
        await sameActorPerson(query, actorKey, input.principal.userId, row.authorActorKey),
        request.decision,
      );
    }
  }
  function readOptions(): GitReadOptions {
    if (!held) throw new Error("PR lease required");
    return {
      signal: input.signal ? AbortSignal.any([input.signal, held.scope.signal]) : held.scope.signal,
      deadlineAt: held.scope.deadlineAt,
    };
  }
  async function expected() {
    const options = readOptions();
    const ref = request.kind === "create" ? `refs/heads/${request.headBranch}` : row!.sourceBranch;
    const currentTargetSha = await readRefShaAsync(repo, "refs/heads/main", options);
    const currentHeadSha = await readRefShaAsync(repo, ref, options);
    const targetMoved = currentTargetSha !== request.expectedTargetSha;
    const headMoved =
      currentHeadSha !== request.expectedHeadSha ||
      (row !== null && row.headSha !== request.expectedHeadSha);
    if (targetMoved || headMoved)
      throw new PrConflictError(
        "Reviewed revision changed",
        {
          kind: "revision_moved",
          targetMoved,
          headMoved,
          currentTargetSha: currentTargetSha ?? null,
          currentHeadSha: currentHeadSha ?? null,
        },
        {
          headSha: currentHeadSha ?? request.expectedHeadSha,
          proposalNumber: row?.number ?? null,
        },
      );
  }
  return {
    barrier: {
      async prepare(lease) {
        lease.assertHeldKb(kbId);
        held = lease;
        await admission(lease.query);
        if (
          (await lease.transaction((q) =>
            reconcileKbIntents(q, input.reposDir, kbId, readOptions()),
          )) === "repair_required"
        )
          throw new KbDomainError("REPAIR_REQUIRED", "Knowledge base requires repair");
        intent = await findOperationIntent(lease.query, lookup);
        if (intent) {
          if (intent.requestHash !== requestHash)
            throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "Request body mismatch");
          if (intent.phase !== "FINALIZED")
            throw new KbDomainError("CONFLICT", "Publication was not completed");
          receipt = kbWriteToolSchemas.knowledge_pull_requests_review.output.parse(
            intent.responseBody,
          );
          return;
        }
        if (input.ratePort) await chargeKbMutation(input.ratePort, actorKey, kbId);
        if (request.kind === "create") {
          const ref = `refs/heads/${request.headBranch}`;
          if (request.headBranch === "main" || request.headBranch.startsWith("pr/"))
            throw new KbDomainError("FORBIDDEN", "Owned user branch required");
          try {
            await runGitAsync(repo, ["check-ref-format", ref], readOptions());
          } catch {
            assertGitReadActive(readOptions());
            throw new KbDomainError("INVALID_ARGUMENT", "Invalid branch");
          }
          const owner = await loadBranchOwner(lease.query, kbId, ref);
          // The person owns their branches, whichever credential pushed them.
          if (
            owner?.purpose !== "USER" ||
            !(await sameActorPerson(
              lease.query,
              actorKey,
              input.principal.userId,
              owner.ownerActorKey,
            ))
          )
            throw new KbDomainError("FORBIDDEN", "Owned user branch required");
          const existing = await lease.query(
            `SELECT number FROM pull_request WHERE "kbId"=$1 AND "sourceBranch"=$2 LIMIT 1`,
            [kbId, ref],
          );
          if (existing.rowCount)
            throw new KbDomainError("CONFLICT", "Branch already has a pull request");
        } else if (!row || !isActivePrStatus(row.status)) throw stateChanged();
        await expected();
        if (request.kind === "create") {
          // A new PR's first status is checked against main, never assumed.
          const snapshot = await readMainSnapshot(lease.query, kbId);
          if (snapshot?.mainHead !== request.expectedTargetSha)
            throw new KbDomainError("STORAGE_UNAVAILABLE", "Pull request status unavailable");
          createStatus = {
            status: await proposalMergeStatus({
              ...readOptions(),
              query: lease.query,
              reposDir: input.reposDir,
              kbId,
              canonicalOrigin: input.canonicalOrigin,
              mainHead: request.expectedTargetSha,
              headSha: request.expectedHeadSha,
              dream: null,
            }),
            checkedSha: snapshot.mainHead,
            epoch: snapshot.epoch,
            key: mergeabilityKey(
              snapshot,
              { headSha: request.expectedHeadSha, version: 1 },
              input.canonicalOrigin,
            ),
          };
        }
        if (request.kind === "review" && request.decision === "merge") {
          // The same validation the status check uses (one planner, one context).
          validation = await reviewedMergeValidation({
            ...readOptions(),
            query: lease.query,
            kbId,
            repoPath: repo,
            canonicalOrigin: input.canonicalOrigin,
            mainHead: request.expectedTargetSha,
            headSha: request.expectedHeadSha,
          });
          plan = await planReviewedMerge({
            ...readOptions(),
            scratchRoot: input.reposDir,
            admitScratch: async (opId, bytes) => {
              const quota = await lease.transaction((query) =>
                reserveQuota(
                  { transactionQuery: query },
                  {
                    opId,
                    charges: [],
                    disks: [
                      {
                        path: input.reposDir,
                        bytes,
                        meter: input.diskMeter ?? statfsDiskMeter(input.reposDir),
                      },
                    ],
                    expiresAt: new Date(Date.now() + 3600000),
                  },
                ),
              );
              return () =>
                lease.transaction(
                  (query) => releaseQuota({ transactionQuery: query }, quota.reservationIds),
                  false,
                );
            },
            repoPath: repo,
            mainHead: request.expectedTargetSha,
            sourceHead: request.expectedHeadSha,
            dream: row!.dreamMetadata,
            pendingConflicts: row!.pendingConflicts,
            proposalNumber: row!.number,
            validation,
            // A readable merge commit naming the PR, plus who merged it.
            message: withTrailer(
              `Merge #${row!.number}: ${row!.title}`,
              await actedByTrailer(lease.query, actorKey),
            ),
          });
          if (plan.commitSha !== request.expectedTargetSha) {
            const merge = plan;
            const opId = randomUUID();
            const written: string[] = [];
            try {
              intent = await lease.transaction(async (query) => {
                const bytes = await stagedNewObjectBytesAsync(repo, merge.objects, readOptions());
                const quota =
                  bytes.physicalBytes > 0n
                    ? await reserveQuota(
                        { transactionQuery: query },
                        {
                          opId,
                          charges: [
                            {
                              dimension: "KB_HISTORY_BYTES",
                              subjectId: kbId,
                              amount: bytes.physicalBytes,
                            },
                          ],
                          disks: [
                            {
                              path: input.reposDir,
                              bytes: bytes.diskFloorBytes,
                              meter: input.diskMeter ?? statfsDiskMeter(input.reposDir),
                            },
                          ],
                          expiresAt: new Date(Date.now() + 3600000),
                          heldForPublication: true,
                        },
                      )
                    : { reservationIds: [] };
                const next = await reservePublicationIntent(query, {
                  ...lookup,
                  opId,
                  requestHash,
                  actorUserIdSnapshot: input.principal.userId,
                  actorUserId: input.principal.userId,
                  refName: "refs/heads/main",
                  oldRef: request.expectedTargetSha,
                  newRef: merge.commitSha,
                  preparedDelta: {
                    kind: "pr_merge",
                    number: row!.number,
                    version: row!.version,
                    headSha: merge.commitSha,
                    targetSha: request.expectedTargetSha,
                    quotaReservationIds: quota.reservationIds,
                  },
                });
                await writeStagedObjectsAsync(repo, merge.objects, written, readOptions());
                return next;
              });
            } catch (error) {
              // Only a confirmed rollback proves no intent references these
              // objects; an uncertain COMMIT leaves them for journal recovery.
              if (isRolledBackTransactionError(error)) await removeLooseObjectsAsync(repo, written);
              throw error;
            }
          }
        }
        await input.barrier?.afterPrepared?.();
      },
      async reauthorize({ query }) {
        await admission(query);
      },
      async reservePublication(context) {
        assertAuthorityReservation(context, kbId);
        if (receipt) return;
        await expected();
        if (intent) {
          const result = await context.query(
            `UPDATE operation_intent SET phase='COMMITTING',"updatedAt"=now() WHERE "opId"=$1 AND phase='PREPARED'`,
            [intent.opId],
          );
          if (result.rowCount !== 1)
            throw new OperationIntentError("INVALID_STATE", "Intent is not prepared");
          reserved = true;
          return;
        }
        const query = context.query;
        const opId = randomUUID();
        if (request.kind === "create") {
          let baseSha: string;
          try {
            baseSha = (
              await runGitAsync(
                repo,
                ["merge-base", request.expectedTargetSha, request.expectedHeadSha],
                readOptions(),
              )
            ).stdout
              .toString()
              .trim();
          } catch {
            assertGitReadActive(readOptions());
            throw stale();
          }
          const number = await allocateNextPrNumber(query, kbId);
          if (!createStatus)
            throw new OperationIntentError("INVALID_STATE", "missing validated proposal status");
          await upsertPullRequestHead(query, {
            kbId,
            number,
            title: request.title,
            sourceBranch: `refs/heads/${request.headBranch}`,
            baseSha,
            headSha: request.expectedHeadSha,
            targetSha: request.expectedTargetSha,
            authorActorKey: actorKey,
            isAutoPr: false,
            version: 1,
            mergeStatus: createStatus,
          });
          row = await findPullRequest(query, kbId, number);
        } else {
          const merged = request.decision === "merge";
          const result = await query(
            `UPDATE pull_request SET status=$3::"PullRequestStatus","mergeCommitSha"=$4,"mergedByActorKey"=$5,"targetSha"=$6,version=version+1,"updatedAt"=now() WHERE "kbId"=$1 AND number=$2 AND status IN ('OPEN','CONFLICT')`,
            [
              kbId,
              row!.number,
              merged ? "MERGED" : "CLOSED",
              merged ? request.expectedTargetSha : null,
              merged ? actorKey : null,
              request.expectedTargetSha,
            ],
          );
          if (result.rowCount !== 1) throw stateChanged();
          row = await findPullRequest(query, kbId, row!.number);
        }
        if (!row) throw missing();
        receipt = { operationId: opId, pr: toPrSummary(row) };
        await recordAuditEvent(query, {
          opId,
          action: operation.toLowerCase(),
          outcome: "SUCCESS",
          actorKey,
          actorUserIdSnapshot: input.principal.userId,
          actorUserId: input.principal.userId,
          kbId,
          revision: request.expectedHeadSha,
        });
        await recordFinalizedReceipt(query, {
          ...lookup,
          actorUserId: input.principal.userId,
          requestHash,
          opId,
          responseBody: receipt,
        });
      },
    },
    async publish(lease, executor) {
      if (lease !== held)
        throw new OperationIntentError(
          "INVALID_STATE",
          "Publication requires its reservation lease",
        );
      lease.assertHeldKb(kbId);
      lease.assertCanReceiveNetworkBody("publish PR merge");
      if (receipt) {
        await admission(lease.query);
        return receipt;
      }
      if (!reserved || !intent || !plan)
        throw new OperationIntentError("INVALID_STATE", "Publication was not reserved");
      await input.barrier?.afterCommitting?.();
      await fsyncRefUpdate(
        { reposDir: input.reposDir, kbId, executor },
        {
          refName: "refs/heads/main",
          oldSha: request.expectedTargetSha,
          newSha: plan.commitSha,
          binding: bindValidatedTreeForPublication(plan.validation, plan.commitSha),
          validation,
          readOptions: readOptions(),
        },
      );
      await input.barrier?.afterRefUpdate?.();
      const finalized = await lease.transaction((q) => finalizeIntent(q, intent!.opId));
      await input.barrier?.afterDbFinalize?.();
      await admission(lease.query);
      return kbWriteToolSchemas.knowledge_pull_requests_review.output.parse(finalized.responseBody);
    },
  };
}

export function mutatePullRequest(
  runtime: KbRuntimeConfig,
  actor: string | Principal,
  request: PrMutationRequest,
  verifier?: CredentialVerifier,
  signal?: AbortSignal,
) {
  const principal = typeof actor === "string" ? { kind: "browser" as const, userId: actor } : actor;
  const publication = createPullRequestPublication({
    store: prismaAuthorityStore(runtime.prisma),
    principal,
    verifier,
    reposDir: runtime.reposDir,
    canonicalOrigin: runtime.canonicalOrigin,
    request,
    ratePort: runtime.ratePort,
    diskMeter: runtime.diskMeter,
    signal,
  });
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [request.kbId],
    barrier: publication.barrier,
    run: (ctx) => {
      const executor = runtime.createGitExecutor?.(ctx, request.kbId);
      if (!executor) throw new KbDomainError("INTERNAL", "Git executor unavailable");
      return publication.publish(ctx.lease, executor);
    },
  });
}

/** One path an open PR still has to resolve, for the browser's PR page and editor. */
export type PrConflictPath = {
  path: string;
  kind: ConflictItem["kind"];
  /** Recorded on the PR by an earlier move onto main (else found against current main). */
  recorded: boolean;
  /** Main's own entry, in the way of other conflicts' choices: it resolves with them. */
  standing: boolean;
  /** The revisions its base, main ("theirs") and PR ("yours") versions are read at. */
  baseSha: string;
  theirsSha: string;
  yoursSha: string;
};

const byPathKind = (a: { path: string; kind: string }, b: { path: string; kind: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;

/**
 * R3-W6: every path an open PR still has to resolve against current main,
 * typed (document or asset), with the revisions each version is read at so
 * the editor can show base, main's and the PR's versions. The recorded
 * conflicts plus what the logical merge finds now, the same union a move
 * onto main records. Bounded like a PROPOSAL_CONFLICT (`truncated` past it).
 */
export async function getPullRequestConflicts(
  input: ReadInput,
  request: { kbId: string; number: number },
  /** Test seam: runs after each status refresh, before the row is read. */
  hooks: { afterRefresh?: () => Promise<void> } = {},
): Promise<{
  status: PullRequestRow["status"];
  headSha: string;
  targetSha: string;
  /** A dream PR is pinned to its own main: it is never moved or resolved. */
  isDream: boolean;
  paths: PrConflictPath[];
  truncated: boolean;
}> {
  const options = gitReadOptions(input);
  assertGitReadActive(options);
  await readAuth(input, request.kbId);
  /** Every successful answer re-checks authority and the deadline last. */
  const finish = async <T>(value: T): Promise<T> => {
    await readAuth(input, request.kbId);
    assertGitReadActive(options);
    return value;
  };
  const unavailable = () =>
    new KbDomainError("STORAGE_UNAVAILABLE", "Pull request status unavailable");
  // One authoritative check: the status is made current against the
  // current main snapshot (retrying when main moves under the check) and the
  // paths are computed against that very main; a failed check is an
  // operational failure, never a cached answer.
  let row: PullRequestRow | null = null;
  let checked: string | null = null;
  for (let attempt = 0; attempt < MERGEABILITY_ATTEMPTS && checked === null; attempt += 1) {
    const refreshed = await refreshPrMergeability(
      { ...input, ...options },
      { kbId: request.kbId, number: request.number },
    );
    if (refreshed.failed.includes(request.number)) throw unavailable();
    await hooks.afterRefresh?.();
    row = await findPullRequest(input.query, request.kbId, request.number);
    if (!row) throw missing();
    if (!isActivePrStatus(row.status)) break;
    const snapshot = await readMainSnapshot(input.query, request.kbId);
    if (snapshot && row.mergeCheckedKey === mergeabilityKey(snapshot, row, input.canonicalOrigin))
      checked = snapshot.mainHead;
  }
  if (!row) throw missing();
  const current = row;
  const isDream = current.dreamMetadata !== null;
  const none = (targetSha: string) => ({
    status: current.status,
    headSha: current.headSha,
    targetSha,
    isDream,
    paths: [],
    truncated: false,
  });
  if (!isActivePrStatus(current.status)) return finish(none(current.targetSha));
  if (checked === null) throw unavailable();
  const recorded = Array.isArray(current.pendingConflicts) ? current.pendingConflicts : [];
  // A PR that merges into the checked main has nothing to resolve.
  if (current.status === "OPEN") return finish(none(checked));
  const snapshot = { mainHead: checked };
  row = current;
  const repoPath = kbBareRepoPath(input.reposDir, request.kbId);
  const merged = await mergeProposalOntoMain({
    ...options,
    repoPath,
    mainHead: snapshot.mainHead,
    proposalHead: row.headSha,
    readFiles: false,
    recorded,
    scratchRoot: input.reposDir,
  });
  let mergeBase = merged.mergeBase ?? null;
  const baseOf = async () => {
    mergeBase ??= (
      await runGitAsync(repoPath, ["merge-base", snapshot.mainHead, row.headSha], options)
    ).stdout
      .toString()
      .trim();
    return mergeBase;
  };
  const byKey = new Map<string, PrConflictPath>();
  for (const item of recorded)
    byKey.set(`${item.kind}\0${item.path}`, {
      path: item.path,
      kind: item.kind,
      recorded: true,
      standing: item.standing === true,
      baseSha: item.baseSha ?? (await baseOf()),
      theirsSha: snapshot.mainHead,
      yoursSha: item.yoursSha ?? row.headSha,
    });
  for (const item of merged.conflicts) {
    const key = `${item.kind}\0${item.path}`;
    const prior = byKey.get(key);
    if (prior) {
      // A fresh finding of a recorded conflict as a real one lifts "standing".
      if (!item.standing) prior.standing = false;
      continue;
    }
    byKey.set(key, {
      path: item.path,
      kind: item.kind,
      recorded: false,
      standing: item.standing === true,
      baseSha: await baseOf(),
      theirsSha: snapshot.mainHead,
      yoursSha: row.headSha,
    });
  }
  const paths = [...byKey.values()].sort(byPathKind);
  return finish({
    status: row.status,
    headSha: row.headSha,
    targetSha: snapshot.mainHead,
    isDream,
    paths: paths.slice(0, PROPOSAL_CONFLICT_MAX_PATHS),
    truncated: paths.length > PROPOSAL_CONFLICT_MAX_PATHS,
  });
}

/**
 * R3-W6: the viewer's own open automatic PR (opened from any of their
 * credentials or the web) when it changes the document at `path`, so the
 * editor can offer the PR's version instead of silently editing main's.
 */
export async function findViewerProposalForPath(
  input: ReadInput & { userId: string },
  request: { kbId: string; path: string },
): Promise<{
  number: number;
  status: PullRequestRow["status"];
  headSha: string;
  isDream: boolean;
} | null> {
  const options = gitReadOptions(input);
  assertGitReadActive(options);
  await readAuth(input, request.kbId);
  /** Every answer, `null` included, re-checks authority and the deadline last. */
  const finish = async <T>(value: T): Promise<T> => {
    await readAuth(input, request.kbId);
    assertGitReadActive(options);
    return value;
  };
  const row = await findActiveAutoPrForActor(
    input.query,
    request.kbId,
    `user:${input.userId}`,
    input.userId,
  );
  if (!row) return finish(null);
  const changed = await changedLogicalPaths(
    kbBareRepoPath(input.reposDir, request.kbId),
    row.baseSha,
    row.headSha,
    options,
  );
  if (!changed.some((item) => item.kind === "document" && item.path === request.path))
    return finish(null);
  return finish({
    number: row.number,
    status: row.status,
    headSha: row.headSha,
    isDream: row.dreamMetadata !== null,
  });
}
