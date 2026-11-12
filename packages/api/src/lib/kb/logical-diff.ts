import { type GitReadOptions, readBlobContentAsync, runGitAsync } from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import { type LogicalConflict, MANIFEST_PATH } from "./logical-merge";
import { parseAssetManifest } from "./manifest";
import { KB_PATH_LIMITS } from "./paths";

/**
 * The typed logical diff of two commits, shared by proposal rebases and
 * the Git push hook: it only lists and reads, so the hook stays small.
 */

/** A recursive listing's most bytes for a tree within the limits. */
const DIFF_LISTING_MAX_BYTES = 2 * KB_TREE_LIMITS.maxEntries * (KB_PATH_LIMITS.maxBytes + 96);

/**
 * Every logical write between two commits, typed: documents by path, and a
 * manifest change expanded into the assets it adds, removes or replaces.
 */
export async function changedLogicalPaths(
  repoPath: string,
  from: string,
  to: string,
  options: GitReadOptions,
): Promise<LogicalConflict[]> {
  const base = from;
  const proposalHead = to;
  const { stdout } = await runGitAsync(
    repoPath,
    ["diff", "--no-renames", "--name-only", "-z", base, proposalHead],
    { ...options, maxBuffer: DIFF_LISTING_MAX_BYTES },
  );
  const physical = stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0);
  const documents = physical
    .filter((path) => path !== MANIFEST_PATH)
    .map((path): LogicalConflict => ({ path, kind: "document" }));
  if (!physical.includes(MANIFEST_PATH)) return documents;
  return [
    ...documents,
    ...(await changedAssetPaths(repoPath, base, proposalHead, options)).map(
      (path): LogicalConflict => ({ path, kind: "asset" }),
    ),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1));
}

/** Asset paths whose manifest entry differs between two commits (added, removed or replaced). */
async function changedAssetPaths(
  repoPath: string,
  from: string,
  to: string,
  options: GitReadOptions,
): Promise<string[]> {
  const entries = async (rev: string) => {
    const text = await blobAtPath(repoPath, rev, MANIFEST_PATH, options);
    const parsed = parseAssetManifest(Buffer.from(text ?? '{"version":1,"entries":[]}'));
    return new Map("code" in parsed ? [] : parsed.entries.map((entry) => [entry.path, entry]));
  };
  const [before, after] = [await entries(from), await entries(to)];
  const changed: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const [a, b] = [before.get(path), after.get(path)];
    if (!a || !b || a.hash !== b.hash || a.size !== b.size || a.mime !== b.mime) changed.push(path);
  }
  return changed.sort();
}

async function blobAtPath(
  repoPath: string,
  commit: string,
  path: string,
  options: GitReadOptions,
): Promise<string | null> {
  const { stdout } = await runGitAsync(repoPath, ["ls-tree", "-z", commit, "--", path], options);
  const entry = stdout.toString().split("\0")[0] ?? "";
  const match = /^100644 blob ([a-f0-9]{40})\t/.exec(entry);
  if (!match) return null;
  const bytes = await readBlobContentAsync(
    repoPath,
    match[1]!,
    { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
    options,
  );
  return bytes.toString("utf8");
}
