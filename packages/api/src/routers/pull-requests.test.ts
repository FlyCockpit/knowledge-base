import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { Context } from "../context";
import { prFileAttribution } from "../lib/kb/document-history";
import { authorizeDocumentRead } from "../lib/kb/documents-read";
import { getPullRequest, listPullRequests, mutatePullRequest } from "../lib/kb/pull-requests";
import { pullRequestsRouter } from "./pull-requests";

vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
vi.mock("../lib/kb/pull-requests", () => ({
  listPullRequests: vi.fn(),
  getPullRequest: vi.fn(),
  mutatePullRequest: vi.fn(),
}));
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({ prisma: {}, reposDir: "/repos" }) }));
vi.mock("../lib/kb/document-history", () => ({ prFileAttribution: vi.fn() }));
vi.mock("../lib/kb/actors", () => ({ resolveActors: vi.fn(async () => new Map()) }));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => async () => {} }));
vi.mock("../lib/kb/documents-read", () => ({ authorizeDocumentRead: vi.fn(async () => {}) }));
const kbId = "a".repeat(24);
function client(loggedIn = true) {
  const session = mockDeep<NonNullable<Context["session"]>>();
  session.user.id = "reader";
  session.user.twoFactorEnabled = true;
  session.user.banned = false;
  return createRouterClient(pullRequestsRouter, {
    context: () => ({ session: loggedIn ? session : null }),
  });
}
beforeEach(() => vi.clearAllMocks());
it("requires login on PR reads", async () => {
  await expect(client(false).list({ kbId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(listPullRequests).not.toHaveBeenCalled();
});
it("returns the bounded empty list", async () => {
  vi.mocked(listPullRequests).mockResolvedValue({ items: [], nextCursor: null });
  expect(await client().list({ kbId })).toEqual({ items: [], nextCursor: null });
});
it("rejects unmatched confirm and excessive limits before domain effects", async () => {
  await expect(
    client().review({
      kbId,
      number: 1,
      decision: "merge",
      confirm: "CLOSE",
      expectedHeadSha: "a".repeat(40),
      expectedTargetSha: "b".repeat(40),
      idempotencyKey: "review-request-key",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(client().list({ kbId, limit: 51 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(mutatePullRequest).not.toHaveBeenCalled();
});
it("a review CONFLICT carries structured details; other errors carry only the code", async () => {
  const { PrConflictError } = await import("../lib/kb/pr-conflict");
  const { KbDomainError } = await import("../lib/kb/errors");
  const review = {
    kbId,
    number: 1,
    decision: "merge" as const,
    confirm: "MERGE" as const,
    expectedHeadSha: "a".repeat(40),
    expectedTargetSha: "b".repeat(40),
    idempotencyKey: "review-request-key",
  };
  const cases = [
    {
      thrown: new PrConflictError(
        "Reviewed revision changed",
        {
          kind: "revision_moved",
          targetMoved: true,
          headMoved: false,
          currentTargetSha: "c".repeat(40),
          currentHeadSha: "a".repeat(40),
        },
        { headSha: "a".repeat(40), proposalNumber: 1 },
      ),
      data: {
        code: "CONFLICT",
        conflict: {
          kind: "revision_moved",
          targetMoved: true,
          headMoved: false,
          currentTargetSha: "c".repeat(40),
          currentHeadSha: "a".repeat(40),
        },
      },
    },
    {
      thrown: new PrConflictError("This pull request conflicts with main.", {
        kind: "content_conflict",
      }),
      data: { code: "CONFLICT", conflict: { kind: "content_conflict" } },
    },
    {
      thrown: new PrConflictError("Reviewed revision changed", { kind: "state_changed" }),
      data: { code: "CONFLICT", conflict: { kind: "state_changed" } },
    },
    // An unclassified CONFLICT and a non-conflict error forward no details.
    {
      thrown: new KbDomainError("CONFLICT", "Publication was not completed"),
      data: { code: "CONFLICT" },
    },
    { thrown: new KbDomainError("FORBIDDEN", "Forbidden"), data: { code: "FORBIDDEN" } },
  ];
  for (const { thrown, data } of cases) {
    vi.mocked(mutatePullRequest).mockRejectedValueOnce(thrown);
    const error = await client()
      .review(review)
      .catch((e: unknown) => e);
    expect((error as { data?: unknown }).data).toEqual(data);
  }
});
it("adds each Markdown file's labels and writer to the browser's PR page only", async () => {
  const sha = (c: string) => c.repeat(40);
  const files = [
    { path: "a.md", status: "modified", beforeBlobSha: sha("1"), afterBlobSha: sha("2") },
    { path: "x.png", status: "added", beforeBlobSha: null, afterBlobSha: sha("3") },
  ];
  vi.mocked(getPullRequest).mockResolvedValue({
    pr: { number: 1, authorActorKey: "user:reader", baseSha: sha("a"), headSha: sha("b") },
    files,
    touchedAssets: [],
    nextCursor: null,
  } as unknown as Awaited<ReturnType<typeof getPullRequest>>);
  vi.mocked(prFileAttribution).mockResolvedValue(
    new Map([
      [
        "a.md",
        {
          beforeProvenance: "human",
          afterProvenance: "agent",
          writtenBy: { kind: "unattributed", name: null, via: null },
        },
      ],
    ]),
  );
  const page = await client().get({ kbId, number: 1 });
  expect(vi.mocked(prFileAttribution).mock.calls[0]?.[0]).toMatchObject({
    repoPath: expect.stringContaining(kbId),
    baseSha: sha("a"),
    headSha: sha("b"),
    files,
  });
  expect(page.files).toEqual([
    {
      ...files[0],
      beforeProvenance: "human",
      afterProvenance: "agent",
      writtenBy: { kind: "unattributed", name: null, via: null },
    },
    { ...files[1], beforeProvenance: null, afterProvenance: null, writtenBy: null },
  ]);
});
it("never reads attribution for a PR the viewer cannot read", async () => {
  const { KbDomainError } = await import("../lib/kb/errors");
  vi.mocked(getPullRequest).mockRejectedValue(new KbDomainError("FORBIDDEN", "no"));
  await expect(client().get({ kbId, number: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(prFileAttribution).not.toHaveBeenCalled();
});
it("rechecks live read after the author and attribution reads, before publishing them", async () => {
  const { KbDomainError } = await import("../lib/kb/errors");
  const sha = (c: string) => c.repeat(40);
  vi.mocked(getPullRequest).mockResolvedValue({
    pr: { number: 1, authorActorKey: "grant:g", baseSha: sha("a"), headSha: sha("b") },
    files: [],
    touchedAssets: [],
    nextCursor: null,
  } as unknown as Awaited<ReturnType<typeof getPullRequest>>);
  vi.mocked(prFileAttribution).mockResolvedValue(new Map());
  // Access revoked while the attribution was read: nothing is published.
  vi.mocked(authorizeDocumentRead).mockRejectedValueOnce(new KbDomainError("FORBIDDEN", "gone"));
  await expect(client().get({ kbId, number: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(vi.mocked(authorizeDocumentRead).mock.invocationCallOrder[0]).toBeGreaterThan(
    vi.mocked(prFileAttribution).mock.invocationCallOrder[0]!,
  );
  vi.mocked(listPullRequests).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(authorizeDocumentRead).mockRejectedValueOnce(new KbDomainError("FORBIDDEN", "gone"));
  await expect(client().list({ kbId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  // A credential author is labelled by its key, whatever its name.
  vi.mocked(getPullRequest).mockResolvedValue({
    pr: { number: 1, authorActorKey: "grant:g", baseSha: sha("a"), headSha: sha("b") },
    files: [],
    touchedAssets: [],
    nextCursor: null,
  } as unknown as Awaited<ReturnType<typeof getPullRequest>>);
  expect((await client().get({ kbId, number: 1 })).pr.author.kind).toBe("credential");
});
