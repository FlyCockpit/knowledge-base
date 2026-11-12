import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { requireBuiltArtifact } from "../../../../test-utils/src/kb/build-artifacts.mjs";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv, runGit } from "./git-read";
import { initialMainTreeFiles, writeInitialMainCommitLoose } from "./git-write";
import { createMergeScratch, MERGE_SCRATCH_BYTES, sweepMergeScratch } from "./merge-scratch";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kb-merge-scratch-test-"));
  dirs.push(root);
  return root;
}

describe("managed reviewed merge scratch", () => {
  it("admits bytes before object work, excludes live attempts, and cleans failures", async () => {
    const root = fixture();
    let released = false;
    const owned = await createMergeScratch(root, {}, async (opId, bytes) => {
      expect(opId).toMatch(/^merge-/);
      expect(bytes).toBe(MERGE_SCRATCH_BYTES);
      const entries = readdirSync(join(root, ".private/tmp"));
      expect(entries).toEqual([opId]);
      expect(readdirSync(join(root, ".private/tmp", opId))).toEqual([]);
      return async () => {
        released = true;
      };
    });
    await writeFile(join(owned.path, "keep"), "live");
    await sweepMergeScratch(root, () => {});
    expect(await readFile(join(owned.path, "keep"), "utf8")).toBe("live");
    await owned.dispose();
    expect(released).toBe(true);
    await expect(
      createMergeScratch(root, {}, async () => {
        throw new Error("admission denied");
      }),
    ).rejects.toThrow("admission denied");
    expect(await readdir(join(root, ".private/tmp"))).toEqual([]);
    await sweepMergeScratch(root, () => {});
  });
  it("requires the fence and keeps unrelated paths and symlink targets", async () => {
    const root = fixture();
    const target = fixture();
    await writeFile(join(target, "keep"), "safe");
    await sweepMergeScratch(root, () => {});
    const tmp = join(root, ".private/tmp");
    const name = `merge-${randomUUID()}`;
    await symlink(target, join(tmp, name));
    await mkdir(join(tmp, "merge-not-an-attempt"));
    await expect(
      sweepMergeScratch(root, () => {
        throw new Error("missing fence");
      }),
    ).rejects.toThrow("missing fence");
    expect(existsSync(join(tmp, name))).toBe(true);
    await sweepMergeScratch(root, () => {});
    expect(await readFile(join(target, "keep"), "utf8")).toBe("safe");
    expect(await readdir(tmp)).toEqual(["merge-not-an-attempt"]);
  });
  it("recovers real SIGKILL merge objects after descendant drain, preserves a live attempt, and retries", async () => {
    const repoRoot = resolve(import.meta.dirname, "../../../../..");
    const native = join(repoRoot, "apps/server/native");
    requireBuiltArtifact(join(native, "kb-supervisor"), "pnpm test:kb --build-only pr");
    // The supervisor fences <KB_DATA_ROOT>/repos; the repos root is a child.
    const dataRoot = fixture();
    const root = join(dataRoot, "repos");
    mkdirSync(join(root, ".private"), { recursive: true });
    const repo = join(root, "kb_fixture.git");
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const base = (
      await writeInitialMainCommitLoose(repo, {
        message: "initial",
        description: "crash fixture",
      })
    ).headSha;
    const files = initialMainTreeFiles("crash fixture");
    const commit = (path: string) =>
      writeGitFixtureCommit(repo, {
        parentSha: base,
        message: path,
        files: [...files, { segments: [path], content: Buffer.from(path) }],
      });
    const main = commit("main.md");
    const source = commit("proposal.md");
    const blob = runGit(repo, ["rev-parse", `${base}:index.md`]);
    const object = join(repo, "objects", blob.slice(0, 2), blob.slice(2));
    const bytes = readFileSync(object);
    unlinkSync(object);
    execFileSync("mkfifo", [object]);
    const script = join(root, "fixture.mts");
    const mergeModule = pathToFileURL(join(repoRoot, "packages/api/src/lib/kb/pr-merge.ts")).href;
    const scratchModule = pathToFileURL(
      join(repoRoot, "packages/api/src/lib/kb/merge-scratch.ts"),
    ).href;
    const fenceModule = pathToFileURL(join(repoRoot, "apps/server/src/kb-process.ts")).href;
    writeFileSync(
      script,
      `
import assert from "node:assert/strict";
import { writeFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { planReviewedMerge } from ${JSON.stringify(mergeModule)};
import { createMergeScratch, sweepMergeScratch } from ${JSON.stringify(scratchModule)};
import { assertProcessFence, pingProcessFence } from ${JSON.stringify(fenceModule)};
const root = process.env.KB_DATA_ROOT + "/repos";
await pingProcessFence();
const input = ${JSON.stringify({ repoPath: repo, mainHead: main, sourceHead: source, dream: null, scratchRoot: root })};
if (process.env.MODE === "owner") {
  void planReviewedMerge({ ...input, deadlineAt: Date.now() + 20000 }).catch(e => { console.error(e); process.exit(2); });
  for (;;) {
    const tmp = root + "/.private/tmp";
    let names = []; try { names = readdirSync(tmp); } catch {}
    if (names.some(n => { try { return readdirSync(tmp + "/" + n + "/objects").some(s => /^[a-f0-9]{2}$/.test(s)); } catch { return false; } })) break;
    await delay(10);
  }
  writeFileSync(root + "/written", String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const live = await createMergeScratch(root, {});
  writeFileSync(live.path + "/live", "keep");
  const released = [];
  await sweepMergeScratch(root, assertProcessFence, async id => { released.push(id); });
  assert.equal(released.length, 1);
  assert.equal(readdirSync(root + "/.private/tmp").length, 1);
  assert.equal(readdirSync(live.path)[0], "live");
  const retry = await planReviewedMerge(input);
  assert.equal(retry.validation.ok, true);
  await live.dispose();
  assert.deepEqual(readdirSync(root + "/.private/tmp"), []);
  process.exit(0);
}
`,
    );
    const start = (mode: string) => {
      const child = spawn(
        join(native, "kb-supervisor"),
        [
          "--",
          process.execPath,
          "--import",
          join(repoRoot, "node_modules/tsx/dist/loader.mjs"),
          script,
        ],
        {
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            KB_DATA_ROOT: dataRoot,
            MODE: mode,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      return {
        child,
        exit: new Promise<number | null>((done) => child.once("exit", done)),
        output: () => output,
      };
    };
    const owner = start("owner");
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(join(root, "written"))) {
        if (owner.child.exitCode !== null || Date.now() > deadline) throw new Error(owner.output());
        await delay(20);
      }
      const tmp = join(root, ".private/tmp");
      const attempt = readdirSync(tmp)[0]!;
      const objects = join(tmp, attempt, "objects");
      const shard = readdirSync(objects).find((n) => /^[a-f0-9]{2}$/.test(n))!;
      const objectName = readdirSync(join(objects, shard))[0]!;
      expect(inflateSync(readFileSync(join(objects, shard, objectName))).toString()).toMatch(
        /^(tree|commit) /,
      );
      const contender = start("contender");
      // The held fence is its own typed record and exit status.
      expect(await contender.exit).toBe(85);
      expect(contender.output()).toContain('"reason":"FENCE_HELD"');
      process.kill(Number(readFileSync(join(root, "written"), "utf8")), "SIGKILL");
      await owner.exit; // Native supervisor reaps every former descendant before fence release.
      expect(readdirSync(tmp)).toEqual([attempt]);
      unlinkSync(object);
      writeFileSync(object, bytes);
      const successor = start("successor");
      try {
        expect(await successor.exit, successor.output()).toBe(0);
      } finally {
        if (successor.child.exitCode === null) {
          successor.child.kill("SIGTERM");
          await successor.exit;
        }
      }
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      if (owner.child.exitCode === null) {
        owner.child.kill("SIGTERM");
        await owner.exit;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 25000);
});
