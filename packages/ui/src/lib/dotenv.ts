/**
 * Pure `.env` text <-> key/value list conversion, plus per-row validation, for
 * `KeyValueEditor`. No React, no `dotenv` package: this runs in the browser on
 * text a user pasted, and the `dotenv` npm package is reserved for loading the
 * repo's own `.env` (see scripts/check-load-dotenv-contract.ts).
 *
 * Supported syntax — the common subset every dotenv loader agrees on:
 *
 * - blank lines and full-line `#` comments are ignored; CRLF/CR line endings
 *   and a leading BOM are accepted
 * - an optional `export ` prefix
 * - `KEY=value`; whitespace around the key and around an unquoted value is
 *   dropped; every `=` after the first belongs to the value
 * - unquoted values end at an inline comment, which needs whitespace before
 *   the `#` (`URL=https://x.test/#a` keeps its `#a`; `A=1 # note` is `1`)
 * - `'single'` quotes are literal; `"double"` quotes understand `\n`, `\r`,
 *   `\t`, `\"` and `\\`; either kind may span several physical lines
 * - a repeated key keeps its first position and takes the last value, and is
 *   reported as a `duplicate-key` error so the user sees it happened
 *
 * Deliberately unsupported: `${VAR}` expansion and backtick quotes. They are
 * loader-specific, and a value is stored exactly as the user wrote it.
 */

export type DotenvEntry = { key: string; value: string };

export type DotenvParseErrorCode =
  /** A non-comment line with no `=`. */
  | "missing-equals"
  /** The part before `=` is empty or contains whitespace or quotes. */
  | "invalid-key"
  /** A quoted value whose closing quote never appears. */
  | "unterminated-quote"
  /** Something other than a comment follows a closing quote. */
  | "trailing-characters"
  /** The key appeared earlier; the later value won. Not fatal. */
  | "duplicate-key";

export type DotenvParseError = {
  /** 1-based line number in the original text. */
  line: number;
  code: DotenvParseErrorCode;
  /** English, for logs and tests. UI text comes from the caller's labels. */
  message: string;
  /** The key, when one could be read from the line. */
  key?: string;
  /**
   * The offending source text, verbatim: every physical line the statement
   * consumed (joined with `\n`), so a multi-line quoted value with trailing
   * text keeps all of it. An unterminated quote consumes only its own line —
   * parsing resumes on the next one.
   */
  source: string;
};

/**
 * One statement of `.env` text, in source order, before repeated keys are
 * resolved: a parsed assignment, or a line (span) that failed to parse.
 * `duplicate-key` is never reported here; {@link parseDotenv} adds it.
 */
export type DotenvStatement =
  | {
      kind: "entry";
      /** 1-based line the assignment starts on. */
      line: number;
      entry: DotenvEntry;
      /** The consumed source text, verbatim (see `DotenvParseError.source`). */
      source: string;
    }
  | { kind: "error"; error: DotenvParseError };

export type DotenvParseResult = {
  entries: DotenvEntry[];
  errors: DotenvParseError[];
};

const PARSE_MESSAGES: Record<DotenvParseErrorCode, string> = {
  "missing-equals": "Expected KEY=value",
  "invalid-key": "Key is empty or contains spaces or quotes",
  "unterminated-quote": "Quoted value is never closed",
  "trailing-characters": "Unexpected text after the closing quote",
  "duplicate-key": "Key is defined more than once; the last value wins",
};

/** Parse-time key check: only what would make the line ambiguous. */
const PARSE_KEY = /^[^\s"'`=#]+$/;

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
  "\\": "\\",
};

type QuotedScan = { ok: true; value: string; rest: string; endLine: number } | { ok: false };

/**
 * Read a quoted value starting at `lines[lineIndex]`, where `text` is that
 * line's content right after the opening quote. Continues across lines (the
 * newline becomes part of the value) until the matching quote.
 */
function scanQuoted(
  lines: readonly string[],
  lineIndex: number,
  text: string,
  quote: '"' | "'",
): QuotedScan {
  let value = "";
  let current = text;
  let index = lineIndex;
  for (;;) {
    for (let i = 0; i < current.length; i++) {
      const char = current[i];
      if (quote === '"' && char === "\\" && i + 1 < current.length) {
        const next = current[i + 1] as string;
        // Unknown escapes stay as written, so a Windows path survives.
        value += DOUBLE_QUOTE_ESCAPES[next] ?? `\\${next}`;
        i++;
        continue;
      }
      if (char === quote) {
        return { ok: true, value, rest: current.slice(i + 1), endLine: index };
      }
      value += char;
    }
    index++;
    if (index >= lines.length) return { ok: false };
    value += "\n";
    current = lines[index] as string;
  }
}

function parseError(
  line: number,
  code: DotenvParseErrorCode,
  source: string,
  key?: string,
): DotenvParseError {
  return {
    line,
    code,
    message: PARSE_MESSAGES[code],
    ...(key === undefined ? {} : { key }),
    source,
  };
}

/** Split `.env` text into statements, in source order. Never throws. */
export function scanDotenv(text: string): DotenvStatement[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const statements: DotenvStatement[] = [];

  const fail = (start: number, end: number, code: DotenvParseErrorCode, key?: string) => {
    const source = lines.slice(start, end + 1).join("\n");
    statements.push({ kind: "error", error: parseError(start + 1, code, source, key) });
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex] as string;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Only the start is trimmed: trailing spaces can belong to a quoted value
    // that continues on the next line.
    const statement = raw.trimStart().replace(/^export\s+/, "");
    const equals = statement.indexOf("=");
    if (equals === -1) {
      fail(lineIndex, lineIndex, "missing-equals");
      continue;
    }
    const key = statement.slice(0, equals).trim();
    if (!PARSE_KEY.test(key)) {
      fail(lineIndex, lineIndex, "invalid-key", key);
      continue;
    }

    const startLine = lineIndex;
    const afterEquals = statement.slice(equals + 1);
    const valueStart = afterEquals.trimStart();
    let value: string;
    const quote = valueStart[0];
    if (quote === '"' || quote === "'") {
      const scan = scanQuoted(lines, lineIndex, valueStart.slice(1), quote);
      if (!scan.ok) {
        // Resume on the next line: one stray quote must not swallow the file.
        fail(lineIndex, lineIndex, "unterminated-quote", key);
        continue;
      }
      lineIndex = scan.endLine;
      const rest = scan.rest.trim();
      if (rest !== "" && !rest.startsWith("#")) {
        fail(startLine, lineIndex, "trailing-characters", key);
        continue;
      }
      value = scan.value;
    } else {
      const comment = afterEquals.search(/\s#/);
      value = (comment === -1 ? afterEquals : afterEquals.slice(0, comment)).trim();
    }

    statements.push({
      kind: "entry",
      line: startLine + 1,
      entry: { key, value },
      source: lines.slice(startLine, lineIndex + 1).join("\n"),
    });
  }

  return statements;
}

/** Parse `.env` text. Never throws; problems come back in `errors`. */
export function parseDotenv(text: string): DotenvParseResult {
  const entries: DotenvEntry[] = [];
  const positionByKey = new Map<string, number>();
  const errors: DotenvParseError[] = [];

  for (const statement of scanDotenv(text)) {
    if (statement.kind === "error") {
      errors.push(statement.error);
      continue;
    }
    const { key, value } = statement.entry;
    const existing = positionByKey.get(key);
    if (existing === undefined) {
      positionByKey.set(key, entries.length);
      entries.push({ key, value });
    } else {
      errors.push(parseError(statement.line, "duplicate-key", statement.source, key));
      entries[existing] = { key, value };
    }
  }

  return { entries, errors };
}

function quoteValue(value: string): string {
  const needsQuotes = value !== value.trim() || /[#"'\n\r\\]/.test(value) || value.startsWith("`");
  if (!needsQuotes) return value;
  // Single quotes are literal, so prefer them whenever nothing inside needs
  // an escape — the output then reads exactly like the value.
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * Inverse of {@link parseDotenv} for entries whose keys parse: one `KEY=value`
 * per line, quoting only values that need it (edge whitespace, `#`, quotes,
 * backslashes, line breaks). Fully blank rows are skipped.
 */
export function serializeDotenv(entries: readonly DotenvEntry[]): string {
  return entries
    .filter((entry) => entry.key !== "" || entry.value !== "")
    .map((entry) => `${entry.key}=${quoteValue(entry.value)}`)
    .join("\n");
}

export type KeyValueErrorCode = "empty-key" | "invalid-key" | "duplicate-key" | "reserved-key";

export type ValidateEntriesOptions = {
  /** Keys the platform sets itself; an entry using one is flagged. Case-sensitive. */
  reservedKeys?: readonly string[];
  /** Defaults to {@link DEFAULT_KEY_PATTERN}. `g`/`y` flags are ignored. */
  keyPattern?: RegExp;
};

/** POSIX-portable environment variable name. */
export const DEFAULT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A row with neither key nor value — an unfilled row, not an error. */
export function isBlankEntry(entry: DotenvEntry): boolean {
  return entry.key === "" && entry.value === "";
}

/**
 * One error code (or `null`) per entry, index-aligned with `entries`. Blank
 * rows are never errors. When several rules fail, the most fundamental wins:
 * empty, then invalid, then reserved, then duplicate. Every occurrence of a
 * duplicated key is flagged, so the user sees both rows.
 */
export function validateEntries(
  entries: readonly DotenvEntry[],
  options: ValidateEntriesOptions = {},
): (KeyValueErrorCode | null)[] {
  const source = options.keyPattern ?? DEFAULT_KEY_PATTERN;
  // A stateful (g/y) regex would alternate between matching and not.
  const pattern = new RegExp(source.source, source.flags.replace(/[gy]/g, ""));
  const reserved = new Set(options.reservedKeys ?? []);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.key !== "") counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if (isBlankEntry(entry)) return null;
    if (entry.key === "") return "empty-key";
    if (!pattern.test(entry.key)) return "invalid-key";
    if (reserved.has(entry.key)) return "reserved-key";
    if ((counts.get(entry.key) ?? 0) > 1) return "duplicate-key";
    return null;
  });
}
