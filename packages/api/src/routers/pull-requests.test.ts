import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { Context } from "../context";
import { listPullRequests, mutatePullRequest } from "../lib/kb/pull-requests";
import { pullRequestsRouter } from "./pull-requests";

vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
vi.mock("../lib/kb/pull-requests", () => ({
  listPullRequests: vi.fn(),
  getPullRequest: vi.fn(),
  mutatePullRequest: vi.fn(),
}));
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({ prisma: {} }) }));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => async () => {} }));
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
