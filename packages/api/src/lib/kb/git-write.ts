import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflate, inflateSync } from "node:zlib";

import {
  assertGitReadActive,
  type GitReadOptions,
  gitReadCheckpoint,
  hardenedGitEnv,
  kbBareRepoPath,
  readCommitTreeSha,
  readCommitTreeShaAsync,
  runGit,
} from "./git-read";
import { KB_MANAGED_GITIGNORE } from "./paths";
import {
  GIT_IDENTITY_EMAIL,
  GIT_IDENTITY_NAME,
  type StagedGitObject,
  stageTreeForFiles,
  type TreeFileInput,
} from "./staged-tree";
import {
  assertPublicationTreeBinding,
  createPublicationTreeBinding,
  type PublicationTreeBinding,
  type TreeValidationOptions,
  type TreeValidationSuccess,
  validateGitCommit,
  validateGitCommitAsync,
  validateStagedCommitTree,
} from "./validate-tree";

const SHA1 = /^[0-9a-f]{40}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_REF = "0".repeat(40);

/** Thrown by executors when a mutating Git command exits nonzero. */
export class GitCommandError extends Error {
  readonly status: number;
  constructor(command: string, status: number) {
    super(`git ${command} exited with status ${status}`);
    this.name = "GitCommandError";
    this.status = status;
  }
}

/**
 * Supervised transport for every mutating Git command. Implementations spawn
 * Git through the server coordinator's mutating-child fence (coordinator-
 * issued capability, child drained before the operation fence is released)
 * and reject with GitCommandError on any nonzero exit. Mutating commands never
 * depend on stdout: commits are written as loose objects in-process and ref
 * transitions are proven by CAS exit status plus read-back. There is no
 * unsupervised fallback.
 */
export type GitMutatingExecutor = {
  exec(input: {
    cwd: string;
    /** Complete argv; argv[0] is the git binary. */
    argv: readonly string[];
    env: NodeJS.ProcessEnv;
  }): Promise<void> | void;
};

export type GitRunOptions = {
  reposDir: string;
  kbId: string;
  executor: GitMutatingExecutor;
};

function repoPath(options: Pick<GitRunOptions, "reposDir" | "kbId">): string {
  return kbBareRepoPath(options.reposDir, options.kbId);
}

function assertGitArgv(argv: readonly string[]): void {
  if (argv.some((arg) => arg.includes("\0"))) throw new Error("refusing git argv with NUL");
}

async function gitMutate(
  options: GitRunOptions,
  cwd: string,
  argv: readonly string[],
): Promise<void> {
  assertGitArgv(argv);
  const result = options.executor.exec({ cwd, argv: ["git", ...argv], env: hardenedGitEnv() });
  if (result instanceof Promise) await result;
}

async function configureRepoDurability(options: GitRunOptions, repo: string): Promise<void> {
  // `core.fsync=all` covers loose objects; the deprecated `core.fsyncObjectFiles`
  // key makes every client fetch print a `remote: warning`.
  await gitMutate(options, options.reposDir, ["--git-dir", repo, "config", "core.fsync", "all"]);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncFileAndParentDirs(filePath: string, repoRoot: string): void {
  fsyncFile(filePath);
  let dir = dirname(filePath);
  while (dir.length >= repoRoot.length && dir.startsWith(repoRoot)) {
    // Directory entries are part of the durability contract. EIO, ENOSPC,
    // permission errors and unsupported directory fsync all fail publication.
    fsyncFile(dir);
    if (dir === repoRoot) break;
    dir = dirname(dir);
  }
  fsyncFile(dirname(repoRoot));
}

function fsyncBareRef(repo: string, refName: string): void {
  if (!refName.startsWith("refs/")) throw new Error("ref must be fully qualified");
  const looseRef = join(repo, refName);
  try {
    fsyncFileAndParentDirs(looseRef, repo);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  // Some Git versions may record a new nested ref only in packed-refs initially.
  const packed = join(repo, "packed-refs");
  try {
    fsyncFile(packed);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let dir = dirname(looseRef);
  while (dir.length >= repo.length && dir.startsWith(repo)) {
    try {
      fsyncFile(dir);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      break;
    }
    if (dir === repo) break;
    dir = dirname(dir);
  }
  fsyncFile(dirname(repo));
}

/** Write a Git loose object (zlib of `<type> <len>\0< body>`) and fsync it. */
function writeLooseObject(repo: string, type: string, body: Buffer): string {
  const store = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, "utf8"), body]);
  const sha = createHash("sha1").update(store).digest("hex");
  if (!SHA1.test(sha)) throw new Error("invalid object hash");
  return writeLooseObjectEncoded(repo, {
    sha,
    type,
    body,
    deflated: deflateSync(store),
  });
}

function writeLooseObjectEncoded(
  repo: string,
  object: { sha: string; type: string; body: Buffer; deflated: Buffer },
  created?: string[],
): string {
  const dir = join(repo, "objects", object.sha.slice(0, 2));
  const file = join(dir, object.sha.slice(2));
  mkdirSync(dir, { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(file, "wx");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    // Existence is not proof of a complete or durable earlier write. Refuse a
    // partial/corrupt object, and resync verified bytes and every directory.
    const store = Buffer.concat([
      Buffer.from(`${object.type} ${object.body.length}\0`, "utf8"),
      object.body,
    ]);
    const existing = inflateSync(readFileSync(file), { maxOutputLength: store.length + 1 });
    if (!existing.equals(store)) throw new Error("existing loose object does not match its hash");
  }
  if (fd !== undefined) {
    try {
      // Record ownership immediately after exclusive creation, before writing
      // or syncing can fail. The caller can reclaim even a partial last file.
      created?.push(object.sha);
      writeFileSync(fd, object.deflated);
    } finally {
      closeSync(fd);
    }
  }
  fsyncFileAndParentDirs(file, repo);
  return object.sha;
}

/**
 * Materialize a staged, pre-validated object set through the durable
 * loose-object writer. Returns exactly the objects whose loose files this
 * call created — the set a failed publication may reclaim. A supplied sink is
 * updated incrementally, including a partial file if writing or syncing fails.
 */
export function writeStagedObjects(
  repo: string,
  objects: ReadonlyMap<string, StagedGitObject>,
  created: string[] = [],
): string[] {
  for (const object of objects.values()) {
    writeLooseObjectEncoded(repo, object, created);
  }
  return created;
}

const inflateObjectAsync = promisify(inflate);
async function syncFileAsync(path: string): Promise<void> {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncFileAndParentsAsync(
  file: string,
  root: string,
  options: GitReadOptions,
): Promise<void> {
  await syncFileAsync(file);
  await gitReadCheckpoint(options);
  let dir = dirname(file);
  while (dir.length >= root.length && dir.startsWith(root)) {
    await syncFileAsync(dir);
    await gitReadCheckpoint(options);
    if (dir === root) break;
    dir = dirname(dir);
  }
  await syncFileAsync(dirname(root));
  await gitReadCheckpoint(options);
}
/** PR preparation retains its lease through every write/fsync, including an
 * aborted pending I/O. The incremental created set owns partial error cleanup. */
export async function writeStagedObjectsAsync(
  repo: string,
  objects: ReadonlyMap<string, StagedGitObject>,
  created: string[],
  options: GitReadOptions,
  // Only objects witnessed in a published parent under the same KB lease.
  // Unreferenced leftovers still require their own content durability barrier.
  durableObjects: ReadonlySet<string> = new Set(),
): Promise<void> {
  const entries = [...objects.values()];
  const directories = new Map<string, Promise<unknown>>();
  const dirtyDirectories = new Set<string>();
  // Bound descriptors and pending I/O. Every batch joins even rejected writes
  // before abort cleanup or the per-KB lease can be released.
  const batchSize = 32;
  for (let offset = 0; offset < entries.length; offset += batchSize) {
    await gitReadCheckpoint(options);
    const results = await Promise.allSettled(
      entries.slice(offset, offset + batchSize).map(async (object) => {
        assertGitReadActive(options);
        const dir = join(repo, "objects", object.sha.slice(0, 2));
        const path = join(dir, object.sha.slice(2));
        let ready = directories.get(dir);
        if (!ready) {
          ready = mkdir(dir, { recursive: true });
          directories.set(dir, ready);
        }
        await ready;
        assertGitReadActive(options);
        let file: Awaited<ReturnType<typeof open>> | undefined;
        try {
          file = await open(path, "wx");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          const compressed = await readFile(path);
          // Staged bytes normally match the prior publication exactly. Avoid
          // queuing another inflate per unchanged object on the fsync pool.
          if (!compressed.equals(object.deflated)) {
            const expected = Buffer.concat([
              Buffer.from(`${object.type} ${object.body.length}\0`),
              object.body,
            ]);
            const existing = await inflateObjectAsync(compressed, {
              maxOutputLength: expected.length + 1,
            });
            if (!existing.equals(expected))
              throw new Error("existing loose object does not match its hash");
          }
        }
        if (file) {
          dirtyDirectories.add(dir);
          created.push(object.sha);
          try {
            assertGitReadActive(options);
            await file.writeFile(object.deflated);
            await file.sync();
          } finally {
            await file.close();
          }
        } else if (!durableObjects.has(object.sha)) {
          // Valid unreferenced bytes may be an interrupted writer's inode too.
          dirtyDirectories.add(dir);
          await syncFileAsync(path);
        }
      }),
    );
    assertGitReadActive(options);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  if (dirtyDirectories.size === 0) return;
  // All contents precede their fanout entries; sibling directory barriers can
  // share a filesystem journal commit. Each level drains before its parent.
  const fanouts = [...dirtyDirectories];
  for (let offset = 0; offset < fanouts.length; offset += batchSize) {
    const results = await Promise.allSettled(
      fanouts.slice(offset, offset + batchSize).map(syncFileAsync),
    );
    assertGitReadActive(options);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  for (const directory of [join(repo, "objects"), repo, dirname(repo)]) {
    await syncFileAsync(directory);
    await gitReadCheckpoint(options);
  }
}

export async function removeLooseObjectsAsync(
  repo: string,
  shas: readonly string[],
): Promise<void> {
  for (const sha of shas) {
    const file = join(repo, "objects", sha.slice(0, 2), sha.slice(2));
    try {
      await unlink(file);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) continue;
    }
    // Match synchronous reclaim durability. Cleanup stays joined after abort;
    // failed reclamation retains unreachable garbage, never changes refs.
    try {
      await syncFileAsync(dirname(file));
    } catch {
      /* best-effort reclaim */
    }
  }
}

/**
 * Best-effort reclaim of operation-owned loose objects after a publication
 * aborts before its ref update: the files were created by this operation and
 * nothing references them, so removing them restores the pre-operation store.
 * Only ever call with the `created` set populated by writeStagedObjects, under
 * the per-KB operation lock, before any ref has moved to these objects.
 */
export function removeLooseObjects(repo: string, shas: readonly string[]): void {
  for (const sha of shas) {
    const file = join(repo, "objects", sha.slice(0, 2), sha.slice(2));
    try {
      unlinkSync(file);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) continue;
    }
    try {
      // Deletion durability mirrors the write path: sync the directory that
      // held the entry. Failures leave unreachable garbage, never corruption.
      fsyncFile(dirname(file));
    } catch {
      // Reclaim is best effort; the publication error is the one to report.
    }
  }
}

export async function initBareKbRepo(options: GitRunOptions): Promise<string> {
  const path = repoPath(options);
  mkdirSync(options.reposDir, { recursive: true });
  await gitMutate(options, options.reposDir, ["init", "--bare", "--initial-branch=main", path]);
  await gitMutate(options, options.reposDir, [
    "--git-dir",
    path,
    "config",
    "receive.denyNonFastForwards",
    "true",
  ]);
  await gitMutate(options, options.reposDir, [
    "--git-dir",
    path,
    "config",
    "receive.denyDeletes",
    "true",
  ]);
  await gitMutate(options, options.reposDir, ["--git-dir", path, "config", "gc.auto", "0"]);
  await gitMutate(options, options.reposDir, [
    "--git-dir",
    path,
    "config",
    "maintenance.auto",
    "false",
  ]);
  await gitMutate(options, options.reposDir, [
    "--git-dir",
    path,
    "config",
    "core.useReplaceRefs",
    "false",
  ]);
  await configureRepoDurability(options, path);
  return path;
}

/** The canonical initial `main` tree; exported so git fixtures build on the real layout. */
export function initialMainTreeFiles(description: string): TreeFileInput[] {
  return [
    {
      segments: ["index.md"],
      content: Buffer.from(`# Knowledge base\n\n${description}\n`, "utf8"),
    },
    { segments: [".gitignore"], content: Buffer.from(KB_MANAGED_GITIGNORE, "utf8") },
    {
      segments: [".assets", "manifest.json"],
      content: Buffer.from('{"version":1,"entries":[]}\n', "utf8"),
    },
  ];
}

/** Durable loose objects only — repo must already be a bare git directory; no ref movement. */
export async function writeInitialMainCommitLoose(
  repo: string,
  input: { message: string; description: string },
  options: GitReadOptions = {},
): Promise<{ headSha: string; binding: PublicationTreeBinding }> {
  const staged = stageTreeForFiles(initialMainTreeFiles(input.description));
  const timestamp = Math.floor(Date.now() / 1000);
  const identity = `${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}> ${timestamp} +0000`;
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  const commitBody = Buffer.from(
    `tree ${staged.rootSha}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`,
    "utf8",
  );
  const store = Buffer.concat([Buffer.from(`commit ${commitBody.length}\0`), commitBody]);
  const sha = createHash("sha1").update(store).digest("hex");
  staged.objects.set(sha, {
    sha,
    type: "commit",
    body: commitBody,
    deflated: deflateSync(store),
  });
  const validation = validateStagedCommitTree({
    objects: staged.objects,
    rootTreeSha: staged.rootSha,
    commitSha: sha,
  });
  if (!validation.ok) {
    throw new Error(`initial tree failed validation: ${validation.message}`);
  }
  // Flush sibling contents/fanouts together, then each ancestor once. The
  // synchronous per-object writer repeated every ancestor barrier and stalled
  // the server event loop for entire filesystem journal commits under load.
  const created: string[] = [];
  try {
    await writeStagedObjectsAsync(repo, staged.objects, created, options);
  } catch (error) {
    await removeLooseObjectsAsync(repo, created);
    throw error;
  }
  return { headSha: sha, binding: createPublicationTreeBinding(validation, sha) };
}

export async function publishInitialMainRef(
  options: GitRunOptions,
  input: { headSha: string; binding: PublicationTreeBinding },
  readOptions: GitReadOptions = {},
): Promise<void> {
  await fsyncRefUpdate(options, {
    refName: "refs/heads/main",
    newSha: input.headSha,
    oldSha: null,
    binding: input.binding,
    readOptions,
  });
}

export async function writeInitialMainCommit(
  options: GitRunOptions,
  input: { message: string; description: string },
  readOptions: GitReadOptions = {},
): Promise<string> {
  await initBareKbRepo(options);
  const publication = await writeInitialMainCommitLoose(repoPath(options), input, readOptions);
  await publishInitialMainRef(options, publication, readOptions);
  return publication.headSha;
}

/**
 * Create the publication commit as a loose object in-process. The object —
 * plus the empty tree it points at — is fsynced before the caller may persist
 * COMMITTING, so a CAS can never target an object that is not yet durable.
 * No subprocess is involved, so no supervised stdout capture is required.
 */
export async function createEmptyTreeCommit(
  options: Pick<GitRunOptions, "reposDir" | "kbId">,
  input: { parentSha: string; message: string; timestampSeconds?: number },
): Promise<string> {
  const repo = repoPath(options);
  if (!SHA1.test(input.parentSha)) throw new Error("invalid parent sha");
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  const identity = `${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}> ${timestamp} +0000`;
  const body = Buffer.from(
    `tree ${EMPTY_TREE}\nparent ${input.parentSha}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`,
    "utf8",
  );
  writeLooseObject(repo, "tree", Buffer.alloc(0));
  return writeLooseObject(repo, "commit", body);
}

/** Reuses the parent tree so journal-style publications keep a valid KB layout. */
export async function createTreeReuseCommit(
  options: Pick<GitRunOptions, "reposDir" | "kbId">,
  input: { parentSha: string; message: string; timestampSeconds?: number },
): Promise<string> {
  const repo = repoPath(options);
  if (!SHA1.test(input.parentSha)) throw new Error("invalid parent sha");
  const treeSha = readCommitTreeSha(repo, input.parentSha);
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const message = input.message.endsWith("\n") ? input.message : `${input.message}\n`;
  const identity = `${GIT_IDENTITY_NAME} <${GIT_IDENTITY_EMAIL}> ${timestamp} +0000`;
  const body = Buffer.from(
    `tree ${treeSha}\nparent ${input.parentSha}\nauthor ${identity}\ncommitter ${identity}\n\n${message}`,
    "utf8",
  );
  return writeLooseObject(repo, "commit", body);
}

export function validateProposedCommitTree(
  repoPath: string,
  commitSha: string,
  options?: Omit<TreeValidationOptions, "repoPath">,
): TreeValidationSuccess {
  const result = validateGitCommit({ repoPath, ...options }, commitSha);
  if (!result.ok) throw new Error(result.message);
  return result;
}

export function bindValidatedTreeForPublication(
  validation: TreeValidationSuccess,
  commitSha: string,
): PublicationTreeBinding {
  return createPublicationTreeBinding(validation, commitSha);
}

export async function fsyncRefUpdateWithBinding(
  options: GitRunOptions,
  input: {
    refName: string;
    newSha: string;
    oldSha: string | null;
    binding: PublicationTreeBinding;
    validation?: Omit<TreeValidationOptions, "repoPath">;
  },
): Promise<void> {
  return fsyncRefUpdate(options, input);
}

export async function fsyncRefUpdate(
  options: GitRunOptions,
  input: {
    refName: string;
    newSha: string;
    oldSha: string | null;
    binding: PublicationTreeBinding;
    validation?: Omit<TreeValidationOptions, "repoPath">;
    readOptions?: GitReadOptions;
  },
): Promise<void> {
  const repo = repoPath(options);
  if (input.readOptions) {
    const lifetime = input.readOptions;
    assertGitReadActive(lifetime);
    const treeSha = await readCommitTreeShaAsync(repo, input.newSha, lifetime);
    const binding = input.binding;
    const digest = createHash("sha256").update(`${treeSha}\0${input.newSha}`).digest("hex");
    if (
      binding.commitSha !== input.newSha ||
      binding.treeSha !== treeSha ||
      binding.digest !== digest
    )
      throw new Error("publication tree binding mismatch");
    const validation = await validateGitCommitAsync(
      { repoPath: repo, ...input.validation, ...lifetime },
      input.newSha,
    );
    if (!validation.ok) throw new Error(validation.message);
    assertGitReadActive(lifetime);
  } else {
    assertPublicationTreeBinding(
      { repoPath: repo, ...input.validation },
      input.binding,
      input.newSha,
    );
  }
  await casRefUpdate(options, {
    refName: input.refName,
    newSha: input.newSha,
    oldSha: input.oldSha,
    readOptions: input.readOptions,
  });
}

async function casRefUpdate(
  options: GitRunOptions,
  input: { refName: string; newSha: string; oldSha: string | null; readOptions?: GitReadOptions },
): Promise<void> {
  const repo = repoPath(options);
  if (!input.refName.startsWith("refs/")) throw new Error("ref must be fully qualified");
  if (!SHA1.test(input.newSha)) throw new Error("invalid new sha");
  if (input.oldSha !== null && !SHA1.test(input.oldSha)) throw new Error("invalid old sha");
  const expectedOld = input.oldSha ?? ZERO_REF;
  try {
    await gitMutate(options, options.reposDir, [
      "--git-dir",
      repo,
      "update-ref",
      input.refName,
      input.newSha,
      expectedOld,
    ]);
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new Error(`ref cas rejected: ${error.message}`);
    }
    throw error;
  }
  if (input.readOptions) {
    // CAS may already be durable: drain all ref barriers even if cancelled;
    // the journal owns recovery if the total budget expired after publication.
    const loose = join(repo, input.refName);
    try {
      await syncFileAndParentsAsync(loose, repo, {});
    } catch (error) {
      // A ref Git recorded only in packed-refs.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await syncFileAndParentsAsync(join(repo, "packed-refs"), repo, {});
    }
    assertGitReadActive(input.readOptions);
  } else fsyncBareRef(repo, input.refName);
}

/** Recovery must establish durability even if the previous CAS returned an fsync error. */
export function fsyncPublishedRef(
  options: Pick<GitRunOptions, "reposDir" | "kbId">,
  refName: string,
): void {
  fsyncBareRef(repoPath(options), refName);
}

/**
 * Only call under the server volume fence and the per-KB operation/advisory
 * locks, before spawning a new writer. Entry to that operation gate proves
 * the preceding writer's entire process tree has drained (or seals the gate
 * on an unconfirmed drain). Lock age or PID liveness is never sufficient.
 * These are Git's disposable publication locks, never the supervisor's flock
 * inode. Updating main also locks HEAD for its symbolic-ref/reflog update.
 */
export function removeAbandonedPublicationLocks(
  options: Pick<GitRunOptions, "reposDir" | "kbId"> & { refNames?: readonly string[] },
): void {
  const repo = repoPath(options);
  const fds: number[] = [];
  try {
    // Open each generated directory without following symlinks. Linux's fd
    // paths keep unlink and fsync anchored to the same directory inode.
    let path = options.reposDir;
    for (const segment of [null, basename(repo), "refs", "heads"]) {
      if (segment !== null) path = `/proc/self/fd/${fds.at(-1)}/${segment}`;
      let fd: number;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        // CREATING repositories may not have reached directory creation yet.
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      fds.push(fd);
    }
    const locks = [
      { parent: fds[1]!, name: "HEAD.lock" },
      { parent: fds[3]!, name: "main.lock" },
    ];
    const parents = [fds[1]!, fds[3]!];
    // Auto-proposals publish nested refs. Keep this directory fd-anchored too,
    // and sync it even if a previous recovery unlinked its last stale lock.
    let proposals: number | undefined;
    try {
      proposals = openSync(
        `/proc/self/fd/${fds[3]}/pr`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (proposals !== undefined) {
      fds.push(proposals);
      parents.push(proposals);
      for (const name of readdirSync(`/proc/self/fd/${proposals}`)) {
        if (name.endsWith(".lock")) locks.push({ parent: proposals, name });
      }
    }
    // User-ref locks are named by durable intents; never sweep unrelated locks.
    for (const ref of new Set(options.refNames ?? [])) {
      if (ref === "refs/heads/main" || ref.startsWith("refs/heads/pr/")) continue;
      if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]{0,190}$/.test(ref) || ref.includes(".."))
        throw new Error("invalid journal ref");
      const parts = ref.slice("refs/heads/".length).split("/");
      let parent = fds[3]!;
      for (const part of parts.slice(0, -1)) {
        try {
          parent = openSync(
            `/proc/self/fd/${parent}/${part}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          fds.push(parent);
          parents.push(parent);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          parent = -1;
          break;
        }
      }
      if (parent !== -1) locks.push({ parent, name: `${parts.at(-1)}.lock` });
    }
    for (const { parent, name } of locks) {
      const lock = `/proc/self/fd/${parent}/${name}`;
      try {
        if (!lstatSync(lock).isFile()) throw new Error("unexpected Git ref lock file type");
        unlinkSync(lock);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    // Sync even when absent: a previous unlink may have succeeded before its
    // directory sync failed. Do not let that retry declare recovery complete.
    for (const parent of parents) fsyncSync(parent);
  } finally {
    for (const fd of fds.reverse()) closeSync(fd);
  }
}

export async function removeAbandonedPublicationLocksAsync(
  options: Pick<GitRunOptions, "reposDir" | "kbId"> & { refNames?: readonly string[] },
  lifetime: GitReadOptions,
): Promise<void> {
  const repo = repoPath(options);
  const handles: FileHandle[] = [];
  const fds: number[] = [];
  const openDir = async (path: string, flags: number) => {
    const handle = await open(path, flags);
    handles.push(handle);
    await gitReadCheckpoint(lifetime);
    return handle.fd;
  };
  try {
    // Open each generated directory without following symlinks. Linux's fd
    // paths keep unlink and fsync anchored to the same directory inode.
    let path = options.reposDir;
    for (const segment of [null, basename(repo), "refs", "heads"]) {
      if (segment !== null) path = `/proc/self/fd/${fds.at(-1)}/${segment}`;
      let fd: number;
      try {
        fd = await openDir(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        // CREATING repositories may not have reached directory creation yet.
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      fds.push(fd);
    }
    const locks = [
      { parent: fds[1]!, name: "HEAD.lock" },
      { parent: fds[3]!, name: "main.lock" },
    ];
    const parents = [fds[1]!, fds[3]!];
    // Auto-proposals publish nested refs. Keep this directory fd-anchored too,
    // and sync it even if a previous recovery unlinked its last stale lock.
    let proposals: number | undefined;
    try {
      proposals = await openDir(
        `/proc/self/fd/${fds[3]}/pr`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (proposals !== undefined) {
      fds.push(proposals);
      parents.push(proposals);
      for (const name of await readdir(`/proc/self/fd/${proposals}`)) {
        if (name.endsWith(".lock")) locks.push({ parent: proposals, name });
      }
    }
    // User-ref locks are named by durable intents; never sweep unrelated locks.
    for (const ref of new Set(options.refNames ?? [])) {
      if (ref === "refs/heads/main" || ref.startsWith("refs/heads/pr/")) continue;
      if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]{0,190}$/.test(ref) || ref.includes(".."))
        throw new Error("invalid journal ref");
      const parts = ref.slice("refs/heads/".length).split("/");
      let parent = fds[3]!;
      for (const part of parts.slice(0, -1)) {
        try {
          parent = await openDir(
            `/proc/self/fd/${parent}/${part}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          fds.push(parent);
          parents.push(parent);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          parent = -1;
          break;
        }
      }
      if (parent !== -1) locks.push({ parent, name: `${parts.at(-1)}.lock` });
    }
    for (const { parent, name } of locks) {
      const lock = `/proc/self/fd/${parent}/${name}`;
      try {
        if (!(await lstat(lock)).isFile()) throw new Error("unexpected Git ref lock file type");
        await unlink(lock);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    // Sync even when absent: a previous unlink may have succeeded before its
    // directory sync failed. Do not let that retry declare recovery complete.
    for (const parent of parents) {
      await handles.find((h) => h.fd === parent)!.sync();
      await gitReadCheckpoint(lifetime);
    }
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export function objectExists(
  options: Pick<GitRunOptions, "reposDir" | "kbId">,
  sha: string,
): boolean {
  const repo = repoPath(options);
  try {
    runGit(repo, ["cat-file", "-e", `${sha}^{commit}`], hardenedGitEnv());
    return true;
  } catch {
    return false;
  }
}

export async function fsyncPublishedRefAsync(
  options: Pick<GitRunOptions, "reposDir" | "kbId">,
  refName: string,
  lifetime: GitReadOptions,
): Promise<void> {
  const repo = repoPath(options);
  try {
    await syncFileAndParentsAsync(join(repo, refName), repo, lifetime);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await syncFileAndParentsAsync(join(repo, "packed-refs"), repo, lifetime);
  }
}
