/** Normalized KB document paths (CONTRACT Path + tree rules). */

export const KB_PATH_LIMITS = {
  maxBytes: 512,
  maxSegments: 32,
} as const;

const WINDOWS_RESERVED = new Set(
  [
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
  ].map((name) => name.toLocaleLowerCase("en-US")),
);

export type PathIssueCode =
  | "PATH_EMPTY"
  | "PATH_ABSOLUTE"
  | "PATH_BACKSLASH"
  | "PATH_DOT"
  | "PATH_DOTDOT"
  | "PATH_CONTROL"
  | "PATH_BOM"
  | "PATH_TOO_LONG"
  | "PATH_TOO_DEEP"
  | "PATH_NOT_UTF8"
  | "PATH_NOT_NFC"
  | "PATH_GIT_RESERVED"
  | "PATH_WINDOWS_RESERVED"
  | "PATH_NOT_PORTABLE"
  | "PATH_CASE_COLLISION";

export type PathIssue = { code: PathIssueCode; message: string };

export function pathByteLength(path: string): number {
  return Buffer.byteLength(path, "utf8");
}

export function normalizeKbPath(
  raw: string,
): { ok: true; path: string } | { ok: false; issue: PathIssue } {
  if (raw.length === 0) {
    return { ok: false, issue: { code: "PATH_EMPTY", message: "path must not be empty" } };
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, issue: { code: "PATH_ABSOLUTE", message: "path must be relative" } };
  }
  if (raw.includes("\\")) {
    return {
      ok: false,
      issue: { code: "PATH_BACKSLASH", message: "path must not contain backslashes" },
    };
  }
  if (!isValidUtf8String(raw)) {
    return { ok: false, issue: { code: "PATH_NOT_UTF8", message: "path must be valid UTF-8" } };
  }
  const nfc = raw.normalize("NFC");
  if (nfc !== raw) {
    return { ok: false, issue: { code: "PATH_NOT_NFC", message: "path must be NFC-normalized" } };
  }
  if (pathByteLength(nfc) > KB_PATH_LIMITS.maxBytes) {
    return { ok: false, issue: { code: "PATH_TOO_LONG", message: "path exceeds byte limit" } };
  }
  const segments = nfc.split("/");
  if (segments.length > KB_PATH_LIMITS.maxSegments) {
    return { ok: false, issue: { code: "PATH_TOO_DEEP", message: "path exceeds segment limit" } };
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      return {
        ok: false,
        issue: { code: "PATH_EMPTY", message: "path must not contain empty segments" },
      };
    }
    if (segment === ".") {
      return {
        ok: false,
        issue: { code: "PATH_DOT", message: "path must not contain dot segments" },
      };
    }
    if (segment === "..") {
      return {
        ok: false,
        issue: { code: "PATH_DOTDOT", message: "path must not contain parent segments" },
      };
    }
    if (segmentHasControlChar(segment)) {
      return {
        ok: false,
        issue: { code: "PATH_CONTROL", message: "path must not contain control characters" },
      };
    }
    if (segment.includes("\uFEFF")) {
      return {
        ok: false,
        issue: {
          code: "PATH_BOM",
          message: "path must not contain the byte order mark character",
        },
      };
    }
    if (isGitMetadataSegment(segment)) {
      return {
        ok: false,
        issue: { code: "PATH_GIT_RESERVED", message: "path uses a Git metadata segment name" },
      };
    }
    const reserved = windowsReservedBasename(segment);
    if (WINDOWS_RESERVED.has(reserved)) {
      return {
        ok: false,
        issue: { code: "PATH_WINDOWS_RESERVED", message: "path uses a reserved segment name" },
      };
    }
    const stem = segment.toLowerCase().endsWith(".md") ? segment.slice(0, -3) : segment;
    if (
      /[<>:"|?*]/.test(segment) ||
      segment.startsWith(" ") ||
      /[ .]$/.test(segment) ||
      /[ .]$/.test(stem)
    ) {
      return {
        ok: false,
        issue: {
          code: "PATH_NOT_PORTABLE",
          message:
            "path segments must be portable: no reserved punctuation or leading/trailing spaces or dots",
        },
      };
    }
  }
  return { ok: true, path: nfc };
}

export function casefoldPathKey(path: string): string {
  return path
    .split("/")
    .map((segment) => casefoldSegment(segment))
    .join("/");
}

export type PathKind = "file" | "dir";

export type SeenPathEntry = { path: string; kind: PathKind };

/**
 * Register one path (with its kind) under its case-fold key. A prior entry
 * collides unless it is the identical path registered as a directory again —
 * repeated directory prefixes from sibling leaves (`docs` from `docs/a.md`
 * and `docs/b.md`) are the only legal exact repeat, so a file/dir clash or a
 * file repeating another file's exact or case-folded path is a collision.
 */
export function registerPath(
  seen: Map<string, SeenPathEntry>,
  path: string,
  kind: PathKind,
): PathIssue | null {
  const key = casefoldPathKey(path);
  const prior = seen.get(key);
  if (prior && !(prior.path === path && prior.kind === "dir" && kind === "dir")) {
    const message =
      prior.path === path
        ? `duplicate tree entry path ${path}`
        : `path case-folds to an existing entry (${prior.path})`;
    return { code: "PATH_CASE_COLLISION", message };
  }
  seen.set(key, { path, kind });
  return null;
}

/**
 * Register every directory prefix (as a directory) and the leaf itself (with
 * its kind) so file and directory names cannot case-fold collide anywhere in
 * the tree.
 */
export function registerPathWithPrefixes(
  seen: Map<string, SeenPathEntry>,
  path: string,
  kind: PathKind,
): PathIssue | null {
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join("/");
    const issue = registerPath(seen, prefix, "dir");
    if (issue) return issue;
  }
  return registerPath(seen, path, kind);
}

/**
 * Unicode 15.0.0 full-casefold exceptions (CaseFolding.txt C+F), generated
 * with Python 3.12 / unicodedata 15.0.0 over all code points using
 * `chr(cp).casefold() != chr(cp).lower()`. Include identity mappings: Cherokee
 * uppercase folds to itself even though lowercase maps it elsewhere.
 * Other code points use the runtime's locale-independent Unicode lowercase;
 * new runtime Unicode versions must retain the fixed-point regression test.
 */
const CASEFOLD_EXPANSIONS: Readonly<Record<number, string>> = {
  181: "\u03bc",
  223: "ss",
  329: "\u02bcn",
  383: "s",
  496: "j\u030c",
  837: "\u03b9",
  912: "\u03b9\u0308\u0301",
  944: "\u03c5\u0308\u0301",
  962: "\u03c3",
  976: "\u03b2",
  977: "\u03b8",
  981: "\u03c6",
  982: "\u03c0",
  1008: "\u03ba",
  1009: "\u03c1",
  1013: "\u03b5",
  1415: "\u0565\u0582",
  5024: "\u13a0",
  5025: "\u13a1",
  5026: "\u13a2",
  5027: "\u13a3",
  5028: "\u13a4",
  5029: "\u13a5",
  5030: "\u13a6",
  5031: "\u13a7",
  5032: "\u13a8",
  5033: "\u13a9",
  5034: "\u13aa",
  5035: "\u13ab",
  5036: "\u13ac",
  5037: "\u13ad",
  5038: "\u13ae",
  5039: "\u13af",
  5040: "\u13b0",
  5041: "\u13b1",
  5042: "\u13b2",
  5043: "\u13b3",
  5044: "\u13b4",
  5045: "\u13b5",
  5046: "\u13b6",
  5047: "\u13b7",
  5048: "\u13b8",
  5049: "\u13b9",
  5050: "\u13ba",
  5051: "\u13bb",
  5052: "\u13bc",
  5053: "\u13bd",
  5054: "\u13be",
  5055: "\u13bf",
  5056: "\u13c0",
  5057: "\u13c1",
  5058: "\u13c2",
  5059: "\u13c3",
  5060: "\u13c4",
  5061: "\u13c5",
  5062: "\u13c6",
  5063: "\u13c7",
  5064: "\u13c8",
  5065: "\u13c9",
  5066: "\u13ca",
  5067: "\u13cb",
  5068: "\u13cc",
  5069: "\u13cd",
  5070: "\u13ce",
  5071: "\u13cf",
  5072: "\u13d0",
  5073: "\u13d1",
  5074: "\u13d2",
  5075: "\u13d3",
  5076: "\u13d4",
  5077: "\u13d5",
  5078: "\u13d6",
  5079: "\u13d7",
  5080: "\u13d8",
  5081: "\u13d9",
  5082: "\u13da",
  5083: "\u13db",
  5084: "\u13dc",
  5085: "\u13dd",
  5086: "\u13de",
  5087: "\u13df",
  5088: "\u13e0",
  5089: "\u13e1",
  5090: "\u13e2",
  5091: "\u13e3",
  5092: "\u13e4",
  5093: "\u13e5",
  5094: "\u13e6",
  5095: "\u13e7",
  5096: "\u13e8",
  5097: "\u13e9",
  5098: "\u13ea",
  5099: "\u13eb",
  5100: "\u13ec",
  5101: "\u13ed",
  5102: "\u13ee",
  5103: "\u13ef",
  5104: "\u13f0",
  5105: "\u13f1",
  5106: "\u13f2",
  5107: "\u13f3",
  5108: "\u13f4",
  5109: "\u13f5",
  5112: "\u13f0",
  5113: "\u13f1",
  5114: "\u13f2",
  5115: "\u13f3",
  5116: "\u13f4",
  5117: "\u13f5",
  7296: "\u0432",
  7297: "\u0434",
  7298: "\u043e",
  7299: "\u0441",
  7300: "\u0442",
  7301: "\u0442",
  7302: "\u044a",
  7303: "\u0463",
  7304: "\ua64b",
  7830: "h\u0331",
  7831: "t\u0308",
  7832: "w\u030a",
  7833: "y\u030a",
  7834: "a\u02be",
  7835: "\u1e61",
  7838: "ss",
  8016: "\u03c5\u0313",
  8018: "\u03c5\u0313\u0300",
  8020: "\u03c5\u0313\u0301",
  8022: "\u03c5\u0313\u0342",
  8064: "\u1f00\u03b9",
  8065: "\u1f01\u03b9",
  8066: "\u1f02\u03b9",
  8067: "\u1f03\u03b9",
  8068: "\u1f04\u03b9",
  8069: "\u1f05\u03b9",
  8070: "\u1f06\u03b9",
  8071: "\u1f07\u03b9",
  8072: "\u1f00\u03b9",
  8073: "\u1f01\u03b9",
  8074: "\u1f02\u03b9",
  8075: "\u1f03\u03b9",
  8076: "\u1f04\u03b9",
  8077: "\u1f05\u03b9",
  8078: "\u1f06\u03b9",
  8079: "\u1f07\u03b9",
  8080: "\u1f20\u03b9",
  8081: "\u1f21\u03b9",
  8082: "\u1f22\u03b9",
  8083: "\u1f23\u03b9",
  8084: "\u1f24\u03b9",
  8085: "\u1f25\u03b9",
  8086: "\u1f26\u03b9",
  8087: "\u1f27\u03b9",
  8088: "\u1f20\u03b9",
  8089: "\u1f21\u03b9",
  8090: "\u1f22\u03b9",
  8091: "\u1f23\u03b9",
  8092: "\u1f24\u03b9",
  8093: "\u1f25\u03b9",
  8094: "\u1f26\u03b9",
  8095: "\u1f27\u03b9",
  8096: "\u1f60\u03b9",
  8097: "\u1f61\u03b9",
  8098: "\u1f62\u03b9",
  8099: "\u1f63\u03b9",
  8100: "\u1f64\u03b9",
  8101: "\u1f65\u03b9",
  8102: "\u1f66\u03b9",
  8103: "\u1f67\u03b9",
  8104: "\u1f60\u03b9",
  8105: "\u1f61\u03b9",
  8106: "\u1f62\u03b9",
  8107: "\u1f63\u03b9",
  8108: "\u1f64\u03b9",
  8109: "\u1f65\u03b9",
  8110: "\u1f66\u03b9",
  8111: "\u1f67\u03b9",
  8114: "\u1f70\u03b9",
  8115: "\u03b1\u03b9",
  8116: "\u03ac\u03b9",
  8118: "\u03b1\u0342",
  8119: "\u03b1\u0342\u03b9",
  8124: "\u03b1\u03b9",
  8126: "\u03b9",
  8130: "\u1f74\u03b9",
  8131: "\u03b7\u03b9",
  8132: "\u03ae\u03b9",
  8134: "\u03b7\u0342",
  8135: "\u03b7\u0342\u03b9",
  8140: "\u03b7\u03b9",
  8146: "\u03b9\u0308\u0300",
  8147: "\u03b9\u0308\u0301",
  8150: "\u03b9\u0342",
  8151: "\u03b9\u0308\u0342",
  8162: "\u03c5\u0308\u0300",
  8163: "\u03c5\u0308\u0301",
  8164: "\u03c1\u0313",
  8166: "\u03c5\u0342",
  8167: "\u03c5\u0308\u0342",
  8178: "\u1f7c\u03b9",
  8179: "\u03c9\u03b9",
  8180: "\u03ce\u03b9",
  8182: "\u03c9\u0342",
  8183: "\u03c9\u0342\u03b9",
  8188: "\u03c9\u03b9",
  43888: "\u13a0",
  43889: "\u13a1",
  43890: "\u13a2",
  43891: "\u13a3",
  43892: "\u13a4",
  43893: "\u13a5",
  43894: "\u13a6",
  43895: "\u13a7",
  43896: "\u13a8",
  43897: "\u13a9",
  43898: "\u13aa",
  43899: "\u13ab",
  43900: "\u13ac",
  43901: "\u13ad",
  43902: "\u13ae",
  43903: "\u13af",
  43904: "\u13b0",
  43905: "\u13b1",
  43906: "\u13b2",
  43907: "\u13b3",
  43908: "\u13b4",
  43909: "\u13b5",
  43910: "\u13b6",
  43911: "\u13b7",
  43912: "\u13b8",
  43913: "\u13b9",
  43914: "\u13ba",
  43915: "\u13bb",
  43916: "\u13bc",
  43917: "\u13bd",
  43918: "\u13be",
  43919: "\u13bf",
  43920: "\u13c0",
  43921: "\u13c1",
  43922: "\u13c2",
  43923: "\u13c3",
  43924: "\u13c4",
  43925: "\u13c5",
  43926: "\u13c6",
  43927: "\u13c7",
  43928: "\u13c8",
  43929: "\u13c9",
  43930: "\u13ca",
  43931: "\u13cb",
  43932: "\u13cc",
  43933: "\u13cd",
  43934: "\u13ce",
  43935: "\u13cf",
  43936: "\u13d0",
  43937: "\u13d1",
  43938: "\u13d2",
  43939: "\u13d3",
  43940: "\u13d4",
  43941: "\u13d5",
  43942: "\u13d6",
  43943: "\u13d7",
  43944: "\u13d8",
  43945: "\u13d9",
  43946: "\u13da",
  43947: "\u13db",
  43948: "\u13dc",
  43949: "\u13dd",
  43950: "\u13de",
  43951: "\u13df",
  43952: "\u13e0",
  43953: "\u13e1",
  43954: "\u13e2",
  43955: "\u13e3",
  43956: "\u13e4",
  43957: "\u13e5",
  43958: "\u13e6",
  43959: "\u13e7",
  43960: "\u13e8",
  43961: "\u13e9",
  43962: "\u13ea",
  43963: "\u13eb",
  43964: "\u13ec",
  43965: "\u13ed",
  43966: "\u13ee",
  43967: "\u13ef",
  64256: "ff",
  64257: "fi",
  64258: "fl",
  64259: "ffi",
  64260: "ffl",
  64261: "st",
  64262: "st",
  64275: "\u0574\u0576",
  64276: "\u0574\u0565",
  64277: "\u0574\u056b",
  64278: "\u057e\u0576",
  64279: "\u0574\u056d",
};

/**
 * Deterministic full Unicode case-fold key for collision detection: NFKC,
 * then the complete per-code-point full casefold table (CaseFolding.txt C+F;
 * `toLowerCase` covers every code point the expansion table does not list),
 * then NFKC again so fold output is canonical. Folds `Σ`/`ς`, `Straße`/
 * `STRAẞE` and Greek ypogegrammeni compositions (`ᾀ`/`ἀι`) onto one key.
 * Applied identically to leaves, directory prefixes, reserved-path checks
 * and manifest comparisons.
 */
function casefoldSegment(segment: string): string {
  let folded = "";
  for (const ch of segment.normalize("NFKC")) {
    const codePoint = ch.codePointAt(0)!;
    folded += CASEFOLD_EXPANSIONS[codePoint] ?? String.fromCodePoint(codePoint).toLowerCase();
  }
  return folded.normalize("NFKC");
}

function isGitMetadataSegment(segment: string): boolean {
  // Git's HFS protection ignores these code points inside metadata names.
  // NTFS also aliases the 8.3 name GIT~1, trailing dots/spaces and alternate
  // data streams (`.git:...`). Apply this at every depth and to empty dirs.
  const folded = casefoldSegment(segment).replace(
    /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu,
    "",
  );
  const basename = folded.split(":", 1)[0]!.replace(/[ .]+$/u, "");
  return basename === ".git" || basename === "git~1";
}

function windowsReservedBasename(segment: string): string {
  const folded = casefoldSegment(segment);
  const withoutTrailing = folded.replace(/[.\s]+$/u, "");
  const dot = withoutTrailing.indexOf(".");
  const base = dot < 0 ? withoutTrailing : withoutTrailing.slice(0, dot);
  return base.replace(/[.\s]+$/u, "");
}

function segmentHasControlChar(segment: string): boolean {
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isValidUtf8String(text: string): boolean {
  const bytes = Buffer.from(text, "utf8");
  return bytes.toString("utf8") === text;
}

export const KB_MANAGED_GITIGNORE = "# kb managed\n";

export function isMarkdownPath(path: string): boolean {
  return path.endsWith(".md") || path === "index.md";
}

export const KB_RESERVED_PATHS = new Set([".gitignore", ".assets/manifest.json"]);

export function isReservedPath(path: string): boolean {
  return KB_RESERVED_PATHS.has(path) || KB_RESERVED_PATHS.has(casefoldPathKey(path));
}

/** A reserved root file, or anything under `.assets/` (case-folded): never a document. */
export function isKbNamespacePath(path: string): boolean {
  return isReservedPath(path) || casefoldPathKey(path).startsWith(casefoldPathKey(".assets/"));
}
