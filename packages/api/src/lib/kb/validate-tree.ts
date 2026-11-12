import { createHash, randomUUID } from "node:crypto";

import {
  assertGitReadActive,
  chargeIncomingObject,
  createIncomingObjectBudget,
  finishGitReadAsync,
  finishGitReadSync,
  type GitReadOptions,
  type GitReadSteps,
  type GitTreeEntry,
  gitReadOptions,
  gitReadStep,
  type IncomingObjectBudget,
  listCommitsBetween,
  listNewlyReachableObjects,
  listTreeBlobsSync,
  readBlobContent,
  readBlobContentAsync,
  readBlobsAsync,
  readCommitBlobs,
  readCommitParents,
  readCommitTreeSha,
  readCommitTreeShaAsync,
  readObjectSizeBytes,
  readObjectSizeBytesAsync,
  readObjectsSync,
  runGitAsync,
  TreeReadBudgetError,
  TreeStructureError,
  type TreeWalkBudget,
  walkGitTreeEntries,
  walkGitTreeEntriesAsync,
} from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import { canonicalManifestBytes, parseAssetManifest, validateManifestDocument } from "./manifest";
import {
  bodyByteOffsetAfterFrontMatter,
  decodeUtf8Fatal,
  findSealedReferences,
  parseMarkdownDocument,
  sealedReferenceScanSource,
  validateMarkdownBytes,
} from "./parse-markdown";
import {
  isMarkdownPath,
  KB_MANAGED_GITIGNORE,
  KB_PATH_LIMITS,
  normalizeKbPath,
  registerPath,
  type SeenPathEntry,
} from "./paths";
import { type StagedObjectSet, walkStagedTreeEntries } from "./staged-tree";
import { exceedsFileBudget, exceedsTreeByteBudget, type TreeTotals } from "./tree-budget";

const SHA1 = /^[0-9a-f]{40}$/;
const BLOB_MODE = "100644";
const TREE_MODE = "040000";
const LFS_POINTER_PREFIX = Buffer.from("version https://git-lfs.github.com/spec/v1\n", "utf8");

export type TreeValidationErrorCode =
  | "TREE_BUDGET"
  | "TREE_MODE"
  | "TREE_TYPE"
  | "TREE_PATH"
  | "TREE_FILE_KIND"
  | "TREE_REQUIRED"
  | "TREE_MANIFEST"
  | "TREE_MARKDOWN"
  | "TREE_DOCUMENT_ID"
  | "TREE_SEALED"
  | "TREE_BINDING";

export type TreeValidationFailure = {
  ok: false;
  code: TreeValidationErrorCode;
  message: string;
  path?: string;
  /** The underlying path or Markdown issue code, when one caused the failure. */
  issue?: string;
};

export type TreeValidationSuccess = {
  ok: true;
  treeSha: string;
  commitSha?: string;
};

export type TreeValidationResult = TreeValidationSuccess | TreeValidationFailure;

/** `blob` is the object holding the reference at `path` (L-8). */
export type SealedReferenceOccurrence = { reference: string; path: string; blob: string };

export type TreeValidationOptions = {
  repoPath: string;
  loadCommitContext?: (
    sha: string,
  ) => Promise<Pick<TreeValidationOptions, "trustedBlobs" | "lineageHashes">>;
  trustedBlobs?: ReadonlyMap<string, { size: number; mime: string }>;
  lineageHashes?: ReadonlySet<string>;
  validateSealedReferences?: (
    refs: readonly SealedReferenceOccurrence[],
  ) => TreeValidationFailure | null;
  /**
   * L-8: `path -> blob` of the commit this tree builds on (or the intersection
   * of eligible validated parents for a pushed merge). References in a
   * blob unchanged at its path were validated when it was written, so a later
   * revocation never blocks unrelated writes; only changed paths must
   * reference live records. Absent: every reference is validated.
   */
  baseBlobs?: ReadonlyMap<string, string>;
};

type TreeBudget = {
  files: number;
  treeBytes: number;
};

function defaultSealedValidator(
  refs: readonly SealedReferenceOccurrence[],
): TreeValidationFailure | null {
  if (refs.length === 0) return null;
  return {
    ok: false,
    code: "TREE_SEALED",
    message: "Unresolved sealed reference",
    path: refs[0]!.path,
  };
}

function fail(
  code: TreeValidationErrorCode,
  message: string,
  path?: string,
  issue?: string,
): TreeValidationFailure {
  return issue === undefined
    ? { ok: false, code, message, path }
    : { ok: false, code, message, path, issue };
}

function freshIncomingBudget(incomingObjects?: ReadonlySet<string>): IncomingObjectBudget {
  return createIncomingObjectBudget(
    KB_TREE_LIMITS.maxObjects,
    KB_TREE_LIMITS.maxUncompressedObjectBytes,
    incomingObjects,
  );
}

function isLfsPointer(blob: Buffer): boolean {
  if (blob.byteLength < LFS_POINTER_PREFIX.byteLength) return false;
  return blob.subarray(0, LFS_POINTER_PREFIX.byteLength).equals(LFS_POINTER_PREFIX);
}

/**
 * Where tree validation reads objects from: the canonical bare repository, or
 * a staged in-memory candidate set that has not been materialized yet. Both
 * sources feed the identical per-entry rules, so a candidate commit is judged
 * exactly as it will be judged after the writer persists it.
 */
type TreeObjectSource = {
  walkEntries(
    treeSha: string,
    budget: TreeWalkBudget,
    incoming?: IncomingObjectBudget,
  ): GitTreeEntry[] | Promise<GitTreeEntry[]>;
  objectSizeBytes(sha: string): number | Promise<number>;
  blobContent(sha: string, limits: { maxBytes: number }): Buffer | Promise<Buffer>;
};

function repoObjectSource(repoPath: string): TreeObjectSource {
  // Sizes are immutable metadata; keep no blob buffers and share no state
  // across repositories, quarantine contexts or validation calls.
  const sizesBySha = new Map<string, number>();
  // Blobs of the walked tree in one batched read when within the byte
  // budgets (the per-blob path below reports anything else as before).
  let cached: Map<string, Buffer> | null = null;
  return {
    walkEntries: (treeSha, budget, incoming) => {
      cached = prefetchTreeBlobsSync(repoPath, treeSha);
      return walkGitTreeEntries(repoPath, treeSha, budget, incoming);
    },
    objectSizeBytes: (sha) => {
      let size = sizesBySha.get(sha) ?? cached?.get(sha)?.length;
      if (size === undefined) {
        size = readObjectSizeBytes(repoPath, sha);
        sizesBySha.set(sha, size);
      }
      return size;
    },
    blobContent: (sha, limits) => {
      const bytes = cached?.get(sha);
      return bytes && bytes.length <= limits.maxBytes
        ? bytes
        : readBlobContent(repoPath, sha, limits);
    },
  };
}

function stagedObjectSource(objects: StagedObjectSet): TreeObjectSource {
  return {
    walkEntries: (treeSha, budget, incoming) =>
      walkStagedTreeEntries(objects, treeSha, budget, incoming),
    objectSizeBytes: (sha) => {
      const object = objects.get(sha);
      if (!object) throw new Error("staged object not found");
      return object.body.length;
    },
    blobContent: (sha, limits) => {
      const object = objects.get(sha);
      if (object?.type !== "blob") throw new Error("staged blob not found");
      if (object.body.byteLength > limits.maxBytes) {
        throw new TreeReadBudgetError("blob exceeds read budget", {
          size: object.body.byteLength,
          maxBytes: limits.maxBytes,
        });
      }
      return object.body;
    },
  };
}

/**
 * Validate one full tree. Per-tree budgets (file count, tree bytes, walk
 * entries) always start fresh; the incoming-object budget is shared across a
 * whole traversal range when `incoming` is supplied by
 * validateNewlyReachableCommits. Newly reachable commits/trees/blobs accumulate
 * against one allowance, charged before each content validation read.
 */
export function validateGitTree(
  options: TreeValidationOptions,
  treeSha: string,
  incoming?: IncomingObjectBudget,
): TreeValidationResult {
  if (!SHA1.test(treeSha)) return fail("TREE_BUDGET", "invalid tree sha");
  return validateTreeFromSource(repoObjectSource(options.repoPath), options, treeSha, incoming);
}

/**
 * Validate a staged candidate commit against the shared whole-tree rules —
 * before any object is materialized in the canonical repository. Same rules,
 * same failure codes, same binding inputs as the post-write path.
 */
export function validateStagedCommitTree(
  staged: { objects: StagedObjectSet; rootTreeSha: string; commitSha: string },
  options?: Omit<TreeValidationOptions, "repoPath">,
): TreeValidationResult {
  if (!SHA1.test(staged.commitSha)) return fail("TREE_BUDGET", "invalid commit sha");
  const result = validateTreeFromSource(
    stagedObjectSource(staged.objects),
    options ?? {},
    staged.rootTreeSha,
  );
  if (!result.ok) return result;
  return { ok: true, treeSha: staged.rootTreeSha, commitSha: staged.commitSha };
}

function validateTreeFromSource(
  source: TreeObjectSource,
  options: Omit<TreeValidationOptions, "repoPath">,
  treeSha: string,
  incoming?: IncomingObjectBudget,
): TreeValidationResult {
  return finishGitReadSync(validateTreeSteps(source, options, treeSha, incoming));
}
function* validateTreeSteps(
  source: TreeObjectSource,
  options: Omit<TreeValidationOptions, "repoPath">,
  treeSha: string,
  incoming?: IncomingObjectBudget,
): GitReadSteps<TreeValidationResult> {
  const budget = incoming ?? freshIncomingBudget();
  const perTree: TreeBudget = { files: 0, treeBytes: 0 };
  const pathSeen = new Map<string, SeenPathEntry>();
  const exactPaths = new Set<string>();
  const documentIds = new Map<string, string>();
  const sealed: SealedReferenceOccurrence[] = [];
  let manifestBlob: Buffer | null = null;
  let hasGitignore = false;
  let hasManifest = false;
  let hasIndex = false;
  try {
    const entries = yield* gitReadStep(
      source.walkEntries(
        treeSha,
        {
          entries: 0,
          maxEntries: KB_TREE_LIMITS.maxEntries,
        },
        budget,
      ),
    );
    for (const entry of entries) {
      yield undefined;
      if (entry.type === "commit") {
        return fail("TREE_TYPE", "gitlink (submodule) entries are not allowed", entry.path);
      }
      const normalized = normalizeKbPath(entry.path);
      if (!normalized.ok) {
        return fail("TREE_PATH", normalized.issue.message, entry.path, normalized.issue.code);
      }
      const path = normalized.path;
      const depth = path.split("/").length;
      if (depth > KB_TREE_LIMITS.maxTreeDepth) {
        return fail("TREE_PATH", "path exceeds depth budget", path);
      }
      // Both raw tree walkers emit directories before their descendants.
      // Register each entry once, rather than case-folding every ancestor again.
      const collision = registerPath(pathSeen, path, entry.type === "tree" ? "dir" : "file");
      if (collision) return fail("TREE_PATH", collision.message, path, collision.code);
      if (entry.type === "tree") {
        if (entry.mode !== TREE_MODE) {
          return fail("TREE_MODE", `unsupported directory mode ${entry.mode}`, path);
        }
        if (path === ".gitignore" || path === ".assets/manifest.json") {
          return fail(
            "TREE_FILE_KIND",
            "reserved root file must be a regular file",
            path,
            "PATH_GIT_RESERVED",
          );
        }
        if (path.startsWith(".assets/")) {
          return fail(
            "TREE_FILE_KIND",
            "only manifest.json is allowed under .assets",
            path,
            "PATH_GIT_RESERVED",
          );
        }
        continue;
      }
      if (entry.mode !== BLOB_MODE) {
        return fail("TREE_MODE", `unsupported file mode ${entry.mode}`, path);
      }
      if (exactPaths.has(path)) {
        return fail("TREE_PATH", `duplicate tree entry path ${path}`, path);
      }
      exactPaths.add(path);
      if (path.startsWith(".assets/") && path !== ".assets/manifest.json") {
        return fail(
          "TREE_FILE_KIND",
          "only manifest.json is allowed under .assets",
          path,
          "PATH_GIT_RESERVED",
        );
      }
      if (path === ".gitignore") {
        hasGitignore = true;
      } else if (path === ".assets/manifest.json") {
        hasManifest = true;
      } else if (path === "index.md") {
        hasIndex = true;
      } else if (!isMarkdownPath(path)) {
        return fail("TREE_FILE_KIND", "only Markdown files are allowed", path);
      }
      perTree.files += 1;
      if (exceedsFileBudget(perTree.files)) {
        return fail("TREE_BUDGET", "tree exceeds file budget");
      }
      const size = yield* gitReadStep(source.objectSizeBytes(entry.sha));
      if (size > KB_TREE_LIMITS.maxMarkdownBytes) {
        return fail("TREE_BUDGET", "markdown exceeds size budget", path);
      }
      chargeIncomingObject(budget, entry.sha, size);
      const blob = yield* gitReadStep(
        source.blobContent(entry.sha, {
          maxBytes: KB_TREE_LIMITS.maxMarkdownBytes,
        }),
      );
      perTree.treeBytes += blob.byteLength;
      if (exceedsTreeByteBudget(perTree.treeBytes)) {
        return fail("TREE_BUDGET", "tree exceeds byte budget");
      }
      if (path === ".gitignore") {
        if (!blob.equals(Buffer.from(KB_MANAGED_GITIGNORE, "utf8"))) {
          return fail("TREE_FILE_KIND", "gitignore content is not the managed template", path);
        }
        continue;
      }
      if (path === ".assets/manifest.json") {
        manifestBlob = blob;
        continue;
      }
      const utf8Issue = validateMarkdownBytes(blob);
      if (utf8Issue) return fail("TREE_MARKDOWN", utf8Issue.message, path, utf8Issue.code);
      if (isLfsPointer(blob)) {
        return fail("TREE_MARKDOWN", "git LFS pointers are not supported", path);
      }
      const parsed = parseMarkdownDocument(blob);
      if ("code" in parsed) return fail("TREE_MARKDOWN", parsed.message, path, parsed.code);
      if (parsed.documentId) {
        const prior = documentIds.get(parsed.documentId);
        if (prior) {
          return fail("TREE_DOCUMENT_ID", `duplicate document id ${parsed.documentId}`, path);
        }
        documentIds.set(parsed.documentId, path);
      }
      // The scan source is the whole decoded document plus decoded YAML
      // keys/values, so references hidden in comments, keys or escape
      // sequences reach the validator exactly once per (reference, path).
      const scanSource = sealedReferenceScanSource(parsed, decodeUtf8Fatal(blob));
      const sealedSeen = new Set<string>();
      for (const reference of findSealedReferences(scanSource)) {
        const seenKey = `${reference}\0${path}`;
        if (sealedSeen.has(seenKey)) continue;
        sealedSeen.add(seenKey);
        sealed.push({ reference, path, blob: entry.sha });
      }
    }
    if (manifestBlob) {
      const manifestIssue = validateManifestDocument(manifestBlob, {
        trustedBlobs: options.trustedBlobs ?? new Map(),
        lineageHashes: options.lineageHashes ?? new Set(),
        treePaths: pathSeen,
      });
      if (manifestIssue) {
        // The typed cause rides along: an entry path's issue, else the manifest's.
        return fail(
          "TREE_MANIFEST",
          manifestIssue.message,
          manifestIssue.path ?? ".assets/manifest.json",
          manifestIssue.pathIssue ?? manifestIssue.code,
        );
      }
      const parsed = parseAssetManifest(manifestBlob);
      if ("code" in parsed) {
        return fail("TREE_MANIFEST", parsed.message, ".assets/manifest.json");
      }
      if (!manifestBlob.equals(canonicalManifestBytes(parsed))) {
        return fail("TREE_MANIFEST", "manifest must be canonical", ".assets/manifest.json");
      }
    }
  } catch (error) {
    if (error instanceof TreeReadBudgetError) {
      return fail("TREE_BUDGET", error.message);
    }
    if (error instanceof TreeStructureError) {
      return fail("TREE_PATH", error.message);
    }
    throw error;
  }
  if (!hasGitignore || !hasManifest || !hasIndex) {
    return fail("TREE_REQUIRED", "tree is missing required root files");
  }
  const baseBlobs = options.baseBlobs;
  const changedSealed = baseBlobs
    ? sealed.filter((occurrence) => baseBlobs.get(occurrence.path) !== occurrence.blob)
    : sealed;
  const sealedIssue = (options.validateSealedReferences ?? defaultSealedValidator)(changedSealed);
  if (sealedIssue) return sealedIssue;
  return { ok: true, treeSha };
}

export function validateGitCommit(
  options: TreeValidationOptions,
  commitSha: string,
  incoming?: IncomingObjectBudget,
): TreeValidationResult {
  if (!SHA1.test(commitSha)) return fail("TREE_BUDGET", "invalid commit sha");
  const budget = incoming ?? freshIncomingBudget();
  try {
    chargeIncomingObject(budget, commitSha, readObjectSizeBytes(options.repoPath, commitSha));
    const treeSha = readCommitTreeSha(options.repoPath, commitSha);
    const tree = validateGitTree(options, treeSha, budget);
    if (!tree.ok) return tree;
    return { ok: true, treeSha, commitSha };
  } catch (error) {
    if (error instanceof TreeReadBudgetError) {
      return fail("TREE_BUDGET", error.message);
    }
    if (error instanceof TreeStructureError) {
      return fail("TREE_PATH", error.message);
    }
    throw error;
  }
}

/** Sync twin of `prefetchTreeBlobs` for the synchronous validator. */
function prefetchTreeBlobsSync(repoPath: string, treeSha: string): Map<string, Buffer> | null {
  if (!SHA1.test(treeSha)) return null;
  try {
    return prefetchTreeBlobsSyncUnchecked(repoPath, treeSha);
  } catch {
    // Best effort: a tree the listing cannot read is reported by the walk.
    return null;
  }
}
function prefetchTreeBlobsSyncUnchecked(repoPath: string, treeSha: string) {
  let total = 0;
  const shas: string[] = [];
  for (const blob of listTreeBlobsSync(repoPath, treeSha)) {
    total += blob.size;
    if (blob.size > KB_TREE_LIMITS.maxMarkdownBytes || total > KB_TREE_LIMITS.maxTreeBytes)
      return null;
    if (shas.length >= KB_TREE_LIMITS.maxEntries) return null;
    shas.push(blob.sha);
  }
  return readObjectsSync(repoPath, shas, {
    maxBytes: KB_TREE_LIMITS.maxMarkdownBytes,
    type: "blob",
  });
}

/** Every blob of a tree in memory, or null when its sizes exceed the tree budgets. */
async function prefetchTreeBlobs(
  repoPath: string,
  treeSha: string,
  options: GitReadOptions,
): Promise<Map<string, Buffer> | null> {
  const { stdout } = await runGitAsync(repoPath, ["ls-tree", "-r", "-l", "-z", treeSha], {
    ...options,
    maxBuffer: KB_TREE_LIMITS.maxEntries * (KB_PATH_LIMITS.maxBytes + 96),
  });
  const shas: string[] = [];
  let total = 0;
  for (const line of stdout.toString().split("\0")) {
    const match = /^[0-9]+ blob ([a-f0-9]{40}) +([0-9]+)\t/.exec(line);
    if (!match) continue;
    const size = Number(match[2]);
    total += size;
    if (size > KB_TREE_LIMITS.maxMarkdownBytes || total > KB_TREE_LIMITS.maxTreeBytes) return null;
    if (shas.length >= KB_TREE_LIMITS.maxEntries) return null;
    shas.push(match[1]!);
  }
  return readBlobsAsync(repoPath, shas, { maxBytes: KB_TREE_LIMITS.maxMarkdownBytes }, options);
}

/** Request-path validator: identical rules, asynchronous reads and bounded CPU steps. */
export async function validateGitCommitAsync(
  options: TreeValidationOptions & GitReadOptions,
  commitSha: string,
): Promise<TreeValidationResult> {
  const lifetime = gitReadOptions(options);
  assertGitReadActive(lifetime);
  if (!SHA1.test(commitSha)) return fail("TREE_BUDGET", "invalid commit sha");
  const budget = freshIncomingBudget();
  try {
    chargeIncomingObject(
      budget,
      commitSha,
      await readObjectSizeBytesAsync(options.repoPath, commitSha, lifetime),
    );
    const treeSha = await readCommitTreeShaAsync(options.repoPath, commitSha, lifetime);
    // One batched read of every blob when the tree is within its byte
    // budgets (a whole-tree check per PR status would otherwise spawn a Git
    // process per file); anything else is read one by one and fails there.
    const cached = await prefetchTreeBlobs(options.repoPath, treeSha, lifetime).catch(() => {
      // Best effort: the walk reports any tree the listing cannot read.
      assertGitReadActive(lifetime);
      return null;
    });
    const source: TreeObjectSource = {
      walkEntries: (sha, walkBudget, incoming) =>
        walkGitTreeEntriesAsync(options.repoPath, sha, walkBudget, lifetime, incoming),
      objectSizeBytes: async (sha) =>
        cached?.get(sha)?.length ?? readObjectSizeBytesAsync(options.repoPath, sha, lifetime),
      blobContent: async (sha, limits) => {
        const bytes = cached?.get(sha);
        return bytes && bytes.length <= limits.maxBytes
          ? bytes
          : readBlobContentAsync(options.repoPath, sha, limits, lifetime);
      },
    };
    const tree = await finishGitReadAsync(
      validateTreeSteps(source, options, treeSha, budget),
      lifetime,
    );
    return tree.ok ? { ok: true, treeSha, commitSha } : tree;
  } catch (error) {
    if (error instanceof TreeReadBudgetError) return fail("TREE_BUDGET", error.message);
    if (error instanceof TreeStructureError) return fail("TREE_PATH", error.message);
    throw error;
  }
}

/**
 * Validate every newly reachable commit between old and new (inclusive of the
 * tip) against one shared incoming-object budget: distinct commits, trees and
 * blobs absent from oldSha's reachable history accumulate across the whole
 * range, so individually valid trees cannot launder an over-budget object set.
 * Per-tree file/content limits remain per commit.
 */
export async function validateNewlyReachableCommits(
  options: TreeValidationOptions,
  input: { oldSha: string; newSha: string },
): Promise<TreeValidationResult> {
  try {
    const commits = listCommitsBetween(
      options.repoPath,
      input.oldSha,
      input.newSha,
      KB_TREE_LIMITS.maxNewCommitsPerPush,
    );
    // Bound each proposed tree's metadata before Git's native object-set walk
    // visits it. The walk below does not read blobs; their incoming byte charge
    // and full content validation still happen together after membership is known.
    for (const commitSha of commits.length > 0 ? commits : [input.newSha]) {
      const metadataBudget = freshIncomingBudget();
      chargeIncomingObject(
        metadataBudget,
        commitSha,
        readObjectSizeBytes(options.repoPath, commitSha),
      );
      walkGitTreeEntries(
        options.repoPath,
        readCommitTreeSha(options.repoPath, commitSha),
        { entries: 0, maxEntries: KB_TREE_LIMITS.maxEntries },
        metadataBudget,
      );
    }
    const budget = freshIncomingBudget(
      await listNewlyReachableObjects(
        options.repoPath,
        input.oldSha,
        input.newSha,
        KB_TREE_LIMITS.maxObjects,
      ),
    );
    const incomingCommits = new Set(commits);
    const validated = new Set<string>();
    const connectedToOld = new Set([input.oldSha]);
    let tip: TreeValidationResult | undefined;
    for (const commitSha of commits) {
      // L-8: parent order must never grant a sealed exemption. Follow parents
      // connected to the branch's old tip; side histories have no branch tip
      // of their own, so every parent is eligible. Only a blob identical at
      // its path in ALL eligible parents is unambiguously unchanged. This
      // also prevents an obsolete ancestor parent from hiding a restoration
      // in side history, even when the final push tip removes the document.
      // Topological order validates every new parent first. Roots have no
      // baseline and every reference in them must be live.
      const parents = readCommitParents(options.repoPath, commitSha);
      if (parents.some((parent) => incomingCommits.has(parent) && !validated.has(parent))) {
        throw new TreeStructureError("commit parent was not validated");
      }
      const commitContext = await options.loadCommitContext?.(commitSha);
      const branchParents = parents.filter((parent) => connectedToOld.has(parent));
      const bases = branchParents.length > 0 ? branchParents : parents;
      const baseBlobs = bases[0]
        ? readCommitBlobs(options.repoPath, bases[0])
        : new Map<string, string>();
      for (const parent of bases.slice(1)) {
        if (baseBlobs.size === 0) break;
        const other = readCommitBlobs(options.repoPath, parent);
        for (const [path, blob] of baseBlobs) {
          if (other.get(path) !== blob) baseBlobs.delete(path);
        }
      }
      const context = {
        ...options,
        ...commitContext,
        baseBlobs,
      };
      const result = validateGitCommit(context, commitSha, budget);
      if (!result.ok) return result;
      validated.add(commitSha);
      if (branchParents.length > 0) connectedToOld.add(commitSha);
      if (commitSha === input.newSha) tip = result;
    }
    // A no-op branch creation/update inherits the already validated old tree.
    // Avoid validating a non-empty range's tip twice with different contexts.
    if (tip) return tip;
    return validateGitCommit(
      {
        ...options,
        ...(await options.loadCommitContext?.(input.newSha)),
        baseBlobs: readCommitBlobs(options.repoPath, input.oldSha),
      },
      input.newSha,
      budget,
    );
  } catch (error) {
    if (error instanceof TreeReadBudgetError) {
      return fail("TREE_BUDGET", error.message);
    }
    if (error instanceof TreeStructureError) {
      return fail("TREE_PATH", error.message);
    }
    throw error;
  }
}

export type PublicationTreeBinding = {
  bindingId: string;
  commitSha: string;
  treeSha: string;
  digest: string;
};

export function createPublicationTreeBinding(
  validation: TreeValidationSuccess,
  commitSha: string,
): PublicationTreeBinding {
  if (!validation.ok || !validation.treeSha) {
    throw new Error("validation must succeed before publication binding");
  }
  if (!SHA1.test(commitSha)) throw new Error("invalid commit sha");
  const digest = createHash("sha256").update(`${validation.treeSha}\0${commitSha}`).digest("hex");
  return {
    bindingId: randomUUID(),
    commitSha,
    treeSha: validation.treeSha,
    digest,
  };
}

export function assertPublicationTreeBinding(
  options: TreeValidationOptions,
  binding: PublicationTreeBinding,
  commitSha: string,
): void {
  if (!SHA1.test(commitSha)) throw new TreePublicationBindingError("invalid commit sha");
  if (binding.commitSha !== commitSha) {
    throw new TreePublicationBindingError("publication commit does not match binding");
  }
  const treeSha = readCommitTreeSha(options.repoPath, commitSha);
  if (treeSha !== binding.treeSha) {
    throw new TreePublicationBindingError("publication tree does not match binding");
  }
  const digest = createHash("sha256").update(`${treeSha}\0${commitSha}`).digest("hex");
  if (digest !== binding.digest) {
    throw new TreePublicationBindingError("publication binding digest mismatch");
  }
  const validation = validateGitTree(options, treeSha);
  if (!validation.ok) {
    throw new TreePublicationBindingError(validation.message);
  }
}

export class TreePublicationBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreePublicationBindingError";
  }
}

export { bodyByteOffsetAfterFrontMatter };

/**
 * The totals whole-tree validation charges for a staged tree, from the same
 * walk (the logical merge's accounting is checked against this).
 */
export function measureStagedTree(staged: {
  objects: StagedObjectSet;
  rootTreeSha: string;
}): TreeTotals {
  const budget = { entries: 0, maxEntries: Number.MAX_SAFE_INTEGER };
  const entries = walkStagedTreeEntries(staged.objects, staged.rootTreeSha, budget);
  let files = 0;
  let treeBytes = 0;
  let manifest: Buffer | null = null;
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const body = staged.objects.get(entry.sha)?.body;
    if (!body) throw new Error("staged blob not found");
    files += 1;
    treeBytes += body.length;
    if (entry.path === ".assets/manifest.json") manifest = body;
  }
  const parsed = manifest ? parseAssetManifest(manifest) : null;
  const manifestEntries = parsed && !("code" in parsed) ? parsed.entries : [];
  return {
    entries: budget.entries,
    files,
    treeBytes,
    manifestEntries: manifestEntries.length,
    manifestBytes: manifest?.length ?? 0,
  };
}
