/**
 * The CONFLICT details a browser save may receive (R3-W6). Pure: the
 * web editor's tests feed real domain details through this same function, so
 * the router-to-editor contract cannot drift.
 *
 * - `{headSha, proposalNumber}`: the head the caller should read and continue
 *   (main, or their open proposal).
 * - PROPOSAL_CONFLICT: additionally `reason`, `mainSha` (current main, what
 *   the next save goes against) and the paths still to resolve with their
 *   kind and the revisions their versions are read at. `headSha` is the
 *   proposal head, which the caller may read. Version contents are never
 *   forwarded: the editor reads them at those revisions with its own authority.
 */
export type BrowserConflictPath = {
  path: string;
  kind: "document" | "asset";
  baseSha: string;
  theirsSha: string;
  yoursSha: string;
};
export type BrowserConflictDetails =
  | { headSha: string; proposalNumber: number | null }
  | {
      headSha: string;
      proposalNumber: number;
      reason: "PROPOSAL_CONFLICT";
      mainSha: string;
      paths: BrowserConflictPath[];
    };

const SHA = /^[0-9a-f]{40}$/;
const isSha = (value: unknown): value is string => typeof value === "string" && SHA.test(value);
/** The protocol's PROPOSAL_CONFLICT_MAX_PATHS. */
const MAX_PATHS = 50;

export function browserConflictDetails(details: unknown): BrowserConflictDetails | null {
  if (!details || typeof details !== "object") return null;
  const raw = details as Record<string, unknown>;
  const { proposalNumber } = raw;
  const numbered = Number.isSafeInteger(proposalNumber) && Number(proposalNumber) >= 1;
  if (raw.reason === "PROPOSAL_CONFLICT") {
    if (!isSha(raw.proposalHeadSha) || !isSha(raw.headSha) || !numbered) return null;
    const items = Array.isArray(raw.paths) ? raw.paths.slice(0, MAX_PATHS) : [];
    const paths: BrowserConflictPath[] = [];
    for (const item of items) {
      const entry = (item ?? {}) as Record<string, unknown>;
      if (
        typeof entry.path !== "string" ||
        entry.path.length === 0 ||
        entry.path.length > 4096 ||
        (entry.kind !== "document" && entry.kind !== "asset") ||
        !isSha(entry.baseSha) ||
        !isSha(entry.theirsSha) ||
        !isSha(entry.yoursSha)
      )
        return null;
      paths.push({
        path: entry.path,
        kind: entry.kind,
        baseSha: entry.baseSha,
        theirsSha: entry.theirsSha,
        yoursSha: entry.yoursSha,
      });
    }
    if (paths.length === 0) return null;
    return {
      headSha: raw.proposalHeadSha,
      proposalNumber: proposalNumber as number,
      reason: "PROPOSAL_CONFLICT",
      mainSha: raw.headSha,
      paths,
    };
  }
  if (!isSha(raw.headSha)) return null;
  if (proposalNumber !== null && !numbered) return null;
  return { headSha: raw.headSha, proposalNumber: proposalNumber as number | null };
}
