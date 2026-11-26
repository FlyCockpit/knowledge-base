import { markdownIssueReason, pathIssueReason } from "./argument-reasons";
import { moveChangesAssetLinks, resolveMarkdownAssetReferences } from "./documents-read";
import { type GitReadOptions, listTreeBlobsAsync, readBlobsAsync } from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import { type AssetManifestEntry, canonicalManifestBytes, parseAssetManifest } from "./manifest";
import {
  parseMarkdownDocument,
  sameExceptProvenanceLine,
  stampProvenance,
  validateMarkdownBytes,
} from "./parse-markdown";
import { isKbNamespacePath, isMarkdownPath, normalizeKbPath } from "./paths";
import type { ApplyWarning } from "./protocol/common";
import type { KbInvalidArgumentReason } from "./protocol/envelope";
import type { TreeFileInput } from "./staged-tree";
export type PlannedChange =
  | { op: "create"; path: string; content: { markdown: string } }
  | { op: "replace"; path: string; content: { markdown: string } }
  | { op: "delete"; path: string }
  /**
   * Browser-only rename/move of one document (`DOCUMENT_MOVE`): the same bytes
   * at `toPath`, gone from `path`, in one commit. Never a kb/1 protocol op.
   */
  | { op: "move"; path: string; toPath: string }
  | { op: "assetPut"; path: string; uploadId: string }
  | { op: "assetRemove"; path: string };

/**
 * A move to another folder that would change what one of the document's
 * relative image links resolves to. Browser-only, like the move itself.
 */
export const MOVE_BREAKS_ASSET_LINKS = "MOVE_BREAKS_ASSET_LINKS";

/** Why planning refused a change, and which change/field it names. */
export type PlanFailure = {
  ok: false;
  message: string;
  reason: KbInvalidArgumentReason | "PATH_EXISTS" | typeof MOVE_BREAKS_ASSET_LINKS;
  changeIndex?: number;
  key?: "path" | "content" | "toPath";
};

export type PlannedPublication =
  | PlanFailure
  | {
      ok: true;
      noop: boolean;
      changedPaths: string[];
      files: TreeFileInput[];
      warnings: ApplyWarning[];
    };

function pathToSegments(path: string): string[] {
  return path.split("/");
}

export async function walkGitTreeAtCommit(input: {
  repoPath: string;
  baseRevision: string;
  changes: PlannedChange[];
  assetEntries?: ReadonlyMap<string, AssetManifestEntry>;
  /**
   * Start from these files instead of `baseRevision`'s tree: a proposal
   * rebased onto main starts from the merged tree. Always yields a
   * commit, since moving the proposal is itself the change.
   */
  baseFiles?: ReadonlyMap<string, Buffer>;
  /**
   * Paths a rebase reported as conflicts. Each resolution is valid on
   * them whatever the merged tree holds: delete or assetRemove takes either
   * side's deletion, create/replace/assetPut writes the chosen version.
   */
  resolving?: { documents: ReadonlySet<string>; assets: ReadonlySet<string> };
  /** The publication's cancellation and deadline (reads never block the lock). */
  gitOptions?: GitReadOptions;
  /**
   * The provenance the server stamps on every document this publication
   * writes (create/replace): `agent` for a credential's edit, `human` for a
   * person's web edit. Absent: written as given (dreams serialize their own).
   */
  stamp?: "agent" | "human";
}): Promise<PlannedPublication> {
  // Typed: an asset op never resolves a document conflict, nor the reverse.
  const resolvingDocuments = input.resolving?.documents ?? new Set<string>();
  const resolvingAssets = input.resolving?.assets ?? new Set<string>();
  const files = new Map<string, Buffer>(input.baseFiles ?? []);
  if (!input.baseFiles) {
    // One listing and one batched read for the whole tree, both cancellable.
    const options = input.gitOptions ?? {};
    const blobs = await listTreeBlobsAsync(input.repoPath, input.baseRevision, options);
    if (blobs.length > KB_TREE_LIMITS.maxEntries)
      return { ok: false, message: "tree exceeds entry budget", reason: "TOO_LARGE" };
    const bodies = await readBlobsAsync(
      input.repoPath,
      blobs.map((blob) => blob.sha),
      { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes, totalMaxBytes: KB_TREE_LIMITS.maxTreeBytes },
      options,
    );
    for (const blob of blobs) files.set(blob.path, bodies.get(blob.sha)!);
  }

  const parsed = parseAssetManifest(files.get(".assets/manifest.json") ?? Buffer.alloc(0));
  if ("code" in parsed) return { ok: false, message: parsed.message, reason: "SCHEMA" };
  const assets = new Map(parsed.entries.map((entry) => [entry.path, entry]));
  for (const [path, entry] of input.assetEntries ?? []) assets.set(path, entry);
  const changedPaths: string[] = [...(input.assetEntries?.keys() ?? [])];
  const removedAssets: string[] = [];
  const stamp = input.stamp;
  /** The bytes to write, stamped when the publication stamps. */
  const stamped = (bytes: Buffer): Buffer | { message: string } => {
    if (!stamp) return bytes;
    const result = stampProvenance(bytes, stamp);
    return result.ok ? result.bytes : { message: result.message };
  };
  /**
   * Write a document's given bytes over whatever the tree holds at `path`.
   * A rewrite equal to the stored document, or differing from it only by
   * provenance lines (`sameExceptProvenanceLine`), is no change and the
   * stored blob is kept: re-saving never relabels (or unprotects) a document,
   * through a requoted label or an escaped key alike. A resolution still
   * counts as resolved below. Returns the stamp's refusal, if any.
   */
  const write = (path: string, given: Buffer): string | null => {
    const prior = files.get(path);
    if (prior && (prior.equals(given) || (stamp && sameExceptProvenanceLine(prior, given))))
      return null;
    const next = stamped(given);
    if (!Buffer.isBuffer(next)) return next.message;
    if (!prior?.equals(next)) {
      files.set(path, next);
      changedPaths.push(path);
    }
    return null;
  };
  for (const [changeIndex, change] of input.changes.entries()) {
    const at = (
      message: string,
      reason: PlanFailure["reason"],
      key: NonNullable<PlanFailure["key"]> = "path",
    ): PlanFailure => ({ ok: false, message, reason, changeIndex, key });
    if (change.op === "assetPut" || change.op === "assetRemove") {
      if (change.op === "assetRemove") {
        if (!assets.delete(change.path) && !resolvingAssets.has(change.path))
          return at("asset path does not exist", "PATH_NOT_FOUND");
        changedPaths.push(change.path);
        removedAssets.push(change.path);
      } else if (!input.assetEntries?.has(change.path))
        return at("asset upload not resolved", "SCHEMA");
      continue;
    }
    const norm = normalizeKbPath(change.path);
    if (!norm.ok) return at(norm.issue.message, pathIssueReason(norm.issue.code));
    const path = norm.path;
    // A document can't live in the KB's own namespace, even with a `.md` name.
    if (isKbNamespacePath(path))
      return at("path is reserved for the knowledge base", "RESERVED_PATH");
    if (!isMarkdownPath(path)) {
      return at("only markdown document paths are supported", "NOT_MARKDOWN_PATH");
    }
    const exists = files.has(path);
    const resolves = resolvingDocuments.has(path);
    if (change.op === "create") {
      if (exists && !resolves) return at(`path already exists: ${path}`, "PATH_EXISTS");
      const content = change.content;
      const markdown = "markdown" in content ? content.markdown : "";
      const issue = validateMarkdownBytes(Buffer.from(markdown, "utf8"));
      if (issue) return at(issue.message, markdownIssueReason(issue.code), "content");
      const parsed = parseMarkdownDocument(Buffer.from(markdown, "utf8"));
      if ("code" in parsed) return at(parsed.message, markdownIssueReason(parsed.code), "content");
      // A create resolving a recorded conflict over an existing path is a
      // write over that document: the same provenance-only noop rule applies.
      const failure = write(path, Buffer.from(markdown, "utf8"));
      if (failure) return at(failure, "SCHEMA", "content");
      continue;
    }
    if (change.op === "move") {
      const moved = moveDocument(files, assets, path, change.toPath);
      if (!moved.ok) return at(moved.message, moved.reason, moved.key);
      changedPaths.push(path, moved.toPath);
      continue;
    }
    if (change.op === "delete") {
      if (!exists && !resolves) return at(`path does not exist: ${path}`, "PATH_NOT_FOUND");
      files.delete(path);
      changedPaths.push(path);
      continue;
    }
    if (!exists && !resolves) return at(`path does not exist: ${path}`, "PATH_NOT_FOUND");
    const markdown = "markdown" in change.content ? change.content.markdown : "";
    const issue = validateMarkdownBytes(Buffer.from(markdown, "utf8"));
    if (issue) return at(issue.message, markdownIssueReason(issue.code), "content");
    const parsed = parseMarkdownDocument(Buffer.from(markdown, "utf8"));
    if ("code" in parsed) return at(parsed.message, markdownIssueReason(parsed.code), "content");
    const failure = write(path, Buffer.from(markdown, "utf8"));
    if (failure) return at(failure, "SCHEMA", "content");
  }

  const manifest = canonicalManifestBytes({ version: 1, entries: [...assets.values()] });
  files.set(".assets/manifest.json", manifest);
  // Resolving a recorded conflict is a change even when the chosen version
  // equals what the PR already holds ("keep mine"): the conflict is gone.
  for (const path of [...resolvingDocuments, ...resolvingAssets])
    if (!changedPaths.includes(path)) changedPaths.push(path);
  if (changedPaths.length === 0 && !input.baseFiles) {
    return { ok: true, noop: true, changedPaths: [], files: [], warnings: [] };
  }

  const treeFiles: TreeFileInput[] = [];
  for (const [path, bytes] of files) {
    treeFiles.push({ segments: pathToSegments(path), content: bytes });
  }
  // Required KB layout files must remain present.
  for (const required of [".gitignore", ".assets/manifest.json"]) {
    if (!files.has(required)) {
      return { ok: false, message: `required path missing: ${required}`, reason: "SCHEMA" };
    }
  }

  return {
    ok: true,
    noop: false,
    changedPaths,
    files: treeFiles,
    warnings: danglingAssetLinks(files, removedAssets),
  };
}

type MoveFailure = Omit<PlanFailure, "changeIndex">;

/**
 * Move one document within `files`: the stored bytes, unchanged, from `from`
 * (already normalized and checked as a document path) to `toPath`, which gets
 * the same path rules as a create. No provenance stamp: a move is not an
 * edit, so an agent's document stays an agent's.
 *
 * Relative image links resolve against the document's folder. A move to
 * another folder that would make a link that reaches an asset today point
 * somewhere else is refused (`MOVE_BREAKS_ASSET_LINKS`) rather than
 * committed: rewriting the person's Markdown silently is not ours to do, and
 * a warning after the commit would leave broken images behind. Root-relative
 * links (`/assets/…`, what the editor inserts) and renames within the same
 * folder never trigger it; links that already reach nothing are not checked.
 */
function moveDocument(
  files: Map<string, Buffer>,
  assets: ReadonlyMap<string, AssetManifestEntry>,
  from: string,
  toPath: string,
): { ok: true; toPath: string } | MoveFailure {
  const fail = (
    message: string,
    reason: PlanFailure["reason"],
    key: NonNullable<PlanFailure["key"]> = "toPath",
  ): MoveFailure => ({ ok: false, message, reason, key });
  const norm = normalizeKbPath(toPath);
  if (!norm.ok) return fail(norm.issue.message, pathIssueReason(norm.issue.code));
  const to = norm.path;
  if (isKbNamespacePath(to))
    return fail("path is reserved for the knowledge base", "RESERVED_PATH");
  if (!isMarkdownPath(to))
    return fail("only markdown document paths are supported", "NOT_MARKDOWN_PATH");
  if (to === from) return fail("the document is already at this path", "INVALID_PATH");
  const bytes = files.get(from);
  if (!bytes) return fail(`path does not exist: ${from}`, "PATH_NOT_FOUND", "path");
  if (files.has(to)) return fail(`path already exists: ${to}`, "PATH_EXISTS");
  const parsed = parseMarkdownDocument(bytes);
  if ("body" in parsed && moveChangesAssetLinks(parsed.body, from, to, (path) => assets.has(path)))
    return fail(
      "the document links images by a path relative to its folder",
      MOVE_BREAKS_ASSET_LINKS,
    );
  files.delete(from);
  files.set(to, bytes);
  return { ok: true, toPath: to };
}

/** Documents of the resulting tree that still link to a removed asset. */
export function danglingAssetLinks(
  files: ReadonlyMap<string, Buffer>,
  removed: string[],
): ApplyWarning[] {
  if (removed.length === 0) return [];
  const referencedBy = new Map<string, string[]>(removed.map((path) => [path, []]));
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isMarkdownPath(path)) continue;
    const parsed = parseMarkdownDocument(bytes);
    if (!("body" in parsed)) continue;
    for (const target of resolveMarkdownAssetReferences(parsed.body, path)) {
      const list = referencedBy.get(target);
      if (list && list.length < 20) list.push(path);
    }
  }
  return [...referencedBy]
    .filter(([, list]) => list.length > 0)
    .map(([path, list]) => ({ code: "ASSET_STILL_REFERENCED" as const, path, referencedBy: list }));
}
