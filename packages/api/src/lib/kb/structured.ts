import { type SourceChunk, type SourceSpan, sourceTokens } from "./chunk";
import { KbDomainError } from "./errors";
import type { ParsedMarkdown } from "./parse-markdown";
import { casefoldPathKey } from "./paths";
import { compareIsoUtc, countUnicodeScalars, parseIsoUtcParts } from "./protocol/common";
import { redactForEmbed } from "./redact-for-embed";

export const STRUCTURED_LIMITS = {
  rows: 1024,
  columns: 64,
  columnScalars: 256,
  cellScalars: 1024,
} as const;
export type Scalar = string | number | boolean | null;
export type StructuredRow = { rowIndex: number; values: Record<string, Scalar>; span: SourceSpan };
export type StructuredDocument = {
  type: string | null;
  title: string | null;
  titleFolded: string | null;
  tags: string[];
  timestamp: string;
  rows: StructuredRow[];
};
export type StructuredFilters = {
  type?: string;
  title?: string;
  tags?: string[];
  timestamp?: { after?: string; before?: string };
  structured?: { column: string; equals: Scalar }[];
};
const normalize = (value: string) => value.normalize("NFC").trim();
const trimCell = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, "");
function invalid(): never {
  throw new KbDomainError("INVALID_ARGUMENT", "Invalid structured document or filter");
}

/** GFM splits on unescaped pipes, including in code spans; only \| loses its escape. */
function cells(line: string): string[] | null {
  let text = trimCell(line.replace(/[\r\n]+$/, ""));
  if (!text.includes("|")) return null;
  if (text.startsWith("|")) text = text.slice(1);
  const result: string[] = [];
  let cell = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1]!;
      if (next === "|") {
        cell += "|";
        i++;
      } else if (next === "\\") {
        cell += "\\";
        i++;
      } else {
        cell += `\\${next}`;
        i++;
      }
    } else if (text[i] === "|") {
      result.push(trimCell(cell));
      cell = "";
    } else cell += text[i];
  }
  if (trimCell(cell) || !text.endsWith("|")) result.push(trimCell(cell));
  return result;
}

function scalar(cell: string): Scalar {
  let result: Scalar = cell;
  try {
    const value: unknown = JSON.parse(cell);
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      result = value;
    }
  } catch {
    /* Non-JSON cells remain source strings. */
  }
  if (typeof result === "string") {
    const length = countUnicodeScalars(result);
    if (length === null || length > STRUCTURED_LIMITS.cellScalars) invalid();
  }
  return result;
}

/** Bounded GFM pipe tables with exact body spans. Code blocks are never rows. */
export function extractTableRows(body: string): StructuredRow[] {
  const tokens = sourceTokens(body);
  const rows: StructuredRow[] = [];
  const lines = [...body.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter((line) => line[0].length);
  let headers: string[] | null = null;
  let fence = "";
  let fenceLength = 0;
  let byte = 0;
  let tokenIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const text = line[0].replace(/[\r\n]+$/, "");
    const startByte = byte;
    byte += Buffer.byteLength(line[0]);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker?.[1]?.[0] === fence && marker[1].length >= fenceLength && !marker[2]!.trim())
        fence = "";
      continue;
    }
    if (marker) {
      fence = marker[1]![0]!;
      fenceLength = marker[1]!.length;
      headers = null;
      continue;
    }
    if (/^(?: {4}|\t)/.test(text) || !text.trim()) {
      headers = null;
      continue;
    }
    // GFM body rows require a pipe; block markers end an open table.
    if (headers && /^ {0,3}(?:#{1,6}[ \t]|>|[-+*][ \t]|\d+[.)][ \t]|<)/.test(text)) headers = null;
    const values: string[] | null = cells(text);
    if (!values) {
      headers = null;
      continue;
    }
    if (!headers) {
      const separator = cells(lines[i + 1]?.[0] ?? "");
      if (
        !separator ||
        separator.length !== values.length ||
        !separator.every((cell) => /^:?-+:?$/.test(cell))
      )
        continue;
      if (
        values.length > STRUCTURED_LIMITS.columns ||
        new Set(values).size !== values.length ||
        values.some((key) => !key || [...key].length > STRUCTURED_LIMITS.columnScalars)
      )
        invalid();
      headers = values;
      byte += Buffer.byteLength(lines[++i]![0]);
      continue;
    }
    if (rows.length >= STRUCTURED_LIMITS.rows) invalid();
    while (tokens[tokenIndex] && tokens[tokenIndex]!.end <= line.index) tokenIndex++;
    const startToken = tokenIndex;
    while (tokens[tokenIndex] && tokens[tokenIndex]!.start < line.index + text.length) tokenIndex++;
    rows.push({
      rowIndex: rows.length,
      values: Object.fromEntries(headers.map((key, n) => [key, scalar(values[n] ?? "")])),
      span: {
        startToken,
        endToken: tokenIndex,
        startByte,
        endByte: startByte + Buffer.byteLength(text),
      },
    });
  }
  return rows;
}

/**
 * Store every safe row once on its first retained intersecting piece. Other
 * intersecting pieces hold only a reference to that immutable chunk ordinal.
 * Each row has an independent, exact source citation; neither its values nor
 * its citation are constrained by the model's embedding context. Full-row
 * redaction runs before storage, so splitting cannot reveal a credential.
 */
export function structuredRowsForChunks(
  body: Buffer,
  rows: StructuredRow[],
  chunks: SourceChunk[],
) {
  type Stored = StructuredRow & { citation: SourceSpan & { body: string } };
  const stored = new Map<number, (Stored | { rowIndex: number; chunkIndex: number })[]>();
  for (const row of rows) {
    const intersecting = chunks.filter(
      (chunk) => row.span.startByte < chunk.span.endByte && row.span.endByte > chunk.span.startByte,
    );
    const anchor = intersecting[0];
    if (!anchor) continue; // all pieces withheld by the credential floor
    const text = redactForEmbed(
      body.subarray(row.span.startByte, row.span.endByte).toString("utf8"),
    );
    if (text === null) continue;
    for (const chunk of intersecting) {
      const entries = stored.get(chunk.chunkIndex) ?? [];
      entries.push(
        chunk === anchor
          ? { ...row, citation: { ...row.span, body: text } }
          : { rowIndex: row.rowIndex, chunkIndex: anchor.chunkIndex },
      );
      stored.set(chunk.chunkIndex, entries);
    }
  }
  return stored;
}

export function extractStructuredDocument(
  parsed: ParsedMarkdown,
  commitTimestamp: string,
): StructuredDocument {
  const fm = parsed.frontMatter;
  // Invalid present valid_from does not silently acquire a different timestamp.
  const timestamp = fm.valid_from === undefined ? commitTimestamp : fm.valid_from;
  if (typeof timestamp !== "string" || parseIsoUtcParts(timestamp) === null) invalid();
  const title = typeof fm.title === "string" ? normalize(fm.title) : null;
  return {
    type: typeof fm.type === "string" ? normalize(fm.type) : null,
    title,
    titleFolded: title === null ? null : casefoldPathKey(title),
    tags: Array.isArray(fm.tags)
      ? [
          ...new Set(
            fm.tags
              .filter((tag): tag is string => typeof tag === "string")
              .map(normalize)
              .filter(Boolean),
          ),
        ]
      : [],
    timestamp,
    rows: extractTableRows(parsed.body),
  };
}

/** Returns exact matching rows, or [null] for a matching document without row predicates. */
export function matchStructuredDocument(
  document: StructuredDocument,
  filters: StructuredFilters,
): (StructuredRow | null)[] {
  const { after, before } = filters.timestamp ?? {};
  for (const stamp of [after, before])
    if (stamp !== undefined && parseIsoUtcParts(stamp) === null) invalid();
  if (after !== undefined && before !== undefined && compareIsoUtc(after, before)! >= 0) invalid();
  if (
    (filters.type !== undefined && document.type !== normalize(filters.type)) ||
    (filters.title !== undefined &&
      !document.titleFolded?.includes(casefoldPathKey(normalize(filters.title)))) ||
    filters.tags?.some((tag) => !document.tags.includes(normalize(tag))) ||
    (after !== undefined && compareIsoUtc(document.timestamp, after)! < 0) ||
    (before !== undefined && compareIsoUtc(document.timestamp, before)! >= 0)
  )
    return [];
  if (!filters.structured?.length) return [null];
  return document.rows.filter((row) =>
    filters.structured!.every(
      (condition) =>
        Object.hasOwn(row.values, condition.column) &&
        row.values[condition.column] === condition.equals,
    ),
  );
}

/** Request-side exact filters, normalized exactly like the indexed StructuredDocument fields. */
export type NormalizedStructuredFilters = {
  type: string | null;
  titleFolded: string | null;
  tags: string[];
  /** isoSortKey of the inclusive lower / exclusive upper timestamp bound. */
  afterKey: string | null;
  beforeKey: string | null;
  /** All same-row equality conditions as one JSON object (null prototype), or null. */
  row: Record<string, Scalar> | null;
  /** Two conditions on one column with different values: no row can ever match. */
  impossible: boolean;
};

/**
 * Fixed-width `YYYY-MM-DDTHH:MM:SS` + 9-digit fraction. For the contract's UTC `Z` instants its
 * bytewise order equals compareIsoUtc, so SQL and JS compare timestamps identically.
 */
export function isoSortKey(iso: string): string {
  if (parseIsoUtcParts(iso) === null) invalid();
  const fraction = /\.(\d{1,9})Z$/.exec(iso)?.[1] ?? "";
  return `${iso.slice(0, 19)}${fraction.padEnd(9, "0")}`;
}

export function normalizeStructuredFilters(
  filters: StructuredFilters,
): NormalizedStructuredFilters {
  const { after, before } = filters.timestamp ?? {};
  const afterKey = after === undefined ? null : isoSortKey(after);
  const beforeKey = before === undefined ? null : isoSortKey(before);
  if (afterKey !== null && beforeKey !== null && afterKey >= beforeKey) invalid();
  let row: Record<string, Scalar> | null = null;
  let impossible = false;
  for (const { column, equals } of filters.structured ?? []) {
    row ??= Object.create(null) as Record<string, Scalar>;
    if (Object.hasOwn(row, column) && row[column] !== equals) impossible = true;
    row[column] = equals;
  }
  return {
    type: filters.type === undefined ? null : normalize(filters.type),
    titleFolded: filters.title === undefined ? null : casefoldPathKey(normalize(filters.title)),
    tags: [...new Set((filters.tags ?? []).map(normalize))].sort(),
    afterKey,
    beforeKey,
    row,
    impossible,
  };
}
