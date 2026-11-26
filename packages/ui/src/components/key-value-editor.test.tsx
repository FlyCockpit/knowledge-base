import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  hasKeyValueErrors,
  importKeyValueText,
  isUnparsedEntry,
  KeyValueEditor,
  type KeyValueEditorProps,
  type KeyValueEntry,
  keyValueEntriesFromText,
  keyValueRowMessages,
  keyValueTextMessages,
  keyValueEditorEnglishLabels as labels,
  lineCount,
  mergeKeyValueEntries,
  normalizeLineEndings,
  pasteIntoValue,
  pasteKeyValueText,
  serializeKeyValueEntries,
  settleUnparsedRow,
  unparsedKeyValueEntry,
} from "./key-value-editor";

/**
 * No DOM in this repo's test setup, so the component is checked as static
 * markup (wiring, labels, masking, error placement) and the behaviour lives in
 * the exported pure helpers, tested directly. Focus moves and the text-mode
 * switch are interaction-only and are checked in a browser.
 */
function field(value: KeyValueEntry[], errors: unknown[] = []) {
  return {
    name: "env",
    state: { value, meta: { errors } },
    handleBlur: vi.fn(),
    handleChange: vi.fn(),
  };
}

function render(
  value: KeyValueEntry[],
  props: Partial<KeyValueEditorProps> = {},
  errors: unknown[] = [],
) {
  return renderToStaticMarkup(
    <KeyValueEditor
      field={field(value, errors)}
      label="Environment variables"
      labels={labels}
      {...props}
    />,
  );
}

/** Attributes of the first `<input>` whose aria-label is `name`. */
function inputNamed(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]*aria-label="${name}"[^>]*>`));
  if (!match) throw new Error(`no input labelled ${name}`);
  return match[0];
}

describe("KeyValueEditor markup", () => {
  it("groups the rows in a fieldset whose legend is the label", () => {
    const html = render([{ key: "A", value: "1" }]);
    expect(html).toMatch(/^<fieldset[^>]*>.*<legend[^>]*>Environment variables<\/legend>/);
  });

  it("labels every input by row and key, with monospace, no autofill keys", () => {
    const html = render([
      { key: "API_URL", value: "https://x.test" },
      { key: "", value: "" },
    ]);
    const key = inputNamed(html, "Key, row 1");
    expect(key).toContain('value="API_URL"');
    expect(key).toContain('autoComplete="off"');
    expect(key).toContain('spellCheck="false"');
    expect(key).toContain('inputMode="text"');
    expect(key).toContain("font-mono");
    expect(inputNamed(html, "Value for API_URL")).toContain('value="https://x.test"');
    expect(inputNamed(html, "Value, row 2")).toContain('value=""');
    expect(html).toContain('aria-label="Remove API_URL"');
    expect(html).toContain('aria-label="Remove row 2"');
  });

  it("shows column headers from sm: up only, hidden from assistive tech", () => {
    const html = render([{ key: "A", value: "1" }]);
    expect(html).toMatch(
      /<div aria-hidden="true" class="hidden[^"]*sm:grid[^"]*"><span>Key<\/span><span>Value<\/span>/,
    );
  });

  it("stacks key above value on phones and puts them side by side from sm:", () => {
    const html = render([{ key: "A", value: "1" }]);
    expect(html).toMatch(
      /class="grid min-w-0 gap-2 sm:grid-cols-\[minmax\(0,2fr\)_minmax\(0,3fr\)\]/,
    );
  });

  it("renders one blank, unremovable row for an empty list", () => {
    const html = render([]);
    expect(inputNamed(html, "Key, row 1")).toContain('value=""');
    expect(html).not.toContain("Remove");
    expect(html).toContain("Add variable");
  });

  it("flags an invalid row inline and points the key input at the message", () => {
    const html = render([
      { key: "GOOD", value: "1" },
      { key: "1BAD", value: "2" },
    ]);
    expect(inputNamed(html, "Key, row 1")).not.toContain('aria-invalid="true"');
    const bad = inputNamed(html, "Key, row 2");
    expect(bad).toContain('aria-invalid="true"');
    const describedBy = bad.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(
      `<div id="${describedBy}" role="alert"><p class="text-sm text-destructive">1BAD is not a valid key.`,
    );
  });

  it("flags reserved and duplicate keys with the caller's messages", () => {
    const html = render(
      [
        { key: "PATH", value: "/bin" },
        { key: "A", value: "1" },
        { key: "A", value: "2" },
      ],
      { reservedKeys: ["PATH"] },
    );
    expect(html).toContain("PATH is set by the platform");
    expect(html.match(/A is defined more than once/g)).toHaveLength(2);
  });

  it("does not flag a blank row, but does flag a value with no key", () => {
    expect(render([{ key: "", value: "" }])).not.toContain('role="alert"');
    expect(render([{ key: "", value: "x" }])).toContain("Enter a key for this value");
  });

  it("masks secret values with a reveal toggle and keeps password managers out", () => {
    const html = render([{ key: "TOKEN", value: "s3cr3t" }], { secret: true });
    const value = inputNamed(html, "Value for TOKEN");
    expect(value).toContain('type="password"');
    expect(value).toContain('autoComplete="new-password"');
    expect(value).toContain('data-1p-ignore="true"');
    expect(value).toContain('data-lpignore="true"');
    expect(html).toMatch(/<button[^>]*aria-label="Show value of TOKEN"[^>]*aria-pressed="false"/);
  });

  it("masks only the keys a secret predicate selects", () => {
    const html = render(
      [
        { key: "PUBLIC_URL", value: "x" },
        { key: "DB_PASSWORD", value: "y" },
      ],
      { secret: (key) => /PASSWORD|SECRET|TOKEN/.test(key) },
    );
    expect(inputNamed(html, "Value for PUBLIC_URL")).toContain('type="text"');
    expect(inputNamed(html, "Value for DB_PASSWORD")).toContain('type="password"');
    expect(html).not.toContain("Show value of PUBLIC_URL");
    expect(html).toContain("Show value of DB_PASSWORD");
  });

  it("offers the Rows / .env text switch and file import by default", () => {
    const html = render([]);
    expect(html).toContain('aria-label="Editing mode"');
    expect(html).toContain(">Rows<");
    expect(html).toContain(">.env text<");
    expect(html).toContain("Import .env file");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept=".env,text\/plain"[^>]*hidden/);
  });

  it("drops the switch and import when turned off", () => {
    const html = render([], { textMode: false, fileImport: false });
    expect(html).not.toContain("Editing mode");
    expect(html).not.toContain('type="file"');
  });

  it("keeps 44px touch targets below md: on the switch", () => {
    const html = render([]);
    const item = html.match(/<button[^>]*data-slot="toggle-group-item"[^>]*>/)?.[0] ?? "";
    expect(item).toContain("h-11");
    expect(item).toContain("md:h-8");
  });

  it("shows field-level errors under the editor and describes the fieldset with them", () => {
    const html = renderToStaticMarkup(
      <KeyValueEditor
        field={field([], [{ message: "Fix the highlighted variables" }])}
        label="Env"
        labels={labels}
      />,
    );
    const describedBy = html.match(/<fieldset[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`<div id="${describedBy}" role="alert">`);
    expect(html).toContain("Fix the highlighted variables");
  });

  it("marks the first flagged row invalid for a field-level error", () => {
    const html = render(
      [
        { key: "A", value: "1" },
        { key: "1BAD", value: "2" },
      ],
      {},
      ["Fix the highlighted variables first"],
    );
    const fieldErrorId = html.match(/<fieldset[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(inputNamed(html, "Key, row 1")).not.toContain('aria-invalid="true"');
    const bad = inputNamed(html, "Key, row 2");
    expect(bad).toContain('aria-invalid="true"');
    expect(bad.match(/aria-describedby="([^"]+)"/)?.[1]?.split(" ")).toContain(fieldErrorId);
  });

  it("marks the first key input invalid for a field-level error on clean rows", () => {
    const html = render([], {}, ["At least one variable is required"]);
    const fieldErrorId = html.match(/<fieldset[^>]*aria-describedby="([^"]+)"/)?.[1];
    const key = inputNamed(html, "Key, row 1");
    expect(key).toContain('aria-invalid="true"');
    expect(key).toContain(`aria-describedby="${fieldErrorId}"`);
    expect(render([])).not.toContain('aria-invalid="true"');
  });

  it("keeps an unparsed line in its own masked control, never in a key or a message", () => {
    const html = render([unparsedKeyValueEntry('API_TOKEN="sensitive"oops')], {
      secret: (key) => key.includes("TOKEN"),
    });
    expect(html).not.toContain("Key, row 1");
    const control = inputNamed(html, "Unparsed line, row 1");
    // Only the password input holds the text (as any masked secret does).
    expect(html.replace(control, "")).not.toContain("sensitive");
    expect(control).toContain('type="password"');
    expect(control).toContain('autoComplete="new-password"');
    expect(control).toContain('aria-invalid="true"');
    expect(html).toContain("Line 1: unexpected text after the closing quote");
    expect(html).toContain('aria-label="Show value, row 1"');
    expect(html).toContain('aria-label="Remove row 1"');
  });

  it("shows an unparsed line as editable text when nothing is secret", () => {
    const html = render([{ key: "A", value: "1" }, unparsedKeyValueEntry("JUNK")]);
    const control = inputNamed(html, "Unparsed line, row 2");
    expect(control).toContain('type="text"');
    expect(control).toContain('value="JUNK"');
    expect(html).toContain("Line 2: expected KEY=value");
    expect(html).not.toContain("Show value");
  });

  it("edits a multi-line value in a textarea so its line breaks survive", () => {
    const html = render([{ key: "CERT", value: "-----BEGIN-----\nabc\n-----END-----" }]);
    expect(html).toMatch(
      /<textarea[^>]*aria-label="Value for CERT"[^>]*>-----BEGIN-----\nabc\n-----END-----<\/textarea>/,
    );
  });

  it("masks a multi-line secret with its line count, without its content", () => {
    const html = render([{ key: "CERT", value: "-----BEGIN-----\nabc\n-----END-----" }], {
      secret: true,
    });
    expect(html).not.toContain("BEGIN");
    expect(html).not.toContain("<textarea");
    const control = inputNamed(html, "Value for CERT");
    expect(control).toContain('type="password"');
    expect(control).toContain("readOnly");
    expect(html).toContain("3 lines, hidden");
    const hintId = control.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(html).toContain(`id="${hintId}"`);
  });

  it("never renders JSON", () => {
    const html = render([{ key: "A", value: "1" }]);
    expect(html).not.toContain("{&quot;");
    expect(html).not.toContain('"key"');
  });
});

describe("hasKeyValueErrors", () => {
  it("is false for valid rows and blank rows", () => {
    expect(
      hasKeyValueErrors([
        { key: "A", value: "1" },
        { key: "", value: "" },
      ]),
    ).toBe(false);
  });

  it("is true for any invalid, duplicate or reserved key", () => {
    expect(hasKeyValueErrors([{ key: "a b", value: "" }])).toBe(true);
    expect(
      hasKeyValueErrors([
        { key: "A", value: "" },
        { key: "A", value: "" },
      ]),
    ).toBe(true);
    expect(hasKeyValueErrors([{ key: "PATH", value: "" }], { reservedKeys: ["PATH"] })).toBe(true);
  });

  it("is true for an unparsed line, with or without its marker", () => {
    const entry = unparsedKeyValueEntry("JUNK");
    expect(hasKeyValueErrors([entry])).toBe(true);
    expect(hasKeyValueErrors([{ key: entry.key, value: entry.value }])).toBe(true);
  });
});

describe("keyValueEntriesFromText", () => {
  it("keeps lines that fail to parse verbatim, in place, as unparsed rows", () => {
    const { entries, parsed } = keyValueEntriesFromText("A=1\nJUNK\nB='open\nC=3");
    expect(parsed).toEqual([
      { key: "A", value: "1" },
      { key: "C", value: "3" },
    ]);
    expect(entries).toEqual([
      { key: "A", value: "1" },
      { key: "", value: "JUNK", unparsed: true },
      { key: "", value: "B='open", unparsed: true },
      { key: "C", value: "3" },
    ]);
    expect(hasKeyValueErrors(entries)).toBe(true);
  });

  it("never turns a line without = into a valid entry across a mode round trip", () => {
    const { entries } = keyValueEntriesFromText("JUNK");
    expect(entries.every(isUnparsedEntry)).toBe(true);
    const text = serializeKeyValueEntries(entries);
    expect(text).toBe("JUNK");
    expect(keyValueEntriesFromText(text).entries).toEqual(entries);
  });

  it("keeps the whole span of a multi-line line that fails", () => {
    const { entries } = keyValueEntriesFromText('A="first\nsecond"oops\nB=1');
    expect(entries).toEqual([
      { key: "", value: 'A="first\nsecond"oops', unparsed: true },
      { key: "B", value: "1" },
    ]);
    expect(serializeKeyValueEntries(entries)).toBe('A="first\nsecond"oops\nB=1');
  });

  it("does not turn a resolved duplicate into an extra row", () => {
    expect(keyValueEntriesFromText("A=1\nA=2").entries).toEqual([{ key: "A", value: "2" }]);
  });
});

describe("serializeKeyValueEntries", () => {
  it("round-trips rows, unparsed lines and multi-line values", () => {
    const rows: KeyValueEntry[] = [
      { key: "CERT", value: "-----BEGIN-----\nabc\n-----END-----" },
      unparsedKeyValueEntry("  not a line"),
      { key: "", value: "" },
      { key: "B", value: "it's" },
    ];
    const text = serializeKeyValueEntries(rows);
    expect(text).toBe('CERT="-----BEGIN-----\\nabc\\n-----END-----"\n  not a line\nB="it\'s"');
    expect(keyValueEntriesFromText(text).entries).toEqual(
      rows.filter((row) => row.key || row.value),
    );
  });
});

describe("lineCount", () => {
  it("counts lines across line ending styles", () => {
    expect(lineCount("")).toBe(1);
    expect(lineCount("a\nb\r\nc\rd")).toBe(4);
  });
});

describe("keyValueRowMessages", () => {
  it("gives unparsed rows their line in the text view and a reason, never the content", () => {
    const rows: KeyValueEntry[] = [
      { key: "A", value: "x\ny" },
      { key: "", value: "" },
      unparsedKeyValueEntry('T="a\nb"secret'),
      unparsedKeyValueEntry("JUNK"),
      { key: "1X", value: "" },
    ];
    expect(keyValueRowMessages(rows, labels)).toEqual([
      null,
      null,
      "Line 2: unexpected text after the closing quote",
      "Line 4: expected KEY=value",
      expect.stringContaining("1X is not a valid key"),
    ]);
  });
});

describe("settleUnparsedRow", () => {
  it("turns a fixed line into a normal row", () => {
    expect(
      settleUnparsedRow([{ key: "A", value: "1" }, unparsedKeyValueEntry("JUNK=2")], 1),
    ).toEqual([
      { key: "A", value: "1" },
      { key: "JUNK", value: "2" },
    ]);
  });

  it("leaves a line that still fails alone, and empties to a blank row", () => {
    expect(settleUnparsedRow([unparsedKeyValueEntry("JUNK")], 0)).toBeNull();
    expect(settleUnparsedRow([unparsedKeyValueEntry("")], 0)).toEqual([{ key: "", value: "" }]);
    expect(settleUnparsedRow([{ key: "A", value: "1" }], 0)).toBeNull();
  });
});

describe("importKeyValueText", () => {
  it("merges into the rows it is given and drops blank rows", () => {
    expect(
      importKeyValueText(
        [
          { key: "A", value: "edited" },
          { key: "", value: "" },
        ],
        "B=2\nJUNK",
      ),
    ).toEqual([
      { key: "A", value: "edited" },
      { key: "B", value: "2" },
      { key: "", value: "JUNK", unparsed: true },
    ]);
  });
});

describe("keyValueTextMessages", () => {
  it("lists parse errors by line, then key problems by key", () => {
    expect(
      keyValueTextMessages("PATH=/x\nJUNK\nA.B=1", labels, { reservedKeys: ["PATH"] }),
    ).toEqual([
      "Line 2: expected KEY=value",
      "PATH is set by the platform",
      expect.stringContaining("A.B is not a valid key"),
    ]);
  });

  it("never repeats the content of a line that fails", () => {
    expect(keyValueTextMessages('API_TOKEN="sensitive"oops', labels).join(" ")).not.toContain(
      "sensitive",
    );
  });

  it("is empty for clean text", () => {
    expect(keyValueTextMessages("A=1\n# c\n\nB=2", labels)).toEqual([]);
  });
});

describe("mergeKeyValueEntries", () => {
  const base = [
    { key: "A", value: "1" },
    { key: "B", value: "2" },
  ];

  it("replaces existing keys in place and appends new ones", () => {
    expect(
      mergeKeyValueEntries(base, [
        { key: "B", value: "20" },
        { key: "C", value: "3" },
      ]),
    ).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "20" },
      { key: "C", value: "3" },
    ]);
  });

  it("inserts new keys at a position", () => {
    expect(mergeKeyValueEntries(base, [{ key: "Z", value: "9" }], 1)).toEqual([
      { key: "A", value: "1" },
      { key: "Z", value: "9" },
      { key: "B", value: "2" },
    ]);
  });
});

describe("pasteKeyValueText", () => {
  const rows = [
    { key: "A", value: "1" },
    { key: "", value: "" },
    { key: "C", value: "3" },
  ];

  it("turns a pasted .env file into rows in place of a blank row", () => {
    expect(pasteKeyValueText(rows, 1, "# comment\nexport A=10\nB=2\r\nD='x y'\n")).toEqual([
      { key: "A", value: "10" },
      { key: "B", value: "2" },
      { key: "D", value: "x y" },
      { key: "C", value: "3" },
    ]);
  });

  it("splits a single KEY=value pasted into an empty key input", () => {
    expect(pasteKeyValueText([{ key: "", value: "" }], 0, "TOKEN=abc=def")).toEqual([
      { key: "TOKEN", value: "abc=def" },
    ]);
  });

  it("leaves a single line alone when the key input already has text", () => {
    expect(pasteKeyValueText(rows, 0, "X=1")).toBeNull();
  });

  it("leaves plain text alone", () => {
    expect(pasteKeyValueText(rows, 1, "API_URL")).toBeNull();
  });

  it("inserts after a filled row for multi-line pastes", () => {
    expect(pasteKeyValueText(rows, 0, "X=1\nY=2")).toEqual([
      { key: "A", value: "1" },
      { key: "X", value: "1" },
      { key: "Y", value: "2" },
      { key: "", value: "" },
      { key: "C", value: "3" },
    ]);
  });

  it("falls back to a normal paste when nothing parses", () => {
    expect(pasteKeyValueText(rows, 1, "\n# only a comment\n")).toBeNull();
  });
});

describe("pasteIntoValue", () => {
  it("keeps the line breaks of pasted text at the caret or over the selection", () => {
    const pem = "-----BEGIN CERT-----\nMIIB\n-----END CERT-----";
    expect(pasteIntoValue("", pem, 0, 0)).toBe(pem);
    expect(pasteIntoValue("ab", "x\ny", 1, 1)).toBe("ax\nyb");
    expect(pasteIntoValue("abcd", "x\ny", 1, 3)).toBe("ax\nyd");
  });

  it("turns CRLF and lone CR into LF, as the textarea will", () => {
    expect(pasteIntoValue("ab", "x\r\ny\rz", 1, 1)).toBe("ax\ny\nzb");
    expect(normalizeLineEndings("x\r\ny")).toBe("x\ny");
  });

  it("appends when the selection is unknown", () => {
    expect(pasteIntoValue("ab", "x\ny", null, null)).toBe("abx\ny");
  });
});
