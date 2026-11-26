import { documentOutline } from "./outline";

/**
 * Where a search hit is in its document, as the heading to jump to.
 *
 * A hit's snippet is the start of its chunk (the server's `plainSnippet`:
 * Markdown formatting removed, whitespace collapsed, maybe cut with "…").
 * Both sides are reduced to the same word stream (lowercased runs of letters
 * and digits; link destinations and tags dropped), the snippet's first words
 * are found in the document, and the nearest heading at or before that line
 * is the answer. Null when the words are not found or come before the first
 * heading.
 */
export function headingForSnippet(markdown: string, snippet: string): string | null {
  const target = words(snippet.replace(/…\s*$/u, ""));
  if (target.length === 0) return null;
  const lines = markdown.split(/\r?\n/);
  const outline = documentOutline(markdown);
  if (outline.length === 0) return null;
  const stream: { word: string; line: number }[] = [];
  const start = frontMatterEnd(lines);
  for (let line = start; line < lines.length; line++) {
    for (const word of words(projectLine(lines[line]!))) stream.push({ word, line });
  }
  const at = locate(
    stream.map((entry) => entry.word),
    target,
  );
  if (at < 0) return null;
  const line = stream[at]!.line;
  let found: string | null = null;
  for (const heading of outline) {
    if (heading.line > line) break;
    found = heading.id;
  }
  return found;
}

function frontMatterEnd(lines: readonly string[]): number {
  if (lines[0] !== "---") return 0;
  const close = lines.indexOf("---", 1);
  return close < 0 ? 0 : close + 1;
}

/** A Markdown line as the snippet would show its words: no link destinations or tags. */
function projectLine(line: string): string {
  return line
    .replace(/<\/?[a-z][^<>]*>/gi, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\]\[[^\]]*\]/g, "]");
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).map((word) =>
    word.replace(/['’]/g, ""),
  );
}

/**
 * Index in `stream` where the snippet starts: the longest run (8 words down
 * to 3, or all of a shorter snippet) of its opening words found consecutively,
 * also skipping up to two leading words that may be a cut-off token.
 */
function locate(stream: readonly string[], target: readonly string[]): number {
  const longest = Math.min(8, target.length);
  const shortest = Math.min(3, target.length);
  for (let length = longest; length >= shortest; length--) {
    for (let skip = 0; skip <= 2 && skip + length <= target.length; skip++) {
      const run = target.slice(skip, skip + length);
      const at = indexOfRun(stream, run);
      if (at >= 0) return at;
    }
  }
  return -1;
}

function indexOfRun(stream: readonly string[], run: readonly string[]): number {
  outer: for (let i = 0; i + run.length <= stream.length; i++) {
    for (let j = 0; j < run.length; j++) if (stream[i + j] !== run[j]) continue outer;
    return i;
  }
  return -1;
}
