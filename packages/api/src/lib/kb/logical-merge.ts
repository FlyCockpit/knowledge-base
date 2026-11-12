import { createHash } from "node:crypto";
import { KB_TREE_LIMITS } from "./limits";
import { type AssetManifestEntry, canonicalManifestBytes, parseAssetManifest } from "./manifest";
import { parseMarkdownDocument } from "./parse-markdown";
import { casefoldPathKey } from "./paths";
import type { TreeFileInput } from "./staged-tree";
import {
  exceededTreeLimit,
  manifestByteLength,
  manifestEntryBytes,
  type TreeLimit,
  type TreeTotals,
  treeEntryCount,
} from "./tree-budget";

/**
 * The three-way merge of a proposal onto main over the KB's logical
 * model, never Git's raw paths: documents by logical path (with their ids),
 * assets by manifest entry. Every conflict carries its true kind, and the
 * provisional tree is always valid: an unresolved conflict keeps the
 * proposal's choice where that is valid on its own, and main's version
 * where the proposal's would break the tree. Breaking the tree means any
 * structural clash (duplicate document id, case or path collision,
 * file-vs-directory) and any repository limit (file, entry and asset counts,
 * total and per-file bytes, manifest size).
 *
 * Contents are read lazily by blob id: unchanged documents are compared by
 * id and never read, unless a document id must be checked against them.
 * Clashes are resolved with incremental indices and a worklist: a fallback
 * re-checks only the entries that hold the keys it needs.
 */

/**
 * The conflicts a PR still has after a head change that wrote `written`
 * (kind and path): a write of the same kind and path resolves one; main's
 * standing entries are resolved once no other conflict remains.
 */
export function remainingConflicts<T extends LogicalConflict>(
  pending: readonly T[],
  written: (item: LogicalConflict) => boolean,
): { resolved: T[]; unresolved: T[]; remaining: T[] } {
  const resolved = pending.filter(written);
  const unresolved = pending.filter((item) => !written(item));
  return {
    resolved,
    unresolved,
    remaining: unresolved.some((item) => !item.standing) ? unresolved : [],
  };
}

export const MANIFEST_PATH = ".assets/manifest.json";
const GITIGNORE_PATH = ".gitignore";

type LogicalKind = "document" | "asset";
export type LogicalConflict = {
  path: string;
  kind: LogicalKind;
  /**
   * Main's own, unchanged entry, recorded only because other conflicts'
   * choices could collide with it. It may be resolved like any conflict, and
   * needs no choice of its own: once no other conflict remains, main's entry
   * stands and it is resolved with them.
   */
  standing?: true;
};

/**
 * A blob by its Git id; its size when known (limits are enforced only then);
 * `bytes` when already in memory (a merge result).
 */
export type Blob = { sha: string; size?: number; bytes?: Buffer };
export type BlobReader = (sha: string) => Promise<Buffer>;
/** A tree's blobs by path, as `ls-tree -r -l` lists them. */
export type TreeBlobs = ReadonlyMap<string, { sha: string; size?: number }>;

/** A KB tree as the logical model sees it. */
export type LogicalTree = {
  /** Markdown documents: every tree file but the managed `.gitignore` and the manifest. */
  documents: Map<string, Blob>;
  assets: Map<string, AssetManifestEntry>;
  /** The managed `.gitignore`, carried through from main. */
  managed: Map<string, Blob>;
};

/** Git's blob id of some bytes. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

/** The logical model of a tree; null when its manifest cannot be read. */
export async function logicalTreeOf(
  entries: TreeBlobs,
  read: BlobReader,
): Promise<LogicalTree | null> {
  const documents = new Map<string, Blob>();
  const managed = new Map<string, Blob>();
  let manifest: Buffer | null = null;
  for (const [path, blob] of entries) {
    if (path === MANIFEST_PATH) manifest = await read(blob.sha);
    else if (path === GITIGNORE_PATH) managed.set(path, { ...blob });
    else documents.set(path, { ...blob });
  }
  const parsed = parseAssetManifest(manifest ?? Buffer.from('{"version":1,"entries":[]}'));
  if ("code" in parsed) return null;
  return {
    documents,
    assets: new Map(parsed.entries.map((entry) => [entry.path, entry])),
    managed,
  };
}

const manifestBytes = (tree: LogicalTree) =>
  canonicalManifestBytes({ version: 1, entries: [...tree.assets.values()] });

/** Staging inputs for a logical tree: existing blobs by id, new ones by content. */
export function treeInputsOf(tree: LogicalTree): TreeFileInput[] {
  const inputs: TreeFileInput[] = [];
  for (const [path, blob] of [...tree.documents, ...tree.managed])
    inputs.push({
      segments: path.split("/"),
      content: blob.bytes ?? Buffer.alloc(0),
      ...(blob.bytes ? {} : { blobSha: blob.sha }),
    });
  inputs.push({ segments: MANIFEST_PATH.split("/"), content: manifestBytes(tree) });
  return inputs;
}

/** Every file of a logical tree in memory (the base a rebased edit applies to). */
export async function filesOfLogical(
  tree: LogicalTree,
  readMany: (shas: readonly string[]) => Promise<ReadonlyMap<string, Buffer>>,
): Promise<Map<string, Buffer>> {
  const entries = [...tree.documents, ...tree.managed];
  const stored = await readMany(entries.filter(([, b]) => !b.bytes).map(([, b]) => b.sha));
  const files = new Map<string, Buffer>();
  for (const [path, blob] of entries) {
    const bytes = blob.bytes ?? stored.get(blob.sha);
    if (!bytes) throw new Error("blob batch read incomplete");
    files.set(path, bytes);
  }
  files.set(MANIFEST_PATH, manifestBytes(tree));
  return files;
}

const sameBlob = (a?: Blob, b?: Blob) => (a === undefined ? b === undefined : a.sha === b?.sha);
const sameAsset = (a?: AssetManifestEntry, b?: AssetManifestEntry) =>
  a === undefined
    ? b === undefined
    : !!b && a.hash === b.hash && a.size === b.size && a.mime === b.mime;
const CHECKPOINT_EVERY = 256;
const byPathThenKind = (a: LogicalConflict, b: LogicalConflict) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
const keyOf = (kind: LogicalKind, path: string) => `${kind}\0${path}`;

/** Line merge of one document changed on both sides; null when the lines clash. */
export type MergeText = (base: Buffer, main: Buffer, proposal: Buffer) => Promise<Buffer | null>;

type Slot = {
  kind: LogicalKind;
  path: string;
  /** The provisional value; undefined = absent. */
  value: Blob | AssetManifestEntry | undefined;
  /** Equal to main's version: such entries are valid together and never move. */
  pinned: boolean;
  claimed: boolean;
  id: string | null;
};

/**
 * Merge `proposal` onto `main` from their common `base`. Conflicts are
 * sorted by path and kind; `tree` is the provisional, valid result.
 */
export async function mergeLogicalTrees(input: {
  base: LogicalTree;
  main: LogicalTree;
  proposal: LogicalTree;
  /** One line merge in memory (tests and small callers); `mergeTexts` batches them. */
  mergeText?: MergeText;
  read: BlobReader;
  /** Batched reads (one Git process for many blobs); defaults to `read` one by one. */
  readMany?: (shas: readonly string[]) => Promise<ReadonlyMap<string, Buffer>>;
  /**
   * Every line merge at once (one native process for all of them), by path:
   * the merged bytes, or null where the lines clash. Used instead of
   * `mergeText` when given; contents are then never read here.
   */
  mergeTexts?: (
    items: readonly { path: string; base?: Blob; main: Blob; proposal: Blob }[],
  ) => Promise<ReadonlyMap<string, Buffer | null>>;
  /** Cooperative yield and cancellation, awaited every few hundred steps. */
  checkpoint?: () => Promise<void>;
  /**
   * Turn repository limits into typed conflicts (needs every blob's size).
   * The merge planner leaves this to whole-tree validation, which refuses
   * an over-limit result as a conflict anyway.
   */
  enforceLimits?: boolean;
  /**
   * Conflicts recorded earlier and still unresolved, with the versions their
   * resolution may still choose (the proposal's saved "yours"). They stay
   * conflicts, and the closure checks their choices against this merge's
   * tree too, so moving main can never strand a recorded choice.
   */
  recorded?: readonly (LogicalConflict & {
    choices: readonly (Blob | AssetManifestEntry)[];
  })[];
}): Promise<{ tree: LogicalTree; conflicts: LogicalConflict[]; totals: TreeTotals }> {
  const { base, main, proposal } = input;
  let steps = 0;
  const tick = async () => {
    steps += 1;
    if (steps % CHECKPOINT_EVERY === 0) await input.checkpoint?.();
  };
  // Contents prefetched in batches; anything else is read on demand.
  const prefetched = new Map<string, Buffer>();
  const prefetch = async (blobs: readonly (Blob | undefined)[]) => {
    const missing = [
      ...new Set(
        blobs.filter((b): b is Blob => !!b && !b.bytes && !prefetched.has(b.sha)).map((b) => b.sha),
      ),
    ];
    if (missing.length === 0 || !input.readMany) return;
    for (const [sha, bytes] of await input.readMany(missing)) prefetched.set(sha, bytes);
  };
  const load = async (blob: Blob) =>
    blob.bytes ?? prefetched.get(blob.sha) ?? (await input.read(blob.sha));
  // Documents both sides changed are line-merged, all at once when the
  // caller can (`mergeTexts`, one native process), else one by one.
  const lineMerges = new Map<string, Buffer | null>();
  {
    const both: (Blob | undefined)[] = [];
    const paths: string[] = [];
    for (const [path, m] of main.documents) {
      const [b, p] = [base.documents.get(path), proposal.documents.get(path)];
      if (p && !sameBlob(m, p) && !sameBlob(b, p) && !sameBlob(b, m)) {
        both.push(b, m, p);
        paths.push(path);
      }
    }
    if (input.mergeTexts) {
      const merged = await input.mergeTexts(
        paths.map((path) => ({
          path,
          base: base.documents.get(path),
          main: main.documents.get(path)!,
          proposal: proposal.documents.get(path)!,
        })),
      );
      for (const path of paths) lineMerges.set(path, merged.get(path) ?? null);
      paths.length = 0;
    } else await prefetch(both);
    // One merge at a time otherwise (`mergeText` is the in-memory form).
    for (const path of paths) {
      const [b, m, p] = [
        base.documents.get(path),
        main.documents.get(path)!,
        proposal.documents.get(path)!,
      ];
      await tick();
      if (!input.mergeText) throw new Error("no line merge");
      lineMerges.set(
        path,
        await input.mergeText(b ? await load(b) : Buffer.alloc(0), await load(m), await load(p)),
      );
    }
  }
  const conflicts = new Map<string, LogicalConflict>();
  const conflict = (path: string, kind: LogicalKind) =>
    conflicts.set(keyOf(kind, path), { path, kind });

  // 1. Per-path three-way choice.
  const slots = new Map<string, Slot>();
  const mainValue = (kind: LogicalKind, path: string) =>
    kind === "document" ? main.documents.get(path) : main.assets.get(path);
  for (const path of new Set([
    ...base.documents.keys(),
    ...main.documents.keys(),
    ...proposal.documents.keys(),
  ])) {
    await tick();
    const [b, m, p] = [
      base.documents.get(path),
      main.documents.get(path),
      proposal.documents.get(path),
    ];
    let value: Blob | undefined;
    if (sameBlob(m, p) || sameBlob(b, p)) value = m;
    else if (sameBlob(b, m)) value = p;
    else {
      // Both sides changed it. Lines may still combine into a valid document.
      const merged = m && p ? (lineMerges.get(path) ?? null) : null;
      if (
        merged &&
        merged.length <= KB_TREE_LIMITS.maxMarkdownBytes &&
        !("code" in parseMarkdownDocument(merged))
      )
        value = { sha: gitBlobSha(merged), size: merged.length, bytes: merged };
      else {
        conflict(path, "document");
        value = p;
      }
    }
    slots.set(keyOf("document", path), {
      kind: "document",
      path,
      value,
      pinned: sameBlob(value, m),
      claimed: false,
      id: null,
    });
  }
  for (const path of new Set([
    ...base.assets.keys(),
    ...main.assets.keys(),
    ...proposal.assets.keys(),
  ])) {
    await tick();
    const [b, m, p] = [base.assets.get(path), main.assets.get(path), proposal.assets.get(path)];
    let value: AssetManifestEntry | undefined;
    if (sameAsset(m, p) || sameAsset(b, p)) value = m;
    else if (sameAsset(b, m)) value = p;
    else {
      conflict(path, "asset");
      value = p;
    }
    slots.set(keyOf("asset", path), {
      kind: "asset",
      path,
      value,
      pinned: sameAsset(value, m),
      claimed: false,
      id: null,
    });
  }

  // Document ids, read on demand and cached by blob.
  const ids = new Map<string, string | null>();
  const idOf = async (blob: Blob) => {
    if (!ids.has(blob.sha)) {
      const parsed = parseMarkdownDocument(await load(blob));
      ids.set(blob.sha, "code" in parsed ? null : parsed.documentId);
    }
    return ids.get(blob.sha)!;
  };
  const changed = [...slots.values()].filter((slot) => !slot.pinned && slot.value);
  // Recorded conflicts: their saved choices, and a slot for every path (an
  // empty, unclaimed one where no tree holds it any more).
  const savedChoices = new Map<string, (Blob | AssetManifestEntry)[]>();
  for (const item of input.recorded ?? []) {
    const key = keyOf(item.kind, item.path);
    if (!slots.has(key))
      slots.set(key, {
        kind: item.kind,
        path: item.path,
        value: undefined,
        pinned: false,
        claimed: false,
        id: null,
      });
    savedChoices.set(key, [...(savedChoices.get(key) ?? []), ...item.choices]);
  }
  const savedDocuments = [...savedChoices]
    .filter(([key]) => slots.get(key)!.kind === "document")
    .flatMap(([, values]) => values as Blob[]);
  await prefetch([
    ...changed.filter((s) => s.kind === "document").map((s) => s.value as Blob),
    ...savedDocuments,
  ]);
  let idsMatter = false;
  for (const blob of [
    ...changed.filter((s) => s.kind === "document").map((s) => s.value as Blob),
    ...savedDocuments,
  ])
    if (!idsMatter) {
      await tick();
      idsMatter = (await idOf(blob)) !== null;
    }

  // 2. Incremental indices: case-folded file keys, directory keys (spelling
  // and holders) and document ids, each held by the slots that claim them.
  const files = new Map<string, Slot>();
  const dirs = new Map<string, { spelling: string; holders: Set<Slot>; treeHolders: number }>();
  const idHolders = new Map<string, Slot>();
  const prefixes = (path: string) => {
    const segments = path.split("/");
    const folded = casefoldPathKey(path).split("/");
    return segments.map((_, depth) => ({
      spelling: segments.slice(0, depth + 1).join("/"),
      key: folded.slice(0, depth + 1).join("/"),
      dir: depth < segments.length - 1,
    }));
  };
  // Running totals the repository limits are checked against.
  const totals = {
    treeFiles: 2, // .gitignore and the manifest
    treeDirs: 1, // .assets
    treeBytes: [...main.managed.values()].reduce((sum, blob) => sum + (blob.size ?? 0), 0),
    assets: 0,
    manifestEntryBytes: 0,
  };
  // The managed files hold their keys for good (a pinned sentinel).
  const reserved: Slot = {
    kind: "document",
    path: "",
    value: undefined,
    pinned: true,
    claimed: true,
    id: null,
  };
  for (const path of [...main.managed.keys(), MANIFEST_PATH])
    for (const p of prefixes(path))
      if (!p.dir) files.set(p.key, reserved);
      else
        dirs.set(p.key, {
          spelling: p.spelling,
          holders: new Set([reserved]),
          treeHolders: 1,
        });
  /** Whether any claim clashes with `slot`'s (early exit: cost = its depth). */
  const clashes = (slot: Slot): boolean => {
    for (const p of prefixes(slot.path)) {
      const file = files.get(p.key);
      if (file && file !== slot) return true;
      const dir = dirs.get(p.key);
      if (dir && (!p.dir || dir.spelling !== p.spelling) && dir.holders.size > 0) return true;
    }
    if (slot.id !== null) {
      const holder = idHolders.get(slot.id);
      if (holder && holder !== slot) return true;
    }
    return false;
  };
  /**
   * The holders clashing with `slot`, enumerated only when a pinned (main)
   * entry must evict them; each evicted holder leaves its sets, so every
   * holder is enumerated at most once over the whole merge.
   */
  const clashing = (slot: Slot): Slot[] => {
    const out: Slot[] = [];
    for (const p of prefixes(slot.path)) {
      const file = files.get(p.key);
      if (file && file !== slot) out.push(file);
      const dir = dirs.get(p.key);
      if (dir && (!p.dir || dir.spelling !== p.spelling)) out.push(...dir.holders);
    }
    if (slot.id !== null) {
      const holder = idHolders.get(slot.id);
      if (holder && holder !== slot) out.push(holder);
    }
    return out.filter((other) => other !== slot && !other.pinned);
  };
  const sizeOf = (slot: Slot) =>
    slot.kind === "document"
      ? ((slot.value as Blob).size ?? 0)
      : manifestEntryBytes(slot.value as AssetManifestEntry);
  const claim = (slot: Slot) => {
    const tree = slot.kind === "document";
    for (const p of prefixes(slot.path)) {
      if (!p.dir) {
        files.set(p.key, slot);
        continue;
      }
      let dir = dirs.get(p.key);
      if (!dir) {
        dir = { spelling: p.spelling, holders: new Set(), treeHolders: 0 };
        dirs.set(p.key, dir);
      }
      dir.holders.add(slot);
      if (tree) {
        dir.treeHolders += 1;
        if (dir.treeHolders === 1) totals.treeDirs += 1;
      }
    }
    if (slot.id !== null) idHolders.set(slot.id, slot);
    if (tree) {
      totals.treeFiles += 1;
      totals.treeBytes += sizeOf(slot);
    } else {
      totals.assets += 1;
      totals.manifestEntryBytes += sizeOf(slot);
    }
    slot.claimed = true;
  };
  const release = (slot: Slot) => {
    if (!slot.claimed) return;
    const tree = slot.kind === "document";
    for (const p of prefixes(slot.path)) {
      if (!p.dir) {
        if (files.get(p.key) === slot) files.delete(p.key);
        continue;
      }
      const dir = dirs.get(p.key);
      if (!dir) continue;
      dir.holders.delete(slot);
      if (tree) {
        dir.treeHolders -= 1;
        if (dir.treeHolders === 0) totals.treeDirs -= 1;
      }
      if (dir.holders.size === 0 && dir.treeHolders === 0) dirs.delete(p.key);
    }
    if (slot.id !== null && idHolders.get(slot.id) === slot) idHolders.delete(slot.id);
    if (tree) {
      totals.treeFiles -= 1;
      totals.treeBytes -= sizeOf(slot);
    } else {
      totals.assets -= 1;
      totals.manifestEntryBytes -= sizeOf(slot);
    }
    slot.claimed = false;
  };
  const proposalValue = (kind: LogicalKind, path: string) =>
    kind === "document" ? proposal.documents.get(path) : proposal.assets.get(path);
  // Every document version an id may be needed for — the chosen one, main's
  // (a fallback) and the proposal's (a resolution choice) — in one batch.
  if (idsMatter)
    await prefetch(
      [...slots.values()]
        .filter((s) => s.kind === "document")
        .flatMap((s) => [
          s.value as Blob | undefined,
          main.documents.get(s.path),
          proposal.documents.get(s.path),
        ]),
    );
  const prepare = async (slot: Slot) => {
    slot.id = slot.kind === "document" && idsMatter ? await idOf(slot.value as Blob) : null;
  };

  // A worklist of fallbacks: a changed entry that clashes (or must give way
  // to a limit) takes main's version; if that version exists it is pinned and
  // evicts only the changed entries holding its keys, which fall back in turn.
  const queue: Slot[] = [];
  const fallBack = (slot: Slot) => {
    if (slot.pinned) return;
    conflict(slot.path, slot.kind);
    release(slot);
    slot.value = mainValue(slot.kind, slot.path);
    slot.pinned = true;
    if (slot.value) queue.push(slot);
  };
  const settle = async () => {
    while (queue.length > 0) {
      await tick();
      const slot = queue.pop()!;
      await prepare(slot);
      for (const other of clashing(slot)) fallBack(other);
      claim(slot);
    }
  };
  // Main's own entries first (valid together), then changed entries in order.
  for (const slot of slots.values())
    if (slot.pinned && slot.value) {
      await tick();
      await prepare(slot);
      claim(slot);
    }
  changed.sort(byPathThenKind);
  for (const slot of changed) {
    await tick();
    if (slot.pinned) continue; // already fell back
    await prepare(slot);
    if (clashes(slot)) fallBack(slot);
    else claim(slot);
    await settle();
  }

  // 3. Repository limits, to a fixpoint. Each entry's signed contribution to
  // each limit is its chosen version against main's; while any limit is
  // exceeded, the latest-sorted changed entry contributing positively to it
  // falls back (and its evictions with it), then every limit is rechecked.
  // It terminates: an entry falls back at most once, and main fits.
  // The validator's own accounting (root, directories, files, manifest bytes).
  const currentTotals = (): TreeTotals => {
    const manifestBytes = manifestByteLength(totals.manifestEntryBytes, totals.assets);
    return {
      entries: treeEntryCount(totals.treeFiles, totals.treeDirs),
      files: totals.treeFiles,
      treeBytes: totals.treeBytes + manifestBytes,
      manifestEntries: totals.assets,
      manifestBytes,
    };
  };
  type Limit = TreeLimit;
  const violated = () => exceededTreeLimit(currentTotals());
  /** The entry's own size in a limit (a manifest entry with its separating comma). */
  const measure = (kind: LogicalKind, value: Slot["value"], limit: Limit): number => {
    if (!value) return 0;
    if (kind === "asset") {
      const bytes = manifestEntryBytes(value as AssetManifestEntry) + 1;
      return limit === "assets" ? 1 : limit === "manifest" || limit === "bytes" ? bytes : 0;
    }
    if (limit === "files" || limit === "entries") return 1;
    return limit === "bytes" ? ((value as Blob).size ?? 0) : 0;
  };
  const contribution = (slot: Slot, limit: Limit) =>
    slot.pinned || !slot.claimed
      ? 0
      : measure(slot.kind, slot.value, limit) -
        measure(slot.kind, mainValue(slot.kind, slot.path), limit);
  if (input.enforceLimits !== false) {
    const candidates = changed.slice().sort((a, b) => byPathThenKind(b, a));
    // A contribution only drops to zero (on fallback), so one cursor per limit suffices.
    const cursor: Record<Limit, number> = {
      assets: 0,
      manifest: 0,
      files: 0,
      entries: 0,
      bytes: 0,
    };
    for (let limit = violated(); limit !== null; limit = violated()) {
      await tick();
      while (
        cursor[limit] < candidates.length &&
        contribution(candidates[cursor[limit]]!, limit) <= 0
      )
        cursor[limit] += 1;
      const slot = candidates[cursor[limit]];
      // Only when main itself is over (it cannot be): whole-tree validation decides.
      if (!slot) break;
      fallBack(slot);
      await settle();
    }
  }

  // 4. Closure: every entry a conflict's resolution choice (main's version or
  // the proposal's; a deletion claims nothing) would collide with is itself a
  // recorded, typed conflict, so no resolution can fail on an unreported path.
  // Claims are final here; each directory key's holders are enumerated once.
  const reportedDirs = new Set<string>();
  for (const item of input.recorded ?? [])
    if (!conflicts.has(keyOf(item.kind, item.path)))
      conflicts.set(keyOf(item.kind, item.path), {
        path: item.path,
        kind: item.kind,
        ...(item.standing ? { standing: true as const } : {}),
      });
  const pending = [...slots.values()].filter((slot) => conflicts.has(keyOf(slot.kind, slot.path)));
  const report = (other: Slot) => {
    if (other === reserved || conflicts.has(keyOf(other.kind, other.path))) return;
    // Main's own entry (pinned from the start, never a fallback: those are
    // recorded already) only stands in the way.
    conflicts.set(keyOf(other.kind, other.path), {
      path: other.path,
      kind: other.kind,
      ...(other.pinned ? { standing: true as const } : {}),
    });
    pending.push(other);
  };
  while (pending.length > 0) {
    await tick();
    const slot = pending.pop()!;
    const choices = [
      mainValue(slot.kind, slot.path),
      proposalValue(slot.kind, slot.path),
      ...(savedChoices.get(keyOf(slot.kind, slot.path)) ?? []),
    ].filter((value) => value !== undefined);
    if (choices.length === 0) continue;
    for (const p of prefixes(slot.path)) {
      const file = files.get(p.key);
      if (file && file !== slot) report(file);
      const dir = dirs.get(p.key);
      if (dir && (!p.dir || dir.spelling !== p.spelling) && !reportedDirs.has(p.key)) {
        reportedDirs.add(p.key);
        for (const holder of dir.holders) if (holder !== slot) report(holder);
      }
    }
    if (slot.kind === "document" && idsMatter)
      for (const choice of choices) {
        const choiceId = await idOf(choice as Blob);
        const holder = choiceId === null ? undefined : idHolders.get(choiceId);
        if (holder && holder !== slot) report(holder);
      }
  }

  const documents = new Map<string, Blob>();
  const assets = new Map<string, AssetManifestEntry>();
  for (const slot of [...slots.values()].sort(byPathThenKind)) {
    if (!slot.value || !slot.claimed) continue;
    if (slot.kind === "document") documents.set(slot.path, slot.value as Blob);
    else assets.set(slot.path, slot.value as AssetManifestEntry);
  }
  return {
    tree: { documents, assets, managed: new Map(main.managed) },
    conflicts: [...conflicts.values()].sort(byPathThenKind),
    // What validation will charge (meaningful when every size is known).
    totals: currentTotals(),
  };
}
