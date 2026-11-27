/**
 * How close a search hit is, in words a person can trust. The browser search
 * reply carries per hit its cosine similarity to the query (`semantic`, from
 * the vector arm) and whether the keyword arm matched it (in hybrid search
 * that needs most of the query's words). The fused RRF `score` only orders the
 * results and is never shown as a similarity.
 *
 * Cosine values are not comparable across embedding models (each model spreads
 * unrelated text over a different range), so the bands are calibrated per
 * model: `RELEVANCE_THRESHOLDS`, keyed by the reply's `calibration` (the
 * measured model family). The basis
 * of each row is recorded in work/kb-workspace/search-calibration.md.
 */

export type HitRelevance = {
  semantic: number | null;
  semanticRank: number | null;
  keyword: boolean;
  keywordRank: number | null;
};

export type RelevanceThresholds = {
  /** At or above: "Strong". */
  strong: number;
  /** At or above: "Related". */
  related: number;
  /** Below (and no keyword match): collapsed under "Weaker matches". */
  floor: number;
};

/**
 * One table, one row per embedding model family. The built-in rows are measured
 * (11-26, real GGUF weights, the server's own child, prefixes, chunking and int8
 * quantization, a labelled 30-document / 28-query fixture; work/kb-workspace/
 * search-calibration.md): `floor` sits near the 95th–97th percentile of unrelated
 * pairs, `related` above their 99th, `strong` above every loosely related pair and
 * at most the strongly related 5th–25th percentile. The two models live in very
 * different ranges (an unrelated pair scores ~0.14 on Qwen and ~0.55 on Gemma), so a
 * row never carries over to another model.
 */
export const RELEVANCE_THRESHOLDS: Readonly<Record<string, RelevanceThresholds>> = {
  "qwen3-embedding-0.6b-q8_0": { strong: 0.55, related: 0.4, floor: 0.32 },
  "embeddinggemma-2-q8_0": { strong: 0.72, related: 0.66, floor: 0.63 },
};

export function thresholdsFor(calibration: string | undefined): RelevanceThresholds | null {
  return calibration !== undefined && Object.hasOwn(RELEVANCE_THRESHOLDS, calibration)
    ? (RELEVANCE_THRESHOLDS[calibration] ?? null)
    : null;
}

/**
 * `keyword`: a keyword-only search (no semantic arm), where the match itself is
 * all that is known.
 */
type RelevanceBand = "strong" | "related" | "weak" | "keyword";

export type RelevanceAssessment =
  | { band: "neutral"; passes: true; level: null }
  | {
      band: RelevanceBand;
      /** Shown among the results; false collapses it under "Weaker matches". */
      passes: boolean;
      /** Meter fill, 1–3 (weak, related, strong); a keyword-only match is 2. */
      level: 1 | 2 | 3;
    };

const LEVEL: Record<RelevanceBand, 1 | 2 | 3> = { weak: 1, keyword: 2, related: 2, strong: 3 };

/**
 * The band of one hit:
 * - lexical calibration (keyword-only search): "keyword", always shown;
 * - semantic bands from the model's thresholds;
 * - a keyword match lifts a hit to at least "Related" (it contains most of the
 *   query's words), and a Related meaning plus a keyword match is "Strong";
 * - a hit passes the floor by its meaning or by a keyword match.
 */
export function assessRelevance(
  relevance: HitRelevance,
  calibration: string | undefined,
): RelevanceAssessment {
  if (calibration === "lexical") return { band: "keyword", passes: true, level: 2 };
  const t = thresholdsFor(calibration);
  if (t === null) return { band: "neutral", passes: true, level: null };
  const s = relevance.semantic;
  let band: RelevanceBand =
    s === null ? "weak" : s >= t.strong ? "strong" : s >= t.related ? "related" : "weak";
  if (relevance.keyword) {
    if (band === "weak") band = "related";
    else if (band === "related" && s !== null) band = "strong";
  }
  const passes = relevance.keyword || (s !== null && s >= t.floor);
  return { band, passes, level: LEVEL[band] };
}

/**
 * Splits hits into those shown and the weaker ones collapsed below them, keeping
 * the server's order within each. Hits without relevance (structured search)
 * are all shown.
 */
export function partitionByFloor<T extends { relevance?: HitRelevance }>(
  hits: readonly T[],
  calibration: string | undefined,
): { shown: T[]; weaker: T[] } {
  const shown: T[] = [];
  const weaker: T[] = [];
  for (const hit of hits) {
    if (!hit.relevance || assessRelevance(hit.relevance, calibration).passes) shown.push(hit);
    else weaker.push(hit);
  }
  return { shown, weaker };
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "de",
  "del",
  "el",
  "en",
  "for",
  "from",
  "in",
  "is",
  "it",
  "la",
  "las",
  "los",
  "of",
  "on",
  "or",
  "the",
  "to",
  "un",
  "una",
  "with",
  "y",
]);

/** The query's words worth highlighting: letters/digits runs, no stopwords, longest first. */
export function highlightTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = [...new Set(words.filter((w) => w.length >= 2 && !STOPWORDS.has(w)))];
  return terms.sort((a, b) => b.length - a.length).slice(0, 16);
}

export type SnippetPart = { text: string; match: boolean };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The snippet split into plain and matching parts: each occurrence of a term at
 * the start of a word (so "flour" marks "flours", not "cauliflour"),
 * case-insensitive. Pure text: the caller renders matches as `<mark>`.
 */
export function highlightSnippet(snippet: string, terms: readonly string[]): SnippetPart[] {
  if (terms.length === 0 || snippet.length === 0) return [{ text: snippet, match: false }];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRegExp).join("|")})`, "giu");
  const parts: SnippetPart[] = [];
  let last = 0;
  for (const found of snippet.matchAll(pattern)) {
    const at = found.index ?? 0;
    if (found[0].length === 0) continue;
    if (at > last) parts.push({ text: snippet.slice(last, at), match: false });
    parts.push({ text: found[0], match: true });
    last = at + found[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts.length > 0 ? parts : [{ text: snippet, match: false }];
}
