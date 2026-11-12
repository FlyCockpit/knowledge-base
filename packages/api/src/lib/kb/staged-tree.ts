import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  assertSingleSegmentName,
  chargeIncomingObject,
  type GitReadOptions,
  type GitTreeEntry,
  gitReadCheckpoint,
  type IncomingObjectBudget,
  TreeReadBudgetError,
  TreeStructureError,
  type TreeWalkBudget,
} from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import { decodeUtf8Fatal } from "./parse-markdown";

const SHA1 = /^[0-9a-f]{40}$/;
/** Filesystem allocation granularity used to conservatively admit disk usage. */
const DISK_BLOCK_BYTES = 4096;

export const GIT_IDENTITY_NAME = "knowledge-base";
export const GIT_IDENTITY_EMAIL = "kb@example.invalid";

/**
 * One file of a staged tree. With `blobSha`, the blob already exists in the
 * object store and is referenced as is (its `content` is not hashed).
 */
export type TreeFileInput = { segments: string[]; content: Buffer; blobSha?: string };

export type StagedGitObject = {
  sha: string;
  type: "blob" | "tree" | "commit";
  /** Raw object body without Git's `<type> <len>\0` store header. */
  body: Buffer;
  /** Exact on-disk bytes the durable loose-object writer persists for this object. */
  deflated: Buffer;
};

export type StagedObjectSet = ReadonlyMap<string, StagedGitObject>;

export type StagedCommit = {
  commitSha: string;
  rootTreeSha: string;
  objects: Map<string, StagedGitObject>;
};

type TreeEntryInput = { mode: "100644" | "40000"; name: string; sha: string };

/**
 * Git orders tree entries by raw name bytes, comparing directory names as if
 * they carried a trailing slash — the same rule git itself applies when
 * writing tree objects.
 */
function compareTreeEntryNames(a: TreeEntryInput, b: TreeEntryInput): number {
  const left = Buffer.from(a.mode === "40000" ? `${a.name}/` : a.name, "utf8");
  const right = Buffer.from(b.mode === "40000" ? `${b.name}/` : b.name, "utf8");
  return Buffer.compare(left, right);
}

function encodeTreeObject(entries: readonly TreeEntryInput[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntryNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), Buffer.from(entry.sha, "hex"));
  }
  return Buffer.concat(parts);
}

function stageObject(
  objects: Map<string, StagedGitObject>,
  type: StagedGitObject["type"],
  body: Buffer,
): string {
  const store = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, "utf8"), body]);
  const sha = createHash("sha1").update(store).digest("hex");
  if (!SHA1.test(sha)) throw new Error("invalid object hash");
  if (!objects.has(sha)) {
    objects.set(sha, { sha, type, body, deflated: deflateSync(store) });
  }
  return sha;
}

/**
 * Build the nested tree objects for a flat set of files entirely in memory —
 * the pure twin of the durable writer's tree construction. Identical inputs
 * deterministically produce the object set (and therefore the SHAs) the
 * writer persists.
 */
export function stageTreeForFiles(files: readonly TreeFileInput[]): {
  rootSha: string;
  objects: Map<string, StagedGitObject>;
} {
  const objects = new Map<string, StagedGitObject>();
  // One pass per level: files of this directory, and children grouped by
  // their first segment in insertion order (linear, never re-slicing).
  const build = (remaining: readonly TreeFileInput[]): string => {
    const entries: TreeEntryInput[] = [];
    const groups = new Map<string, TreeFileInput[]>();
    for (const item of remaining) {
      if (item.segments.length === 1) {
        entries.push({
          mode: "100644",
          name: item.segments[0]!,
          sha:
            item.blobSha && SHA1.test(item.blobSha)
              ? item.blobSha
              : stageObject(objects, "blob", item.content),
        });
        continue;
      }
      const name = item.segments[0]!;
      let group = groups.get(name);
      if (!group) {
        group = [];
        groups.set(name, group);
      }
      group.push({
        segments: item.segments.slice(1),
        content: item.content,
        blobSha: item.blobSha,
      });
    }
    for (const [name, group] of groups) entries.push({ mode: "40000", name, sha: build(group) });
    return stageObject(objects, "tree", encodeTreeObject(entries));
  };
  return { rootSha: build(files), objects };
}

/**
 * Stage the complete publication commit — every blob, every rewritten tree,
 * and the commit object itself — without touching the repository, so whole
 * tree validation can run (and reject) before a single byte is durable.
 */
export function stageCommitWithTreeFiles(input: {
  parentSha: string;
  /**
   * Further parents after `parentSha`: a proposal moved onto main keeps its
   * previous head as one, so recorded conflict versions stay reachable.
   */
  extraParents?: readonly string[];
  message: string;
  files: readonly TreeFileInput[];
  timestampSeconds?: number;
}): StagedCommit {
  if (!SHA1.test(input.parentSha)) throw new Error("invalid parent sha");
  const extra = input.extraParents ?? [];
  if (extra.some((sha) => !SHA1.test(sha))) throw new Error("invalid parent sha");
  const { rootSha, objects } = stageTreeForFiles(input.files);
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const identity = `${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}> ${timestamp} +0000`;
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  const body = Buffer.from(
    `tree ${rootSha}\nparent ${input.parentSha}\n${extra.map((sha) => `parent ${sha}\n`).join("")}author ${identity}\ncommitter ${identity}\n\n${message}`,
    "utf8",
  );
  return { commitSha: stageObject(objects, "commit", body), rootTreeSha: rootSha, objects };
}

type StagedTreeChild = { mode: string; type: GitTreeEntry["type"]; sha: string; name: string };

/** Parse one staged tree body back into children: `<mode> <name>\0<20-byte sha>` records. */
function parseStagedTreeChildren(body: Buffer): StagedTreeChild[] {
  const children: StagedTreeChild[] = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const nul = space >= 0 ? body.indexOf(0x00, space + 1) : -1;
    if (space < 0 || nul < 0 || nul + 21 > body.length) {
      throw new Error("staged tree encoding is corrupt");
    }
    const mode = body.toString("ascii", offset, space);
    const sha = body.subarray(nul + 1, nul + 21).toString("hex");
    if (!SHA1.test(sha)) throw new Error("staged tree encoding is corrupt");
    children.push({
      mode,
      type: mode === "40000" ? "tree" : "blob",
      sha,
      name: decodeUtf8Fatal(body.subarray(space + 1, nul)),
    });
    offset = nul + 21;
  }
  return children;
}

/**
 * In-memory twin of `walkGitTreeEntries`: identical depth-first pre-order
 * emission, entry budget charging, duplicate-name, single-segment, depth, and
 * sort-order enforcement — reading staged tree bodies instead of the
 * repository, so whole-tree validation covers exactly the bytes the writer
 * will persist.
 */
export function walkStagedTreeEntries(
  objects: StagedObjectSet,
  treeSha: string,
  budget: TreeWalkBudget,
  incoming?: IncomingObjectBudget,
): GitTreeEntry[] {
  if (!SHA1.test(treeSha)) throw new Error("invalid tree sha");
  const entries: GitTreeEntry[] = [];
  const chargeEntry = (): void => {
    budget.entries += 1;
    if (budget.entries > budget.maxEntries) {
      throw new TreeReadBudgetError("tree exceeds entry budget", {
        size: budget.entries,
        maxBytes: budget.maxEntries,
      });
    }
  };
  const visit = (sha: string, prefix: string, depth: number): void => {
    const object = objects.get(sha);
    if (object?.type !== "tree") throw new Error("staged tree not found");
    if (incoming) chargeIncomingObject(incoming, sha, object.body.length);
    chargeEntry();
    const childNames = new Set<string>();
    let previousSortKey: Buffer | undefined;
    for (const child of parseStagedTreeChildren(object.body)) {
      if (childNames.has(child.name)) {
        throw new TreeStructureError(`duplicate entry name ${child.name} in tree ${sha}`);
      }
      childNames.add(child.name);
      assertSingleSegmentName(child.name);
      if (depth + 1 > KB_TREE_LIMITS.maxTreeDepth) {
        throw new TreeStructureError("tree nesting exceeds depth budget");
      }
      const sortKey = Buffer.from(child.name + (child.type === "tree" ? "/" : ""), "utf8");
      if (previousSortKey && Buffer.compare(previousSortKey, sortKey) >= 0) {
        throw new TreeStructureError(`entry ${child.name} is out of order in tree ${sha}`);
      }
      previousSortKey = sortKey;
      const path = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
      // Git's ls-tree reports tree modes as 040000; mirror that normalization
      // so validation sees the same entry shape it gets from the repository.
      entries.push({
        mode: child.mode === "40000" ? "040000" : child.mode,
        type: child.type,
        sha: child.sha,
        path,
      });
      if (child.type === "tree") {
        visit(child.sha, path, depth + 1);
        continue;
      }
      chargeEntry();
    }
  };
  visit(treeSha, "", 0);
  return entries;
}

export type StagedNewObjectBytes = {
  /** Exact physical bytes materializing this staged set adds to the object store. */
  physicalBytes: bigint;
  /** The same objects rounded up to filesystem block allocation, for disk admission. */
  diskFloorBytes: bigint;
};

/**
 * Measure what materializing this staged set would add to the canonical
 * repository. A staged object whose loose file is already present adds
 * nothing; an absent object contributes exactly the deflated bytes the writer
 * persists (a packed duplicate still gains a new loose file, so it counts).
 */
export function stagedNewObjectBytes(repo: string, objects: StagedObjectSet): StagedNewObjectBytes {
  let physicalBytes = 0n;
  let diskFloorBytes = 0n;
  for (const object of objects.values()) {
    if (existsSync(join(repo, "objects", object.sha.slice(0, 2), object.sha.slice(2)))) continue;
    physicalBytes += BigInt(object.deflated.length);
    diskFloorBytes += BigInt(
      Math.ceil(object.deflated.length / DISK_BLOCK_BYTES) * DISK_BLOCK_BYTES,
    );
  }
  return { physicalBytes, diskFloorBytes };
}

export async function stagedNewObjectBytesAsync(
  repo: string,
  objects: StagedObjectSet,
  options: GitReadOptions,
): Promise<StagedNewObjectBytes> {
  let physicalBytes = 0n;
  let diskFloorBytes = 0n;
  for (const object of objects.values()) {
    await gitReadCheckpoint(options);
    try {
      await access(join(repo, "objects", object.sha.slice(0, 2), object.sha.slice(2)));
      continue;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    physicalBytes += BigInt(object.deflated.length);
    diskFloorBytes += BigInt(
      Math.ceil(object.deflated.length / DISK_BLOCK_BYTES) * DISK_BLOCK_BYTES,
    );
  }
  return { physicalBytes, diskFloorBytes };
}
