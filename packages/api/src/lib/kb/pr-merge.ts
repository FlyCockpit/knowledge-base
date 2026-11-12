import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { deflate, inflate } from "node:zlib";
import {
  type DreamMetadata,
  evaluateDreamMergeGuardAsync,
  type PersistedDreamMetadata,
} from "./dream";
import { KbDomainError } from "./errors";
import {
  assertGitReadActive,
  type GitReadOptions,
  gitReadCheckpoint,
  gitReadOptions,
  listTreeBlobsAsync,
  readBlobContentAsync,
  readBlobsAsync,
  readCommitTreeShaAsync,
  runGitAsync,
  walkGitTreeEntriesAsync,
} from "./git-read";
import { textMergeTreeArgv } from "./git-version";
import { KB_TREE_LIMITS } from "./limits";
import { changedLogicalPaths } from "./logical-diff";
import {
  type BlobReader,
  filesOfLogical,
  type LogicalConflict,
  type LogicalTree,
  logicalTreeOf,
  MANIFEST_PATH,
  mergeLogicalTrees,
  treeInputsOf,
} from "./logical-merge";
import { parseAssetManifest } from "./manifest";
import { createMergeScratch, type ScratchAdmission } from "./merge-scratch";
import { KB_PATH_LIMITS } from "./paths";
import { PrConflictError } from "./pr-conflict";
import {
  PROPOSAL_CONFLICT_CONTENT_MAX_BYTES,
  PROPOSAL_CONFLICT_MAX_PATHS,
} from "./protocol/envelope";
import {
  GIT_IDENTITY_EMAIL,
  GIT_IDENTITY_NAME,
  type StagedGitObject,
  stageTreeForFiles,
} from "./staged-tree";
import { type TreeValidationOptions, validateGitCommitAsync } from "./validate-tree";

/**
 * Room for any listing the limits allow: every path of both sides of a diff
 * (or one recursive tree with sizes), each at the maximum path length, plus
 * Git's per-line framing (mode, type, id, size, separators).
 */
/** Manifests (each up to the document limit) read at once for conflict details. */
const MANIFEST_READ_BATCH = 8;
/** Bound pending filesystem work; every batch drains before cleanup can start. */
const SCRATCH_IO_BATCH = 32;

async function scratchIoBatches<T>(
  items: Iterable<T>,
  options: GitReadOptions,
  action: (item: T) => Promise<void>,
): Promise<void> {
  let batch: T[] = [];
  const drain = async () => {
    await gitReadCheckpoint(options);
    const results = await Promise.allSettled(batch.map(action));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    assertGitReadActive(options);
    batch = [];
  };
  for (const item of items) {
    batch.push(item);
    if (batch.length === SCRATCH_IO_BATCH) await drain();
  }
  if (batch.length > 0) await drain();
}

async function writeScratchObjects(
  repo: string,
  objects: Iterable<StagedGitObject>,
  options: GitReadOptions,
): Promise<void> {
  const directories = new Map<string, Promise<unknown>>();
  await scratchIoBatches(objects, options, async (object) => {
    const dir = join(repo, "objects", object.sha.slice(0, 2));
    let ready = directories.get(dir);
    if (!ready) {
      ready = mkdir(dir, { recursive: true });
      directories.set(dir, ready);
    }
    await ready;
    assertGitReadActive(options);
    await writeFile(join(dir, object.sha.slice(2)), object.deflated);
  });
}
const GIT_LISTING_MAX_BYTES = 2 * KB_TREE_LIMITS.maxEntries * (KB_PATH_LIMITS.maxBytes + 96);

const CONFLICT_MESSAGE =
  "This pull request conflicts with main. Its author can update it by proposing the change again against the current main.";
const conflict = (details: unknown = {}) =>
  new PrConflictError(CONFLICT_MESSAGE, { kind: "content_conflict" }, details);
const deflateAsync = promisify(deflate);
/** One trailing newline, no NUL (a commit body is text). */
const commitMessageText = (message: string) =>
  `${message.replaceAll("\0", "").replace(/\s+$/u, "")}\n`;
const inflateAsync = promisify(inflate);
async function git(repo: string, args: string[], options: GitReadOptions): Promise<string> {
  const { stdout } = await runGitAsync(repo, args, { ...options, maxBuffer: 1024 * 1024 });
  return stdout.toString().trim();
}
async function ancestor(
  repo: string,
  a: string,
  b: string,
  options: GitReadOptions,
): Promise<boolean> {
  try {
    await git(repo, ["merge-base", "--is-ancestor", a, b], options);
    return true;
  } catch (error) {
    assertGitReadActive(options);
    if (error && typeof error === "object" && "code" in error && error.code === 1) return false;
    throw error;
  }
}

/** Object-only preparation. Git writes exclusively to a private scratch repository;
 * canonical objects are read-only alternates. One operation deadline covers all
 * children, CPU checkpoints and asynchronous I/O; drain precedes scratch disposal. */
export async function planReviewedMerge(
  input: {
    repoPath: string;
    mainHead: string;
    sourceHead: string;
    dream: DreamMetadata | PersistedDreamMetadata | null;
    validation?: Omit<TreeValidationOptions, "repoPath">;
    scratchRoot?: string;
    admitScratch?: ScratchAdmission;
    /** Merge commit message ("Merge #N: title" plus the Acted-by trailer). */
    message?: string;
    /** Conflicts recorded on the PR and not yet resolved: it cannot merge. */
    pendingConflicts?: readonly ConflictItem[] | null;
    /**
     * The PR being merged (a review): a refusal over typed conflicts then
     * lists them with their versions, as a PROPOSAL_CONFLICT. A status
     * check leaves it out and only learns that the merge would be refused.
     */
    proposalNumber?: number;
  } & GitReadOptions,
) {
  const options = gitReadOptions(input);
  assertGitReadActive(options);
  const typedConflict = async (paths: readonly ConflictItem[]) =>
    input.proposalNumber === undefined || paths.length === 0
      ? conflict()
      : conflict(
          (
            await proposalConflictError({
              ...options,
              repoPath: input.repoPath,
              mainHead: input.mainHead,
              proposalHead: input.sourceHead,
              proposalNumber: input.proposalNumber,
              paths,
            })
          ).details,
        );
  if (input.pendingConflicts && input.pendingConflicts.length > 0)
    throw await typedConflict(input.pendingConflicts);
  if (![input.mainHead, input.sourceHead].every((s) => /^[a-f0-9]{40}$/.test(s))) throw conflict();
  if (
    input.dream &&
    !(
      await evaluateDreamMergeGuardAsync({
        ...options,
        repoPath: input.repoPath,
        mainHead: input.mainHead,
        dream: input.dream,
      })
    ).ok
  )
    throw conflict();
  const validate = async (repoPath: string, sha: string) => {
    const result = await validateGitCommitAsync({ ...input.validation, ...options, repoPath }, sha);
    if (!result.ok) throw conflict();
    return result;
  };
  // A reviewed merge always records its merger, even when ancestry permits a fast-forward.
  // Read-only mergeability checks still use the zero-object fast path.
  const fastForward = await ancestor(input.repoPath, input.mainHead, input.sourceHead, options);
  if (fastForward && (!input.message || input.mainHead === input.sourceHead)) {
    return {
      commitSha: input.sourceHead,
      objects: new Map<string, StagedGitObject>(),
      validation: await validate(input.repoPath, input.sourceHead),
    };
  }
  if (!fastForward && (await ancestor(input.repoPath, input.sourceHead, input.mainHead, options))) {
    return {
      commitSha: input.mainHead,
      objects: new Map<string, StagedGitObject>(),
      validation: await validate(input.repoPath, input.mainHead),
    };
  }
  const owned = await createMergeScratch(
    input.scratchRoot ?? dirname(input.repoPath),
    options,
    input.admitScratch,
  );
  const scratch = owned.path;
  try {
    await mkdir(join(scratch, "objects", "info"), { recursive: true });
    await mkdir(join(scratch, "refs"));
    await writeFile(join(scratch, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(scratch, "objects", "info", "alternates"),
      `${resolve(input.repoPath, "objects")}\n`,
    );
    let staged: Awaited<ReturnType<typeof stageScratchTree>>;
    if (fastForward) {
      // An ancestor merge changes only the commit metadata. Reuse the source
      // tree and validate it through the same publication path below.
      staged = {
        rootSha: await readCommitTreeShaAsync(input.repoPath, input.sourceHead, options),
        objects: new Map<string, StagedGitObject>(),
      };
    } else {
      // The logical merge: any typed conflict (content or structural) refuses.
      const merged = await scratchMerge({
        repoPath: input.repoPath,
        scratch,
        mainHead: input.mainHead,
        proposalHead: input.sourceHead,
        options,
        enforceLimits: false,
      });
      if (merged.conflicts.length > 0) throw await typedConflict(merged.conflicts);
      staged = await stageScratchTree(scratch, merged.tree, options, merged.knownTrees);
    }
    const tree = staged.rootSha;
    const identity = `${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}> ${Math.floor(Date.now() / 1000)} +0000`;
    const body = Buffer.from(
      `tree ${tree}\nparent ${input.mainHead}\nparent ${input.sourceHead}\nauthor ${identity}\ncommitter ${identity}\n\n${commitMessageText(input.message ?? "Merge reviewed proposal")}`,
    );
    const raw = Buffer.concat([Buffer.from(`commit ${body.length}\0`), body]);
    const commitSha = createHash("sha1").update(raw).digest("hex");
    const objects = new Map<string, StagedGitObject>([
      [commitSha, { sha: commitSha, type: "commit", body, deflated: await deflateAsync(raw) }],
    ]);
    await writeScratchObjects(scratch, objects.values(), options);
    const generated = staged.objects;
    generated.set(commitSha, objects.get(commitSha)!);
    await gitReadCheckpoint(options);
    const validation = await validate(scratch, commitSha);
    // Account for every loose object. Reuse generated bodies only after the
    // actual scratch bytes match; unknown objects still get decoded.
    let objectBytes = 0;
    for (const dir of await readdir(join(scratch, "objects"))) {
      if (!/^[a-f0-9]{2}$/.test(dir)) continue;
      const names = (await readdir(join(scratch, "objects", dir))).filter((name) =>
        /^[a-f0-9]{38}$/.test(name),
      );
      const collect = async (name: string) => {
        const sha = dir + name;
        const deflated = await readFile(join(scratch, "objects", dir, name));
        const cached = generated.get(sha);
        let type: string;
        let body: Buffer;
        let rawBytes: number;
        if (cached) {
          if (!deflated.equals(cached.deflated)) throw conflict();
          type = cached.type;
          body = cached.body;
          rawBytes = Buffer.byteLength(`${type} ${body.length}\0`) + body.length;
          if (rawBytes > 128 * 1024 * 1024)
            throw new KbDomainError("QUOTA_EXCEEDED", "Merge object budget exceeded");
        } else {
          const raw = await inflateAsync(deflated, { maxOutputLength: 128 * 1024 * 1024 });
          const nul = raw.indexOf(0);
          type = raw.subarray(0, nul).toString("ascii").split(" ")[0]!;
          body = raw.subarray(nul + 1);
          rawBytes = raw.length;
        }
        objectBytes += rawBytes + deflated.length;
        if (objectBytes > 4 * 128 * 1024 * 1024)
          throw new KbDomainError("QUOTA_EXCEEDED", "Merge object budget exceeded");
        if (type !== "tree" && type !== "blob" && type !== "commit") throw conflict();
        objects.set(sha, { sha, type, body, deflated });
      };
      await scratchIoBatches(
        names.filter((name) => generated.has(dir + name)),
        options,
        collect,
      );
      // Unknown objects retain the original sequential inflation bound.
      for (const name of names) {
        if (generated.has(dir + name)) continue;
        await gitReadCheckpoint(options);
        await collect(name);
      }
    }
    await gitReadCheckpoint(options);
    return { commitSha, objects, validation };
  } finally {
    await owned.dispose();
  }
}

/** Result of replaying a proposal onto main. */
/**
 * One unresolved path of a proposal against main. Its kind says which
 * operations resolve it: a document by create/replace/delete, an asset by
 * assetPut/assetRemove. `baseSha` is the merge base it was found against.
 */
export type ConflictItem = LogicalConflict & {
  /** The merge base it was found against. */
  baseSha?: string;
  /** The proposal head whose version is "yours" (the branch may have moved since). */
  yoursSha?: string;
};

export type ProposalMerge = {
  /** Paths that do not merge, sorted by path; empty when the proposal applies cleanly. */
  conflicts: ConflictItem[];
  /**
   * The merged tree's files when requested. A conflicted document holds the
   * proposal's version (or is absent where the proposal deleted it) and a
   * conflicted asset the proposal's entry: no merge marker is ever written.
   */
  files: Map<string, Buffer> | null;
  /** With `readFiles`: every path the proposal changed since its merge base with main. */
  /** Every logical write the proposal made since its merge base, by kind and path. */
  proposalPaths: LogicalConflict[] | null;
  /** The merge base the conflicts were found against (null for an ancestry fast path). */
  mergeBase?: string | null;
};

async function treeFiles(
  repoPath: string,
  treeSha: string,
  options: GitReadOptions,
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const entries = await walkGitTreeEntriesAsync(
    repoPath,
    treeSha,
    { entries: 0, maxEntries: KB_TREE_LIMITS.maxEntries },
    options,
  );
  // One batched read for every blob (never one process per entry).
  const blobs = entries.filter((entry) => entry.type === "blob");
  const bodies = await readBlobsAsync(
    repoPath,
    blobs.map((entry) => entry.sha),
    { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes, totalMaxBytes: KB_TREE_LIMITS.maxTreeBytes },
    options,
  );
  for (const entry of blobs) files.set(entry.path, bodies.get(entry.sha)!);
  return files;
}

/**
 * The logical three-way merge in a prepared scratch repository: the
 * three trees are read from the canonical object store, documents changed on
 * both sides go through `git merge-file` on scratch files, and the result is
 * the provisional files plus every typed conflict. Nothing is written to the
 * canonical repository.
 */
async function scratchMerge(input: {
  repoPath: string;
  scratch: string;
  mainHead: string;
  proposalHead: string;
  options: GitReadOptions;
  /** Typed conflicts for repository limits (the rebase); the planner leaves them to validation. */
  enforceLimits: boolean;
  /** The PR's unresolved recorded conflicts: their saved choices join the closure. */
  recorded?: readonly ConflictItem[];
}): Promise<{
  tree: LogicalTree;
  conflicts: LogicalConflict[];
  mergeBase: string;
  read: BlobReader;
  knownTrees: ReadonlySet<string>;
}> {
  const { options, scratch } = input;
  const base = await mergeBase(input.repoPath, input.mainHead, input.proposalHead, options);
  const read: BlobReader = (sha) =>
    readBlobContentAsync(
      input.repoPath,
      sha,
      { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
      options,
    );
  // Tree objects the canonical store already holds: staging never rewrites them.
  const knownTrees = new Set<string>();
  const logical = async (sha: string) => {
    const tree = await logicalTreeOf(
      await treeBlobIds(input.repoPath, sha, options, input.enforceLimits, knownTrees),
      read,
    );
    if (!tree) throw new KbDomainError("STORAGE_UNAVAILABLE", "Asset manifest unavailable");
    return tree;
  };
  // Every line merge in one native process: flat synthetic trees of the three
  // versions (names are indices, so nothing is renamed or moved) merged by
  // `git merge-tree` in a private object store beside the scratch repository,
  // whose objects never join the merge result.
  const mergeTexts = async (
    items: readonly {
      path: string;
      base?: { sha: string };
      main: { sha: string };
      proposal: { sha: string };
    }[],
  ): Promise<Map<string, Buffer | null>> => {
    const out = new Map<string, Buffer | null>();
    if (items.length === 0) return out;
    const repo = join(scratch, "text-merge");
    await mkdir(join(repo, "objects", "info"), { recursive: true });
    await mkdir(join(repo, "refs"), { recursive: true });
    await writeFile(join(repo, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(repo, "objects", "info", "alternates"),
      `${resolve(input.repoPath, "objects")}\n`,
    );
    const name = (index: number) => `f${index}`;
    const side = (pick: (item: (typeof items)[number]) => { sha: string } | undefined) =>
      stageTreeForFiles(
        items.map((item, index) => {
          const blob = pick(item);
          return blob
            ? { segments: [name(index)], content: Buffer.alloc(0), blobSha: blob.sha }
            : { segments: [name(index)], content: Buffer.alloc(0) };
        }),
      );
    const trees = [side((i) => i.base), side((i) => i.main), side((i) => i.proposal)];
    await writeScratchObjects(
      repo,
      new Map(trees.flatMap((staged) => [...staged.objects])).values(),
      options,
    );
    const { stdout } = await runGitAsync(
      repo,
      // The startup probe (git-version.ts) runs this same argv on every image.
      textMergeTreeArgv(trees[0]!.rootSha, trees[1]!.rootSha, trees[2]!.rootSha),
      { ...options, maxBuffer: GIT_LISTING_MAX_BYTES, resultExitCodes: [1] },
    );
    const records = stdout.toString().split("\0");
    const result = records[0] ?? "";
    if (!/^[a-f0-9]{40}$/.test(result))
      throw new KbDomainError("STORAGE_UNAVAILABLE", "Merge unavailable");
    const clashing = new Set<string>();
    for (const record of records.slice(1)) {
      if (record === "") break;
      clashing.add(record);
    }
    // The merged versions: oversized ones are clashes, the rest read in one batch.
    const merged = await listTreeBlobsAsync(repo, result, options);
    const fits = merged.filter(
      (blob) => !clashing.has(blob.path) && blob.size <= KB_TREE_LIMITS.maxMarkdownBytes,
    );
    const bodies = await readBlobsAsync(
      repo,
      fits.map((blob) => blob.sha),
      { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
      options,
    );
    const byName = new Map(fits.map((blob) => [blob.path, bodies.get(blob.sha) ?? null]));
    for (const [index, item] of items.entries())
      out.set(item.path, byName.get(name(index)) ?? null);
    return out;
  };
  // Each recorded conflict may still choose the version saved at its "yours"
  // revision: read each such revision's logical tree once.
  const saved = new Map<string, LogicalTree>();
  for (const sha of new Set((input.recorded ?? []).flatMap((item) => item.yoursSha ?? [])))
    saved.set(sha, await logical(sha));
  const recorded = (input.recorded ?? []).map((item) => {
    const tree = item.yoursSha ? saved.get(item.yoursSha) : undefined;
    const choice =
      item.kind === "document" ? tree?.documents.get(item.path) : tree?.assets.get(item.path);
    return {
      path: item.path,
      kind: item.kind,
      ...(item.standing ? { standing: true as const } : {}),
      choices: choice ? [choice] : [],
    };
  });
  const merged = await mergeLogicalTrees({
    recorded,
    base: await logical(base),
    main: await logical(input.mainHead),
    proposal: await logical(input.proposalHead),
    mergeTexts,
    read,
    readMany: (shas) =>
      readBlobsAsync(input.repoPath, shas, { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes }, options),
    checkpoint: () => gitReadCheckpoint(options),
    enforceLimits: input.enforceLimits,
  });
  return { tree: merged.tree, conflicts: merged.conflicts, mergeBase: base, read, knownTrees };
}

/**
 * A commit's blobs by path with their sizes, from one `ls-tree` (no blob is
 * read); its subtree objects are added to `trees`.
 */
async function treeBlobIds(
  repoPath: string,
  commit: string,
  options: GitReadOptions,
  withSizes: boolean,
  trees: Set<string>,
): Promise<Map<string, { sha: string; size?: number }>> {
  // Sizes cost a header read of every blob: only when limits are enforced.
  const { stdout } = await runGitAsync(
    repoPath,
    ["ls-tree", "-r", "-t", ...(withSizes ? ["-l"] : []), "-z", commit],
    { ...options, maxBuffer: GIT_LISTING_MAX_BYTES },
  );
  const entries = new Map<string, { sha: string; size?: number }>();
  for (const line of stdout.toString().split("\0")) {
    const tree = /^040000 tree ([a-f0-9]{40})(?: +-)?\t/.exec(line);
    if (tree) trees.add(tree[1]!);
    const match = /^100644 blob ([a-f0-9]{40})(?: +([0-9]+))?\t(.+)$/s.exec(line);
    if (match)
      entries.set(match[3]!, {
        sha: match[1]!,
        ...(match[2] === undefined ? {} : { size: Number(match[2]) }),
      });
  }
  return entries;
}

/** Write a merged tree's new objects into the scratch store; returns the root tree. */
async function stageScratchTree(
  scratch: string,
  tree: LogicalTree,
  options: GitReadOptions,
  knownTrees: ReadonlySet<string>,
): Promise<{ rootSha: string; objects: Map<string, StagedGitObject> }> {
  // Unchanged blobs are referenced by id and unchanged subtrees are already in
  // the canonical store: only new blobs and trees are written.
  const staged = stageTreeForFiles(treeInputsOf(tree));
  for (const object of staged.objects.values())
    if (object.type === "tree" && knownTrees.has(object.sha)) staged.objects.delete(object.sha);
  await writeScratchObjects(scratch, staged.objects.values(), options);
  return staged;
}

async function mergeBase(
  repoPath: string,
  a: string,
  b: string,
  options: GitReadOptions,
): Promise<string> {
  const base = (await runGitAsync(repoPath, ["merge-base", a, b], options)).stdout
    .toString()
    .trim();
  if (!/^[a-f0-9]{40}$/.test(base))
    throw new KbDomainError("STORAGE_UNAVAILABLE", "Merge unavailable");
  return base;
}

/**
 * Every logical path a proposal changed since its merge base with main: a
 * manifest change is expanded into the assets it adds, removes or replaces.
 */
export async function proposalChangedPaths(
  repoPath: string,
  mainHead: string,
  proposalHead: string,
  options: GitReadOptions,
): Promise<LogicalConflict[]> {
  const base = await mergeBase(repoPath, mainHead, proposalHead, options);
  return changedLogicalPaths(repoPath, base, proposalHead, options);
}

/**
 * Three-way merge of a proposal head onto main, read-only for the canonical
 * repository: Git writes only into a private scratch repository whose object
 * store borrows the canonical one. Decides whether a PR still applies (its
 * CONFLICT status) and, with `readFiles`, yields the tree a proposal rebased
 * onto main starts from.
 */
export async function mergeProposalOntoMain(
  input: {
    repoPath: string;
    mainHead: string;
    proposalHead: string;
    readFiles: boolean;
    scratchRoot?: string;
    admitScratch?: ScratchAdmission;
    /** The PR's unresolved recorded conflicts (their saved choices are rechecked). */
    recorded?: readonly ConflictItem[];
  } & GitReadOptions,
): Promise<ProposalMerge> {
  const options = gitReadOptions(input);
  assertGitReadActive(options);
  if (![input.mainHead, input.proposalHead].every((s) => /^[a-f0-9]{40}$/.test(s)))
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid revision");
  const proposalPaths = async () =>
    input.readFiles
      ? await proposalChangedPaths(input.repoPath, input.mainHead, input.proposalHead, options)
      : null;
  const at = async (sha: string): Promise<ProposalMerge> => ({
    conflicts: [],
    files: input.readFiles
      ? await treeFiles(
          input.repoPath,
          await readCommitTreeShaAsync(input.repoPath, sha, options),
          options,
        )
      : null,
    proposalPaths: await proposalPaths(),
  });
  // Ancestry shortcuts only when nothing is recorded: a recorded choice must
  // still be checked against whatever main took in or added.
  if (!input.recorded?.length) {
    if (await ancestor(input.repoPath, input.mainHead, input.proposalHead, options))
      return at(input.proposalHead);
    if (await ancestor(input.repoPath, input.proposalHead, input.mainHead, options))
      return at(input.mainHead);
  }
  const owned = await createMergeScratch(
    input.scratchRoot ?? dirname(input.repoPath),
    options,
    input.admitScratch,
  );
  const scratch = owned.path;
  try {
    await mkdir(join(scratch, "objects", "info"), { recursive: true });
    await mkdir(join(scratch, "refs"));
    await writeFile(join(scratch, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      join(scratch, "objects", "info", "alternates"),
      `${resolve(input.repoPath, "objects")}\n`,
    );
    const merged = await scratchMerge({
      repoPath: input.repoPath,
      scratch,
      mainHead: input.mainHead,
      proposalHead: input.proposalHead,
      options,
      enforceLimits: input.readFiles,
      recorded: input.recorded,
    });
    return {
      conflicts: merged.conflicts,
      files: input.readFiles
        ? await filesOfLogical(merged.tree, (shas) =>
            readBlobsAsync(
              input.repoPath,
              shas,
              { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
              options,
            ),
          )
        : null,
      proposalPaths: await proposalPaths(),
      mergeBase: merged.mergeBase,
    };
  } finally {
    await owned.dispose();
  }
}

/**
 * CONFLICT for a proposal update that still clashes with main: every
 * unresolved path with its base / main ("theirs") / proposal ("yours")
 * versions, so an agent can resolve by writing each file in full against
 * `headSha` (current main). Contents are inline only within a fixed budget.
 */
export async function proposalConflictError(
  input: {
    repoPath: string;
    mainHead: string;
    proposalHead: string;
    proposalNumber: number;
    paths: readonly ConflictItem[];
  } & GitReadOptions,
): Promise<KbDomainError> {
  const options = gitReadOptions(input);
  const baseSha = await mergeBase(input.repoPath, input.mainHead, input.proposalHead, options);
  const listed = input.paths.slice(0, PROPOSAL_CONFLICT_MAX_PATHS);
  // A conflict recorded earlier keeps the merge base and the proposal head
  // it was found against; both stay reachable from the PR branch.
  const revisionsOf = (item: ConflictItem) => ({
    baseSha: item.baseSha ?? baseSha,
    theirsSha: input.mainHead,
    yoursSha: item.yoursSha ?? input.proposalHead,
  });
  // Every version's id and size from one path-limited listing per revision;
  // whether contents are inline is decided from sizes before any body is
  // read, so historical versions never exceed what a response may carry.
  const wantedAt = new Map<string, Set<string>>();
  for (const item of listed)
    for (const rev of Object.values(revisionsOf(item))) {
      const paths = wantedAt.get(rev) ?? new Set<string>();
      paths.add(item.kind === "document" ? item.path : MANIFEST_PATH);
      wantedAt.set(rev, paths);
    }
  const blobAt = new Map<string, Map<string, { sha: string; size: number }>>();
  for (const [rev, paths] of wantedAt) {
    const { stdout } = await runGitAsync(
      input.repoPath,
      ["ls-tree", "-l", "-z", rev, "--", ...paths],
      { ...options, maxBuffer: GIT_LISTING_MAX_BYTES },
    );
    const ids = new Map<string, { sha: string; size: number }>();
    for (const record of stdout.toString().split("\0")) {
      const match = /^100644 blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/s.exec(record);
      if (match && paths.has(match[3]!))
        ids.set(match[3]!, { sha: match[1]!, size: Number(match[2]) });
    }
    blobAt.set(rev, ids);
  }
  // Asset versions are manifest entries: read the manifests a few at a time,
  // keeping only the entries asked for.
  const assetEntryAt = new Map<string, Map<string, string>>();
  const assetPathsAt = new Map<string, Set<string>>();
  for (const item of listed)
    if (item.kind === "asset")
      for (const rev of Object.values(revisionsOf(item)))
        assetPathsAt.set(rev, (assetPathsAt.get(rev) ?? new Set()).add(item.path));
  const manifestRevs = [...assetPathsAt.keys()];
  for (let start = 0; start < manifestRevs.length; start += MANIFEST_READ_BATCH) {
    const revs = manifestRevs.slice(start, start + MANIFEST_READ_BATCH);
    const shas = revs.flatMap((rev) => blobAt.get(rev)?.get(MANIFEST_PATH)?.sha ?? []);
    const bodies = await readBlobsAsync(
      input.repoPath,
      shas,
      { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
      options,
    );
    for (const rev of revs) {
      const sha = blobAt.get(rev)?.get(MANIFEST_PATH)?.sha;
      const parsed = parseAssetManifest(
        (sha && bodies.get(sha)) || Buffer.from('{"version":1,"entries":[]}'),
      );
      const wanted = assetPathsAt.get(rev)!;
      assetEntryAt.set(
        rev,
        new Map(
          ("code" in parsed ? [] : parsed.entries)
            .filter((entry) => wanted.has(entry.path))
            .map((entry) => [entry.path, JSON.stringify(entry)]),
        ),
      );
    }
  }
  let bytes = 0;
  for (const item of listed)
    for (const rev of Object.values(revisionsOf(item)))
      bytes +=
        item.kind === "document"
          ? (blobAt.get(rev)?.get(item.path)?.size ?? 0)
          : Buffer.byteLength(assetEntryAt.get(rev)?.get(item.path) ?? "", "utf8");
  const contentIncluded = bytes <= PROPOSAL_CONFLICT_CONTENT_MAX_BYTES;
  // Document bodies only when they fit (then at most the inline budget).
  const contents = contentIncluded
    ? await readBlobsAsync(
        input.repoPath,
        listed.flatMap((item) =>
          item.kind === "document"
            ? Object.values(revisionsOf(item)).flatMap(
                (rev) => blobAt.get(rev)?.get(item.path)?.sha ?? [],
              )
            : [],
        ),
        { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes },
        options,
      )
    : new Map<string, Buffer>();
  const versionAt = (rev: string, path: string, kind: ConflictItem["kind"]): string | null => {
    if (!contentIncluded) return null;
    if (kind === "asset") return assetEntryAt.get(rev)?.get(path) ?? null;
    const sha = blobAt.get(rev)?.get(path)?.sha;
    return sha === undefined ? null : contents.get(sha)!.toString("utf8");
  };
  const versions = listed.map((item) => {
    const revisions = revisionsOf(item);
    return {
      path: item.path,
      kind: item.kind,
      base: versionAt(revisions.baseSha, item.path, item.kind),
      theirs: versionAt(revisions.theirsSha, item.path, item.kind),
      yours: versionAt(revisions.yoursSha, item.path, item.kind),
      ...revisions,
    };
  });
  return new KbDomainError(
    "CONFLICT",
    "The proposal conflicts with main; write each listed path in full against main with its proposalNumber and proposalHeadSha",
    undefined,
    {
      headSha: input.mainHead,
      proposalNumber: input.proposalNumber,
      reason: "PROPOSAL_CONFLICT",
      baseSha,
      proposalHeadSha: input.proposalHead,
      contentIncluded,
      paths: versions,
    },
  );
}
