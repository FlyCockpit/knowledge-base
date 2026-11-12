import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  openDirectory: false,
  syncDirectory: false,
  syncs: 0,
  writesBeforeFailure: null as number | null,
  trackAsyncSyncs: false,
  asyncSyncs: [] as string[],
  failAsyncObjectSync: false,
  forbidSync: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      if (faults.openDirectory && fs.statSync(args[0], { throwIfNoEntry: false })?.isDirectory()) {
        throw Object.assign(new Error("injected directory open failure"), { code: "EACCES" });
      }
      return fs.openSync(...args);
    },
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      if (typeof args[0] === "number" && faults.writesBeforeFailure !== null) {
        if (faults.writesBeforeFailure-- === 0) {
          fs.writeSync(args[0], Buffer.from("partial"));
          throw Object.assign(new Error("injected partial object write"), { code: "ENOSPC" });
        }
      }
      return fs.writeFileSync(...args);
    },
    fsyncSync(fd: number) {
      if (faults.forbidSync) throw new Error("synchronous flush during initial publication");
      if (fs.fstatSync(fd).isDirectory()) {
        faults.syncs++;
        if (faults.syncDirectory) {
          throw Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
        }
      }
      return fs.fsyncSync(fd);
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const file = await fs.open(...args);
      const sync = file.sync.bind(file);
      file.sync = async () => {
        if (faults.trackAsyncSyncs) faults.asyncSyncs.push(String(args[0]));
        if (
          faults.failAsyncObjectSync &&
          /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(String(args[0]))
        )
          throw Object.assign(new Error("injected object sync failure"), { code: "EIO" });
        return sync();
      };
      return file;
    },
  };
});
afterEach(() => {
  faults.openDirectory = false;
  faults.syncDirectory = false;
  faults.syncs = 0;
  faults.writesBeforeFailure = null;
  faults.trackAsyncSyncs = false;
  faults.asyncSyncs = [];
  faults.failAsyncObjectSync = false;
  faults.forbidSync = false;
});

import { readHeadSha, runGit } from "./git-read";
import {
  bindValidatedTreeForPublication,
  createEmptyTreeCommit,
  createTreeReuseCommit,
  fsyncRefUpdate,
  GitCommandError,
  type GitMutatingExecutor,
  initBareKbRepo,
  removeAbandonedPublicationLocks,
  removeLooseObjects,
  writeInitialMainCommit,
  writeInitialMainCommitLoose,
  writeStagedObjects,
} from "./git-write";
import { stageTreeForFiles } from "./staged-tree";
import { validateGitCommit } from "./validate-tree";

function publicationBinding(repo: string, commitSha: string) {
  const validation = validateGitCommit({ repoPath: repo }, commitSha);
  if (!validation.ok) throw new Error(validation.message);
  return bindValidatedTreeForPublication(validation, commitSha);
}

/** Real Git through an async supervised-style transport (exit status only). */
const testExecutor: GitMutatingExecutor = {
  exec({ cwd, argv, env }) {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new GitCommandError(String(argv[1] ?? argv[0]), code ?? -1));
      });
    });
  },
};

// These tests execute native durable writes. The guard covers fixture I/O;
// operation deadline/cancellation assertions live in their owning suites.
describe("git-write", { timeout: 180_000 }, () => {
  it("batches initial object durability without synchronous or repeated ancestor flushes", async () => {
    const repos = mkdtempSync(join(tmpdir(), "kb-write-initial-batch-"));
    const kbId = "initialbatch";
    const repo = join(repos, `kb_${kbId}.git`);
    try {
      await initBareKbRepo({ reposDir: repos, kbId, executor: testExecutor });
      faults.syncs = 0;
      faults.trackAsyncSyncs = true;
      faults.forbidSync = true;
      const initial = await writeInitialMainCommitLoose(repo, {
        message: "Initial commit",
        description: "Batched durability",
      });
      // A slow journal commit must not block the event loop or be paid once
      // per object at every shared ancestor. Count work instead of host time.
      expect(faults.syncs).toBe(0);
      const files = faults.asyncSyncs.filter((path) => statSync(path).isFile());
      expect(files).toHaveLength(6); // three blobs, two trees, one commit
      for (const directory of [join(repo, "objects"), repo, repos])
        expect(faults.asyncSyncs.filter((path) => path === directory)).toHaveLength(1);
      for (const fanout of new Set(files.map((path) => join(path, ".."))))
        expect(faults.asyncSyncs.filter((path) => path === fanout)).toHaveLength(1);
      expect(readHeadSha(repo)).toBeNull();
      expect(validateGitCommit({ repoPath: repo }, initial.headSha).ok).toBe(true);
    } finally {
      rmSync(repos, { recursive: true, force: true });
    }
  });

  it("builds the initial tree in-process and routes every git mutation through the executor", async () => {
    const repos = mkdtempSync(join(tmpdir(), "kb-write-supervised-"));
    const kbId = "supervised";
    const recorded: string[] = [];
    const recordingExecutor: GitMutatingExecutor = {
      exec(input) {
        const gitDirAt = input.argv.indexOf("--git-dir");
        const command = String(input.argv[gitDirAt >= 0 ? gitDirAt + 2 : 1] ?? input.argv[0]);
        recorded.push(command);
        return testExecutor.exec(input);
      },
    };
    try {
      await writeInitialMainCommit(
        { reposDir: repos, kbId, executor: recordingExecutor },
        { message: "init", description: "supervised initialization" },
      );
      // Only repo lifecycle commands may run as supervised mutations; the tree
      // objects are constructed in-process by the durable object writer, so no
      // `write-tree`/`add`/`commit` subprocess can bypass the coordinator.
      const allowed = new Set(["init", "config", "update-ref"]);
      for (const command of recorded) expect(allowed.has(command)).toBe(true);
      expect(recorded).toContain("init");
      expect(recorded).toContain("update-ref");
      const repo = join(repos, `kb_${kbId}.git`);
      const tree = runGit(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort();
      expect(tree).toEqual([".assets/manifest.json", ".gitignore", "index.md"]);
      expect(runGit(repo, ["cat-file", "-t", "HEAD"])).toBe("commit");
      expect(runGit(repo, ["fsck", "--strict"])).toBe("");
      // Durability uses `core.fsync`; the deprecated key warns on every fetch.
      expect(runGit(repo, ["config", "core.fsync"])).toBe("all");
      expect(() => runGit(repo, ["config", "core.fsyncObjectFiles"])).toThrow();
    } finally {
      rmSync(repos, { recursive: true, force: true });
    }
  });

  it("drains a failed initial object batch and reclaims only its new objects before retry", async () => {
    const repos = mkdtempSync(join(tmpdir(), "kb-write-initial-failure-"));
    const kbId = "initialfailure";
    const repo = join(repos, `kb_${kbId}.git`);
    const input = { message: "Initial commit", description: "Retry after failed durability" };
    try {
      await initBareKbRepo({ reposDir: repos, kbId, executor: testExecutor });
      faults.failAsyncObjectSync = true;
      await expect(writeInitialMainCommitLoose(repo, input)).rejects.toThrow(
        "injected object sync failure",
      );
      expect(readHeadSha(repo)).toBeNull();
      for (const dir of readdirSync(join(repo, "objects")).filter((dir) =>
        /^[0-9a-f]{2}$/.test(dir),
      ))
        expect(readdirSync(join(repo, "objects", dir))).toEqual([]);
      faults.failAsyncObjectSync = false;
      const initial = await writeInitialMainCommitLoose(repo, input);
      expect(validateGitCommit({ repoPath: repo }, initial.headSha).ok).toBe(true);
    } finally {
      rmSync(repos, { recursive: true, force: true });
    }
  });

  it("removes only abandoned publication locks and durably resyncs absent locks on retry", () => {
    const reposDir = mkdtempSync(join(tmpdir(), "kb-stale-lock-"));
    const options = { reposDir, kbId: "abandoned", refNames: ["refs/heads/topic/nested"] };
    const heads = join(reposDir, "kb_abandoned.git/refs/heads");
    const proposals = join(heads, "pr");
    const lock = join(heads, "main.lock");
    const fence = join(reposDir, ".private/server.fence");
    try {
      mkdirSync(proposals, { recursive: true });
      mkdirSync(join(heads, "topic"));
      writeFileSync(join(heads, "topic/nested.lock"), "interrupted user branch");
      mkdirSync(join(reposDir, ".private"));
      writeFileSync(fence, "persistent fence");
      const inode = statSync(fence).ino;
      writeFileSync(join(heads, "main"), "canonical ref");
      writeFileSync(join(heads, "other.lock"), "unrelated lock");
      writeFileSync(join(proposals, "1"), "proposal ref");
      writeFileSync(join(proposals, "1.lock"), "interrupted proposal append");
      writeFileSync(join(proposals, "2.lock"), "interrupted proposal creation");
      writeFileSync(
        join(reposDir, "kb_abandoned.git/HEAD.lock"),
        "interrupted symbolic ref update",
      );
      writeFileSync(lock, "interrupted Git transaction");
      faults.syncDirectory = true;
      expect(() => removeAbandonedPublicationLocks(options)).toThrow(/injected directory sync/);
      expect(existsSync(lock)).toBe(false);
      expect(() => removeAbandonedPublicationLocks(options)).toThrow(/injected directory sync/);
      faults.syncDirectory = false;
      faults.syncs = 0;
      removeAbandonedPublicationLocks(options);
      expect(faults.syncs).toBe(4);
      expect(existsSync(join(heads, "topic/nested.lock"))).toBe(false);
      expect(existsSync(join(reposDir, "kb_abandoned.git/HEAD.lock"))).toBe(false);
      expect(readFileSync(join(heads, "main"), "utf8")).toBe("canonical ref");
      expect(readFileSync(join(heads, "other.lock"), "utf8")).toBe("unrelated lock");
      expect(existsSync(join(proposals, "1.lock"))).toBe(false);
      expect(existsSync(join(proposals, "2.lock"))).toBe(false);
      expect(readFileSync(join(proposals, "1"), "utf8")).toBe("proposal ref");
      expect(statSync(fence).ino).toBe(inode);
      expect(readFileSync(fence, "utf8")).toBe("persistent fence");
    } finally {
      rmSync(reposDir, { recursive: true, force: true });
    }
  });

  it("refuses symlinks in the abandoned lock path", () => {
    const reposDir = mkdtempSync(join(tmpdir(), "kb-stale-symlink-"));
    const options = { reposDir, kbId: "abandoned" };
    const repo = join(reposDir, "kb_abandoned.git");
    const target = join(reposDir, "outside");
    try {
      mkdirSync(target);
      writeFileSync(join(target, "main.lock"), "untouched");
      mkdirSync(join(repo, "refs"), { recursive: true });
      symlinkSync(target, join(repo, "refs/heads"));
      expect(() => removeAbandonedPublicationLocks(options)).toThrow();
      unlinkSync(join(repo, "refs/heads"));
      mkdirSync(join(repo, "refs/heads"));
      symlinkSync(join(target, "main.lock"), join(repo, "refs/heads/main.lock"));
      expect(() => removeAbandonedPublicationLocks(options)).toThrow(/unexpected Git ref lock/);
      unlinkSync(join(repo, "refs/heads/main.lock"));
      symlinkSync(target, join(repo, "refs/heads/pr"));
      expect(() => removeAbandonedPublicationLocks(options)).toThrow();
      unlinkSync(join(repo, "refs/heads/pr"));
      mkdirSync(join(repo, "refs/heads/pr"));
      symlinkSync(join(target, "main.lock"), join(repo, "refs/heads/pr/1.lock"));
      expect(() => removeAbandonedPublicationLocks(options)).toThrow(/unexpected Git ref lock/);
      expect(readFileSync(join(target, "main.lock"), "utf8")).toBe("untouched");
    } finally {
      rmSync(reposDir, { recursive: true, force: true });
    }
  });

  describe.each(["write", "sync"])("partial staged objects after %s failure", (fault) => {
    let reposDir: string | undefined;
    const prepare = async () => {
      reposDir = mkdtempSync(join(tmpdir(), "kb-partial-write-"));
      const options = { reposDir, kbId: "partial", executor: testExecutor };
      const head = await writeInitialMainCommit(options, {
        message: "init",
        description: "original history",
      });
      const repo = join(reposDir, "kb_partial.git");
      const { objects } = stageTreeForFiles([
        { segments: ["new-a.md"], content: Buffer.from("# A\n") },
        { segments: ["new-b.md"], content: Buffer.from("# B\n") },
      ]);
      return { head, repo, objects };
    };
    let setup: ReturnType<typeof prepare> | undefined;
    beforeAll(() => {
      setup = prepare();
      return setup;
    }, 180_000);
    afterAll(async () => {
      await setup?.catch(() => {});
      if (reposDir) rmSync(reposDir, { recursive: true, force: true });
    }, 180_000);
    it("reclaims the partial staged object set", async () => {
      const fixture = await setup;
      if (!fixture) throw new Error("Partial object fixture is not ready");
      const { head, repo, objects } = fixture;
      try {
        if (fault === "write") faults.writesBeforeFailure = 1;
        else faults.syncDirectory = true;
        const created: string[] = [];
        expect(() => writeStagedObjects(repo, objects, created)).toThrow(/injected/);
        expect(created).toHaveLength(fault === "write" ? 2 : 1);
        for (const sha of created) {
          expect(existsSync(join(repo, "objects", sha.slice(0, 2), sha.slice(2)))).toBe(true);
        }
        faults.writesBeforeFailure = null;
        faults.syncDirectory = false;
        removeLooseObjects(repo, created);
        for (const sha of objects.keys()) {
          expect(existsSync(join(repo, "objects", sha.slice(0, 2), sha.slice(2)))).toBe(false);
        }
        expect(readHeadSha(repo)).toBe(head);
        expect(validateGitCommit({ repoPath: repo }, head)).toMatchObject({ ok: true });
      } finally {
        faults.writesBeforeFailure = null;
        faults.syncDirectory = false;
      }
    });
  });

  it("performs a single-ref cas update", async () => {
    const repos = mkdtempSync(join(tmpdir(), "kb-write-"));
    const kbId = "kbwrite1";
    try {
      const head = await writeInitialMainCommit(
        { reposDir: repos, kbId, executor: testExecutor },
        { message: "init", description: "desc for git write test" },
      );
      const repo = join(repos, `kb_${kbId}.git`);
      const next = await createTreeReuseCommit(
        { reposDir: repos, kbId },
        { parentSha: head, message: "child" },
      );
      expect(runGit(repo, ["cat-file", "-t", next])).toBe("commit");
      await fsyncRefUpdate(
        { reposDir: repos, kbId, executor: testExecutor },
        {
          refName: "refs/heads/main",
          newSha: next,
          oldSha: head,
          binding: publicationBinding(repo, next),
        },
      );
      expect(readHeadSha(repo)).toBe(next);
      await expect(
        fsyncRefUpdate(
          { reposDir: repos, kbId, executor: testExecutor },
          {
            refName: "refs/heads/main",
            newSha: head,
            oldSha: head,
            binding: publicationBinding(repo, head),
          },
        ),
      ).rejects.toThrow(/cas rejected/);
    } finally {
      rmSync(repos, { recursive: true, force: true });
    }
  });

  it("does not overwrite a ref when the expected old sha is stale", async () => {
    const repos = mkdtempSync(join(tmpdir(), "kb-write-"));
    const kbId = "kbwrite2";
    try {
      const head = await writeInitialMainCommit(
        { reposDir: repos, kbId, executor: testExecutor },
        { message: "init", description: "desc for git write test" },
      );
      const repo = join(repos, `kb_${kbId}.git`);
      const planned = await createTreeReuseCommit(
        { reposDir: repos, kbId },
        { parentSha: head, message: "planned" },
      );
      const foreign = await createTreeReuseCommit(
        { reposDir: repos, kbId },
        { parentSha: head, message: "foreign" },
      );
      runGit(repo, ["update-ref", "refs/heads/main", foreign]);
      await expect(
        fsyncRefUpdate(
          { reposDir: repos, kbId, executor: testExecutor },
          {
            refName: "refs/heads/main",
            newSha: planned,
            oldSha: head,
            binding: publicationBinding(repo, planned),
          },
        ),
      ).rejects.toThrow(/cas rejected/);
      expect(readHeadSha(repo)).toBe(foreign);
    } finally {
      rmSync(repos, { recursive: true, force: true });
    }
  });
  it.each(["openDirectory", "syncDirectory"] as const)(
    "propagates %s failures and resyncs reused loose objects",
    async (fault) => {
      const reposDir = mkdtempSync(join(tmpdir(), "kb-write-sync-"));
      const options = { reposDir, kbId: "durability", executor: testExecutor };
      try {
        const head = await writeInitialMainCommit(options, {
          message: "init",
          description: "durability",
        });
        const input = { parentSha: head, message: "same object", timestampSeconds: 1 };
        faults[fault] = true;
        await expect(createEmptyTreeCommit(options, input)).rejects.toThrow(/injected directory/);
        // The empty tree file exists after the failed sync. A retry must still
        // fail while the directory is unsyncable, instead of trusting existence.
        await expect(createEmptyTreeCommit(options, input)).rejects.toThrow(/injected directory/);
        faults[fault] = false;
        const sha = await createTreeReuseCommit(options, input);
        faults.syncs = 0;
        expect(await createTreeReuseCommit(options, input)).toBe(sha);
        expect(faults.syncs).toBeGreaterThan(0);
        faults[fault] = true;
        const repo = join(reposDir, "kb_durability.git");
        await expect(
          fsyncRefUpdate(options, {
            refName: "refs/heads/main",
            newSha: sha,
            oldSha: head,
            binding: publicationBinding(repo, sha),
          }),
        ).rejects.toThrow(/injected directory/);
        expect(readHeadSha(join(reposDir, "kb_durability.git"))).toBe(sha);
      } finally {
        faults[fault] = false;
        rmSync(reposDir, { recursive: true, force: true });
      }
    },
  );

  describe("corrupt reused object", () => {
    let reposDir: string | undefined;
    const prepare = async () => {
      reposDir = mkdtempSync(join(tmpdir(), "kb-write-corrupt-"));
      const options = { reposDir, kbId: "corrupt", executor: testExecutor };
      const head = await writeInitialMainCommit(options, {
        message: "init",
        description: "corruption",
      });
      const input = { parentSha: head, message: "same object", timestampSeconds: 1 };
      const sha = await createEmptyTreeCommit(options, input);
      const objectPath = join(reposDir, "kb_corrupt.git", "objects", sha.slice(0, 2), sha.slice(2));
      writeFileSync(objectPath, "partial", { flush: true });
      return { options, input, head, objectPath };
    };
    let setup: ReturnType<typeof prepare> | undefined;
    beforeAll(() => {
      setup = prepare();
      return setup;
    }, 180_000);
    afterAll(async () => {
      await setup?.catch(() => {});
      if (reposDir) rmSync(reposDir, { recursive: true, force: true });
    }, 180_000);
    it("rejects a corrupt reused loose object without replacing it", async () => {
      const fixture = await setup;
      if (!fixture) throw new Error("Corrupt object fixture is not ready");
      const { options, input, head, objectPath } = fixture;
      await expect(createEmptyTreeCommit(options, input)).rejects.toThrow();
      expect(readHeadSha(join(options.reposDir, "kb_corrupt.git"))).toBe(head);
      expect(readFileSync(objectPath, "utf8")).toBe("partial");
    });
  });
});
