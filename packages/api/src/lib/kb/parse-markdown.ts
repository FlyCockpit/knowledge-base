/** Markdown body and YAML front matter parsing for tree validation. */

export const KB_MARKDOWN_LIMITS = {
  maxFrontmatterBytes: 64 * 1024,
  maxFrontmatterDepth: 16,
  maxCitations: 100,
  maxCitationLabelScalars: 240,
  maxCitationTargetScalars: 2048,
  maxDocumentIdLength: 256,
} as const;

export type MarkdownIssueCode =
  | "MARKDOWN_UTF8"
  | "MARKDOWN_CONTROL"
  | "MARKDOWN_FRONTMATTER_DELIMITER"
  | "MARKDOWN_FRONTMATTER_SIZE"
  | "MARKDOWN_YAML"
  | "MARKDOWN_YAML_DEPTH"
  | "MARKDOWN_YAML_DUPLICATE"
  | "MARKDOWN_YAML_TAG"
  | "MARKDOWN_YAML_ALIAS"
  | "MARKDOWN_JSON_VALUE"
  | "MARKDOWN_DOCUMENT_ID"
  | "MARKDOWN_DOCUMENT_ID_DUPLICATE"
  | "MARKDOWN_CITATIONS"
  | "MARKDOWN_CITATION_SHAPE";

export type MarkdownIssue = { code: MarkdownIssueCode; message: string };

export type DocCitation = { label: string; target: string };

export type ParsedMarkdown = {
  frontMatter: Record<string, unknown>;
  body: string;
  bodyBytes: Buffer;
  documentId: string | null;
  citations: DocCitation[];
};

const SEALED_REFERENCE = /\{\{sealed:v1:knowledge_base:([0-9a-f-]{36}):([0-9a-f-]{36})\}\}/gi;

const FORBIDDEN_YAML_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function findSealedReferences(source: string): string[] {
  const refs: string[] = [];
  for (const match of source.matchAll(SEALED_REFERENCE)) {
    refs.push(`sealed:v1:knowledge_base:${match[1]}:${match[2]}`);
  }
  return refs;
}

/**
 * Fatal UTF-8 decoding that never rewrites source bytes: a leading U+FEFF byte
 * order mark is preserved instead of being silently stripped, so Git object
 * names and Markdown bodies decode to exactly the bytes that were hashed.
 */
export function decodeUtf8Fatal(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * Split a Markdown document into its optional YAML front matter and body.
 * Delimiters are located in the original UTF-8 bytes, so multibyte front matter
 * content cannot shift the body byte offset. The opening delimiter must be a
 * line containing exactly `---`; the closing delimiter is a `---` line.
 */
export function splitFrontMatter(bytes: Buffer): { yaml: Buffer | null; body: Buffer } {
  if (bytes.length === 0) return { yaml: null, body: bytes };
  if (bytes[0] !== 0x2d || bytes[1] !== 0x2d || bytes[2] !== 0x2d) {
    return { yaml: null, body: bytes };
  }
  // The opening delimiter line is exactly "---" followed by LF or CRLF (or EOF).
  if (bytes.length > 3 && bytes[3] !== 0x0a && !(bytes[3] === 0x0d && bytes[4] === 0x0a)) {
    return { yaml: null, body: bytes };
  }
  const openLineEnd = bytes.indexOf(0x0a, 3);
  if (openLineEnd < 0) return { yaml: null, body: bytes };
  const yamlStart = openLineEnd + 1;
  let close = -1;
  let cursor = yamlStart;
  while (cursor <= bytes.length) {
    const lf = bytes.indexOf(0x0a, cursor);
    const lineEnd = lf < 0 ? bytes.length : lf;
    const line = bytes.subarray(cursor, lineEnd);
    const dashEnd = line.length > 0 && line.at(-1) === 0x0d ? line.length - 1 : line.length;
    if (dashEnd === 3 && line[0] === 0x2d && line[1] === 0x2d && line[2] === 0x2d) {
      close = cursor;
      break;
    }
    if (lf < 0) break;
    cursor = lf + 1;
  }
  if (close < 0) return { yaml: null, body: bytes };
  const yamlEnd = close + 3;
  let bodyStart = yamlEnd;
  if (bytes[yamlEnd] === 0x0d && bytes[yamlEnd + 1] === 0x0a) bodyStart = yamlEnd + 2;
  else if (bytes[yamlEnd] === 0x0a) bodyStart = yamlEnd + 1;
  else if (yamlEnd !== bytes.length) return { yaml: null, body: bytes };
  return {
    yaml: bytes.subarray(yamlStart, close),
    body: bytes.subarray(bodyStart),
  };
}

export function validateMarkdownBytes(bytes: Buffer): MarkdownIssue | null {
  let text: string;
  try {
    text = decodeUtf8Fatal(bytes);
  } catch {
    return { code: "MARKDOWN_UTF8", message: "markdown must be valid UTF-8" };
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return {
        code: "MARKDOWN_CONTROL",
        message: "markdown contains forbidden control characters",
      };
    }
  }
  return null;
}

export function parseMarkdownDocument(bytes: Buffer): ParsedMarkdown | MarkdownIssue {
  const utf8Issue = validateMarkdownBytes(bytes);
  if (utf8Issue) return utf8Issue;
  const { yaml, body } = splitFrontMatter(bytes);
  let frontMatter: Record<string, unknown> = {};
  if (yaml) {
    if (yaml.byteLength > KB_MARKDOWN_LIMITS.maxFrontmatterBytes) {
      return { code: "MARKDOWN_FRONTMATTER_SIZE", message: "front matter exceeds size limit" };
    }
    const yamlText = yaml.toString("utf8");
    const parsed = parseRestrictedYaml(yamlText);
    if (!parsed.ok) return parsed.issue;
    frontMatter = parsed.value;
  }
  const jsonIssue = assertJsonSafeValue(frontMatter, 1);
  if (jsonIssue) return jsonIssue;
  if (
    Buffer.byteLength(JSON.stringify(frontMatter), "utf8") > KB_MARKDOWN_LIMITS.maxFrontmatterBytes
  ) {
    return {
      code: "MARKDOWN_FRONTMATTER_SIZE",
      message: "front matter exceeds encoded size limit",
    };
  }
  let documentId: string | null = null;
  if ("id" in frontMatter && frontMatter.id !== undefined && frontMatter.id !== null) {
    if (typeof frontMatter.id !== "string") {
      return { code: "MARKDOWN_DOCUMENT_ID", message: "document id must be a string" };
    }
    if (
      frontMatter.id.length === 0 ||
      frontMatter.id.length > KB_MARKDOWN_LIMITS.maxDocumentIdLength
    ) {
      return { code: "MARKDOWN_DOCUMENT_ID", message: "document id length is invalid" };
    }
    documentId = frontMatter.id;
  }
  let citations: DocCitation[] = [];
  if ("citations" in frontMatter) {
    if (frontMatter.citations === null) {
      return { code: "MARKDOWN_CITATIONS", message: "citations must be an array" };
    }
    if (frontMatter.citations === undefined) {
      // retain unknown omission
    } else {
      if (!Array.isArray(frontMatter.citations)) {
        return { code: "MARKDOWN_CITATIONS", message: "citations must be an array" };
      }
      if (frontMatter.citations.length > KB_MARKDOWN_LIMITS.maxCitations) {
        return { code: "MARKDOWN_CITATIONS", message: "citations exceed limit" };
      }
      citations = [];
      for (const item of frontMatter.citations) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return { code: "MARKDOWN_CITATION_SHAPE", message: "citation must be an object" };
        }
        const row = item as Record<string, unknown>;
        const keys = Object.keys(row);
        if (keys.length !== 2 || !keys.includes("label") || !keys.includes("target")) {
          return {
            code: "MARKDOWN_CITATION_SHAPE",
            message: "citation must contain only label and target",
          };
        }
        if (typeof row.label !== "string" || typeof row.target !== "string") {
          return { code: "MARKDOWN_CITATION_SHAPE", message: "citation requires label and target" };
        }
        // In Unicode mode this matches lone surrogates, not valid astral pairs.
        if (/[\uD800-\uDFFF]/u.test(row.label) || /[\uD800-\uDFFF]/u.test(row.target)) {
          return { code: "MARKDOWN_CITATION_SHAPE", message: "citation requires Unicode scalars" };
        }
        if ([...row.label].length > KB_MARKDOWN_LIMITS.maxCitationLabelScalars) {
          return { code: "MARKDOWN_CITATION_SHAPE", message: "citation label is too long" };
        }
        if ([...row.target].length > KB_MARKDOWN_LIMITS.maxCitationTargetScalars) {
          return { code: "MARKDOWN_CITATION_SHAPE", message: "citation target is too long" };
        }
        citations.push({ label: row.label, target: row.target });
      }
    }
  }
  const bodyText = decodeUtf8Fatal(body);
  return {
    frontMatter,
    body: bodyText,
    bodyBytes: body,
    documentId,
    citations,
  };
}

/**
 * Build the text the sealed-reference scan runs over. `rawSource` (the whole
 * byte-faithfully decoded Markdown document) covers YAML comments, mapping
 * keys and raw values — everything the parsed value tree discards. Decoded
 * front matter keys and string values are still walked so escape-encoded
 * references that never appear literally in the raw bytes are also caught.
 */
export function sealedReferenceScanSource(parsed: ParsedMarkdown, rawSource?: string): string {
  const parts: string[] = [];
  if (rawSource !== undefined) parts.push(rawSource);
  const walk = (value: unknown): void => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) for (const entry of value) walk(entry);
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        parts.push(key);
        walk(entry);
      }
    }
  };
  walk(parsed.frontMatter);
  if (rawSource === undefined) parts.push(parsed.body);
  return parts.join("\n");
}

type YamlParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issue: MarkdownIssue };

type YamlNode =
  | { kind: "map"; target: Record<string, unknown>; indent: number }
  | { kind: "seq"; target: unknown[]; indent: number; indentless?: boolean };

function yamlIssue(message: string): MarkdownIssue {
  return { code: "MARKDOWN_YAML", message };
}

// YAML separation on a single line is ASCII space/tab only. Unicode whitespace
// is scalar content, including in plain keys, and must survive identity checks.
function trimYamlSeparation(text: string): string {
  const trimmed = trimYamlSeparationStart(text);
  let end = trimmed.length;
  while (end > 0 && (trimmed[end - 1] === " " || trimmed[end - 1] === "\t")) end -= 1;
  return trimmed.slice(0, end);
}

function trimYamlSeparationStart(text: string): string {
  return text.replace(/^[ \t]+/, "");
}

/**
 * Restricted block+flow YAML parser for front matter. It decodes quoted keys
 * and scalars, rejects tags/anchors/aliases/merge keys and duplicate decoded
 * keys anywhere (including flow collections), enforces the depth limit during
 * parsing, and never silently reinterprets an unsupported construct as a
 * string: unsupported YAML raises an issue instead.
 */
function parseRestrictedYaml(source: string): YamlParseResult {
  // A BOM at the start of the YAML stream is syntax; anywhere inside a scalar
  // it remains content, so it must not be stripped by separation trimming.
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  // `split` turns a final line terminator into one trailing empty element;
  // that is not a real blank line (it would inflate keep-chomped block
  // scalars by one newline), so drop it.
  if (normalized.endsWith("\n")) lines.pop();
  const root = createYamlMap();
  const stack: YamlNode[] = [{ kind: "map", target: root, indent: -1 }];
  let index = 0;

  const peekContentLine = (): { line: string; indent: number } | null => {
    for (let scan = index; scan < lines.length; scan += 1) {
      const candidate = lines[scan]!;
      if (trimYamlSeparation(candidate).length === 0) continue;
      if (trimYamlSeparationStart(candidate).startsWith("#")) continue;
      const ind = lineIndent(candidate);
      if (ind.issue) return null;
      return { line: candidate, indent: ind.indent };
    }
    return null;
  };

  const pushContainer = (node: YamlNode): MarkdownIssue | null => {
    if (stack.length >= KB_MARKDOWN_LIMITS.maxFrontmatterDepth) {
      return { code: "MARKDOWN_YAML_DEPTH", message: "front matter exceeds depth limit" };
    }
    stack.push(node);
    return null;
  };

  /** Assign `key: raw` into the map at the top of the stack at column `col`. */
  const assignMapValue = (
    entry: { key: string; raw: string },
    col: number,
  ): MarkdownIssue | null => {
    const target = stack.at(-1)!;
    if (target.kind !== "map") return yamlIssue("mapping entries require a map parent");
    const value = trimYamlSeparation(entry.raw);
    if (value.length === 0) {
      const next = peekContentLine();
      if (next && next.indent >= col) {
        const nestedContent = next.line.slice(next.indent);
        if (nestedContent === "-" || nestedContent.startsWith("- ")) {
          const array: unknown[] = [];
          target.target[entry.key] = array;
          // YAML permits mapping-value sequences at the key's own column.
          // Their next sequence entry stays here; a sibling key closes them.
          return pushContainer({
            kind: "seq",
            target: array,
            indent: col,
            indentless: next.indent === col,
          });
        }
        if (next.indent > col) {
          const nested = createYamlMap();
          target.target[entry.key] = nested;
          return pushContainer({ kind: "map", target: nested, indent: col });
        }
      }
      target.target[entry.key] = null;
      return null;
    }
    if (value.startsWith("&") || value.startsWith("*")) {
      return {
        code: "MARKDOWN_YAML_ALIAS",
        message: "front matter must not use YAML anchors or aliases",
      };
    }
    if (value.startsWith("!")) {
      return { code: "MARKDOWN_YAML_TAG", message: "front matter must not use YAML tags" };
    }
    if (value.startsWith("%")) {
      return yamlIssue("YAML directives are not supported in front matter");
    }
    if (value[0] === "|" || value[0] === ">") {
      if (!/^[|>][+-]?$/.test(value)) {
        return yamlIssue("unsupported block scalar header");
      }
      const block = parseBlockScalar(value, col);
      if ("issue" in block) return block.issue;
      target.target[entry.key] = block.value;
      return null;
    }
    const inline = parseInlineValue(value, stack.length);
    if ("issue" in inline) return inline.issue;
    const next = peekContentLine();
    if (next && next.indent > col) {
      return yamlIssue("multi-line plain scalars are not supported");
    }
    target.target[entry.key] = inline.value;
    return null;
  };

  /** Consume and decode a literal/folded block scalar body after its header. */
  function parseBlockScalar(
    header: string,
    col: number,
  ): { value: string } | { issue: MarkdownIssue } {
    const literal = header[0] === "|";
    const chomp = header[1] === "-" ? "strip" : header[1] === "+" ? "keep" : "clip";
    const rawLines: string[] = [];
    let contentIndent = -1;
    while (index < lines.length) {
      const raw = lines[index]!;
      let indent = 0;
      while (raw[indent] === " ") indent += 1;
      if (indent === raw.length) {
        rawLines.push(raw);
        index += 1;
        continue;
      }
      if (indent <= col) break;
      if (contentIndent < 0) {
        contentIndent = indent;
        if (rawLines.some((blank) => blank.length > contentIndent)) {
          return { issue: yamlIssue("leading blank lines exceed block scalar indentation") };
        }
      }
      if (indent < contentIndent) {
        return { issue: yamlIssue("block scalar has inconsistent indentation") };
      }
      rawLines.push(raw);
      index += 1;
    }
    // Only indentation spaces are removed. Extra spaces, tabs and Unicode
    // whitespace are scalar content and can be part of a document's identity.
    const collected = rawLines.map((raw) => (contentIndent < 0 ? "" : raw.slice(contentIndent)));
    let trailing = 0;
    while (collected.length > 0 && collected.at(-1) === "") {
      trailing += 1;
      collected.pop();
    }
    if (collected.length === 0) {
      if (chomp === "keep" && trailing > 0) return { value: "\n".repeat(trailing) };
      return { value: "" };
    }
    let text: string;
    if (literal) {
      text = collected.join("\n");
    } else {
      let out = "";
      let started = false;
      let prevMoreIndented = false;
      let pendingBreaks = 0;
      for (const contentLine of collected) {
        const moreIndented =
          contentLine.length > 0 && (contentLine[0] === " " || contentLine[0] === "\t");
        if (contentLine.length === 0) {
          pendingBreaks += 1;
          continue;
        }
        // Leading empty lines are literal breaks. Between ordinary text
        // lines, one break folds to a space and blank lines remain breaks;
        // adjacent to more-indented text, every break remains literal.
        if (!started) out += "\n".repeat(pendingBreaks);
        else if (prevMoreIndented || moreIndented) out += "\n".repeat(pendingBreaks + 1);
        else if (pendingBreaks > 0) out += "\n".repeat(pendingBreaks);
        else out += " ";
        pendingBreaks = 0;
        out += contentLine;
        started = true;
        prevMoreIndented = moreIndented;
      }
      text = out;
    }
    if (chomp === "strip") return { value: text };
    if (chomp === "keep") return { value: `${text}\n${"\n".repeat(trailing)}` };
    return { value: `${text}\n` };
  }

  while (index < lines.length) {
    const line = lines[index]!;
    if (trimYamlSeparation(line).length === 0 || trimYamlSeparationStart(line).startsWith("#")) {
      index += 1;
      continue;
    }
    const ind = lineIndent(line);
    if (ind.issue) return { ok: false, issue: ind.issue };
    const indent = ind.indent;
    const content = line.slice(indent);
    const sequenceEntry = content === "-" || content.startsWith("- ");
    while (stack.length > 1) {
      const top = stack.at(-1)!;
      if (indent > top.indent) break;
      if (indent === top.indent && top.kind === "seq" && top.indentless && sequenceEntry) break;
      stack.pop();
    }
    const parent = stack.at(-1)!;

    if (sequenceEntry) {
      if (parent.kind !== "seq") {
        return { ok: false, issue: yamlIssue("sequence entries require an array parent") };
      }
      const rest = content === "-" ? "" : content.slice(2);
      if (rest === "-" || rest.startsWith("- ")) {
        return { ok: false, issue: yamlIssue("nested sequence entries are not supported") };
      }
      const itemText = trimYamlSeparationStart(rest);
      const itemCol = indent + 2 + (rest.length - itemText.length);
      index += 1;
      if (itemText.length === 0) {
        const next = peekContentLine();
        if (next && next.indent > indent) {
          const nestedContent = next.line.slice(next.indent);
          if (nestedContent === "-" || nestedContent.startsWith("- ")) {
            return { ok: false, issue: yamlIssue("nested sequence entries are not supported") };
          }
          const item = createYamlMap();
          parent.target.push(item);
          const depthIssue = pushContainer({ kind: "map", target: item, indent });
          if (depthIssue) return { ok: false, issue: depthIssue };
          continue;
        }
        parent.target.push(null);
        continue;
      }
      if (isMappingLine(itemText)) {
        const entry = parseMapEntry(itemText);
        if ("issue" in entry) return { ok: false, issue: entry.issue };
        const item = createYamlMap();
        parent.target.push(item);
        const depthIssue = pushContainer({ kind: "map", target: item, indent });
        if (depthIssue) return { ok: false, issue: depthIssue };
        const assigned = assignMapValue(entry, itemCol);
        if (assigned) return { ok: false, issue: assigned };
        continue;
      }
      const scalarIssue = sequenceScalarIssue(itemText);
      if (scalarIssue) return { ok: false, issue: scalarIssue };
      const inline = parseInlineValue(itemText, stack.length);
      if ("issue" in inline) return { ok: false, issue: inline.issue };
      const next = peekContentLine();
      if (next && next.indent > itemCol) {
        return { ok: false, issue: yamlIssue("multi-line plain scalars are not supported") };
      }
      parent.target.push(inline.value);
      continue;
    }

    const entry = parseMapEntry(content);
    if ("issue" in entry) return { ok: false, issue: entry.issue };
    if (parent.kind !== "map") {
      return { ok: false, issue: yamlIssue("mapping entries require a map parent") };
    }
    if (Object.hasOwn(parent.target, entry.key)) {
      return {
        ok: false,
        issue: {
          code: "MARKDOWN_YAML_DUPLICATE",
          message: `duplicate front matter key ${entry.key}`,
        },
      };
    }
    index += 1;
    const assigned = assignMapValue(entry, indent);
    if (assigned) return { ok: false, issue: assigned };
  }
  return { ok: true, value: root };
}

function sequenceScalarIssue(itemText: string): MarkdownIssue | null {
  const first = itemText[0]!;
  if (first === "&" || first === "*") {
    return {
      code: "MARKDOWN_YAML_ALIAS",
      message: "front matter must not use YAML anchors or aliases",
    };
  }
  if (first === "!") {
    return { code: "MARKDOWN_YAML_TAG", message: "front matter must not use YAML tags" };
  }
  if (first === "%") {
    return yamlIssue("YAML directives are not supported in front matter");
  }
  if (first === "|" || first === ">") {
    return yamlIssue("block scalars in sequence items are not supported");
  }
  return null;
}

type MapEntry = { key: string; raw: string } | { issue: MarkdownIssue };

/** Parse one `key: value` line, decoding quoted keys. */
function parseMapEntry(content: string): MapEntry {
  const first = content[0]!;
  let keyText: string;
  let raw: string;
  if (first === '"' || first === "'") {
    const scanned = scanQuotedScalar(content, 0);
    if ("issue" in scanned) return scanned;
    let pos = scanned.end;
    while (pos < content.length && (content[pos] === " " || content[pos] === "\t")) pos += 1;
    if (content[pos] !== ":") {
      return { issue: yamlIssue("quoted keys must be followed by a colon") };
    }
    keyText = scanned.text;
    raw = content.slice(pos + 1);
  } else {
    let colon = -1;
    for (let i = 0; i < content.length; i += 1) {
      if (content[i] !== ":") continue;
      if (i + 1 === content.length || content[i + 1] === " " || content[i + 1] === "\t") {
        colon = i;
        break;
      }
    }
    if (colon < 0) {
      return { issue: yamlIssue("front matter must use key: value mappings") };
    }
    keyText = trimYamlSeparation(content.slice(0, colon));
    const plainIssue = assertPlainScalar(keyText, false);
    if (plainIssue) return { issue: plainIssue };
    raw = content.slice(colon + 1);
  }
  const keyIssue = assertYamlKey(keyText);
  if (keyIssue) return { issue: keyIssue };
  const trimmed = trimYamlSeparation(raw);
  if (trimmed.startsWith("#")) return { key: keyText, raw: "" };
  return { key: keyText, raw: trimmed };
}

/** True when a sequence item or line is a `key: value` mapping entry. */
function isMappingLine(text: string): boolean {
  const first = text[0];
  if (first === '"' || first === "'") {
    const scanned = scanQuotedScalar(text, 0);
    if ("issue" in scanned) return false;
    let pos = scanned.end;
    while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos += 1;
    return text[pos] === ":";
  }
  // A line starting with a flow indicator is a flow collection value, not a
  // mapping: plain scalars cannot start with `[` or `{`, so treating the
  // first `key: ` inside the collection as a block mapping would misparse it.
  if (first === "[" || first === "{") return false;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ":") continue;
    if (i + 1 === text.length || text[i + 1] === " " || text[i + 1] === "\t") return true;
  }
  return false;
}

type InlineValue = { value: unknown } | { issue: MarkdownIssue };

/** Parse a complete inline value: flow collections, quoted or plain scalars. */
function parseInlineValue(raw: string, parentDepth: number): InlineValue {
  const first = raw[0]!;
  if (first === '"' || first === "'") {
    const scanned = scanQuotedScalar(raw, 0);
    if ("issue" in scanned) return scanned;
    if (!trailingContentOk(raw.slice(scanned.end))) {
      return { issue: yamlIssue("unexpected content after a quoted scalar") };
    }
    return { value: scanned.text };
  }
  if (first === "[" || first === "{") {
    const flow = parseFlowCollection(raw, parentDepth);
    if ("issue" in flow) return flow;
    if (!trailingContentOk(flow.rest)) {
      return { issue: yamlIssue("unexpected content after a flow collection") };
    }
    return { value: flow.value };
  }
  if (first === "&" || first === "*" || first === "!" || first === "%") {
    return { issue: yamlIssue("front matter values must not start with YAML indicators") };
  }
  const scalar = trimYamlSeparation(stripPlainComment(raw));
  if (/:(?:[ \t]|$)/.test(scalar)) {
    return { issue: yamlIssue("plain scalars must not contain mapping colons") };
  }
  const plainIssue = assertPlainScalar(scalar, false);
  if (plainIssue) return { issue: plainIssue };
  if (scalar.length === 0) return { value: null };
  return { value: decodePlainScalar(scalar) };
}

type FlowResult = { value: unknown; rest: string } | { issue: MarkdownIssue };

/** Parse a single-line flow collection (`[...]` / `{...}`) with nesting. */
function parseFlowCollection(text: string, parentDepth: number): FlowResult {
  let pos = 0;
  const skipSpaces = (): void => {
    while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos += 1;
  };
  const parseValue = (nested: number): { value: unknown } | { issue: MarkdownIssue } => {
    skipSpaces();
    const ch = text[pos]!;
    if (ch === "[" || ch === "{") return parseCollection(nested + 1);
    if (ch === '"' || ch === "'") {
      const scanned = scanQuotedScalar(text, pos);
      if ("issue" in scanned) return scanned;
      pos = scanned.end;
      return { value: scanned.text };
    }
    if (ch === "&" || ch === "*") {
      return {
        issue: {
          code: "MARKDOWN_YAML_ALIAS",
          message: "front matter must not use YAML anchors or aliases",
        },
      };
    }
    if (ch === "!") {
      return {
        issue: { code: "MARKDOWN_YAML_TAG", message: "front matter must not use YAML tags" },
      };
    }
    if (ch === "," || ch === "]" || ch === "}") return { value: null };
    let end = pos;
    while (end < text.length && text[end] !== "," && text[end] !== "]" && text[end] !== "}") {
      end += 1;
    }
    const token = trimYamlSeparation(text.slice(pos, end));
    pos = end;
    if (/:(?:[ \t]|$)/.test(token)) {
      return { issue: yamlIssue("flow mappings inside sequences are not supported") };
    }
    const plainIssue = assertPlainScalar(token, true);
    if (plainIssue) return { issue: plainIssue };
    return { value: decodePlainScalar(token) };
  };
  function parseCollection(nested: number): { value: unknown } | { issue: MarkdownIssue } {
    if (nested > KB_MARKDOWN_LIMITS.maxFrontmatterDepth) {
      return {
        issue: { code: "MARKDOWN_YAML_DEPTH", message: "front matter exceeds depth limit" },
      };
    }
    const isSeq = text[pos] === "[";
    const closer = isSeq ? "]" : "}";
    pos += 1;
    skipSpaces();
    if (isSeq) {
      const items: unknown[] = [];
      if (text[pos] === closer) {
        pos += 1;
        return { value: items };
      }
      while (true) {
        if (text[pos] === ",") {
          return { issue: yamlIssue("flow sequences must not contain empty entries") };
        }
        const item = parseValue(nested);
        if ("issue" in item) return item;
        items.push(item.value);
        skipSpaces();
        if (text[pos] === ",") {
          pos += 1;
          skipSpaces();
          if (text[pos] === closer) {
            pos += 1;
            return { value: items };
          }
          continue;
        }
        if (text[pos] === closer) {
          pos += 1;
          return { value: items };
        }
        return { issue: yamlIssue("flow sequence is not closed") };
      }
    }
    const map = createYamlMap();
    if (text[pos] === closer) {
      pos += 1;
      return { value: map };
    }
    while (true) {
      skipSpaces();
      const ch = text[pos]!;
      let key: string;
      if (ch === '"' || ch === "'") {
        const scanned = scanQuotedScalar(text, pos);
        if ("issue" in scanned) return scanned;
        key = scanned.text;
        pos = scanned.end;
      } else {
        let end = pos;
        while (
          end < text.length &&
          !(text[end] === ":" && (end + 1 === text.length || /[ \t[\]{},]/.test(text[end + 1]!))) &&
          text[end] !== "," &&
          text[end] !== "}" &&
          text[end] !== "]"
        ) {
          end += 1;
        }
        key = trimYamlSeparation(text.slice(pos, end));
        const plainIssue = assertPlainScalar(key, true);
        if (plainIssue) return { issue: plainIssue };
        pos = end;
      }
      const keyIssue = assertYamlKey(key);
      if (keyIssue) return { issue: keyIssue };
      skipSpaces();
      if (text[pos] !== ":") {
        return { issue: yamlIssue("flow mapping entries require a colon") };
      }
      pos += 1;
      if (Object.hasOwn(map, key)) {
        return {
          issue: {
            code: "MARKDOWN_YAML_DUPLICATE",
            message: `duplicate front matter key ${key}`,
          },
        };
      }
      const value = parseValue(nested);
      if ("issue" in value) return value;
      map[key] = value.value;
      skipSpaces();
      if (text[pos] === ",") {
        pos += 1;
        skipSpaces();
        if (text[pos] === closer) {
          pos += 1;
          return { value: map };
        }
        continue;
      }
      if (text[pos] === closer) {
        pos += 1;
        return { value: map };
      }
      return { issue: yamlIssue("flow mapping is not closed") };
    }
  }
  const result = parseCollection(parentDepth + 1);
  if ("issue" in result) return result;
  return { value: result.value, rest: text.slice(pos) };
}

type QuotedScan = { text: string; end: number } | { issue: MarkdownIssue };

/**
 * Decoded front matter strings may not reintroduce what the raw-byte check
 * forbids: double-quoted escapes (`\0`, `\x01`, `\u0000`, …) would smuggle
 * control characters past the Markdown byte validation, and escape sequences
 * can produce lone surrogates that valid UTF-8 never contains. Both would
 * break later persistence (Postgres text/jsonb rejects U+0000 and unpaired
 * surrogates), so they are rejected at decode time.
 */
function assertDecodedScalarText(text: string): MarkdownIssue | null {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return yamlIssue("decoded front matter strings must not contain control characters");
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        return yamlIssue("decoded front matter strings must not contain lone surrogates");
      }
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return yamlIssue("decoded front matter strings must not contain lone surrogates");
    }
  }
  return null;
}

/** Scan a quoted scalar starting at `start`; `end` is just past the closer. */
function scanQuotedScalar(text: string, start: number): QuotedScan {
  const quote = text[start]!;
  if (quote === "'") {
    let out = "";
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        const control = assertDecodedScalarText(out);
        if (control) return { issue: control };
        return { text: out, end: i + 1 };
      }
      out += ch;
      i += 1;
    }
    return { issue: yamlIssue("quoted scalar is not closed") };
  }
  let out = "";
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const control = assertDecodedScalarText(out);
      if (control) return { issue: control };
      return { text: out, end: i + 1 };
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "n") {
        out += "\n";
        i += 2;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i += 2;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i += 2;
        continue;
      }
      if (next === "0") {
        out += "\0";
        i += 2;
        continue;
      }
      if (next === "b") {
        out += "\b";
        i += 2;
        continue;
      }
      if (next === "f") {
        out += "\f";
        i += 2;
        continue;
      }
      if (next === "\\" || next === '"' || next === "/") {
        out += next;
        i += 2;
        continue;
      }
      if (next === "u" || next === "x" || next === "U") {
        const width = next === "u" ? 4 : next === "x" ? 2 : 8;
        const hex = text.slice(i + 2, i + 2 + width);
        if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) {
          return { issue: yamlIssue("invalid hexadecimal escape in a double-quoted scalar") };
        }
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff) {
          return { issue: yamlIssue("Unicode escape exceeds U+10FFFF") };
        }
        out += String.fromCodePoint(codePoint);
        i += 2 + width;
        continue;
      }
      return { issue: yamlIssue("unsupported escape in a double-quoted scalar") };
    }
    out += ch;
    i += 1;
  }
  return { issue: yamlIssue("quoted scalar is not closed") };
}

function stripPlainComment(raw: string): string {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "#") continue;
    if (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t") return raw.slice(0, i);
  }
  return raw;
}

function trailingContentOk(rest: string): boolean {
  if (rest.length === 0) return true;
  if (rest[0] !== " " && rest[0] !== "\t") return false;
  const trimmed = trimYamlSeparationStart(rest);
  return trimmed.length === 0 || trimmed.startsWith("#");
}

function lineIndent(
  line: string,
): { indent: number; issue?: undefined } | { issue: MarkdownIssue } {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === " ") {
      i += 1;
      continue;
    }
    if (ch === "\t") {
      return { issue: yamlIssue("YAML indentation must use spaces") };
    }
    break;
  }
  return { indent: i };
}

/** YAML 1.2 core-schema plain scalar resolution (null/bool/int/float, else string). */
function decodePlainScalar(raw: string): unknown {
  if (raw === "null" || raw === "Null" || raw === "NULL" || raw === "~") return null;
  if (raw === "true" || raw === "True" || raw === "TRUE") return true;
  if (raw === "false" || raw === "False" || raw === "FALSE") return false;
  if (/^[+-]?\.(inf|Inf|INF)$/.test(raw)) {
    return raw.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (/^\.(nan|NaN|NAN)$/.test(raw)) return Number.NaN;
  if (/^(0x[\da-fA-F]+|0o[0-7]+)$/.test(raw)) return Number(raw);
  if (/^[-+]?\d+$/.test(raw)) return Number(raw);
  if (/^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function createYamlMap(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/** Context-specific YAML syntax; quoted scalars bypass these plain restrictions. */
function assertPlainScalar(raw: string, flow: boolean): MarkdownIssue | null {
  if (
    /^[[\]{},#&*!|>'"%@`]/.test(raw) ||
    /^[?:-](?:[ \t]|$)/.test(raw) ||
    /[ \t]#/.test(raw) ||
    (flow && (/^[?:-][[\]{},]/.test(raw) || /[[\]{},]/.test(raw)))
  ) {
    return yamlIssue("unsupported YAML plain scalar syntax");
  }
  return null;
}

function assertYamlKey(key: string): MarkdownIssue | null {
  if (!key) return yamlIssue("front matter key must not be empty");
  if (key === "<<") return yamlIssue("front matter must not use YAML merge keys");
  if (key.startsWith("&") || key.startsWith("*") || key.startsWith("!")) {
    return yamlIssue("front matter keys must not use YAML anchors, aliases or tags");
  }
  if (FORBIDDEN_YAML_KEYS.has(key)) {
    return yamlIssue("front matter key is not allowed");
  }
  return null;
}

function assertJsonSafeValue(value: unknown, depth: number): MarkdownIssue | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { code: "MARKDOWN_JSON_VALUE", message: "front matter numbers must be finite" };
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return { code: "MARKDOWN_JSON_VALUE", message: "front matter integers must be safe" };
    }
    return null;
  }
  // Depth counts containers, including the root mapping, never scalar leaves.
  if (depth > KB_MARKDOWN_LIMITS.maxFrontmatterDepth) {
    return { code: "MARKDOWN_YAML_DEPTH", message: "front matter exceeds depth limit" };
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const issue = assertJsonSafeValue(entry, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const issue = assertJsonSafeValue(entry, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  return { code: "MARKDOWN_JSON_VALUE", message: "front matter contains unsupported values" };
}

export function bodyByteOffsetAfterFrontMatter(bytes: Buffer): number {
  const { body } = splitFrontMatter(bytes);
  return bytes.byteLength - body.byteLength;
}

export type DocumentProvenance = "dream" | "human" | "absent";

/** Conservative default: absent provenance is treated as human-authored for dream guards. */
export function readDocumentProvenance(frontMatter: Record<string, unknown>): DocumentProvenance {
  const value = frontMatter.provenance;
  if (value === "dream") return "dream";
  if (value === "human") return "human";
  if (value === undefined || value === null) return "absent";
  return "human";
}

export type DreamDocumentFields = {
  id: string;
  type: string;
  title: string | null;
  citations: DocCitation[];
  body: string;
};

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function serializeDreamCitation(entry: DocCitation): string {
  return `  - label: ${yamlScalar(entry.label)}\n    target: ${yamlScalar(entry.target)}`;
}

/**
 * Deterministic dream Markdown: fixed front matter key order, sorted citations,
 * literal body bytes after the closing delimiter. Sealed references must never
 * appear in serialized output — callers reject them before invoking this.
 */
export function serializeDreamMarkdown(fields: DreamDocumentFields): string {
  const lines = ["---", `id: ${yamlScalar(fields.id)}`, `type: ${yamlScalar(fields.type)}`];
  if (fields.title !== null) {
    lines.push(`title: ${yamlScalar(fields.title)}`);
  }
  lines.push("provenance: dream");
  const citations = [...fields.citations].sort((a, b) => {
    const byLabel = a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    return byLabel !== 0 ? byLabel : a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });
  if (citations.length > 0) {
    lines.push("citations:");
    for (const citation of citations) {
      lines.push(serializeDreamCitation(citation));
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n${fields.body}`;
}
