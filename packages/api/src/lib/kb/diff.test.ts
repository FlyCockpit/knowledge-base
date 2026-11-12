import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffAtRevisions } from "./diff";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv } from "./git-read";
import { initialMainTreeFiles } from "./git-write";
import type { TreeFileInput } from "./staged-tree";

describe("immutable revision diff", () => {
  let repo: string;
  let base: string;
  let head: string;
  const assets = Array.from({ length: 205 }, (_, i) => ({
    path: `media/${String(i).padStart(3, "0")}.png`,
    hash: `sha256:${"a".repeat(64)}`,
    size: 10,
    mime: "image/png",
  }));
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "kb-pr-diff-"));
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const files = initialMainTreeFiles("Diff fixture knowledge base");
    const commit = (files: TreeFileInput[], parentSha = "0".repeat(40)) => {
      return writeGitFixtureCommit(repo, { parentSha, message: "diff", files });
    };
    base = commit(files);
    const changed = [
      ...files.filter((f) => f.segments.join("/") !== ".assets/manifest.json"),
      {
        segments: [".assets", "manifest.json"],
        content: Buffer.from(JSON.stringify({ version: 1, entries: assets })),
      },
      ...Array.from({ length: 205 }, (_, i) => ({
        segments: [`f${String(i).padStart(3, "0")}.md`],
        content: Buffer.from(`body ${i}`),
      })),
    ];
    head = commit(changed, base);
  }, 180_000);
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("pages more than 200 immutable files and touched manifest assets to a complete set", async () => {
    const paths: string[] = [];
    const touched: unknown[] = [];
    let after: string | null = null;
    do {
      const page = await diffAtRevisions({
        repoPath: repo,
        baseSha: base,
        headSha: head,
        limit: 200,
        after,
      });
      expect(page.files.length + page.touchedAssets.length).toBeLessThanOrEqual(200);
      paths.push(...page.files.map((f) => f.path));
      touched.push(...page.touchedAssets);
      after = page.nextAfter;
    } while (after);
    expect(new Set(paths).size).toBe(206);
    expect(touched).toHaveLength(205);
    expect(touched[0]).toEqual({ path: assets[0]!.path, before: null, after: assets[0] });
  });

  it("reverses touched assets when the revisions are reversed", async () => {
    expect(
      (await diffAtRevisions({ repoPath: repo, baseSha: head, headSha: base, limit: 1 }))
        .touchedAssets[0],
    ).toMatchObject({ before: assets[0], after: null });
  });

  it("returns an empty page for an unchanged revision", async () => {
    expect(
      await diffAtRevisions({ repoPath: repo, baseSha: base, headSha: base, limit: 20 }),
    ).toEqual({
      files: [],
      touchedAssets: [],
      nextAfter: null,
    });
  });
});
