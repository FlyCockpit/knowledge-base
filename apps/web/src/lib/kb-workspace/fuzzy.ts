/**
 * Quick-open matching: a case-insensitive subsequence match of the query in
 * a path, scored so that the file name beats its folders, word starts and
 * runs of consecutive letters beat scattered hits, and shorter paths win
 * ties. Linear in the path per query, so 10k paths stay well inside a frame.
 */

export type FuzzyMatch = { score: number; ranges: [number, number][] };

const BOUNDARY = new Set(["/", "-", "_", ".", " "]);

/** Greedy subsequence of `query` (lower-cased) in `target` from `from`, preferring word starts. */
function matchFrom(query: string, target: string, lower: string, from: number): number[] | null {
  const positions: number[] = [];
  let at = from;
  for (let q = 0; q < query.length; q++) {
    const ch = query[q]!;
    const first = lower.indexOf(ch, at);
    if (first < 0) return null;
    let pick = first;
    // Unless this continues a run, jump to a later word start for the same letter if there is one.
    const continuesRun = positions.length > 0 && positions[positions.length - 1] === first - 1;
    if (!continuesRun && !isWordStart(target, first)) {
      for (let i = first + 1; i < lower.length; i++) {
        if (lower[i] === ch && isWordStart(target, i)) {
          // Only if the rest of the query still fits after it.
          if (fits(query, q + 1, lower, i + 1)) pick = i;
          break;
        }
      }
    }
    positions.push(pick);
    at = pick + 1;
  }
  return positions;
}

function fits(query: string, q: number, lower: string, from: number): boolean {
  let at = from;
  for (let i = q; i < query.length; i++) {
    at = lower.indexOf(query[i]!, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

function isWordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1]!;
  if (BOUNDARY.has(prev)) return true;
  const ch = target[i]!;
  // camelCase hump
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase();
}

function scorePositions(target: string, positions: number[], nameStart: number): number {
  let score = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]!;
    score += 1;
    if (p >= nameStart) score += 2;
    if (isWordStart(target, p)) score += 3;
    if (i > 0 && positions[i - 1] === p - 1) score += 4;
  }
  if (positions[0] === nameStart) score += 4;
  // Shorter paths first among equals.
  return score - target.length * 0.01;
}

function toRanges(positions: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const p of positions) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  return ranges;
}

/** The query's match in `target`, or null. Ranges are [start, end) offsets into `target`. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const lower = target.toLowerCase();
  const nameStart = target.lastIndexOf("/") + 1;
  // Prefer a match inside the file name; else anywhere in the path.
  const inName = matchFrom(q, target, lower, nameStart);
  const positions = inName ?? matchFrom(q, target, lower, 0);
  if (!positions) return null;
  const score = scorePositions(target, positions, nameStart) + (inName ? 10 : 0);
  return { score, ranges: toRanges(positions) };
}

/** The best `limit` matches, best first; an empty query keeps the paths' order. */
export function fuzzyFilter(
  query: string,
  paths: readonly string[],
  limit = 50,
): { path: string; score: number; ranges: [number, number][] }[] {
  const q = query.replace(/\s+/g, "");
  if (!q) return paths.slice(0, limit).map((path) => ({ path, score: 0, ranges: [] }));
  const out: { path: string; score: number; ranges: [number, number][] }[] = [];
  for (const path of paths) {
    const match = fuzzyMatch(q, path);
    if (match) out.push({ path, ...match });
  }
  out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out.slice(0, limit);
}
