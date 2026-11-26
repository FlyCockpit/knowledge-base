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
 * first-parent line that deleted or (exactly) renamed a file, newest first,
 * at most `DELETED_SCAN_MAX_COMMITS` of them; deletions in the window (by
 * commit time) are listed unless renamed away later; `capped` says that
 * bound or the row bound was reached, so the window may be incomplete. A merge (a pull request landing, or one
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
/** Name-status output of the scanned commits (paths are at most 512 bytes each). */
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

type Deletion = Omit<DeletedDocumentRow, "actor"> & {
  /** The path was renamed away here (an exact move), not deleted. */
  moved?: true;
};

/**
 * Whether the commit that removed `row.path` moved it: the same bytes added
 * under another name in that commit (an exact rename, what a web move makes).
 */
async function movedAway(
  repoPath: string,
  row: Pick<Deletion, "path" | "deletedSha" | "revision">,
  options: GitReadOptions,
): Promise<boolean> {
  const { stdout } = await runGitAsync(
    repoPath,
    [
      "diff-tree",
      "-r",
      "-z",
      "--find-renames=100%",
      "--diff-filter=R",
      "--name-status",
      row.revision,
      row.deletedSha,
    ],
    options,
  );
  // `R100\0<old>\0<new>\0` per rename.
  const parts = String(stdout).split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) if (parts[i + 1] === row.path) return true;
  return false;
}

/**
 * Whether the list may be incomplete: the scan reached its commit bound or
 * the row bound. Conservative on purpose: commit times on main need not be in
 * order, so no timestamp seen proves the window was exhausted.
 */
export function deletedScanCapped(scannedCommits: number, rows: number): boolean {
  return scannedCommits >= DELETED_SCAN_MAX_COMMITS || rows >= DELETED_ROWS_MAX;
}

/**
 * One deleting commit per `\x1e<sha> <parents> <time>\0` header, its
 * deleted paths as NUL-terminated names after a newline. A header must match
 * exactly; names that are not valid KB Markdown document paths are skipped
 * (pushed trees are validated, so this only drops what no page could open).
 */
export function parseDeletionLog(stdout: string): Deletion[] {
  const out: Deletion[] = [];
  let current: { sha: string; parent: string; deletedAt: string | null } | null = null;
  const tokens = stdout.split("\0");
  const keep = (name: string) => {
    const normalized = normalizeKbPath(name);
    return (
      normalized.ok && normalized.path === name && isMarkdownPath(name) && !isKbNamespacePath(name)
    );
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i]!;
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
    // `--name-status -z`: `D\0<path>\0`, or `R<score>\0<old>\0<new>\0` for an
    // exact rename (the list scan detects those).
    const status = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (status.length === 0) continue;
    if (status.startsWith("R")) {
      const from = tokens[i + 1] ?? "";
      i += 2;
      if (current && from && keep(from))
        out.push({
          path: from,
          deletedSha: current.sha,
          revision: current.parent,
          deletedAt: current.deletedAt,
          moved: true,
        });
      continue;
    }
    if (status !== "D") continue;
    const name = tokens[i + 1] ?? "";
    i += 1;
    if (!current || name.length === 0 || !keep(name)) continue;
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
    // Renamed away after any earlier deletion: the document lives on.
    if (deletion.moved) continue;
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
      // A web rename/move keeps the bytes: exact (100%) renames are not
      // deletions. One path's scan is limited to that path, so git can't pair
      // it with its new name there; `movedAway` checks that row instead.
      ...(only === null
        ? ["--find-renames=100%", "--diff-filter=DR"]
        : ["--no-renames", "--diff-filter=D"]),
      "--name-status",
      "-z",
      "--format=%x1e%H %P %ct",
      `--max-count=${DELETED_SCAN_MAX_COMMITS}`,
      // No time filter in git: the window applies to deletions below, while a
      // later rename-away counts whatever its commit time (times on main need
      // not be in order), so it always hides the older deletion.
      head,
      "--",
      // Exactly this path: never a glob.
      ...(only !== null ? [`:(literal)${only}`] : []),
    ],
    { ...options, maxBuffer: DELETED_SCAN_MAX_BYTES },
  );
  const log = String(stdout);
  const scanned = log.split("\x1e").length - 1;
  // Each path's newest event first, at any commit time (times on main need
  // not be in order); then the window, on that event only: a path whose
  // newest event is a rename-away, or a deletion outside the window (a header
  // without a time is outside it), is not listed.
  const newest = new Map<string, Deletion>();
  for (const row of parseDeletionLog(log)) if (!newest.has(row.path)) newest.set(row.path, row);
  const inWindow = [...newest.values()].filter(
    (row) =>
      !row.moved &&
      (since === 0 || (row.deletedAt !== null && Date.parse(row.deletedAt) >= since * 1000)),
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
  // One path whose newest "deletion" was a move to another name is not deleted.
  if (only !== null && rows[0] && (await movedAway(input.repoPath, rows[0], options)))
    rows.length = 0;
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
    capped: deletedScanCapped(scanned, rows.length),
  };
}
