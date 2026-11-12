import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { gitFixtureTests } from "./fixtures/git-fixture";

import {
  initBareKbRepo,
  removeLooseObjects,
  writeInitialMainCommitLoose,
  writeStagedObjects,
} from "./git-write";
import { KB_MANAGED_GITIGNORE } from "./paths";
import { stageCommitWithTreeFiles, stagedNewObjectBytes } from "./staged-tree";
import { validateGitCommit, validateStagedCommitTree } from "./validate-tree";

/** Real Git through an async supervised-style transport (exit status only). */
const testExecutor = {
  exec(input: { cwd: string; argv: readonly string[]; env: NodeJS.ProcessEnv }) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(input.argv[0]!, input.argv.slice(1) as string[], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git ${input.argv[1]} exited with ${code}`));
      });
    });
  },
};

function validTreeFiles(extra: Record<string, string> = []) {
  return [
    { segments: ["index.md"], content: Buffer.from("# Knowledge base\n\nstaged\n", "utf8") },
    { segments: [".gitignore"], content: Buffer.from(KB_MANAGED_GITIGNORE, "utf8") },
    {
      segments: [".assets", "manifest.json"],
      content: Buffer.from('{"version":1,"entries":[]}\n', "utf8"),
    },
    ...Object.entries(extra).map(([path, markdown]) => ({
      segments: path.split("/"),
      content: Buffer.from(markdown, "utf8"),
    })),
  ];
}

function looseObjectBytes(repo: string): number {
  const objectsDir = join(repo, "objects");
  let total = 0;
  for (const entry of readdirSync(objectsDir, { withFileTypes: true })) {
    if (!/^[0-9a-f]{2}$/.test(entry.name)) continue;
    for (const name of readdirSync(join(objectsDir, entry.name))) {
      total += statSync(join(objectsDir, entry.name, name)).size;
    }
  }
  return total;
}

describe("staged-tree", () => {
  const test = gitFixtureTests("kb-staged-", async (reposDir) => {
    const kbId = "stagedparity";
    await initBareKbRepo({ reposDir, kbId, executor: testExecutor });
    const repo = join(reposDir, `kb_${kbId}.git`);
    const initial = await writeInitialMainCommitLoose(repo, {
      message: "init",
      description: "staged parity",
    });
    return { reposDir, repo, initial };
  });

  test("rejects a duplicate document id before any object reaches the repository", ({
    reposDir,
  }) => {
    const repo = join(reposDir, "kb_missing.git");
    const staged = stageCommitWithTreeFiles({
      parentSha: "5".repeat(40),
      message: "duplicate ids",
      timestampSeconds: 1,
      files: validTreeFiles({
        "docs/a.md": "---\nid: same\n---\n# A\n",
        "docs/b.md": "---\nid: same\n---\n# B\n",
      }),
    });
    const validation = validateStagedCommitTree(staged);
    expect(validation).toMatchObject({ ok: false, code: "TREE_DOCUMENT_ID" });
    // Staging is pure: nothing was materialized, not even the object store.
    expect(existsSync(join(repo, "objects"))).toBe(false);
  });

  test("flags file and directory path collisions in the staged tree", () => {
    const staged = stageCommitWithTreeFiles({
      parentSha: "5".repeat(40),
      message: "collision",
      timestampSeconds: 1,
      files: validTreeFiles({ a: "file", "a/b.md": "# nested\n" }),
    });
    expect(validateStagedCommitTree(staged)).toMatchObject({ ok: false, code: "TREE_PATH" });
  });

  test("charges exactly the bytes the durable writer adds and reclaims them on abort", ({
    repo,
    initial,
  }) => {
    const staged = stageCommitWithTreeFiles({
      parentSha: initial.headSha,
      message: "edit",
      timestampSeconds: 123,
      files: validTreeFiles({ "docs/new.md": "# New\n" }),
    });
    expect(validateStagedCommitTree(staged)).toMatchObject({ ok: true });
    const { physicalBytes, diskFloorBytes } = stagedNewObjectBytes(repo, staged.objects);
    expect(physicalBytes).toBeGreaterThan(0n);
    // Disk admission is block-rounded and never below the exact byte sum.
    expect(diskFloorBytes).toBeGreaterThanOrEqual(physicalBytes);
    expect(diskFloorBytes % 4096n).toBe(0n);

    // The required root files deduplicate with the initial commit, so only
    // part of the staged set is new — and only that part is charged.
    const before = looseObjectBytes(repo);
    const created = writeStagedObjects(repo, staged.objects);
    expect(created.length).toBeLessThan(staged.objects.size);
    expect(BigInt(looseObjectBytes(repo) - before)).toBe(physicalBytes);
    // Once materialized, the same staged set measures zero new bytes.
    expect(stagedNewObjectBytes(repo, staged.objects)).toMatchObject({
      physicalBytes: 0n,
      diskFloorBytes: 0n,
    });
    // The repository-side validator agrees with the staged validation.
    expect(validateGitCommit({ repoPath: repo }, staged.commitSha)).toMatchObject({
      ok: true,
      treeSha: staged.rootTreeSha,
    });

    // Aborting reclaims exactly the objects this operation created and
    // leaves the pre-existing (deduplicated) history intact.
    removeLooseObjects(repo, created);
    expect(looseObjectBytes(repo)).toBe(before);
    expect(validateGitCommit({ repoPath: repo }, initial.headSha)).toMatchObject({ ok: true });
  });
});
