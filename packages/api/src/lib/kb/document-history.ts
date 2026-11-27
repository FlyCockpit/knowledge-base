import { pageTake } from "../pagination";
import { type ActorIdentity, parseServerAttribution, resolveActors } from "./actors";
import { KbDomainError } from "./errors";
import { type GitReadOptions, gitReadOptions, readBlobsAsync, runGitAsync } from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import type { LockQuery } from "./lock";
import {
  type DocumentProvenance,
  parseMarkdownDocument,
  readDocumentProvenance,
} from "./parse-markdown";
import { isMarkdownPath, KB_PATH_LIMITS, normalizeKbPath } from "./paths";

/**
 * Browser-only display of who wrote a document and how: the path-limited
 * history of main, and the writer of each Markdown file of a pull request.
 * The MCP outputs never carry any of this.
 *
 * Attribution is trusted only from a commit's canonical server trailer block
 * (`parseServerAttribution`); pushes cannot carry one, so anything else is
 * "unattributed" (a Git push, or a commit from before attribution keys).
 * Web vs credential comes from the actor key, never from the `via` text.
 */

const SHA1 = /^[0-9a-f]{40}$/;
/** Blob bytes one display read may load to read front matter. */
const PROVENANCE_READ_BUDGET = 16 * 1024 * 1024;
/** A pull request range longer than this has no per-file writer. */
const PR_WRITTEN_BY_MAX_COMMITS = 500;
const SUBJECT_MAX_CHARS = 200;
/** The most history rows one page returns. */
const DOCUMENT_HISTORY_MAX = 50;
/**
 * The deepest history row a cursor may resume at: a page starting past this
 * offset is never offered (the last page simply has no next cursor).
 */
const DOCUMENT_HISTORY_MAX_OFFSET = 10_000;
/**
 * An opaque history cursor: the pinned main head of the first page and the
 * number of rows already returned (`v1.<sha>.<offset>`, canonical decimal).
 */
export const DOCUMENT_HISTORY_CURSOR = /^v1\.[0-9a-f]{40}\.[1-9][0-9]{0,4}$/;
/** Commit objects are small; this bounds one batch of raw commit reads. */
const COMMIT_READ_MAX_BYTES = 16 * 1024 * 1024;

export type HistoryActor = {
  /** `web`: a person in the web app. `credential`: a PAT or OAuth app. `unattributed`: a Git push or an older commit. */
  kind: "web" | "credential" | "unattributed";
  /** The person, when known. */
  name: string | null;
  /** The token or app name of a credential (display only). */
  via: string | null;
};

export type DocumentHistoryRow = {
  sha: string;
  /**
   * Where the document lived at this commit. History follows renames, so
   * rows older than a move carry the earlier path (open them there).
   */
  path: string;
  /** ISO time, or null when the commit's own timestamp is outside the representable range. */
  committedAt: string | null;
  subject: string;
  /**
   * The path's provenance at this commit; null when the path is gone (deleted),
   * not Markdown, or too large for this page's read budget (unknown).
   */
  provenance: DocumentProvenance | null;
  deleted: boolean;
  actor: HistoryActor;
};

const UNATTRIBUTED: HistoryActor = { kind: "unattributed", name: null, via: null };

/** Actor of one commit message, from its trusted server block only. */
function actorKeyOfMessage(message: string): string | null {
  return parseServerAttribution(message)?.actorKey ?? null;
}

export function historyActor(
  message: string,
  actors: ReadonlyMap<string, ActorIdentity>,
): HistoryActor {
  const attribution = parseServerAttribution(message);
  if (!attribution) return UNATTRIBUTED;
  const identity = actors.get(attribution.actorKey);
  const credential = attribution.actorKey.startsWith("grant:");
  return {
    kind: credential ? "credential" : "web",
    name: identity?.name ?? null,
    via: credential ? (identity?.via ?? null) : null,
  };
}

/** The commit's first line as one bounded display line. */
export function commitSubjectLine(message: string): string {
  const first = message.replace(/\r\n?/g, "\n").split("\n")[0] ?? "";
  const cleaned = first
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length <= SUBJECT_MAX_CHARS
    ? cleaned
    : `${chars.slice(0, SUBJECT_MAX_CHARS - 1).join("")}…`;
}

/**
 * A commit larger than this is never one the server wrote (its messages are a
 * one-line subject and a few trailers): its message is not read, so it shows
 * with no subject and no attribution. Pushers choose message sizes.
 */
const COMMIT_MESSAGE_MAX_BYTES = 64 * 1024;

/**
 * Commit messages keyed by sha: sizes first (`git cat-file --batch-check`),
 * then the commits within `COMMIT_MESSAGE_MAX_BYTES` through `git cat-file
 * --batch` in batches that fit `COMMIT_READ_MAX_BYTES`, so no set of large
 * pushed messages can overflow a read. The message is everything after the
 * header block, parsed by declared size so message bytes can never pose as
 * another record. Oversized or missing commits have no entry.
 */
export async function readCommitMessagesAsync(
  repoPath: string,
  shas: readonly string[],
  options: GitReadOptions,
): Promise<Map<string, string>> {
  const wanted = [...new Set(shas)];
  if (wanted.some((sha) => !SHA1.test(sha))) throw new Error("invalid commit sha");
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const { stdout: checked } = await runGitAsync(
    repoPath,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { ...options, input: `${wanted.join("\n")}\n` },
  );
  const batches: string[][] = [];
  let batchBytes = Number.POSITIVE_INFINITY;
  for (const line of String(checked).split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (!sha || !SHA1.test(sha) || type !== "commit" || !/^\d+$/.test(size ?? "")) continue;
    // Header line + content + LF, with room for the header itself.
    const bytes = Number(size) + 128;
    if (Number(size) > COMMIT_MESSAGE_MAX_BYTES) continue;
    if (batchBytes + bytes > COMMIT_READ_MAX_BYTES) {
      batches.push([]);
      batchBytes = 0;
    }
    batches.at(-1)!.push(sha);
    batchBytes += bytes;
  }
  for (const batch of batches) await readCommitBatch(repoPath, batch, options, out);
  return out;
}

async function readCommitBatch(
  repoPath: string,
  wanted: readonly string[],
  options: GitReadOptions,
  out: Map<string, string>,
): Promise<void> {
  const { stdout } = await runGitAsync(repoPath, ["cat-file", "--batch"], {
    ...options,
    input: `${wanted.join("\n")}\n`,
    encoding: "buffer",
    maxBuffer: COMMIT_READ_MAX_BYTES,
  });
  const bytes = stdout as Buffer;
  let offset = 0;
  while (offset < bytes.length) {
    const eol = bytes.indexOf(0x0a, offset);
    if (eol < 0) throw new Error("truncated commit batch");
    const header = bytes.subarray(offset, eol).toString("ascii").split(" ");
    offset = eol + 1;
    if (header[1] === "missing") continue;
    const [sha, type, sizeText] = header;
    const size = Number(sizeText);
    if (!sha || !SHA1.test(sha) || !Number.isSafeInteger(size) || size < 0)
      throw new Error("invalid commit batch header");
    const body = bytes.subarray(offset, offset + size);
    offset += size + 1;
    if (type !== "commit") continue;
    const raw = body.toString("utf8");
    const split = raw.indexOf("\n\n");
    out.set(sha, split < 0 ? "" : raw.slice(split + 2));
  }
}

/** `<spec>` → blob sha and size through one `git cat-file --batch-check`; absent when missing. */
export async function batchCheckBlobs(
  repoPath: string,
  specs: readonly string[],
  options: GitReadOptions,
): Promise<Map<string, { sha: string; size: number }>> {
  const out = new Map<string, { sha: string; size: number }>();
  if (specs.length === 0) return out;
  const { stdout } = await runGitAsync(
    repoPath,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { ...options, input: `${specs.join("\n")}\n` },
  );
  const lines = String(stdout).split("\n");
  specs.forEach((spec, index) => {
    const [sha, type, size] = (lines[index] ?? "").split(" ");
    if (sha && SHA1.test(sha) && type === "blob" && /^\d+$/.test(size ?? ""))
      out.set(spec, { sha, size: Number(size) });
  });
  return out;
}

/**
 * The provenance of each Markdown blob, read in one batch within a byte
 * budget. A blob over the Markdown limit or the remaining budget is not read
 * and has no entry (its label is unknown, never shown as "absent"); one that
 * does not parse is "absent" (it carries no label this read can trust).
 */
export async function readBlobProvenance(
  repoPath: string,
  blobs: readonly { sha: string; size: number }[],
  options: GitReadOptions,
): Promise<Map<string, DocumentProvenance>> {
  const out = new Map<string, DocumentProvenance>();
  const wanted: string[] = [];
  let budget = PROVENANCE_READ_BUDGET;
  for (const blob of blobs) {
    if (out.has(blob.sha) || wanted.includes(blob.sha)) continue;
    // Not read: unknown, so the caller shows no label rather than a wrong one.
    if (blob.size > KB_TREE_LIMITS.maxMarkdownBytes || blob.size > budget) continue;
    budget -= blob.size;
    wanted.push(blob.sha);
  }
  const contents = await readBlobsAsync(
    repoPath,
    wanted,
    {
      maxBytes: KB_TREE_LIMITS.maxMarkdownBytes,
      totalMaxBytes: PROVENANCE_READ_BUDGET,
    },
    options,
  );
  for (const sha of wanted) {
    const bytes = contents.get(sha);
    const parsed = bytes ? parseMarkdownDocument(bytes) : null;
    out.set(
      sha,
      parsed && "frontMatter" in parsed ? readDocumentProvenance(parsed.frontMatter) : "absent",
    );
  }
  return out;
}

function encodeHistoryCursor(head: string, offset: number): string {
  return `v1.${head}.${offset}`;
}

/** The cursor's pinned head and offset, or INVALID_CURSOR for anything non-canonical. */
function decodeHistoryCursor(cursor: string): { head: string; offset: number } {
  if (!DOCUMENT_HISTORY_CURSOR.test(cursor))
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const [, head = "", offsetText = ""] = cursor.split(".");
  const offset = Number(offsetText);
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > DOCUMENT_HISTORY_MAX_OFFSET)
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  return { head, offset };
}

/**
 * Most bytes one followed-log row can take: `\0<40-hex sha> <time>\0`, then
 * `\n<status>\0` and, for a rename or copy, two paths of at most
 * `KB_PATH_LIMITS.maxBytes` bytes, each NUL-terminated.
 */
export const FOLLOWED_LOG_ROW_MAX_BYTES =
  1 + 40 + 1 + 20 + 1 + 1 + 8 + 1 + 2 * (KB_PATH_LIMITS.maxBytes + 1);

/** The output buffer for a followed log of `rows` rows (at least git's default). */
export function followedLogMaxBytes(rows: number): number {
  return Math.max(8 * 1024 * 1024, rows * FOLLOWED_LOG_ROW_MAX_BYTES);
}

/**
 * `git log --follow --name-status -z --format=%x00%H %ct` output: per commit
 * `\0<sha> <time>\0` then, when the commit touched the followed file,
 * `\n<status>\0<path>\0` (`R…`/`C…`: `<old>\0<new>\0`). Newest first, so a
 * rename row's new name is where the document lived at that commit and its
 * old name is the path of every older row. A row without a status (a merge
 * that kept the file as its first parent had it) keeps the current name.
 */
export function parseFollowedLog(
  stdout: string,
  path: string,
): { sha: string; committedAt: string | null; path: string; followedFrom?: string }[] {
  const tokens = stdout.split("\0");
  const rows: ReturnType<typeof parseFollowedLog> = [];
  let current = path;
  let i = 0;
  while (i < tokens.length) {
    const header = tokens[i++] ?? "";
    if (header === "" || header === "\n") continue;
    const [sha, time] = header.split(" ");
    if (!sha || !SHA1.test(sha) || !/^\d+$/.test(time ?? "")) throw new Error("invalid log line");
    // A pushed commit's timestamp is the pusher's: one outside JavaScript's
    // date range is shown as unknown rather than failing the page.
    const at = new Date(Number(time) * 1000);
    let rowPath = current;
    let followedFrom: string | undefined;
    const status = (tokens[i] ?? "").replace(/^\n/, "");
    if (/^[ACDMRTUX]\d*$/.test(status) && status !== "") {
      i += 1;
      if (status.startsWith("R") || status.startsWith("C")) {
        const from = tokens[i++] ?? "";
        const to = tokens[i++] ?? "";
        if (!from || !to) throw new Error("invalid log line");
        rowPath = to;
        followedFrom = from;
        current = from;
      } else {
        const named = tokens[i++] ?? "";
        if (!named) throw new Error("invalid log line");
        rowPath = named;
        current = named;
      }
    }
    rows.push({
      sha,
      committedAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
      path: rowPath,
      ...(followedFrom ? { followedFrom } : {}),
    });
  }
  return rows;
}

/**
 * One page of the path's history on main, newest first. The first page pins
 * main's head; its cursor (opaque, `DOCUMENT_HISTORY_CURSOR`) carries that
 * head and the rows already returned, and every later page reruns the same
 * path-limited log from the pinned head, skipping them. So a merge whose
 * parents both changed the path never loses a side across pages, and no row
 * repeats. The pinned head must still be on main's history; past
 * `DOCUMENT_HISTORY_MAX_OFFSET` rows there are no further pages.
 */
export async function readDocumentHistory(
  input: {
    repoPath: string;
    headSha: string;
    path: string;
    cursor: string | null;
    limit: number;
    query: LockQuery;
  } & GitReadOptions,
): Promise<{ items: DocumentHistoryRow[]; nextCursor: string | null }> {
  const options = gitReadOptions(input);
  const normalized = normalizeKbPath(input.path);
  if (!normalized.ok) throw new KbDomainError("INVALID_ARGUMENT", "Invalid path");
  const path = normalized.path;
  if (!SHA1.test(input.headSha)) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  let head = input.headSha;
  let offset = 0;
  if (input.cursor !== null) {
    ({ head, offset } = decodeHistoryCursor(input.cursor));
    const ancestor = await runGitAsync(
      input.repoPath,
      ["merge-base", "--is-ancestor", head, input.headSha],
      { ...options, resultExitCodes: [1, 128] },
    );
    if (ancestor.exitCode !== 0) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  }
  // pageTake: one extra commit says whether there is another page.
  const limit = Math.min(Math.max(input.limit, 1), DOCUMENT_HISTORY_MAX);
  const take = pageTake(limit);
  const { stdout } = await runGitAsync(
    input.repoPath,
    [
      "--literal-pathspecs",
      "log",
      "--topo-order",
      // Across renames (a web move keeps the bytes, so it is always found),
      // with each commit's path: NUL-separated, never quoted.
      "--follow",
      // Tiny documents often share most of their front matter. Only identical
      // bytes establish a move; similarity alone is not document identity.
      "--find-renames=100%",
      "--name-status",
      "--diff-merges=first-parent",
      "-z",
      "--format=%x00%H %ct",
      // No --skip: git applies it before following renames. Reading from the
      // pinned head every time (bounded by DOCUMENT_HISTORY_MAX_OFFSET) also
      // keeps each row's tracked path right on later pages.
      `--max-count=${offset + take}`,
      head,
      "--",
      path,
    ],
    // Every row up to this page is read: size the buffer for that many
    // worst-case rows rather than the default (deep pages of renames).
    { ...options, maxBuffer: followedLogMaxBytes(offset + take) },
  );
  let followed = parseFollowedLog(String(stdout), path);
  const moves = followed.filter((commit) => commit.followedFrom !== undefined);
  if (moves.length) {
    // --follow can report even an exact copy as a rename. A move must remove
    // its source in this commit; otherwise this row is the new document's
    // creation and older source history belongs to a different document.
    // Check any object type: a retained source directory also is not a move.
    const { stdout: sources } = await runGitAsync(
      input.repoPath,
      ["cat-file", "--batch-check=%(objectname)"],
      { ...options, input: `${moves.map((row) => `${row.sha}:${row.followedFrom}`).join("\n")}\n` },
    );
    const objects = String(sources).split("\n");
    const copy = moves.find((_, index) => SHA1.test(objects[index] ?? ""));
    if (copy) followed = followed.slice(0, followed.indexOf(copy) + 1);
  }
  const commits = followed.slice(offset);
  const page = commits.slice(0, limit);
  const messages = await readCommitMessagesAsync(
    input.repoPath,
    page.map((commit) => commit.sha),
    options,
  );
  const markdownRows = page.filter((commit) => isMarkdownPath(commit.path));
  const blobs = markdownRows.length
    ? await batchCheckBlobs(
        input.repoPath,
        markdownRows.map((commit) => `${commit.sha}:${commit.path}`),
        options,
      )
    : new Map<string, { sha: string; size: number }>();
  const provenance = await readBlobProvenance(input.repoPath, [...blobs.values()], options);
  const actorKeys = page.flatMap((commit) => {
    const key = actorKeyOfMessage(messages.get(commit.sha) ?? "");
    return key ? [key] : [];
  });
  const actors = actorKeys.length
    ? await resolveActors(input.query, actorKeys)
    : new Map<string, ActorIdentity>();
  const items = page.map((commit): DocumentHistoryRow => {
    const message = messages.get(commit.sha) ?? "";
    const blob = blobs.get(`${commit.sha}:${commit.path}`);
    // Without a blob here the path was deleted by this commit (Markdown only).
    const deleted = isMarkdownPath(commit.path) && !blob;
    return {
      sha: commit.sha,
      path: commit.path,
      committedAt: commit.committedAt,
      subject: commitSubjectLine(message),
      provenance: blob ? (provenance.get(blob.sha) ?? null) : null,
      deleted,
      actor: historyActor(message, actors),
    };
  });
  const next = offset + page.length;
  return {
    items,
    nextCursor:
      commits.length > limit && next <= DOCUMENT_HISTORY_MAX_OFFSET
        ? encodeHistoryCursor(head, next)
        : null,
  };
}

export type PrFileAttribution = {
  beforeProvenance: DocumentProvenance | null;
  afterProvenance: DocumentProvenance | null;
  /** Who wrote the file's newest change in the PR range; null when unknown (not Markdown, or a long range). */
  writtenBy: HistoryActor | null;
};

/**
 * Per Markdown file of one PR diff page: its provenance before and after, and
 * the writer of the newest commit in `base..head` touching it, from one
 * bounded `git log` over the range (at most PR_WRITTEN_BY_MAX_COMMITS
 * commits, else no writer). Non-Markdown files get all nulls.
 */
export async function prFileAttribution(
  input: {
    repoPath: string;
    baseSha: string;
    headSha: string;
    files: readonly {
      path: string;
      beforeBlobSha: string | null;
      afterBlobSha: string | null;
    }[];
    query: LockQuery;
  } & GitReadOptions,
): Promise<Map<string, PrFileAttribution>> {
  const options = gitReadOptions(input);
  const out = new Map<string, PrFileAttribution>();
  const markdown = input.files.filter((file) => isMarkdownPath(file.path));
  if (markdown.length === 0) return out;
  if (!SHA1.test(input.baseSha) || !SHA1.test(input.headSha)) throw new Error("invalid commit sha");
  const blobShas = [
    ...new Set(
      markdown.flatMap((file) =>
        [file.beforeBlobSha, file.afterBlobSha].filter((sha): sha is string => sha !== null),
      ),
    ),
  ];
  if (blobShas.some((sha) => !SHA1.test(sha))) throw new Error("invalid blob sha");
  const sizes = await batchCheckBlobs(input.repoPath, blobShas, options);
  const provenance = await readBlobProvenance(input.repoPath, [...sizes.values()], options);
  const newest = await newestTouchingCommits(
    input.repoPath,
    input.baseSha,
    input.headSha,
    new Set(markdown.map((file) => file.path)),
    options,
  );
  const messages = newest
    ? await readCommitMessagesAsync(input.repoPath, [...new Set(newest.values())], options)
    : new Map<string, string>();
  const actorKeys = [...messages.values()].flatMap((message) => {
    const key = actorKeyOfMessage(message);
    return key ? [key] : [];
  });
  const actors = actorKeys.length
    ? await resolveActors(input.query, actorKeys)
    : new Map<string, ActorIdentity>();
  // A blob too large for this read's budget is unknown (null), never "absent".
  const label = (sha: string | null) => (sha === null ? null : (provenance.get(sha) ?? null));
  for (const file of markdown) {
    const commit = newest?.get(file.path);
    out.set(file.path, {
      beforeProvenance: label(file.beforeBlobSha),
      afterProvenance: label(file.afterBlobSha),
      writtenBy:
        newest === null
          ? null
          : commit
            ? historyActor(messages.get(commit) ?? "", actors)
            : // A path in the diff no commit in the range lists.
              null,
    });
  }
  return out;
}

/**
 * path → newest commit in base..head that lists it (`--name-only`, no
 * renames; a merge lists the paths that differ from all of its parents, as a
 * dense combined diff), for the wanted paths; null when the range is over the bound or
 * the listing does not fit.
 */
async function newestTouchingCommits(
  repoPath: string,
  baseSha: string,
  headSha: string,
  wanted: ReadonlySet<string>,
  options: GitReadOptions,
): Promise<Map<string, string> | null> {
  let stdout: string | Buffer;
  try {
    ({ stdout } = await runGitAsync(
      repoPath,
      [
        "log",
        "-z",
        "--no-renames",
        "--topo-order",
        "--name-only",
        // A merge (a PR moved onto main, a person's conflict resolution) lists
        // exactly the paths that differ from every parent: those it wrote.
        "--diff-merges=dense-combined",
        "--format=%x01%H",
        `--max-count=${PR_WRITTEN_BY_MAX_COMMITS + 1}`,
        `${baseSha}..${headSha}`,
      ],
      { ...options, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (error) {
    // Cancellation and deadlines stay errors; an oversized listing only loses the writer.
    if (error instanceof KbDomainError) throw error;
    return null;
  }
  const out = new Map<string, string>();
  let current: string | null = null;
  let count = 0;
  for (const raw of String(stdout).split("\0")) {
    const token = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (token.startsWith("\x01")) {
      current = token.slice(1);
      if (!SHA1.test(current)) return null;
      count += 1;
      if (count > PR_WRITTEN_BY_MAX_COMMITS) return null;
      continue;
    }
    if (current && token && wanted.has(token) && !out.has(token)) out.set(token, current);
  }
  return out;
}
