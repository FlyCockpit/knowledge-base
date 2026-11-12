import { proposalBranchLabel, proposalRefName } from "./branch-owner";
import type { DreamMetadata, PersistedDreamMetadata } from "./dream";
import type { LockQuery } from "./lock";
import { type LogicalConflict, remainingConflicts } from "./logical-merge";
import type { ConflictItem } from "./pr-merge";

export type PullRequestRow = {
  kbId: string;
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  baseSha: string;
  headSha: string;
  targetSha: string;
  status: "OPEN" | "CONFLICT" | "CLOSED" | "MERGED";
  authorActorKey: string;
  version: number;
  mergeCommitSha: string | null;
  isAutoPr: boolean;
  dreamMetadata: PersistedDreamMetadata | DreamMetadata | null;
  /** The main the stored OPEN/CONFLICT was computed against; null = unchecked. */
  mergeCheckedSha?: string | null;
  mergeCheckedKey?: string | null;
  /** Unresolved conflicts recorded on the PR. */
  pendingConflicts?: ConflictItem[] | null;
};

export type PrSummary = {
  number: number;
  title: string;
  sourceBranch: string;
  targetBranch: "main";
  baseSha: string;
  headSha: string;
  targetSha: string;
  status: PullRequestRow["status"];
  authorActorKey: string;
  version: number;
  mergeCommitSha: string | null;
};

/**
 * The protocol summary. An open PR's status and target always come from one
 * snapshot: `targetSha` is the main its status was computed against,
 * so "OPEN against X" never pairs with a different, live main.
 */
export function toPrSummary(row: PullRequestRow): PrSummary {
  const checked =
    isActivePrStatus(row.status) &&
    row.mergeCheckedSha &&
    /^[a-f0-9]{40}$/.test(row.mergeCheckedSha)
      ? row.mergeCheckedSha
      : null;
  return {
    number: row.number,
    title: row.title,
    sourceBranch: proposalBranchLabel(row.sourceBranch),
    targetBranch: "main",
    baseSha: row.baseSha,
    headSha: row.headSha,
    targetSha: checked ?? row.targetSha,
    status: row.status,
    authorActorKey: row.authorActorKey,
    version: row.version,
    mergeCommitSha: row.mergeCommitSha,
  };
}

/** Complete identity of merge validation. Asset trust/lineage is immutable;
 * dream metadata and pending conflicts change only with the PR's version.
 * The prefix lets bounded SQL scans use exactly the same key as readers.
 * Keep the local-store derivation in sync (pull_requests::mergeability_key).
 */
export function mergeabilityKey(
  snapshot: { mainHead: string; policyGeneration: string },
  pr?: Pick<PullRequestRow, "headSha" | "version">,
  canonicalOrigin?: string,
): string {
  const prefix = `v1:${snapshot.mainHead}:${snapshot.policyGeneration}:${JSON.stringify(canonicalOrigin ?? "")}`;
  return pr ? `${prefix}:${pr.headSha}:${pr.version}` : prefix;
}

const ACTIVE_STATUSES = ["OPEN", "CONFLICT"] as const;

export async function allocateNextPrNumber(query: LockQuery, kbId: string): Promise<number> {
  const rows = await query<{ number: number }>(
    `UPDATE "knowledge_base"
        SET "nextPrNumber" = "nextPrNumber" + 1, "updatedAt" = now()
      WHERE id = $1
      RETURNING ("nextPrNumber" - 1) AS number`,
    [kbId],
  );
  const number = rows.rows[0]?.number;
  if (number === undefined || number < 1) throw new Error("failed to allocate proposal number");
  return number;
}

export async function findPullRequest(
  query: LockQuery,
  kbId: string,
  number: number,
): Promise<PullRequestRow | null> {
  // Protocol selectors are safe integers; bind as bigint so absent int4-overflow numbers stay misses.
  const rows = await query<PullRequestRow>(
    `SELECT "kbId", number, title, "sourceBranch", "targetBranch", "baseSha", "headSha",
            "targetSha", status::text AS status, "authorActorKey", version, "mergeCommitSha",
            "isAutoPr", "dreamMetadata", "mergeCheckedSha", "mergeCheckedKey",
            "pendingConflicts"
       FROM "pull_request"
      WHERE "kbId" = $1 AND number = $2::bigint`,
    [kbId, number],
  );
  return rows.rows[0] ?? null;
}

/**
 * The open automatic PR a propose-only edit continues: the actor's own, else
 * (the person owns the PR) the newest one opened by the same person's
 * web session or any of their credentials. A dream's PR is only ever
 * continued by the actor that dreamed it, and dreams never adopt another's.
 */
export async function findActiveAutoPrForActor(
  query: LockQuery,
  kbId: string,
  actorKey: string,
  /** The person, for the fallback; null keeps the lookup to this actor (dreams). */
  userId: string | null,
): Promise<PullRequestRow | null> {
  const rows = await query<PullRequestRow>(
    `SELECT "kbId", number, title, "sourceBranch", "targetBranch", "baseSha", "headSha",
            "targetSha", status::text AS status, "authorActorKey", version, "mergeCommitSha",
            "isAutoPr", "dreamMetadata", "mergeCheckedSha", "mergeCheckedKey",
            "pendingConflicts"
       FROM "pull_request"
      WHERE "kbId" = $1
        AND "isAutoPr" = true
        AND status IN ('OPEN'::"PullRequestStatus", 'CONFLICT'::"PullRequestStatus")
        AND ("authorActorKey" = $2
             OR ($3::text IS NOT NULL AND "dreamMetadata" IS NULL
                 AND ("authorActorKey" = 'user:' || $3
                      OR "authorActorKey" IN (SELECT 'grant:' || g.id::text FROM mcp_grant g
                                               WHERE g."userId" = $3))))
      ORDER BY ("authorActorKey" = $2) DESC, number DESC
      LIMIT 1`,
    [kbId, actorKey, userId],
  );
  return rows.rows[0] ?? null;
}

export function isActivePrStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function assertPrMutable(row: PullRequestRow): void {
  if (!isActivePrStatus(row.status)) {
    throw new Error("proposal branch is closed or merged");
  }
}

export async function upsertPullRequestHead(
  query: LockQuery,
  input: {
    kbId: string;
    number: number;
    title: string;
    sourceBranch: string;
    baseSha: string;
    headSha: string;
    targetSha: string;
    authorActorKey: string;
    isAutoPr: boolean;
    version: number;
    dreamMetadata?: PersistedDreamMetadata | DreamMetadata | null;
    /** The status computed for this head and the main it was checked against. */
    mergeStatus: { status: "OPEN" | "CONFLICT"; checkedSha: string; epoch: string; key: string };
    /** The conflicts this head still has to resolve. */
    pendingConflicts?: readonly ConflictItem[];
  },
): Promise<void> {
  const updated = await query(
    `INSERT INTO "pull_request"
       ("kbId", number, title, "sourceBranch", "targetBranch", "baseSha", "headSha", "targetSha",
        status, "authorActorKey", version, "isAutoPr", "dreamMetadata", "mergeCheckedSha",
        "mergeCheckedEpoch", "mergeCheckedKey", "pendingConflicts", "updatedAt")
     VALUES ($1, $2, $3, $4, 'main', $5, $6, $7, $12::"PullRequestStatus", $8, $9, $10, $11::jsonb, $13,
             $14::bigint, $16, $15::jsonb, now())
     ON CONFLICT ("kbId", number) DO UPDATE
       -- R3-W5: a PR keeps the title it was opened with; an update's title
       -- is only that commit's message.
       SET "baseSha" = EXCLUDED."baseSha",
           "headSha" = EXCLUDED."headSha",
           "mergeCheckedSha" = EXCLUDED."mergeCheckedSha",
           "mergeCheckedEpoch" = EXCLUDED."mergeCheckedEpoch",
           "mergeCheckedKey" = EXCLUDED."mergeCheckedKey",
           "pendingConflicts" = EXCLUDED."pendingConflicts",
           "targetSha" = EXCLUDED."targetSha",
           status = EXCLUDED.status,
           version = EXCLUDED.version,
           "dreamMetadata" = COALESCE(EXCLUDED."dreamMetadata", "pull_request"."dreamMetadata"),
           "updatedAt" = now()
       WHERE "pull_request".status IN ('OPEN'::"PullRequestStatus", 'CONFLICT'::"PullRequestStatus")`,
    [
      input.kbId,
      input.number,
      input.title,
      input.sourceBranch,
      input.baseSha,
      input.headSha,
      input.targetSha,
      input.authorActorKey,
      input.version,
      input.isAutoPr,
      input.dreamMetadata ? JSON.stringify(input.dreamMetadata) : null,
      input.mergeStatus.status,
      input.mergeStatus.checkedSha,
      input.mergeStatus.epoch,
      JSON.stringify(input.pendingConflicts ?? []),
      input.mergeStatus.key,
    ],
  );
  if (updated.rowCount !== 1) throw new Error("proposal branch is closed or merged");
}

export function refForNewAutoPr(number: number): string {
  return proposalRefName(number);
}

/**
 * The journal owns this update; closed/merged history remains immutable. A
 * push is a head change like any other: each recorded conflict it wrote
 * (same kind and path, `touched`) is resolved, untouched ones stay.
 */
export async function refreshPushedProposal(
  query: LockQuery,
  kbId: string,
  refName: string,
  headSha: string,
  touched: readonly LogicalConflict[],
) {
  const written = new Set(touched.map((item) => `${item.kind}\0${item.path}`));
  const rows = (
    await query<{ number: number; pendingConflicts: unknown }>(
      `SELECT number, "pendingConflicts" FROM pull_request
        WHERE "kbId"=$1 AND "sourceBranch"=$2 AND status IN ('OPEN','CONFLICT') FOR UPDATE`,
      [kbId, refName],
    )
  ).rows;
  for (const row of rows) {
    const pending = Array.isArray(row.pendingConflicts)
      ? (row.pendingConflicts as ConflictItem[])
      : [];
    const { remaining } = remainingConflicts(pending, (item) =>
      written.has(`${item.kind}\0${item.path}`),
    );
    await query(
      `UPDATE pull_request SET "headSha"=$3, "targetSha"=(SELECT "headSha" FROM knowledge_base WHERE id=$1),
      status='OPEN', "mergeCheckedSha"=NULL, "mergeCheckedEpoch"=NULL, "pendingConflicts"=$4::jsonb,
      version=version+1, "updatedAt"=now()
      WHERE "kbId"=$1 AND number=$2 AND status IN ('OPEN','CONFLICT')`,
      [kbId, row.number, headSha, JSON.stringify(remaining)],
    );
  }
}
