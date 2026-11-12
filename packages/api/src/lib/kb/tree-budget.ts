import { KB_TREE_LIMITS } from "./limits";
import { type AssetManifestEntry, KB_MANIFEST_MAX_ENTRIES } from "./manifest";

/**
 * One accounting of a KB tree against its budgets, shared by whole-tree
 * validation and the logical merge, so the two can never disagree on
 * what counts: the root tree, every directory, every file (the managed
 * `.gitignore` and the manifest included), and the manifest's own bytes.
 */
export type TreeTotals = {
  /** Tree entries as the validator's walk charges them: the root, each directory, each file. */
  entries: number;
  files: number;
  /** Bytes of every file, the manifest included. */
  treeBytes: number;
  manifestEntries: number;
  manifestBytes: number;
};

/** The walk charges the root tree and every directory and file once. */
export function treeEntryCount(files: number, directories: number): number {
  return 1 + directories + files;
}

/** Canonical manifest bytes: `{"version":1,"entries":[…]}\n` with comma-separated entries. */
const MANIFEST_FIXED_BYTES = Buffer.byteLength('{"version":1,"entries":[]}\n');
export function manifestEntryBytes(entry: AssetManifestEntry): number {
  return Buffer.byteLength(
    JSON.stringify({ path: entry.path, hash: entry.hash, size: entry.size, mime: entry.mime }),
  );
}
export function manifestByteLength(entryBytes: number, entries: number): number {
  return MANIFEST_FIXED_BYTES + entryBytes + Math.max(0, entries - 1);
}

/**
 * The most logical writes one change between two trees within the limits can
 * make: every document removed and as many added (files), every asset entry
 * removed and as many added (manifest entries). Logical counts are bounded by
 * logical limits, never by the physical tree-entry count.
 */
export const KB_MAX_LOGICAL_CHANGES = 2 * (KB_TREE_LIMITS.maxFiles + KB_MANIFEST_MAX_ENTRIES);

export type TreeLimit = "assets" | "manifest" | "files" | "entries" | "bytes";

/** The first budget a tree exceeds, in a fixed order; null when it fits them all. */
export function exceededTreeLimit(totals: TreeTotals): TreeLimit | null {
  if (totals.manifestEntries > KB_MANIFEST_MAX_ENTRIES) return "assets";
  if (totals.manifestBytes > KB_TREE_LIMITS.maxMarkdownBytes) return "manifest";
  if (exceedsFileBudget(totals.files)) return "files";
  if (totals.entries > KB_TREE_LIMITS.maxEntries) return "entries";
  if (exceedsTreeByteBudget(totals.treeBytes)) return "bytes";
  return null;
}
export const exceedsFileBudget = (files: number) => files > KB_TREE_LIMITS.maxFiles;
export const exceedsTreeByteBudget = (bytes: number) => bytes > KB_TREE_LIMITS.maxTreeBytes;
