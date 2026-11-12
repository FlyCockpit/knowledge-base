import { createHash } from "node:crypto";
import { assetValidationContext } from "./asset-authz";
import { KbDomainError } from "./errors";
import markdownEntities from "./fixtures/markdown-entities.json" with { type: "json" };
import {
  assertGitReadActive,
  type GitReadOptions,
  gitReadOptions,
  kbBareRepoPath,
  readBlobsAsync,
  runGitAsync,
  TreeReadBudgetError,
} from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import type { LockQuery } from "./lock";
import { type AssetManifestEntry, parseAssetManifest } from "./manifest";
import { decodeUtf8Fatal, parseMarkdownDocument } from "./parse-markdown";
import { isMarkdownPath, normalizeKbPath } from "./paths";
import { type AuthorizeInput, recheckRead } from "./permissions";
import { assertKbRecoveryComplete } from "./recovery-gate";
import { parseSealedReference } from "./sealed-reference";

const SHA1 = /^[0-9a-f]{40}$/;
const MAX_DOCUMENT_BYTES = KB_TREE_LIMITS.maxMarkdownBytes;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** 8192 entries at ~600 bytes of ls-tree record each, plus headroom. */
const LS_TREE_MAX_BUFFER = 16 * 1024 * 1024;

/** Content admission is stricter than metadata/repair management admission. */
export async function authorizeDocumentRead(input: AuthorizeInput): Promise<void> {
  assertKbRecoveryComplete();
  const auth = await recheckRead(input);
  if (auth.state === "REPAIR_REQUIRED") {
    throw new KbDomainError("REPAIR_REQUIRED", "Knowledge base requires repair");
  }
  if (auth.state !== "ACTIVE") {
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Knowledge base is not ready");
  }
}

export type DocumentListItem = {
  path: string;
  documentId: string | null;
  commitSha: string;
  blobSha: string;
  size: number;
};

export type DocumentRecord = {
  path: string;
  documentId: string | null;
  markdown: string;
  frontMatter: Record<string, unknown>;
  commitSha: string;
  blobSha: string;
  contentHash: string;
  documentCitations: { label: string; target: string }[];
  assetRefs: AssetManifestEntry[];
};

function assertSha(sha: string): void {
  if (!SHA1.test(sha)) throw new KbDomainError("INVALID_ARGUMENT", "Invalid revision");
}

async function runGitTextAsync(
  repoPath: string,
  args: readonly string[],
  options: GitReadOptions,
): Promise<string> {
  const { stdout } = await runGitAsync(repoPath, args, options);
  return stdout.toString().trim();
}

async function runGitBytesAsync(
  repoPath: string,
  args: readonly string[],
  maxBuffer: number,
  options: GitReadOptions,
): Promise<Buffer> {
  const { stdout } = await runGitAsync(repoPath, args, {
    ...options,
    encoding: "buffer",
    maxBuffer,
  });
  return stdout as Buffer;
}

export async function listRetainedBranchTips(
  repoPath: string,
  options: GitReadOptions = {},
): Promise<string[]> {
  const output = await runGitTextAsync(
    repoPath,
    ["for-each-ref", "--format=%(objectname)", "refs/heads"],
    options,
  );
  if (!output) return [];
  return output.split("\n").filter((line) => SHA1.test(line));
}

export async function isCommitReachable(
  repoPath: string,
  commitSha: string,
  readOptions: GitReadOptions = {},
): Promise<boolean> {
  const options = gitReadOptions(readOptions);
  assertSha(commitSha);
  const { stdout, stderr, exitCode } = await runGitAsync(
    repoPath,
    [
      "for-each-ref",
      `--contains=${commitSha}`,
      "--count=1",
      "--format=%(objectname)",
      "refs/heads",
    ],
    { ...options, maxBuffer: 64 * 1024, resultExitCodes: [128, 129] },
  );
  if (exitCode) {
    // Native execFile errors do not carry stderr. Ask the existing runner to
    // return these statuses so unknown objects remain misses, while repository
    // and IO failures with the same status still surface as operational errors.
    if (
      stderr
        .split("\n")
        .some(
          (line) =>
            line === `error: no such commit ${commitSha}` ||
            line === `fatal: not a valid object name ${commitSha}` ||
            line === `fatal: Not a valid object name ${commitSha}`,
        )
    )
      return false;
    throw Object.assign(new Error("Git revision reachability failed"), { code: exitCode, stderr });
  }
  return stdout
    .toString()
    .trim()
    .split("\n")
    .some((line) => SHA1.test(line));
}

export async function resolvePinnedRevision(
  repoPath: string,
  rev: string | undefined,
  authoritativeHead: string | null,
  options: GitReadOptions = {},
): Promise<string> {
  if (!authoritativeHead) {
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Knowledge base is not ready");
  }
  const pinned = rev ?? authoritativeHead;
  assertSha(pinned);
  if (!(await isCommitReachable(repoPath, pinned, options))) {
    throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  }
  return pinned;
}

function contentHashFor(bytes: Buffer): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${digest}`;
}

type SnapshotEntry = { path: string; blobSha: string; size: number };

/**
 * One bounded bulk read (`ls-tree -r -l -z`) replaces the per-directory walk
 * plus one `cat-file -s` per document: paths, blob SHAs, and sizes arrive in
 * a single Git invocation, and the entry budget is enforced while parsing.
 */
async function readBlobEntriesWithSizes(
  repoPath: string,
  commitSha: string,
  options: GitReadOptions,
): Promise<SnapshotEntry[]> {
  assertSha(commitSha);
  const stdout = await runGitBytesAsync(
    repoPath,
    ["ls-tree", "-r", "-l", "-z", commitSha],
    LS_TREE_MAX_BUFFER,
    options,
  );
  const entries: SnapshotEntry[] = [];
  let start = 0;
  while (start < stdout.byteLength) {
    let end = stdout.indexOf(0, start);
    if (end < 0) end = stdout.byteLength;
    const record = stdout.subarray(start, end);
    start = end + 1;
    if (record.byteLength === 0) continue;
    if (entries.length >= KB_TREE_LIMITS.maxEntries) {
      throw new TreeReadBudgetError("tree exceeds entry budget", {
        size: entries.length + 1,
        maxBytes: KB_TREE_LIMITS.maxEntries,
      });
    }
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("unexpected ls-tree record");
    const meta = record.subarray(0, tab).toString("ascii");
    const match = /^(\d+) (blob|tree|commit) ([0-9a-f]{40}) +(-|\d+)$/.exec(meta);
    if (!match) throw new Error(`unexpected ls-tree meta ${meta}`);
    if (match[2] !== "blob") continue;
    let path: string;
    try {
      path = decodeUtf8Fatal(record.subarray(tab + 1));
    } catch {
      throw new TreeReadBudgetError("tree path is not valid UTF-8", { size: 0, maxBytes: 0 });
    }
    entries.push({ path, blobSha: match[3]!, size: Number(match[4]) });
  }
  return entries;
}

async function readBlobContentAsync(
  repoPath: string,
  blobSha: string,
  limits: { maxBytes: number },
  options: GitReadOptions,
): Promise<Buffer> {
  if (!SHA1.test(blobSha)) throw new Error("invalid blob sha");
  const stdout = await runGitBytesAsync(
    repoPath,
    ["cat-file", "blob", blobSha],
    limits.maxBytes + 1,
    options,
  );
  if (stdout.byteLength > limits.maxBytes) {
    throw new TreeReadBudgetError("blob exceeds read budget", {
      size: stdout.byteLength,
      maxBytes: limits.maxBytes,
    });
  }
  return stdout;
}

/** The immutable manifest entry list at a commit, from the same tree snapshot. */
async function loadManifestFromSnapshot(
  repoPath: string,
  entries: readonly SnapshotEntry[],
  options: GitReadOptions,
): Promise<Map<string, AssetManifestEntry>> {
  const manifestEntry = entries.find((entry) => entry.path === ".assets/manifest.json");
  if (!manifestEntry) return new Map();
  const bytes = await readBlobContentAsync(
    repoPath,
    manifestEntry.blobSha,
    {
      maxBytes: KB_TREE_LIMITS.maxMarkdownBytes,
    },
    options,
  );
  const parsed = parseAssetManifest(bytes);
  if (!("version" in parsed))
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset manifest unavailable");
  return new Map(parsed.entries.map((entry) => [entry.path, entry]));
}

export async function listDocumentsAtRevision(
  input: {
    reposDir: string;
    kbId: string;
    commitSha: string;
    prefix?: string;
    limit: number;
    afterPath?: string | null;
  } & GitReadOptions,
): Promise<{ items: DocumentListItem[]; nextAfter: string | null }> {
  const options = gitReadOptions(input);
  const repoPath = kbBareRepoPath(input.reposDir, input.kbId);
  if (!(await isCommitReachable(repoPath, input.commitSha, options))) {
    throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  }
  let normalizedPrefix: string | undefined;
  if (input.prefix) {
    // L-22: a trailing `/` restricts the raw prefix to one directory.
    const directory = input.prefix.endsWith("/");
    const normalized = normalizeKbPath(directory ? input.prefix.slice(0, -1) : input.prefix);
    if (!normalized.ok) throw new KbDomainError("INVALID_ARGUMENT", "Invalid path prefix");
    normalizedPrefix = directory ? `${normalized.path}/` : normalized.path;
  }
  const entries = await readBlobEntriesWithSizes(repoPath, input.commitSha, options);
  const paths = entries
    .filter(
      (entry) =>
        entry.path.endsWith(".md") &&
        (!normalizedPrefix || entry.path.startsWith(normalizedPrefix)),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const filtered = input.afterPath ? paths.filter((row) => row.path > input.afterPath!) : paths;
  const page = filtered.slice(0, input.limit + 1);
  const items: DocumentListItem[] = [];
  // The page's documents in one batched read; an oversized or unreadable
  // one just has no id (metadata is optional), but a terminated read is not
  // a partial success.
  const listed = page.slice(0, input.limit);
  let bodies: ReadonlyMap<string, Buffer> = new Map();
  try {
    bodies = await readBlobsAsync(
      repoPath,
      listed.filter((row) => row.size <= MAX_DOCUMENT_BYTES).map((row) => row.blobSha),
      { maxBytes: MAX_DOCUMENT_BYTES },
      options,
    );
  } catch {
    assertGitReadActive(options);
  }
  for (const row of listed) {
    let documentId: string | null = null;
    const bytes = bodies.get(row.blobSha);
    if (bytes) {
      const parsed = parseMarkdownDocument(bytes);
      if ("documentId" in parsed) documentId = parsed.documentId;
    }
    items.push({
      path: row.path,
      documentId,
      commitSha: input.commitSha,
      blobSha: row.blobSha,
      size: row.size,
    });
  }
  const nextAfter = page.length > input.limit ? (items[items.length - 1]?.path ?? null) : null;
  return { items, nextAfter };
}

export async function readDocumentAtRevision(
  input: {
    reposDir: string;
    kbId: string;
    commitSha: string;
    path: string;
    query?: LockQuery;
  } & GitReadOptions,
): Promise<DocumentRecord> {
  const normalized = normalizeKbPath(input.path);
  if (!normalized.ok) throw new KbDomainError("INVALID_ARGUMENT", "Invalid path");
  const options = gitReadOptions(input);
  const repoPath = kbBareRepoPath(input.reposDir, input.kbId);
  if (!(await isCommitReachable(repoPath, input.commitSha, options))) {
    throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  }
  const entries = await readBlobEntriesWithSizes(repoPath, input.commitSha, options);
  const entry = entries.find((row) => row.path === normalized.path);
  // A missing document, not a missing KB or revision.
  if (!entry)
    throw new KbDomainError("NOT_FOUND", "Document not found", undefined, {
      reason: "PATH_NOT_FOUND",
      field: "/path",
    });
  const bytes = await readBlobContentAsync(
    repoPath,
    entry.blobSha,
    {
      maxBytes: MAX_DOCUMENT_BYTES,
    },
    options,
  );
  const parsed = parseMarkdownDocument(bytes);
  if (!("body" in parsed)) {
    throw new KbDomainError("INVALID_ARGUMENT", "Document is not valid Markdown");
  }
  const markdown = bytes.toString("utf8");
  const manifest = await loadManifestFromSnapshot(repoPath, entries, options);
  const referenced = resolveMarkdownAssetReferences(parsed.body, normalized.path);
  const assetRefs = [...manifest.values()].filter((row) => referenced.has(row.path));
  if (assetRefs.length) {
    if (!input.query) throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset authority unavailable");
    const context = await assetValidationContext(
      input.query,
      input.kbId,
      assetRefs.map((entry) => entry.hash),
    );
    for (const entry of assetRefs) {
      const trusted = context.trustedBlobs.get(entry.hash);
      if (!trusted || trusted.size !== entry.size || trusted.mime !== entry.mime)
        throw new KbDomainError("NOT_FOUND", "Asset not found");
    }
  }
  const contentHash = contentHashFor(bytes);
  const responseBytes = Buffer.byteLength(
    JSON.stringify({
      path: normalized.path,
      markdown,
      frontMatter: parsed.frontMatter,
      commitSha: input.commitSha,
      blobSha: entry.blobSha,
      contentHash,
      documentCitations: parsed.citations,
      assetRefs,
    }),
    "utf8",
  );
  if (responseBytes > MAX_RESPONSE_BYTES) {
    throw new KbDomainError("INVALID_ARGUMENT", "Response too large");
  }
  return {
    path: normalized.path,
    documentId: parsed.documentId,
    markdown,
    frontMatter: parsed.frontMatter,
    commitSha: input.commitSha,
    blobSha: entry.blobSha,
    contentHash,
    documentCitations: parsed.citations,
    assetRefs,
  };
}

export function estimateListPageBytes(items: DocumentListItem[]): number {
  return Buffer.byteLength(JSON.stringify({ items }), "utf8");
}

/**
 * Source-side bound, not a normalized-path bound: entities/percent escapes,
 * dot segments and discarded queries can make a valid asset URL much longer
 * than its <=512-byte manifest path. Construct claims keep the scan linear.
 */
const MAX_LINK_PART_CHARS = MAX_DOCUMENT_BYTES;

/** CommonMark reference labels are at most 999 characters after normalization. */
const MAX_REFERENCE_LABEL_CHARS = 999;

type BracketPair = { open: number; close: number };

/**
 * One linear pass with an open-bracket stack: every character is visited at
 * most once, so a document of unmatched `[` delimiters can never trigger the
 * repeated suffix scans a backtracking regex performs.
 */
function collectBracketPairs(text: string): BracketPair[] {
  const pairs: BracketPair[] = [];
  const stack: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      stack.push(i);
    } else if (ch === "]") {
      const open = stack.pop();
      if (open !== undefined) pairs.push({ open, close: i });
    }
    i += 1;
  }
  return pairs;
}

function isWhitespaceChar(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function skipInlineWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  return i;
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWhitespaceChar(text[i]!)) i += 1;
  return i;
}

/**
 * Scan for the next terminator accepted by `accept`, honoring backslash
 * escapes and bounded by MAX_LINK_PART_CHARS. Returns the terminator index or
 * -1 when the bound or end of input hits first.
 */
function scanUntil(text: string, from: number, accept: (ch: string) => boolean): number {
  let i = from;
  while (i < text.length && i < from + MAX_LINK_PART_CHARS) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (accept(ch)) return i;
    i += 1;
  }
  return -1;
}

function stripMarkdownCode(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  let fenceChar = "";
  let fenceLength = 0;
  let inParagraph = false;
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceChar) {
      if (
        fence &&
        fence[1]![0] === fenceChar &&
        fence[1]!.length >= fenceLength &&
        !fence[2]!.trim()
      ) {
        fenceChar = "";
        fenceLength = 0;
      }
      continue;
    }
    if (fence) {
      fenceChar = fence[1]![0]!;
      fenceLength = fence[1]!.length;
      inParagraph = false;
      continue;
    }
    if (!line.trim()) {
      inParagraph = false;
      kept.push(line);
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      if (inParagraph) kept.push(line);
      continue;
    }
    kept.push(line);
    inParagraph = true;
  }
  const text = kept.join("\n");
  // Match backtick runs by length, including multiline spans. Unmatched runs
  // remain literal; a single tick inside a double-tick span never closes it.
  const runs = [...text.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const ends = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    const end = next.get(run[0].length);
    if (end !== undefined) ends.set(i, end);
    next.set(run[0].length, i);
  }
  let result = "";
  let cursor = 0;
  for (let i = 0; i < runs.length; i++) {
    const end = ends.get(i);
    if (end === undefined) continue;
    result += `${text.slice(cursor, runs[i]!.index)} `;
    cursor = runs[end]!.index + runs[end]![0].length;
    i = end;
  }
  return result + text.slice(cursor);
}

function isExternalDestination(destination: string): boolean {
  return (
    destination.length === 0 ||
    destination.startsWith("#") ||
    destination.startsWith("//") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(destination)
  );
}

function normalizeSegments(segments: readonly string[]): string | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : null;
}

/**
 * Resolve a destination once. An encoded URL references its decoded path,
 * never both that path and a distinct literal-percent asset in the manifest.
 */
function assetCandidatesFromDestination(
  documentDir: readonly string[],
  destination: string,
): string[] {
  const withoutFragment = destination.replace(/[?#].*$/, "");
  if (withoutFragment.length === 0) return [];
  let form = withoutFragment;
  try {
    form = decodeURIComponent(withoutFragment);
  } catch {
    // Malformed percent-encoding: match the literal path only.
  }
  if (isExternalDestination(form)) return [];
  const segments = form.startsWith("/") ? form.split("/") : [...documentDir, ...form.split("/")];
  const normalized = normalizeSegments(segments);
  return normalized ? [normalized] : [];
}

/** CommonMark destinations decode escapes and character references ONCE,
 * before query/fragment/path normalization. An escaped ampersand is literal,
 * so two separate replacement passes would incorrectly decode it again.
 * Named data is generated from the pinned GFM renderer (sync-markdown-entities).
 */
function decodeMarkdownDestination(raw: string): string {
  return raw.replace(
    /\\([!-/:-@[-`{-~])|&(?:#([0-9]{1,7})|#[xX]([a-fA-F0-9]{1,6})|([a-zA-Z][a-zA-Z0-9]{0,31}));/g,
    (
      match,
      escaped: string | undefined,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined,
    ) => {
      if (escaped !== undefined) return escaped;
      if (name !== undefined)
        return Object.hasOwn(markdownEntities, name)
          ? markdownEntities[name as keyof typeof markdownEntities]
          : match;
      const code = Number.parseInt(decimal ?? hex ?? "", decimal !== undefined ? 10 : 16);
      // Same invalid/control/noncharacter handling as micromark.
      if (
        code < 9 ||
        code === 11 ||
        (code > 13 && code < 32) ||
        (code > 126 && code < 160) ||
        (code > 55_295 && code < 57_344) ||
        (code > 64_975 && code < 65_008) ||
        (code & 65_535) >= 65_534 ||
        code > 1_114_111
      )
        return "\uFFFD";
      return String.fromCodePoint(code);
    },
  );
}

function addAssetDestination(
  referenced: Set<string>,
  documentDir: readonly string[],
  raw: string,
): void {
  const trimmed = raw.trim();
  if (!trimmed || isExternalDestination(trimmed)) return;
  const destination = decodeMarkdownDestination(trimmed);
  if (isExternalDestination(destination)) return;
  for (const candidate of assetCandidatesFromDestination(documentDir, destination)) {
    referenced.add(candidate);
  }
}

/**
 * Parsed construct. `destination` is null when the construct is not a valid
 * link, but `claimEnd` always marks the region this parse scanned: claiming
 * even failed parses is what keeps the whole scan linear, because the
 * characters of one attempt are never rescanned by another.
 */
type ParsedConstruct = { destination: string | null; claimEnd: number };

/** `[text](dest)` — parse the parenthesized destination and claim through `)`. */
function parseParenthesizedDestination(text: string, openParen: number): ParsedConstruct {
  let i = skipInlineWhitespace(text, openParen + 1);
  let scanned = Math.min(i, text.length);
  if (i >= text.length || i >= openParen + MAX_LINK_PART_CHARS) {
    return { destination: null, claimEnd: scanned };
  }
  let destination: string;
  let afterDestination: number;
  if (text[i] === "<") {
    const end = scanUntil(text, i + 1, (ch) => ch === ">" || ch === "\n");
    scanned = end < 0 ? Math.min(text.length, i + 1 + MAX_LINK_PART_CHARS) : end + 1;
    if (end < 0 || text[end] !== ">") return { destination: null, claimEnd: scanned };
    destination = text.slice(i + 1, end);
    afterDestination = end + 1;
  } else {
    let depth = 0;
    let j = i;
    while (j < text.length && j < i + MAX_LINK_PART_CHARS) {
      const ch = text[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "(") {
        depth += 1;
        j += 1;
        continue;
      }
      if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
        j += 1;
        continue;
      }
      if (isWhitespaceChar(ch)) break;
      j += 1;
    }
    if (j >= i + MAX_LINK_PART_CHARS) j = i + MAX_LINK_PART_CHARS;
    if (j > text.length) j = text.length;
    scanned = j;
    // A bare destination must end at a depth-0 `)` (link closes) or at
    // whitespace (title may follow); running to the bound or end of input,
    // or unbalanced parens, means this is not a link.
    if (depth !== 0 || j >= text.length) return { destination: null, claimEnd: scanned };
    destination = text.slice(i, j);
    afterDestination = j;
  }
  let k = skipWhitespace(text, afterDestination);
  scanned = Math.max(scanned, Math.min(k, text.length));
  if (k < text.length) {
    const ch = text[k]!;
    if (ch === '"' || ch === "'") {
      const end = scanUntil(text, k + 1, (c) => c === ch || c === "\n");
      scanned = Math.max(
        scanned,
        end < 0 ? Math.min(text.length, k + 1 + MAX_LINK_PART_CHARS) : end + 1,
      );
      if (end < 0 || text[end] !== ch) return { destination: null, claimEnd: scanned };
      k = skipWhitespace(text, end + 1);
      scanned = Math.max(scanned, Math.min(k, text.length));
    } else if (ch === "(") {
      let depth = 0;
      let e = k + 1;
      let closed = -1;
      while (e < text.length && e < k + MAX_LINK_PART_CHARS) {
        const c = text[e]!;
        if (c === "\\") {
          e += 2;
          continue;
        }
        if (c === "(") {
          depth += 1;
          e += 1;
          continue;
        }
        if (c === ")") {
          if (depth === 0) {
            closed = e;
            break;
          }
          depth -= 1;
          e += 1;
          continue;
        }
        e += 1;
      }
      if (e >= k + MAX_LINK_PART_CHARS) e = k + MAX_LINK_PART_CHARS;
      if (e > text.length) e = text.length;
      scanned = Math.max(scanned, e);
      if (closed < 0) return { destination: null, claimEnd: scanned };
      k = skipWhitespace(text, closed + 1);
      scanned = Math.max(scanned, Math.min(k, text.length));
    }
  }
  if (k < text.length && text[k] === ")") {
    return { destination, claimEnd: k + 1 };
  }
  return { destination: null, claimEnd: scanned };
}

/** End of the line containing `from`, claiming it for a definition attempt. */
function endOfLine(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] !== "\n") i += 1;
  return i;
}

/**
 * `[label]: dest [title]` at line start. The line is always claimed; the
 * definition registers only when a destination and at most a title precede
 * the line's end.
 */
function parseDefinitionDestination(
  text: string,
  colon: number,
): ParsedConstruct & { valid: boolean } {
  const lineEnd = endOfLine(text, colon);
  let i = skipInlineWhitespace(text, colon + 1);
  if (i >= lineEnd) return { destination: null, claimEnd: lineEnd, valid: false };
  let destination: string | null = null;
  let end: number;
  if (text[i] === "<") {
    const close = scanUntil(text, i + 1, (ch) => ch === ">" || ch === "\n");
    if (close >= 0 && close < lineEnd && text[close] === ">") {
      destination = text.slice(i + 1, close);
      end = close + 1;
    } else {
      end = i + 1;
    }
  } else {
    let j = i;
    while (j < lineEnd && j < i + MAX_LINK_PART_CHARS) {
      const ch = text[j]!;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (isWhitespaceChar(ch)) break;
      j += 1;
    }
    if (j === i) return { destination: null, claimEnd: lineEnd, valid: false };
    destination = text.slice(i, Math.min(j, lineEnd));
    end = Math.min(j, lineEnd);
  }
  if (destination === null) return { destination: null, claimEnd: lineEnd, valid: false };
  // Only whitespace, or a title then only whitespace, may precede the EOL.
  // Inline whitespace only: the line's own terminator must stay untouched.
  let k = skipInlineWhitespace(text, end);
  if (k < lineEnd) {
    const ch = text[k]!;
    if (ch === '"' || ch === "'") {
      const close = scanUntil(text, k + 1, (c) => c === ch || c === "\n");
      if (close < 0 || close > lineEnd || text[close] !== ch) {
        return { destination: null, claimEnd: lineEnd, valid: false };
      }
      k = skipInlineWhitespace(text, close + 1);
    } else if (ch === "(") {
      let depth = 0;
      let e = k + 1;
      let closed = -1;
      while (e < lineEnd && e < k + MAX_LINK_PART_CHARS) {
        const c = text[e]!;
        if (c === "\\") {
          e += 2;
          continue;
        }
        if (c === "(") {
          depth += 1;
          e += 1;
          continue;
        }
        if (c === ")") {
          if (depth === 0) {
            closed = e;
            break;
          }
          depth -= 1;
          e += 1;
          continue;
        }
        e += 1;
      }
      if (closed < 0) return { destination: null, claimEnd: lineEnd, valid: false };
      k = skipInlineWhitespace(text, closed + 1);
    } else {
      return { destination: null, claimEnd: lineEnd, valid: false };
    }
  }
  if (k !== lineEnd) return { destination: null, claimEnd: lineEnd, valid: false };
  return { destination, claimEnd: lineEnd, valid: true };
}

function isAtLineStart(text: string, open: number): boolean {
  let i = open - 1;
  let spaces = 0;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) {
    spaces += 1;
    i -= 1;
  }
  return (i < 0 || text[i] === "\n") && spaces <= 3;
}

/** CommonMark label normalization: trim, collapse whitespace, case-fold. */
function normalizeReferenceLabel(label: string): string | null {
  if (label.length === 0 || label.length > MAX_REFERENCE_LABEL_CHARS) return null;
  const normalized = label.replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** `[ref]` after a closed bracket: scan to the next unescaped `]`, bounded. */
function parseReferenceLabel(
  text: string,
  openBracket: number,
): { label: string | null; closeIndex: number; claimEnd: number } {
  const close = scanUntil(text, openBracket + 1, (ch) => ch === "]");
  if (close < 0) {
    return {
      label: null,
      closeIndex: -1,
      claimEnd: Math.min(text.length, openBracket + 1 + MAX_LINK_PART_CHARS),
    };
  }
  return { label: text.slice(openBracket + 1, close), closeIndex: close, claimEnd: close + 1 };
}

/**
 * Repo-relative paths of Markdown link/image destinations in this document
 * that could reference committed assets: relative destinations resolve against
 * the document's directory (percent-decoded once), code
 * spans/blocks are excluded, reference definitions are resolved, and absolute
 * URLs, fragments, and scheme-bearing destinations are ignored.
 *
 * The scanner is bounded linear time: a single stack pass pairs brackets, and
 * every construct (inline destination, reference label, definition) claims
 * the region it scanned — successfully parsed or not — so no character is
 * ever rescanned for another construct. Full, collapsed and shortcut references
 * resolve only through definitions in this same source.
 */
export function resolveMarkdownAssetReferences(
  markdown: string,
  documentPath: string,
): Set<string> {
  const text = stripMarkdownCode(markdown);
  const documentDir = documentPath.split("/").slice(0, -1);
  const referenced = new Set<string>();
  const definitions = new Map<string, string>();
  const pendingReferences = new Set<string>();

  let claimedUntil = -1;
  for (const pair of collectBracketPairs(text)) {
    if (pair.close < claimedUntil) continue;
    const after = pair.close + 1;
    const next = after < text.length ? text[after]! : "";
    if (next === "(") {
      const parsed = parseParenthesizedDestination(text, after);
      claimedUntil = Math.max(claimedUntil, parsed.claimEnd);
      if (parsed.destination !== null) {
        addAssetDestination(referenced, documentDir, parsed.destination);
      }
      continue;
    }
    if (next === "[") {
      const parsed = parseReferenceLabel(text, after);
      claimedUntil = Math.max(claimedUntil, parsed.claimEnd);
      if (parsed.label !== null) {
        const key = normalizeReferenceLabel(parsed.label || text.slice(pair.open + 1, pair.close));
        if (key) pendingReferences.add(key);
      }
      continue;
    }
    if (next === ":" && pair.close - pair.open - 1 <= MAX_REFERENCE_LABEL_CHARS) {
      if (!isAtLineStart(text, pair.open)) continue;
      const parsed = parseDefinitionDestination(text, after);
      claimedUntil = Math.max(claimedUntil, parsed.claimEnd);
      if (parsed.valid && parsed.destination !== null) {
        const key = normalizeReferenceLabel(text.slice(pair.open + 1, pair.close));
        if (key && !definitions.has(key)) definitions.set(key, parsed.destination);
      }
    }
    if (next !== ":" && pair.close - pair.open <= MAX_REFERENCE_LABEL_CHARS + 1) {
      const key = normalizeReferenceLabel(text.slice(pair.open + 1, pair.close));
      if (key) pendingReferences.add(key);
    }
  }
  // Resolve each used definition once; repeated references must not multiply
  // a long destination's entity/path normalization work.
  for (const key of pendingReferences) {
    const destination = definitions.get(key);
    if (destination) addAssetDestination(referenced, documentDir, destination);
  }
  return referenced;
}

/** Literal source occurrence: no case folding, Markdown decoding or delimiter stripping. */
export function sourceHasSealedReference(source: string, reference: string): boolean {
  try {
    parseSealedReference(reference);
  } catch {
    return false;
  }
  return source.includes(reference);
}

/** Reads only this bounded immutable Markdown blob, never another path, HEAD or the index. */
export async function assertSealedReferenceAtRevision(
  input: {
    reposDir: string;
    kbId: string;
    commitSha: string;
    path: string;
    reference: string;
  } & GitReadOptions,
): Promise<void> {
  const options = gitReadOptions(input);
  const missing = () => new KbDomainError("UNRESOLVED_REFERENCE", "Unresolved reference");
  const path = normalizeKbPath(input.path);
  if (!path.ok || !isMarkdownPath(path.path)) throw missing();
  const repo = kbBareRepoPath(input.reposDir, input.kbId);
  if (!(await isCommitReachable(repo, input.commitSha, options))) throw missing();
  const entries = await readBlobEntriesWithSizes(repo, input.commitSha, options);
  const entry = entries.find((row) => row.path === path.path);
  if (!entry || entry.size > MAX_DOCUMENT_BYTES) throw missing();
  const bytes = await readBlobContentAsync(
    repo,
    entry.blobSha,
    { maxBytes: MAX_DOCUMENT_BYTES },
    options,
  );
  if (!sourceHasSealedReference(decodeUtf8Fatal(bytes), input.reference)) throw missing();
}
