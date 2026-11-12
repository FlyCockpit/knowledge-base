/**
 * R2-27 (CLI twin `kb-local/src/plain_snippet.rs`, shared corpus
 * `fixtures/plain-snippet.json`): format source windows before clipping citation
 * snippets. Code contents stay literal; Markdown formatting becomes plain text.
 * Unpaired delimiters stay literal because a glob and clipped emphasis cannot
 * be distinguished without the missing source. The citation span stays exact.
 */
/** Each closing-delimiter cursor only advances, even after an unmatched opener. */
function bracketed(source: string, image: boolean, nonempty: boolean, open: string, close: string) {
  const out: string[] = [];
  let end = 0;
  let tail = 0;
  for (let i = 0; i < source.length; ) {
    const label = image
      ? source[i] === "!" && source[i + 1] === "["
        ? i + 2
        : -1
      : source[i] === "["
        ? i + 1
        : -1;
    if (label >= 0) {
      end = Math.max(end, label);
      while (end < source.length && source[end] !== "]") end++;
      if (end < source.length && (!nonempty || end > label) && source[end + 1] === open) {
        tail = Math.max(tail, end + 2);
        while (tail < source.length && source[tail] !== close) tail++;
        if (tail < source.length) {
          out.push(source.slice(label, end));
          i = tail + 1;
          continue;
        }
      }
    }
    out.push(source[i++]!);
  }
  return out.join("");
}

export function plainSnippet(markdown: string): string {
  // Preserve literal code before stripping Markdown. Use a marker absent from
  // the source so even adversarial input cannot impersonate a protected span.
  let longest = 0;
  let runLength = 0;
  for (const char of markdown) {
    runLength = char === "\0" ? runLength + 1 : 0;
    longest = Math.max(longest, runLength);
  }
  const marker = `${"\0".repeat(longest + 1)}:`;
  const literals: string[] = [];
  let source = "";
  for (let i = 0; i < markdown.length; ) {
    if (markdown[i] !== "`") {
      source += markdown[i++];
      continue;
    }
    const run = /^`+/.exec(markdown.slice(i))![0];
    let start = i + run.length;
    if (run.length >= 3) start += /^[\w-]*/.exec(markdown.slice(start))![0].length;
    let end = start;
    while (end < markdown.length) {
      const next = markdown.indexOf("`", end);
      if (next < 0) {
        end = markdown.length;
        break;
      }
      const close = /^`+/.exec(markdown.slice(next))![0];
      if (close.length === run.length) {
        end = next;
        break;
      }
      end = next + close.length;
    }
    const space = run.length >= 3 ? " " : "";
    source += `${space}${marker}${literals.length}${marker}${space}`;
    literals.push(markdown.slice(start, end));
    i = end < markdown.length ? end + run.length : end;
  }
  source = source.replace(/<\/?[a-z][^<>]*>/gi, " ");
  source = bracketed(source, true, false, "(", ")");
  source = bracketed(source, false, true, "(", ")");
  source = bracketed(source, false, true, "[", "]");
  let plain = source
    .replace(/\|/g, " ")
    .replace(/(^|\s)#{1,6}(?=\s|$)/g, "$1")
    .replace(/(^|\s):?(?:-{3,}|\*{3,}|_{3,}):?(?=\s|$)/g, "$1")
    .replace(/^\s*(?:>+|[-*+])\s+/, "")
    .replace(/(\*{1,3}|~~)(?=\S)(.*?\S)\1/gs, "$2")
    .replace(/(^|[^\p{Alphabetic}\p{N}_])(__?)(?=\S)(.*?\S)\2(?![\p{Alphabetic}\p{N}_])/gu, "$1$3");
  // Restore all protected spans in one pass; inserted literals are never parsed.
  plain = plain.replace(
    new RegExp(`${marker}(\\d+)${marker}`, "g"),
    (_, index: string) => literals[Number(index)]!,
  );
  return plain.replace(/\s+/g, " ").trim();
}
