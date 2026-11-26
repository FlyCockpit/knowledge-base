"use client";

import { Button } from "@knowledge-base/ui/components/button";
import { Input } from "@knowledge-base/ui/components/input";
import { FieldError, type FieldLike } from "@knowledge-base/ui/components/text-field";
import { Textarea } from "@knowledge-base/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@knowledge-base/ui/components/toggle-group";
import {
  type DotenvEntry,
  type DotenvParseError,
  type DotenvParseErrorCode,
  isBlankEntry,
  type KeyValueErrorCode,
  parseDotenv,
  scanDotenv,
  serializeDotenv,
  type ValidateEntriesOptions,
  validateEntries,
} from "@knowledge-base/ui/lib/dotenv";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Eye, EyeOff, FileUp, Plus, Trash2 } from "lucide-react";
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * One editor row. `unparsed` marks a `.env` line (or multi-line span) that did
 * not parse: its verbatim text is held in `value` under an empty `key`, so it
 * is never mistaken for a valid entry — even without the marker,
 * `validateEntries` flags a value with no key — and it round-trips back to
 * text unchanged. Use {@link unparsedKeyValueEntry} to make one.
 */
export type KeyValueEntry = DotenvEntry & { unparsed?: true };

const BLANK: KeyValueEntry = { key: "", value: "" };

/** A row holding `.env` text that did not parse, verbatim. */
export function unparsedKeyValueEntry(source: string): KeyValueEntry {
  return { key: "", value: source, unparsed: true };
}

export function isUnparsedEntry(entry: KeyValueEntry): boolean {
  return entry.unparsed === true;
}

/**
 * Every user-visible string. This package is i18n-free; the app passes
 * translated text. `row` arguments are 1-based, for "Key, row 2"-style labels
 * on rows whose key is still empty.
 */
export type KeyValueEditorLabels = {
  /** Column header (sm: and up) and key input placeholder. */
  key: string;
  /** Column header (sm: and up) and value input placeholder. */
  value: string;
  /** aria-label of a row's key input. */
  keyInput: (row: number) => string;
  /** aria-label of a row's value input. `key` may be empty. */
  valueInput: (key: string, row: number) => string;
  /** aria-label of the input holding a `.env` line that did not parse. */
  unparsedLine: (row: number) => string;
  /**
   * Shown next to a masked multi-line value (a certificate) in place of its
   * content, until it is revealed.
   */
  maskedLines: (lines: number) => string;
  add: string;
  /** aria-label of a row's remove button. `key` may be empty. */
  remove: (key: string, row: number) => string;
  /**
   * aria-label of a secret row's reveal toggle. The label stays the same in
   * both states; `aria-pressed` carries whether the value is shown.
   */
  reveal: (key: string, row: number) => string;
  importFile: string;
  /** aria-label of the Rows / .env text switch. */
  mode: string;
  rowsMode: string;
  textMode: string;
  /** Shown under the text area in .env text mode. */
  textHint: string;
  /** Also shown in text mode when any row is secret: values are unmasked there. */
  secretTextHint: string;
  errors: {
    emptyKey: string;
    invalidKey: (key: string) => string;
    duplicateKey: (key: string) => string;
    reservedKey: (key: string) => string;
    /** Never given the line's content: it may hold a secret. */
    parseLine: (line: number, code: DotenvParseErrorCode) => string;
  };
};

/** English strings for tests and docs. Never applied implicitly — pass `labels`. */
export const keyValueEditorEnglishLabels: KeyValueEditorLabels = {
  key: "Key",
  value: "Value",
  keyInput: (row) => `Key, row ${row}`,
  valueInput: (key, row) => (key ? `Value for ${key}` : `Value, row ${row}`),
  unparsedLine: (row) => `Unparsed line, row ${row}`,
  maskedLines: (lines) => (lines === 1 ? "1 line, hidden" : `${lines} lines, hidden`),
  add: "Add variable",
  remove: (key, row) => (key ? `Remove ${key}` : `Remove row ${row}`),
  reveal: (key, row) => (key ? `Show value of ${key}` : `Show value, row ${row}`),
  importFile: "Import .env file",
  mode: "Editing mode",
  rowsMode: "Rows",
  textMode: ".env text",
  textHint: "One KEY=value per line. Lines starting with # are ignored.",
  secretTextHint: "Secret values are shown unmasked in this view.",
  errors: {
    emptyKey: "Enter a key for this value",
    invalidKey: (key) =>
      `${key} is not a valid key. Use letters, digits and underscores, not starting with a digit.`,
    duplicateKey: (key) => `${key} is defined more than once`,
    reservedKey: (key) => `${key} is set by the platform`,
    parseLine: (line, code) => {
      const reason: Record<DotenvParseErrorCode, string> = {
        "missing-equals": "expected KEY=value",
        "invalid-key": "the key is empty or contains spaces or quotes",
        "unterminated-quote": "the quoted value is never closed",
        "trailing-characters": "unexpected text after the closing quote",
        "duplicate-key": "this key was already defined; the last value wins",
      };
      return `Line ${line}: ${reason[code]}`;
    },
  },
};

export type KeyValueValidationOptions = ValidateEntriesOptions;

/**
 * For a form validator: true when any row would be flagged inline, or any row
 * holds a `.env` line that has not been turned into a valid entry yet.
 */
export function hasKeyValueErrors(
  entries: readonly KeyValueEntry[],
  options: KeyValueValidationOptions = {},
): boolean {
  return (
    entries.some((entry) => isUnparsedEntry(entry) && !isBlankEntry(entry)) ||
    validateEntries(entries, options).some((code) => code !== null)
  );
}

/**
 * Parse `.env` text into editor rows without dropping anything the user
 * typed: a line that fails to parse (other than a repeated key, which is
 * resolved) becomes an {@link unparsedKeyValueEntry} at its position, holding
 * the full source span verbatim. `hasKeyValueErrors` blocks submit while one
 * is left, and {@link serializeKeyValueEntries} writes it back unchanged.
 */
export function keyValueEntriesFromText(text: string): {
  entries: KeyValueEntry[];
  parsed: KeyValueEntry[];
  errors: DotenvParseError[];
} {
  const entries: KeyValueEntry[] = [];
  const positionByKey = new Map<string, number>();
  for (const statement of scanDotenv(text)) {
    if (statement.kind === "error") {
      entries.push(unparsedKeyValueEntry(statement.error.source));
      continue;
    }
    const { key, value } = statement.entry;
    const existing = positionByKey.get(key);
    if (existing === undefined) {
      positionByKey.set(key, entries.length);
      entries.push({ key, value });
    } else {
      entries[existing] = { key, value };
    }
  }
  const { entries: parsed, errors } = parseDotenv(text);
  return { entries, parsed, errors };
}

/**
 * Editor rows to `.env` text: `serializeDotenv` for entries, the verbatim
 * source for unparsed rows. Fully blank rows are skipped.
 */
export function serializeKeyValueEntries(entries: readonly KeyValueEntry[]): string {
  return entries
    .filter((entry) => !isBlankEntry(entry))
    .map((entry) =>
      isUnparsedEntry(entry)
        ? entry.value
        : serializeDotenv([{ key: entry.key, value: entry.value }]),
    )
    .join("\n");
}

/** Number of lines in `text` (a value with no line break has one). */
export function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

/**
 * Merge `incoming` into `base`: an incoming key that already exists replaces
 * that row's value in place; new keys are inserted at `insertAt` (default: the
 * end), in order. Unparsed rows (empty key) are always inserted.
 */
export function mergeKeyValueEntries(
  base: readonly KeyValueEntry[],
  incoming: readonly KeyValueEntry[],
  insertAt: number = base.length,
): KeyValueEntry[] {
  const result = [...base];
  const added: KeyValueEntry[] = [];
  for (const entry of incoming) {
    const existing = entry.key === "" ? -1 : result.findIndex((row) => row.key === entry.key);
    if (existing === -1) added.push(entry);
    else result[existing] = entry;
  }
  return [...result.slice(0, insertAt), ...added, ...result.slice(insertAt)];
}

/**
 * What importing a `.env` file's `text` should turn `current` into: its rows
 * merged in, blank rows dropped. Pass the field value as of when the file has
 * been read, not when it was chosen.
 */
export function importKeyValueText(
  current: readonly KeyValueEntry[],
  text: string,
): KeyValueEntry[] {
  return mergeKeyValueEntries(
    current.filter((entry) => !isBlankEntry(entry)),
    keyValueEntriesFromText(text).entries,
  );
}

/**
 * What pasting `text` into row `index`'s key input should produce, or `null`
 * to let the browser paste normally. Multi-line text is always treated as a
 * `.env` snippet; a single `KEY=value` line only when the key input is empty
 * (so pasting `a=b` into the middle of an existing key still works). A blank
 * target row is replaced by the pasted rows.
 */
export function pasteKeyValueText(
  rows: readonly KeyValueEntry[],
  index: number,
  text: string,
): KeyValueEntry[] | null {
  const target = rows[index];
  const multiline = /[\r\n]/.test(text.trim());
  if (!multiline && !(text.includes("=") && target?.key === "")) return null;
  const { entries } = keyValueEntriesFromText(text);
  if (entries.length === 0) return null;
  if (target && isBlankEntry(target)) {
    return mergeKeyValueEntries(
      rows.filter((_, i) => i !== index),
      entries,
      index,
    );
  }
  return mergeKeyValueEntries(rows, entries, index + 1);
}

/**
 * What leaving an edited unparsed row should produce: the row's text parsed
 * again, so `JUNK` fixed to `JUNK=1` becomes a normal row. Text that empties
 * out (blank, comments only) leaves a blank row. `null` when nothing changes.
 */
export function settleUnparsedRow(
  rows: readonly KeyValueEntry[],
  index: number,
): KeyValueEntry[] | null {
  const entry = rows[index];
  if (!entry || !isUnparsedEntry(entry)) return null;
  const { entries } = keyValueEntriesFromText(entry.value);
  if (sameEntries(entries, [entry])) return null;
  return [
    ...rows.slice(0, index),
    ...(entries.length > 0 ? entries : [BLANK]),
    ...rows.slice(index + 1),
  ];
}

function sameEntries(a: readonly KeyValueEntry[], b: readonly KeyValueEntry[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every(
        (entry, i) =>
          entry.key === b[i]?.key &&
          entry.value === b[i]?.value &&
          isUnparsedEntry(entry) === isUnparsedEntry(b[i] as KeyValueEntry),
      ))
  );
}

function rowErrorMessage(code: KeyValueErrorCode, key: string, labels: KeyValueEditorLabels) {
  switch (code) {
    case "empty-key":
      return labels.errors.emptyKey;
    case "invalid-key":
      return labels.errors.invalidKey(key);
    case "duplicate-key":
      return labels.errors.duplicateKey(key);
    case "reserved-key":
      return labels.errors.reservedKey(key);
  }
}

/**
 * The inline message for each row, index-aligned, or `null`. An unparsed row
 * gets the line it occupies in the `.env` text view and the reason — never
 * its content, which may hold a secret.
 */
export function keyValueRowMessages(
  rows: readonly KeyValueEntry[],
  labels: KeyValueEditorLabels,
  options: KeyValueValidationOptions = {},
): (string | null)[] {
  const codes = validateEntries(rows, options);
  let line = 1;
  return rows.map((entry, index) => {
    if (isBlankEntry(entry)) return null;
    const startLine = line;
    if (isUnparsedEntry(entry)) {
      line += lineCount(entry.value);
      const problem = scanDotenv(entry.value).find((statement) => statement.kind === "error");
      return problem?.kind === "error"
        ? labels.errors.parseLine(startLine + problem.error.line - 1, problem.error.code)
        : null;
    }
    line += 1;
    const code = codes[index] ?? null;
    return code === null ? null : rowErrorMessage(code, entry.key, labels);
  });
}

/** Messages for text mode: parse errors by line, then key problems by key. */
export function keyValueTextMessages(
  text: string,
  labels: KeyValueEditorLabels,
  options: KeyValueValidationOptions = {},
): string[] {
  const { parsed, errors } = keyValueEntriesFromText(text);
  const messages = errors.map((error) => labels.errors.parseLine(error.line, error.code));
  const codes = validateEntries(parsed, options);
  for (const [i, code] of codes.entries()) {
    const entry = parsed[i];
    if (code === null || !entry) continue;
    const message = rowErrorMessage(code, entry.key, labels);
    if (!messages.includes(message)) messages.push(message);
  }
  return messages;
}

type Mode = "rows" | "text";

type TextDraft = {
  text: string;
  /** The value this draft last produced — a different `value` means an outside change. */
  committed: readonly KeyValueEntry[];
};

/**
 * Per-row view state, by index. Valid only for `value`: any change the editor
 * did not record here as a single-row text edit (paste, import, add, remove,
 * a reset from outside) resets it, so a reveal never lands on another row.
 */
type RowState = {
  value: readonly KeyValueEntry[];
  /** Rows whose secret value (or unparsed line) is unmasked. */
  revealed: ReadonlySet<number>;
  /**
   * Rows showing a textarea. Once a row has one it keeps it while edited, so
   * deleting the last line break does not swap the element under the caret.
   */
  multiline: ReadonlySet<number>;
};

const NONE: ReadonlySet<number> = new Set();

/** What a masked multi-line value shows: a fixed mask, never the value. */
const MASK = "\u2022".repeat(8);

const hasLineBreak = (text: string) => /[\r\n]/.test(text);

// Password managers key off these to skip a field; `autoComplete` alone is
// not enough for them.
const PASSWORD_MANAGER_IGNORE = {
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

const TEXT_INPUT_PROPS = {
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  inputMode: "text",
  ...PASSWORD_MANAGER_IGNORE,
} as const;

type ValueControlProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  /** Masked: a password input, or for a multi-line value a read-only mask. */
  masked: boolean;
  /** Edit as a textarea, keeping line breaks. */
  multiline: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  maskedLines: (lines: number) => string;
  className?: string;
  controlRef?: (element: HTMLElement | null) => void;
};

/**
 * A row's text control. `<input>` drops line breaks, so a value that has any
 * (a certificate) is a textarea, sized to its content; masked, it is a
 * read-only mask plus the line count until revealed.
 */
/**
 * The value after pasting `text` over the selection `start…end` of `value`
 * (appended when the selection is unknown, as on a password input). Line
 * endings become `\n`, as a textarea would make them, so the caret offset
 * computed from the pasted text matches what ends up in the box.
 */
export function pasteIntoValue(
  value: string,
  text: string,
  start: number | null,
  end: number | null,
): string {
  const pasted = normalizeLineEndings(text);
  if (start === null || end === null) return value + pasted;
  return value.slice(0, start) + pasted + value.slice(end);
}

/** `\r\n` and a lone `\r` as `\n`. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function ValueControl({
  id,
  label,
  value,
  onChange,
  onBlur,
  masked,
  multiline,
  invalid,
  describedBy,
  maskedLines,
  className,
  controlRef,
}: ValueControlProps) {
  // Where the caret goes once a multi-line paste has turned this input into
  // a textarea (the element changes, so focus must be put back).
  const refocusAt = useRef<number | null>(null);
  const textareaRef = (element: HTMLTextAreaElement | null) => {
    controlRef?.(element);
    if (element && refocusAt.current !== null) {
      element.focus();
      element.setSelectionRange(refocusAt.current, refocusAt.current);
      refocusAt.current = null;
    }
  };
  const shared = {
    "aria-label": label,
    "aria-invalid": invalid || undefined,
    onBlur,
    ...TEXT_INPUT_PROPS,
  };
  if (masked && hasLineBreak(value)) {
    const hintId = `${id}-lines`;
    return (
      <div className={cn("flex min-w-0 items-center gap-2", className)}>
        <Input
          {...shared}
          ref={controlRef}
          aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
          className="min-w-0 flex-1 font-mono"
          type="password"
          readOnly
          value={MASK}
          autoComplete="new-password"
        />
        <span id={hintId} className="shrink-0 text-xs text-muted-foreground">
          {maskedLines(lineCount(value))}
        </span>
      </div>
    );
  }
  if (multiline && !masked) {
    return (
      <Textarea
        {...shared}
        ref={textareaRef}
        aria-describedby={describedBy}
        className={cn("min-h-0 font-mono", className)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
    );
  }
  return (
    <Input
      {...shared}
      ref={controlRef}
      aria-describedby={describedBy}
      className={cn("font-mono", className)}
      type={masked ? "password" : "text"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onPaste={(event) => {
        // A single-line <input> drops the line breaks of pasted text (a PEM
        // certificate, two .env lines into an unparsed row). Insert it
        // ourselves; the value then has a break and this becomes a textarea.
        const text = event.clipboardData.getData("text/plain");
        if (!hasLineBreak(text)) return;
        event.preventDefault();
        const { selectionStart, selectionEnd } = event.currentTarget;
        // A masked value becomes the read-only mask, not a textarea: nothing to refocus.
        if (!masked)
          refocusAt.current = (selectionStart ?? value.length) + normalizeLineEndings(text).length;
        onChange(pasteIntoValue(value, text, selectionStart, selectionEnd));
      }}
      autoComplete={masked ? "new-password" : "off"}
    />
  );
}

type KeyValueEditorProps = {
  field: FieldLike<KeyValueEntry[]>;
  /** The fieldset legend. */
  label: string;
  description?: React.ReactNode;
  labels: KeyValueEditorLabels;
  /**
   * Masks values (all of them, or those whose key the function accepts) with
   * a per-row reveal toggle.
   */
  secret?: boolean | ((key: string) => boolean);
  /** Keys the platform sets; using one is flagged inline. Case-sensitive. */
  reservedKeys?: readonly string[];
  /** Overrides the default `^[A-Za-z_][A-Za-z0-9_]*$` key rule. */
  keyPattern?: RegExp;
  /** Offer the Rows / .env text switch. Default `true`. */
  textMode?: boolean;
  /** Offer the "Import .env file" button. Default `true`. */
  fileImport?: boolean;
  disabled?: boolean;
  /** Styles the fieldset. */
  className?: string;
};

/**
 * Environment-variable style KEY=value list editor, wired to a TanStack Form
 * `field` holding `KeyValueEntry[]` — the list counterpart to `TextField`.
 * Never a JSON textarea: rows by default, with an optional `.env` text view
 * for bulk edits, paste-to-rows on the key inputs, and `.env` file import.
 *
 * Validation is inline per row (empty / invalid / duplicate / reserved key)
 * and advisory; to block submit, validate the field with
 * `hasKeyValueErrors(value, { reservedKeys, keyPattern })` and return a
 * summary message, which renders under the editor like any field error.
 *
 * The value can contain fully blank rows (an added row not filled in yet).
 * They are never errors; drop them before saving
 * (`value.filter((entry) => !isBlankEntry(entry))`, from
 * `@knowledge-base/ui/lib/dotenv`).
 *
 * Secret values render as `type="password"` with
 * `autoComplete="new-password"`, not `"off"`: browsers ignore `"off"` on
 * password inputs and will autofill the user's saved login password into an
 * env var value. `"new-password"` stops that fill, and the `data-*-ignore`
 * attributes keep 1Password, LastPass and Bitwarden from offering to fill or
 * save. The `.env` text view shows secrets unmasked — it is the user's own
 * data, switching to it is an explicit action, and `secretTextHint` says so.
 *
 * Text mode keeps its own draft so the text is not reformatted while the user
 * types; each edit is parsed and committed to the field. Lines that fail to
 * parse are listed with their line numbers and kept verbatim as unparsed rows
 * (see `keyValueEntriesFromText`), so switching back to rows loses nothing;
 * they block `hasKeyValueErrors`, are masked whenever `secret` is set, and
 * their messages give the line and reason, never the text.
 *
 * A value with line breaks (an imported certificate) is edited in a textarea
 * in its row, so the breaks survive; masked, it shows a fixed mask and its
 * line count until revealed. Reveals reset on every change other than typing
 * in a row (paste, import, add, remove, mode switch, an outside change).
 */
function KeyValueEditor({
  field,
  label,
  description,
  labels,
  secret = false,
  reservedKeys,
  keyPattern,
  textMode: allowTextMode = true,
  fileImport = true,
  disabled,
  className,
}: KeyValueEditorProps) {
  const reactId = useId();
  const baseId = `${reactId}-${field.name}`;
  const legendId = `${baseId}-legend`;
  const descriptionId = `${baseId}-description`;
  const fieldErrorId = `${baseId}-error`;
  const textHintId = `${baseId}-text-hint`;
  const textErrorId = `${baseId}-text-error`;

  const value = field.state.value;
  const [mode, setMode] = useState<Mode>("rows");
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const [rowState, setRowState] = useState<RowState>(() => ({
    value,
    revealed: NONE,
    multiline: NONE,
  }));
  // First control of each row (key input, or an unparsed row's input).
  const rowControls = useRef(new Map<number, HTMLElement>());
  const fileInput = useRef<HTMLInputElement>(null);
  // The value as of the latest render, for work that finishes later (a file
  // read): merging into the value captured when it started would overwrite
  // edits made meanwhile.
  // The value a file import merges into when its read resolves (seconds
  // later): kept current after each commit, never written during render.
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  });

  const validation = { reservedKeys, keyPattern };
  // An empty list still shows one blank row to type into; it only becomes
  // part of the value once edited.
  const rows = value.length > 0 ? value : [BLANK];
  const rowMessages = keyValueRowMessages(rows, labels, validation);
  const isSecret = (key: string) => (typeof secret === "function" ? secret(key) : secret);
  // Any secret configuration masks unparsed lines: one may be a secret
  // assignment whose key could not be read.
  const maskUnparsed = secret !== false;
  const anySecret =
    secret === true ||
    (typeof secret === "function" &&
      value.some((entry) => isUnparsedEntry(entry) || secret(entry.key)));
  const { maskedLines } = labels;

  // Adjusting state during render, not in an effect, so stale state never
  // paints. The field changed without a single-row edit recording it: drop
  // per-row state that would now point at the wrong rows.
  let rowView = rowState;
  if (!sameEntries(rowView.value, value)) {
    rowView = { value, revealed: NONE, multiline: NONE };
    setRowState(rowView);
  }
  // The field changed from outside while the text view is open (a reset, an
  // import): rebuild the draft.
  let activeDraft = draft;
  if (mode === "text" && (activeDraft === null || !sameEntries(activeDraft.committed, value))) {
    activeDraft = { text: serializeKeyValueEntries(value), committed: value };
    setDraft(activeDraft);
  }

  const commit = (next: KeyValueEntry[]) => field.handleChange(next);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setDraft(next === "text" ? { text: serializeKeyValueEntries(value), committed: value } : null);
    setRowState({ value, revealed: NONE, multiline: NONE });
    setMode(next);
  };

  /** A single-row text edit: the only change that keeps per-row state. */
  const updateRow = (index: number, patch: Partial<KeyValueEntry>) => {
    const next = rows.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
    const editedText = patch.value !== undefined && hasLineBreak(rows[index]?.value ?? "");
    setRowState((current) => ({
      value: next,
      revealed: current.revealed,
      multiline: editedText ? new Set(current.multiline).add(index) : current.multiline,
    }));
    commit(next);
  };

  const addRow = () => {
    const newIndex = rows.length;
    // flushSync renders the new row before the lookup below, so focus moves
    // in the same click — no effect, and no autoFocus that would also fire
    // when rows mount for other reasons (a mode switch, a reset).
    flushSync(() => commit([...rows, BLANK]));
    rowControls.current.get(newIndex)?.focus();
  };

  const removeRow = (index: number) => {
    const next = value.filter((_, i) => i !== index);
    flushSync(() => commit(next));
    // There is always a row 0 (the blank placeholder when the list empties).
    rowControls.current.get(Math.min(index, Math.max(next.length, 1) - 1))?.focus();
  };

  const toggleReveal = (index: number) => {
    setRowState((current) => {
      const revealed = new Set(current.revealed);
      if (revealed.has(index)) revealed.delete(index);
      else revealed.add(index);
      return { ...current, revealed };
    });
  };

  const changeText = (text: string) => {
    const { entries } = keyValueEntriesFromText(text);
    setDraft({ text, committed: entries });
    commit(entries);
  };

  const fieldErrors = field.state.meta.errors;
  const hasFieldError = fieldErrors.some(Boolean);
  const describedBy =
    [description ? descriptionId : null, hasFieldError ? fieldErrorId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  // A field-level error ("fix the highlighted variables", "at least one is
  // required") marks one control invalid too, so focusFirstInvalidField can
  // land on the editor: the first flagged row, else the first row.
  const fieldErrorRow = hasFieldError
    ? Math.max(
        rowMessages.findIndex((message) => message !== null),
        0,
      )
    : -1;

  const textMessages =
    mode === "text" && activeDraft
      ? keyValueTextMessages(activeDraft.text, labels, validation)
      : [];

  const toolbarButtonClass = "h-11 min-w-11 px-3 md:h-8 md:min-w-8 md:px-2.5";

  const registerControl = (index: number) => (element: HTMLElement | null) => {
    if (element) rowControls.current.set(index, element);
    else rowControls.current.delete(index);
  };

  const revealButton = (key: string, index: number, shown: boolean) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={labels.reveal(key, index + 1)}
      aria-pressed={shown}
      onClick={() => toggleReveal(index)}
    >
      {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </Button>
  );

  const removeButton = (key: string, index: number) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={labels.remove(key, index + 1)}
      onClick={() => removeRow(index)}
    >
      <Trash2 aria-hidden="true" />
    </Button>
  );

  return (
    <fieldset
      className={cn("min-w-0 space-y-3", className)}
      disabled={disabled}
      aria-describedby={describedBy}
    >
      <legend id={legendId} className="mb-2 text-sm leading-none font-medium">
        {label}
      </legend>
      {description ? (
        <div id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </div>
      ) : null}

      {allowTextMode ? (
        <ToggleGroup
          variant="outline"
          aria-label={labels.mode}
          value={[mode]}
          onValueChange={(next) => {
            // Pressing the active item again would empty the group; ignore it.
            const picked = next[0];
            if (picked === "rows" || picked === "text") switchMode(picked);
          }}
        >
          <ToggleGroupItem value="rows" className={toolbarButtonClass}>
            {labels.rowsMode}
          </ToggleGroupItem>
          <ToggleGroupItem value="text" className={toolbarButtonClass}>
            {labels.textMode}
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}

      {mode === "text" && activeDraft ? (
        <div className="min-w-0 space-y-2">
          <Textarea
            aria-labelledby={legendId}
            aria-describedby={[
              textHintId,
              textMessages.length > 0 ? textErrorId : null,
              hasFieldError ? fieldErrorId : null,
            ]
              .filter(Boolean)
              .join(" ")}
            aria-invalid={textMessages.length > 0 || hasFieldError || undefined}
            className="min-h-40 font-mono"
            value={activeDraft.text}
            onChange={(event) => changeText(event.target.value)}
            onBlur={field.handleBlur}
            autoComplete="off"
            {...TEXT_INPUT_PROPS}
          />
          <div id={textHintId} className="space-y-1 text-xs text-muted-foreground">
            <p>{labels.textHint}</p>
            {anySecret ? <p>{labels.secretTextHint}</p> : null}
          </div>
          <FieldError id={textErrorId} errors={textMessages} />
        </div>
      ) : (
        <div className="min-w-0 space-y-2">
          <div
            aria-hidden="true"
            className="hidden gap-2 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          >
            <span>{labels.key}</span>
            <span>{labels.value}</span>
          </div>
          {rows.map((entry, index) => {
            const row = index + 1;
            const message = rowMessages[index] ?? null;
            const errorId = `${baseId}-row-${index}-error`;
            const controlId = `${baseId}-row-${index}`;
            const shown = rowView.revealed.has(index);
            const multiline = hasLineBreak(entry.value) || rowView.multiline.has(index);
            const isPlaceholder = value.length === 0;
            const invalid = message !== null || index === fieldErrorRow;
            const controlDescribedBy =
              [message !== null ? errorId : null, index === fieldErrorRow ? fieldErrorId : null]
                .filter(Boolean)
                .join(" ") || undefined;
            const error =
              message !== null ? (
                <div className="min-w-0 sm:col-span-2">
                  <FieldError id={errorId} errors={[message]} />
                </div>
              ) : null;
            const rowClass =
              "grid min-w-0 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:items-start";

            if (isUnparsedEntry(entry)) {
              // A line that did not parse: its text, verbatim and editable, in
              // place of the key and value — masked whenever the editor has
              // secrets, since it may be a secret assignment. Leaving it
              // parses it again.
              return (
                // Rows have no identity beyond their position: every input is
                // controlled from `value`, and per-row state (reveal) is
                // reset whenever rows shift, so an index key is correct.
                <div key={index} className={rowClass}>
                  <div className="flex min-w-0 items-start gap-1 sm:col-span-2">
                    <ValueControl
                      id={controlId}
                      controlRef={registerControl(index)}
                      label={labels.unparsedLine(row)}
                      value={entry.value}
                      onChange={(text) => updateRow(index, { value: text })}
                      onBlur={() => {
                        const next = settleUnparsedRow(rows, index);
                        if (next) commit(next);
                        field.handleBlur();
                      }}
                      masked={maskUnparsed && !shown}
                      multiline={multiline}
                      invalid={invalid}
                      describedBy={controlDescribedBy}
                      maskedLines={maskedLines}
                      className="min-w-0 flex-1"
                    />
                    {maskUnparsed ? revealButton("", index, shown) : null}
                    {removeButton("", index)}
                  </div>
                  {error}
                </div>
              );
            }

            const rowSecret = isSecret(entry.key);
            return (
              <div key={index} className={rowClass}>
                <Input
                  ref={registerControl(index)}
                  aria-label={labels.keyInput(row)}
                  aria-invalid={invalid || undefined}
                  aria-describedby={controlDescribedBy}
                  className="font-mono"
                  placeholder={labels.key}
                  value={entry.key}
                  onChange={(event) => updateRow(index, { key: event.target.value })}
                  onBlur={field.handleBlur}
                  onPaste={(event) => {
                    const next = pasteKeyValueText(
                      rows,
                      index,
                      event.clipboardData.getData("text/plain"),
                    );
                    if (next === null) return;
                    event.preventDefault();
                    commit(next);
                  }}
                  autoComplete="off"
                  {...TEXT_INPUT_PROPS}
                />
                <div className="flex min-w-0 items-start gap-1">
                  <ValueControl
                    id={`${controlId}-value`}
                    label={labels.valueInput(entry.key, row)}
                    value={entry.value}
                    onChange={(text) => updateRow(index, { value: text })}
                    onBlur={field.handleBlur}
                    masked={rowSecret && !shown}
                    multiline={multiline}
                    invalid={false}
                    describedBy={undefined}
                    maskedLines={maskedLines}
                    className="min-w-0 flex-1"
                  />
                  {rowSecret ? (
                    revealButton(entry.key, index, shown)
                  ) : secret ? (
                    // Same width as the reveal button, so the value column
                    // lines up across secret and plain rows.
                    <span aria-hidden="true" className="size-11 shrink-0 md:size-8" />
                  ) : null}
                  {isPlaceholder ? null : removeButton(entry.key, index)}
                </div>
                {error}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={addRow}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {labels.add}
            </Button>
            {fileImport ? (
              <>
                <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
                  <FileUp data-icon="inline-start" aria-hidden="true" />
                  {labels.importFile}
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".env,text/plain"
                  hidden
                  tabIndex={-1}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Clear so choosing the same file again still fires.
                    event.target.value = "";
                    // Merge into the value as of when the read finishes.
                    if (file) {
                      void file
                        .text()
                        .then((text) => commit(importKeyValueText(latestValue.current, text)));
                    }
                  }}
                />
              </>
            ) : null}
          </div>
        </div>
      )}

      <FieldError id={fieldErrorId} errors={fieldErrors} />
    </fieldset>
  );
}

export type { KeyValueEditorProps };
export { KeyValueEditor };
