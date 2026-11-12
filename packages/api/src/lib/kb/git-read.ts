import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldToLoop } from "node:timers/promises";

import { KbDomainError } from "./errors";
import { KB_TREE_LIMITS } from "./limits";
import { decodeUtf8Fatal } from "./parse-markdown";
import { KB_PATH_LIMITS } from "./paths";

const KB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA1 = /^[0-9a-f]{40}$/;

export function assertKbId(kbId: string): void {
  if (!KB_ID.test(kbId)) throw new Error(`invalid kb id ${kbId}`);
}

export function kbBareRepoPath(reposDir: string, kbId: string): string {
  assertKbId(kbId);
  return join(reposDir, `kb_${kbId}.git`);
}

// Explicit hook-only context; ordinary reads never inherit ambient Git quarantine variables.
const quarantine = new AsyncLocalStorage<{
  GIT_OBJECT_DIRECTORY: string;
  GIT_ALTERNATE_OBJECT_DIRECTORIES: string;
}>();
export function withGitQuarantine<T>(objects: string, canonicalObjects: string, run: () => T): T {
  return quarantine.run(
    { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: canonicalObjects },
    run,
  );
}

let resolvedGit: string | undefined;
/**
 * The git binary the server's children run: the first executable `git` on the
 * process's own PATH, resolved once to an absolute path. The smart-HTTP
 * backend spawns exactly this binary (its environment has a fixed PATH), so
 * receive-pack, its hook and every in-process read use one git.
 */
export function gitBinary(): string {
  resolvedGit ??= findGitOnPath(process.env.PATH);
  return resolvedGit;
}

/** The first executable `git` file in the absolute entries of a PATH value. */
export function findGitOnPath(path: string | undefined): string {
  for (const dir of (path ?? "").split(":")) {
    if (!dir.startsWith("/")) continue;
    const candidate = join(dir, "git");
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  throw new KbDomainError("STORAGE_UNAVAILABLE", "git is not on PATH");
}

export function hardenedGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...quarantine.getStore(),
    // Caller-controlled first: a test may point PATH/HOME at fixtures.
    ...extra,
    PATH: extra?.PATH ?? process.env.PATH,
    HOME: extra?.HOME ?? process.env.HOME,
    // Hardening last: ambient config, credentials, and prompts stay disabled
    // even if a caller passes a wider environment. Replacement refs are part
    // of the same hardening: authority reads must interpret the requested
    // object, never a planted refs/replace/* substitute.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_AUTHOR_NAME: "knowledge-base",
    GIT_AUTHOR_EMAIL: "kb@example.invalid",
    GIT_COMMITTER_NAME: "knowledge-base",
    GIT_COMMITTER_EMAIL: "kb@example.invalid",
  };
}

export function runGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = hardenedGitEnv(),
): string {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("refusing git argv with NUL");
  return execFileSync("git", [...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export type GitReadOptions = { signal?: AbortSignal; deadlineAt?: number };

/** Pin once at the operation entry, then carry the same total budget through every child. */
export function gitReadOptions(
  options: GitReadOptions = {},
): GitReadOptions & { deadlineAt: number } {
  return {
    signal: options.signal,
    deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + 60_000),
  };
}

export function assertGitReadActive(options: GitReadOptions): void {
  if (options.signal?.aborted) {
    if (
      (options.signal.reason instanceof DOMException &&
        options.signal.reason.name === "TimeoutError") ||
      (options.signal.reason &&
        typeof options.signal.reason === "object" &&
        "code" in options.signal.reason &&
        options.signal.reason.code === "DEADLINE_EXCEEDED")
    )
      throw new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded");
    throw new KbDomainError("CANCELLED", "Cancelled");
  }
  if (Date.now() >= (options.deadlineAt ?? Infinity))
    throw new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded");
}

/**
 * Kill an owned Git child on cancellation or at the deadline, and record which
 * one happened. A killed child's outcome is classified by that recorded cause,
 * never inferred afterwards from the wall clock (a timer can fire before
 * Date.now() reaches the deadline, and the clock can move) or from the order
 * in which exit, stdio drain and stream errors were observed.
 */
function ownGitChildLifetime(lifetime: GitReadOptions & { deadlineAt: number }, kill: () => void) {
  let deadlineKilled = false;
  const onAbort = () => kill();
  const timer = setTimeout(
    () => {
      deadlineKilled = true;
      kill();
    },
    Math.max(1, lifetime.deadlineAt - Date.now()),
  );
  timer.unref();
  lifetime.signal?.addEventListener("abort", onAbort, { once: true });
  if (lifetime.signal?.aborted) onAbort();
  return {
    /** After the child closed: a deadline kill is DEADLINE_EXCEEDED whatever else failed. */
    assertActive(): void {
      if (deadlineKilled) throw new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded");
      assertGitReadActive(lifetime);
    },
    release(): void {
      clearTimeout(timer);
      lifetime.signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Own the native read until close (exit and stdio drain), even on abort or timeout.
 * Input is complete at spawn: send it and EOF, or immediate EOF when omitted.
 * Interactive streaming belongs in a dedicated helper such as readBlobsAsync.
 */
export async function runGitAsync(
  cwd: string,
  args: readonly string[],
  options: GitReadOptions & {
    env?: NodeJS.ProcessEnv;
    /** Complete bounded plumbing input; omitted input means an empty stream. */
    input?: string | Buffer;
    encoding?: "utf8" | "buffer";
    maxBuffer?: number;
    /** Non-zero exit codes that are results, not failures (e.g. merge-tree's 1 = conflicts). */
    resultExitCodes?: readonly number[];
  } = {},
): Promise<{ stdout: string | Buffer; stderr: string; exitCode?: number }> {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("refusing git argv with NUL");
  const lifetime = gitReadOptions(options);
  assertGitReadActive(lifetime);
  let finish!: (value: {
    error: Error | null;
    stdout: string | Buffer;
    stderr: string | Buffer;
  }) => void;
  const result = new Promise<{
    error: Error | null;
    stdout: string | Buffer;
    stderr: string | Buffer;
  }>((resolve) => {
    finish = resolve;
  });
  const child = execFile(
    "git",
    [...args],
    {
      cwd,
      env: options.env ?? hardenedGitEnv(),
      encoding: options.encoding ?? "utf8",
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      // execFile also kills on output overflow. That path must not depend on SIGTERM cooperation.
      killSignal: "SIGKILL",
    },
    (error, stdout, stderr) => finish({ error, stdout, stderr }),
  );
  // Node's abort callback can precede exit. Never use its promise rejection as proof of drain.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.stdin?.on("error", () => {}); // A failed child may close stdin before consuming it.
  child.stdin?.end(options.input);
  const owner = ownGitChildLifetime(lifetime, () => child.kill("SIGKILL"));
  try {
    const [output] = await Promise.all([result, closed]);
    owner.assertActive();
    if (output.error) {
      const code = (output.error as { code?: unknown }).code;
      if (typeof code === "number" && options.resultExitCodes?.includes(code))
        return { stdout: output.stdout, stderr: output.stderr.toString(), exitCode: code };
      throw output.error;
    }
    return { stdout: output.stdout, stderr: output.stderr.toString(), exitCode: 0 };
  } finally {
    owner.release();
  }
}

/** Shared traversal/validation steps preserve the synchronous hook rules while
 * request paths await native I/O and yield between bounded CPU work units. */
export type GitReadSteps<T> = Generator<Promise<void> | undefined, T>;
export function* gitReadStep<T>(value: T | Promise<T>): GitReadSteps<T> {
  if (!(value instanceof Promise)) return value;
  let result!: T;
  yield value.then((v) => {
    result = v;
  });
  return result;
}
export function finishGitReadSync<T>(steps: GitReadSteps<T>): T {
  let next = steps.next();
  while (!next.done) {
    if (next.value) throw new Error("Async read in synchronous validation");
    next = steps.next();
  }
  return next.value;
}
export async function gitReadCheckpoint(options: GitReadOptions): Promise<void> {
  await yieldToLoop();
  assertGitReadActive(options);
}
export async function finishGitReadAsync<T>(
  steps: GitReadSteps<T>,
  options: GitReadOptions,
): Promise<T> {
  let next = steps.next();
  while (!next.done) {
    try {
      await next.value;
      await gitReadCheckpoint(options);
      next = steps.next();
    } catch (error) {
      next = steps.throw(error);
    }
  }
  assertGitReadActive(options);
  return next.value;
}
export async function readRefShaAsync(
  repoPath: string,
  refName: string,
  options: GitReadOptions,
): Promise<string | null> {
  if (!refName.startsWith("refs/")) throw new Error("ref must be fully qualified");
  try {
    const { stdout } = await runGitAsync(repoPath, ["rev-parse", "--verify", refName], options);
    const value = stdout.toString().trim();
    if (!SHA1.test(value)) throw new Error("invalid ref sha");
    return value;
  } catch (error) {
    assertGitReadActive(options);
    if (error && typeof error === "object" && "code" in error && error.code === 128)
      return absentRefOrThrowAsync(repoPath, refName, options, error);
    // A spawn failure (no child ran): an unreadable repository is a storage
    // failure, as in the synchronous reader.
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string")
      repositoryMissing(repoPath, error);
    throw error;
  }
}

/**
 * Git answers "not a valid ref" (exit 128) alike for a missing ref and for a
 * broken one, so absence is asked of git again, twice: `for-each-ref` lists
 * nothing and says nothing for a missing ref, warns about a broken one and
 * fails on a malformed ref store or repository; `symbolic-ref -q` exits 1 for
 * a ref that is not a symbolic ref (it ignores dangling ones silently
 * otherwise). Only those clean answers mean "absent"; anything else is a
 * storage failure, never a "changed" or "missing" branch that a caller could
 * turn into a user refusal.
 */
type GitAnswer = { status: number | null; stdout: string; stderr: string };
const refAbsenceProbes = (refName: string) => [
  { args: ["for-each-ref", "--format=%(refname)", "--", refName], clean: 0 },
  { args: ["symbolic-ref", "-q", "--", refName], clean: 1 },
];
function absenceAnswer(refName: string, answers: GitAnswer[], cause: unknown): null {
  const probes = refAbsenceProbes(refName);
  const bad = answers.find(
    (answer, i) =>
      answer.status !== probes[i]!.clean ||
      answer.stderr.trim() !== "" ||
      // for-each-ref also lists refs below this name (refs/heads/a/b for refs/heads/a).
      answer.stdout.split("\n").some((line) => (i === 0 ? line === refName : line.trim() !== "")),
  );
  if (!bad) return null;
  throw Object.assign(new KbDomainError("STORAGE_UNAVAILABLE", `Ref ${refName} is unreadable`), {
    cause: bad.stderr.trim() ? new Error(bad.stderr.trim().slice(0, 500)) : cause,
  });
}
async function absentRefOrThrowAsync(
  repoPath: string,
  refName: string,
  options: GitReadOptions,
  cause: unknown,
): Promise<null> {
  const answers: GitAnswer[] = [];
  for (const probe of refAbsenceProbes(refName)) {
    try {
      const result = await runGitAsync(repoPath, probe.args, {
        ...options,
        resultExitCodes: [1],
      });
      answers.push({
        status: result.exitCode ?? 0,
        stdout: result.stdout.toString(),
        stderr: result.stderr,
      });
    } catch (error) {
      assertGitReadActive(options);
      const e = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      answers.push({
        status: typeof e.code === "number" ? e.code : null,
        stdout: String(e.stdout ?? ""),
        stderr: String(e.stderr || (error as Error).message),
      });
    }
  }
  return absenceAnswer(refName, answers, cause);
}
function absentRefOrThrow(repoPath: string, refName: string, cause: unknown): null {
  const answers = refAbsenceProbes(refName).map(({ args }) => {
    const result = spawnSync("git", args, {
      cwd: repoPath,
      env: hardenedGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr || (result.error ? String(result.error.message) : ""),
    };
  });
  return absenceAnswer(refName, answers, cause);
}
export async function readCommitTreeShaAsync(
  repoPath: string,
  sha: string,
  options: GitReadOptions,
): Promise<string> {
  if (!SHA1.test(sha)) throw new Error("invalid commit sha");
  const { stdout } = await runGitAsync(repoPath, ["rev-parse", `${sha}^{tree}`], options);
  const tree = stdout.toString().trim();
  if (!SHA1.test(tree)) throw new Error("invalid tree sha");
  return tree;
}
export async function readObjectSizeBytesAsync(
  repoPath: string,
  sha: string,
  options: GitReadOptions,
): Promise<number> {
  if (!SHA1.test(sha)) throw new Error("invalid object sha");
  const { stdout } = await runGitAsync(repoPath, ["cat-file", "-s", sha], options);
  const size = Number(stdout.toString().trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid object size");
  return size;
}
export async function readBlobContentAsync(
  repoPath: string,
  sha: string,
  limits: { maxBytes: number },
  options: GitReadOptions,
): Promise<Buffer> {
  if (!SHA1.test(sha)) throw new Error("invalid blob sha");
  const { stdout } = await runGitAsync(repoPath, ["cat-file", "blob", sha], {
    ...options,
    encoding: "buffer",
    maxBuffer: limits.maxBytes + 1,
  });
  const bytes = Buffer.from(stdout);
  if (bytes.length > limits.maxBytes)
    throw new TreeReadBudgetError("blob exceeds read budget", {
      size: bytes.length,
      maxBytes: limits.maxBytes,
    });
  return bytes;
}

export function readRefSha(repoPath: string, refName: string): string | null {
  if (!refName.startsWith("refs/")) throw new Error(`ref must be fully qualified: ${refName}`);
  let value: string;
  try {
    value = runGit(repoPath, ["rev-parse", "--verify", refName]);
  } catch (error) {
    // A repository that does not exist yet (before its first write) has no refs;
    // only a confirmed ENOENT counts. EACCES and the like are storage failures.
    if (repositoryMissing(repoPath, error)) return null;
    // 128 is git's "not a valid ref" for missing and broken refs alike: ask again.
    if ((error as { status?: unknown }).status === 128)
      return absentRefOrThrow(repoPath, refName, error);
    throw error;
  }
  if (!SHA1.test(value)) throw new Error(`unexpected ref value ${value}`);
  return value;
}

function repositoryMissing(repoPath: string, cause: unknown): boolean {
  try {
    statSync(repoPath);
    return false;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return true;
    throw Object.assign(new KbDomainError("STORAGE_UNAVAILABLE", "Repository is unreadable"), {
      cause: error ?? cause,
    });
  }
}

export function readHeadSha(repoPath: string, defaultBranch = "main"): string | null {
  return readRefSha(repoPath, `refs/heads/${defaultBranch}`);
}

export function readCommitTreeSha(repoPath: string, commitSha: string): string {
  if (!SHA1.test(commitSha)) throw new Error("invalid commit sha");
  const tree = runGit(repoPath, ["rev-parse", `${commitSha}^{tree}`]);
  if (!SHA1.test(tree)) throw new Error("invalid tree sha");
  return tree;
}

/** Ordered parents (empty for a root); SHA-only input and bounded Git output. */
export function readCommitParents(repoPath: string, commitSha: string): string[] {
  if (!SHA1.test(commitSha)) throw new Error("invalid commit sha");
  const line = runGit(repoPath, ["rev-list", "--parents", "--max-count=1", commitSha]);
  const [sha, ...parents] = line.split(" ");
  if (sha !== commitSha || parents.some((parent) => !SHA1.test(parent))) {
    throw new TreeStructureError("invalid commit parent");
  }
  return [...new Set(parents)];
}

export type GitTreeEntry = {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  path: string;
};

function runGitBuffer(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = hardenedGitEnv(),
  maxBuffer = 8 * 1024 * 1024,
): Buffer {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("refusing git argv with NUL");
  return execFileSync("git", [...args], {
    cwd,
    env,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
}

function decodePathBytes(pathBytes: Buffer): string {
  try {
    return decodeUtf8Fatal(pathBytes);
  } catch {
    throw new TreeReadBudgetError("tree path is not valid UTF-8", {
      size: pathBytes.byteLength,
      maxBytes: pathBytes.byteLength,
    });
  }
}

function parseLsTreeRecord(record: Buffer): {
  mode: string;
  type: GitTreeEntry["type"];
  sha: string;
  name: string;
} {
  const tab = record.indexOf(0x09);
  if (tab < 0) throw new Error("unexpected ls-tree record");
  const meta = record.subarray(0, tab).toString("ascii");
  const match = /^(\d+) (blob|tree|commit) ([0-9a-f]{40})$/.exec(meta);
  if (!match) throw new Error(`unexpected ls-tree meta ${meta}`);
  const name = decodePathBytes(record.subarray(tab + 1));
  return { mode: match[1]!, type: match[2] as GitTreeEntry["type"], sha: match[3]!, name };
}

function parseCommitBlobs(output: Buffer): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const child of parseTreeChildren(output)) {
    if (child.type === "blob") blobs.set(child.name, child.sha);
  }
  return blobs;
}

/** 8192 entries at ~600 bytes of ls-tree record each, plus headroom. */
const COMMIT_BLOBS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * `path -> blob` of one commit's whole tree in a single bounded
 * `ls-tree -r -z` (L-8: which paths a new commit changes). The commit was
 * validated when written, so its paths are already canonical.
 */
export function readCommitBlobs(repoPath: string, commitSha: string): Map<string, string> {
  if (!SHA1.test(commitSha)) throw new Error("invalid commit sha");
  return parseCommitBlobs(
    runGitBuffer(
      repoPath,
      ["ls-tree", "-r", "-z", "--full-tree", commitSha],
      hardenedGitEnv(),
      COMMIT_BLOBS_MAX_BYTES,
    ),
  );
}

/** Async {@link readCommitBlobs} under a request's Git read options. */
export async function readCommitBlobsAsync(
  repoPath: string,
  commitSha: string,
  options: GitReadOptions,
  /** Objects in this already published tree; callers hold its per-KB lease. */
  durableObjects?: Set<string>,
): Promise<Map<string, string>> {
  if (!SHA1.test(commitSha)) throw new Error("invalid commit sha");
  const { stdout } = await runGitAsync(
    repoPath,
    ["ls-tree", "-r", ...(durableObjects ? ["-t"] : []), "-z", "--full-tree", commitSha],
    {
      ...options,
      encoding: "buffer",
      maxBuffer: COMMIT_BLOBS_MAX_BYTES,
    },
  );
  const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  if (durableObjects) {
    for (const entry of parseTreeChildren(output)) durableObjects.add(entry.sha);
  }
  return parseCommitBlobs(output);
}

function listTreeChildren(
  repoPath: string,
  treeSha: string,
): Array<{
  mode: string;
  type: GitTreeEntry["type"];
  sha: string;
  name: string;
}> {
  const output = runGitBuffer(repoPath, ["ls-tree", "-z", treeSha]);
  return parseTreeChildren(output);
}

function parseTreeChildren(
  output: Buffer,
): Array<{ mode: string; type: GitTreeEntry["type"]; sha: string; name: string }> {
  const children: Array<{
    mode: string;
    type: GitTreeEntry["type"];
    sha: string;
    name: string;
  }> = [];
  let start = 0;
  while (start < output.byteLength) {
    let end = output.indexOf(0, start);
    if (end < 0) end = output.byteLength;
    if (end > start) children.push(parseLsTreeRecord(output.subarray(start, end)));
    start = end + 1;
  }
  return children;
}

export type TreeWalkBudget = {
  entries: number;
  maxEntries: number;
};

/**
 * Aggregate budget over every distinct incoming Git object (commits, trees,
 * blobs). Charge each distinct SHA before its content validation read, so a
 * traversal range shares one allowance instead of a fresh one per commit.
 * Range membership excludes existing history; tree metadata is preflighted
 * separately before Git enumerates that membership.
 */
export type IncomingObjectBudget = {
  seen: Set<string>;
  incomingObjects?: ReadonlySet<string>;
  objects: number;
  uncompressedBytes: number;
  maxObjects: number;
  maxUncompressedBytes: number;
};

export function createIncomingObjectBudget(
  maxObjects: number,
  maxUncompressedBytes: number,
  incomingObjects?: ReadonlySet<string>,
): IncomingObjectBudget {
  return {
    seen: new Set(),
    incomingObjects,
    objects: 0,
    uncompressedBytes: 0,
    maxObjects,
    maxUncompressedBytes,
  };
}

/** Charge one distinct incoming object before its content validation read. */
export function chargeIncomingObject(
  budget: IncomingObjectBudget,
  sha: string,
  size: number,
): void {
  if (budget.incomingObjects && !budget.incomingObjects.has(sha)) return;
  if (budget.seen.has(sha)) return;
  budget.seen.add(sha);
  budget.objects += 1;
  budget.uncompressedBytes += size;
  if (budget.objects > budget.maxObjects) {
    throw new TreeReadBudgetError("object traversal exceeds object budget", {
      size: budget.objects,
      maxBytes: budget.maxObjects,
    });
  }
  if (budget.uncompressedBytes > budget.maxUncompressedBytes) {
    throw new TreeReadBudgetError("object traversal exceeds uncompressed byte budget", {
      size: budget.uncompressedBytes,
      maxBytes: budget.maxUncompressedBytes,
    });
  }
}

/** Raised for tree objects git accepts on the wire but that cannot be a KB tree. */
export class TreeStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeStructureError";
  }
}

/**
 * Walk every entry of a tree, depth-first pre-order: directory entries are
 * emitted with their full path (no trailing slash) before their children, so
 * validation covers directories that have no blob descendants — including
 * empty trees. Duplicate entry names inside one tree object (which git accepts
 * in packs) and entries out of Git's byte order throw TreeStructureError.
 * Gitlink (`commit`) entries are emitted
 * for the validator to reject. Every raw child name must be exactly one
 * nonempty path segment: git also accepts entry names containing `/` on the
 * wire (only fsck flags them), and concatenating such a name with the parent
 * prefix would fabricate logical paths that alias real subtrees, so they are
 * rejected here before path construction.
 */
export function walkGitTreeEntries(
  repoPath: string,
  treeSha: string,
  budget: TreeWalkBudget,
  incoming?: IncomingObjectBudget,
): GitTreeEntry[] {
  // Tree objects come from one batched read per depth level, not one process
  // per directory; the walk itself (order, names, depth, budgets) is unchanged.
  // Best effort: anything the batched read cannot load is walked (and
  // reported) object by object, exactly as before.
  let snapshot: TreeSnapshot | null = null;
  try {
    snapshot = SHA1.test(treeSha) ? loadTreeSnapshotSync(repoPath, treeSha) : null;
  } catch {
    snapshot = null;
  }
  return finishGitReadSync(
    walkTreeSteps(treeSha, budget, incoming, {
      size: (sha) => snapshot?.sizes.get(sha) ?? readObjectSizeBytes(repoPath, sha),
      children: (sha) => snapshot?.children.get(sha) ?? listTreeChildren(repoPath, sha),
    }),
  );
}
export async function walkGitTreeEntriesAsync(
  repoPath: string,
  treeSha: string,
  budget: TreeWalkBudget,
  options: GitReadOptions,
  incoming?: IncomingObjectBudget,
): Promise<GitTreeEntry[]> {
  assertGitReadActive(options);
  let snapshot: TreeSnapshot | null = null;
  try {
    snapshot = SHA1.test(treeSha) ? await loadTreeSnapshotAsync(repoPath, treeSha, options) : null;
  } catch {
    assertGitReadActive(options);
    snapshot = null;
  }
  return finishGitReadAsync(
    walkTreeSteps(treeSha, budget, incoming, {
      size: (sha) => snapshot?.sizes.get(sha) ?? readObjectSizeBytesAsync(repoPath, sha, options),
      children: async (sha) => {
        const cached = snapshot?.children.get(sha);
        if (cached) return cached;
        const { stdout } = await runGitAsync(repoPath, ["ls-tree", "-z", sha], {
          ...options,
          encoding: "buffer",
        });
        return parseTreeChildren(Buffer.from(stdout));
      },
    }),
    options,
  );
}
function* walkTreeSteps(
  treeSha: string,
  budget: TreeWalkBudget,
  incoming: IncomingObjectBudget | undefined,
  source: {
    size(sha: string): number | Promise<number>;
    children(
      sha: string,
    ): ReturnType<typeof listTreeChildren> | Promise<ReturnType<typeof listTreeChildren>>;
  },
): GitReadSteps<GitTreeEntry[]> {
  if (!SHA1.test(treeSha)) throw new Error("invalid tree sha");
  const entries: GitTreeEntry[] = [];
  // Object metadata is immutable. Reuse it only within this repo's walk;
  // logical paths, depth and budgets are still checked on every visit.
  const childrenBySha = new Map<string, ReturnType<typeof listTreeChildren>>();
  const chargeEntry = (): void => {
    budget.entries += 1;
    if (budget.entries > budget.maxEntries) {
      throw new TreeReadBudgetError("tree exceeds entry budget", {
        size: budget.entries,
        maxBytes: budget.maxEntries,
      });
    }
  };
  const visit = function* (sha: string, prefix: string, depth: number): GitReadSteps<void> {
    yield undefined;
    // chargeIncomingObject ignores excluded and already-charged objects, so
    // read a size only for an object it will actually charge (once per SHA).
    if (
      incoming &&
      !incoming.seen.has(sha) &&
      (!incoming.incomingObjects || incoming.incomingObjects.has(sha))
    ) {
      chargeIncomingObject(incoming, sha, yield* gitReadStep(source.size(sha)));
    }
    // The tree object itself counts as one entry (the root is the first);
    // each child is counted exactly once — blob and gitlink children here,
    // tree children when their own visit starts — so a directory is never
    // charged both as a child and as a visited tree.
    chargeEntry();
    let children = childrenBySha.get(sha);
    if (children === undefined) {
      children = yield* gitReadStep(source.children(sha));
      childrenBySha.set(sha, children);
    }
    const childNames = new Set<string>();
    let previousSortKey: Buffer | undefined;
    for (const child of children) {
      if (childNames.has(child.name)) {
        throw new TreeStructureError(`duplicate entry name ${child.name} in tree ${sha}`);
      }
      childNames.add(child.name);
      assertSingleSegmentName(child.name);
      if (depth + 1 > KB_TREE_LIMITS.maxTreeDepth) {
        throw new TreeStructureError("tree nesting exceeds depth budget");
      }
      // Names decode losslessly, so re-encoding preserves their original bytes.
      // Git compares directories with a trailing slash, not by string/locale
      // order. Preserve the received order: sorting here would hide a malformed
      // committed tree whose entries Git cannot reliably resolve by path.
      const sortKey = Buffer.from(child.name + (child.type === "tree" ? "/" : ""), "utf8");
      if (previousSortKey && Buffer.compare(previousSortKey, sortKey) >= 0) {
        throw new TreeStructureError(`entry ${child.name} is out of order in tree ${sha}`);
      }
      previousSortKey = sortKey;
      const path = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
      entries.push({ mode: child.mode, type: child.type, sha: child.sha, path });
      if (child.type === "tree") {
        yield* visit(child.sha, path, depth + 1);
        continue;
      }
      chargeEntry();
    }
  };
  yield* visit(treeSha, "", 0);
  return entries;
}

/** A raw git entry name must be one nonempty path segment — never a nested or special path form. */
export function assertSingleSegmentName(name: string): void {
  if (name.length === 0) {
    throw new TreeStructureError("tree entry name must not be empty");
  }
  if (name.includes("/")) {
    throw new TreeStructureError(`tree entry name must not contain a slash (${name})`);
  }
  if (name === "." || name === "..") {
    throw new TreeStructureError(`tree entry name must not be a dot segment (${name})`);
  }
}

export function readObjectSizeBytes(repoPath: string, sha: string): number {
  if (!SHA1.test(sha)) throw new Error("invalid object sha");
  const sizeText = runGit(repoPath, ["cat-file", "-s", sha]);
  const size = Number(sizeText);
  if (!Number.isInteger(size) || size < 0) throw new Error("invalid object size");
  return size;
}

/** Read a blob whose size is already known and budgeted, bounded by maxBytes. */
export function readBlobContent(
  repoPath: string,
  blobSha: string,
  limits: { maxBytes: number },
): Buffer {
  if (!SHA1.test(blobSha)) throw new Error("invalid blob sha");
  const raw = execFileSync("git", ["cat-file", "blob", blobSha], {
    cwd: repoPath,
    env: hardenedGitEnv(),
    encoding: "buffer",
    maxBuffer: limits.maxBytes + 1,
  });
  if (raw.byteLength > limits.maxBytes) {
    throw new TreeReadBudgetError("blob exceeds read budget", {
      size: raw.byteLength,
      maxBytes: limits.maxBytes,
    });
  }
  return raw;
}

export class TreeReadBudgetError extends Error {
  readonly size: number;
  readonly maxBytes: number;
  constructor(message: string, input: { size: number; maxBytes: number }) {
    super(message);
    this.name = "TreeReadBudgetError";
    this.size = input.size;
    this.maxBytes = input.maxBytes;
  }
}

export type CommitMetadata = {
  sha: string;
  treeSha: string;
  author: string;
  committer: string;
  message: string;
};

export function readCommitMetadata(repoPath: string, commitSha: string): CommitMetadata {
  if (!SHA1.test(commitSha)) throw new Error("invalid commit sha");
  const raw = runGit(repoPath, ["cat-file", "-p", commitSha]);
  const lines = raw.split("\n");
  let treeSha = "";
  let author = "";
  let committer = "";
  let message = "";
  let inMessage = false;
  for (const line of lines) {
    if (inMessage) {
      message += `${line}\n`;
      continue;
    }
    if (line.startsWith("tree ")) treeSha = line.slice(5).trim();
    else if (line.startsWith("author ")) author = line.slice(7);
    else if (line.startsWith("committer ")) committer = line.slice(10);
    else if (line.length === 0) inMessage = true;
  }
  if (!SHA1.test(treeSha)) throw new Error("commit missing tree");
  return { sha: commitSha, treeSha, author, committer, message };
}

export function listCommitsBetween(
  repoPath: string,
  oldSha: string,
  newSha: string,
  limit: number,
): string[] {
  if (!SHA1.test(oldSha) || !SHA1.test(newSha)) throw new Error("invalid commit sha");
  const output = runGit(repoPath, [
    "rev-list",
    "--reverse",
    "--topo-order",
    `${oldSha}..${newSha}`,
    `--max-count=${limit + 1}`,
  ]);
  if (!output) return [];
  const commits = output.split("\n").filter(Boolean);
  if (commits.length > limit) {
    throw new TreeReadBudgetError("commit traversal exceeds budget", {
      size: commits.length,
      maxBytes: limit,
    });
  }
  return commits;
}

/**
 * Explicitly exclude every historical tree: a plain old..new object walk only
 * excludes boundary trees and can report restored historical content as new.
 * Stream old tree exclusions into Git with backpressure and keep only the
 * bounded incoming SHA set in memory. No blob content is read here.
 */
export async function listNewlyReachableObjects(
  repoPath: string,
  oldSha: string,
  newSha: string,
  limit: number,
): Promise<ReadonlySet<string>> {
  if (!SHA1.test(oldSha) || !SHA1.test(newSha)) throw new Error("invalid commit sha");
  const overBudget = (): TreeReadBudgetError =>
    new TreeReadBudgetError("object traversal exceeds object budget", {
      size: limit + 1,
      maxBytes: limit,
    });
  const exclusions = spawn("git", ["rev-list", "--format=^%T", "--no-commit-header", oldSha], {
    cwd: repoPath,
    env: hardenedGitEnv(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  const incoming = spawn(
    "git",
    ["rev-list", "--objects", "--no-object-names", `${oldSha}..${newSha}`, "--stdin"],
    { cwd: repoPath, env: hardenedGitEnv(), stdio: ["pipe", "pipe", "ignore"] },
  );
  const waitForGit = (child: ChildProcess): Promise<void> =>
    new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("incoming object enumeration failed"));
      });
    });
  const objects = new Set<string>();
  const collect = async (): Promise<void> => {
    let partial = "";
    for await (const chunk of incoming.stdout) {
      const lines = (partial + chunk.toString("ascii")).split("\n");
      partial = lines.pop()!;
      if (partial.length > 40) throw new Error("invalid incoming object sha");
      for (const sha of lines) {
        if (!SHA1.test(sha)) throw new Error("invalid incoming object sha");
        objects.add(sha);
        if (objects.size > limit) throw overBudget();
      }
    }
    if (partial) throw new Error("truncated incoming object sha");
  };
  const work = [
    waitForGit(exclusions),
    waitForGit(incoming),
    pipeline(exclusions.stdout, incoming.stdin),
    collect(),
  ];
  try {
    await Promise.all(work);
    return objects;
  } catch (error) {
    exclusions.kill("SIGKILL");
    incoming.kill("SIGKILL");
    await Promise.allSettled(work);
    throw error;
  }
}

/**
 * Read many blobs with one `git cat-file --batch` (a rebase reads a whole
 * tree; one process per blob would not fit a request deadline). Results are
 * keyed by id; any blob over `maxBytes`, missing, or not a blob fails the
 * read. The child is owned until it closes, and killed on cancellation or the
 * deadline.
 */
export async function readBlobsAsync(
  repoPath: string,
  shas: readonly string[],
  limits: { maxBytes: number; totalMaxBytes?: number },
  options: GitReadOptions,
): Promise<Map<string, Buffer>> {
  return readObjectsAsync(repoPath, shas, { ...limits, type: "blob" }, options);
}

/** `readBlobsAsync` for any one object type (tree objects for whole-tree snapshots). */
export async function readObjectsAsync(
  repoPath: string,
  shas: readonly string[],
  limits: {
    maxBytes: number;
    type: "blob" | "tree";
    /** Bytes the whole batch may return; default: three trees within the limits (a merge). */
    totalMaxBytes?: number;
  },
  options: GitReadOptions,
): Promise<Map<string, Buffer>> {
  const lifetime = gitReadOptions(options);
  assertGitReadActive(lifetime);
  const wanted = [...new Set(shas)];
  if (wanted.some((sha) => !SHA1.test(sha))) throw new Error("invalid blob sha");
  const out = new Map<string, Buffer>();
  if (wanted.length === 0) return out;
  // One owned lifecycle: every stream has an error handler, every wait also
  // ends when the child closes, and the producer, the consumer and the child's
  // close are all joined before this read settles (exactly once).
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: repoPath,
    env: hardenedGitEnv(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let streamError: Error | null = null;
  const noteError = (error: Error) => {
    streamError ??= error;
  };
  child.stdin.on("error", noteError);
  child.stdout.on("error", noteError);
  let finished = false;
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      noteError(error);
      finished = true;
      resolve(null);
    });
    child.once("close", (code) => {
      finished = true;
      resolve(code);
    });
  });
  const cancel = () => {
    if (!finished) child.kill("SIGKILL");
  };
  const owner = ownGitChildLifetime(lifetime, cancel);
  const feed = async () => {
    for (const sha of wanted) {
      if (finished || streamError || child.stdin.destroyed) return;
      if (!child.stdin.write(`${sha}\n`))
        // Backpressure: wait for room, or for the child to go away.
        await Promise.race([
          new Promise<void>((resolve) => child.stdin.once("drain", () => resolve())),
          new Promise<void>((resolve) => child.stdin.once("close", () => resolve())),
          closed.then(() => undefined),
        ]);
    }
    if (!child.stdin.destroyed) child.stdin.end();
  };
  const parse = async () => {
    let buffer: Buffer = Buffer.alloc(0);
    let pending: { sha: string; size: number } | null = null;
    let total = 0;
    const totalMax = limits.totalMaxBytes ?? 3 * KB_TREE_LIMITS.maxTreeBytes;
    for await (const chunk of child.stdout) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);
      for (;;) {
        if (!pending) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          const header = buffer.subarray(0, newline).toString("ascii");
          buffer = buffer.subarray(newline + 1);
          const match = /^([a-f0-9]{40}) (blob|tree) ([0-9]+)$/.exec(header);
          if (!match || match[2] !== limits.type) throw new Error("object batch read failed");
          const size = Number(match[3]);
          if (size > limits.maxBytes)
            throw new TreeReadBudgetError("blob exceeds read budget", {
              size,
              maxBytes: limits.maxBytes,
            });
          total += size;
          if (total > totalMax)
            throw new TreeReadBudgetError("object batch exceeds read budget", {
              size: total,
              maxBytes: totalMax,
            });
          pending = { sha: match[1]!, size };
        }
        if (buffer.length < pending.size + 1) break;
        out.set(pending.sha, Buffer.from(buffer.subarray(0, pending.size)));
        buffer = buffer.subarray(pending.size + 1);
        pending = null;
      }
      await yieldToLoop();
    }
    if (pending || buffer.length > 0) throw new Error("truncated blob batch read");
  };
  try {
    const [fed, parsed] = await Promise.allSettled([feed(), parse()]);
    // A consumer failure (budget, malformed output) stops the child too.
    if (parsed.status === "rejected") cancel();
    const code = await closed;
    owner.assertActive();
    if (parsed.status === "rejected") throw parsed.reason;
    if (fed.status === "rejected") throw fed.reason;
    if (streamError || code !== 0 || out.size !== wanted.length)
      throw new Error("blob batch read failed");
    return out;
  } finally {
    cancel();
    owner.release();
  }
}

/**
 * Parse a raw tree object body into children in stored order, with modes as
 * `ls-tree` prints them (zero-padded to six digits) and the same name rules.
 */
function parseRawTree(body: Buffer): ReturnType<typeof parseTreeChildren> {
  const children: ReturnType<typeof parseTreeChildren> = [];
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const nul = space >= 0 ? body.indexOf(0x00, space + 1) : -1;
    if (space < 0 || nul < 0 || nul + 21 > body.length)
      throw new TreeStructureError("tree object encoding is corrupt");
    const raw = body.toString("ascii", offset, space);
    if (!/^[0-7]{5,6}$/.test(raw)) throw new TreeStructureError("tree object mode is corrupt");
    const mode = raw.padStart(6, "0");
    const type: GitTreeEntry["type"] =
      mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob";
    children.push({
      mode,
      type,
      sha: body.subarray(nul + 1, nul + 21).toString("hex"),
      name: decodePathBytes(body.subarray(space + 1, nul)),
    });
    offset = nul + 21;
  }
  return children;
}

/** The most bytes all tree objects of a tree within the limits can take (every entry once). */
const TREE_OBJECTS_MAX_BYTES = KB_TREE_LIMITS.maxEntries * (KB_PATH_LIMITS.maxBytes + 40);

export type TreeSnapshot = {
  children: Map<string, ReturnType<typeof parseTreeChildren>>;
  sizes: Map<string, number>;
};

/** The most bytes a recursive listing of a tree within the limits can take. */
const TREE_LISTING_MAX_BYTES = KB_TREE_LIMITS.maxEntries * (KB_PATH_LIMITS.maxBytes + 64);

/**
 * Every tree object under `rootTree` in two processes, whatever the number of
 * directories or the depth: one recursive listing names the distinct subtree
 * objects, one batched read returns their raw bodies (the walk checks names,
 * order and budgets on those bodies, as before). Null when the listing does not
 * fit what a tree within the limits can produce; anything missing is read
 * object by object by the walk, which then reports the budget it exceeds.
 */
export async function loadTreeSnapshotAsync(
  repoPath: string,
  rootTree: string,
  options: GitReadOptions,
): Promise<TreeSnapshot | null> {
  let listing: Buffer;
  try {
    listing = Buffer.from(
      (
        await runGitAsync(repoPath, ["ls-tree", "-r", "-t", "-z", rootTree], {
          ...options,
          encoding: "buffer",
          maxBuffer: TREE_LISTING_MAX_BYTES,
        })
      ).stdout,
    );
  } catch {
    assertGitReadActive(options);
    return null;
  }
  const trees = subtreesOfListing(rootTree, listing);
  if (!trees) return null;
  return snapshotOf(
    trees,
    await readObjectsAsync(
      repoPath,
      trees,
      { maxBytes: TREE_OBJECTS_MAX_BYTES, type: "tree" },
      options,
    ),
  );
}

/** Synchronous twin for the publication planners that still read synchronously. */
export function loadTreeSnapshotSync(repoPath: string, rootTree: string): TreeSnapshot | null {
  let listing: Buffer;
  try {
    listing = runGitBuffer(
      repoPath,
      ["ls-tree", "-r", "-t", "-z", rootTree],
      undefined,
      TREE_LISTING_MAX_BYTES,
    );
  } catch {
    return null;
  }
  const trees = subtreesOfListing(rootTree, listing);
  if (!trees) return null;
  return snapshotOf(
    trees,
    readObjectsSync(repoPath, trees, { maxBytes: TREE_OBJECTS_MAX_BYTES, type: "tree" }),
  );
}

/** The distinct tree objects of a listing (root first); null past the entry budget. */
function subtreesOfListing(rootTree: string, listing: Buffer): string[] | null {
  const trees = new Set([rootTree]);
  let offset = 0;
  while (offset < listing.length) {
    const end = listing.indexOf(0x00, offset);
    const stop = end < 0 ? listing.length : end;
    // "040000 tree <sha>\t<name>"
    if (stop - offset > 52 && listing.toString("ascii", offset, offset + 12) === "040000 tree ")
      trees.add(listing.toString("ascii", offset + 12, offset + 52));
    if (trees.size > KB_TREE_LIMITS.maxEntries) return null;
    offset = stop + 1;
  }
  return [...trees].filter((sha) => SHA1.test(sha));
}

function snapshotOf(trees: readonly string[], bodies: Map<string, Buffer>): TreeSnapshot {
  const snapshot: TreeSnapshot = { children: new Map(), sizes: new Map() };
  for (const sha of trees) {
    const body = bodies.get(sha);
    if (!body) continue;
    snapshot.sizes.set(sha, body.length);
    snapshot.children.set(sha, parseRawTree(body));
  }
  return snapshot;
}

/** Synchronous batched object read (one `git cat-file --batch`) for the sync planners. */
export function readObjectsSync(
  repoPath: string,
  shas: readonly string[],
  limits: { maxBytes: number; type: "blob" | "tree" },
  totalMaxBytes = KB_TREE_LIMITS.maxTreeBytes,
): Map<string, Buffer> {
  const wanted = [...new Set(shas)];
  if (wanted.some((sha) => !SHA1.test(sha))) throw new Error("invalid object sha");
  const out = new Map<string, Buffer>();
  if (wanted.length === 0) return out;
  const stdout = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoPath,
    env: hardenedGitEnv(),
    input: Buffer.from(`${wanted.join("\n")}\n`),
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: totalMaxBytes + wanted.length * 64,
  });
  let offset = 0;
  while (offset < stdout.length) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("truncated object batch read");
    const match = /^([a-f0-9]{40}) (blob|tree) ([0-9]+)$/.exec(
      stdout.subarray(offset, newline).toString("ascii"),
    );
    if (!match || match[2] !== limits.type) throw new Error("object batch read failed");
    const size = Number(match[3]);
    if (size > limits.maxBytes)
      throw new TreeReadBudgetError("object exceeds read budget", {
        size,
        maxBytes: limits.maxBytes,
      });
    const start = newline + 1;
    if (start + size + 1 > stdout.length) throw new Error("truncated object batch read");
    out.set(match[1]!, Buffer.from(stdout.subarray(start, start + size)));
    offset = start + size + 1;
  }
  if (out.size !== wanted.length) throw new Error("object batch read failed");
  return out;
}

/** A commit's blobs by path with sizes (one cancellable `ls-tree`). */
export async function listTreeBlobsAsync(
  repoPath: string,
  commitOrTree: string,
  options: GitReadOptions,
): Promise<Array<{ path: string; sha: string; size: number }>> {
  if (!SHA1.test(commitOrTree)) throw new Error("invalid tree sha");
  const { stdout } = await runGitAsync(repoPath, ["ls-tree", "-r", "-l", "-z", commitOrTree], {
    ...options,
    encoding: "buffer",
    maxBuffer: KB_TREE_LIMITS.maxEntries * (KB_PATH_LIMITS.maxBytes + 96),
  });
  return parseTreeBlobListing(Buffer.from(stdout));
}

function parseTreeBlobListing(stdout: Buffer): Array<{ path: string; sha: string; size: number }> {
  const blobs: Array<{ path: string; sha: string; size: number }> = [];
  for (const record of stdout.toString("utf8").split("\0")) {
    const match = /^[0-9]+ blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/s.exec(record);
    if (match) blobs.push({ path: match[3]!, sha: match[1]!, size: Number(match[2]) });
  }
  return blobs;
}

/** A commit's blobs by path (one `ls-tree`), sizes included. */
export function listTreeBlobsSync(
  repoPath: string,
  commitOrTree: string,
): Array<{ path: string; sha: string; size: number }> {
  if (!SHA1.test(commitOrTree)) throw new Error("invalid tree sha");
  const stdout = runGitBuffer(
    repoPath,
    ["ls-tree", "-r", "-l", "-z", commitOrTree],
    undefined,
    KB_TREE_LIMITS.maxEntries * (KB_PATH_LIMITS.maxBytes + 96),
  );
  return parseTreeBlobListing(stdout);
}
