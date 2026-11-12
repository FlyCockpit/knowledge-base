import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, vi } from "vitest";
import { manifestAtCommitAsync } from "./asset-authz";
import { walkGitTreeAtCommit } from "./changes-plan";
import { diffAtRevisions } from "./diff";
import { isCommitReachable } from "./documents-read";
import { gitFixtureTests } from "./fixtures/git-fixture";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { writeCountingGitWrapper } from "./fixtures/git-wrapper";
import {
  nearLimitByteFiles,
  nearLimitDistinctFiles,
  writeFixtureCommit,
} from "./fixtures/near-limit-tree";
import { hardenedGitEnv, runGit } from "./git-read";
import {
  bindValidatedTreeForPublication,
  fsyncRefUpdate,
  initialMainTreeFiles,
  removeLooseObjectsAsync,
  writeStagedObjectsAsync,
} from "./git-write";
import { KB_TREE_LIMITS } from "./limits";
import { MutationScope } from "./lock";
import { canonicalManifestBytes } from "./manifest";
import { mergeProposalOntoMain, planReviewedMerge, proposalConflictError } from "./pr-merge";
import type { TreeFileInput } from "./staged-tree";
import { stageCommitWithTreeFiles } from "./staged-tree";
import { treeEntryCount } from "./tree-budget";
import { validateGitCommit, validateGitCommitAsync } from "./validate-tree";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

function fixture(root: string) {
  const repo = join(root, "kb_fixture.git");
  execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
  const files = initialMainTreeFiles("Pull request merge fixture");
  const commit = (parent: string, extra: TreeFileInput[], message = "fixture") => {
    return writeGitFixtureCommit(repo, {
      parentSha: parent,
      message,
      files: [...files, ...extra],
    });
  };
  // The initial fixture is an object-only root; no working-tree/index/ref mutation.
  const base = writeGitFixtureCommit(repo, {
    parentSha: "0".repeat(40),
    message: "initial",
    files,
  });
  return { root, repo, base, commit };
}
const file = (path: string, body: string): TreeFileInput => ({
  segments: path.split("/"),
  content: Buffer.from(body),
});

const png = (n: string) => ({
  path: `media/${n}.png`,
  hash: `sha256:${n.repeat(64).slice(0, 64)}`,
  size: 10,
  mime: "image/png",
});
/** Commits that differ only in their asset manifest (independent and clashing additions). */
function assetFixtures(f: ReturnType<typeof fixture>) {
  const withManifest = (entries: ReturnType<typeof png>[]) =>
    writeGitFixtureCommit(f.repo, {
      parentSha: f.base,
      message: "assets",
      files: [
        ...initialMainTreeFiles("Pull request merge fixture").filter(
          (entry) => entry.segments.join("/") !== ".assets/manifest.json",
        ),
        {
          segments: [".assets", "manifest.json"],
          content: canonicalManifestBytes({ version: 1, entries }),
        },
      ],
    });
  return {
    assetMain: withManifest([png("a")]),
    assetHead: withManifest([png("b")]),
    assetClash: withManifest([{ ...png("a"), hash: `sha256:${"c".repeat(64)}` }]),
  };
}

/** 8,191 entries (root included), and main and proposal each one flat document more. */
function rootBoundaryFixtures(f: ReturnType<typeof fixture>) {
  const chain = (n: number) =>
    `${Array.from({ length: 30 }, (_, d) => (d === 0 ? `c${n}` : "d")).join("/")}/x.md`;
  const docs = [
    file("solo/x.md", "solo\n"),
    // Identical chains share their subtrees (few objects), yet every visit counts.
    ...Array.from({ length: 264 }, (_, n) => file(chain(n), "x\n")),
  ];
  const files = initialMainTreeFiles("Pull request merge fixture");
  const boundaryBase = writeGitFixtureCommit(f.repo, {
    parentSha: f.base,
    message: "boundary",
    files: [...files, ...docs],
  });
  const plus = (extra: TreeFileInput) =>
    writeGitFixtureCommit(f.repo, {
      parentSha: boundaryBase,
      message: "plus",
      files: [...files, ...docs, extra],
    });
  return {
    boundaryMain: plus(file("m.md", "main\n")),
    boundaryHead: plus(file("p.md", "proposal\n")),
  };
}

const longPath = (n: number) =>
  `${"l".repeat(250)}/${"m".repeat(241)}/${String(n).padStart(10, "0")}.md`;

describe("reviewed merge trees", () => {
  const test = gitFixtureTests("kb-pr-merge-", (root) => {
    const f = fixture(root);
    const doc = "---\nid: shared\n---\nbody";
    return {
      ...f,
      head: f.commit(f.base, [file("a.md", "a")]),
      main: f.commit(f.base, [file("main.md", "main")]),
      proposal: f.commit(f.base, [file("proposal.md", "proposal")]),
      conflictMain: f.commit(f.base, [file("same.md", "main")]),
      conflictHead: f.commit(f.base, [file("same.md", "proposal")]),
      humanMain: f.commit(f.base, [
        file("concepts/a.md", "---\nid: a\nprovenance: human\n---\nhuman"),
      ]),
      other: f.commit(f.base, [file("other.md", "other")]),
      duplicateMain: f.commit(f.base, [file("main.md", doc)]),
      duplicateHead: f.commit(f.base, [file("head.md", doc)]),
      invalid: f.commit(f.base, [file("bad.bin", "binary")]),
      ...assetFixtures(f),
      ...rootBoundaryFixtures(f),
      // 2,200 paths of 506 bytes: past a 1 MiB listing, within the limits.
      manyLongPaths: writeGitFixtureCommit(f.repo, {
        parentSha: f.base,
        message: "many",
        files: [
          ...initialMainTreeFiles("Pull request merge fixture"),
          ...Array.from({ length: 2200 }, (_, n) => file(longPath(n), `${n}`)),
        ],
      }),
    };
  });
  test("records the reviewer in a merge commit even for compatible ancestry", async (f) => {
    const message = "Merge #1: Fixture proposal\n\nActed-by: Reviewer via web";
    const result = await planReviewedMerge({
      repoPath: f.repo,
      mainHead: f.base,
      sourceHead: f.head,
      dream: null,
      message,
    });
    expect(result.commitSha).not.toBe(f.head);
    expect(result.objects.size).toBe(1);
    const commit = result.objects.get(result.commitSha);
    expect(commit?.body.toString()).toContain(`parent ${f.base}\nparent ${f.head}\n`);
    expect(commit?.body.toString()).toContain(message);
  });
  test("fast forwards compatible ancestry and validates the entire tree", async (f) => {
    const result = await planReviewedMerge({
      repoPath: f.repo,
      mainHead: f.base,
      sourceHead: f.head,
      dream: null,
    });
    expect(result.commitSha).toBe(f.head);
    expect(result.objects.size).toBe(0);
    expect(result.validation.ok).toBe(true);
  });
  test("creates a clean divergent merge with main first and proposal second", async (f) => {
    const result = await planReviewedMerge({
      repoPath: f.repo,
      mainHead: f.main,
      sourceHead: f.proposal,
      dream: null,
    });
    expect(writeGitFixtureCommit(f.repo, result)).toBe(result.commitSha);
    expect(runGit(f.repo, ["cat-file", "-p", result.commitSha])).toContain(
      `parent ${f.main}\nparent ${f.proposal}\n`,
    );
    expect(runGit(f.repo, ["ls-tree", "-r", "--name-only", result.commitSha])).toContain("main.md");
    expect(runGit(f.repo, ["ls-tree", "-r", "--name-only", result.commitSha])).toContain(
      "proposal.md",
    );
    expect(validateGitCommit({ repoPath: f.repo }, result.commitSha).ok).toBe(true);
  });
  test("rejects a real content conflict without publishing any ref", async (f) => {
    await expect(
      planReviewedMerge({
        repoPath: f.repo,
        mainHead: f.conflictMain,
        sourceHead: f.conflictHead,
        dream: null,
      }),
    ).rejects.toThrow("This pull request conflicts with main");
    expect(runGit(f.repo, ["for-each-ref"])).toBe("");
  });
  test("replays a proposal onto main read-only, reporting conflicted paths", async (f) => {
    const before = readdirSync(join(f.repo, "objects")).sort();
    const clean = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.main,
      proposalHead: f.proposal,
      readFiles: true,
    });
    expect(clean.conflicts).toEqual([]);
    expect(clean.files?.get("main.md")?.toString()).toBe("main");
    expect(clean.files?.get("proposal.md")?.toString()).toBe("proposal");
    const clash = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.conflictMain,
      proposalHead: f.conflictHead,
      readFiles: true,
    });
    expect(clash.conflicts).toEqual([{ path: "same.md", kind: "document" }]);
    // Never a merge marker: the conflicted document keeps the proposal's version.
    expect(clash.files?.get("same.md")?.toString()).toBe("proposal");
    for (const bytes of clash.files!.values()) expect(bytes.toString()).not.toContain("<<<<<<<");
    const statusOnly = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.conflictMain,
      proposalHead: f.conflictHead,
      readFiles: false,
    });
    expect(statusOnly).toMatchObject({
      conflicts: [{ path: "same.md", kind: "document" }],
      files: null,
      proposalPaths: null,
    });
    // Ancestry needs no scratch merge at all.
    expect(
      (
        await mergeProposalOntoMain({
          repoPath: f.repo,
          mainHead: f.base,
          proposalHead: f.head,
          readFiles: false,
        })
      ).conflicts,
    ).toEqual([]);
    // The canonical repository gained no objects and no refs.
    expect(readdirSync(join(f.repo, "objects")).sort()).toEqual(before);
    expect(runGit(f.repo, ["for-each-ref"])).toBe("");
  });
  test("independent asset additions merge; a clashing asset is named, not the manifest", async (f) => {
    const clean = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.assetMain,
      proposalHead: f.assetHead,
      readFiles: true,
    });
    expect(clean.conflicts).toEqual([]);
    const manifest = JSON.parse(clean.files!.get(".assets/manifest.json")!.toString());
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([
      "media/a.png",
      "media/b.png",
    ]);
    const lineage = [png("a"), png("b")];
    const merged = await planReviewedMerge({
      repoPath: f.repo,
      mainHead: f.assetMain,
      sourceHead: f.assetHead,
      dream: null,
      validation: {
        trustedBlobs: new Map(lineage.map((e) => [e.hash, { size: e.size, mime: e.mime }])),
        lineageHashes: new Set(lineage.map((e) => e.hash)),
      },
    });
    expect(merged.validation.ok).toBe(true);
    const clash = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.assetMain,
      proposalHead: f.assetClash,
      readFiles: false,
    });
    expect(clash.conflicts).toEqual([{ path: "media/a.png", kind: "asset" }]);
    const error = await proposalConflictError({
      repoPath: f.repo,
      mainHead: f.assetMain,
      proposalHead: f.assetClash,
      proposalNumber: 1,
      paths: clash.conflicts,
    });
    expect((error.details as { paths: unknown[] }).paths).toMatchObject([
      {
        path: "media/a.png",
        kind: "asset",
        base: null,
        theirs: JSON.stringify(png("a")),
        yours: JSON.stringify({ ...png("a"), hash: `sha256:${"c".repeat(64)}` }),
      },
    ]);
    await expect(
      planReviewedMerge({
        repoPath: f.repo,
        mainHead: f.assetMain,
        sourceHead: f.assetClash,
        dream: null,
      }),
    ).rejects.toThrow("This pull request conflicts with main");
  });
  test("path listings fit every tree the limits allow (2,200 paths of 506 bytes)", async (f) => {
    expect(Buffer.byteLength(longPath(0))).toBe(506);
    const many = f.manyLongPaths;
    const merged = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.main,
      proposalHead: many,
      readFiles: true,
    });
    expect(merged.conflicts).toEqual([]);
    expect(merged.proposalPaths).toHaveLength(2200);
  });
  test("the root tree counts — two flat additions at 8,191 entries conflict", async (f) => {
    // Both heads are valid at 8,192 entries; the merge would be 8,193.
    for (const head of [f.boundaryMain, f.boundaryHead])
      expect(validateGitCommit({ repoPath: f.repo }, head).ok).toBe(true);
    const rebase = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.boundaryMain,
      proposalHead: f.boundaryHead,
      readFiles: true,
    });
    // The update flow records a typed conflict instead of failing TOO_LARGE.
    expect(rebase.conflicts).toEqual([{ path: "p.md", kind: "document" }]);
    await expect(
      planReviewedMerge({
        repoPath: f.repo,
        mainHead: f.boundaryMain,
        sourceHead: f.boundaryHead,
        dream: null,
      }),
    ).rejects.toThrow("This pull request conflicts with main");
  });
  test("an unresolved update carries base, theirs and yours", async (f) => {
    const error = await proposalConflictError({
      repoPath: f.repo,
      mainHead: f.conflictMain,
      proposalHead: f.conflictHead,
      proposalNumber: 3,
      paths: [{ path: "same.md", kind: "document" }],
    });
    expect(error).toMatchObject({
      code: "CONFLICT",
      details: {
        headSha: f.conflictMain,
        proposalNumber: 3,
        reason: "PROPOSAL_CONFLICT",
        baseSha: f.base,
        proposalHeadSha: f.conflictHead,
        contentIncluded: true,
        paths: [{ path: "same.md", base: null, theirs: "main", yours: "proposal" }],
      },
    });
  });
  test("rejects an otherwise clean merge after human provenance takes over", async (f) => {
    const dream = {
      model: { provider: "fixture", model: "fixture" },
      redactionApplied: true as const,
      upserts: [],
      guardTouchedPaths: { a: [{ path: "concepts/a.md", existedAtBase: false }] },
    };
    await expect(
      planReviewedMerge({ repoPath: f.repo, mainHead: f.humanMain, sourceHead: f.other, dream }),
    ).rejects.toThrow("This pull request conflicts with main");
    expect(runGit(f.repo, ["for-each-ref"])).toBe("");
  });
  test("rejects duplicate IDs introduced only by the combined tree", async (f) => {
    await expect(
      planReviewedMerge({
        repoPath: f.repo,
        mainHead: f.duplicateMain,
        sourceHead: f.duplicateHead,
        dream: null,
      }),
    ).rejects.toThrow();
  });
  test("validates a fast forward too, and handles already integrated source", async (f) => {
    await expect(
      planReviewedMerge({ repoPath: f.repo, mainHead: f.base, sourceHead: f.invalid, dream: null }),
    ).rejects.toThrow();
    expect(
      (
        await planReviewedMerge({
          repoPath: f.repo,
          mainHead: f.head,
          sourceHead: f.base,
          dream: null,
        })
      ).commitSha,
    ).toBe(f.head);
  });
});

// A real Git read blocked in open(2), with no mocked child/validator boundary.
async function withBlockedBlob(
  f: ReturnType<typeof fixture>,
  sha: string,
  path: string,
  work: () => Promise<void>,
) {
  const blob = runGit(f.repo, ["rev-parse", `${sha}:${path}`]);
  const object = join(f.repo, "objects", blob.slice(0, 2), blob.slice(2));
  const original = readFileSync(object);
  unlinkSync(object);
  execFileSync("mkfifo", [object]);
  try {
    await work();
  } finally {
    unlinkSync(object);
    writeFileSync(object, original);
  }
}
describe("PR operation lifetime", () => {
  const test = gitFixtureTests("kb-pr-lifetime-", async (root) => {
    const f = fixture(root);
    const source = f.commit(f.base, [file("proposal.md", "proposal")]);
    const main = f.commit(f.base, [file("main.md", "main")]);
    const head = f.commit(f.base, [file("a.md", "a")]);
    const plan = await planReviewedMerge({
      repoPath: f.repo,
      mainHead: f.base,
      sourceHead: head,
      dream: null,
    });
    return { ...f, source, main, head, plan };
  });
  test("source-asset reads (reachability, manifest) are cancellable", async (f) => {
    let timerRan = false;
    const tick = setTimeout(() => {
      timerRan = true;
    }, 20);
    try {
      await withBlockedBlob(f, f.head, ".assets/manifest.json", async () => {
        await expect(
          manifestAtCommitAsync(f.repo, f.head, { deadlineAt: Date.now() + 150 }),
        ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      });
      // Reachability reads commit objects: block the head commit itself.
      runGit(f.repo, ["update-ref", "refs/heads/reach", f.head]);
      const object = join(f.repo, "objects", f.head.slice(0, 2), f.head.slice(2));
      const original = readFileSync(object);
      unlinkSync(object);
      execFileSync("mkfifo", [object]);
      try {
        await expect(
          isCommitReachable(f.repo, f.base, { deadlineAt: Date.now() + 150 }),
        ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      } finally {
        unlinkSync(object);
        writeFileSync(object, original);
        runGit(f.repo, ["update-ref", "-d", "refs/heads/reach"]);
      }
    } finally {
      clearTimeout(tick);
    }
    expect(timerRan).toBe(true);
  });
  test("request publication reads are cancellable and never block the event loop", async (f) => {
    let timerRan = false;
    await withBlockedBlob(f, f.head, "index.md", async () => {
      const tick = setTimeout(() => {
        timerRan = true;
      }, 20);
      try {
        await expect(
          walkGitTreeAtCommit({
            repoPath: f.repo,
            baseRevision: f.head,
            changes: [{ op: "create", path: "n.md", content: { markdown: "# n\n" } }],
            gitOptions: { deadlineAt: Date.now() + 150 },
          }),
        ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
        await expect(
          validateGitCommitAsync({ repoPath: f.repo, deadlineAt: Date.now() + 150 }, f.head),
        ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      } finally {
        clearTimeout(tick);
      }
    });
    expect(timerRan).toBe(true);
  });
  for (const kind of ["ff", "divergent", "integrated", "dream"]) {
    test(`bounds a stalled ${kind} validator/provenance child and permits retry`, async (f) => {
      const source = f.source;
      const main = kind === "divergent" ? f.main : kind === "integrated" ? source : f.base;
      const head = kind === "integrated" ? f.base : source;
      const dream =
        kind === "dream"
          ? {
              model: { provider: "test", model: "test" },
              redactionApplied: true as const,
              upserts: [],
            }
          : null;
      let timerRan = false;
      await withBlockedBlob(f, head, "index.md", async () => {
        const tick = setTimeout(() => {
          timerRan = true;
        }, 20);
        try {
          await expect(
            planReviewedMerge({
              repoPath: f.repo,
              mainHead: main,
              sourceHead: head,
              dream,
              deadlineAt: Date.now() + 150,
            }),
          ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
        } finally {
          clearTimeout(tick);
        }
      });
      expect(timerRan).toBe(true);
      expect(runGit(f.repo, ["for-each-ref"])).toBe("");
      const retry = await planReviewedMerge({
        repoPath: f.repo,
        mainHead: main,
        sourceHead: head,
        dream,
      });
      expect(retry.validation.ok).toBe(true);
      if (kind === "divergent") expect(readdirSync(join(f.root, ".private", "tmp"))).toEqual([]);
    });
  }
  test("responds to scope shutdown while a real child is stalled", async (f) => {
    const head = f.head;
    const scope = new MutationScope("pr-shutdown", Date.now, Date.now() + 5000);
    await withBlockedBlob(f, head, "index.md", async () => {
      const timer = setTimeout(() => scope.requestShutdown(), 100);
      try {
        await expect(
          planReviewedMerge({
            repoPath: f.repo,
            mainHead: f.base,
            sourceHead: head,
            dream: null,
            signal: scope.signal,
            deadlineAt: scope.deadlineAt,
          }),
        ).rejects.toMatchObject({ code: "CANCELLED" });
      } finally {
        clearTimeout(timer);
        scope.dispose();
      }
    });
    expect(
      (
        await planReviewedMerge({
          repoPath: f.repo,
          mainHead: f.base,
          sourceHead: head,
          dream: null,
        })
      ).commitSha,
    ).toBe(head);
  });
  test("bounds manifest detail reads and revalidates before publication", async (f) => {
    const { head, plan } = f;
    await withBlockedBlob(f, head, ".assets/manifest.json", async () => {
      await expect(
        diffAtRevisions({
          repoPath: f.repo,
          baseSha: f.base,
          headSha: head,
          limit: 200,
          deadlineAt: Date.now() + 100,
        }),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      let published = false;
      await expect(
        fsyncRefUpdate(
          {
            reposDir: f.root,
            kbId: "fixture",
            executor: {
              exec() {
                published = true;
              },
            },
          },
          {
            refName: "refs/heads/main",
            oldSha: f.base,
            newSha: head,
            binding: bindValidatedTreeForPublication(plan.validation, head),
            readOptions: { deadlineAt: Date.now() + 100 },
          },
        ),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(published).toBe(false);
    });
    expect(
      (await diffAtRevisions({ repoPath: f.repo, baseSha: f.base, headSha: head, limit: 200 }))
        .files,
    ).toHaveLength(1);
  });
});

function persistenceFixture(root: string) {
  const f = fixture(root);
  const staged = stageCommitWithTreeFiles({
    files: [...initialMainTreeFiles("Pull request merge fixture"), file("async.md", "async")],
    parentSha: f.base,
    message: "async",
  });
  return { ...f, staged };
}
describe("async PR object persistence", () => {
  describe("fresh persistence", () => {
    const test = gitFixtureTests("kb-pr-persist-", persistenceFixture);
    test("writes/fsyncs objects and validates their real Git tree", async (f) => {
      const created: string[] = [];
      await writeStagedObjectsAsync(f.repo, f.staged.objects, created, {
        deadlineAt: Date.now() + 30_000,
      });
      expect(created.length).toBeGreaterThan(0);
      expect(validateGitCommit({ repoPath: f.repo }, f.staged.commitSha).ok).toBe(true);
    });
    test("flushes every object's bytes before flushing each shared directory once", async (f) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const synced = new Set<string>();
      const directories: string[] = [];
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        const path = String(args[0]);
        const directory = (await handle.stat()).isDirectory();
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          if (directory) {
            expect(synced.size).toBe(f.staged.objects.size);
            directories.push(path);
          } else {
            synced.add(path);
          }
          await sync();
        });
        return handle;
      });
      try {
        await writeStagedObjectsAsync(f.repo, f.staged.objects, [], {});
        expect(directories.length).toBeGreaterThan(0);
        expect(new Set(directories).size).toBe(directories.length);
      } finally {
        vi.mocked(open).mockImplementation(actual.open);
      }
    });
    test("joins pending object writes on failure before cleanup can remove their inodes", async (f) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const staged = stageCommitWithTreeFiles({
        files: [
          ...initialMainTreeFiles("Pull request merge fixture"),
          file("failure.md", "failure"),
        ],
        parentSha: f.base,
        message: "failed batch",
      });
      let unblock!: () => void;
      let admitted!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const started = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      const failure = new Error("injected object write failure");
      let writes = 0;
      let pending = 0;
      let settled = false;
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        // This fault test measures write drainage. The preceding test covers
        // real fsync ordering; journal latency is outside this assertion.
        vi.spyOn(handle, "sync").mockResolvedValue();
        if (args[1] === "wx") {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementation(async (...input) => {
            pending++;
            const index = writes++;
            try {
              if (index === 0) await blocked;
              if (index === 1) {
                admitted();
                throw failure;
              }
              await write(...input);
            } finally {
              pending--;
            }
          });
        }
        return handle;
      });
      const created: string[] = [];
      const outcome = writeStagedObjectsAsync(f.repo, staged.objects, created, {}).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        await Promise.race([
          started,
          outcome.then((error) => {
            throw error ?? new Error("No concurrent write");
          }),
        ]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(pending).toBeGreaterThan(0);
        expect(settled).toBe(false);
      } finally {
        unblock();
        await outcome;
        vi.mocked(open).mockImplementation(actual.open);
      }
      expect(await outcome).toBe(failure);
      expect(pending).toBe(0);
      for (const sha of created) {
        const path = join(f.repo, "objects", sha.slice(0, 2), sha.slice(2));
        unlinkSync(path);
        expect(() => readFileSync(path)).toThrow();
      }
    });
  });
  describe("valid reuse", () => {
    const test = gitFixtureTests("kb-pr-reuse-", async (root) => {
      const f = persistenceFixture(root);
      await writeStagedObjectsAsync(f.repo, f.staged.objects, [], {});
      return f;
    });
    test("resyncs existing valid bytes without acquiring their cleanup ownership", async (f) => {
      const reused: string[] = [];
      await writeStagedObjectsAsync(f.repo, f.staged.objects, reused, {});
      expect(reused).toEqual([]);
    });
    test("verifies published reuse without flushing every unchanged inode again", async (f) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const syncedFiles: string[] = [];
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if ((await handle.stat()).isFile()) {
          const sync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            syncedFiles.push(String(args[0]));
            await sync();
          });
        }
        return handle;
      });
      const object = [...f.staged.objects.values()].find(
        (entry) => entry.type === "blob" && entry.body.toString() === "async",
      )!;
      const objectPath = join(f.repo, "objects", object.sha.slice(0, 2), object.sha.slice(2));
      try {
        await writeStagedObjectsAsync(
          f.repo,
          f.staged.objects,
          [],
          {},
          new Set(f.staged.objects.keys()),
        );
        expect(syncedFiles).toEqual([]);
        writeFileSync(objectPath, "corrupt");
        await expect(
          writeStagedObjectsAsync(
            f.repo,
            f.staged.objects,
            [],
            {},
            new Set(f.staged.objects.keys()),
          ),
        ).rejects.toThrow();
      } finally {
        writeFileSync(objectPath, object.deflated);
        vi.mocked(open).mockImplementation(actual.open);
      }
    });
    test("accepts identical objects with a different valid compression", async (f) => {
      const object = [...f.staged.objects.values()].find(
        (entry) => entry.type === "blob" && entry.body.toString() === "async",
      )!;
      const bytes = Buffer.concat([
        Buffer.from(`${object.type} ${object.body.length}\0`),
        object.body,
      ]);
      writeFileSync(
        join(f.repo, "objects", object.sha.slice(0, 2), object.sha.slice(2)),
        deflateSync(bytes, { level: 0 }),
      );
      const reused: string[] = [];
      await writeStagedObjectsAsync(f.repo, f.staged.objects, reused, {});
      expect(reused).toEqual([]);
    });
  });
  describe("corrupt reuse", () => {
    const test = gitFixtureTests("kb-pr-corrupt-", async (root) => {
      const f = persistenceFixture(root);
      const created: string[] = [];
      await writeStagedObjectsAsync(f.repo, f.staged.objects, created, {});
      const sha = created[0]!;
      const path = join(f.repo, "objects", sha.slice(0, 2), sha.slice(2));
      writeFileSync(path, "corrupt");
      return { ...f, path, created };
    });
    test("rejects corrupt bytes without replacing them and reclaims only owned objects", async (f) => {
      await expect(writeStagedObjectsAsync(f.repo, f.staged.objects, [], {})).rejects.toThrow();
      expect(readFileSync(f.path, "utf8")).toBe("corrupt");
      await removeLooseObjectsAsync(f.repo, f.created);
      expect(() => readFileSync(f.path)).toThrow();
    });
  });
  describe("retry after cleanup", () => {
    const test = gitFixtureTests("kb-pr-retry-", async (root) => {
      const f = persistenceFixture(root);
      const created: string[] = [];
      await writeStagedObjectsAsync(f.repo, f.staged.objects, created, {});
      await removeLooseObjectsAsync(f.repo, created);
      return f;
    });
    test("persists and validates a legitimate retry", async (f) => {
      await writeStagedObjectsAsync(f.repo, f.staged.objects, [], {});
      expect(validateGitCommit({ repoPath: f.repo }, f.staged.commitSha).ok).toBe(true);
    });
  });
  describe("cancellation before persistence", () => {
    const test = gitFixtureTests("kb-pr-cancel-write-", persistenceFixture);
    test("rejects before acquiring any object cleanup ownership", async (f) => {
      const abort = new AbortController();
      abort.abort();
      const created: string[] = [];
      await expect(
        writeStagedObjectsAsync(f.repo, f.staged.objects, created, { signal: abort.signal }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      expect(created).toEqual([]);
    });
  });
});

describe("near-limit trees with distinct subtrees", () => {
  const test = gitFixtureTests("kb-pr-near-limit-", async (root) => {
    const f = fixture(root);
    const files = nearLimitDistinctFiles();
    const stage = (parentSha: string, list: TreeFileInput[]) =>
      writeFixtureCommit(f.repo, parentSha, list);
    const big = await stage(f.base, files);
    const edited = files.map((entry) =>
      entry.segments.join("/") === "g7/d3/n.md" ? file("g7/d3/n.md", "# edited\n") : entry,
    );
    // An id cascade: the proposal shifts all 4,000 document ids by one, main
    // adds the next id, so every document falls back to main's version.
    const n = 4000;
    const cascadeDoc = (i: number, key: number) =>
      file(`d/${String(i).padStart(5, "0")}.md`, `---\nid: k${key}\n---\n# ${i}\n`);
    const required = initialMainTreeFiles("Pull request merge fixture");
    const shifted = Array.from({ length: n }, (_, i) => cascadeDoc(i, i));
    const cascadeBase = await stage(f.base, [...required, ...shifted]);
    return {
      ...f,
      files,
      big,
      head: await stage(big, edited),
      main: await stage(big, [...files.filter((e) => e.segments.join("/") !== "g9/d1/n.md")]),
      cascadeMain: await stage(cascadeBase, [
        ...required,
        ...shifted,
        file("main/new.md", `---\nid: k${n}\n---\n# new\n`),
      ]),
      cascadeHead: await stage(cascadeBase, [
        ...required,
        ...Array.from({ length: n }, (_, i) => cascadeDoc(i, i + 1)),
      ]),
    };
  });
  test("the fixture sits near the entry, file and depth limits", ({ files }) => {
    const dirs = new Set<string>();
    for (const entry of files)
      for (let n = 1; n < entry.segments.length; n += 1)
        dirs.add(entry.segments.slice(0, n).join("/"));
    const entries = treeEntryCount(files.length, dirs.size);
    expect(entries).toBe(7912);
    expect(entries).toBeLessThanOrEqual(KB_TREE_LIMITS.maxEntries);
    expect(files.length).toBeLessThanOrEqual(KB_TREE_LIMITS.maxFiles);
    expect(Math.max(...files.map((e) => e.segments.length))).toBe(KB_TREE_LIMITS.maxTreeDepth);
  });
  test("validates and plans a divergent merge well within the deadlines", async (f) => {
    const started = Date.now();
    expect((await validateGitCommitAsync({ repoPath: f.repo }, f.big)).ok).toBe(true);
    expect(validateGitCommit({ repoPath: f.repo }, f.big).ok).toBe(true);
    const plan = await planReviewedMerge({
      repoPath: f.repo,
      mainHead: f.main,
      sourceHead: f.head,
      dream: null,
      // A list page rechecks many PRs inside one read lifetime.
      deadlineAt: Date.now() + 5_000,
    });
    expect(plan.validation.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
  test("settles a 4,000-document id cascade with batched reads of main's versions", async (f) => {
    const bin = join(f.root, "bin-cascade");
    const log = join(f.root, "git-cascade");
    mkdirSync(bin);
    writeFileSync(log, "");
    writeCountingGitWrapper(bin, log);
    const started = Date.now();
    let merged: Awaited<ReturnType<typeof mergeProposalOntoMain>>;
    try {
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      merged = await mergeProposalOntoMain({
        repoPath: f.repo,
        mainHead: f.cascadeMain,
        proposalHead: f.cascadeHead,
        readFiles: true,
        scratchRoot: f.root,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(merged.conflicts).toHaveLength(4001);
    // One read per fallback version took ~21 s.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readFileSync(log, "utf8").trim().split("\n").length).toBeLessThanOrEqual(24);
  });
  test("reads an incorporated proposal's files in a fixed number of git processes", async (f) => {
    // Main is an ancestor of the proposal (another branch incorporated it):
    // the shortcut reads the proposal head's files.
    const bin = join(f.root, "bin-ancestry");
    const log = join(f.root, "git-ancestry");
    mkdirSync(bin);
    writeFileSync(log, "");
    writeCountingGitWrapper(bin, log);
    const started = Date.now();
    let merged: Awaited<ReturnType<typeof mergeProposalOntoMain>>;
    try {
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      merged = await mergeProposalOntoMain({
        repoPath: f.repo,
        mainHead: f.big,
        proposalHead: f.head,
        readFiles: true,
        scratchRoot: f.root,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(merged.conflicts).toEqual([]);
    expect(merged.files?.size).toBe(f.files.length);
    expect(merged.files?.get("g7/d3/n.md")?.toString()).toBe("# edited\n");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readFileSync(log, "utf8").trim().split("\n").length).toBeLessThanOrEqual(16);
  });
  test("plans with a fixed number of git processes, not one per directory", async (f) => {
    const bin = join(f.root, "bin");
    const log = join(f.root, "git-calls");
    mkdirSync(bin);
    writeFileSync(log, "");
    writeCountingGitWrapper(bin, log);
    try {
      vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
      const plan = await planReviewedMerge({
        repoPath: f.repo,
        mainHead: f.main,
        sourceHead: f.head,
        dream: null,
      });
      expect(plan.validation.ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    // ~4,000 distinct directories, a 32-deep chain: still a handful of reads.
    expect(readFileSync(log, "utf8").trim().split("\n").length).toBeLessThanOrEqual(24);
  });
});

describe("near-limit bytes with clean edits to every document", () => {
  const test = gitFixtureTests("kb-pr-near-bytes-", async (root) => {
    const f = fixture(root);
    const base = await writeFixtureCommit(f.repo, f.base, nearLimitByteFiles("base"));
    return {
      ...f,
      near: base,
      main: await writeFixtureCommit(f.repo, base, nearLimitByteFiles("main")),
      head: await writeFixtureCommit(f.repo, base, nearLimitByteFiles("proposal")),
    };
  });
  test(
    "rebases and plans 4,093 line merges well inside the deadlines",
    async (f) => {
      expect(validateGitCommit({ repoPath: f.repo }, f.main).ok).toBe(true);
      let started = Date.now();
      const moved = await mergeProposalOntoMain({
        repoPath: f.repo,
        mainHead: f.main,
        proposalHead: f.head,
        readFiles: true,
        scratchRoot: f.root,
        deadlineAt: Date.now() + 30_000,
      });
      expect(moved.conflicts).toEqual([]);
      const sample = moved.files?.get("d0007/doc.md")?.toString() ?? "";
      expect(sample.startsWith("# d7 main")).toBe(true);
      expect(sample).toContain("last line of 7 by the proposal");
      expect(Date.now() - started).toBeLessThan(25_000);
      started = Date.now();
      const plan = await planReviewedMerge({
        repoPath: f.repo,
        mainHead: f.main,
        sourceHead: f.head,
        dream: null,
        deadlineAt: Date.now() + 30_000,
      });
      expect(plan.validation.ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(25_000);
    },
    { timeout: 120_000 },
  );
});

describe("conflict details within the response budget", () => {
  // 50 paths whose recorded base and yours versions are distinct 2 MiB documents.
  const big = (n: number, side: string) =>
    file(`big/${n}.md`, `# ${side} ${n}\n${"x".repeat(KB_TREE_LIMITS.maxMarkdownBytes - 64)}\n`);
  const test = gitFixtureTests("kb-pr-conflict-budget-", async (root) => {
    const f = fixture(root);
    const files = initialMainTreeFiles("Pull request merge fixture");
    const n = Array.from({ length: 50 }, (_, i) => i);
    const base = await writeFixtureCommit(f.repo, f.base, [
      ...files,
      ...n.map((i) => big(i, "base")),
    ]);
    const yours = await writeFixtureCommit(f.repo, base, [
      ...files,
      ...n.map((i) => big(i, "yours")),
    ]);
    const main = await writeFixtureCommit(f.repo, base, [...files, file("main.md", "# main\n")]);
    return { ...f, base, yours, main, n };
  });
  test("decides inline contents from sizes and never reads past the budget", async (f) => {
    const error = await proposalConflictError({
      repoPath: f.repo,
      mainHead: f.main,
      proposalHead: f.yours,
      proposalNumber: 1,
      paths: f.n.map((i) => ({
        path: `big/${i}.md`,
        kind: "document" as const,
        baseSha: f.base,
        yoursSha: f.yours,
      })),
    });
    const details = error.details as {
      contentIncluded: boolean;
      paths: { base: unknown; yours: unknown; baseSha: string; yoursSha: string }[];
    };
    expect(error.code).toBe("CONFLICT");
    expect(details.contentIncluded).toBe(false);
    expect(details.paths).toHaveLength(50);
    for (const entry of details.paths)
      expect(entry).toMatchObject({ base: null, yours: null, baseSha: f.base, yoursSha: f.yours });
  });
});

describe("recorded choices survive ancestry", () => {
  const doc = (id: string, body: string) => `---\nid: ${id}\n---\n# ${body}\n`;
  const test = gitFixtureTests("kb-pr-recorded-ancestry-", (root) => {
    const f = fixture(root);
    // The PR's saved "yours" a.md carries id `shared`; its provisional head
    // holds main's a.md (id `one`) while the conflict is unresolved.
    const yours = f.commit(f.base, [file("a.md", doc("shared", "mine"))]);
    const provisional = f.commit(f.base, [file("a.md", doc("one", "main"))]);
    // Main takes in the provisional head, then adds c.md with the saved id.
    const main = f.commit(provisional, [
      file("a.md", doc("one", "main")),
      file("c.md", doc("shared", "c")),
    ]);
    return { ...f, yours, provisional, main };
  });
  test("a main that took in the provisional head is still checked against recorded choices", async (f) => {
    const recorded = [{ path: "a.md", kind: "document" as const, yoursSha: f.yours }];
    const merged = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.main,
      proposalHead: f.provisional,
      readFiles: true,
      scratchRoot: f.root,
      recorded,
    });
    expect(merged.conflicts).toEqual([
      { path: "a.md", kind: "document" },
      { path: "c.md", kind: "document", standing: true },
    ]);
    // Without recorded conflicts the shortcut still applies.
    const plain = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.main,
      proposalHead: f.provisional,
      readFiles: true,
      scratchRoot: f.root,
    });
    expect(plain.conflicts).toEqual([]);
  });
});

describe("merge scratch I/O ownership", () => {
  const test = gitFixtureTests("kb-pr-io-drain-", (root) => {
    const repo = join(root, "kb.git");
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const required = initialMainTreeFiles("Scratch I/O drain");
    const base = writeGitFixtureCommit(repo, {
      parentSha: "0".repeat(40),
      message: "base",
      files: required,
    });
    const side = (name: string) =>
      writeGitFixtureCommit(repo, {
        parentSha: base,
        message: name,
        files: [
          ...required,
          ...Array.from({ length: 48 }, (_, index) => ({
            segments: [`d${index}`, `${name}.md`],
            content: Buffer.from(`# ${name}\n`),
          })),
        ],
      });
    return { root, repo, main: side("main"), head: side("proposal") };
  });

  for (const cause of ["failure", "abort"] as const) {
    test(`drains actual late scratch writes before disposal on ${cause}`, async (f) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const before = readdirSync(join(f.repo, "objects"), { recursive: true }).sort();
      const abort = new AbortController();
      const failure = new Error("injected scratch write failure");
      let pending = 0;
      let writes = 0;
      let released = false;
      const deletionPending: number[] = [];
      vi.mocked(rm).mockImplementation(async (...args) => {
        if (/\/merge-[^/]+$/.test(String(args[0]))) deletionPending.push(pending);
        return actual.rm(...args);
      });
      let settled = false;
      let unblock!: () => void;
      let observed!: () => void;
      const blocked = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const triggered = new Promise<void>((resolve) => {
        observed = resolve;
      });
      vi.mocked(writeFile).mockImplementation(async (...args) => {
        if (!/\/merge-[^/]+\/objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(String(args[0])))
          return actual.writeFile(...args);
        pending += 1;
        const index = writes++;
        try {
          if (index === 0) await blocked;
          if (index === 1) {
            if (cause === "abort") abort.abort();
            observed();
            if (cause === "failure") throw failure;
          }
          await actual.writeFile(...args);
        } finally {
          pending -= 1;
        }
      });
      const outcome = planReviewedMerge({
        repoPath: f.repo,
        mainHead: f.main,
        sourceHead: f.head,
        dream: null,
        scratchRoot: f.root,
        signal: abort.signal,
        admitScratch: async () => async () => {
          expect(pending).toBe(0);
          released = true;
        },
      }).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        // Admission is an event, not a latency assertion. An early failure
        // must fail this test too; the suite's watchdog covers a true hang.
        await Promise.race([
          triggered,
          outcome.then((error) => {
            throw error ?? new Error("Merge completed without concurrent scratch writes");
          }),
        ]);
        // Let the rejection/abort propagate while the first actual write is pending.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(pending).toBeGreaterThan(0);
        expect(settled).toBe(false);
        expect(released).toBe(false);
      } finally {
        unblock();
        await outcome;
        vi.mocked(writeFile).mockImplementation(actual.writeFile);
        vi.mocked(rm).mockImplementation(actual.rm);
      }
      // Sample synchronously at rm entry: asynchronous deletion must never
      // overlap an admitted write, even if that write settles before rm does.
      expect(deletionPending).toEqual([0]);
      const error = await outcome;
      if (cause === "failure") expect(error).toBe(failure);
      else expect(error).toMatchObject({ code: "CANCELLED" });
      expect(released).toBe(true);
      expect(pending).toBe(0);
      expect(readdirSync(join(f.root, ".private", "tmp"))).toEqual([]);
      expect(readdirSync(join(f.repo, "objects"), { recursive: true }).sort()).toEqual(before);
    });
  }
});

/**
 * The shared native line-merge corpus (`fixtures/text-merge-cases.json`),
 * which kb-local's `tests/pull_requests.rs` runs too: every case is one
 * document of ONE real-Git merge, so the server and the local store combine
 * (or refuse) the same lines with the same algorithm.
 */
describe("native line merges: the shared real-Git corpus (server and kb-local parity)", () => {
  type TextCase = {
    name: string;
    base: string | null;
    main: string;
    proposal: string;
    merged: string | null;
  };
  const corpus = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/text-merge-cases.json"), "utf8"),
  ) as { cases: TextCase[] };
  const doc = (i: number) => `cases/c${String(i).padStart(2, "0")}.md`;
  const test = gitFixtureTests("kb-text-merge-", (root) => {
    const repo = join(root, "kb.git");
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const files = initialMainTreeFiles("Text merge corpus");
    const side = (parentSha: string, pick: (c: TextCase) => string | null) =>
      writeGitFixtureCommit(repo, {
        parentSha,
        message: "side",
        files: [
          ...files,
          ...corpus.cases.flatMap((c, i) => {
            const text = pick(c);
            return text === null ? [] : [file(doc(i), text)];
          }),
        ],
      });
    const base = side("0".repeat(40), (c) => c.base);
    return {
      root,
      repo,
      main: side(base, (c) => c.main),
      proposal: side(base, (c) => c.proposal),
    };
  });
  test("merges every case exactly as the corpus records", async (f) => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(30);
    const merged = await mergeProposalOntoMain({
      repoPath: f.repo,
      mainHead: f.main,
      proposalHead: f.proposal,
      readFiles: true,
      scratchRoot: f.root,
    });
    const clashing = new Set(merged.conflicts.map((c) => c.path));
    for (const [i, c] of corpus.cases.entries())
      expect(
        clashing.has(doc(i)) ? null : merged.files!.get(doc(i))!.toString("utf8"),
        c.name,
      ).toBe(c.merged);
  });
});
