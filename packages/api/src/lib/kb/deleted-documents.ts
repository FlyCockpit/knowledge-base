import { pageTake } from "../pagination";
import { type ActorIdentity, parseServerAttribution, resolveActors } from "./actors";
import {
  batchCheckBlobs,
  type HistoryActor,
  historyActor,
  readCommitMessagesAsync,
} from "./document-history";
import { KbDomainError } from "./errors";
import { type GitReadOptions, gitReadOptions, runGitAsync } from "./git-read";
import type { LockQuery } from "./lock";
import { isKbNamespacePath, isMarkdownPath, normalizeKbPath } from "./paths";

/**
 * "Recently deleted": documents deleted on main in the last
 * `RECENTLY_DELETED_DAYS` days that main's head no longer has, newest
 * deletion first: the way back to a document whose own page is gone.
 * Browser-only display, like a document's history. It is a window, not all
 * of history: an older deletion is still found by its path (the document's
 * own page asks with `path`, which has no time window).
 *
 * The list comes from main's Git history: the commits on main's
 * first-parent line in the window (by commit time) that deleted a file,
 * newest first, at most `DELETED_SCAN_MAX_COMMITS` of them; `capped` says
 * that bound, or the row bound, cut the window short. A merge (a pull request landing, or one
 * moved onto newer main) counts by what it changed against its first parent.
 * A path appears once, at its latest deletion; one main has again is not
 * deleted. Paths are checked against the head in chunks and the rows (not
 * the paths seen) are capped, so documents recreated since never crowd out
 * one that is still deleted; at most `DELETED_CHECK_MAX` paths are checked.
 * `revision` is the deleting commit's first parent, where the document's
 * last version is read (and restored from). Pages rerun the same scan from
 * the head and window start pinned in the cursor
 * (`v2.<head>.<since>.<offset>`, `since` 0 for one path), so no row repeats.
 */

const SHA1 = /^[0-9a-f]{40}$/;
/** The window the list covers, stated in the UI and docs. */
const RECENTLY_DELETED_DAYS = 30;
const DAY_SECONDS = 86_400;
/** A list page's cursor: pinned head, window start (Unix seconds), offset. */
export const DELETED_DOCUMENTS_CURSOR =
  /^v2\.[0-9a-f]{40}\.(?:0|[1-9][0-9]{0,11})\.[1-9][0-9]{0,4}$/;
/** Deleting commits one scan reads (bounds the Git output, not the rows). */
const DELETED_SCAN_MAX_COMMITS = 1000;
/** Rows one scan collects; a page never resumes past this. */
const DELETED_ROWS_MAX = 2000;
/** Distinct deleted paths one scan checks against the head (bounded work). */
const DELETED_CHECK_MAX = 50_000;
const DELETED_CHECK_CHUNK = 2000;
const DELETED_PAGE_MAX = 50;
/** Name-only output of the scanned commits (paths are at most 512 bytes each). */
const DELETED_SCAN_MAX_BYTES = 32 * 1024 * 1024;

export type DeletedDocumentRow = {
  path: string;
  /** The commit that deleted it. */
  deletedSha: string;
  /** The deleting commit's first parent: the document's last version. */
  revision: string;
  /** ISO time, or null when the commit's own timestamp is out of range. */
  deletedAt: string | null;
  actor: HistoryActor;
};

type Deletion = Omit<DeletedDocumentRow, "actor">;

/**
 * One deleting commit per `\x1e<sha> <parents> <time>\0` header, its
 * deleted paths as NUL-terminated names after a newline. A header must match
 * exactly; names that are not valid KB Markdown document paths are skipped
 * (pushed trees are validated, so this only drops what no page could open).
 */
export function parseDeletionLog(stdout: string): Deletion[] {
  const out: Deletion[] = [];
  let current: { sha: string; parent: string; deletedAt: string | null } | null = null;
  for (const raw of stdout.split("\0")) {
    if (raw.startsWith("\x1e")) {
      const match = /^([0-9a-f]{40})((?: [0-9a-f]{40})*) (\d+)$/.exec(raw.slice(1));
      if (!match) throw new Error("invalid deletion log header");
      const parents = (match[2] ?? "").trim().split(" ").filter(Boolean);
      const at = new Date(Number(match[3]) * 1000);
      // A merge is diffed against its first parent; a root deletes nothing.
      current =
        parents.length >= 1
          ? {
              sha: match[1]!,
              parent: parents[0]!,
              deletedAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
            }
          : null;
      continue;
    }
    const name = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (!current || name.length === 0) continue;
    const normalized = normalizeKbPath(name);
    if (!normalized.ok || normalized.path !== name) continue;
    if (!isMarkdownPath(name) || isKbNamespacePath(name)) continue;
    out.push({
      path: name,
      deletedSha: current.sha,
      revision: current.parent,
      deletedAt: current.deletedAt,
    });
  }
  return out;
}

/**
 * The newest deletion of each path the head no longer has, newest first:
 * `present` answers which of a chunk of paths the head has. Stops once
 * `rowsMax` rows are found or `checkMax` paths were checked.
 */
export async function selectDeleted(
  deletions: readonly Deletion[],
  present: (paths: string[]) => Promise<Set<string>>,
  limits: { rowsMax: number; checkMax: number; chunk: number } = {
    rowsMax: DELETED_ROWS_MAX,
    checkMax: DELETED_CHECK_MAX,
    chunk: DELETED_CHECK_CHUNK,
  },
): Promise<Deletion[]> {
  const seen = new Set<string>();
  const latest: Deletion[] = [];
  for (const deletion of deletions) {
    if (seen.has(deletion.path)) continue;
    seen.add(deletion.path);
    latest.push(deletion);
    if (latest.length >= limits.checkMax) break;
  }
  const rows: Deletion[] = [];
  for (
    let start = 0;
    start < latest.length && rows.length < limits.rowsMax;
    start += limits.chunk
  ) {
    const chunk = latest.slice(start, start + limits.chunk);
    const has = await present(chunk.map((row) => row.path));
    for (const row of chunk) {
      if (!has.has(row.path)) rows.push(row);
      if (rows.length >= limits.rowsMax) break;
    }
  }
  return rows;
}

function decodeCursor(
  cursor: string,
  windowStart: number | null,
): { head: string; since: number; offset: number } {
  if (!DELETED_DOCUMENTS_CURSOR.test(cursor))
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const [, head = "", sinceText = "", offsetText = ""] = cursor.split(".");
  const since = Number(sinceText);
  const offset = Number(offsetText);
  if (!Number.isSafeInteger(offset) || offset < 1 || offset >= DELETED_ROWS_MAX)
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  // One path has no window (0). A list cursor keeps its window start for a
  // day at most, so a page never reaches further back than the window says.
  const valid =
    windowStart === null
      ? since === 0
      : since >= windowStart - DAY_SECONDS && since <= windowStart + DAY_SECONDS;
  if (!valid) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  return { head, since, offset };
}

export async function readDeletedDocuments(
  input: {
    repoPath: string;
    headSha: string;
    cursor: string | null;
    limit: number;
    query: LockQuery;
    /**
     * One document's deletion only (its own page): the same scan, so a
     * page and the list agree on when it was deleted and where its last
     * version is, merges included.
     */
    path?: string;
    /** Now, in milliseconds (tests). */
    now?: number;
  } & GitReadOptions,
): Promise<{
  items: DeletedDocumentRow[];
  nextCursor: string | null;
  /** The list's window in days; null for one path, which has none. */
  windowDays: number | null;
  /** The scan's bounds ended the list before the window's start. */
  capped: boolean;
}> {
  const options = gitReadOptions(input);
  let only: string | null = null;
  if (input.path !== undefined) {
    const normalized = normalizeKbPath(input.path);
    if (!normalized.ok) throw new KbDomainError("INVALID_ARGUMENT", "Invalid path");
    only = normalized.path;
  }
  if (!SHA1.test(input.headSha)) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  const windowStart =
    only === null
      ? Math.floor((input.now ?? Date.now()) / 1000) - RECENTLY_DELETED_DAYS * DAY_SECONDS
      : null;
  let head = input.headSha;
  let since = windowStart ?? 0;
  let offset = 0;
  if (input.cursor !== null) {
    ({ head, since, offset } = decodeCursor(input.cursor, windowStart));
    const ancestor = await runGitAsync(
      input.repoPath,
      ["merge-base", "--is-ancestor", head, input.headSha],
      { ...options, resultExitCodes: [1, 128] },
    );
    if (ancestor.exitCode !== 0) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  }
  const { stdout } = await runGitAsync(
    input.repoPath,
    [
      "log",
      "--first-parent",
      "--diff-merges=first-parent",
      "--no-renames",
      "--diff-filter=D",
      "--name-only",
      "-z",
      "--format=%x1e%H %P %ct",
      `--max-count=${DELETED_SCAN_MAX_COMMITS}`,
      // A filter, not a walk limit: `--since` stops at the first older
      // commit, and commit times on main need not be in order.
      ...(since > 0 ? [`--since-as-filter=@${since}`] : []),
      head,
      "--",
      // Exactly this path: never a glob.
      ...(only !== null ? [`:(literal)${only}`] : []),
    ],
    { ...options, maxBuffer: DELETED_SCAN_MAX_BYTES },
  );
  const log = String(stdout);
  const scanned = log.split("\x1e").length - 1;
  // Exactly the window (and a header without a time is outside it).
  const inWindow = parseDeletionLog(log).filter(
    (row) => since === 0 || (row.deletedAt !== null && Date.parse(row.deletedAt) >= since * 1000),
  );
  // Newest deletion of each path; only paths the pinned head lacks.
  const rows = await selectDeleted(inWindow, async (paths) => {
    const found = await batchCheckBlobs(
      input.repoPath,
      paths.map((path) => `${head}:${path}`),
      options,
    );
    return new Set(paths.filter((path) => found.has(`${head}:${path}`)));
  });
  const limit = Math.min(Math.max(input.limit, 1), DELETED_PAGE_MAX);
  // pageTake: one extra row says whether there is another page.
  const window = rows.slice(offset, offset + pageTake(limit));
  const page = window.slice(0, limit);
  const messages = await readCommitMessagesAsync(
    input.repoPath,
    page.map((row) => row.deletedSha),
    options,
  );
  const actorKeys = page.flatMap((row) => {
    const key = parseServerAttribution(messages.get(row.deletedSha) ?? "")?.actorKey;
    return key ? [key] : [];
  });
  const actors = actorKeys.length
    ? await resolveActors(input.query, actorKeys)
    : new Map<string, ActorIdentity>();
  const next = offset + page.length;
  return {
    items: page.map((row) => ({
      ...row,
      actor: historyActor(messages.get(row.deletedSha) ?? "", actors),
    })),
    nextCursor:
      window.length > limit && next < DELETED_ROWS_MAX ? `v2.${head}.${since}.${next}` : null,
    windowDays: only === null ? RECENTLY_DELETED_DAYS : null,
    capped: scanned >= DELETED_SCAN_MAX_COMMITS || rows.length >= DELETED_ROWS_MAX,
  };
}
