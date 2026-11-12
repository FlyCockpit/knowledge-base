import { KbDomainError } from "./errors";

/**
 * Why a PR merge/close was refused with CONFLICT. The browser review
 * page shows a distinct message per kind instead of re-reading the PR to guess:
 *
 * - `revision_moved`: the reviewed revisions are no longer current — main
 *   (the merge base target) and/or the proposal head moved. The flags say
 *   which; the current SHAs are ones the caller may already read.
 * - `content_conflict`: the reviewed revisions are still current but cannot
 *   be merged (overlapping edits, a guard, or an invalid merged tree).
 * - `state_changed`: the PR stopped being open (closed or merged) meanwhile.
 */
export type PrConflictDetails =
  | {
      kind: "revision_moved";
      targetMoved: boolean;
      headMoved: boolean;
      currentTargetSha: string | null;
      currentHeadSha: string | null;
    }
  | { kind: "content_conflict" }
  | { kind: "state_changed" };

/**
 * CONFLICT carrying structured PR conflict details. `details` stays the
 * CONTRACT/MCP envelope shape (`{headSha, proposalNumber}` or `{}`); the
 * structured `conflict` is only forwarded by the browser PR router.
 */
export class PrConflictError extends KbDomainError {
  constructor(
    message: string,
    readonly conflict: PrConflictDetails,
    details: unknown = {},
  ) {
    super("CONFLICT", message, undefined, details);
    this.name = "PrConflictError";
  }
}

const SHA = /^[0-9a-f]{40}$/;
const shaOrNull = (value: unknown) => (typeof value === "string" && SHA.test(value) ? value : null);

/** Validated structured details of a PR CONFLICT, or null when the error carries none. */
export function prConflictDetails(error: unknown): PrConflictDetails | null {
  if (!(error instanceof PrConflictError)) return null;
  const conflict = error.conflict;
  switch (conflict.kind) {
    case "revision_moved":
      return {
        kind: "revision_moved",
        targetMoved: conflict.targetMoved === true,
        headMoved: conflict.headMoved === true,
        currentTargetSha: shaOrNull(conflict.currentTargetSha),
        currentHeadSha: shaOrNull(conflict.currentHeadSha),
      };
    case "content_conflict":
      return { kind: "content_conflict" };
    case "state_changed":
      return { kind: "state_changed" };
    default:
      return null;
  }
}

/**
 * Error data the browser receives. A PR CONFLICT carries structured details
 * (moved base/head revisions vs content conflict) so the review page
 * never re-reads the PR to guess; everything else carries only the stable code.
 */
export function pullRequestErrorData(
  error: unknown,
  code: string,
): { code: string; conflict?: PrConflictDetails } {
  const conflict = code === "CONFLICT" ? prConflictDetails(error) : null;
  return conflict ? { code, conflict } : { code };
}
