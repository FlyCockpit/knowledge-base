import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@knowledge-base/db/client";
import type { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import { createCursorSigner, stableFilterHash } from "./cursor";
import { gitFixtureTests } from "./fixtures/git-fixture";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv, kbBareRepoPath } from "./git-read";
import * as gitWrite from "./git-write";
import { initialMainTreeFiles } from "./git-write";
import { HeldLockLease, type LockQuery } from "./lock";
import type { IntentRow } from "./operation-intent";
import type { LiveAuthorityStore } from "./permissions";
import { PrConflictError } from "./pr-conflict";
import { planReviewedMerge } from "./pr-merge";
import type { CredentialVerifier, TokenPrincipal } from "./principal";
import { mergeabilityKey, type PullRequestRow } from "./proposals";
import {
  assertReviewPermission,
  createPullRequestPublication,
  getPullRequest,
  listPullRequests,
  proposalMergeStatus,
} from "./pull-requests";
import { setKbRecoveryComplete } from "./recovery";
import type { TreeFileInput } from "./staged-tree";

vi.mock("@knowledge-base/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@knowledge-base/queue", () => ({}));
vi.mock("./quota", async (original) => ({
  ...(await original<typeof import("./quota")>()),
  reserveQuota: vi.fn<typeof import("./quota").reserveQuota>(async (_context, input) => ({
    opId: input.opId,
    reservationIds: [],
    charges: [...input.charges],
  })),
  releaseQuota: vi.fn(async () => {}),
}));

afterEach(() => vi.restoreAllMocks());

const store: LiveAuthorityStore = {
  loadKb: async () => ({ id: "a".repeat(24), ownerId: "owner", state: "ACTIVE" }),
  loadShare: async () => ({ bits: ["read"], revokedAt: null }),
  loadIdentity: async () => ({ banned: false, twoFactorSatisfied: true, instanceEnabled: true }),
};

describe("PR permission matrix", () => {
  it("propose author can close but neither propose nor write may merge", () => {
    expect(() => assertReviewPermission(["read", "propose"], true, "close")).not.toThrow();
    for (const bits of [
      ["read", "propose"],
      ["read", "propose", "write"],
    ] as const) {
      expect(() => assertReviewPermission(bits, true, "merge")).toThrow();
    }
    expect(() => assertReviewPermission(["read", "propose"], false, "close")).toThrow();
    // A read-only credential of the author cannot close.
    expect(() => assertReviewPermission(["read"], true, "close")).toThrow();
  });
  it("review alone admits merge and close, without adding write", () => {
    for (const decision of ["merge", "close"] as const)
      expect(() => assertReviewPermission(["read", "review"], false, decision)).not.toThrow();
  });
  it("empty list changes nothing, is bounded and reauthorizes before reply", async () => {
    setKbRecoveryComplete(true);
    const calls: string[] = [];
    const query: LockQuery = async <Row>(sql: string) => {
      calls.push(sql);
      return { rows: [] as Row[], rowCount: 0 };
    };
    const loadIdentity = vi.fn(store.loadIdentity);
    const result = await listPullRequests(
      {
        query,
        store: { ...store, loadIdentity },
        principal: { kind: "browser", userId: "reader" },
        cursorSigner: createCursorSigner(Buffer.alloc(32, 7)),
        reposDir: "/unused",
      },
      { kbId: "a".repeat(24) },
    );
    expect(result).toEqual({ items: [], nextCursor: null });
    // One bounded page read, then the main snapshot (none yet: nothing to recheck).
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/LIMIT/);
    expect(calls[1]).toMatch(/FROM knowledge_base WHERE id=\$1/);
    for (const sql of calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(loadIdentity).toHaveBeenCalledTimes(2);
  });
});

describe("PR merge rollback cleanup", () => {
  const kbId = "a".repeat(24);
  const test = gitFixtureTests("kb-pr-rollback-", (reposDir) => {
    const repo = kbBareRepoPath(reposDir, kbId);
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const files = initialMainTreeFiles("Merge rollback fixture");
    const baseSha = writeGitFixtureCommit(repo, {
      parentSha: "0".repeat(40),
      message: "base",
      files,
    });
    const commit = (path: string) =>
      writeGitFixtureCommit(repo, {
        parentSha: baseSha,
        message: path,
        files: [...files, { segments: [path], content: Buffer.from(`# ${path}\n`) }],
      });
    const mainSha = commit("main.md");
    const headSha = commit("proposal.md");
    for (const [ref, sha] of [
      ["refs/heads/main", mainSha],
      ["refs/heads/proposals/1", headSha],
    ] as const)
      execFileSync("git", ["--git-dir", repo, "update-ref", ref, sha], {
        env: hardenedGitEnv(),
      });
    return { reposDir, repo, baseSha, mainSha, headSha };
  });

  function context(
    f: { reposDir: string; baseSha: string; mainSha: string; headSha: string },
    failure:
      | "before-commit"
      | "server-commit"
      | "lost-commit"
      | "unknown-commit"
      | "rollback-failed"
      | "callback",
  ) {
    const state: { intent: IntentRow | null; loaded: boolean } = { intent: null, loaded: false };
    const serverError = Object.assign(new Error("merge transaction rejected"), { code: "40001" });
    const row: PullRequestRow = {
      kbId,
      number: 1,
      // Distinct commits keep uncertain outcomes from being reused by the next case.
      title: `Proposal ${failure}`,
      sourceBranch: "refs/heads/proposals/1",
      targetBranch: "main",
      baseSha: f.baseSha,
      headSha: f.headSha,
      targetSha: f.mainSha,
      status: "OPEN",
      version: 1,
      mergeCommitSha: null,
      authorActorKey: "user:owner",
      isAutoPr: false,
      dreamMetadata: null,
      mergeCheckedSha: f.mainSha,
    };
    const query = vi.fn<LockQuery>().mockImplementation(async (sql, values = []) => {
      if (sql.startsWith("SET statement_timeout") && state.loaded && failure === "before-commit")
        throw serverError;
      if (sql === "COMMIT" && state.loaded) {
        if (failure === "lost-commit")
          throw Object.assign(new Error("connection lost after COMMIT"), { code: "ECONNRESET" });
        if (failure === "unknown-commit") throw new Error("client failed after COMMIT");
        throw serverError;
      }
      if (sql === "ROLLBACK" && state.loaded && failure === "rollback-failed")
        throw new Error("rollback failed");
      if (/^(SET |BEGIN$|COMMIT$|ROLLBACK$|SELECT pg_advisory_unlock_all)/.test(sql))
        return { rows: [], rowCount: 0 };
      if (sql.includes('FROM "user"'))
        return {
          rows: [
            {
              id: "owner",
              name: "Owner",
              banned: false,
              twoFactorEnabled: true,
              role: "user",
              createdAt: new Date(),
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('FROM "knowledge_base"'))
        return {
          rows: [{ id: kbId, ownerId: "owner", state: "ACTIVE", headSha: f.mainSha }],
          rowCount: 1,
        };
      if (sql.includes('FROM "pull_request"')) return { rows: [row], rowCount: 1 };
      if (sql.includes('INSERT INTO "operation_intent"')) {
        state.intent = {
          opId: String(values[0]),
          kbId,
          reservedKbId: null,
          actorKey: String(values[2]),
          actorUserIdSnapshot: "owner",
          actorUserId: "owner",
          operation: "PR_MERGE",
          idempotencyKey: String(values[6]),
          requestHash: String(values[7]),
          phase: "PREPARED",
          refName: String(values[8]),
          oldRef: String(values[9]),
          newRef: String(values[10]),
          preparedDelta: JSON.parse(String(values[11])),
          responseBody: null,
          resultRevision: null,
          resultStatus: null,
          publishNonce: String(values[12]),
          abortReason: null,
        };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM "operation_intent"')) {
        const matched = state.intent && sql.includes('"actorKey" = $1');
        if (matched) state.loaded = true;
        return { rows: matched ? [state.intent] : [], rowCount: matched ? 1 : 0 };
      }
      throw new Error(`Unexpected fixture SQL: ${sql}`);
    });
    const client = mockDeep<Client>();
    client.query.mockImplementation(
      (
        statement: string | { text: string; values?: unknown[]; queryMode: "extended" },
        values?: unknown[],
      ) =>
        query(
          typeof statement === "string" ? statement : statement.text,
          typeof statement === "string" ? values : statement.values,
        ),
    );
    const lease = new HeldLockLease({
      client,
      opId: "pr-merge-test",
      backendPid: 1,
      abort: new AbortController(),
    });
    vi.spyOn(lease, "assertHeldKb").mockImplementation(() => {});
    const input = {
      reposDir: f.reposDir,
      store,
      principal: { kind: "browser" as const, userId: "owner" },
      diskMeter: { freeBytes: async () => 10n ** 12n },
      request: {
        kind: "review" as const,
        kbId,
        number: 1,
        decision: "merge" as const,
        expectedHeadSha: f.headSha,
        expectedTargetSha: f.mainSha,
        idempotencyKey: `merge-test-${failure}`,
        confirm: "MERGE" as const,
      },
    };
    return { input, lease, query, serverError };
  }

  for (const failure of [
    "before-commit",
    "server-commit",
    "lost-commit",
    "unknown-commit",
    "rollback-failed",
    "callback",
  ] as const) {
    test(`reclaims only operation-owned objects with definite rollback: ${failure}`, async (f) => {
      const { input, lease, query, serverError } = context(f, failure);
      const preexisting = execFileSync(
        "git",
        ["--git-dir", f.repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
        { env: hardenedGitEnv(), encoding: "utf8" },
      )
        .trim()
        .split("\n");
      const writeObjects = gitWrite.writeStagedObjectsAsync;
      const write = vi.spyOn(gitWrite, "writeStagedObjectsAsync");
      if (failure === "callback")
        write.mockImplementation(async (...args) => {
          await writeObjects(...args);
          // Intent reservation precedes object writes: fail the callback after its filesystem work.
          throw serverError;
        });
      const remove = vi.spyOn(gitWrite, "removeLooseObjectsAsync");
      try {
        await expect(createPullRequestPublication(input).barrier.prepare!(lease)).rejects.toThrow(
          failure === "lost-commit"
            ? "pinned Postgres session was lost"
            : failure === "unknown-commit"
              ? "client failed after COMMIT"
              : serverError.message,
        );
        expect(write).toHaveBeenCalledTimes(1);
        const created = write.mock.calls[0]![2];
        expect(created.length).toBeGreaterThan(0);
        const reclaim =
          failure === "before-commit" || failure === "server-commit" || failure === "callback";
        expect(remove).toHaveBeenCalledTimes(reclaim ? 1 : 0);
        const rollbackIndex = query.mock.calls.findIndex(([sql]) => sql === "ROLLBACK");
        expect(rollbackIndex).toBeGreaterThanOrEqual(0);
        const commitAfterWrite = query.mock.calls.some(
          ([sql], index) =>
            sql === "COMMIT" &&
            query.mock.invocationCallOrder[index]! > write.mock.invocationCallOrder[0]!,
        );
        expect(commitAfterWrite).toBe(failure !== "before-commit" && failure !== "callback");
        if (reclaim) {
          expect(remove).toHaveBeenCalledWith(f.repo, created);
          expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(
            query.mock.invocationCallOrder[rollbackIndex]!,
          );
        }
        for (const sha of created) {
          expect(preexisting).not.toContain(sha);
          expect(existsSync(join(f.repo, "objects", sha.slice(0, 2), sha.slice(2)))).toBe(!reclaim);
        }
        for (const sha of preexisting)
          expect(existsSync(join(f.repo, "objects", sha.slice(0, 2), sha.slice(2)))).toBe(true);
      } finally {
        await lease.close();
      }
    });
  }
});

describe("a PR's status is the reviewed-merge planner's outcome", () => {
  const kbId = "f".repeat(24);
  const file = (path: string, body: string): TreeFileInput => ({
    segments: path.split("/"),
    content: Buffer.from(body),
  });
  const test = gitFixtureTests("kb-pr-status-", (reposDir) => {
    const repo = kbBareRepoPath(reposDir, kbId);
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const files = initialMainTreeFiles("Status fixture");
    const commit = (parentSha: string, extra: TreeFileInput[]) =>
      writeGitFixtureCommit(repo, { parentSha, message: "fixture", files: [...files, ...extra] });
    const base = writeGitFixtureCommit(repo, { parentSha: "0".repeat(40), message: "init", files });
    return {
      reposDir,
      repo,
      base,
      main: commit(base, [file("main.md", "main")]),
      proposal: commit(base, [file("proposal.md", "proposal")]),
      sameMain: commit(base, [file("same.md", "main")]),
      sameHead: commit(base, [file("same.md", "proposal")]),
      twinMain: commit(base, [file("a.md", "---\nid: twin\n---\n# A\n")]),
      twinHead: commit(base, [file("b.md", "---\nid: twin\n---\n# B\n")]),
      humanMain: commit(base, [file("concepts/a.md", "---\nid: a\nprovenance: human\n---\nhuman")]),
      other: commit(base, [file("other.md", "other")]),
    };
  });
  const noRows: LockQuery = async <Row>() => ({ rows: [] as Row[], rowCount: 0 });
  test("clean, text clash, invalid tree and dream guard all agree with the planner", async (f) => {
    const dream = {
      model: { provider: "fixture", model: "fixture" },
      redactionApplied: true as const,
      upserts: [],
      guardTouchedPaths: { a: [{ path: "concepts/a.md", existedAtBase: false }] },
    };
    const cases = [
      { mainHead: f.main, headSha: f.proposal, dream: null, expected: "OPEN" },
      { mainHead: f.base, headSha: f.proposal, dream: null, expected: "OPEN" },
      { mainHead: f.sameMain, headSha: f.sameHead, dream: null, expected: "CONFLICT" },
      { mainHead: f.twinMain, headSha: f.twinHead, dream: null, expected: "CONFLICT" },
      // The dream guard: a clean text merge after main took human provenance.
      { mainHead: f.humanMain, headSha: f.other, dream, expected: "CONFLICT" },
      { mainHead: f.main, headSha: f.other, dream, expected: "OPEN" },
    ] as const;
    for (const c of cases) {
      const planner = await planReviewedMerge({
        repoPath: f.repo,
        mainHead: c.mainHead,
        sourceHead: c.headSha,
        dream: c.dream,
      }).then(
        () => "OPEN",
        (error) => {
          if (error instanceof PrConflictError) return "CONFLICT";
          throw error;
        },
      );
      const status = await proposalMergeStatus({
        query: noRows,
        reposDir: f.reposDir,
        kbId,
        mainHead: c.mainHead,
        headSha: c.headSha,
        dream: c.dream,
      });
      expect([status, planner]).toEqual([c.expected, c.expected]);
    }
  });
});

describe("PR detail snapshot cursors", () => {
  const kbId = "a".repeat(32);
  const grantId = "00000000-0000-4000-8000-000000000001";
  const longPath = `${"a".repeat(120)}/${"b".repeat(120)}/${"c".repeat(120)}/${"d".repeat(146)}.md`;
  const test = gitFixtureTests("kb-pr-cursor-", (reposDir) => {
    const repo = kbBareRepoPath(reposDir, kbId);
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const files = initialMainTreeFiles("Cursor fixture");
    const baseSha = writeGitFixtureCommit(repo, {
      parentSha: "0".repeat(40),
      message: "base",
      files,
    });
    const headSha = writeGitFixtureCommit(repo, {
      parentSha: baseSha,
      message: "proposal",
      files: [
        ...files,
        ...[longPath, "z.md"].map((path) => ({
          segments: path.split("/"),
          content: Buffer.from("# New\n"),
        })),
      ],
    });
    return { reposDir, baseSha, headSha };
  });

  function context(f: { reposDir: string; baseSha: string; headSha: string }, version = 1) {
    setKbRecoveryComplete(true);
    const snapshot = { mainHead: f.baseSha, epoch: "1", policyGeneration: "1" };
    const row: PullRequestRow = {
      kbId,
      number: 1,
      title: "Proposal",
      sourceBranch: "refs/heads/proposals/1",
      targetBranch: "main",
      baseSha: f.baseSha,
      headSha: f.headSha,
      targetSha: f.baseSha,
      status: "OPEN",
      version,
      mergeCommitSha: null,
      authorActorKey: `grant:${grantId}`,
      isAutoPr: false,
      dreamMetadata: null,
      mergeCheckedSha: f.baseSha,
    };
    row.mergeCheckedKey = mergeabilityKey(snapshot, row);
    const query: LockQuery = async <Row>(sql: string) => {
      // The cached merge check is already current, so its stale scan is empty.
      const rows = sql.includes("FROM knowledge_base")
        ? [{ headSha: f.baseSha, ...snapshot }]
        : sql.includes('FROM "pull_request"')
          ? [{ ...row }]
          : sql.includes("FROM pull_request")
            ? []
            : null;
      if (!rows) throw new Error(`Unexpected fixture SQL: ${sql}`);
      return { rows: rows as Row[], rowCount: rows.length };
    };
    const principal: TokenPrincipal = {
      kind: "token",
      userId: "reader",
      grantId,
      grantGeneration: "1",
      scopes: ["mcp:read"],
      expiresAt: null,
      storedAcl: new Map([[kbId, ["read"]]]),
    };
    const verifier: CredentialVerifier = {
      inspect: async () => ({
        generationActive: true,
        instanceEnabled: true,
        expired: false,
        banned: false,
        twoFactorSatisfied: true,
      }),
    };
    return {
      row,
      input: {
        ...f,
        query,
        store,
        principal,
        verifier,
        cursorSigner: createCursorSigner(Buffer.alloc(32, 7)),
      },
      request: { kbId, number: 1, page: { limit: 1 } },
    };
  }

  test("fits the maximum KB id, grant actor, safe version and 512-byte path under 1024 bytes", async (f) => {
    const { input, request } = context(f, Number.MAX_SAFE_INTEGER);
    expect(Buffer.byteLength(longPath)).toBe(512);
    const first = await getPullRequest(input, request);
    expect(first.files[0]?.path).toBe(longPath);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(Buffer.byteLength(first.nextCursor!)).toBe(1022);
    const second = await getPullRequest(input, {
      ...request,
      page: { limit: 1, cursor: first.nextCursor! },
    });
    expect(second.files.map((file) => file.path)).toEqual(["z.md"]);
    expect(second.pr).toEqual(first.pr);
    expect(second.nextCursor).toBeNull();
  });

  test("serves a PR merged between pages as the first page's consistent snapshot", async (f) => {
    const { input, request, row } = context(f);
    const first = await getPullRequest(input, request);
    expect(first.pr.mergeCommitSha).toBeNull();
    row.status = "MERGED";
    row.version += 1;
    row.mergeCommitSha = f.headSha;
    const second = await getPullRequest(input, { ...request, page: { cursor: first.nextCursor! } });
    expect(second.pr).toEqual(first.pr);
    expect(second.pr).toMatchObject({ status: "OPEN", version: 1, mergeCommitSha: null });
  });

  test("keeps the pinned status and target when only the derived merge check changes", async (f) => {
    const { input, request, row } = context(f);
    const first = await getPullRequest(input, request);
    row.status = "CONFLICT";
    const second = await getPullRequest(input, { ...request, page: { cursor: first.nextCursor! } });
    expect(second.pr).toEqual(first.pr);
  });

  test("strictly rejects malformed hashes, status, version and diff keys in a signed pin", async (f) => {
    const { input, request } = context(f);
    const first = await getPullRequest(input, request);
    const binding = {
      actorKey: `grant:${grantId}`,
      kbId,
      filterHash: stableFilterHash({ number: 1 }),
      sortKey: "pr:diff",
      revision: "*",
    };
    const payload = input.cursorSigner.verify(first.nextCursor!, binding);
    const [target, status, base] = payload.lastKey!.split(":");
    // Alter just the unused final base64 bits: Node's decoder alone accepts it.
    const noncanonicalTarget =
      target!.slice(0, -1) + String.fromCharCode(target!.charCodeAt(26) + 1);
    for (const lastKey of [
      `${noncanonicalTarget}:${status}:${base}:1:f:a.md`,
      `${target}:${status}:${noncanonicalTarget}:1:f:a.md`,
      `${"!".repeat(27)}:${status}:${base}:1:f:a.md`,
      `${target}:Q:${base}:1:f:a.md`,
      `${target}:${status}:${base}:0:f:a.md`,
      `${target}:${status}:${base}:01:f:a.md`,
      `${target}:${status}:${base}:${(Number.MAX_SAFE_INTEGER + 1).toString(36)}:f:a.md`,
      `${target}:${status}:${base}:1:x:a.md`,
    ]) {
      const cursor = input.cursorSigner.sign({ ...payload, lastKey });
      await expect(getPullRequest(input, { ...request, page: { cursor } })).rejects.toMatchObject({
        code: "INVALID_CURSOR",
      });
    }
  });
});
