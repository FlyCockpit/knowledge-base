import { describe, expect, it } from "vitest";

import {
  collectDiff,
  conflictOutcome,
  initialReviewMemory,
  type PrPage,
  type PrSummary,
  type ReviewDeps,
  reviewControls,
  reviewReady,
  runReview,
} from "./use-pr-review";

const KB = "a".repeat(24);
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TARGET = "3".repeat(40);
const NEW_HEAD = "4".repeat(40);
const NEW_TARGET = "5".repeat(40);
const MERGE = "6".repeat(40);
const OP = "00000000-0000-4000-8000-0000000000aa";
const AUTHOR = "user:author";

function summary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 7,
    title: "Proposal",
    sourceBranch: "refs/heads/pr/7",
    targetBranch: "main",
    baseSha: BASE,
    headSha: HEAD,
    targetSha: TARGET,
    status: "OPEN",
    authorActorKey: AUTHOR,
    version: 1,
    mergeCommitSha: null,
    ...overrides,
  };
}

function file(i: number) {
  return {
    path: `notes/${String(i).padStart(4, "0")}.md`,
    status: "added" as const,
    beforeBlobSha: null,
    afterBlobSha: "7".repeat(40),
  };
}

/** 205 deltas served as CONTRACT pages of at most 50. */
function pagesOf(total: number, size = 50, pr = summary()): PrPage[] {
  const pages: PrPage[] = [];
  for (let start = 0; start < total; start += size) {
    const end = Math.min(total, start + size);
    pages.push({
      pr,
      files: Array.from({ length: end - start }, (_, k) => file(start + k)),
      touchedAssets: [],
      nextCursor: end < total ? `cursor-${end}` : null,
    });
  }
  return pages;
}

describe("collectDiff", () => {
  it("is null before any page loads (empty/default case)", () => {
    expect(collectDiff([])).toBeNull();
  });

  it(">200 deltas: never complete before the final page, then the full set", () => {
    const pages = pagesOf(205);
    expect(pages).toHaveLength(5);
    for (let loaded = 1; loaded < pages.length; loaded++) {
      const diff = collectDiff(pages.slice(0, loaded))!;
      expect(diff.complete).toBe(false);
      expect(diff.files).toHaveLength(loaded * 50);
      expect(reviewReady(diff, "merge")).toBe(false);
    }
    const all = collectDiff(pages)!;
    expect(all.complete).toBe(true);
    expect(all.drift).toBe(false);
    expect(all.files).toHaveLength(205);
    expect(new Set(all.files.map((f) => f.path)).size).toBe(205);
    expect(reviewReady(all, "merge")).toBe(true);
  });

  it("keeps the first page's exact base/head/target; a later page at other SHAs is drift", () => {
    const [first, second] = pagesOf(60);
    const moved = { ...second!, pr: summary({ headSha: NEW_HEAD }) };
    const diff = collectDiff([first!, moved])!;
    expect(diff.pr.headSha).toBe(HEAD);
    expect(diff.pr.targetSha).toBe(TARGET);
    expect(diff.drift).toBe(true);
    // Rows from a page at other revisions are never merged into the reviewed set.
    expect(diff.files).toHaveLength(50);
    expect(diff.complete).toBe(false);
    expect(reviewReady(diff, "merge")).toBe(false);
    expect(reviewReady(diff, "close")).toBe(false);
  });
});

describe("reviewControls", () => {
  it("propose-only author: close allowed, merge absent", () => {
    const c = reviewControls({
      bits: ["read", "propose"],
      viewerActorKey: AUTHOR,
      pr: summary(),
    });
    expect(c.showMerge).toBe(false);
    expect(c.canMerge).toBe(false);
    expect(c.canClose).toBe(true);
  });

  it("propose-only non-author: neither", () => {
    const c = reviewControls({
      bits: ["read", "propose"],
      viewerActorKey: "user:other",
      pr: summary(),
    });
    expect(c).toEqual({ showMerge: false, canMerge: false, canClose: false, mergeBlocked: false });
  });

  it("review-only: merge and close an OPEN PR", () => {
    const c = reviewControls({ bits: ["read", "review"], viewerActorKey: "user:r", pr: summary() });
    expect(c).toEqual({ showMerge: true, canMerge: true, canClose: true, mergeBlocked: false });
  });

  it("write without review never merges (write does not imply review)", () => {
    const c = reviewControls({
      bits: ["read", "propose", "write"],
      viewerActorKey: "user:w",
      pr: summary(),
    });
    expect(c.showMerge).toBe(false);
  });

  it("the person owns the PR: any of their credentials' PRs are theirs to close", () => {
    const viaToken = summary({
      authorActorKey: "grant:00000000-0000-4000-8000-000000000001",
      author: { name: "Bob Builder", via: "bob-direct", isViewer: true },
    });
    expect(
      reviewControls({ bits: ["read", "propose"], viewerActorKey: AUTHOR, pr: viaToken }).canClose,
    ).toBe(true);
    // Read-only access never closes, even the author's.
    expect(reviewControls({ bits: ["read"], viewerActorKey: AUTHOR, pr: viaToken }).canClose).toBe(
      false,
    );
    const someoneElse = { ...viaToken, author: { ...viaToken.author!, isViewer: false } };
    expect(
      reviewControls({ bits: ["read", "propose"], viewerActorKey: AUTHOR, pr: someoneElse })
        .canClose,
    ).toBe(false);
  });

  it("CONFLICT status cannot be merged; terminal PRs have no actions", () => {
    const bits = ["read", "review"];
    const conflicted = reviewControls({
      bits,
      viewerActorKey: "user:r",
      pr: summary({ status: "CONFLICT" }),
    });
    expect(conflicted.canMerge).toBe(false);
    expect(conflicted.mergeBlocked).toBe(true);
    for (const status of ["MERGED", "CLOSED"] as const)
      expect(reviewControls({ bits, viewerActorKey: "user:r", pr: summary({ status }) })).toEqual({
        showMerge: true,
        canMerge: false,
        canClose: false,
        mergeBlocked: false,
      });
  });
});

type Call = Record<string, unknown>;
function deps(respond: (input: Call) => unknown) {
  const calls: Call[] = [];
  let n = 0;
  const d: ReviewDeps = {
    review: async (input) => {
      calls.push(input);
      const out = respond(input);
      if (out instanceof Error) throw out;
      return out;
    },
    newKey: () => `key-${String(++n).padStart(16, "0")}`,
  };
  return { d, calls };
}
const conflict = (details?: unknown) =>
  Object.assign(new Error("conflicts, update your branch"), {
    code: "CONFLICT",
    data: details === undefined ? { code: "CONFLICT" } : { code: "CONFLICT", conflict: details },
  });
const moved = (targetMoved: boolean, headMoved: boolean) => ({
  kind: "revision_moved",
  targetMoved,
  headMoved,
  currentTargetSha: targetMoved ? NEW_TARGET : TARGET,
  currentHeadSha: headMoved ? NEW_HEAD : HEAD,
});
const network = () => new TypeError("Failed to fetch");

describe("runReview", () => {
  const diff = collectDiff(pagesOf(3))!;

  it("merge submits exactly the displayed head and target with MERGE", async () => {
    const { d, calls } = deps(() => ({
      operationId: OP,
      pr: summary({ status: "MERGED", mergeCommitSha: MERGE, version: 2 }),
    }));
    const run = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" });
    expect(calls).toEqual([
      {
        kbId: KB,
        number: 7,
        decision: "merge",
        confirm: "MERGE",
        expectedHeadSha: HEAD,
        expectedTargetSha: TARGET,
        idempotencyKey: "key-0000000000000001",
      },
    ]);
    expect(run.outcome).toEqual({ kind: "merged", mergeCommitSha: MERGE });
    expect(run.memory).toEqual(initialReviewMemory());
  });

  it("close sends CLOSE", async () => {
    const { d, calls } = deps(() => ({ operationId: OP, pr: summary({ status: "CLOSED" }) }));
    const run = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "close" });
    expect(calls[0]).toMatchObject({ decision: "close", confirm: "CLOSE" });
    expect(run.outcome).toEqual({ kind: "closed" });
  });

  it("base moved (server details): asks for a new diff and never resubmits fresh SHAs", async () => {
    const { d, calls } = deps(() => conflict(moved(true, false)));
    const run = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" });
    expect(run.outcome).toEqual({ kind: "changed", targetMoved: true, headMoved: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ expectedHeadSha: HEAD, expectedTargetSha: TARGET });
    expect(run.memory).toEqual(initialReviewMemory());
  });

  it("head moved and both moved are reported as such", async () => {
    for (const [target, head] of [
      [false, true],
      [true, true],
    ] as const) {
      const { d } = deps(() => conflict(moved(target, head)));
      const run = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "close" });
      expect(run.outcome).toEqual({ kind: "changed", targetMoved: target, headMoved: head });
    }
  });

  it("content conflict (server details) is a real conflict: 'update your branch'", async () => {
    const { d, calls } = deps(() => conflict({ kind: "content_conflict" }));
    const run = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" });
    expect(run.outcome).toEqual({ kind: "conflict" });
    expect(calls).toHaveLength(1);
  });

  it("a PR closed or merged elsewhere is its own outcome", async () => {
    const { d } = deps(() => conflict({ kind: "state_changed" }));
    const run = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" });
    expect(run.outcome).toEqual({ kind: "stateChanged" });
  });

  it("CONFLICT without readable details still invalidates the review (never 'conflict')", async () => {
    for (const details of [undefined, { kind: "mystery" }, "revision_moved", null]) {
      const { d } = deps(() => conflict(details));
      const run = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" });
      expect(run.outcome).toEqual({ kind: "changed", targetMoved: false, headMoved: false });
    }
  });

  it("conflictOutcome reads only the server details, never a refetch", () => {
    expect(conflictOutcome(conflict({ kind: "content_conflict" }))).toEqual({ kind: "conflict" });
    expect(conflictOutcome(conflict(moved(true, true)))).toEqual({
      kind: "changed",
      targetMoved: true,
      headMoved: true,
    });
  });

  it("unknown outcome then retry reuses the key and shows the durable recorded result", async () => {
    let attempt = 0;
    const { d, calls } = deps(() =>
      ++attempt === 1
        ? network()
        : { operationId: OP, pr: summary({ status: "MERGED", mergeCommitSha: MERGE }) },
    );
    const first = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" });
    expect(first.outcome).toEqual({ kind: "retryable" });
    const second = await runReview(d, first.memory, { kbId: KB, diff, decision: "merge" });
    expect(second.outcome).toEqual({ kind: "merged", mergeCommitSha: MERGE });
    expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
  });

  it("a different decision or reviewed revision gets a new key", async () => {
    const { d, calls } = deps(() => network());
    const first = await runReview(d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" });
    await runReview(d, first.memory, { kbId: KB, diff, decision: "close" });
    expect(calls[0]!.idempotencyKey).not.toBe(calls[1]!.idempotencyKey);
  });

  it("an incomplete or drifted diff is never submitted", async () => {
    const { d, calls } = deps(() => ({ operationId: OP, pr: summary() }));
    const partial = collectDiff(pagesOf(205).slice(0, 2))!;
    const run = await runReview(d, initialReviewMemory(), {
      kbId: KB,
      diff: partial,
      decision: "merge",
    });
    expect(run.outcome).toEqual({ kind: "incomplete" });
    expect(calls).toHaveLength(0);
  });

  it("FORBIDDEN is reported, malformed success is an error", async () => {
    const forbidden = deps(() => Object.assign(new Error("x"), { data: { code: "FORBIDDEN" } }));
    expect(
      (await runReview(forbidden.d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" }))
        .outcome,
    ).toEqual({ kind: "forbidden" });
    const junk = deps(() => ({ ok: true }));
    expect(
      (await runReview(junk.d, initialReviewMemory(), { kbId: KB, diff, decision: "merge" }))
        .outcome,
    ).toEqual({ kind: "error" });
  });
});
