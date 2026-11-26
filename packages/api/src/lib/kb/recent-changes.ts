import { pageTake } from "../pagination";
import { type ActorIdentity, parseServerAttribution, resolveActors } from "./actors";
import {
  commitSubjectLine,
  DOCUMENT_HISTORY_CURSOR,
  historyActor,
  readCommitMessagesAsync,
} from "./document-history";
import { KbDomainError } from "./errors";
import { type GitReadOptions, gitReadOptions, runGitAsync } from "./git-read";
import type { LockQuery } from "./lock";
import { isKbNamespacePath, isMarkdownPath, normalizeKbPath } from "./paths";

/**
 * Browser-only "recently changed" feed of a KB: main's first-parent
 * history, newest first, limited to commits that touch Markdown documents,
 * each with who made it and the documents it changed. Attribution is the
 * same trusted server trailer block as a document's history
 * (`historyActor`): a person in the web app is "human", a PAT or OAuth app
 * (an MCP client or agent) is "agent", and anything else (a Git push, an
 * older commit) is "unknown". Pages rerun the same log from the head pinned
 * in the cursor (`v1.<head>.<offset>`), so no row repeats.
 */

const SHA1 = /^[0-9a-f]{40}$/;
const RECENT_PAGE_MAX = 50;
/** The deepest commit a cursor may resume at. */
const RECENT_CHANGES_MAX_OFFSET = 2000;
/** Paths listed per commit; the rest are only counted. */
const RECENT_CHANGE_PATHS_MAX = 50;
/** One commit's name-status output; a larger import lists no paths. */
const DIFF_TREE_MAX_BYTES = 4 * 1024 * 1024;

type RecentChangeKind = "added" | "modified" | "deleted" | "renamed";

export type RecentChangePath = { path: string; change: RecentChangeKind; from?: string };

type RecentChangeActor = {
  kind: "human" | "agent" | "unknown";
  /** The person, when known. */
  label: string | null;
  /** The token or app name of an agent credential (display only). */
  via: string | null;
};

export type RecentChangeRow = {
  sha: string;
  /** ISO time, or null when the commit's own timestamp is out of range. */
  at: string | null;
  subject: string;
  actor: RecentChangeActor;
  paths: RecentChangePath[];
  /** Documents changed beyond `paths` (0 when all are listed). */
  morePaths: number;
  /** The change list was too large to read: `paths` is empty, not "none". */
  pathsUnknown: boolean;
};

/** A path a page can open: a normalized Markdown document outside the KB namespace. */
function isDocumentPath(path: string): boolean {
  const normalized = normalizeKbPath(path);
  return (
    normalized.ok && normalized.path === path && isMarkdownPath(path) && !isKbNamespacePath(path)
  );
}

/**
 * `git diff-tree -r -z -M --name-status` output: `<status>\0<path>\0`, or
 * `R<score>\0<from>\0<to>\0` / `C<score>\0<from>\0<to>\0`. Only document
 * paths are kept; a rename from a non-document is an add, one to a
 * non-document a delete.
 */
export function parseNameStatus(stdout: string): RecentChangePath[] {
  const tokens = stdout.split("\0");
  const out: RecentChangePath[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = (tokens[i++] ?? "").replace(/^\n/, "");
    if (status === "") continue;
    if (!/^[ACDMRTUX]\d*$/.test(status)) throw new Error("invalid name-status record");
    if (status[0] === "R" || status[0] === "C") {
      const from = tokens[i++] ?? "";
      const to = tokens[i++] ?? "";
      if (!from || !to) throw new Error("invalid name-status record");
      const fromDoc = isDocumentPath(from);
      const toDoc = isDocumentPath(to);
      if (status[0] === "C") {
        if (toDoc) out.push({ path: to, change: "added" });
      } else if (fromDoc && toDoc) out.push({ path: to, change: "renamed", from });
      else if (toDoc) out.push({ path: to, change: "added" });
      else if (fromDoc) out.push({ path: from, change: "deleted" });
      continue;
    }
    const path = tokens[i++] ?? "";
    if (!path) throw new Error("invalid name-status record");
    if (!isDocumentPath(path)) continue;
    out.push({
      path,
      change: status[0] === "A" ? "added" : status[0] === "D" ? "deleted" : "modified",
    });
  }
  return out;
}

function decodeCursor(cursor: string): { head: string; offset: number } {
  if (!DOCUMENT_HISTORY_CURSOR.test(cursor))
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  const [, head = "", offsetText = ""] = cursor.split(".");
  const offset = Number(offsetText);
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > RECENT_CHANGES_MAX_OFFSET)
    throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  return { head, offset };
}

function agentKind(kind: "web" | "credential" | "unattributed"): RecentChangeActor["kind"] {
  return kind === "web" ? "human" : kind === "credential" ? "agent" : "unknown";
}

async function changedDocuments(
  repoPath: string,
  sha: string,
  parent: string | null,
  options: GitReadOptions,
): Promise<{ paths: RecentChangePath[]; unknown: boolean }> {
  try {
    const { stdout } = await runGitAsync(
      repoPath,
      [
        "diff-tree",
        "-r",
        "-z",
        "-M",
        "--no-commit-id",
        "--name-status",
        ...(parent ? [parent, sha] : ["--root", sha]),
      ],
      { ...options, maxBuffer: DIFF_TREE_MAX_BYTES },
    );
    return { paths: parseNameStatus(String(stdout)), unknown: false };
  } catch (error) {
    // Cancellation and deadlines stay errors; an oversized listing only loses its paths.
    if (error instanceof KbDomainError) throw error;
    return { paths: [], unknown: true };
  }
}

export async function readRecentChanges(
  input: {
    repoPath: string;
    headSha: string;
    cursor: string | null;
    limit: number;
    query: LockQuery;
  } & GitReadOptions,
): Promise<{ items: RecentChangeRow[]; nextCursor: string | null }> {
  const options = gitReadOptions(input);
  if (!SHA1.test(input.headSha)) throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
  let head = input.headSha;
  let offset = 0;
  if (input.cursor !== null) {
    ({ head, offset } = decodeCursor(input.cursor));
    const ancestor = await runGitAsync(
      input.repoPath,
      ["merge-base", "--is-ancestor", head, input.headSha],
      { ...options, resultExitCodes: [1, 128] },
    );
    if (ancestor.exitCode !== 0) throw new KbDomainError("INVALID_CURSOR", "Invalid cursor");
  }
  const limit = Math.min(Math.max(input.limit, 1), RECENT_PAGE_MAX);
  // pageTake: one extra commit says whether there is another page.
  const { stdout } = await runGitAsync(
    input.repoPath,
    [
      "log",
      "--first-parent",
      "--format=%H%x09%P%x09%ct",
      `--skip=${offset}`,
      `--max-count=${pageTake(limit)}`,
      head,
      "--",
      ":(glob)**/*.md",
    ],
    options,
  );
  const commits = String(stdout)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // A root commit has no parents: the middle field is empty.
      const match = /^([0-9a-f]{40})\t((?:[0-9a-f]{40}(?: [0-9a-f]{40})*)?)\t(\d+)$/.exec(line);
      if (!match) throw new Error("invalid log line");
      const parents = (match[2] ?? "").trim().split(" ").filter(Boolean);
      const at = new Date(Number(match[3]) * 1000);
      return {
        sha: match[1]!,
        parent: parents[0] ?? null,
        at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
      };
    });
  const page = commits.slice(0, limit);
  const messages = await readCommitMessagesAsync(
    input.repoPath,
    page.map((commit) => commit.sha),
    options,
  );
  const actorKeys = page.flatMap((commit) => {
    const key = parseServerAttribution(messages.get(commit.sha) ?? "")?.actorKey;
    return key ? [key] : [];
  });
  const actors = actorKeys.length
    ? await resolveActors(input.query, actorKeys)
    : new Map<string, ActorIdentity>();
  const items: RecentChangeRow[] = [];
  for (const commit of page) {
    const changed = await changedDocuments(input.repoPath, commit.sha, commit.parent, options);
    // Only namespace or non-normalized Markdown changed: nothing a page can open.
    if (!changed.unknown && changed.paths.length === 0) continue;
    const message = messages.get(commit.sha) ?? "";
    const actor = historyActor(message, actors);
    items.push({
      sha: commit.sha,
      at: commit.at,
      subject: commitSubjectLine(message),
      actor: { kind: agentKind(actor.kind), label: actor.name, via: actor.via },
      paths: changed.paths.slice(0, RECENT_CHANGE_PATHS_MAX),
      morePaths: Math.max(0, changed.paths.length - RECENT_CHANGE_PATHS_MAX),
      pathsUnknown: changed.unknown,
    });
  }
  const next = offset + page.length;
  return {
    items,
    nextCursor:
      commits.length > limit && next <= RECENT_CHANGES_MAX_OFFSET ? `v1.${head}.${next}` : null,
  };
}
