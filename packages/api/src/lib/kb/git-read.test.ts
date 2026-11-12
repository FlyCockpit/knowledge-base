import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  isCommitReachable,
  listDocumentsAtRevision,
  readDocumentAtRevision,
} from "./documents-read";
import { gitFixtureTests } from "./fixtures/git-fixture";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { writeCountingGitWrapper } from "./fixtures/git-wrapper";
import * as gitReads from "./git-read";
import {
  assertKbId,
  createIncomingObjectBudget,
  hardenedGitEnv,
  kbBareRepoPath,
  readHeadSha,
  runGit,
  runGitAsync,
  TreeReadBudgetError,
  walkGitTreeEntries,
} from "./git-read";
import { initialMainTreeFiles } from "./git-write";

// Reader tests seed real native Git objects through the shared fixture writer.
// Production publication durability has its own git-write boundary tests.
function seedReadRepo(repos: string, kbId: string, description: string): string {
  const repo = kbBareRepoPath(repos, kbId);
  runGit(repos, ["init", "--bare", repo]);
  const head = writeGitFixtureCommit(repo, {
    parentSha: "0".repeat(40),
    message: "init",
    files: initialMainTreeFiles(description),
  });
  runGit(repo, ["update-ref", "refs/heads/main", head]);
  return head;
}

describe("git-read", () => {
  it("rejects cancelled/expired reads before spawning and preserves ordinary Git failures", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kb-read-lifetime-"));
    try {
      const stop = new AbortController();
      stop.abort();
      await expect(
        runGitAsync(scratch, ["--version"], { signal: stop.signal }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      await expect(
        runGitAsync(scratch, ["--version"], { deadlineAt: Date.now() - 1 }),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect((await runGitAsync(scratch, ["--version"])).stdout.toString()).toContain(
        "git version",
      );
      await expect(runGitAsync(scratch, ["--version"], { maxBuffer: 1 })).rejects.toMatchObject({
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
      await expect(
        runGitAsync(scratch, ["rev-parse", "--verify", "refs/heads/missing"]),
      ).rejects.toMatchObject({ code: 128 });
      await expect(
        runGitAsync(scratch, ["--version"], { env: hardenedGitEnv({ PATH: scratch }) }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    { input: undefined, sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
    { input: "", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" },
    { input: "hello\n", sha: "ce013625030ba8dba906f756967f9e9ca394464a" },
    { input: Buffer.from("hello\n"), sha: "ce013625030ba8dba906f756967f9e9ca394464a" },
  ])("sends complete input and EOF to a plumbing child ($input)", async ({ input, sha }) => {
    const result = await runGitAsync(tmpdir(), ["hash-object", "--stdin"], {
      input,
      deadlineAt: Date.now() + 2_000,
    });
    expect(result.stdout.toString().trim()).toBe(sha);
  });

  describe("published tree object inventory", () => {
    const test = gitFixtureTests("kb-read-published-", (repos) => {
      const kbId = "inventory";
      const head = seedReadRepo(repos, kbId, "published tree");
      return { repo: kbBareRepoPath(repos, kbId), head };
    });
    test("collects descendant trees and blobs from the same pinned listing", async (f) => {
      const objects = new Set<string>();
      const blobs = await gitReads.readCommitBlobsAsync(f.repo, f.head, {}, objects);
      expect(blobs).toEqual(gitReads.readCommitBlobs(f.repo, f.head));
      for (const sha of blobs.values()) expect(objects.has(sha)).toBe(true);
      const assetsTree = runGit(f.repo, ["rev-parse", `${f.head}:.assets`]);
      expect(objects.has(assetsTree)).toBe(true);
      expect(objects.has(f.head)).toBe(false);
    });
  });

  describe("checks retained-tip ancestry in one bounded Git invocation", () => {
    const test = gitFixtureTests("kb-read-tips-", async (repos) => {
      const kbId = "lifetime";
      const head = seedReadRepo(repos, kbId, "tip budget");
      const repo = kbBareRepoPath(repos, kbId);
      const unreachable = writeGitFixtureCommit(repo, {
        parentSha: head,
        message: "unretained",
        files: [],
      });
      execFileSync("git", ["update-ref", "--stdin"], {
        cwd: repo,
        env: hardenedGitEnv(),
        input: Array.from({ length: 80 }, (_, i) => `update refs/heads/tip-${i} ${head}\n`).join(
          "",
        ),
      });

      return { head, repo, unreachable };
    });
    test("checks retained-tip ancestry in one bounded Git invocation", async ({
      head,
      repo,
      unreachable,
    }) => {
      expect(await isCommitReachable(repo, head)).toBe(true);
      expect(await isCommitReachable(repo, unreachable)).toBe(false);
      const bin = join(repo, "test-bin");
      const log = join(repo, "git-calls");
      mkdirSync(bin);
      const git = writeCountingGitWrapper(bin, log, "all");
      const previousPath = process.env.PATH;
      try {
        vi.stubEnv("PATH", `${bin}:${previousPath}`);
        expect(await isCommitReachable(repo, unreachable, { deadlineAt: Date.now() + 5_000 })).toBe(
          false,
        );
        expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
          `for-each-ref --contains=${unreachable} --count=1 --format=%(objectname) refs/heads`,
        ]);
        // A controlled slow child tests the deadline without relying on ref-count cost.
        writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 5\n");
        const deadlineAt = Date.now() + 100;
        await expect(isCommitReachable(repo, unreachable, { deadlineAt })).rejects.toMatchObject({
          code: "DEADLINE_EXCEEDED",
        });
        expect(Date.now() - deadlineAt).toBeLessThan(2_000);
        writeFileSync(join(bin, "git"), `#!/bin/sh\nexec '${git.replaceAll("'", "'\\''")}' "$@"\n`);
        // The expired attempt must not contaminate a fresh operation.
        expect(await isCommitReachable(repo, head)).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("retains the timer's deadline cause when the wall clock moves backward", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kb-read-clock-"));
    const fifo = join(scratch, "blocked-input");
    execFileSync("mkfifo", [fifo]);
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      // Native Git blocks opening a file with no writer, independently of stdin EOF.
      const pending = runGitAsync(scratch, ["hash-object", fifo], {
        deadlineAt: now + 100,
      });
      // Scheduling is synchronous; move only wall time after the real timer is armed.
      now -= 5_000;
      await expect(pending).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      // A fresh, successful child must not inherit the previous terminal cause.
      expect((await runGitAsync(scratch, ["--version"])).stdout.toString()).toContain(
        "git version",
      );
    } finally {
      clock.mockRestore();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    { reason: undefined, code: "CANCELLED" },
    { reason: new DOMException("Deadline exceeded", "TimeoutError"), code: "DEADLINE_EXCEEDED" },
  ])("preserves $code for an externally stopped real child", async ({ reason, code }) => {
    const scratch = mkdtempSync(join(tmpdir(), "kb-read-abort-"));
    const fifo = join(scratch, "blocked-input");
    execFileSync("mkfifo", [fifo]);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(reason), 100);
    try {
      await expect(
        runGitAsync(scratch, ["hash-object", fifo], { signal: stop.signal }),
      ).rejects.toMatchObject({ code });
      expect((await runGitAsync(scratch, ["--version"])).stdout.toString()).toContain(
        "git version",
      );
    } finally {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  describe.skipIf(process.platform !== "linux")(
    "times out and joins a real blocked blob child; listing cannot swallow cancellation",
    () => {
      const test = gitFixtureTests("kb-read-fifo-", async (repos) => {
        const kbId = "blocked";
        const head = seedReadRepo(repos, kbId, "blocked blob");
        const repo = kbBareRepoPath(repos, kbId);
        const blob = runGit(repo, ["rev-parse", `${head}:index.md`]);
        const objectPath = join(repo, "objects", blob.slice(0, 2), blob.slice(2));
        const bytes = readFileSync(objectPath);

        return { repos, kbId, head, repo, blob, objectPath, bytes };
      });
      test("times out and joins a real blocked blob child; listing cannot swallow cancellation", async ({
        repos,
        kbId,
        head,
        repo,
        blob,
        objectPath,
        bytes,
      }) => {
        try {
          unlinkSync(objectPath);
          execFileSync("mkfifo", [objectPath]);
          await expect(
            runGitAsync(repo, ["cat-file", "blob", blob], { deadlineAt: Date.now() + 100 }),
          ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
        } finally {
          unlinkSync(objectPath);
          writeFileSync(objectPath, bytes);
        }
        const stop = new AbortController();
        // Cancel at completion of the real metadata blob read, inside the list's catch.
        // This branch check complements the uninstrumented stalled-child MCP regression.
        const nativeRead = gitReads.readBlobsAsync;
        const read = vi.spyOn(gitReads, "readBlobsAsync").mockImplementation(async (...args) => {
          const result = await nativeRead(...args);
          stop.abort();
          gitReads.assertGitReadActive(args[3]);
          return result;
        });
        try {
          await expect(
            listDocumentsAtRevision({
              reposDir: repos,
              kbId,
              commitSha: head,
              limit: 1,
              signal: stop.signal,
            }),
          ).rejects.toMatchObject({ code: "CANCELLED" });
        } finally {
          read.mockRestore();
        }
        const document = await readDocumentAtRevision({
          reposDir: repos,
          kbId,
          commitSha: head,
          path: "index.md",
        });
        expect(document.markdown).toContain("blocked blob");
        expect(
          (await listDocumentsAtRevision({ reposDir: repos, kbId, commitSha: head, limit: 1 }))
            .items,
        ).toHaveLength(1);
      });
    },
  );

  it("rejects invalid kb ids", () => {
    expect(() => assertKbId("../evil")).toThrow();
  });

  it("keeps hardening keys non-overridable through extra env", () => {
    const env = hardenedGitEnv({
      GIT_CONFIG_GLOBAL: "/home/attacker/gitconfig",
      GIT_TERMINAL_PROMPT: "1",
      GIT_NO_REPLACE_OBJECTS: "0",
    });
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  describe("reads the requested object even when refs/replace is planted", () => {
    const test = gitFixtureTests("kb-repos-", async (repos) => {
      const kbId = "kbreplace1";
      const original = seedReadRepo(repos, kbId, "replace refs must not substitute objects");
      const repo = kbBareRepoPath(repos, kbId);
      const replacement = writeGitFixtureCommit(repo, {
        parentSha: original,
        message: "replacement",
        files: [],
      });
      const originalTree = runGit(repo, ["rev-parse", `${original}^{tree}`]);
      const replacementTree = runGit(repo, ["rev-parse", `${replacement}^{tree}`]);
      runGit(repo, ["update-ref", `refs/replace/${original}`, replacement]);

      return { original, repo, originalTree, replacementTree };
    });
    test("reads the requested object even when refs/replace is planted", async ({
      original,
      repo,
      originalTree,
      replacementTree,
    }) => {
      expect(originalTree).not.toBe(replacementTree);
      // Control: with replace refs active, git resolves the substitute.
      const permissiveEnv = hardenedGitEnv();
      delete permissiveEnv.GIT_NO_REPLACE_OBJECTS;
      expect(
        runGit(
          repo,
          ["-c", "core.useReplaceRefs=true", "rev-parse", `${original}^{tree}`],
          permissiveEnv,
        ),
      ).toBe(replacementTree);
      // Hardened reads interpret the requested object itself — the env gate
      // holds even when the repo config would allow substitution.
      expect(runGit(repo, ["rev-parse", `${original}^{tree}`])).toBe(originalTree);
      expect(
        runGit(repo, ["-c", "core.useReplaceRefs=true", "rev-parse", `${original}^{tree}`]),
      ).toBe(originalTree);
    });
  });

  describe("reads head from a seeded bare repo", () => {
    const test = gitFixtureTests("kb-repos-", async (repos) => {
      const kbId = "kbtest1";
      const sha = seedReadRepo(repos, kbId, "desc for git read test");

      return { repos, kbId, sha };
    });
    test("reads head from a seeded bare repo", async ({ repos, kbId, sha }) => {
      expect(kbBareRepoPath(repos, kbId)).toContain(`kb_${kbId}.git`);
      expect(readHeadSha(kbBareRepoPath(repos, kbId))).toBe(sha);
    });
  });

  describe("counts every walked entry exactly once", () => {
    const test = gitFixtureTests("kb-repos-walk-", async (repos) => {
      const kbId = "kbwalk1";
      const sha = seedReadRepo(repos, kbId, "walk budget");
      const repo = kbBareRepoPath(repos, kbId);
      const treeSha = runGit(repo, ["rev-parse", `${sha}^{tree}`]);

      return { repo, treeSha };
    });
    test("counts every walked entry exactly once", async ({ repo, treeSha }) => {
      const budget = { entries: 0, maxEntries: 8192 };
      const entries = walkGitTreeEntries(repo, treeSha, budget);
      // Root tree + .assets + .assets/manifest.json + .gitignore + index.md:
      // directories are charged once, not again when visit() enters them.
      expect(budget.entries).toBe(5);
      expect(entries.map((entry) => entry.path).sort()).toEqual([
        ".assets",
        ".assets/manifest.json",
        ".gitignore",
        "index.md",
      ]);
    });
  });

  describe("revisits shared tree objects at every path and charges every logical entry", () => {
    const test = gitFixtureTests("kb-repos-shared-tree-", async (scratch) => {
      runGit(scratch, ["init", "--quiet", "--bare", "repo.git"]);
      const repo = join(scratch, "repo.git");
      const gitInput = (args: string[], input: string): string =>
        execFileSync("git", args, { cwd: repo, env: hardenedGitEnv(), input })
          .toString("utf8")
          .trim();
      const blob = gitInput(["hash-object", "-w", "--stdin"], "x\n");
      const child = gitInput(["mktree"], `100644 blob ${blob}\tf.md\n`);
      const root = gitInput(
        ["mktree"],
        `040000 tree ${child}\tleft\n040000 tree ${child}\tright\n`,
      );

      return { repo, child, root };
    });
    test("revisits shared tree objects at every path and charges every logical entry", async ({
      repo,
      child,
      root,
    }) => {
      const incoming = createIncomingObjectBudget(2, 1024);
      const budget = { entries: 0, maxEntries: 5 };
      expect(walkGitTreeEntries(repo, root, budget, incoming).map((entry) => entry.path)).toEqual([
        "left",
        "left/f.md",
        "right",
        "right/f.md",
      ]);
      expect(budget.entries).toBe(5);
      // Physical object accounting stays distinct from per-path traversal.
      expect(incoming.objects).toBe(2);
      expect(incoming.seen).toEqual(new Set([root, child]));
      expect(() => walkGitTreeEntries(repo, root, { entries: 0, maxEntries: 4 })).toThrow(
        TreeReadBudgetError,
      );
      expect(() =>
        walkGitTreeEntries(
          repo,
          root,
          { entries: 0, maxEntries: 5 },
          createIncomingObjectBudget(1, 1024),
        ),
      ).toThrow(TreeReadBudgetError);
    });
  });

  describe("reads repeated immutable subtrees once per walk but charges every path", () => {
    const test = gitFixtureTests("kb-walk-shared-", async (root) => {
      runGit(root, ["init", "--bare", "--quiet"]);
      const blob = runGit(root, ["hash-object", "-w", "--stdin"], hardenedGitEnv());
      const tree = spawnTree(`100644 blob ${blob}\tf.md\n`);
      const parent = spawnTree(
        Array.from(
          { length: 32 },
          (_, i) => `040000 tree ${tree}\td${String(i).padStart(2, "0")}\n`,
        ).join(""),
      );
      function spawnTree(input: string) {
        return execFileSync("git", ["mktree"], {
          cwd: root,
          env: hardenedGitEnv(),
          input,
          encoding: "utf8",
        }).trim();
      }
      const bin = join(root, "bin");
      const log = join(root, "reads");
      mkdirSync(bin);
      writeCountingGitWrapper(bin, log, "all");

      return { root, parent, bin, log };
    });
    test("reads repeated immutable subtrees once per walk but charges every path", async ({
      root,
      parent,
      bin,
      log,
    }) => {
      const previousPath = process.env.PATH;
      try {
        vi.stubEnv("PATH", `${bin}:${previousPath}`);
        for (let invocation = 0; invocation < 2; invocation += 1) {
          writeFileSync(log, "");
          const budget = { entries: 0, maxEntries: 65 };
          const incoming = createIncomingObjectBudget(10, 1024 * 1024);
          const entries = walkGitTreeEntries(root, parent, budget, incoming);
          expect(entries).toHaveLength(64);
          expect(budget.entries).toBe(65);
          expect(incoming.objects).toBe(2);
          const reads = readFileSync(log, "utf8").trim().split("\n");
          // One listing names the distinct subtrees, one batched read loads them.
          expect(reads).toEqual([`ls-tree -r -t -z ${parent}`, "cat-file --batch"]);
        }
        const small = { entries: 0, maxEntries: 2 };
        expect(() => walkGitTreeEntries(root, parent, small)).toThrow(TreeReadBudgetError);
        expect(small.entries).toBe(3);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});

describe("batched blob reads own their subprocess lifecycle", () => {
  const test = gitFixtureTests("kb-read-batch-", (root) => {
    const repo = join(root, "kb_batch.git");
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    // Enough distinct blobs that stdin backpressure engages mid-write.
    const files = Array.from({ length: 3500 }, (_, n) => ({
      segments: ["b", `${n}.md`],
      content: Buffer.from(`# ${n}\n${"z".repeat(n % 97)}\n`),
    }));
    const head = writeGitFixtureCommit(repo, {
      parentSha: "0".repeat(40),
      message: "batch",
      files: [...initialMainTreeFiles("Batch fixture"), ...files],
    });
    const shas = runGit(repo, ["ls-tree", "-r", head])
      .split("\n")
      .map((line) => line.split(/\s+/)[2]!)
      .filter(Boolean);
    return { repo, shas };
  });
  const watchUnhandled = () => {
    const seen: unknown[] = [];
    const record = (error: unknown) => seen.push(error);
    process.on("uncaughtException", record);
    process.on("unhandledRejection", record);
    return {
      seen,
      stop: () => {
        process.off("uncaughtException", record);
        process.off("unhandledRejection", record);
      },
    };
  };
  test("reads every blob in one process", async (f) => {
    const blobs = await gitReads.readBlobsAsync(f.repo, f.shas, { maxBytes: 1 << 20 }, {});
    expect(blobs.size).toBe(new Set(f.shas).size);
  });
  test("cancellation at any point settles once, with no unhandled stream error", async (f) => {
    const watch = watchUnhandled();
    try {
      for (const delay of [0, 1, 1, 2, 3, 5, 8]) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), delay);
        const outcome = await gitReads
          .readBlobsAsync(f.repo, f.shas, { maxBytes: 1 << 20 }, { signal: abort.signal })
          .then(
            () => "resolved",
            () => "rejected",
          );
        clearTimeout(timer);
        expect(["resolved", "rejected"]).toContain(outcome);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
    }
  });
  for (const [when, shift] of [
    ["the wall clock moves backward", -5_000],
    ["the timer fires before the wall clock reaches the deadline", 0],
  ] as const)
    test(`a deadline-killed batch child is DEADLINE_EXCEEDED when ${when}`, async (f) => {
      // A real cat-file child blocked in open(2) on one object: only the
      // deadline kill can end it, so its close is always a non-zero exit.
      const object = join(f.repo, "objects", f.shas[0]!.slice(0, 2), f.shas[0]!.slice(2));
      const original = readFileSync(object);
      unlinkSync(object);
      execFileSync("mkfifo", [object]);
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const pending = gitReads.readBlobsAsync(
          f.repo,
          f.shas.slice(0, 3),
          { maxBytes: 1 << 20 },
          { deadlineAt: now + 100 },
        );
        // The real timer is armed; wall time never reaches the deadline now.
        now += shift;
        await expect(pending).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      } finally {
        clock.mockRestore();
        unlinkSync(object);
        writeFileSync(object, original);
      }
      // The next read does not inherit the previous kill.
      expect((await gitReads.readBlobsAsync(f.repo, f.shas, { maxBytes: 1 << 20 }, {})).size).toBe(
        new Set(f.shas).size,
      );
    });
  test("deadline expiry during a large batch rejects and settles", async (f) => {
    const watch = watchUnhandled();
    try {
      const outcome = await gitReads
        .readBlobsAsync(f.repo, f.shas, { maxBytes: 1 << 20 }, { deadlineAt: Date.now() + 2 })
        .then(
          () => "resolved",
          (error: unknown) => (error as { code?: string }).code ?? "rejected",
        );
      expect(["resolved", "DEADLINE_EXCEEDED"]).toContain(outcome);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
    }
  });
});

describe("ref reads tell a missing ref from a broken one (R3-W10 review)", () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-ref-read-"));
    const env = { ...gitReads.hardenedGitEnv() };
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
    run("init", "--bare", "--quiet", "--initial-branch=main");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      env,
      input: "x\n",
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["mktree"], {
      cwd: dir,
      env,
      input: `100644 blob ${blob}\tf\n`,
      encoding: "utf8",
    }).trim();
    const commit = run("commit-tree", tree, "-m", "m");
    run("update-ref", "refs/heads/main", commit);
    return { dir, commit, run };
  };
  const both = async (dir: string, ref: string) => [
    await gitReads.readRefShaAsync(dir, ref, {}).catch((error: unknown) => error),
    (() => {
      try {
        return gitReads.readRefSha(dir, ref);
      } catch (error) {
        return error;
      }
    })(),
  ];
  it("reads a ref and reports a missing one as null", async () => {
    const { dir, commit, run } = repo();
    try {
      expect(await both(dir, "refs/heads/main")).toEqual([commit, commit]);
      expect(await both(dir, "refs/heads/missing")).toEqual([null, null]);
      // A namespace directory is not the ref itself.
      mkdirSync(join(dir, "refs/heads/team"));
      expect(await both(dir, "refs/heads/team")).toEqual([null, null]);
      run("update-ref", "refs/heads/team/sub", commit);
      expect(await both(dir, "refs/heads/team")).toEqual([null, null]);
      // Packed refs read normally.
      run("update-ref", "refs/heads/packed", commit);
      run("pack-refs", "--all");
      expect(await both(dir, "refs/heads/packed")).toEqual([commit, commit]);
      expect(gitReads.readRefSha(join(dir, "absent-repo"), "refs/heads/main")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ["garbage", (dir: string) => writeFileSync(join(dir, "refs/heads/topic"), "garbage\n")],
    [
      "dangling symbolic",
      (dir: string) => writeFileSync(join(dir, "refs/heads/topic"), "ref: refs/heads/nowhere\n"),
    ],
    [
      "broken packed",
      (dir: string) => writeFileSync(join(dir, "packed-refs"), "not-a-sha refs/heads/topic\n"),
    ],
    // Not the requested ref at all: a malformed ref store is still a storage failure.
    [
      "malformed unrelated packed",
      (dir: string) =>
        writeFileSync(
          join(dir, "packed-refs"),
          "# pack-refs with: peeled fully-peeled sorted \nnot-a-sha refs/heads/other\n",
        ),
    ],
    [
      "unrelated garbage packed line",
      (dir: string) => writeFileSync(join(dir, "packed-refs"), "garbage\n"),
    ],
    [
      "broken repository config",
      (dir: string) => writeFileSync(join(dir, "config"), "[core\nbroken"),
    ],
    ["not a repository", (dir: string) => rmSync(join(dir, "HEAD"))],
  ])("reports a %s ref as a storage failure, never as absent", async (_name, corrupt) => {
    const { dir } = repo();
    try {
      corrupt(dir);
      for (const result of await both(dir, "refs/heads/topic"))
        expect(result).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an unreadable repository is a storage failure in both ref readers", () => {
  it.skipIf(process.getuid?.() === 0)("EACCES on an ancestor, sync and async alike", async () => {
    const root = mkdtempSync(join(tmpdir(), "kb-ref-eacces-"));
    const locked = join(root, "locked");
    const repo = join(locked, "r.git");
    try {
      mkdirSync(locked);
      execFileSync("git", ["init", "--bare", "--quiet", repo], { env: gitReads.hardenedGitEnv() });
      chmodSync(locked, 0o000);
      const sync = (() => {
        try {
          return gitReads.readRefSha(repo, "refs/heads/main");
        } catch (error) {
          return error;
        }
      })();
      const async = await gitReads
        .readRefShaAsync(repo, "refs/heads/main", {})
        .catch((error: unknown) => error);
      for (const result of [sync, async])
        expect(result).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      // A repository that does not exist yet still reads as having no refs.
      expect(gitReads.readRefSha(join(root, "absent.git"), "refs/heads/main")).toBeNull();
    } finally {
      chmodSync(locked, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("gitBinary", () => {
  it("is the absolute git the server's own PATH resolves, used for the smart-HTTP backend", () => {
    const first = (process.env.PATH ?? "")
      .split(":")
      .filter((dir) => dir.startsWith("/"))
      .map((dir) => join(dir, "git"))
      .find((path) => {
        try {
          return execFileSync("test", ["-x", path, "-a", "-f", path]) !== undefined;
        } catch {
          return false;
        }
      });
    expect(gitReads.gitBinary()).toBe(first);
  });
});
