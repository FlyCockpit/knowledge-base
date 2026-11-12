import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync, mkdtempSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeGitFixtureBlobPack,
  writeGitFixtureCommit,
  writeGitFixtureLooseBlob,
} from "@knowledge-base/api/lib/kb/fixtures/git-objects";
import { hardenedGitEnv, kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import { captureLog } from "@knowledge-base/env/log";
import { kbDataPaths } from "@knowledge-base/env/topology";
import type { KbGitRollupJobData } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  checkout: vi.fn(),
  measure: vi.fn(),
  recover: vi.fn(),
  roll: vi.fn(),
  diskState: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  acknowledge: vi.fn(),
  root: "/unused",
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("@knowledge-base/env/shared", () => ({
  env: {
    DATABASE_URL: { reveal: () => "postgres://unused.invalid/fixture" },
    get KB_DATA_ROOT() {
      return state.root;
    },
  },
}));
vi.mock("@knowledge-base/api/lib/kb/authority-lock", () => ({ runLockedOperation: state.run }));
vi.mock("@knowledge-base/api/lib/kb/lock", async (original) => ({
  ...(await original<typeof import("@knowledge-base/api/lib/kb/lock")>()),
  checkoutPinnedSession: state.checkout,
}));
vi.mock("@knowledge-base/api/lib/kb/quota", () => ({
  reserveQuota: state.reserve,
  releaseQuota: state.release,
  statfsDiskMeter: () => ({}),
}));
vi.mock("@knowledge-base/api/lib/kb/git-rollup", async (original) => ({
  ...(await original<typeof import("@knowledge-base/api/lib/kb/git-rollup")>()),
  acknowledgeGitRollup: state.acknowledge,
  measureGitRollup: state.measure,
  recoverGitRollup: state.recover,
  rollupGitObjects: state.roll,
  gitRollupState: state.diskState,
}));
const { MutationScope } = await import("@knowledge-base/api/lib/kb/lock");
const { gitRollupRetry, handleKbGitRollupJob } = await import("./kb-git-rollup");
const job = { id: "rollup-1", data: { reason: "cron" } } as unknown as Job<KbGitRollupJobData>;
const settings = new Map<string, string>();
let kbs: { id: string }[], phase: string, active: boolean;
const query = vi.fn(async (sql: string, values: unknown[] = []) => {
  const key = String(values[0]);
  if (sql.startsWith("SELECT value"))
    return { rows: settings.has(key) ? [{ value: settings.get(key) }] : [] };
  if (sql.startsWith('SELECT id FROM "knowledge_base"')) return { rows: kbs };
  if (sql.startsWith("SELECT state")) return { rows: [{ state: active ? "ACTIVE" : "DELETING" }] };
  if (sql.startsWith('SELECT id FROM "quota_reservation"')) return { rows: [] };
  if (sql.startsWith('INSERT INTO "app_setting"')) settings.set(key, String(values[1]));
  else if (sql.startsWith('DELETE FROM "app_setting" WHERE key = $1')) settings.delete(key);
  else throw new Error(`unexpected SQL: ${sql}`);
  return { rows: [] };
});
function history() {
  return JSON.parse(settings.get("kb.git-rollup.kb1") ?? "null");
}
beforeEach(() => {
  vi.clearAllMocks();
  state.root = "/unused";
  settings.clear();
  phase = "none";
  active = true;
  kbs = [{ id: "kb1" }];
  state.checkout.mockImplementation(async ({ scope }) => ({ query, scope, close: vi.fn() }));
  state.run.mockImplementation(async (options) => {
    const scope = new MutationScope(options.opId, Date.now, options.mutationDeadlineAt);
    try {
      return await options.run({ query, scope });
    } finally {
      scope.dispose();
    }
  });
  state.measure.mockResolvedValue({ level: 8, packs: [], looseSample: 0, due: true });
  state.diskState.mockImplementation(async () => phase);
  state.recover.mockImplementation(async () => {
    const completed = phase !== "unprepared";
    phase = "none";
    return completed;
  });
  state.roll.mockResolvedValue(true);
  state.reserve.mockResolvedValue({ reservationIds: ["disk"] });
  state.release.mockResolvedValue(undefined);
  state.acknowledge.mockImplementation(async () => {
    phase = "none";
  });
});
describe("scheduled Git rollup", () => {
  it("maintains real objects behind oversized retained inputs across firings and publication", async () => {
    const actual = await vi.importActual<typeof import("@knowledge-base/api/lib/kb/git-rollup")>(
      "@knowledge-base/api/lib/kb/git-rollup",
    );
    const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    // Exercise the real pack protocol without making drive journal latency part
    // of this scheduler regression. The integration suite retains real fsyncs.
    const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await realFs.open(...args);
      vi.spyOn(file, "sync").mockResolvedValue(undefined);
      return file;
    });
    state.root = mkdtempSync(join(tmpdir(), "kb-rollup-scheduled-"));
    const root = state.root;
    let largeName = "";
    // Directory order is unspecified. Always enumerate the real oversized file
    // first so this regression exercises the poisoned-prefix case on every FS.
    const directories = vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const dir = await realFs.opendir(...args);
      if (!String(args[0]).endsWith("/objects/17")) return dir;
      const entries: Dirent[] = [];
      for await (const entry of dir) entries.push(entry);
      entries.sort((a, b) => Number(b.name === largeName) - Number(a.name === largeName));
      return Object.assign(dir, {
        async *[Symbol.asyncIterator]() {
          yield* entries;
        },
      });
    });
    kbs = [{ id: "kb1" }, { id: "kb2" }];
    const repos = kbs.map((kb) => kbBareRepoPath(kbDataPaths(root).reposDir, kb.id));
    const git = (repo: string, args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: hardenedGitEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    state.measure.mockImplementation(actual.measureGitRollup);
    state.diskState.mockImplementation(actual.gitRollupState);
    state.roll.mockImplementation(actual.rollupGitObjects);
    state.recover.mockImplementation(actual.recoverGitRollup);
    state.acknowledge.mockImplementation(actual.acknowledgeGitRollup);
    try {
      for (const repo of repos) {
        await fs.mkdir(repo, { recursive: true });
        git(repo, ["init", "--bare", "--template="]);
      }
      const repo = repos[0]!;
      const large = writeGitFixtureLooseBlob(
        repo,
        createHash("shake256", { outputLength: 17 << 20 })
          .update("oversized retained fixture")
          .digest(),
        "17",
      );
      largeName = large.objectSha.slice(2);
      const largePath = join(repo, "objects/17", large.objectSha.slice(2));
      expect(statSync(largePath).size).toBeGreaterThan(actual.GIT_ROLLUP.maxLooseBytes);
      const heads: string[] = [];
      for (let pass = 0; pass < 2; pass++) {
        const head = writeGitFixtureCommit(repo, {
          parentSha: heads.at(-1) ?? "0".repeat(40),
          message: `Publication ${pass}`,
          files: [{ segments: ["doc.md"], content: Buffer.from(`# Publication ${pass}\n`) }],
        });
        git(repo, ["update-ref", "refs/heads/main", head, heads.at(-1) ?? "0".repeat(40)]);
        heads.push(head);
        const small = Array.from({ length: 27 }, (_, i) =>
          writeGitFixtureLooseBlob(repo, Buffer.from(`publication ${pass}/${i}`), "17"),
        );
        const dir = await fs.opendir(join(repo, "objects/17"));
        const order: string[] = [];
        for await (const entry of dir) order.push(entry.name);
        expect(order[0]).toBe(large.objectSha.slice(2));
        const sibling = Array.from(
          { length: 8 },
          (_, i) =>
            writeGitFixtureBlobPack(repos[1]!, Buffer.from(`sibling ${pass}/${i}`)).objectSha,
        );
        expect((await actual.measureGitRollup(repo, {})).looseSample).toBeGreaterThanOrEqual(27);
        expect(await handleKbGitRollupJob(job)).toEqual({ count: 2 });
        for (const blob of small) {
          expect(existsSync(join(repo, "objects/17", blob.objectSha.slice(2)))).toBe(false);
          expect(git(repo, ["cat-file", "blob", blob.objectSha])).toEqual(blob.body);
        }
        for (const [i, sha] of sibling.entries())
          expect(git(repos[1]!, ["cat-file", "blob", sha]).toString()).toBe(`sibling ${pass}/${i}`);
        expect(existsSync(largePath)).toBe(true);
        expect(await actual.measureGitRollup(repo, {})).toMatchObject({
          looseSample: 0,
          due: false,
        });
        const folds = state.roll.mock.calls.length;
        const reservations = state.reserve.mock.calls.length;
        for (let idle = 0; idle < 3; idle++)
          expect(await handleKbGitRollupJob(job)).toEqual({ count: 0 });
        expect(state.roll).toHaveBeenCalledTimes(folds);
        expect(state.reserve).toHaveBeenCalledTimes(reservations);
        for (const [i, head] of heads.entries())
          expect(git(repo, ["show", `${head}:doc.md`]).toString()).toBe(`# Publication ${i}\n`);
      }
      // fsck verifies the retained payload without buffering another 17 MiB
      // copy through the test's small-output command wrapper.
      expect(git(repo, ["cat-file", "-s", large.objectSha]).toString().trim()).toBe(
        String(large.body.length),
      );
      for (const repo of repos) git(repo, ["fsck", "--full", "--no-dangling"]);
    } finally {
      directories.mockRestore();
      opened.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("bounds page SQL and reuses deadline-aware KB SQL with no Prisma checkout", async () => {
    expect(await handleKbGitRollupJob(job)).toEqual({ count: 1 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY id LIMIT $2"), ["", 16]);
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "kb-write", kbIds: ["kb1"], lockWaitMs: 250 }),
    );
    expect(settings.get("kb.git-rollup.cursor")).toBe("kb1");
    expect(history()).toBeNull();
    expect(state.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      expect.objectContaining({
        heldForPublication: true,
        charges: [],
        disks: [expect.objectContaining({ bytes: BigInt(96 << 20) })],
      }),
    );
    active = false;
    await handleKbGitRollupJob(job);
    expect(state.roll).toHaveBeenCalledTimes(1);
  });
  it("spaces retries by pressure or time without shrinking the cap", () => {
    const previous = { level: 8, failures: 1, retryAt: 1000 };
    expect(gitRollupRetry(previous, 15, 999)).toEqual({ allowed: false, maxBytes: 32 << 20 });
    expect(gitRollupRetry(previous, 16, 999).allowed).toBe(true);
    expect(gitRollupRetry(previous, 8, 1000).allowed).toBe(true);
  });
  it("counts only real failed folds, spaces them, and continues with siblings", async () => {
    kbs.push({ id: "kb2" });
    state.roll.mockRejectedValueOnce(new Error("canary must never be logged"));
    const log = captureLog();
    try {
      expect(await handleKbGitRollupJob(job)).toEqual({ count: 1 });
      expect(history()).toMatchObject({ failures: 1, cleanup: false });
      for (let i = 0; i < 3; i++) await handleKbGitRollupJob(job);
      expect(state.roll).toHaveBeenCalledTimes(5); // kb1 once; kb2 every pass
      expect(JSON.stringify(log.records)).not.toContain("canary");
      settings.set("kb.git-rollup.kb1", JSON.stringify({ ...history(), retryAt: 0 }));
      await handleKbGitRollupJob(job);
      expect(history()).toBeNull();
    } finally {
      log.restore();
    }
  });
  it("repeated graceful cancellation before preparation never charges a failure or blocks a healthy pass", async () => {
    const cancelled = Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    for (let i = 0; i < 3; i++) {
      state.roll.mockRejectedValueOnce(cancelled);
      await handleKbGitRollupJob(job);
      expect(history()).toBeNull();
    }
    expect(await handleKbGitRollupJob(job)).toEqual({ count: 1 });
    expect(state.roll).toHaveBeenCalledTimes(4);
  });
  it("restores prior failure history after a scope expires and scratch was gracefully removed", async () => {
    state.run.mockImplementationOnce(async (options) => {
      const scope = new MutationScope(options.opId);
      state.roll.mockImplementationOnce(async () => {
        scope.cancel(new Error("shutdown"));
        throw scope.signal.reason;
      });
      try {
        return await options.run({ query, scope });
      } finally {
        scope.dispose();
      }
    });
    await handleKbGitRollupJob(job);
    expect(history()).toMatchObject({ failures: 0, attempt: true });
    state.roll.mockResolvedValue(true);
    expect(await handleKbGitRollupJob(job)).toEqual({ count: 1 });
    expect(history()).toBeNull();
  });
  it.each(["installed", "done", "prepared"])(
    "recovers %s without repacking and counts only pre-install fold failures",
    async (remaining) => {
      const failures = remaining === "prepared" ? 1 : 0;
      state.roll.mockImplementationOnce(async () => {
        phase = remaining;
        throw new Error("retirement blocked");
      });
      await handleKbGitRollupJob(job);
      expect(history()).toMatchObject({ failures, cleanup: true });
      expect(state.release).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i++) await handleKbGitRollupJob(job);
      expect(state.recover).not.toHaveBeenCalled();
      settings.set("kb.git-rollup.kb1", JSON.stringify({ ...history(), retryAt: 0 }));
      state.recover.mockRejectedValueOnce(new Error("cleanup still blocked"));
      await handleKbGitRollupJob(job);
      expect(history()).toMatchObject({ failures, cleanup: true });
      settings.set("kb.git-rollup.kb1", JSON.stringify({ ...history(), retryAt: 0 }));
      expect(await handleKbGitRollupJob(job)).toEqual({ count: 1 });
      expect(state.roll).toHaveBeenCalledTimes(1);
      expect(history()).toBeNull();
    },
  );
  it("keeps SQL settlement and disposal errors out of fold-failure classification", async () => {
    settings.set("kb.git-rollup.kb1", JSON.stringify({ level: 1, failures: 2, retryAt: 0 }));
    state.roll.mockImplementationOnce(async () => {
      phase = "done";
      return true;
    });
    state.release.mockRejectedValueOnce(new Error("settlement unavailable"));
    await handleKbGitRollupJob(job);
    expect(history()).toMatchObject({ failures: 2, attempt: true });
    expect(await handleKbGitRollupJob(job)).toEqual({ count: 1 });
    expect(history()).toBeNull();
    expect(state.roll).toHaveBeenCalledTimes(1);
    state.acknowledge.mockImplementationOnce(async () => {
      phase = "none";
      throw new Error("directory sync failed after disposal");
    });
    await handleKbGitRollupJob(job);
    expect(history()).toBeNull();
  });
  it("restores the exact prior failure history after graceful scope interruption", async () => {
    const prior = { level: 1, failures: 2, retryAt: 0 };
    settings.set("kb.git-rollup.kb1", JSON.stringify(prior));
    state.run.mockImplementationOnce(async (options) => {
      const scope = new MutationScope(options.opId);
      state.roll.mockImplementationOnce(async () => {
        scope.cancel(new Error("shutdown"));
        throw scope.signal.reason;
      });
      try {
        return await options.run({ query, scope });
      } finally {
        scope.dispose();
      }
    });
    await handleKbGitRollupJob(job);
    state.measure.mockResolvedValue({ level: 8, due: false });
    await handleKbGitRollupJob(job);
    expect(history()).toEqual(prior);
  });

  it("spaces an unprepared crash without inventing a failed fold", async () => {
    phase = "unprepared";
    settings.set(
      "kb.git-rollup.kb1",
      JSON.stringify({ level: 8, failures: 0, retryAt: Date.now() + 300000, attempt: true }),
    );
    await handleKbGitRollupJob(job);
    expect(state.recover).not.toHaveBeenCalled();
    settings.set("kb.git-rollup.kb1", JSON.stringify({ ...history(), retryAt: 0 }));
    await handleKbGitRollupJob(job);
    expect(history()).toBeNull();
    expect(await handleKbGitRollupJob(job)).toEqual({ count: 1 });
  });
  it("retains prior failed-fold history when crash recovery only discards unprepared scratch", async () => {
    const prior = { level: 1, failures: 2, retryAt: 0 };
    phase = "unprepared";
    settings.set(
      "kb.git-rollup.kb1",
      JSON.stringify({ level: 8, failures: 2, retryAt: 0, attempt: true, prior }),
    );
    await handleKbGitRollupJob(job);
    expect(history()).toEqual(prior);
    expect(state.roll).not.toHaveBeenCalled();
  });

  it("wraps exhausted cursors and refuses unknown payloads", async () => {
    settings.set("kb.git-rollup.cursor", "kb9");
    kbs = [];
    await handleKbGitRollupJob(job);
    expect(settings.has("kb.git-rollup.cursor")).toBe(false);
    await expect(
      handleKbGitRollupJob({ ...job, data: { reason: "other" } } as never),
    ).rejects.toThrow();
  });
});
