import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const gitCalls = vi.hoisted(() => ({ count: 0 }));
// Count real metadata executions without retaining the large inputs/results
// that a module-wide spy would keep throughout the range-budget fixtures.
// Blob-content reads intentionally stay per logical file (no blob buffers are
// cached), so only tree listings and object-size reads are counted.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: new Proxy(actual.execFileSync, {
      apply(target, receiver, args) {
        const argv = args[1];
        if (!(Array.isArray(argv) && argv[0] === "cat-file" && argv[1] === "blob")) {
          gitCalls.count += 1;
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  };
});

import { gitFixtureTests } from "./fixtures/git-fixture";
import { writeCountingGitWrapper } from "./fixtures/git-wrapper";
import cases from "./fixtures/tree-cases.json";
import {
  hardenedGitEnv,
  kbBareRepoPath,
  listNewlyReachableObjects,
  readCommitMetadata,
  readHeadSha,
  readObjectSizeBytes,
  runGit,
  TreeReadBudgetError,
  TreeStructureError,
  walkGitTreeEntries,
} from "./git-read";
import {
  bindValidatedTreeForPublication,
  createTreeReuseCommit,
  fsyncRefUpdateWithBinding,
  GitCommandError,
  type GitMutatingExecutor,
  validateProposedCommitTree,
  writeInitialMainCommit,
} from "./git-write";
import { KB_TREE_LIMITS } from "./limits";
import { validatePush, ZERO_SHA } from "./push-validation";
import { sealedTreeValidator } from "./sealed-reference";
import { stageCommitWithTreeFiles } from "./staged-tree";
import {
  assertPublicationTreeBinding,
  createPublicationTreeBinding,
  TreePublicationBindingError,
  validateGitCommit,
  validateNewlyReachableCommits,
  validateStagedCommitTree,
} from "./validate-tree";

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

type InitialTreeFixture = { reposDir: string; kbId: string; repo: string; head: string };

function initialTreeTests(kbId: string, description: string) {
  return gitFixtureTests("kb-tree-initial-", async (reposDir) => {
    const head = await writeInitialMainCommit(
      { reposDir, kbId, executor: testExecutor },
      { message: "init", description },
    );
    return {
      reposDir,
      kbId,
      repo: kbBareRepoPath(reposDir, kbId),
      head,
    } satisfies InitialTreeFixture;
  });
}

type FixtureCase = { files: Record<string, string> };

function seedRequiredFiles(work: string, indexBody: string): void {
  writeFileSync(join(work, "index.md"), indexBody, "utf8");
  writeFileSync(join(work, ".gitignore"), "# kb managed\n", "utf8");
  mkdirSync(join(work, ".assets"), { recursive: true });
  writeFileSync(join(work, ".assets/manifest.json"), '{"version":1,"entries":[]}\n', "utf8");
}

function commitFixtureTree(
  reposDir: string,
  kbId: string,
  fixture: FixtureCase,
): { repo: string; sha: string } {
  const work = mkdtempSync(join(tmpdir(), "kb-tree-fixture-"));
  try {
    for (const [path, content] of Object.entries(fixture.files)) {
      const target = join(work, path);
      mkdirSync(join(work, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    runGit(work, ["init", "--initial-branch=main"], hardenedGitEnv());
    runGit(work, ["add", "."], hardenedGitEnv());
    runGit(work, ["commit", "-m", "fixture"], hardenedGitEnv());
    const sha = readHeadSha(work);
    if (!sha) throw new Error("missing fixture commit");
    const repo = kbBareRepoPath(reposDir, kbId);
    mkdirSync(reposDir, { recursive: true });
    runGit(work, ["clone", "--bare", work, repo], hardenedGitEnv());
    return { repo, sha };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("validate-tree golden corpus", () => {
  // Every real Git fixture is prepared independently before its validator action.
  describe.each([
    "validMinimal",
    "citationsShape",
    "crlfBody",
    "unicodePath",
    "multibyteFrontmatter",
    "yamlCommentsAndBlocks",
    "flowCitations",
    "indentationlessCitations",
    "nestedFlowArrays",
  ] as const)("accepts valid fixture %s", (name) => {
    const test = gitFixtureTests("kb-tree-corpus-", (root) =>
      commitFixtureTree(root, name, cases[name]),
    );
    test("validates the pinned real commit", (fixture) => {
      expect(validateGitCommit({ repoPath: fixture.repo }, fixture.sha).ok).toBe(true);
    });
  });

  describe.each([
    "nonPortablePath0",
    "nonPortablePath1",
    "nonPortablePath2",
    "nonPortablePath3",
    "nonPortablePath4",
    "nonPortablePath5",
    "nonPortablePath6",
    "nonPortablePath7",
    "nonPortablePath8",
    "nonPortablePath9",
    "nonPortablePath10",
    "nonPortablePath11",
    "nonPortablePath12",
    "duplicateDocumentId",
    "manifestPathCollision",
    "forbiddenControlInBody",
    "yamlDuplicateKey",
    "sigmaCaseCollision",
    "sharpSCaseCollision",
    "greekCasefoldCollision",
    "yamlQuotedKeyDuplicate",
    "assetsNestedBlob",
    "numericDocumentId",
    "sealedInComment",
    "sealedInQuotedKey",
    "foldedLeadingBlankDuplicateId",
    "hexadecimalDocumentId",
    "octalDocumentId",
    "cherokeeCaseCollision",
    "cherokeeUppercaseVariantCollision",
    "escapedDel",
    "escapedOutOfRangeCodepoint",
  ] as const)("rejects invalid fixture %s", (name) => {
    const test = gitFixtureTests("kb-tree-corpus-", (root) =>
      commitFixtureTree(root, name, cases[name]),
    );
    test("validates the pinned real commit", (fixture) => {
      const result = validateGitCommit({ repoPath: fixture.repo }, fixture.sha);
      expect(result.ok, name).toBe(false);
      const expectedCodes: Partial<Record<typeof name, string>> = {
        foldedLeadingBlankDuplicateId: "TREE_DOCUMENT_ID",
        hexadecimalDocumentId: "TREE_MARKDOWN",
        octalDocumentId: "TREE_MARKDOWN",
        cherokeeCaseCollision: "TREE_PATH",
        cherokeeUppercaseVariantCollision: "TREE_PATH",
        escapedDel: "TREE_MARKDOWN",
        escapedOutOfRangeCodepoint: "TREE_MARKDOWN",
      };
      if (expectedCodes[name]) expect(result).toMatchObject({ code: expectedCodes[name] });
    });
  });
});

/** Hand-build a raw tree entry `<mode> <name>\0<20-byte sha>` exactly as git stores it. */
function rawTreeEntry(mode: string, name: string, sha: string): Buffer {
  return Buffer.concat([Buffer.from(`${mode} ${name}\0`, "utf8"), Buffer.from(sha, "hex")]);
}

function hashObject(repo: string, type: "blob" | "tree", body: Buffer, literally = false): string {
  const scratch = mkdtempSync(join(tmpdir(), "kb-raw-tree-"));
  try {
    const file = join(scratch, "object");
    writeFileSync(file, body);
    return runGit(
      repo,
      literally
        ? ["hash-object", "-t", type, "-w", "--literally", file]
        : ["hash-object", "-t", type, "-w", file],
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function mktree(repo: string, lines: readonly string[]): string {
  return execFileSync("git", ["mktree"], {
    cwd: repo,
    env: hardenedGitEnv(),
    input: `${lines.join("\n")}\n`,
  })
    .toString("utf8")
    .trim();
}

describe("crafted git tree objects", () => {
  describe.each([KB_TREE_LIMITS.maxTreeDepth - 1, KB_TREE_LIMITS.maxTreeDepth, 8000])(
    "bounds descent before visiting a deeply nested child tree (depth %i)",
    (depth) => {
      let scratch: string | undefined;
      let repo: string;
      let oldSha: string;
      let sha: string;
      let setup: Promise<void> | undefined;
      let action: Promise<void> | undefined;
      beforeAll(() => {
        // Loose-object creation is fixture I/O, not validator work. Each depth
        // gets its own operation deadline and a real, independently built tree.
        setup = Promise.resolve().then(() => {
          scratch = mkdtempSync(join(tmpdir(), "kb-tree-depth-"));
          runGit(scratch, ["init", "--quiet", "--bare", "repo.git"]);
          repo = join(scratch, "repo.git");
          const index = hashObject(repo, "blob", Buffer.from("# depth boundary\n"));
          const assets = hashObject(
            repo,
            "tree",
            rawTreeEntry(
              "100644",
              "manifest.json",
              hashObject(repo, "blob", Buffer.from('{"version":1,"entries":[]}\n')),
            ),
          );
          const base = [
            `040000 tree ${assets}\t.assets`,
            `100644 blob ${hashObject(repo, "blob", Buffer.from("# kb managed\n"))}\t.gitignore`,
            `100644 blob ${index}\tindex.md`,
          ];
          oldSha = runGit(repo, ["commit-tree", mktree(repo, base), "-m", "base"]);
          let chain = hashObject(repo, "tree", rawTreeEntry("100644", "leaf.md", index));
          // Avoid thousands of subprocesses while retaining actual loose Git
          // objects and the hostile 8,000-level descendant.
          for (let level = 1; level < depth; level += 1) {
            const body = rawTreeEntry("40000", "d", chain);
            const object = Buffer.concat([Buffer.from(`tree ${body.byteLength}\0`), body]);
            chain = createHash("sha1").update(object).digest("hex");
            const dir = join(repo, "objects", chain.slice(0, 2));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, chain.slice(2)), deflateSync(object));
          }
          const tree = mktree(repo, [...base, `040000 tree ${chain}\td`]);
          sha = runGit(repo, ["commit-tree", tree, "-p", oldSha, "-m", `depth ${depth}`]);
        });
        return setup;
      }, 180_000);
      afterAll(async () => {
        await setup?.catch(() => {});
        await action?.catch(() => {});
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }, 180_000);
      it("validates the single-commit and newly reachable range boundaries", () => {
        action = (async () => {
          const result = validateGitCommit({ repoPath: repo }, sha);
          const range = await validateNewlyReachableCommits(
            { repoPath: repo },
            { oldSha, newSha: sha },
          );
          expect(range).toEqual(result);
          if (depth === KB_TREE_LIMITS.maxTreeDepth - 1) expect(result).toMatchObject({ ok: true });
          else
            expect(result).toMatchObject({
              ok: false,
              code: "TREE_PATH",
              message: "tree nesting exceeds depth budget",
            });
        })();
        return action;
      });
    },
  );

  describe("Unicode document identity", () => {
    const test = gitFixtureTests("kb-tree-unicode-id-", async (reposDir) => {
      const kbId = "yamlspace";
      const base = await writeInitialMainCommit(
        { reposDir, kbId, executor: testExecutor },
        { message: "init", description: "Unicode document identity" },
      );
      const repo = kbBareRepoPath(reposDir, kbId);
      const validation = validateProposedCommitTree(repo, base);
      const baseEntries = runGit(repo, ["ls-tree", validation.treeSha]).split("\n");
      const plain = hashObject(repo, "blob", Buffer.from("---\nid: \u00a0shared\u00a0\n---\n"));
      const quoted = hashObject(repo, "blob", Buffer.from('---\nid: "\u00a0shared\u00a0"\n---\n'));
      const treeSha = mktree(repo, [
        ...baseEntries,
        `100644 blob ${plain}\tplain.md`,
        `100644 blob ${quoted}\tquoted.md`,
      ]);
      const sha = runGit(repo, ["commit-tree", treeSha, "-p", base, "-m", "duplicate IDs"]);
      return { reposDir, kbId, repo, base, validation, treeSha, sha };
    });
    test("rejects equivalent plain and quoted Unicode-whitespace ids before publication", async ({
      reposDir,
      kbId,
      repo,
      base,
      validation,
      treeSha,
      sha,
    }) => {
      expect(validateGitCommit({ repoPath: repo }, sha)).toMatchObject({
        ok: false,
        code: "TREE_DOCUMENT_ID",
      });
      const binding = createPublicationTreeBinding({ ...validation, treeSha }, sha);
      expect(() => assertPublicationTreeBinding({ repoPath: repo }, binding, sha)).toThrow(
        TreePublicationBindingError,
      );
      let publicationCalls = 0;
      await expect(
        fsyncRefUpdateWithBinding(
          {
            reposDir,
            kbId,
            executor: {
              exec: async () => {
                publicationCalls += 1;
              },
            },
          },
          { refName: "refs/heads/main", oldSha: base, newSha: sha, binding },
        ),
      ).rejects.toThrow(TreePublicationBindingError);
      expect(publicationCalls).toBe(0);
      expect(readHeadSha(repo)).toBe(base);
    });
  });

  describe.each(["root", "ascii", "directory", "unicode"] as const)(
    "enforces Git byte ordering for %s before publication",
    (scenario) => {
      const test = gitFixtureTests("kb-tree-order-", (reposDir) => {
        const kbId = "treeorder";
        const { repo, sha: base } = commitFixtureTree(reposDir, kbId, cases.validMinimal);
        const validation = validateProposedCommitTree(repo, base);
        const baseEntries = runGit(repo, ["ls-tree", validation.treeSha]).split("\n");
        const baseTreeBytes = execFileSync("git", ["cat-file", "tree", validation.treeSha], {
          cwd: repo,
          env: hardenedGitEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const body = "# ordered document\n";
        const blob = hashObject(repo, "blob", Buffer.from(body));
        const directory = mktree(repo, [`100644 blob ${blob}\tchild.md`]);
        const entry = (name: string): Buffer => rawTreeEntry("100644", name, blob);
        const malformedTrees =
          scenario === "root"
            ? [
                hashObject(
                  repo,
                  "tree",
                  Buffer.concat([entry("z.md"), baseTreeBytes, entry("a.md")]),
                  true,
                ),
              ]
            : [];
        const orderedCases: Array<{
          treeSha: string;
          sha: string;
          readablePaths: readonly string[];
        }> = [];
        for (const [label, first, second, readablePaths] of [
          ["ascii", entry("a.md"), entry("z.md"), ["a.md", "z.md"]],
          // A directory compares as "a/", so "a.md" must precede it.
          [
            "directory",
            entry("a.md"),
            rawTreeEntry("040000", "a", directory),
            ["a.md", "a/child.md"],
          ],
          // UTF-8 byte order differs from JavaScript UTF-16 string order here.
          ["unicode", entry("\ue000.md"), entry("\u{10000}.md"), ["\ue000.md", "\u{10000}.md"]],
        ] as const) {
          if (scenario !== label) continue;
          const ordered = hashObject(repo, "tree", Buffer.concat([first, second]), true);
          const reversed = hashObject(repo, "tree", Buffer.concat([second, first]), true);
          const treeSha = mktree(repo, [...baseEntries, `040000 tree ${ordered}\tdocs`]);
          const sha = runGit(repo, ["commit-tree", treeSha, "-p", base, "-m", "ordered"]);
          orderedCases.push({ treeSha, sha, readablePaths });
          malformedTrees.push(mktree(repo, [...baseEntries, `040000 tree ${reversed}\tdocs`]));
        }
        const malformedCases = malformedTrees.map((treeSha) => ({
          treeSha,
          sha: runGit(repo, ["commit-tree", treeSha, "-p", base, "-m", "unsorted"]),
        }));
        return { reposDir, kbId, repo, base, validation, body, orderedCases, malformedCases };
      });
      test("validates ordered controls and refuses unordered publication", async ({
        reposDir,
        kbId,
        repo,
        base,
        validation,
        body,
        orderedCases,
        malformedCases,
      }) => {
        for (const { treeSha, sha, readablePaths } of orderedCases) {
          expect(validateGitCommit({ repoPath: repo }, sha)).toMatchObject({ ok: true });
          const binding = createPublicationTreeBinding({ ...validation, treeSha }, sha);
          expect(() =>
            assertPublicationTreeBinding({ repoPath: repo }, binding, sha),
          ).not.toThrow();
          for (const path of readablePaths) {
            expect(runGit(repo, ["show", `${sha}:docs/${path}`])).toBe(body.trim());
          }
        }
        let publicationCalls = 0;
        const executor: GitMutatingExecutor = {
          exec: async () => {
            publicationCalls += 1;
          },
        };
        for (const { treeSha, sha } of malformedCases) {
          expect(() => walkGitTreeEntries(repo, treeSha, { entries: 0, maxEntries: 8192 })).toThrow(
            TreeStructureError,
          );
          expect(validateGitCommit({ repoPath: repo }, sha)).toMatchObject({
            ok: false,
            code: "TREE_PATH",
            message: expect.stringContaining("out of order"),
          });
          const binding = createPublicationTreeBinding({ ...validation, treeSha }, sha);
          expect(() => assertPublicationTreeBinding({ repoPath: repo }, binding, sha)).toThrow(
            TreePublicationBindingError,
          );
          await expect(
            fsyncRefUpdateWithBinding(
              { reposDir, kbId, executor },
              { refName: "refs/heads/main", oldSha: base, newSha: sha, binding },
            ),
          ).rejects.toThrow(TreePublicationBindingError);
        }
        expect(publicationCalls).toBe(0);
        expect(readHeadSha(repo)).toBe(base);
      });
    },
  );

  // Every alias has a private prepared commit and its own unchanged action deadline.
  describe.each(
    [".git", ".GiT", "GIT~1", ".git. ", ".git:stream", ".g\u200cit"].flatMap((name) =>
      [false, true].flatMap((empty) => [false, true].map((nested) => ({ name, empty, nested }))),
    ),
  )(
    "rejects Git metadata alias $name before publication (empty=$empty, nested=$nested)",
    ({ name, empty, nested }) => {
      const test = gitFixtureTests("kb-tree-dotgit-", (reposDir) => {
        const kbId = "dotgit";
        const { repo, sha: base } = commitFixtureTree(reposDir, kbId, cases.validMinimal);
        const validation = validateProposedCommitTree(repo, base);
        const baseEntries = runGit(repo, ["ls-tree", validation.treeSha]).split("\n");
        const hidden = hashObject(repo, "blob", Buffer.from("# hidden\n"));
        const child = empty
          ? hashObject(repo, "tree", Buffer.alloc(0))
          : mktree(repo, [`100644 blob ${hidden}\thidden.md`]);
        const entry = `040000 tree ${child}\t${name}`;
        const treeSha = mktree(repo, [
          ...baseEntries,
          nested ? `040000 tree ${mktree(repo, [entry])}\tdocs` : entry,
        ]);
        const sha = runGit(repo, ["commit-tree", treeSha, "-p", base, "-m", "metadata path"]);
        return { reposDir, kbId, repo, base, validation, treeSha, sha };
      });
      test("rejects validation and rechecks fabricated publication bindings", async ({
        reposDir,
        kbId,
        repo,
        base,
        validation,
        treeSha,
        sha,
      }) => {
        let publicationCalls = 0;
        const executor: GitMutatingExecutor = {
          exec: async () => {
            publicationCalls += 1;
          },
        };
        expect(validateGitCommit({ repoPath: repo }, sha)).toMatchObject({
          ok: false,
          code: "TREE_PATH",
          path: nested ? `docs/${name}` : name,
        });
        // A stale or fabricated success binding cannot authorize a ref update.
        const binding = createPublicationTreeBinding({ ...validation, treeSha }, sha);
        await expect(
          fsyncRefUpdateWithBinding(
            { reposDir, kbId, executor },
            { refName: "refs/heads/main", oldSha: base, newSha: sha, binding },
          ),
        ).rejects.toThrow(TreePublicationBindingError);
        expect(publicationCalls).toBe(0);
        expect(readHeadSha(repo)).toBe(base);
      });
    },
  );

  describe("rejects a tree with duplicate entry names that git accepts on the wire", () => {
    const test = gitFixtureTests("kb-tree-dup-", async (scratch) => {
      runGit(scratch, ["init", "--quiet", "--bare", "repo.git"], hardenedGitEnv());
      const repo = join(scratch, "repo.git");
      const blob = (content: string): string =>
        hashObject(repo, "blob", Buffer.from(content, "utf8"));
      const gitignore = blob("# kb managed\n");
      const manifest = blob('{"version":1,"entries":[]}\n');
      const index = blob("# crafted root\n");
      const firstIndex = blob("# first index\n");
      const secondIndex = blob("# second index\n");
      const assets = hashObject(repo, "tree", rawTreeEntry("100644", "manifest.json", manifest));
      const baseTree = mktree(repo, [
        `040000 tree ${assets}\t.assets`,
        `100644 blob ${gitignore}\t.gitignore`,
        `100644 blob ${index}\tindex.md`,
      ]);
      const base = runGit(repo, ["commit-tree", baseTree, "-m", "base"], hardenedGitEnv());
      // Two distinct blobs stored under the same name in one tree object: git
      // writes and fetches this without fsck, so only the validator stops it.
      const raw = Buffer.concat([
        rawTreeEntry("040000", ".assets", assets),
        rawTreeEntry("100644", ".gitignore", gitignore),
        rawTreeEntry("100644", "index.md", firstIndex),
        rawTreeEntry("100644", "index.md", secondIndex),
      ]);
      const dupTree = hashObject(repo, "tree", raw, true);
      const dup = runGit(
        repo,
        ["commit-tree", dupTree, "-p", base, "-m", "duplicate names"],
        hardenedGitEnv(),
      );

      return { repo, base, dup };
    });
    test("rejects a tree with duplicate entry names that git accepts on the wire", async ({
      repo,
      base,
      dup,
    }) => {
      const result = validateGitCommit({ repoPath: repo }, dup);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("TREE_PATH");
        expect(result.message).toContain("duplicate entry name");
      }
      const range = await validateNewlyReachableCommits(
        { repoPath: repo },
        { oldSha: base, newSha: dup },
      );
      expect(range.ok).toBe(false);
    });
  });

  describe("rejects empty directories that bypass blob-path validation", () => {
    const test = gitFixtureTests("kb-tree-empty-dir-", (scratch) => {
      runGit(scratch, ["init", "--quiet", "--bare", "repo.git"], hardenedGitEnv());
      const repo = join(scratch, "repo.git");
      const blob = (content: string): string =>
        hashObject(repo, "blob", Buffer.from(content, "utf8"));
      const gitignore = blob("# kb managed\n");
      const manifest = blob('{"version":1,"entries":[]}\n');
      const index = blob("# crafted root\n");
      const assets = hashObject(repo, "tree", rawTreeEntry("100644", "manifest.json", manifest));
      const empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const base = [
        `040000 tree ${assets}\t.assets`,
        `100644 blob ${gitignore}\t.gitignore`,
        `100644 blob ${index}\tindex.md`,
      ];
      const assetsWithForbidden = mktree(repo, [
        `040000 tree ${empty}\tforbidden`,
        `100644 blob ${manifest}\tmanifest.json`,
      ]);
      const rejected: Array<{ lines: string[]; expectedPath?: string }> = [
        { lines: [...base, `040000 tree ${empty}\tCON`], expectedPath: "CON" },
        {
          lines: [...base, `040000 tree ${empty}\tDocs`, `040000 tree ${empty}\tdocs`],
          expectedPath: "docs",
        },
        {
          lines: [
            `040000 tree ${assetsWithForbidden}\t.assets`,
            `100644 blob ${gitignore}\t.gitignore`,
            `100644 blob ${index}\tindex.md`,
          ],
          expectedPath: ".assets/forbidden",
        },
      ];
      const rejectedCommits = rejected.map(({ lines, expectedPath }) => ({
        commitSha: runGit(
          repo,
          ["commit-tree", mktree(repo, lines), "-m", "empty dirs"],
          hardenedGitEnv(),
        ),
        expectedPath,
      }));
      // A 41-segment chain of empty trees must also fail the depth budget.
      let chain = empty;
      for (let depth = 0; depth < 41; depth += 1) {
        chain = mktree(repo, [`040000 tree ${chain}\td${depth}`]);
      }
      const deepSha = runGit(
        repo,
        ["commit-tree", mktree(repo, [...base, `040000 tree ${chain}\tchain`]), "-m", "deep chain"],
        hardenedGitEnv(),
      );
      return { repo, rejectedCommits, deepSha };
    });
    test("checks empty-directory paths and the depth boundary", ({
      repo,
      rejectedCommits,
      deepSha,
    }) => {
      for (const { commitSha, expectedPath } of rejectedCommits) {
        const result = validateGitCommit({ repoPath: repo }, commitSha);
        expect(result.ok).toBe(false);
        if (!result.ok && expectedPath) expect(result.path).toBe(expectedPath);
      }
      const deep = validateGitCommit({ repoPath: repo }, deepSha);
      expect(deep.ok).toBe(false);
      if (!deep.ok) expect(deep.code).toBe("TREE_PATH");
    });
  });

  describe("rejects raw entry names containing slashes before path construction", () => {
    const test = gitFixtureTests("kb-tree-slash-", (scratch) => {
      runGit(scratch, ["init", "--quiet", "--bare", "repo.git"], hardenedGitEnv());
      const repo = join(scratch, "repo.git");
      const blob = (content: string): string =>
        hashObject(repo, "blob", Buffer.from(content, "utf8"));
      const gitignore = blob("# kb managed\n");
      const manifest = blob('{"version":1,"entries":[]}\n');
      const index = blob("# crafted root\n");
      const doc = blob("# real doc\n");
      const assets = hashObject(repo, "tree", rawTreeEntry("100644", "manifest.json", manifest));
      const docs = mktree(repo, [`100644 blob ${doc}\tx.md`]);
      const nested = mktree(repo, [`040000 tree ${docs}\tb`]);
      const empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      // Each crafted tree embeds a raw entry name containing "/": git stores
      // and fetches these without fsck, and concatenating them with the parent
      // prefix would alias a real subtree path.
      const crafted: Array<{ raw: Buffer; expectedPath: string }> = [
        {
          // Root blob literally named `.assets/manifest.json` with no `.assets` dir.
          raw: Buffer.concat([
            rawTreeEntry("100644", ".assets/manifest.json", manifest),
            rawTreeEntry("100644", ".gitignore", gitignore),
            rawTreeEntry("100644", "index.md", index),
          ]),
          expectedPath: ".assets/manifest.json",
        },
        {
          // Blob `file.md` plus a root tree entry literally named `file.md/child.md`.
          raw: Buffer.concat([
            rawTreeEntry("040000", ".assets", assets),
            rawTreeEntry("100644", ".gitignore", gitignore),
            rawTreeEntry("100644", "file.md", index),
            rawTreeEntry("100644", "file.md/child.md", doc),
          ]),
          expectedPath: "file.md/child.md",
        },
        {
          // Real `docs/{x.md}` subtree plus crafted root tree entry `docs/x.md`
          // (tree-tree duplicate of one logical path).
          raw: Buffer.concat([
            rawTreeEntry("040000", ".assets", assets),
            rawTreeEntry("100644", ".gitignore", gitignore),
            rawTreeEntry("040000", "docs", docs),
            rawTreeEntry("040000", "docs/x.md", empty),
            rawTreeEntry("100644", "index.md", index),
          ]),
          expectedPath: "docs/x.md",
        },
        {
          // Crafted entry listed first: walk order must not matter.
          raw: Buffer.concat([
            rawTreeEntry("040000", "docs/x.md", empty),
            rawTreeEntry("040000", ".assets", assets),
            rawTreeEntry("100644", ".gitignore", gitignore),
            rawTreeEntry("100644", "index.md", index),
            rawTreeEntry("040000", "docs", docs),
          ]),
          expectedPath: "docs/x.md",
        },
        {
          // Crafted `a/b` against real nested `a/{b/{x.md}}` trees.
          raw: Buffer.concat([
            rawTreeEntry("040000", ".assets", assets),
            rawTreeEntry("100644", ".gitignore", gitignore),
            rawTreeEntry("040000", "a", nested),
            rawTreeEntry("040000", "a/b", docs),
            rawTreeEntry("100644", "index.md", index),
          ]),
          expectedPath: "a/b",
        },
      ];
      const craftedCommits = crafted.map(({ raw, expectedPath }) => ({
        commitSha: runGit(
          repo,
          ["commit-tree", hashObject(repo, "tree", raw, true), "-m", "slash names"],
          hardenedGitEnv(),
        ),
        expectedPath,
      }));
      return { repo, craftedCommits };
    });
    test("checks every crafted raw name", ({ repo, craftedCommits }) => {
      for (const { commitSha, expectedPath } of craftedCommits) {
        const result = validateGitCommit({ repoPath: repo }, commitSha);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("TREE_PATH");
          expect(result.message).toContain("slash");
          expect(result.message).toContain(expectedPath);
        }
      }
    });
  });

  describe("accepts a directory-heavy tree below the entry budget", () => {
    const test = gitFixtureTests("kb-tree-dirs-", async (reposDir) => {
      const work = join(reposDir, "work");
      mkdirSync(work);

      // 2,800 directories each holding one two-byte Markdown file plus the
      // three required files: 2,803 files and 5,606 actual entries (including
      // root, docs and .assets) — under
      // both the 4,096-file and 8,192-entry budgets. Counting every directory
      // twice (as a child and again on visit) would exceed 8,192 and wrongly
      // reject this tree.
      runGit(work, ["init", "--quiet", "--initial-branch=main"], hardenedGitEnv());
      seedRequiredFiles(work, "# dirs\n");
      for (let i = 0; i < 2800; i += 1) {
        const dir = join(work, "docs", `d${i}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "f.md"), "x\n", "utf8");
      }
      runGit(work, ["add", "."], hardenedGitEnv());
      runGit(work, ["commit", "-m", "dir heavy"], hardenedGitEnv());
      const sha = readHeadSha(work)!;
      const repo = kbBareRepoPath(reposDir, "dirheavy");
      mkdirSync(reposDir, { recursive: true });
      runGit(work, ["clone", "--quiet", "--bare", work, repo], hardenedGitEnv());

      return { sha, repo };
    });
    test(
      "accepts a directory-heavy tree below the entry budget",
      async ({ sha, repo }) => {
        const callsBefore = gitCalls.count;
        const result = validateGitCommit({ repoPath: repo }, sha);
        expect(result.ok).toBe(true);
        // These 2,800 identical subtrees/blobs must not each spawn metadata readers.
        // Count executions, not wall time, so contention cannot hide a regression.
        expect(gitCalls.count - callsBefore).toBeLessThan(32);
        expect(() =>
          walkGitTreeEntries(repo, result.ok ? result.treeSha : "", {
            entries: 0,
            maxEntries: 5605,
          }),
        ).toThrow(TreeReadBudgetError);
      },
      { timeout: 300_000 },
    );
  });
});

describe("validate-tree budgets", () => {
  describe("repeated-blob reads and aggregate byte budget", () => {
    // Store the shared 2 MiB blob once, without a 66 MiB worktree or clone.
    // Git fixture preparation owns its own lifecycle; each validator action
    // retains the unchanged 30s deadline and reads every real blob occurrence.
    const test = gitFixtureTests("kb-tree-shared-budget-", (root) => {
      runGit(root, ["init", "--quiet", "--bare", "repo.git"], hardenedGitEnv());
      const repo = join(root, "repo.git");
      const required = Object.entries(cases.validMinimal.files).map(([path, content]) => ({
        path,
        sha: hashObject(repo, "blob", Buffer.from(content)),
        bytes: Buffer.byteLength(content),
      }));
      const manifest = required.find((file) => file.path === ".assets/manifest.json")!;
      const assets = mktree(repo, [`100644 blob ${manifest.sha}\tmanifest.json`]);
      const body = Buffer.from("😀".repeat(KB_TREE_LIMITS.maxMarkdownBytes / 4));
      expect(body.byteLength).toBe(KB_TREE_LIMITS.maxMarkdownBytes);
      const shared = hashObject(repo, "blob", body);
      const smallBlob = hashObject(repo, "blob", Buffer.from("# repeated\n"));
      const requiredBytes = required.reduce((sum, file) => sum + file.bytes, 0);
      const commit = (count: number, blob = shared) => {
        const tree = mktree(repo, [
          `040000 tree ${assets}\t.assets`,
          ...required
            .filter((file) => file.path !== ".assets/manifest.json")
            .map((file) => `100644 blob ${file.sha}\t${file.path}`),
          ...Array.from({ length: count }, (_, i) => `100644 blob ${blob}\td${i}.md`),
        ]);
        return runGit(repo, ["commit-tree", tree, "-m", "shared blob budget"], hardenedGitEnv());
      };
      expect(requiredBytes + 31 * body.byteLength).toBeLessThan(KB_TREE_LIMITS.maxTreeBytes);
      expect(requiredBytes + 33 * body.byteLength).toBeGreaterThan(KB_TREE_LIMITS.maxTreeBytes);
      const small = commit(32, smallBlob);
      const below = commit(31);
      const over = commit(33);
      const bin = join(root, "bin");
      const log = join(root, "reads");
      mkdirSync(bin);
      writeCountingGitWrapper(bin, log, "all");
      return { repo, below, over, small, smallBlob, bin, log };
    });
    for (const invocation of [1, 2]) {
      test(`reads trees and blobs in a fixed number of git processes (invocation ${invocation})`, ({
        repo,
        small,
        bin,
        log,
      }) => {
        try {
          vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
          writeFileSync(log, "");
          expect(validateGitCommit({ repoPath: repo }, small).ok).toBe(true);
          const reads = readFileSync(log, "utf8").trim().split("\n");
          // Blob contents and trees come from batched readers: the process
          // count is fixed, independent of how many paths or directories exist.
          expect(reads.filter((line) => line.startsWith("cat-file blob "))).toHaveLength(0);
          // One listing for the tree objects, one (with sizes) for the blobs.
          expect(reads.filter((line) => line.startsWith("ls-tree "))).toHaveLength(2);
          expect(reads.filter((line) => line === "cat-file --batch").length).toBeLessThanOrEqual(3);
          expect(reads.length).toBeLessThanOrEqual(6);
        } finally {
          vi.unstubAllEnvs();
        }
      });
    }
    test("accepts repeated blob occurrences below the aggregate byte budget", ({ repo, below }) => {
      expect(validateGitCommit({ repoPath: repo }, below).ok).toBe(true);
    });
    test("charges the aggregate byte budget for every occurrence of a repeated blob", ({
      repo,
      over,
    }) => {
      expect(validateGitCommit({ repoPath: repo }, over)).toMatchObject({
        ok: false,
        code: "TREE_BUDGET",
        message: "tree exceeds byte budget",
      });
    });
  });

  // File counting is shared per-path code; exercise it with one repeated blob
  // through the staged source (the repository source is covered by the
  // distinct-subtree near-limit fixtures).
  it("charges one repeated blob per path for the file budget", () => {
    const files = Object.entries((cases.validMinimal as FixtureCase).files).map(
      ([path, content]) => ({ segments: path.split("/"), content: Buffer.from(content) }),
    );
    const staged = stageCommitWithTreeFiles({
      parentSha: "a".repeat(40),
      message: "repeated blobs",
      files: [
        ...files,
        ...Array.from({ length: KB_TREE_LIMITS.maxFiles }, (_, i) => ({
          segments: [`d${i}.md`],
          content: Buffer.from("x\n"),
        })),
      ],
    });
    expect(validateStagedCommitTree(staged)).toMatchObject({
      ok: false,
      code: "TREE_BUDGET",
      message: "tree exceeds file budget",
    });
  });

  describe("checks document identity separately at paths sharing cached tree and blob objects", () => {
    const test = gitFixtureTests("kb-tree-cached-id-", async (reposDir) => {
      const fixture = commitFixtureTree(reposDir, "identity", {
        files: {
          ...(cases.validMinimal as FixtureCase).files,
          "a/f.md": "---\nid: shared\n---\nx\n",
          "b/f.md": "---\nid: shared\n---\nx\n",
        },
      });

      return { fixture };
    });
    test("checks document identity separately at paths sharing cached tree and blob objects", async ({
      fixture,
    }) => {
      expect(validateGitCommit({ repoPath: fixture.repo }, fixture.sha)).toMatchObject({
        ok: false,
        code: "TREE_DOCUMENT_ID",
        path: "b/f.md",
      });
    });
  });

  describe("stops before reading a blob larger than the markdown budget", () => {
    const test = gitFixtureTests("kb-tree-budget-", async (reposDir) => {
      const work = join(reposDir, "work");
      mkdirSync(work);
      const huge = `${"# x\n".repeat(Math.ceil((KB_TREE_LIMITS.maxMarkdownBytes + 16) / 4))}`;
      writeFileSync(join(work, "index.md"), huge, "utf8");
      writeFileSync(join(work, ".gitignore"), "# kb managed\n", "utf8");
      mkdirSync(join(work, ".assets"), { recursive: true });
      writeFileSync(join(work, ".assets/manifest.json"), '{"version":1,"entries":[]}\n', "utf8");
      runGit(work, ["init", "--initial-branch=main"], hardenedGitEnv());
      runGit(work, ["add", "."], hardenedGitEnv());
      runGit(work, ["commit", "-m", "huge"], hardenedGitEnv());
      const sha = readHeadSha(work)!;
      const repo = kbBareRepoPath(reposDir, "budget");
      runGit(work, ["clone", "--bare", work, repo], hardenedGitEnv());

      return { work, sha, repo };
    });
    test("stops before reading a blob larger than the markdown budget", async ({
      work,
      sha,
      repo,
    }) => {
      const result = validateGitCommit({ repoPath: repo }, sha);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("TREE_BUDGET");
      rmSync(work, { recursive: true, force: true });
    });
  });
});

describe("publication binding", () => {
  const test = gitFixtureTests("kb-tree-initial-", async (reposDir) => {
    const kbId = "bind";
    const head = await writeInitialMainCommit(
      { reposDir, kbId, executor: testExecutor },
      { message: "init", description: "binding test" },
    );
    const other = await createTreeReuseCommit(
      { reposDir, kbId },
      { parentSha: head, message: "other" },
    );
    return { reposDir, kbId, repo: kbBareRepoPath(reposDir, kbId), head, other };
  });
  test("refuses to publish when validation was bound to a different tree", async ({
    reposDir,
    kbId,
    repo,
    head,
    other,
  }) => {
    const validated = validateProposedCommitTree(repo, head);
    const binding = bindValidatedTreeForPublication(validated, head);
    expect(() => assertPublicationTreeBinding({ repoPath: repo }, binding, other)).toThrow(
      TreePublicationBindingError,
    );
    await expect(
      fsyncRefUpdateWithBinding(
        { reposDir, kbId, executor: testExecutor },
        { refName: "refs/heads/main", newSha: other, oldSha: head, binding },
      ),
    ).rejects.toThrow(TreePublicationBindingError);
    expect(readHeadSha(repo)).toBe(head);
    const honestBinding = createPublicationTreeBinding(validated, other);
    expect(() =>
      assertPublicationTreeBinding({ repoPath: repo }, honestBinding, other),
    ).not.toThrow();
    await fsyncRefUpdateWithBinding(
      { reposDir, kbId, executor: testExecutor },
      { refName: "refs/heads/main", newSha: other, oldSha: head, binding: honestBinding },
    );
    expect(readHeadSha(repo)).toBe(other);
  });
});

describe("push sealed validation uses validated parent trees", () => {
  const namespace = "11111111-1111-4111-8111-111111111111";
  const record = "22222222-2222-4222-8222-222222222222";
  const reference = `{{sealed:v1:knowledge_base:${namespace}:${record}}}`;
  const test = gitFixtureTests("kb-push-sealed-parents-", (scratch) => {
    runGit(scratch, ["init", "--quiet", "--bare", "repo.git"]);
    const repo = join(scratch, "repo.git");
    const blob = (text: string) => hashObject(repo, "blob", Buffer.from(text));
    const assets = mktree(repo, [
      `100644 blob ${blob('{"version":1,"entries":[]}\n')}\tmanifest.json`,
    ]);
    const tree = (index: string, secret: string | null) =>
      mktree(repo, [
        `040000 tree ${assets}\t.assets`,
        `100644 blob ${blob("# kb managed\n")}\t.gitignore`,
        `100644 blob ${blob(index)}\tindex.md`,
        ...(secret === null ? [] : [`100644 blob ${blob(secret)}\tdb.md`]),
      ]);
    const commit = (treeSha: string, parents: string[] = [], time = 1700000000) =>
      runGit(
        repo,
        ["commit-tree", treeSha, ...parents.flatMap((parent) => ["-p", parent]), "-m", "fixture"],
        {
          ...hardenedGitEnv(),
          GIT_AUTHOR_DATE: `${time} +0000`,
          GIT_COMMITTER_DATE: `${time} +0000`,
        },
      );
    const base = commit(tree("base", reference));
    const one = commit(tree("unrelated one", reference), [base]);
    const two = commit(tree("unrelated two", reference), [one]);
    const changed = commit(tree("base", `${reference} changed`), [two]);
    const removed = commit(tree("removed", null), [base]);
    const restored = commit(tree("restored", reference), [removed]);
    const reversedMerge = commit(tree("restored through old first parent", reference), [
      base,
      removed,
    ]);
    const spineChild = commit(tree("branch after removal", null), [removed]);
    const reversedMergeChild = commit(tree("restored through side parent", reference), [
      base,
      spineChild,
    ]);
    const laterRemoved = commit(tree("old tip after removal", null), [removed]);
    const sideRestoreTip = commit(tree("clean tip hides restored side document", null), [
      laterRemoved,
      reversedMerge,
    ]);
    const retainedSide = commit(tree("side branch retains document", reference), [base]);
    const ambiguousSideMerge = commit(tree("restore from ambiguous side parents", reference), [
      retainedSide,
      removed,
    ]);
    const reorderedAmbiguousSideMerge = commit(
      tree("restore from reordered side parents", reference),
      [removed, retainedSide],
    );
    const ambiguousSideTip = commit(tree("clean tip after ambiguous side merge", null), [
      laterRemoved,
      ambiguousSideMerge,
    ]);
    const reorderedAmbiguousSideTip = commit(tree("clean tip after reordered side merge", null), [
      laterRemoved,
      reorderedAmbiguousSideMerge,
    ]);
    const unchangedSideMerge = commit(tree("side parents agree on retained document", reference), [
      base,
      retainedSide,
    ]);
    const unchangedSideTip = commit(tree("clean tip with unchanged side history", null), [
      laterRemoved,
      unchangedSideMerge,
    ]);
    const badRoot = commit(tree("unvalidated root", reference));
    const badMerge = commit(tree("tip masks bad side history", reference), [base, badRoot]);
    const cleanRoot = commit(tree("clean root", null), [], 1700000300);
    const reorderedRetained = commit(tree("retained with branch as second parent", reference), [
      cleanRoot,
      base,
    ]);
    const cleanChild = commit(tree("clean side child", null), [cleanRoot], 1700000100);
    const merge = commit(
      tree("merge unrelated side history", reference),
      [two, cleanChild],
      1700000200,
    );
    const badIntermediate = commit(tree("transient new reference", `${reference} new`), [one]);
    const masksBadIntermediate = commit(tree("tip removes transient document", null), [
      badIntermediate,
    ]);
    return {
      repo,
      base,
      one,
      two,
      changed,
      removed,
      restored,
      reversedMerge,
      reversedMergeChild,
      laterRemoved,
      sideRestoreTip,
      ambiguousSideTip,
      reorderedAmbiguousSideTip,
      unchangedSideTip,
      reorderedRetained,
      badMerge,
      merge,
      masksBadIntermediate,
    };
  });
  test("new branches cannot reintroduce revoked references through old merge parents", async (f) => {
    await expect(
      validatePush(
        {
          repoPath: f.repo,
          validateSealedReferences: sealedTreeValidator(namespace, new Set<string>()),
        },
        { oldSha: ZERO_SHA, newSha: f.reversedMerge, refName: "refs/heads/topic" },
        f.removed,
      ),
    ).rejects.toMatchObject({ refusal: "INVALID_CONTENT" });
  });
  test("new branches cannot hide a revoked restoration in side-history", async (f) => {
    await expect(
      validatePush(
        {
          repoPath: f.repo,
          validateSealedReferences: sealedTreeValidator(namespace, new Set<string>()),
        },
        { oldSha: ZERO_SHA, newSha: f.sideRestoreTip, refName: "refs/heads/topic" },
        f.laterRemoved,
      ),
    ).rejects.toMatchObject({ refusal: "INVALID_CONTENT" });
  });
  for (const [name, old, next, allowed] of [
    ["existing branch edit", "base", "one", true],
    ["multiple unrelated commits", "base", "two", true],
    ["new branch with commits", "create", "two", true],
    ["new branch at main", "create", "base", true],
    ["merge with clock-skewed side history", "base", "merge", true],
    ["retained revoked document with branch as second parent", "base", "reorderedRetained", true],
    ["changed revoked document", "base", "changed", false],
    ["changed revoked document on new branch", "create", "changed", false],
    ["reintroduced historical blob", "removed", "restored", false],
    ["a merge cannot undo a deletion within the same push", "base", "reversedMerge", false],
    ["revoked restoration hidden in side-history", "laterRemoved", "sideRestoreTip", false],
    ["revoked restoration in ambiguous side-history", "laterRemoved", "ambiguousSideTip", false],
    [
      "revoked restoration in reordered side-history",
      "laterRemoved",
      "reorderedAmbiguousSideTip",
      false,
    ],
    ["unchanged documents retained through side-history", "laterRemoved", "unchangedSideTip", true],
    ["revoked references through old merge parents", "removed", "reversedMerge", false],
    [
      "revoked references through old merge parents after branch advances",
      "removed",
      "reversedMergeChild",
      false,
    ],
    ["unvalidated side-history reference", "base", "badMerge", false],
    ["reference hidden in intermediate commit", "base", "masksBadIntermediate", false],
  ] as const) {
    test(name, async (f) => {
      const result = validatePush(
        {
          repoPath: f.repo,
          validateSealedReferences: sealedTreeValidator(namespace, new Set<string>()),
        },
        {
          oldSha: old === "create" ? ZERO_SHA : f[old],
          newSha: f[next],
          refName: "refs/heads/topic",
        },
        f.base,
      );
      if (allowed) expect((await result).ok).toBe(true);
      else await expect(result).rejects.toMatchObject({ refusal: "INVALID_CONTENT" });
    });
  }
});

describe("reachable commit traversal", () => {
  describe("excludes existing history from the incoming-object allowance", () => {
    const test = gitFixtureTests("kb-tree-range-existing-", (scratch) => {
      runGit(scratch, ["init", "--quiet", "--bare", "repo.git"]);
      const repo = join(scratch, "repo.git");
      const blob = (text: string): string => hashObject(repo, "blob", Buffer.from(text));
      const assets = hashObject(
        repo,
        "tree",
        rawTreeEntry("100644", "manifest.json", blob('{"version":1,"entries":[]}\n')),
      );
      const required = [
        `040000 tree ${assets}\t.assets`,
        `100644 blob ${blob("# kb managed\n")}\t.gitignore`,
        `100644 blob ${blob("# incremental range\n")}\tindex.md`,
      ];
      const batch = (label: string, count: number): string[] =>
        Array.from({ length: count }, (_, i) => {
          const body = Buffer.alloc(KB_TREE_LIMITS.maxMarkdownBytes, 0x61);
          body.write(`# ${label}/${i}\n`);
          return `100644 blob ${hashObject(repo, "blob", body)}\t${label}${i}.md`;
        });
      const existing = batch("existing", 12);
      const baseTree = mktree(repo, [...required, ...existing]);
      const base = runGit(repo, ["commit-tree", baseTree, "-m", "base"]);
      let tip = base;
      const tips: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const tree = mktree(repo, [...required, ...existing, ...batch(`new${i}`, 19)]);
        tip = runGit(repo, ["commit-tree", tree, "-p", tip, "-m", `batch ${i}`]);
        tips.push(tip);
      }
      // Reused content may be absent from the old tip, yet reachable in its
      // ancestors. Its new name and presence on disk do not define membership.
      const removed = runGit(repo, [
        "commit-tree",
        mktree(repo, required),
        "-p",
        base,
        "-m",
        "remove",
      ]);
      const restored = runGit(repo, ["commit-tree", baseTree, "-p", removed, "-m", "restore"]);
      return { repo, base, tip, tips, removed, restored };
    });
    test(
      "checks incoming membership, thresholds, reuse, and no-op ranges",
      async ({ repo, base, tip, tips, removed, restored }) => {
        for (const candidate of tips)
          expect(validateGitCommit({ repoPath: repo }, candidate)).toMatchObject({ ok: true });
        const incoming = await listNewlyReachableObjects(
          repo,
          base,
          tip,
          KB_TREE_LIMITS.maxObjects,
        );
        expect(incoming.size).toBe(63); // 57 blobs, three trees, three commits.
        const incomingBytes = [...incoming].reduce(
          (bytes, sha) => bytes + readObjectSizeBytes(repo, sha),
          0,
        );
        expect(incomingBytes).toBeLessThan(KB_TREE_LIMITS.maxUncompressedObjectBytes);
        expect(incomingBytes + 12 * KB_TREE_LIMITS.maxMarkdownBytes).toBeGreaterThan(
          KB_TREE_LIMITS.maxUncompressedObjectBytes,
        );
        expect(
          await validateNewlyReachableCommits({ repoPath: repo }, { oldSha: base, newSha: tip }),
        ).toMatchObject({ ok: true });
        // Object membership is bounded at the threshold and during streaming.
        expect((await listNewlyReachableObjects(repo, base, tip, 63)).size).toBe(63);
        for (const limit of [62, 1]) {
          await expect(listNewlyReachableObjects(repo, base, tip, limit)).rejects.toThrow(
            TreeReadBudgetError,
          );
        }
        expect([...(await listNewlyReachableObjects(repo, removed, restored, 1))]).toEqual([
          restored,
        ]);
        expect(
          await validateNewlyReachableCommits(
            { repoPath: repo },
            { oldSha: removed, newSha: restored },
          ),
        ).toMatchObject({ ok: true });
        expect((await listNewlyReachableObjects(repo, tip, tip, 0)).size).toBe(0);
        expect(
          await validateNewlyReachableCommits({ repoPath: repo }, { oldSha: tip, newSha: tip }),
        ).toMatchObject({ ok: true });
      },
      { timeout: 240_000 },
    );
  });

  describe("carries one incoming-object budget across the whole commit range", () => {
    const test = gitFixtureTests("kb-tree-range-budget-", (reposDir) => {
      const work = join(reposDir, "work");
      mkdirSync(work);
      // Three commits, each replacing the previous batch with 23 distinct
      // 2 MiB Markdown blobs: every tree is within the 64 MiB per-tree budget,
      // but the range introduces 138 MiB of distinct blob content, exceeding
      // the 128 MiB incoming-object cap.
      const blobBytes = KB_TREE_LIMITS.maxMarkdownBytes;
      const perCommit = 23;
      runGit(work, ["init", "--quiet", "--initial-branch=main"], hardenedGitEnv());
      seedRequiredFiles(work, "# range budget\n");
      runGit(work, ["add", "."], hardenedGitEnv());
      runGit(work, ["commit", "-m", "base"], hardenedGitEnv());
      const base = readHeadSha(work)!;
      mkdirSync(join(work, "data"), { recursive: true });
      for (let commit = 1; commit <= 3; commit += 1) {
        for (let fileIndex = 1; fileIndex <= perCommit; fileIndex += 1) {
          const body = Buffer.alloc(blobBytes, 0x61);
          const header = `# distinct blob ${commit}/${fileIndex}\n`;
          body.write(header, 0, "utf8");
          writeFileSync(join(work, "data", `f${fileIndex}.md`), body);
        }
        runGit(work, ["add", "data"], hardenedGitEnv());
        runGit(work, ["commit", "-m", `batch ${commit}`], hardenedGitEnv());
      }
      const tip = readHeadSha(work)!;
      const repo = kbBareRepoPath(reposDir, "rangebudget");
      mkdirSync(reposDir, { recursive: true });
      runGit(work, ["clone", "--quiet", "--bare", work, repo], hardenedGitEnv());
      // Sanity: every individual commit in the range is valid on its own.
      const second = runGit(work, ["rev-parse", "HEAD~1"], hardenedGitEnv());
      return { repo, base, tip, second };
    });
    test(
      "checks individual validity and the aggregate cap",
      async ({ repo, base, tip, second }) => {
        expect(validateGitCommit({ repoPath: repo }, second).ok).toBe(true);
        const range = await validateNewlyReachableCommits(
          { repoPath: repo },
          { oldSha: base, newSha: tip },
        );
        expect(range.ok).toBe(false);
        if (!range.ok) expect(range.code).toBe("TREE_BUDGET");
        // The tip itself is still valid in isolation: only the aggregate trips.
        expect(validateGitCommit({ repoPath: repo }, tip).ok).toBe(true);
      },
      { timeout: 240_000 },
    );
  });

  describe("standalone validation and reuse metadata", () => {
    const test = initialTreeTests("range", "range test");
    describe("rejects an invalid standalone commit", () => {
      const invalidTest = gitFixtureTests("kb-tree-bad-", (badWork) => {
        writeFileSync(join(badWork, "index.md"), "# bad\n\u0001\n", "utf8");
        writeFileSync(join(badWork, ".gitignore"), "# kb managed\n", "utf8");
        mkdirSync(join(badWork, ".assets"), { recursive: true });
        writeFileSync(
          join(badWork, ".assets/manifest.json"),
          '{"version":1,"entries":[]}\n',
          "utf8",
        );
        runGit(badWork, ["init", "--initial-branch=main"], hardenedGitEnv());
        runGit(badWork, ["add", "."], hardenedGitEnv());
        runGit(badWork, ["commit", "-m", "bad"], hardenedGitEnv());
        const badSha = readHeadSha(badWork)!;
        return { badWork, badSha };
      });
      invalidTest("checks the malformed real commit", ({ badWork, badSha }) => {
        expect(validateGitCommit({ repoPath: badWork }, badSha).ok).toBe(false);
      });
    });

    test("preserves metadata on reuse commits", async ({ reposDir, kbId, repo, head: base }) => {
      const beforeMeta = readCommitMetadata(repo, base);
      // Pin the reuse commit to the base timestamp so a second-boundary
      // crossing between the two commits cannot break the author comparison.
      const baseTimestamp = Number.parseInt(
        / (\d+) \+0000$/.exec(beforeMeta.author)?.[1] ?? "",
        10,
      );
      const good = await createTreeReuseCommit(
        { reposDir, kbId },
        { parentSha: base, message: "good marker", timestampSeconds: baseTimestamp },
      );
      const afterMeta = readCommitMetadata(repo, good);
      expect(afterMeta.author).toBe(beforeMeta.author);
      expect(afterMeta.committer).toContain("knowledge-base");
      expect(good).toMatch(/^[0-9a-f]{40}$/);
    });
  });
});

describe.each([false, true])("final frontMatter contract, overflow=%s", (overflow) => {
  const test = gitFixtureTests("kb-frontmatter-json-", (root) =>
    commitFixtureTree(root, "encoded", {
      files: {
        ...cases.validMinimal.files,
        "metadata.md": `---\nk: '${"\t".repeat(32764)}${overflow ? "a" : ""}'\n---\nbody\n`,
      },
    }),
  );
  test("validates the final JSON size at the real Git tree boundary", (fixture) => {
    const result = validateGitCommit({ repoPath: fixture.repo }, fixture.sha);
    if (overflow) expect(result).toMatchObject({ ok: false, code: "TREE_MARKDOWN" });
    else expect(result.ok).toBe(true);
  });
});
