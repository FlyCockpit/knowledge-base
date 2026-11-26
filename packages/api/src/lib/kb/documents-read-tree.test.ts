import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOCUMENT_TREE_PAGE_MAX, listDocumentPathsAtRevision } from "./documents-read";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv, kbBareRepoPath } from "./git-read";
import { initialMainTreeFiles } from "./git-write";
import type { TreeFileInput } from "./staged-tree";

const file = (path: string, body = "x"): TreeFileInput => ({
  segments: path.split("/"),
  content: Buffer.from(`${body}\n`, "utf8"),
});

describe("listDocumentPathsAtRevision", () => {
  const kbId = "tree_fixture";
  let reposDir: string;
  let head: string;
  beforeAll(() => {
    reposDir = mkdtempSync(join(tmpdir(), "kb-doc-tree-"));
    const repo = kbBareRepoPath(reposDir, kbId);
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    head = writeGitFixtureCommit(repo, {
      parentSha: "0".repeat(40),
      message: "Create",
      files: [
        ...initialMainTreeFiles("Tree fixture"),
        file("z.md"),
        file("a/deep/one.md"),
        file("a/two.md"),
        file("B.md"),
        file("notes.txt"),
        file("img/pic.png"),
      ],
      timestampSeconds: 1_800_000_000,
    });
    // Reads are admitted only at commits a branch reaches.
    execFileSync("git", ["update-ref", "refs/heads/main", head], {
      cwd: repo,
      env: hardenedGitEnv(),
    });
  }, 120_000);
  afterAll(() => {
    if (reposDir) rmSync(reposDir, { recursive: true, force: true });
  });

  const list = (limit: number, afterPath: string | null = null, commitSha = head) =>
    listDocumentPathsAtRevision({ reposDir, kbId, commitSha, limit, afterPath });

  it("lists every Markdown path in byte order, nothing else", async () => {
    const page = await list(100);
    expect(page.nextAfter).toBeNull();
    // initialMainTreeFiles' own documents are listed too (they are documents).
    expect(page.paths).toEqual([...page.paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(page.paths).toEqual(
      expect.arrayContaining(["B.md", "a/deep/one.md", "a/two.md", "z.md"]),
    );
    expect(page.paths.every((path) => path.endsWith(".md"))).toBe(true);
    expect(page.paths).not.toContain("notes.txt");
    expect(page.paths).not.toContain("img/pic.png");
  });

  it("pages after a path and bounds the page", async () => {
    const all = (await list(100)).paths;
    const first = await list(2);
    expect(first.paths).toEqual(all.slice(0, 2));
    expect(first.nextAfter).toBe(all[1]);
    const rest = await list(100, first.nextAfter);
    expect(rest.paths).toEqual(all.slice(2));
    expect(rest.nextAfter).toBeNull();
    const huge = await list(DOCUMENT_TREE_PAGE_MAX * 10);
    expect(huge.paths).toEqual(all);
  });

  it("an unknown revision is not found", async () => {
    await expect(list(10, null, "f".repeat(40))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
