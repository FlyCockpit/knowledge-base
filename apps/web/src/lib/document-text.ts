/**
 * The server stamps who wrote a document into its front matter on every
 * write (`stampProvenance` in `packages/api/src/lib/kb/parse-markdown.ts`:
 * strip-and-stamp, a client never chooses its label; dream guards read it).
 * When that stamp is the whole front matter, it is the app's record, not
 * something the person wrote: the editor shows the text without it and the
 * provenance chip says who wrote it. The draft keeps the exact bytes.
 */
// The closing line's ending is part of it: text typed after a stamp that
// ends the file would otherwise run into its `---`.
const STAMP_ONLY_FRONT_MATTER = /^---\r?\nprovenance:[ \t]+[^\r\n]*\r?\n---\r?\n/;

/** A front-matter opener: the draft carries front matter of its own. */
const FRONT_MATTER_OPEN = /^---\r?\n/;

/**
 * `{ stamp, body }`: the app's provenance-only front matter (or "") and the
 * text the person edits. `stamp + body` is always the original text.
 *
 * Hidden only when the text shown reads the way it is stored: a body that
 * itself starts with a `---` line would read as front matter once shown
 * first (and saved so), so then nothing is hidden.
 */
export function splitProvenanceStamp(markdown: string): { stamp: string; body: string } {
  const match = STAMP_ONLY_FRONT_MATTER.exec(markdown);
  const body = match ? markdown.slice(match[0].length) : markdown;
  return match && !FRONT_MATTER_OPEN.test(body)
    ? { stamp: match[0], body }
    : { stamp: "", body: markdown };
}

/**
 * The draft for an edited body. A body that now starts front matter of its
 * own (typed above the first line) replaces the stamp: what is shown is then
 * exactly what is saved, and the server stamps provenance into that front
 * matter on save, as it would have kept it in the hidden block.
 */
export function joinProvenanceStamp(stamp: string, body: string): string {
  return stamp !== "" && !FRONT_MATTER_OPEN.test(body) ? stamp + body : body;
}

/** Strip any leading `---` … `---` front matter block. */
function bodyOf(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return lines.join("\n");
  const close = lines.indexOf("---", 1);
  return close < 0 ? lines.join("\n") : lines.slice(close + 1).join("\n");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_H1 = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const ATX_ANY = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const BREAK = /^ {0,3}(?:-[ \t]*){2,}$|^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/;
/** A Setext H1 underline: the paragraph above it is the heading. */
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;

/**
 * A document's human title: its first level-1 heading (`# Title`, or a
 * paragraph underlined with `===`), outside code blocks and front matter;
 * else its file name without `.md`.
 */
export function documentTitle(markdown: string | null, path: string): string {
  if (markdown !== null) {
    let fence: string | null = null;
    let paragraph: string[] = [];
    for (const line of bodyOf(markdown).split("\n")) {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        continue;
      }
      if (marker) {
        fence = marker;
        paragraph = [];
        continue;
      }
      const text = ATX_H1.exec(line)?.[1]?.trim();
      if (text) return text;
      if (SETEXT_H1.test(line) && paragraph.length > 0) return paragraph.join(" ");
      // A blank line, another heading or a rule (`---` under a paragraph is
      // its H2 underline) ends the paragraph.
      if (line.trim() === "" || ATX_ANY.test(line) || BREAK.test(line)) paragraph = [];
      else paragraph.push(line.trim());
    }
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "") || name;
}
