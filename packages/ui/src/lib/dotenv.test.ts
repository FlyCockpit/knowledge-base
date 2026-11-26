import { describe, expect, it } from "vitest";
import {
  type DotenvEntry,
  isBlankEntry,
  parseDotenv,
  scanDotenv,
  serializeDotenv,
  validateEntries,
} from "./dotenv";

describe("parseDotenv", () => {
  it("reads KEY=value lines and skips blanks and comments", () => {
    const result = parseDotenv("# header\n\nFOO=bar\n   # indented comment\nBAZ=qux\n");
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("accepts CRLF, lone CR and a leading BOM", () => {
    expect(parseDotenv("\uFEFFA=1\r\nB=2\rC=3").entries).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
    ]);
  });

  it("strips an optional export prefix", () => {
    expect(parseDotenv("export FOO=bar\nexport\tBAR=baz").entries).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAR", value: "baz" },
    ]);
  });

  it("keeps a key literally named export", () => {
    expect(parseDotenv("export=1").entries).toEqual([{ key: "export", value: "1" }]);
  });

  it("trims whitespace around keys and unquoted values", () => {
    expect(parseDotenv("  FOO  =   bar baz   ").entries).toEqual([
      { key: "FOO", value: "bar baz" },
    ]);
  });

  it("keeps every = after the first in the value", () => {
    expect(parseDotenv("DSN=postgres://u:p@h/db?sslmode=require&a=b").entries).toEqual([
      { key: "DSN", value: "postgres://u:p@h/db?sslmode=require&a=b" },
    ]);
  });

  it("allows empty values", () => {
    expect(parseDotenv("EMPTY=\nQUOTED=''\nDQ=\"\"").entries).toEqual([
      { key: "EMPTY", value: "" },
      { key: "QUOTED", value: "" },
      { key: "DQ", value: "" },
    ]);
  });

  it("strips inline comments only when whitespace precedes the #", () => {
    expect(parseDotenv("A=1 # note\nB=https://x.test/#frag\nC=x\t#tab\nD= #only").entries).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "https://x.test/#frag" },
      { key: "C", value: "x" },
      { key: "D", value: "" },
    ]);
  });

  it("keeps single-quoted values literal", () => {
    expect(parseDotenv("A='  spaced # not a comment \\n '").entries).toEqual([
      { key: "A", value: "  spaced # not a comment \\n " },
    ]);
  });

  it("expands escapes in double-quoted values", () => {
    expect(parseDotenv('A="line1\\nline2\\ttab \\"q\\" back\\\\slash \\x"').entries).toEqual([
      { key: "A", value: 'line1\nline2\ttab "q" back\\slash \\x' },
    ]);
  });

  it("allows a comment after a closing quote", () => {
    expect(parseDotenv("A='x' # note\nB=\"y\"   ").entries).toEqual([
      { key: "A", value: "x" },
      { key: "B", value: "y" },
    ]);
  });

  it("reads quoted values that span several lines", () => {
    const text = 'KEY="-----BEGIN-----\nabc  \n-----END-----"\nNEXT=1';
    const result = parseDotenv(text);
    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      { key: "KEY", value: "-----BEGIN-----\nabc  \n-----END-----" },
      { key: "NEXT", value: "1" },
    ]);
  });

  it("reports a missing = with its line number", () => {
    const result = parseDotenv("A=1\n\nJUNK\nB=2");
    expect(result.entries).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
    expect(result.errors).toEqual([
      { line: 3, code: "missing-equals", message: expect.any(String), source: "JUNK" },
    ]);
  });

  it("reports keys that are empty or contain spaces or quotes", () => {
    const result = parseDotenv('=x\nMY KEY=1\n"Q"=2');
    expect(result.entries).toEqual([]);
    expect(result.errors.map((error) => [error.line, error.code])).toEqual([
      [1, "invalid-key"],
      [2, "invalid-key"],
      [3, "invalid-key"],
    ]);
  });

  it("reports an unterminated quote and resumes on the next line", () => {
    const result = parseDotenv("A=\"open\nB=2\nC='x");
    expect(result.entries).toEqual([{ key: "B", value: "2" }]);
    expect(result.errors.map((error) => [error.line, error.code, error.key])).toEqual([
      [1, "unterminated-quote", "A"],
      [3, "unterminated-quote", "C"],
    ]);
  });

  it("reports text after a closing quote", () => {
    const result = parseDotenv("A='x'y\nB=1");
    expect(result.entries).toEqual([{ key: "B", value: "1" }]);
    expect(result.errors).toMatchObject([{ line: 1, code: "trailing-characters", key: "A" }]);
  });

  it("keeps every consumed line in the source of a multi-line error", () => {
    const result = parseDotenv('A="first\nsecond"oops\nB=1');
    expect(result.entries).toEqual([{ key: "B", value: "1" }]);
    expect(result.errors).toMatchObject([
      { line: 1, code: "trailing-characters", key: "A", source: 'A="first\nsecond"oops' },
    ]);
  });

  it("keeps an unparsed line verbatim, leading whitespace included", () => {
    expect(parseDotenv("  not a line").errors).toMatchObject([{ source: "  not a line" }]);
  });

  it("reports a multi-line duplicate on the line it starts", () => {
    expect(parseDotenv('A=1\nA="x\ny"').errors).toMatchObject([
      { line: 2, code: "duplicate-key", source: 'A="x\ny"' },
    ]);
  });

  it("lets the last duplicate win, keeps the first position, and reports it", () => {
    const result = parseDotenv("A=1\nB=2\nA=3");
    expect(result.entries).toEqual([
      { key: "A", value: "3" },
      { key: "B", value: "2" },
    ]);
    expect(result.errors).toMatchObject([{ line: 3, code: "duplicate-key", key: "A" }]);
  });

  it("returns nothing for empty input", () => {
    expect(parseDotenv("")).toEqual({ entries: [], errors: [] });
  });
});

describe("scanDotenv", () => {
  it("returns entries and errors in source order, duplicates unresolved", () => {
    expect(scanDotenv("A=1\nJUNK\nB='x\ny'\nA=2")).toEqual([
      { kind: "entry", line: 1, entry: { key: "A", value: "1" }, source: "A=1" },
      { kind: "error", error: expect.objectContaining({ line: 2, source: "JUNK" }) },
      { kind: "entry", line: 3, entry: { key: "B", value: "x\ny" }, source: "B='x\ny'" },
      { kind: "entry", line: 5, entry: { key: "A", value: "2" }, source: "A=2" },
    ]);
  });
});

describe("serializeDotenv", () => {
  it("writes plain values unquoted", () => {
    expect(
      serializeDotenv([
        { key: "A", value: "1" },
        { key: "URL", value: "https://x.test/a?b=c" },
        { key: "EMPTY", value: "" },
        { key: "MID", value: "has inner spaces" },
      ]),
    ).toBe("A=1\nURL=https://x.test/a?b=c\nEMPTY=\nMID=has inner spaces");
  });

  it("single-quotes values that need quoting but no escapes", () => {
    expect(serializeDotenv([{ key: "A", value: " lead" }])).toBe("A=' lead'");
    expect(serializeDotenv([{ key: "A", value: "trail " }])).toBe("A='trail '");
    expect(serializeDotenv([{ key: "A", value: "a #b" }])).toBe("A='a #b'");
    expect(serializeDotenv([{ key: "A", value: 'say "hi"' }])).toBe("A='say \"hi\"'");
    expect(serializeDotenv([{ key: "A", value: "C:\\path" }])).toBe("A='C:\\path'");
  });

  it("double-quotes and escapes values with apostrophes or line breaks", () => {
    expect(serializeDotenv([{ key: "A", value: "it's" }])).toBe('A="it\'s"');
    expect(serializeDotenv([{ key: "A", value: "l1\nl2" }])).toBe('A="l1\\nl2"');
    expect(serializeDotenv([{ key: "A", value: 'x\\n "y"\r\n' }])).toBe('A="x\\\\n \\"y\\"\\r\\n"');
  });

  it("skips fully blank rows", () => {
    expect(
      serializeDotenv([
        { key: "", value: "" },
        { key: "A", value: "1" },
      ]),
    ).toBe("A=1");
  });

  const roundTripCases: DotenvEntry[][] = [
    [{ key: "A", value: "" }],
    [{ key: "A", value: " " }],
    [{ key: "A", value: "#" }],
    [{ key: "A", value: "x #y" }],
    [{ key: "A", value: "'" }],
    [{ key: "A", value: '"' }],
    [{ key: "A", value: "'\"" }],
    [{ key: "A", value: "\\" }],
    [{ key: "A", value: "\\n" }],
    [{ key: "A", value: "it's\\n\n" }],
    [{ key: "A", value: "\r\n\t" }],
    [{ key: "A", value: "a=b=c" }],
    [{ key: "A", value: "`tick`" }],
    [{ key: "A", value: "\u00a0nbsp" }],
    [{ key: "A", value: "-----BEGIN KEY-----\nabc\n-----END KEY-----\n" }],
    [
      { key: "FIRST", value: "1" },
      { key: "SECOND", value: "two words" },
      { key: "THIRD", value: "  'mixed' \"quotes\" # and hash  " },
    ],
  ];

  it.each(roundTripCases)("round-trips through parseDotenv (%#)", (...entries) => {
    const parsed = parseDotenv(serializeDotenv(entries));
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toEqual(entries);
  });

  it("round-trips every printable ASCII character in a value", () => {
    let all = "";
    for (let code = 32; code < 127; code++) all += String.fromCharCode(code);
    const entries = [{ key: "ALL", value: all }];
    expect(parseDotenv(serializeDotenv(entries)).entries).toEqual(entries);
  });
});

describe("validateEntries", () => {
  it("accepts valid unique keys and ignores blank rows", () => {
    expect(
      validateEntries([
        { key: "A", value: "1" },
        { key: "", value: "" },
        { key: "_B2", value: "" },
      ]),
    ).toEqual([null, null, null]);
  });

  it("flags an empty key only when a value is set", () => {
    expect(validateEntries([{ key: "", value: "x" }])).toEqual(["empty-key"]);
  });

  it("flags keys that do not match the default pattern", () => {
    expect(
      validateEntries([
        { key: "1ABC", value: "" },
        { key: "A-B", value: "" },
        { key: " A", value: "" },
        { key: "A.B", value: "" },
      ]),
    ).toEqual(["invalid-key", "invalid-key", "invalid-key", "invalid-key"]);
  });

  it("uses a caller pattern, ignoring a stateful g flag", () => {
    const keyPattern = /^[A-Z][A-Z0-9_.-]*$/g;
    const entries = [
      { key: "A.B", value: "" },
      { key: "C-D", value: "" },
      { key: "lower", value: "" },
    ];
    expect(validateEntries(entries, { keyPattern })).toEqual([null, null, "invalid-key"]);
    expect(validateEntries(entries, { keyPattern })).toEqual([null, null, "invalid-key"]);
  });

  it("flags every occurrence of a duplicate key", () => {
    expect(
      validateEntries([
        { key: "A", value: "1" },
        { key: "B", value: "2" },
        { key: "A", value: "3" },
      ]),
    ).toEqual(["duplicate-key", null, "duplicate-key"]);
  });

  it("flags reserved keys case-sensitively, ahead of duplicates", () => {
    expect(
      validateEntries(
        [
          { key: "PATH", value: "x" },
          { key: "PATH", value: "y" },
          { key: "path", value: "z" },
        ],
        { reservedKeys: ["PATH"] },
      ),
    ).toEqual(["reserved-key", "reserved-key", null]);
  });

  it("prefers invalid over reserved", () => {
    expect(validateEntries([{ key: "1X", value: "" }], { reservedKeys: ["1X"] })).toEqual([
      "invalid-key",
    ]);
  });
});

describe("isBlankEntry", () => {
  it("is true only when key and value are both empty", () => {
    expect(isBlankEntry({ key: "", value: "" })).toBe(true);
    expect(isBlankEntry({ key: "", value: " " })).toBe(false);
    expect(isBlankEntry({ key: "A", value: "" })).toBe(false);
  });
});
