import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { actedByTrailer, sameActorPerson, withTrailer } from "./actors";
import { invalidArgument, pathExists, treeFailureDetails } from "./argument-reasons";
import { assetValidationContext, authorizeAssetImport, manifestAtCommitAsync } from "./asset-authz";
import {
  type AssetDelta,
  type AssetImportRequest,
  finalizeAssetDelta,
  prepareAssetChanges,
  publishAssetBytes,
} from "./assets";
import { recordAuditEvent, recordAuditFailure } from "./audit";
import { type AuthorityBarrier, type AuthorityBarrierContext } from "./authority-lock";
import { insertBranchOwner, loadBranchOwner, PR_BRANCH_PREFIX } from "./branch-owner";
import { type PlannedChange, walkGitTreeAtCommit } from "./changes-plan";
import {
  type DreamChangesApplyRequest,
  type DreamMetadata,
  dreamGuardTouchedPathsForUpserts,
  dreamUpsertsToPlannedChanges,
  formatDreamCommitMessage,
  mergePersistedDreamMetadata,
  type PersistedDreamMetadata,
  parseDreamChangesApplyRequest,
  scanDreamRequestForSensitive,
} from "./dream";
import { KbDomainError } from "./errors";
import { scheduleIndexBuild } from "./generations";
import {
  type GitReadOptions,
  kbBareRepoPath,
  readCommitBlobsAsync,
  readRefShaAsync,
  runGitAsync,
} from "./git-read";
import {
  bindValidatedTreeForPublication,
  fsyncRefUpdate,
  type GitMutatingExecutor,
  removeLooseObjects,
  writeStagedObjectsAsync,
} from "./git-write";
import { chargeKbMutation } from "./limits";
import { type HeldLockLease, isRolledBackTransactionError, type LockQuery } from "./lock";
import { remainingConflicts } from "./logical-merge";
import {
  abortIntent,
  canonicalRequestHash,
  finalizeIntent,
  type IntentRow,
  OperationIntentError,
  type PublicationBarrier,
  reauthorizeChangesReplay,
  reconcileKbIntents,
  recordFinalizedReceipt,
  replayFinalizedIntent,
  reservePublicationIntent,
  settleAbortedIntentQuota,
} from "./operation-intent";
import { casefoldPathKey, normalizeKbPath } from "./paths";
import { authorize, type LiveAuthorityStore } from "./permissions";
import {
  type ConflictItem,
  mergeProposalOntoMain,
  proposalChangedPaths,
  proposalConflictError,
} from "./pr-merge";
import {
  actorKeyFor,
  type CredentialVerifier,
  demandToolGroups,
  KbAdmissionError,
  type Principal,
} from "./principal";
import {
  allocateNextPrNumber,
  assertPrMutable,
  findActiveAutoPrForActor,
  findPullRequest,
  isActivePrStatus,
  mergeabilityKey,
  type PullRequestRow,
  refForNewAutoPr,
  toPrSummary,
  upsertPullRequestHead,
} from "./proposals";
import type { ApplyWarning, changeSchema, textInputSchema } from "./protocol/common";
import { TOO_MANY_CHANGES_MESSAGE } from "./protocol/envelope";
import {
  CHANGES_APPLY_MAX_CHANGES,
  changesApplyRequestSchema,
  kbWriteToolSchemas,
} from "./protocol/writes";
import { proposalMergeStatus, readMainSnapshot, refreshPrMergeability } from "./pull-requests";
import {
  commitQuota,
  type DiskMeter,
  lockReservationVolumes,
  type QuotaCharge,
  releaseQuota,
  reserveQuota,
  statfsDiskMeter,
} from "./quota";
import { loadSealedTreeValidator } from "./sealed-reference";
import { stageCommitWithTreeFiles, stagedNewObjectBytes } from "./staged-tree";
import type { TreeValidationOptions, TreeValidationSuccess } from "./validate-tree";
import { validateGitCommitAsync, validateStagedCommitTree } from "./validate-tree";

export const CHANGES_APPLY_OPERATION = "CHANGES_APPLY";
export const DOCUMENT_CREATE_OPERATION = "DOCUMENT_CREATE";
export const DOCUMENT_UPDATE_OPERATION = "DOCUMENT_UPDATE";
export const DOCUMENT_DELETE_OPERATION = "DOCUMENT_DELETE";

export type Change = z.infer<typeof changeSchema>;
export type TextInput = z.infer<typeof textInputSchema>;

export type ApplyResult = {
  operationId: string;
  kind: "applied" | "proposed" | "noop";
  commitSha: string;
  baseRevision: string;
  proposal: ReturnType<typeof toPrSummary> | null;
  changedPaths: string[];
  sourceSessionIds: string[];
  indexJobId: string | null;
  warnings?: ApplyWarning[];
};

export type ChangesApplyPreparedDelta = {
  kind: "changes_apply";
  headSha: string;
  baseRevision: string;
  resultKind: ApplyResult["kind"];
  changedPaths: string[];
  sourceSessionIds: string[];
  targetRef: string;
  updatesMain: boolean;
  proposalNumber: number | null;
  proposalTitle: string | null;
  proposalVersion: number | null;
  isAutoPr: boolean;
  branchBaseSha: string | null;
  /** Committed on finalize; abort retains history charges and releases unused capacity. */
  quotaReservationIds: string[];
  dreamMetadata?: PersistedDreamMetadata | null;
  assets?: AssetDelta;
  /** Whether the new proposal head applies to main, decided under the KB lock. */
  mergeStatus?: { status: "OPEN" | "CONFLICT"; checkedSha: string; epoch: string; key: string };
  /** The PR's unresolved conflicts after this publication. */
  pendingConflicts?: ConflictItem[];
  /** L-22: replayed with the receipt. */
  warnings?: ApplyWarning[];
};

/** The JSON pointer naming change `index`'s path or content in the tool arguments. */
export type ChangeFieldPointer = (
  index: number,
  key: "path" | "content" | "markdown",
) => string | undefined;
/** `markdown` names inline text (`content/markdown`), the same pointers `kb mcp` reports. */
const changeField = (key: "path" | "content" | "markdown") =>
  key === "markdown" ? "content/markdown" : key;
const defaultChangeField: ChangeFieldPointer = (index, key) =>
  `/changes/${index}/${changeField(key)}`;
/** Single-document tools name their own top-level `path` / `content`. */
export const documentToolField: ChangeFieldPointer = (_index, key) => `/${changeField(key)}`;

/** The conflicts a PR recorded and has not resolved yet. */
function pendingConflictsOf(pr: PullRequestRow): ConflictItem[] {
  return Array.isArray(pr.pendingConflicts) ? pr.pendingConflicts : [];
}

/** Recorded conflicts plus newly found ones, one per path and kind (the newer finding wins). */
function unionConflicts(
  recorded: readonly ConflictItem[],
  found: readonly ConflictItem[],
): ConflictItem[] {
  const key = (item: ConflictItem) => `${item.kind}\0${item.path}`;
  const byKey = new Map(recorded.map((item) => [key(item), item]));
  for (const item of found) byKey.set(key(item), item);
  return [...byKey.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
}

/**
 * One classification of a publication request: what it is, every
 * logical path it writes with that path's kind (and which request field names
 * it), and whether a request against main may move the caller's open proposal
 * onto main. Rebase eligibility, the overwrite guard, conflict resolution,
 * ownership and field pointers read this — never the request's mode or shape.
 */
type PublicationOps = {
  kind: "edit" | "import" | "dream";
  /**
   * Every logical write, keyed by kind and path (`writeKey`): a document and an
   * asset may share a path. Each carries the index of the change naming it.
   */
  writes: ReadonlyMap<string, { kind: ConflictItem["kind"]; path: string; index: number | null }>;
  mayRebase: boolean;
};

const ASSET_OPS: ReadonlySet<string> = new Set(["assetPut", "assetRemove"]);
/** The identity of a logical write: its kind and its path. */
const writeKey = (kind: ConflictItem["kind"], path: string) => `${kind}\0${path}`;

/**
 * Classify a request. `resolved` are the changes the request expands to when
 * they are not its own (a dream's upserts); an import writes its one asset path.
 */
function classifyPublication(
  request: ChangesApplyRequest | AssetImportRequest,
  resolved: readonly { op: string; path: string }[] = [],
): PublicationOps {
  const writes = new Map<
    string,
    { kind: ConflictItem["kind"]; path: string; index: number | null }
  >();
  const write = (path: string, kind: ConflictItem["kind"], index: number | null) => {
    const normalized = normalizeKbPath(path);
    if (normalized.ok)
      writes.set(writeKey(kind, normalized.path), { kind, path: normalized.path, index });
  };
  if (request.mode === "import") {
    write(request.path, "asset", 0);
    return { kind: "import", writes, mayRebase: true };
  }
  const own = request.mode === "dream" ? [] : request.changes;
  for (const [index, change] of own.entries())
    write(change.path, ASSET_OPS.has(change.op) ? "asset" : "document", index);
  for (const change of request.mode === "dream" ? resolved : [])
    write(change.path, ASSET_OPS.has(change.op) ? "asset" : "document", null);
  // A dream proposal is pinned to the main it was generated against.
  return request.mode === "dream"
    ? { kind: "dream", writes, mayRebase: false }
    : { kind: "edit", writes, mayRebase: true };
}

/**
 * The caller's own open proposal whose head is `headSha`, if any: the
 * exact actor's, else (`userId`: the person owns the PR) one opened by
 * the same person's web session or any of their credentials. Ownership is
 * filtered in SQL before the bound, so other people's proposals at the same
 * head can never hide the caller's own.
 */
async function findActiveProposalAtHead(
  query: LockQuery,
  kbId: string,
  headSha: string,
  actorKey: string,
  /** The person, for the match; null keeps the lookup to this actor (dreams). */
  userId: string | null,
): Promise<PullRequestRow | null> {
  const number = (
    await query<{ number: number }>(
      `SELECT pr.number FROM pull_request pr
         JOIN branch_owner bo ON bo."kbId" = pr."kbId" AND bo."refName" = pr."sourceBranch"
        WHERE pr."kbId"=$1 AND pr."headSha"=$2 AND pr.status IN ('OPEN','CONFLICT')
          AND (bo."ownerActorKey" = $3
               OR ($4::text IS NOT NULL
                   AND (bo."ownerActorKey" = 'user:' || $4
                        OR bo."ownerActorKey" IN (SELECT 'grant:' || g.id::text FROM mcp_grant g
                                                   WHERE g."userId" = $4))))
        ORDER BY (bo."ownerActorKey" = $3) DESC, pr.number DESC LIMIT 1`,
      [kbId, headSha, actorKey, userId],
    )
  ).rows[0]?.number;
  return number === undefined ? null : await findPullRequest(query, kbId, number);
}

/** Ancestry on the canonical repository (exit 1 = not an ancestor), cancellable. */
async function isAncestorCommit(
  repoPath: string,
  ancestor: string,
  descendant: string,
  options: GitReadOptions,
): Promise<boolean> {
  const { exitCode } = await runGitAsync(
    repoPath,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { ...options, resultExitCodes: [1] },
  );
  return exitCode !== 1;
}

type AssetValidation = Pick<TreeValidationOptions, "trustedBlobs" | "lineageHashes">;
function unionAssetValidation(a: AssetValidation, b: AssetValidation): AssetValidation {
  return {
    trustedBlobs: new Map([...(a.trustedBlobs ?? []), ...(b.trustedBlobs ?? [])]),
    lineageHashes: new Set([...(a.lineageHashes ?? []), ...(b.lineageHashes ?? [])]),
  };
}

export type ChangesApplyEditRequest = {
  mode: "edit";
  baseRevision: string;
  title: string;
  changes: Change[];
  sourceSessionIds: string[];
  proposalNumber?: number;
  /** The PR head the caller read (precondition). */
  proposalHeadSha?: string;
};

export type ChangesApplyRequest = ChangesApplyEditRequest | DreamChangesApplyRequest;

/**
 * Images the web editor staged while editing (R3-W7): each finished
 * asset upload joins the document's own save as an `assetPut`, so one
 * commit (or one PR update) holds the document and the images it links,
 * and an abandoned edit commits nothing.
 */
export type DocumentStagedAsset = { path: string; uploadId: string };

/** Most staged images one save carries: the change-set bound less the document itself. */
export const DOCUMENT_STAGED_ASSETS_MAX = 7;

export type DocumentMutationRequest =
  | {
      operation: typeof DOCUMENT_CREATE_OPERATION;
      path: string;
      content: TextInput;
      idempotencyKey: string;
      assets?: readonly DocumentStagedAsset[];
    }
  | {
      operation: typeof DOCUMENT_UPDATE_OPERATION;
      path: string;
      content: TextInput;
      idempotencyKey: string;
      assets?: readonly DocumentStagedAsset[];
    }
  | { operation: typeof DOCUMENT_DELETE_OPERATION; path: string; idempotencyKey: string };

function documentChangesFromRequest(request: DocumentMutationRequest): Change[] {
  if (request.operation === DOCUMENT_DELETE_OPERATION) {
    return [{ op: "delete", path: request.path }];
  }
  return [
    {
      op: request.operation === DOCUMENT_CREATE_OPERATION ? "create" : "replace",
      path: request.path,
      content: request.content,
    },
    ...(request.assets ?? []).map(
      (asset): Change => ({ op: "assetPut", path: asset.path, uploadId: asset.uploadId }),
    ),
  ];
}

/** "Update notes.md", or "Update notes.md, add 2 assets" when images join the save. */
function documentSaveTitle(changes: readonly Change[]): string {
  const [document, ...assets] = changes;
  if (!document) return changeSummaryTitle(changes);
  const own = changeSummaryTitle([document]);
  if (assets.length === 0) return own;
  return boundedTitle(`${own}, add ${assets.length === 1 ? "1 asset" : `${assets.length} assets`}`);
}

const CHANGE_VERB: Record<Change["op"], string> = {
  create: "Create",
  replace: "Update",
  delete: "Delete",
  assetPut: "Add asset",
  assetRemove: "Remove asset",
};
const TITLE_MAX = 200;

/**
 * Commit message / proposal title for edits that carry no caller title:
 * "Update runbooks/postgres-failover.md" for one change, a counted summary
 * ("Update 3 documents", "Change 4 files") for several. Bounded like a
 * caller-supplied `title`.
 */
export function changeSummaryTitle(changes: readonly Pick<Change, "op" | "path">[]): string {
  const [first] = changes;
  if (!first) return "Update documents";
  let title: string;
  if (changes.length === 1) {
    title = `${CHANGE_VERB[first.op]} ${first.path}`;
  } else {
    const documentsOnly = changes.every((change) => !change.op.startsWith("asset"));
    const noun = documentsOnly ? "documents" : "files";
    const sameOp = changes.every((change) => change.op === first.op);
    title =
      sameOp && documentsOnly
        ? `${CHANGE_VERB[first.op]} ${changes.length} ${noun}`
        : `Change ${changes.length} ${noun}`;
  }
  return boundedTitle(title);
}

/** A generated commit message / proposal title, cut like a caller `title` (≤ 200 scalars). */
export function boundedTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= TITLE_MAX ? title : `${chars.slice(0, TITLE_MAX - 1).join("")}…`;
}

function operationForDocument(request: DocumentMutationRequest): string {
  return request.operation;
}

function requestHashForDocument(
  kbId: string,
  baseRevision: string,
  request: DocumentMutationRequest & { proposalNumber?: number; proposalHeadSha?: string },
): string {
  return canonicalRequestHash({ kbId, baseRevision, ...request });
}

async function markChangesIntentCommitting(
  context: AuthorityBarrierContext,
  store: LiveAuthorityStore,
  principal: Principal,
  kbId: string,
  opId: string,
  verifier?: CredentialVerifier,
): Promise<void> {
  await authorizeMutation(store, principal, kbId, context.query, verifier);
  const updated = await context.query(
    `UPDATE "operation_intent"
        SET phase = 'COMMITTING'::"OperationIntentPhase", "updatedAt" = now()
      WHERE "opId" = $1 AND phase = 'PREPARED'::"OperationIntentPhase"`,
    [opId],
  );
  if (updated.rowCount === 1) return;
  const current = await context.query<{ phase: string }>(
    `SELECT phase::text AS phase FROM "operation_intent" WHERE "opId" = $1`,
    [opId],
  );
  if (current.rows[0]?.phase === "COMMITTING") return;
  throw new OperationIntentError("INVALID_STATE", "intent is not prepared");
}

async function authorizeMutation(
  store: LiveAuthorityStore,
  principal: Principal,
  kbId: string,
  query: LockQuery,
  verifier?: CredentialVerifier,
): Promise<{ canWrite: boolean }> {
  try {
    const proposeAuth = await authorize({
      store,
      principal,
      kbId,
      operation: "propose",
      query,
      verifier,
    });
    if (proposeAuth.state !== "ACTIVE") {
      throw new OperationIntentError(
        "REPAIR_REQUIRED",
        `knowledge base state ${proposeAuth.state} does not admit changes`,
      );
    }
    let canWrite = false;
    try {
      const writeAuth = await authorize({
        store,
        principal,
        kbId,
        operation: "write",
        query,
        verifier,
      });
      canWrite = writeAuth.state === "ACTIVE";
    } catch (error) {
      if (!(error instanceof KbAdmissionError) || error.code !== "FORBIDDEN") throw error;
    }
    return { canWrite };
  } catch (error) {
    if (error instanceof KbAdmissionError) {
      throw error;
    }
    throw error;
  }
}

export async function applyChangesApplyDelta(
  query: LockQuery,
  intent: IntentRow,
): Promise<{ responseBody: Record<string, unknown>; resultRevision: string }> {
  const delta = intent.preparedDelta as ChangesApplyPreparedDelta;
  if (delta?.kind !== "changes_apply") {
    throw new OperationIntentError("INVALID_STATE", "unexpected prepared delta");
  }
  if (delta.assets) await finalizeAssetDelta(query, intent, delta.assets);
  let indexJobId: string | null = null;
  if (delta.updatesMain) {
    await query(
      `UPDATE "knowledge_base"
          SET "headSha" = $2,
              "updatedAt" = now()
        WHERE id = $1`,
      [intent.kbId, delta.headSha],
    );
    indexJobId = (await scheduleIndexBuild(query, intent.kbId!))?.jobId ?? null;
  }
  if (delta.proposalNumber !== null && delta.proposalTitle && delta.branchBaseSha) {
    const sourceBranch = delta.targetRef;
    await insertBranchOwner(query, {
      kbId: intent.kbId!,
      refName: sourceBranch,
      ownerActorKey: intent.actorKey,
      purpose: delta.isAutoPr ? "AUTO_PR" : "USER",
    });
    const targetSha = (
      await query<{ headSha: string | null }>(
        `SELECT "headSha" FROM "knowledge_base" WHERE id = $1`,
        [intent.kbId],
      )
    ).rows[0]?.headSha;
    if (!targetSha) throw new OperationIntentError("INVALID_STATE", "missing main head");
    if (!delta.mergeStatus)
      throw new OperationIntentError("INVALID_STATE", "missing validated proposal status");
    await upsertPullRequestHead(query, {
      kbId: intent.kbId!,
      number: delta.proposalNumber,
      title: delta.proposalTitle,
      sourceBranch,
      baseSha: delta.branchBaseSha,
      headSha: delta.headSha,
      targetSha,
      authorActorKey: intent.actorKey,
      isAutoPr: delta.isAutoPr,
      version: delta.proposalVersion ?? 1,
      dreamMetadata: delta.dreamMetadata !== undefined ? delta.dreamMetadata : null,
      mergeStatus: delta.mergeStatus,
      pendingConflicts: delta.pendingConflicts ?? [],
    });
  }
  if (delta.proposalNumber !== null) {
    await recordAuditEvent(query, {
      opId: intent.opId,
      action: (delta.proposalVersion ?? 1) === 1 ? "pr_create" : "pr_source_advance",
      outcome: "SUCCESS",
      actorKey: intent.actorKey,
      actorUserIdSnapshot: intent.actorUserIdSnapshot,
      actorUserId: intent.actorUserId,
      kbId: intent.kbId,
      revision: delta.headSha,
      metadata: { headSha: delta.headSha },
    });
  }
  // Exactly-once handoff of the held reservations: COMMITTED is idempotent and
  // a replayed finalize never reaches this code path from FINALIZED.
  const stagingReservations =
    delta.assets?.uploads.flatMap((upload) => upload.reservationIds) ?? [];
  // Lock the union before either settlement, including different repo/assets
  // filesystems. Staging is already materialized and may have expired quota;
  // releasing it is idempotent, whereas publication's held quota is committed.
  await lockReservationVolumes(query, [...delta.quotaReservationIds, ...stagingReservations]);
  await releaseQuota({ transactionQuery: query }, stagingReservations);
  if (delta.quotaReservationIds.length)
    await commitQuota({ transactionQuery: query }, delta.quotaReservationIds);
  await recordAuditEvent(query, {
    opId: intent.opId,
    action: "changes_apply",
    outcome: "SUCCESS",
    actorKey: intent.actorKey,
    actorUserIdSnapshot: intent.actorUserIdSnapshot,
    actorUserId: intent.actorUserId,
    kbId: intent.kbId,
    revision: delta.headSha,
    metadata: { headSha: delta.headSha, reasonCode: `changes_${delta.resultKind}` },
  });
  const proposal =
    delta.proposalNumber !== null
      ? await findPullRequest(query, intent.kbId!, delta.proposalNumber)
      : null;
  const responseBody: ApplyResult = {
    operationId: intent.opId,
    kind: delta.resultKind,
    commitSha: delta.headSha,
    baseRevision: delta.baseRevision,
    proposal: proposal ? toPrSummary(proposal) : null,
    changedPaths: delta.changedPaths,
    sourceSessionIds: delta.sourceSessionIds,
    indexJobId,
    ...(delta.warnings?.length ? { warnings: delta.warnings } : {}),
  };
  return { responseBody, resultRevision: delta.headSha };
}

/**
 * How a request against current main reaches the caller's open proposal
 * move it onto main, resolve some of its recorded conflicts, or (a PR
 * already on main with none recorded) apply on its head.
 */
type RebaseStep = "onto-main" | "resolve" | "on-head";

type PublicationPlan = {
  preparedDelta: ChangesApplyPreparedDelta;
  oldRef: string;
  newRef: string;
  refName: string;
  noop: boolean;
  binding?: TreeValidationSuccess;
  validation?: Omit<TreeValidationOptions, "repoPath">;
  /** Loose objects this plan materialized; reclaimed if the transaction aborts. */
  writtenObjectShas: string[];
};

async function planPublication(input: {
  reposDir: string;
  kbId: string;
  actorKey: string;
  opId: string;
  request: ChangesApplyRequest | AssetImportRequest;
  /** The request's one classification. */
  ops: PublicationOps;
  canWrite: boolean;
  diskMeter: DiskMeter;
  query: LockQuery;
  commitMessage?: string;
  dreamMetadata?: DreamMetadata | null;
  /** Receives the loose objects this plan creates, for abort reclamation. */
  reclaim: { written: string[] };
  assetsDir?: string;
  canonicalOrigin?: string;
  prepareAssets(): ReturnType<typeof prepareAssetChanges>;
  /** The publication lease's deadline/cancellation, for the proposal rebase. */
  gitOptions: GitReadOptions;
  /** The person behind `actorKey` (they own the proposals any of their credentials opened). */
  actorUserId: string;
  fieldFor?: ChangeFieldPointer;
}): Promise<PublicationPlan> {
  const repoPath = kbBareRepoPath(input.reposDir, input.kbId);
  const fieldFor = input.fieldFor ?? defaultChangeField;
  const mainHead = await readRefShaAsync(repoPath, "refs/heads/main", input.gitOptions);
  if (!mainHead) throw new OperationIntentError("NOT_FOUND", "missing git head");

  const baseRevision = input.request.baseRevision;
  let targetRef = "refs/heads/main";
  let proposalNumber: number | null = null;
  let isAutoPr = false;
  let branchBaseSha: string | null = null;
  const proposalTitle = input.request.title;
  let proposalVersion = 1;
  let pendingNewAutoPr = false;
  // Proposing against current main moves an open proposal onto main
  // (same number, new base; its earlier changes replayed). Conflicts it cannot
  // settle are recorded on the PR and resolved progressively: every later
  // proposal against main (or at the PR head) resolving at least one of them
  // advances it, and the PR stays CONFLICT until none remain.
  let selected: PullRequestRow | null = null;
  let rebase: { pr: PullRequestRow; step: RebaseStep } | null = null;
  const continueProposal = async (pr: PullRequestRow, message: string) => {
    selected = pr;
    // The PR head the caller read: a PR that moved since is a stale read,
    // whatever main did (two editors of one PR never overwrite each other).
    const observed = input.request.proposalHeadSha;
    if (observed !== undefined && observed !== pr.headSha)
      throw new KbDomainError("CONFLICT", "proposal head moved", undefined, {
        headSha: pr.headSha,
        proposalNumber: pr.number,
      });
    if (baseRevision === pr.headSha) return;
    // Naming a PR against main (a deliberate overwrite of its paths) needs
    // the head that choice was made on.
    if (input.request.proposalNumber !== undefined && observed === undefined)
      throw invalidArgument(
        "proposalHeadSha is required against main",
        "MISSING_ARGUMENT",
        "/proposalHeadSha",
      );
    if (
      input.ops.mayRebase &&
      baseRevision === mainHead &&
      pr.headSha !== mainHead &&
      !pr.dreamMetadata
    ) {
      // Main moved past the proposal's base: move it onto main.
      if (!(await isAncestorCommit(repoPath, mainHead, pr.headSha, input.gitOptions))) {
        rebase = { pr, step: "onto-main" };
        return;
      }
      // Already on main with recorded conflicts: this request resolves some.
      if (pendingConflictsOf(pr).length > 0) {
        rebase = { pr, step: "resolve" };
        return;
      }
      // Already on main with nothing recorded (R3-W6): the edit applies on
      // the PR head. Main's version of a path the PR did not change is the
      // PR's own, so only a path the PR changed can be overwritten, which
      // the same guard as a move onto main refuses.
      rebase = { pr, step: "on-head" };
      return;
    }
    // A stale read of the proposal (or a dream, pinned to its own main).
    throw new KbDomainError("CONFLICT", message, undefined, {
      headSha: pr.headSha,
      proposalNumber: pr.number,
    });
  };

  /** The person owns the proposal; a dream stays with the exact actor. */
  const ownsProposal = async (pr: PullRequestRow) => {
    const owner = await loadBranchOwner(input.query, input.kbId, pr.sourceBranch);
    return (
      owner !== null &&
      (input.ops.kind === "dream"
        ? owner.ownerActorKey === input.actorKey
        : await sameActorPerson(
            input.query,
            input.actorKey,
            input.actorUserId,
            owner.ownerActorKey,
          ))
    );
  };
  const selectProposal = async (pr: PullRequestRow, message: string) => {
    await continueProposal(pr, message);
    targetRef = pr.sourceBranch;
    proposalNumber = pr.number;
    branchBaseSha = pr.baseSha;
    proposalVersion = pr.version + 1;
    isAutoPr = pr.isAutoPr;
  };
  // The target is what the caller edits, never just their permission level:
  // a named proposal, else (write holders) their own proposal whose head they
  // edit at, else main for write holders and their automatic PR otherwise.
  const atOwnHead =
    input.request.proposalNumber === undefined && input.canWrite && baseRevision !== mainHead
      ? await findActiveProposalAtHead(
          input.query,
          input.kbId,
          baseRevision,
          input.actorKey,
          input.ops.kind === "dream" ? null : input.actorUserId,
        )
      : null;
  if (input.request.proposalNumber !== undefined) {
    const pr = await findPullRequest(input.query, input.kbId, input.request.proposalNumber);
    if (!pr) throw new KbDomainError("NOT_FOUND", "proposal not found");
    if (!isActivePrStatus(pr.status)) {
      // The caller's own PR was closed or merged since they read it: the
      // same precondition answer as a moved head (continue on current main).
      // Anyone else's terminal PR stays invisible.
      if (!(await ownsProposal(pr))) throw new KbDomainError("NOT_FOUND", "proposal not found");
      throw new KbDomainError("CONFLICT", "proposal is no longer open", undefined, {
        headSha: mainHead,
        proposalNumber: null,
      });
    }
    assertPrMutable(pr);
    if (!(await ownsProposal(pr))) {
      throw new KbDomainError("FORBIDDEN", "proposal is not owned by this actor");
    }
    await selectProposal(pr, "base revision does not match proposal head");
  } else if (atOwnHead) {
    assertPrMutable(atOwnHead);
    await selectProposal(atOwnHead, "base revision does not match proposal head");
  } else if (input.canWrite) {
    if (baseRevision !== mainHead) {
      throw new KbDomainError("CONFLICT", "base revision does not match main head", undefined, {
        headSha: mainHead,
        proposalNumber: null,
      });
    }
  } else {
    const existing = await findActiveAutoPrForActor(
      input.query,
      input.kbId,
      input.actorKey,
      input.ops.kind === "dream" ? null : input.actorUserId,
    );
    if (existing) {
      await continueProposal(existing, "base revision does not match active proposal head");
      proposalNumber = existing.number;
      targetRef = existing.sourceBranch;
      branchBaseSha = existing.baseSha;
      proposalVersion = existing.version + 1;
      isAutoPr = true;
    } else {
      if (baseRevision !== mainHead) {
        throw new KbDomainError(
          "CONFLICT",
          "first proposed edit must target current main",
          undefined,
          { headSha: mainHead, proposalNumber: null },
        );
      }
      pendingNewAutoPr = true;
      branchBaseSha = mainHead;
      isAutoPr = true;
    }
  }

  // A PR head was read but no open PR of the caller's is the target any
  // more (closed, merged, or never theirs): nothing to continue.
  if (input.request.proposalHeadSha !== undefined && selected === null)
    throw new KbDomainError("CONFLICT", "proposal is no longer open", undefined, {
      headSha: mainHead,
      proposalNumber: null,
    });
  const step = rebase as { pr: PullRequestRow; step: RebaseStep } | null;
  const rebasing = step?.pr ?? null;
  const updating = selected as PullRequestRow | null;
  // A rebased proposal replaces its branch head: the ref must still be the PR head.
  const expectedRef = rebasing ? rebasing.headSha : baseRevision;
  if (!pendingNewAutoPr) {
    const existingRef = await readRefShaAsync(repoPath, targetRef, input.gitOptions);
    const oldRefCheck =
      existingRef ??
      (targetRef.startsWith(PR_BRANCH_PREFIX) && baseRevision === mainHead
        ? "0000000000000000000000000000000000000000"
        : null);
    if (!oldRefCheck || (existingRef && existingRef !== expectedRef)) {
      throw new KbDomainError("CONFLICT", "base revision is stale");
    }
    if (!existingRef && baseRevision !== mainHead) {
      throw new KbDomainError("CONFLICT", "base revision is stale");
    }
  }

  let baseFiles: Map<string, Buffer> | undefined;
  // The tree the edit applies to and the commit it follows: main for a move
  // onto main, the PR head for a resolution step or a stacked edit.
  let treeRevision = baseRevision;
  let parentSha = baseRevision;
  // Only a write of the same kind and path resolves a conflict.
  const writes = input.ops.writes;
  const writesItem = (item: { kind: ConflictItem["kind"]; path: string }) =>
    writes.has(writeKey(item.kind, item.path));
  let pending = updating ? pendingConflictsOf(updating) : [];
  let proposalPaths: { path: string; kind: ConflictItem["kind"] }[] = [];
  if (step?.step === "onto-main") {
    const merged = await mergeProposalOntoMain({
      ...input.gitOptions,
      repoPath,
      mainHead,
      proposalHead: step.pr.headSha,
      readFiles: true,
      recorded: pending,
      scratchRoot: input.reposDir,
    });
    // Conflicts still recorded from an earlier main stay (their paths keep
    // the proposal's version, so a merge would not see them); new ones join.
    // A recorded conflict keeps the revisions its saved choice lives at (the
    // PR head now holds only its provisional version); a fresh finding of it
    // as a real conflict lifts "standing".
    const recordedByKey = new Map(pending.map((item) => [writeKey(item.kind, item.path), item]));
    pending = unionConflicts(
      pending,
      merged.conflicts.map((item): ConflictItem => {
        const prior = recordedByKey.get(writeKey(item.kind, item.path));
        if (prior) {
          if (item.standing || !prior.standing) return prior;
          const { standing: _lifted, ...real } = prior;
          return real;
        }
        return { ...item, baseSha: merged.mergeBase ?? undefined, yoursSha: step.pr.headSha };
      }),
    );
    baseFiles = merged.files ?? undefined;
    parentSha = mainHead;
    proposalPaths = merged.proposalPaths ?? [];
  } else if (updating) {
    // Every selected PR uses the same overwrite consent check, including
    // writes based directly on its head.
    treeRevision = updating.headSha;
    parentSha = updating.headSha;
    if (input.request.proposalNumber === undefined || input.request.proposalHeadSha === undefined)
      proposalPaths = await proposalChangedPaths(
        repoPath,
        mainHead,
        updating.headSha,
        input.gitOptions,
      );
  }
  const { resolved, unresolved, remaining } = remainingConflicts(pending, writesItem);
  if (updating) {
    // One consent rule: a request may overwrite a path
    // the caller's PR changed — a plain change, a fresh conflict or a
    // recorded one, document or asset — only by naming the PR with the head
    // it read (`proposalNumber` + `proposalHeadSha`, checked above). Without
    // that, every such write clashes and nothing is applied.
    const named =
      input.request.proposalNumber !== undefined && input.request.proposalHeadSha !== undefined;
    const protectedItems = new Map<string, ConflictItem>();
    for (const item of pending) protectedItems.set(writeKey(item.kind, item.path), item);
    for (const item of proposalPaths)
      if (!protectedItems.has(writeKey(item.kind, item.path)))
        protectedItems.set(writeKey(item.kind, item.path), { path: item.path, kind: item.kind });
    const overwritten = named ? [] : [...protectedItems.values()].filter(writesItem);
    // A request against main must make progress on what clashes.
    if ((pending.length > 0 && resolved.length === 0) || overwritten.length > 0) {
      const listed = new Map<string, ConflictItem>();
      for (const item of [...overwritten, ...unresolved])
        listed.set(writeKey(item.kind, item.path), item);
      throw await proposalConflictError({
        ...input.gitOptions,
        repoPath,
        mainHead,
        proposalNumber: updating.number,
        proposalHead: updating.headSha,
        paths: [...listed.values()],
      });
    }
  }
  const resolving = {
    documents: new Set(resolved.filter((i) => i.kind === "document").map((i) => i.path)),
    assets: new Set(resolved.filter((i) => i.kind === "asset").map((i) => i.path)),
  };

  const assetPlan = await input.prepareAssets();
  // A rebased proposal keeps the assets it added: trust its head's manifest too.
  const assetValidation = rebasing
    ? unionAssetValidation(
        assetPlan.validation,
        await assetValidationContext(
          input.query,
          input.kbId,
          (await manifestAtCommitAsync(repoPath, rebasing.headSha, input.gitOptions)).map(
            (entry) => entry.hash,
          ),
        ),
      )
    : assetPlan.validation;
  const durableObjects = new Set<string>();
  const validation: Omit<TreeValidationOptions, "repoPath"> = {
    ...assetValidation,
    validateSealedReferences: await loadSealedTreeValidator(
      input.query,
      input.kbId,
      input.canonicalOrigin,
    ),
    // L-8: only paths this write changes (against the tree it applies to)
    // need live sealed records.
    baseBlobs: await readCommitBlobsAsync(repoPath, treeRevision, input.gitOptions, durableObjects),
  };
  const planned = await walkGitTreeAtCommit({
    gitOptions: input.gitOptions,
    repoPath,
    baseRevision: treeRevision,
    changes: assetPlan.resolved as PlannedChange[],
    assetEntries: assetPlan.assetEntries,
    baseFiles,
    resolving,
  });
  if (!planned.ok) {
    const original =
      planned.changeIndex === undefined || !("changes" in input.request)
        ? undefined
        : input.request.changes[planned.changeIndex];
    const inline =
      original !== undefined &&
      "content" in original &&
      typeof original.content === "object" &&
      "markdown" in original.content;
    const field =
      planned.changeIndex === undefined
        ? undefined
        : fieldFor(
            planned.changeIndex,
            planned.key === "content" && inline ? "markdown" : (planned.key ?? "path"),
          );
    throw planned.reason === "PATH_EXISTS"
      ? pathExists(planned.message, field)
      : invalidArgument(planned.message, planned.reason, field);
  }

  if (pendingNewAutoPr) {
    if (planned.noop) {
      proposalNumber = null;
      isAutoPr = false;
      targetRef = "refs/heads/main";
    } else {
      proposalNumber = await allocateNextPrNumber(input.query, input.kbId);
      targetRef = refForNewAutoPr(proposalNumber);
    }
  }

  const existingRef =
    pendingNewAutoPr && planned.noop
      ? null
      : await readRefShaAsync(repoPath, targetRef, input.gitOptions);
  const oldRef =
    pendingNewAutoPr && planned.noop
      ? baseRevision
      : (existingRef ??
        (targetRef.startsWith(PR_BRANCH_PREFIX) && baseRevision === mainHead
          ? "0000000000000000000000000000000000000000"
          : null));
  if (!(pendingNewAutoPr && planned.noop)) {
    if (!oldRef || (existingRef && existingRef !== expectedRef)) {
      throw new KbDomainError("CONFLICT", "base revision is stale");
    }
    if (!existingRef && baseRevision !== mainHead && !pendingNewAutoPr) {
      throw new KbDomainError("CONFLICT", "base revision is stale");
    }
  }

  const updatesMain = targetRef === "refs/heads/main";
  const resultKind: ApplyResult["kind"] = planned.noop
    ? "noop"
    : updatesMain
      ? "applied"
      : "proposed";

  // Reserve capacity before any object write. The candidate commit is staged
  // and whole-tree-validated entirely in memory first, so a rejected tree —
  // duplicate document ids, path collisions, sealed references — never
  // materializes durable, uncharged Git objects in the canonical repository.
  // History is charged exactly what materializing the staged set adds (the
  // deflated bytes of objects with no loose file yet); disk admission uses the
  // same sum block-rounded. One branch slot is reserved for a newly allocated
  // proposal branch. Noops reserve nothing. A failure rolls the whole planning
  // transaction — including the PR-number allocation — back with it.
  let quotaReservationIds: string[] = [];
  const writtenObjectShas = input.reclaim.written;
  const newBranch = pendingNewAutoPr && !planned.noop;
  // A noop names the revision it was evaluated on: the target ref's head (a
  // request against main may reach the caller's PR, R3-W6), never just the
  // request's base.
  let headSha = planned.noop && oldRef ? oldRef : baseRevision;
  let binding: TreeValidationSuccess | undefined;
  if (!planned.noop) {
    const staged = stageCommitWithTreeFiles({
      parentSha,
      // A move onto main keeps the proposal's previous head as a second parent,
      // so every recorded conflict's versions stay reachable and readable.
      extraParents: step?.step === "onto-main" ? [step.pr.headSha] : [],
      // Git keeps the system author; the trailer names who acted and how.
      message: withTrailer(
        step?.step === "onto-main"
          ? `Move proposal #${step.pr.number} onto main: ${step.pr.title}`
          : (input.commitMessage ?? input.request.title),
        await actedByTrailer(input.query, input.actorKey),
      ),
      files: planned.files,
    });
    const stagedValidation = validateStagedCommitTree(staged, validation);
    if (!stagedValidation.ok) {
      const details = treeFailureDetails(stagedValidation, (path, key) => {
        // The first change writing that path, of either kind.
        const index =
          path === undefined
            ? null
            : ([...writes.values()]
                .filter(
                  (write) =>
                    (write.path === path ||
                      casefoldPathKey(write.path) === casefoldPathKey(path) ||
                      casefoldPathKey(write.path).startsWith(`${casefoldPathKey(path)}/`)) &&
                    write.index !== null,
                )
                .map((write) => write.index!)
                .sort((a, b) => a - b)[0] ?? null);
        return index === null ? undefined : fieldFor(index, key);
      });
      throw invalidArgument(stagedValidation.message, details.reason, details.field);
    }
    const { physicalBytes, diskFloorBytes } = stagedNewObjectBytes(repoPath, staged.objects);
    const charges: QuotaCharge[] = [...assetPlan.charges];
    if (physicalBytes > 0n) {
      charges.push({
        dimension: "KB_HISTORY_BYTES",
        subjectId: input.kbId,
        amount: physicalBytes,
      });
    }
    if (newBranch) {
      charges.push({ dimension: "KB_BRANCH", subjectId: input.kbId, amount: 1n });
    }
    const quota = await reserveQuota(
      { transactionQuery: input.query },
      {
        opId: input.opId,
        charges,
        disks: [
          { path: input.reposDir, bytes: diskFloorBytes, meter: input.diskMeter },
          ...(input.assetsDir && assetPlan.delta.uploads.length
            ? [
                {
                  path: input.assetsDir,
                  bytes: assetPlan.casBytes,
                  meter: statfsDiskMeter(input.assetsDir),
                },
              ]
            : []),
        ],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        heldForPublication: true,
      },
    );
    quotaReservationIds = quota.reservationIds;
    await writeStagedObjectsAsync(
      repoPath,
      staged.objects,
      writtenObjectShas,
      input.gitOptions,
      durableObjects,
    );
    headSha = staged.commitSha;
    const proposed = await validateGitCommitAsync(
      { repoPath, ...validation, ...input.gitOptions },
      headSha,
    );
    if (!proposed.ok) throw new Error(proposed.message);
    binding = proposed;
  }

  const newRef = planned.noop ? oldRef : headSha;
  let deltaDreamMetadata: PersistedDreamMetadata | undefined;
  if (input.dreamMetadata) {
    const touched = await dreamGuardTouchedPathsForUpserts({
      ...input.gitOptions,
      repoPath,
      baseRevision,
      // Existence baseline is the proposal's immutable original main base, so
      // a path created inside the proposal reads as new, not deleted-on-main.
      guardBaseRevision: branchBaseSha ?? baseRevision,
      dream: input.dreamMetadata,
    });
    let existing: PersistedDreamMetadata | DreamMetadata | null = null;
    if (proposalNumber !== null) {
      const pr = await findPullRequest(input.query, input.kbId, proposalNumber);
      existing = pr?.dreamMetadata ?? null;
    }
    deltaDreamMetadata = mergePersistedDreamMetadata(existing, input.dreamMetadata, touched);
  }
  // A receipt never reports an unchecked proposal status. The new head
  // (its objects already written) is checked by the reviewed-merge planner
  // against the main snapshot this lock holds, exactly as a read would.
  let mergeStatus: ChangesApplyPreparedDelta["mergeStatus"];
  if (!planned.noop && targetRef !== "refs/heads/main") {
    const snapshot = await readMainSnapshot(input.query, input.kbId);
    if (snapshot?.mainHead !== mainHead)
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Pull request status unavailable");
    // The dream metadata the PR will carry: this delta's, else the stored one.
    let dream: PullRequestRow["dreamMetadata"] = deltaDreamMetadata ?? null;
    if (!dream && proposalNumber !== null)
      dream =
        (await findPullRequest(input.query, input.kbId, proposalNumber))?.dreamMetadata ?? null;
    mergeStatus = {
      status: await proposalMergeStatus({
        ...input.gitOptions,
        query: input.query,
        reposDir: input.reposDir,
        kbId: input.kbId,
        canonicalOrigin: input.canonicalOrigin,
        mainHead,
        headSha,
        dream,
        pendingAssets: validation,
        pendingConflicts: remaining,
      }),
      checkedSha: mainHead,
      epoch: snapshot.epoch,
      key: mergeabilityKey(snapshot, { headSha, version: proposalVersion }, input.canonicalOrigin),
    };
  }
  const preparedDelta: ChangesApplyPreparedDelta = {
    kind: "changes_apply",
    headSha,
    baseRevision: input.request.baseRevision,
    resultKind,
    changedPaths: planned.changedPaths,
    sourceSessionIds: input.request.sourceSessionIds,
    targetRef,
    updatesMain,
    proposalNumber: updatesMain ? null : proposalNumber,
    proposalTitle: updatesMain ? null : proposalTitle,
    proposalVersion: updatesMain ? null : proposalVersion,
    isAutoPr: updatesMain ? false : isAutoPr,
    // A rebased proposal's new base is the main it moved onto.
    branchBaseSha: updatesMain ? null : step?.step === "onto-main" ? mainHead : branchBaseSha,
    // The conflicts this PR still has to resolve; none for a new PR.
    pendingConflicts: updatesMain ? [] : remaining,
    quotaReservationIds,
    assets: assetPlan.delta,
    ...(deltaDreamMetadata !== undefined ? { dreamMetadata: deltaDreamMetadata } : {}),
    ...(mergeStatus && !updatesMain ? { mergeStatus } : {}),
    ...(planned.warnings.length ? { warnings: planned.warnings } : {}),
  };

  return {
    preparedDelta,
    oldRef: oldRef!,
    newRef: newRef!,
    refName: targetRef,
    noop: planned.noop,
    binding,
    validation,
    writtenObjectShas,
  };
}

async function loadChangesIntent(
  query: LockQuery,
  where: {
    actorKey: string;
    kbId: string;
    operation: string;
    idempotencyKey: string;
  },
): Promise<IntentRow | null> {
  const rows = await query<IntentRow>(
    `SELECT "opId", "kbId", "reservedKbId", "actorKey", "actorUserIdSnapshot", "actorUserId",
            operation, "idempotencyKey", "requestHash", phase::text AS phase,
            "refName", "oldRef", "newRef", "preparedDelta", "responseBody",
            "resultRevision", "resultStatus", "publishNonce", "abortReason"
       FROM "operation_intent"
      WHERE "actorKey" = $1 AND "kbId" = $2 AND operation = $3 AND "idempotencyKey" = $4`,
    [where.actorKey, where.kbId, where.operation, where.idempotencyKey],
  );
  return rows.rows[0] ?? null;
}

export type ChangesPublicationInput = {
  canonicalOrigin?: string;
  store: LiveAuthorityStore;
  principal: Principal;
  verifier?: CredentialVerifier;
  reposDir: string;
  kbId: string;
  idempotencyKey: string;
  request: ChangesApplyRequest | AssetImportRequest;
  operation: string;
  requestHash: string;
  assetsDir?: string;
  blobStore?: import("./blob-store").BlobStore;
  ratePort?: import("./limits").RatePort;
  diskMeter?: DiskMeter;
  barrier?: PublicationBarrier;
  fieldFor?: ChangeFieldPointer;
};

/** A held lease's cancellation and deadline, for every Git read it performs. */
function leaseReadOptions(lease: HeldLockLease): GitReadOptions {
  return { signal: lease.scope.signal, deadlineAt: lease.scope.deadlineAt };
}

async function prepareChangesPublication(
  input: ChangesPublicationInput,
  lease: HeldLockLease,
): Promise<{ intent: IntentRow; fresh: boolean; plan?: PublicationPlan }> {
  const validatedRequest =
    input.request.mode === "import" ? input.request : buildChangesApplyRequest(input.request);
  if (validatedRequest.mode === "import") {
    const { mode: _mode, title: _title, sourceSessionIds: _sessions, ...raw } = validatedRequest;
    if (
      !kbWriteToolSchemas.knowledge_assets_import.input.safeParse(raw).success ||
      raw.kbId !== input.kbId
    )
      throw new KbDomainError("INVALID_ARGUMENT", "Invalid import request");
    lease.assertHeldKb(raw.source.kbId);
  }
  const actorKey = actorKeyFor(input.principal);
  const lookup = {
    actorKey,
    kbId: input.kbId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
  };
  const existing = await lease.query<IntentRow>(
    `SELECT "opId", "kbId", "reservedKbId", "actorKey", "actorUserIdSnapshot", "actorUserId",
            operation, "idempotencyKey", "requestHash", phase::text AS phase,
            "refName", "oldRef", "newRef", "preparedDelta", "responseBody",
            "resultRevision", "resultStatus", "publishNonce", "abortReason"
       FROM "operation_intent"
      WHERE "actorKey" = $1 AND "kbId" = $2 AND operation = $3 AND "idempotencyKey" = $4`,
    [actorKey, input.kbId, input.operation, input.idempotencyKey],
  );
  const intent = existing.rows[0] ?? null;
  if (intent && intent.requestHash !== input.requestHash) {
    throw new OperationIntentError("IDEMPOTENCY_MISMATCH", "request body mismatch");
  }
  if (intent?.phase === "FINALIZED" && intent.responseBody) return { intent, fresh: false };
  if (intent?.phase === "ABORTED") {
    throw new OperationIntentError("INTENT_CONFLICT", intent.abortReason ?? "aborted");
  }
  if (intent) {
    await lease.transaction((query) =>
      reconcileKbIntents(query, input.reposDir, input.kbId, leaseReadOptions(lease)),
    );
    const settled = await loadChangesIntent(lease.query, lookup);
    if (settled?.phase === "FINALIZED") return { intent: settled, fresh: false };
    throw new OperationIntentError("INTENT_CONFLICT", settled?.abortReason ?? "aborted");
  }

  const { canWrite } = await authorizeMutation(
    input.store,
    input.principal,
    input.kbId,
    lease.query,
    input.verifier,
  );
  const reconciliation = await lease.transaction((query) =>
    reconcileKbIntents(query, input.reposDir, input.kbId, leaseReadOptions(lease)),
  );
  if (reconciliation === "repair_required") {
    throw new OperationIntentError("REPAIR_REQUIRED", "knowledge base requires repair");
  }

  let resolved: Change[];
  let commitMessage: string | undefined;
  let dreamMetadata: DreamMetadata | null = null;
  if (validatedRequest.mode === "dream") {
    dreamMetadata = validatedRequest.dream;
    try {
      scanDreamRequestForSensitive(validatedRequest);
      resolved = (await dreamUpsertsToPlannedChanges({
        signal: lease.scope.signal,
        deadlineAt: lease.scope.deadlineAt,
        repoPath: kbBareRepoPath(input.reposDir, input.kbId),
        baseRevision: validatedRequest.baseRevision,
        dream: validatedRequest.dream,
      })) as Change[];
    } catch (error) {
      if (error instanceof KbDomainError && error.message.includes("credential pattern")) {
        await lease.transaction((query) =>
          recordAuditFailure(query, {
            action: "changes_apply",
            actorKey,
            actorUserIdSnapshot: input.principal.userId,
            actorUserId: input.principal.userId,
            kbId: input.kbId,
            metadata: { reasonCode: "dream_sensitive_rejected" },
          }),
        );
      }
      throw error;
    }
    commitMessage = formatDreamCommitMessage(
      validatedRequest.title,
      validatedRequest.sourceSessionIds,
      validatedRequest.dream,
    );
  } else {
    resolved = validatedRequest.mode === "import" ? [] : validatedRequest.changes;
  }
  if (input.ratePort) {
    await chargeKbMutation(input.ratePort, actorKey, input.kbId);
  }
  const diskMeter = input.diskMeter ?? statfsDiskMeter(input.reposDir);

  // One transaction owns the whole fresh reservation: quota charges, PR-number
  // allocation, durable loose objects, and the PREPARED intent either all
  // commit together or none do — a crash can never strand held quota with no
  // journaled intent to release it. If the transaction still fails after the
  // objects were written, reclaim exactly this operation's loose files only
  // after a confirmed rollback. An uncertain COMMIT may have journaled them.
  const opId = randomUUID();
  const repoPath = kbBareRepoPath(input.reposDir, input.kbId);
  const reclaim: { written: string[] } = { written: [] };
  const planning = lease.transaction(async (query) => {
    try {
      const imported =
        validatedRequest.mode === "import"
          ? {
              ...(await authorizeAssetImport({
                store: input.store,
                principal: input.principal,
                verifier: input.verifier,
                query,
                kbId: validatedRequest.source.kbId,
                operation: "read",
                reposDir: input.reposDir,
                rev: validatedRequest.source.rev,
                hash: validatedRequest.source.hash,
                ...leaseReadOptions(lease),
              })),
              path: validatedRequest.path,
              sourceKbId: validatedRequest.source.kbId,
              sourceRev: validatedRequest.source.rev,
            }
          : undefined;
      const plan = await planPublication({
        reposDir: input.reposDir,
        kbId: input.kbId,
        actorKey,
        opId,
        request: validatedRequest,
        ops: classifyPublication(validatedRequest, resolved),
        canWrite,
        diskMeter,
        query,
        commitMessage,
        dreamMetadata,
        reclaim,
        assetsDir: input.assetsDir,
        canonicalOrigin: input.canonicalOrigin,
        gitOptions: { signal: lease.scope.signal, deadlineAt: lease.scope.deadlineAt },
        actorUserId: input.principal.userId,
        fieldFor: input.fieldFor,
        prepareAssets: () =>
          prepareAssetChanges(
            query,
            {
              ...input,
              actorKey,
              opId,
              baseRevision: validatedRequest.baseRevision,
              gitOptions: { signal: lease.scope.signal, deadlineAt: lease.scope.deadlineAt },
            },
            resolved,
            imported,
          ),
      });
      if (plan.noop) {
        // The receipt names the proposal with a status checked against main.
        if (plan.preparedDelta.proposalNumber !== null) {
          const refreshed = await refreshPrMergeability(
            {
              query,
              reposDir: input.reposDir,
              canonicalOrigin: input.canonicalOrigin,
              signal: lease.scope.signal,
              deadlineAt: lease.scope.deadlineAt,
            },
            { kbId: input.kbId, number: plan.preparedDelta.proposalNumber, force: true },
          );
          if (refreshed.failed.length > 0)
            throw new KbDomainError("STORAGE_UNAVAILABLE", "Pull request status unavailable");
        }
        const proposal =
          plan.preparedDelta.proposalNumber !== null
            ? await findPullRequest(query, input.kbId, plan.preparedDelta.proposalNumber)
            : null;
        const responseBody: ApplyResult = {
          operationId: opId,
          kind: "noop",
          commitSha: plan.preparedDelta.headSha,
          baseRevision: validatedRequest.baseRevision,
          proposal: proposal ? toPrSummary(proposal) : null,
          changedPaths: [],
          sourceSessionIds: validatedRequest.sourceSessionIds,
          indexJobId: null,
        };

        await authorizeMutation(input.store, input.principal, input.kbId, query, input.verifier);
        if (plan.preparedDelta.assets) {
          await finalizeAssetDelta(
            query,
            {
              opId,
              kbId: input.kbId,
              actorKey,
              actorUserId: input.principal.userId,
              actorUserIdSnapshot: input.principal.userId,
            },
            plan.preparedDelta.assets,
          );
          await releaseQuota(
            { transactionQuery: query },
            plan.preparedDelta.assets.uploads.flatMap((upload) => upload.reservationIds),
          );
        }
        const receipt = await recordFinalizedReceipt(query, {
          actorKey,
          kbId: input.kbId,
          actorUserId: input.principal.userId,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          opId,
          responseBody,
        });
        return { plan, intent: receipt };
      }

      const intent = await reservePublicationIntent(query, {
        opId,
        kbId: input.kbId,
        actorKey,
        actorUserIdSnapshot: input.principal.userId,
        actorUserId: input.principal.userId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        refName: plan.refName,
        oldRef: plan.oldRef,
        newRef: plan.newRef,
        preparedDelta: plan.preparedDelta,
      });
      return { plan, intent };
    } catch (error) {
      removeLooseObjects(repoPath, reclaim.written);
      reclaim.written = [];
      throw error;
    }
  });
  const planned = await planning.catch((error: unknown) => {
    if (reclaim.written.length > 0 && isRolledBackTransactionError(error))
      removeLooseObjects(repoPath, reclaim.written);
    throw error;
  });
  const { plan } = planned;

  if (plan.noop) {
    await input.barrier?.afterDbFinalize?.();
    return { intent: planned.intent, fresh: false };
  }

  await input.barrier?.afterPrepared?.();
  return { intent: planned.intent!, fresh: true, plan };
}

/**
 * Asset writes need the `assets` tool group on top of whatever group the
 * calling tool holds: an import, or an `assetPut`/`assetRemove` change.
 */
function writesAssets(request: ChangesPublicationInput["request"]): boolean {
  if (request.mode === "import") return true;
  // Unvalidated here: any asset op in the raw changes counts.
  const changes: unknown = (request as { changes?: unknown }).changes;
  return (
    Array.isArray(changes) &&
    changes.some((change: unknown) => {
      const op = (change as { op?: unknown } | null)?.op;
      return typeof op === "string" && ASSET_OPS.has(op);
    })
  );
}

export function createChangesPublication(raw: ChangesPublicationInput): {
  barrier: AuthorityBarrier;
  publish(lease: HeldLockLease, gitExecutor: GitMutatingExecutor): Promise<Record<string, unknown>>;
} {
  // Carried by every authorization of this publication, including the
  // lock-held reauthorization and reservation, so a group removed while the
  // publication waits on a lock denies it.
  const input: ChangesPublicationInput = writesAssets(raw.request)
    ? { ...raw, principal: demandToolGroups(raw.principal, ["assets"]) }
    : raw;
  let prepared:
    | { intent: IntentRow; fresh: boolean; plan?: PublicationPlan; lease: HeldLockLease }
    | undefined;
  let reservationMade = false;
  return {
    barrier: {
      async prepare(lease) {
        lease.assertHeldKb(input.kbId);
        const result = await prepareChangesPublication(input, lease);
        prepared = { ...result, lease };
      },
      async reauthorize(context) {
        if (prepared && !prepared.fresh) {
          // A receipt replay publishes nothing: recheck with replay semantics (write or
          // propose, denial reported as UNAUTHORIZED) exactly as publish() replays it.
          await reauthorizeChangesReplay(
            input.store,
            input.principal,
            input.kbId,
            context.query,
            input.verifier,
          );
          return;
        }
        const authority = await authorizeMutation(
          input.store,
          input.principal,
          input.kbId,
          context.query,
          input.verifier,
        );
        if (prepared?.fresh && prepared.plan?.preparedDelta.updatesMain && !authority.canWrite) {
          throw new OperationIntentError("UNAUTHORIZED", "actor cannot publish main");
        }
        if (prepared?.fresh && input.request.mode === "import") {
          await authorizeAssetImport({
            store: input.store,
            principal: input.principal,
            verifier: input.verifier,
            query: context.query,
            reposDir: input.reposDir,
            kbId: input.request.source.kbId,
            operation: "read",
            rev: input.request.source.rev,
            hash: input.request.source.hash,
            // The reservation's cancellation within the lease's deadline.
            signal: context.signal,
            deadlineAt: prepared.lease.scope.deadlineAt,
          });
        }
      },
      async reservePublication(context: AuthorityBarrierContext) {
        if (!prepared?.fresh) return;
        await markChangesIntentCommitting(
          context,
          input.store,
          input.principal,
          input.kbId,
          prepared.intent.opId,
          input.verifier,
        );
        reservationMade = true;
      },
    },
    async publish(lease, gitExecutor) {
      if (!prepared || prepared.lease !== lease) {
        throw new OperationIntentError(
          "INVALID_STATE",
          "publication requires its reservation lease",
        );
      }
      lease.assertHeldKb(input.kbId);
      lease.assertCanReceiveNetworkBody("publish a Git ref");
      const { intent, fresh, plan } = prepared;
      if (!fresh)
        return replayFinalizedIntent(
          input.store,
          input.principal,
          intent,
          lease.query,
          input.verifier,
        );
      if (!reservationMade) {
        throw new OperationIntentError("INVALID_STATE", "publication was not reserved");
      }
      if (!plan?.noop && plan?.binding) {
        await input.barrier?.afterCommitting?.();
        if (
          plan.preparedDelta.assets?.uploads.length ||
          (input.blobStore?.backend === "s3" &&
            plan.preparedDelta.assets?.lineages.some((entry) => entry.sourceKbId))
        ) {
          if (!input.blobStore || !input.assetsDir)
            throw new KbDomainError("STORAGE_UNAVAILABLE", "Storage unavailable");
          try {
            await publishAssetBytes(
              lease,
              input.assetsDir,
              input.blobStore,
              intent,
              plan.preparedDelta.assets,
            );
          } catch (error) {
            // No ref update has started, and the store has joined its byte IO.
            // Settle now so a fresh operation can reuse READY staging immediately.
            // A lost lease/SQL acknowledgement leaves the existing fenced recovery.
            try {
              if (input.blobStore.backend === "s3")
                await lease.transaction(async (query) => {
                  await abortIntent(query, intent.opId, "asset publication failed");
                  await settleAbortedIntentQuota(
                    query,
                    intent.preparedDelta,
                    kbBareRepoPath(input.reposDir, input.kbId),
                  );
                });
            } catch {
              /* Durable intent remains recoverable. */
            }
            throw error;
          }
        }
        const binding = bindValidatedTreeForPublication(plan.binding, plan.newRef);
        await fsyncRefUpdate(
          { reposDir: input.reposDir, kbId: input.kbId, executor: gitExecutor },
          {
            refName: plan.refName,
            newSha: plan.newRef,
            oldSha: plan.oldRef,
            binding,
            validation: plan.validation,
            // Final validation and the ref CAS stay inside the lease's lifetime.
            readOptions: { signal: lease.scope.signal, deadlineAt: lease.scope.deadlineAt },
          },
        );
        await input.barrier?.afterRefUpdate?.();
      } else if (plan?.noop) {
        await input.barrier?.afterCommitting?.();
      }
      const finalized = await lease.transaction((query) => finalizeIntent(query, intent.opId));
      await input.barrier?.afterDbFinalize?.();
      return replayFinalizedIntent(
        input.store,
        input.principal,
        finalized,
        lease.query,
        input.verifier,
      );
    },
  };
}

export function buildChangesApplyRequest(body: ChangesApplyRequest): ChangesApplyRequest {
  if (Array.isArray(body.changes) && body.changes.length > CHANGES_APPLY_MAX_CHANGES) {
    throw invalidArgument(TOO_MANY_CHANGES_MESSAGE, "TOO_MANY_CHANGES", "/changes", {
      max: CHANGES_APPLY_MAX_CHANGES,
    });
  }
  if (body.mode === "dream") {
    return parseDreamChangesApplyRequest(body);
  }
  const parsed = changesApplyRequestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "invalid changes apply request";
    throw new KbDomainError("INVALID_ARGUMENT", message);
  }
  return parsed.data;
}

export function changesPublicationForDocument(
  input: Omit<ChangesPublicationInput, "operation" | "request" | "requestHash"> & {
    baseRevision: string;
    request: DocumentMutationRequest;
    /** The proposal the caller edits, when they chose one. */
    proposalNumber?: number;
    /** The PR head the caller read (precondition). */
    proposalHeadSha?: string;
  },
): ReturnType<typeof createChangesPublication> {
  const changes = documentChangesFromRequest(input.request);
  const body: ChangesApplyRequest = {
    mode: "edit",
    baseRevision: input.baseRevision,
    title: documentSaveTitle(changes),
    changes,
    sourceSessionIds: [],
    ...(input.proposalNumber === undefined ? {} : { proposalNumber: input.proposalNumber }),
    ...(input.proposalHeadSha === undefined ? {} : { proposalHeadSha: input.proposalHeadSha }),
  };
  return createChangesPublication({
    ...input,
    request: body,
    operation: operationForDocument(input.request),
    requestHash: requestHashForDocument(input.kbId, input.baseRevision, {
      ...input.request,
      ...(input.proposalNumber === undefined ? {} : { proposalNumber: input.proposalNumber }),
      ...(input.proposalHeadSha === undefined ? {} : { proposalHeadSha: input.proposalHeadSha }),
    }),
    // Staged images are `assets[i]` of the browser request (R3-W7).
    fieldFor: (index, key) =>
      index === 0
        ? documentToolField(index, key)
        : `/assets/${index - 1}/${key === "path" ? "path" : "uploadId"}`,
  });
}
