/** Hybrid fusion: score = Σ 1/(RRF_K + rank1), rank1 starting at 1 (first weight 1/61). */
export const RRF_K = 60;
export const HYBRID_CANDIDATES_PER_ARM = 80;

/**
 * L-25: the score a hit carries in replies, in (0, 1]: the fused RRF sum divided by its maximum
 * for the arms that ran (rank 1 in each), i.e. `rrf * 61 / arms`. 1 means ranked first by every
 * arm; a hybrid hit found by one arm alone scores at most 0.5. It orders exactly like the fused
 * sum and measures rank agreement, not calibrated relevance. Same float operations as the CLI.
 */
export function normalizedRrfScore(rrf: number, arms: 1 | 2): number {
  return (rrf * (RRF_K + 1)) / arms;
}

export type ChunkKey = { path: string; chunkIndex: number };
export type FusedChunk = ChunkKey & { score: number };

/** Bytewise UTF-8 order, independent of database collation and JS UTF-16 code units. */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function compareChunkKeys(a: ChunkKey, b: ChunkKey): number {
  return comparePaths(a.path, b.path) || a.chunkIndex - b.chunkIndex;
}

/**
 * Arms are already ordered best-first. A chunk appearing in several arms is one fused hit whose
 * score adds each arm's contribution in arm order; a duplicate inside one arm keeps its best rank.
 * Ties break by path then chunkIndex so the ranking is total and stable.
 */
export function fuseReciprocalRanks(arms: readonly (readonly ChunkKey[])[]): FusedChunk[] {
  const fused = new Map<string, FusedChunk>();
  for (const arm of arms) {
    const seen = new Set<string>();
    let rank = 0;
    for (const candidate of arm) {
      const key = `${candidate.chunkIndex}\0${candidate.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rank += 1;
      const contribution = 1 / (RRF_K + rank);
      const prior = fused.get(key);
      if (prior) prior.score += contribution;
      else
        fused.set(key, {
          path: candidate.path,
          chunkIndex: candidate.chunkIndex,
          score: contribution,
        });
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || compareChunkKeys(a, b));
}
