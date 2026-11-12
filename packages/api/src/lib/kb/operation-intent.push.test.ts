import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LockQuery } from "./lock";
import { reconcileKbIntents, settleAbortedIntentQuota } from "./operation-intent";

const mocks = vi.hoisted(() => ({
  retained: vi.fn(() => 40),
  release: vi.fn(async () => {}),
  commit: vi.fn(async () => {}),
  releaseCommitted: vi.fn(async () => {}),
}));
vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/queue", () => ({}));
vi.mock("./audit", () => ({ admitSecurityEvent: () => false }));
vi.mock("./git-read", () => ({ kbBareRepoPath: () => "/repo", readHeadSha: () => "a".repeat(40) }));
vi.mock("./git-write", () => ({ removeAbandonedPublicationLocks: () => {} }));
vi.mock("./push-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./push-validation")>()),
  retainedPushObjectBytes: mocks.retained,
}));
vi.mock("./quota", () => ({
  releaseQuota: mocks.release,
  commitQuota: mocks.commit,
  releaseCommittedCharge: mocks.releaseCommitted,
}));

const objectFiles = [{ path: `ab/${"c".repeat(38)}`, bytes: 100 }];
const push = () => ({
  kind: "git_push",
  headSha: "b".repeat(40),
  refName: "refs/heads/main",
  newBranch: false,
  quotaReservationIds: ["history", "disk"],
  objectFiles,
});
const history = [{ id: "history", amount: "100", subjectId: "kb" }];
const queryWithHistory = () => vi.fn(async () => ({ rows: history, rowCount: 1 }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.retained.mockReturnValue(40);
});

describe("aborted push settlement", () => {
  it("charges only retained inventoried objects when the repository can be inspected", async () => {
    const query = queryWithHistory();
    await settleAbortedIntentQuota(query as LockQuery, push(), "/repo");
    expect(mocks.retained).toHaveBeenCalledWith("/repo", objectFiles);
    expect(mocks.release).toHaveBeenCalledWith({ transactionQuery: query }, ["disk"]);
    expect(mocks.commit).toHaveBeenCalledWith({ transactionQuery: query }, ["history"]);
    expect(mocks.releaseCommitted).toHaveBeenCalledWith(
      { transactionQuery: query },
      expect.objectContaining({ amount: 60n, subjectId: "kb" }),
    );
  });

  it("keeps the full history charge on tombstone without a repository path", async () => {
    const query = queryWithHistory();
    await settleAbortedIntentQuota(query as LockQuery, push());
    expect(mocks.retained).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith({ transactionQuery: query }, ["disk"]);
    expect(mocks.commit).toHaveBeenCalledWith({ transactionQuery: query }, ["history"]);
    expect(mocks.releaseCommitted).not.toHaveBeenCalled();
  });

  it("releases all reservations when none of the inventoried objects remain", async () => {
    mocks.retained.mockReturnValue(0);
    const query = queryWithHistory();
    await settleAbortedIntentQuota(query as LockQuery, push(), "/repo");
    expect(mocks.release).toHaveBeenCalledWith({ transactionQuery: query }, ["history", "disk"]);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("accepts the empty inventory on an uncharged draft", async () => {
    const query = queryWithHistory();
    await settleAbortedIntentQuota(
      query as LockQuery,
      { ...push(), objectFiles: [], quotaReservationIds: [] },
      "/repo",
    );
    expect(query).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    [{ path: "../escape", bytes: 100 }],
    [{ ...objectFiles[0], bytes: -1 }],
  ])(
    "refuses malformed inventory %j before any settlement, even without a repo path",
    async (inventory) => {
      for (const repoPath of [undefined, "/repo"]) {
        const query = queryWithHistory();
        await expect(
          settleAbortedIntentQuota(
            query as LockQuery,
            { ...push(), objectFiles: inventory },
            repoPath,
          ),
        ).rejects.toMatchObject({ code: "REPAIR_REQUIRED" });
        expect(query).not.toHaveBeenCalled();
      }
      expect(mocks.release).not.toHaveBeenCalled();
      expect(mocks.commit).not.toHaveBeenCalled();
    },
  );
});

describe("push recovery", () => {
  it.each([
    { ...push(), objectFiles: undefined },
    { ...push(), objectFiles: [{ path: "../escape", bytes: 100 }] },
    { ...push(), quotaReservationIds: null },
    { ...push(), kind: "changes_apply" },
    null,
  ])("marks malformed journals for repair and holds their reservations", async (preparedDelta) => {
    const calls: string[] = [];
    const query: LockQuery = async <Row>(sql: string) => {
      calls.push(sql);
      const rows = sql.includes('ORDER BY "createdAt"')
        ? [
            {
              opId: "op",
              kbId: "kb",
              phase: "COMMITTING",
              operation: "GIT_PUSH",
              oldRef: "a".repeat(40),
              newRef: "b".repeat(40),
              refName: "refs/heads/main",
              preparedDelta,
            },
          ]
        : sql.includes('SELECT "headSha"')
          ? [{ headSha: "a".repeat(40), state: "ACTIVE" }]
          : [];
      return { rows: rows as Row[], rowCount: rows.length };
    };
    await expect(reconcileKbIntents(query, "/repos", "kb")).resolves.toBe("repair_required");
    expect(calls.some((sql) => sql.includes("REPAIR_REQUIRED"))).toBe(true);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.retained).not.toHaveBeenCalled();
  });
});
