import { decodeNamedCharacterReference } from "decode-named-character-reference";
import { createHeadingSlugger } from "@/lib/markdown-heading-slugs";

/**
 * A document's headings with the ids the rendered document gives them, so an
 * outline entry links to `#id` of the canonical view (`MarkdownView`:
 * react-markdown + remark-gfm + `rehypeHeadingIds`).
 *
 * This is a line scanner, not a full CommonMark parser. It follows the
 * renderer where it matters for headings: leading YAML front matter is
 * dropped (`stripFrontMatter`), fenced code and HTML blocks hide `#` lines,
 * ATX and setext headings count (also inside block quotes and list items),
 * and the heading text is the rendered text content: inline Markdown reduced,
 * images by their alt text, raw HTML kept literally (the renderer shows it as
 * text). A rare construct it reduces differently only mislabels that id.
 */
export type OutlineHeading = {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  id: string;
  /** 0-based line of the heading in the Markdown as given (front matter included). */
  line: number;
};

const APP_RESERVED_IDS = ["main-content", "app-main", "root"];

/** Same rule as `stripFrontMatter` in markdown-view.tsx: the number of lines it drops. */
function frontMatterLines(lines: readonly string[]): number {
  if (lines[0] !== "---") return 0;
  const close = lines.indexOf("---", 1);
  return close < 0 ? 0 : close + 1;
}

type Containers = { content: string; quotes: number; item: number };

/**
 * A line's container prefixes (block quote markers, list item markers) and
 * its content. `item`: the content column a list item marker opened (0: none).
 */
function containersOf(line: string): Containers {
  let rest = line;
  let quotes = 0;
  let item = 0;
  for (;;) {
    const quote = /^ {0,3}> ?/.exec(rest);
    if (quote) {
      rest = rest.slice(quote[0].length);
      quotes++;
      continue;
    }
    const marker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(rest);
    if (marker && !/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(rest)) {
      rest = rest.slice(marker[0].length);
      item += marker[0].length;
      continue;
    }
    return { content: rest, quotes, item };
  }
}

const stripContainers = (line: string) => containersOf(line).content;

/** The text of an ATX heading line, or null. Closing `#`s count only after a space. */
function atx(line: string): { level: number; raw: string } | null {
  const start = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
  if (!start) return null;
  let raw = line.slice(start[0].length).trim();
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "#") end--;
  if (end === 0) raw = "";
  else if (end < raw.length && (raw[end - 1] === " " || raw[end - 1] === "\t"))
    raw = raw.slice(0, end).trim();
  return { level: start[1]!.length, raw };
}

const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
// HTML blocks (CommonMark types 1-6 by their opening tag): their lines are not Markdown.
const HTML_BLOCK =
  /^ {0,3}<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s/>]|$))/i;

/** Which raw lines start something a paragraph line cannot continue into a setext heading. */
function blocksParagraph(content: string): boolean {
  return (
    content.trim() === "" ||
    atx(content) !== null ||
    FENCE.test(content) ||
    THEMATIC.test(content) ||
    HTML_BLOCK.test(content) ||
    /^ {4,}/.test(content)
  );
}

type Definitions = { links: Set<string>; footnotes: boolean };

const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

function collectDefinitions(lines: readonly string[]): Definitions {
  const links = new Set<string>();
  let footnotes = false;
  for (const line of lines) {
    const content = stripContainers(line);
    const def = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:/.exec(content);
    if (!def) continue;
    if (def[1]!.startsWith("^")) footnotes = true;
    else links.add(normalizeLabel(def[1]!));
  }
  return { links, footnotes };
}

function decodeEntity(entity: string): string | null {
  const numeric = /^#(?:x([0-9a-f]{1,6})|(\d{1,7}))$/i.exec(entity);
  if (numeric) {
    const code = numeric[1] ? Number.parseInt(numeric[1], 16) : Number(numeric[2]);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
    return String.fromCodePoint(code);
  }
  // Named references exactly as the renderer's parser (micromark) decodes them.
  const named = decodeNamedCharacterReference(entity);
  return named === false ? null : named;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Escapes and entities resolved: the literal text of a run with no further Markdown. */
function literalText(source: string): string {
  return source.replace(
    /\\([!-/:-@[-`{-~])|&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (all, esc, ent) => (esc !== undefined ? esc : (decodeEntity(ent) ?? all)),
  );
}

/** Start of the next backtick run of exactly `length` from `from`, or -1. */
function closingRun(source: string, from: number, length: number): number {
  for (let i = from; i < source.length; ) {
    if (source[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (source[end] === "`") end++;
    if (end - i === length) return i;
    i = end;
  }
  return -1;
}

type Delim = { char: string; length: number; open: boolean; close: boolean; index: number };

const isSpace = (ch: string | undefined) => ch === undefined || /\s/u.test(ch);
const isPunct = (ch: string | undefined) =>
  ch !== undefined && (PUNCTUATION.test(ch) || /\p{P}|\p{S}/u.test(ch));

/**
 * Inline Markdown of a heading reduced to its rendered text content: the
 * text the slugger receives (`headingText` in markdown-heading-slugs.ts).
 */
function inlineText(source: string, definitions: Definitions): string {
  // Tokens: literal text pieces and emphasis delimiter runs.
  const pieces: (string | Delim)[] = [];
  let text = "";
  const flush = () => {
    if (text) pieces.push(literalText(text));
    text = "";
  };
  for (let i = 0; i < source.length; ) {
    const ch = source[i]!;
    if (ch === "\\" && i + 1 < source.length && PUNCTUATION.test(source[i + 1]!)) {
      text += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(source.slice(i))![0];
      const at = closingRun(source, i + run.length, run.length);
      if (at >= 0) {
        let code = source.slice(i + run.length, at).replace(/\n/g, " ");
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "")
          code = code.slice(1, -1);
        flush();
        pieces.push(code);
        i = at + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === "<") {
      // Raw inline HTML is dropped by the renderer (no raw-HTML plugin): no text.
      const raw =
        /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!--[\s\S]*?-->)/.exec(
          source.slice(i),
        );
      if (raw && !/^<[a-z][a-z0-9+.-]{1,31}:/i.test(raw[0])) {
        flush();
        i += raw[0].length;
        continue;
      }
      const auto =
        /^<([a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[\w.!#$%&'*+/=?^`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)>/i.exec(
          source.slice(i),
        );
      if (auto) {
        flush();
        pieces.push(auto[1]!);
        i += auto[0].length;
        continue;
      }
    }
    const image = ch === "!" && source[i + 1] === "[";
    if (ch === "[" || image) {
      const link = matchLink(source, image ? i + 1 : i, definitions);
      if (link) {
        flush();
        pieces.push(inlineText(link.label, definitions));
        i = link.end;
        continue;
      }
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const run = new RegExp(`^\\${ch}+`).exec(source.slice(i))![0];
      const before = i === 0 ? undefined : source[i - 1];
      const after = source[i + run.length];
      const leftFlanking =
        !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const rightFlanking =
        !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      let open = leftFlanking;
      let close = rightFlanking;
      if (ch === "_") {
        open = leftFlanking && (!rightFlanking || isPunct(before));
        close = rightFlanking && (!leftFlanking || isPunct(after));
      }
      if (ch === "~" && run.length > 2) {
        open = false;
        close = false;
      }
      flush();
      pieces.push({ char: ch, length: run.length, open, close, index: pieces.length });
      i += run.length;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  processEmphasis(pieces);
  return pieces
    .map((piece) => (typeof piece === "string" ? piece : piece.char.repeat(piece.length)))
    .join("");
}

/** CommonMark "process emphasis", reduced to what decides which delimiters vanish. */
function processEmphasis(pieces: (string | Delim)[]): void {
  const delims = pieces.filter((piece): piece is Delim => typeof piece !== "string");
  for (let c = 0; c < delims.length; c++) {
    const closer = delims[c]!;
    if (!closer.close || closer.length === 0) continue;
    for (let o = c - 1; o >= 0; o--) {
      const opener = delims[o]!;
      if (!opener.open || opener.length === 0 || opener.char !== closer.char) continue;
      if (closer.char === "~") {
        if (opener.length !== closer.length) continue;
      } else if (
        (opener.close || closer.open) &&
        (opener.length + closer.length) % 3 === 0 &&
        !(opener.length % 3 === 0 && closer.length % 3 === 0)
      ) {
        continue;
      }
      const used =
        closer.char === "~" ? closer.length : opener.length >= 2 && closer.length >= 2 ? 2 : 1;
      opener.length -= used;
      closer.length -= used;
      // Delimiters between the pair can no longer match across it.
      for (let between = o + 1; between < c; between++) {
        delims[between]!.open = false;
        delims[between]!.close = false;
      }
      if (closer.length > 0) c--;
      break;
    }
  }
}

/** `[label](dest)`, `[label][ref]`, `[label][]` or `[label]` with a definition. */
function matchLink(
  source: string,
  at: number,
  definitions: Definitions,
): { label: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let i = at; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(source.slice(i))![0];
      const end = closingRun(source, i + run.length, run.length);
      i = (end >= 0 ? end : i) + run.length - 1;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const label = source.slice(at + 1, close);
  if (label.startsWith("^")) return null;
  const next = source[close + 1];
  if (next === "(") {
    let parens = 0;
    for (let i = close + 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "(") parens++;
      else if (ch === ")" && --parens === 0) return { label, end: i + 1 };
    }
  }
  if (next === "[") {
    const end = source.indexOf("]", close + 2);
    if (end >= 0) {
      const ref = source.slice(close + 2, end);
      const key = normalizeLabel(ref === "" ? label : ref);
      if (definitions.links.has(key)) return { label, end: end + 1 };
    }
  }
  if (definitions.links.has(normalizeLabel(label))) return { label, end: close + 1 };
  return null;
}

type RawHeading = { level: number; raw: string; line: number };

function scanHeadings(lines: readonly string[], from: number): RawHeading[] {
  const headings: RawHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  let html = false;
  let paragraph: { start: number; parts: string[]; quotes: number; item: number } | null = null;
  for (let index = from; index < lines.length; index++) {
    const containers = containersOf(lines[index]!);
    const content = containers.content;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (html) {
      if (content.trim() === "") html = false;
      continue;
    }
    const open = FENCE.exec(content);
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      paragraph = null;
      continue;
    }
    if (HTML_BLOCK.test(content)) {
      html = content.trim() !== "";
      paragraph = null;
      continue;
    }
    const setext = SETEXT.exec(content);
    // The underline belongs to the paragraph only inside the same containers:
    // under a list item it must be indented into the item.
    const sameContainer =
      paragraph !== null &&
      containers.quotes === paragraph.quotes &&
      containers.item === 0 &&
      (paragraph.item === 0 ||
        /^ */.exec(lines[index]!.replace(/^(?: {0,3}> ?)*/, ""))![0].length >= paragraph.item);
    if (setext && paragraph && sameContainer) {
      headings.push({
        level: setext[1]![0] === "=" ? 1 : 2,
        raw: paragraph.parts.join("\n"),
        line: paragraph.start,
      });
      paragraph = null;
      continue;
    }
    const heading = atx(content);
    if (heading) {
      headings.push({ ...heading, line: index });
      paragraph = null;
      continue;
    }
    if (
      blocksParagraph(content) ||
      /^ {0,3}\[[^\]]+\]:/.test(content) ||
      /^ {0,3}\|/.test(content)
    ) {
      paragraph = null;
      continue;
    }
    const part = content.trim();
    // A new list item or a deeper quote starts its own paragraph; a line with
    // fewer quote markers is a lazy continuation of the quoted one.
    if (paragraph && containers.item === 0 && containers.quotes <= paragraph.quotes)
      paragraph.parts.push(part);
    else
      paragraph = { start: index, parts: [part], quotes: containers.quotes, item: containers.item };
  }
  return headings;
}

/** The document's headings in order, each with its rendered `id`. */
export function documentOutline(markdown: string): OutlineHeading[] {
  const lines = markdown.split(/\r?\n/);
  const from = frontMatterLines(lines);
  const body = lines.slice(from);
  const definitions = collectDefinitions(body);
  // GFM footnotes add ids of their own before the headings are slugged.
  const reserved = [...APP_RESERVED_IDS];
  if (definitions.footnotes) reserved.push("footnote-label");
  const slug = createHeadingSlugger(reserved);
  return scanHeadings(lines, from).map((heading) => {
    const text = inlineText(heading.raw, definitions);
    return {
      level: heading.level as OutlineHeading["level"],
      text: text.replace(/\s+/g, " ").trim(),
      id: slug(text),
      line: heading.line,
    };
  });
}
