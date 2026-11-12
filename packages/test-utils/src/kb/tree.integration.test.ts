import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hardenedGitEnv,
  kbBareRepoPath,
  readCommitMetadata,
  readHeadSha,
  runGit,
} from "@knowledge-base/api/lib/kb/git-read";
import {
  createTreeReuseCommit,
  GitCommandError,
  type GitMutatingExecutor,
  writeInitialMainCommit,
} from "@knowledge-base/api/lib/kb/git-write";
import {
  validateGitCommit,
  validateNewlyReachableCommits,
} from "@knowledge-base/api/lib/kb/validate-tree";
import { describe, expect, it } from "vitest";

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

function seedWorkTree(work: string, indexBody: string): void {
  writeFileSync(join(work, "index.md"), indexBody, "utf8");
  writeFileSync(join(work, ".gitignore"), "# kb managed\n", "utf8");
  mkdirSync(join(work, ".assets"), { recursive: true });
  writeFileSync(join(work, ".assets/manifest.json"), '{"version":1,"entries":[]}\n', "utf8");
}

describe("tree integration", () => {
  it("rejects an invalid intermediate commit while preserving author metadata on valid history", async () => {
    const reposDir = mkdtempSync(join(tmpdir(), "kb-tree-int-"));
    const work = mkdtempSync(join(tmpdir(), "kb-tree-int-work-"));
    try {
      const kbId = "integration";
      const base = await writeInitialMainCommit(
        { reposDir, kbId, executor: testExecutor },
        { message: "init", description: "integration tree validation" },
      );
      const repo = kbBareRepoPath(reposDir, kbId);
      const baseMeta = readCommitMetadata(repo, base);
      runGit(work, ["clone", repo, "clone"], hardenedGitEnv());
      const cloneRoot = join(work, "clone");
      seedWorkTree(cloneRoot, "# middle invalid\n\u0001\n");
      runGit(cloneRoot, ["add", "index.md"], hardenedGitEnv());
      runGit(cloneRoot, ["commit", "-m", "invalid middle"], hardenedGitEnv());
      const invalidMiddle = readHeadSha(cloneRoot)!;
      expect(validateGitCommit({ repoPath: cloneRoot }, invalidMiddle).ok).toBe(false);
      seedWorkTree(cloneRoot, "# valid tip\n");
      runGit(cloneRoot, ["add", "index.md"], hardenedGitEnv());
      runGit(cloneRoot, ["commit", "-m", "valid tip"], hardenedGitEnv());
      const validTip = readHeadSha(cloneRoot)!;
      expect(validateGitCommit({ repoPath: cloneRoot }, validTip).ok).toBe(true);
      const range = await validateNewlyReachableCommits(
        { repoPath: cloneRoot },
        { oldSha: base, newSha: validTip },
      );
      expect(range.ok).toBe(false);
      const baseTimestamp = Number.parseInt(/ (\d+) \+0000$/.exec(baseMeta.author)?.[1] ?? "", 10);
      const replay = await createTreeReuseCommit(
        { reposDir, kbId },
        { parentSha: base, message: "replay", timestampSeconds: baseTimestamp },
      );
      const replayMeta = readCommitMetadata(repo, replay);
      expect(replayMeta.author).toBe(baseMeta.author);
      expect(replayMeta.sha).not.toBe(base);
    } finally {
      rmSync(reposDir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
