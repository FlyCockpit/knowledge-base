import type { LockQuery } from "./lock";

export const PR_BRANCH_PREFIX = "refs/heads/pr/";

export function proposalRefName(number: number): string {
  if (!Number.isInteger(number) || number < 1) throw new Error("invalid proposal number");
  return `${PR_BRANCH_PREFIX}${number}`;
}

/** Human/protocol branch label: the ref name relative to `refs/heads/` (`pr/<n>`). */
export function proposalBranchLabel(refName: string): string {
  return refName.replace(/^refs\/heads\//, "");
}

export type BranchOwnerRow = {
  kbId: string;
  refName: string;
  ownerActorKey: string;
  purpose: "USER" | "AUTO_PR";
};

export async function loadBranchOwner(
  query: LockQuery,
  kbId: string,
  refName: string,
): Promise<BranchOwnerRow | null> {
  const rows = await query<BranchOwnerRow>(
    `SELECT "kbId", "refName", "ownerActorKey", purpose::text AS purpose
       FROM "branch_owner"
      WHERE "kbId" = $1 AND "refName" = $2`,
    [kbId, refName],
  );
  return rows.rows[0] ?? null;
}

export async function insertBranchOwner(
  query: LockQuery,
  input: {
    kbId: string;
    refName: string;
    ownerActorKey: string;
    purpose: "USER" | "AUTO_PR";
  },
): Promise<void> {
  await query(
    `INSERT INTO "branch_owner" ("kbId", "refName", "ownerActorKey", purpose)
     VALUES ($1, $2, $3, $4::"BranchOwnerPurpose")
     ON CONFLICT ("kbId", "refName") DO NOTHING`,
    [input.kbId, input.refName, input.ownerActorKey, input.purpose],
  );
}
