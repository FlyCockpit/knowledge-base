import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@knowledge-base/db/client";
import type { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";

import { buildChangesApplyRequest, changeSummaryTitle, createChangesPublication } from "./changes";
import { gitFixtureTests } from "./fixtures/git-fixture";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { hardenedGitEnv, kbBareRepoPath } from "./git-read";
import * as gitWrite from "./git-write";
import { HeldLockLease, type LockQuery } from "./lock";
import type { IntentRow } from "./operation-intent";
import type { LiveAuthorityStore } from "./permissions";
import type { CredentialVerifier, TokenPrincipal } from "./principal";

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

describe("changes", () => {
  it("refuses over-cap internal calls with the same typed guidance as MCP", () => {
    const request = {
      mode: "edit" as const,
      baseRevision: "a".repeat(40),
      title: "Batch",
      sourceSessionIds: [],
      changes: Array.from({ length: 32 }, (_, i) => ({
        op: "create" as const,
        path: `batch/${i}.md`,
        content: { markdown: "# Batch\n" },
      })),
    };
    expect(buildChangesApplyRequest(request).changes).toHaveLength(32);
    let refusal: unknown;
    try {
      buildChangesApplyRequest({
        ...request,
        changes: [...request.changes, { op: "delete", path: "extra.md" }],
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("Each call commits on success: apply the first 32 now"),
      details: { reason: "TOO_MANY_CHANGES", field: "/changes", max: 32 },
    });
  });
  it("rejects empty edit batches", () => {
    expect(() =>
      buildChangesApplyRequest({
        mode: "edit",
        baseRevision: "a".repeat(40),
        title: "t",
        changes: [],
        sourceSessionIds: [],
      }),
    ).toThrow(/at least one change/);
  });
});

describe("generated titles stay within the 200-scalar title bound", () => {
  it("cuts the longest valid paths and names", async () => {
    const { boundedTitle } = await import("./changes");
    const long = `notes/${"é".repeat(400)}.md`;
    for (const title of [
      changeSummaryTitle([{ op: "replace", path: long }]),
      changeSummaryTitle([{ op: "assetPut", path: long }]),
      boundedTitle(`Import asset ${long}`),
      boundedTitle("short"),
    ])
      expect(Array.from(title).length).toBeLessThanOrEqual(200);
    expect(boundedTitle("short")).toBe("short");
  });
});

describe("changeSummaryTitle", () => {
  it("names the one changed path with a plain verb", () => {
    expect(changeSummaryTitle([{ op: "replace", path: "runbooks/postgres-failover.md" }])).toBe(
      "Update runbooks/postgres-failover.md",
    );
    expect(changeSummaryTitle([{ op: "create", path: "a.md" }])).toBe("Create a.md");
    expect(changeSummaryTitle([{ op: "delete", path: "a.md" }])).toBe("Delete a.md");
  });
  it("summarizes several changes by count", () => {
    expect(
      changeSummaryTitle([
        { op: "replace", path: "a.md" },
        { op: "replace", path: "b.md" },
      ]),
    ).toBe("Update 2 documents");
    expect(
      changeSummaryTitle([
        { op: "create", path: "a.md" },
        { op: "delete", path: "b.md" },
      ]),
    ).toBe("Change 2 documents");
    expect(
      changeSummaryTitle([
        { op: "create", path: "a.md" },
        { op: "assetPut", path: "img/x.png" },
      ]),
    ).toBe("Change 2 files");
  });
  it("stays within the 200-character title bound", () => {
    const title = changeSummaryTitle([{ op: "create", path: `${"é".repeat(300)}.md` }]);
    expect(Array.from(title)).toHaveLength(200);
  });
});

describe("changes publication receipts and rollback cleanup", () => {
  const kbId = "a".repeat(24);
  const grantId = "00000000-0000-4000-8000-000000000001";
  const test = gitFixtureTests("kb-changes-receipt-", (reposDir) => {
    const repo = kbBareRepoPath(reposDir, kbId);
    execFileSync("git", ["init", "--bare", repo], { env: hardenedGitEnv(), stdio: "ignore" });
    const headSha = writeGitFixtureCommit(repo, {
      parentSha: "0".repeat(40),
      message: "base",
      files: [
        ...gitWrite.initialMainTreeFiles("Changes fixture"),
        { segments: ["a.md"], content: Buffer.from("# Same\n") },
      ],
    });
    execFileSync("git", ["--git-dir", repo, "update-ref", "refs/heads/main", headSha], {
      env: hardenedGitEnv(),
    });
    return { reposDir, repo, headSha };
  });

  function context(
    f: { reposDir: string; headSha: string },
    failure?:
      | "before-commit"
      | "server-commit"
      | "lost-commit"
      | "unknown-commit"
      | "rollback-failed"
      | "callback",
  ) {
    const state: { intent: IntentRow | null; loaded: boolean } = { intent: null, loaded: false };
    const actorKey = `grant:${grantId}`;
    const serverError = Object.assign(new Error("reservation rejected"), { code: "40001" });
    const query = vi.fn<LockQuery>().mockImplementation(async (sql, values = []) => {
      if (sql.startsWith("SET statement_timeout") && state.loaded && failure === "before-commit")
        throw serverError;
      if (sql === "COMMIT" && state.intent && failure) {
        if (failure === "lost-commit")
          throw Object.assign(new Error("connection lost after COMMIT"), { code: "ECONNRESET" });
        if (failure === "unknown-commit") throw new Error("client failed after COMMIT");
        throw serverError;
      }
      if (sql === "ROLLBACK" && failure === "rollback-failed") throw new Error("rollback failed");
      if (/^(SET |BEGIN$|COMMIT$|ROLLBACK$|SELECT pg_advisory_unlock_all)/.test(sql))
        return { rows: [], rowCount: 0 };
      if (sql.includes('FROM "user"'))
        return {
          rows: [{ banned: false, twoFactorEnabled: true, role: "user", createdAt: new Date() }],
          rowCount: 1,
        };
      if (sql.includes('FROM "knowledge_base"'))
        return {
          rows: [{ id: kbId, ownerId: "owner", state: "ACTIVE", headSha: f.headSha }],
          rowCount: 1,
        };
      if (sql.includes("FROM mcp_grant")) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO "operation_intent"')) {
        if (failure === "callback") throw serverError;
        const finalized = sql.includes("'FINALIZED'");
        state.intent = {
          opId: String(values[0]),
          kbId,
          reservedKbId: null,
          actorKey: String(values[2]),
          actorUserIdSnapshot: "owner",
          actorUserId: "owner",
          operation: "CHANGES_APPLY",
          idempotencyKey: "idempotency-test-key",
          requestHash: "request-hash",
          phase: finalized ? "FINALIZED" : "PREPARED",
          refName: finalized ? null : String(values[8]),
          oldRef: finalized ? null : String(values[9]),
          newRef: finalized ? null : String(values[10]),
          preparedDelta: finalized ? null : JSON.parse(String(values[11])),
          responseBody: finalized ? JSON.parse(String(values[8])) : null,
          resultRevision: null,
          resultStatus: finalized ? "SUCCESS" : null,
          publishNonce: "nonce",
          abortReason: null,
        };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM "operation_intent"')) {
        const matched =
          state.intent && sql.includes('"actorKey" = $1') && state.intent.actorKey === values[0];
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
      opId: "changes-test",
      backendPid: 1,
      abort: new AbortController(),
    });
    vi.spyOn(lease, "assertHeldKb").mockImplementation(() => {});
    const principal: TokenPrincipal = {
      kind: "token",
      userId: "owner",
      grantId,
      grantGeneration: "1",
      scopes: ["mcp:read", "mcp:write"],
      expiresAt: null,
      storedAcl: new Map([[kbId, ["read", "write", "propose"]]]),
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
    const store = mockDeep<LiveAuthorityStore>();
    const input = {
      ...f,
      kbId,
      principal,
      verifier,
      store,
      idempotencyKey: "idempotency-test-key",
      operation: "CHANGES_APPLY",
      requestHash: "request-hash",
      diskMeter: { freeBytes: async () => 10n ** 12n },
      request: {
        mode: "edit" as const,
        baseRevision: f.headSha,
        title: `Edit ${failure ?? "noop"}`,
        sourceSessionIds: [],
        changes: [
          {
            op: "replace" as const,
            path: "a.md",
            content: { markdown: failure ? `# Changed ${failure}\n` : "# Same\n" },
          },
        ],
      },
    };
    return { state, actorKey, query, lease, input };
  }

  test("records and replays a token no-op under its grant actor key", async (f) => {
    const { state, actorKey, input, lease, query } = context(f);
    try {
      const first = createChangesPublication(input);
      await first.barrier.prepare!(lease);
      expect(state.intent).toMatchObject({
        actorKey,
        phase: "FINALIZED",
        responseBody: { kind: "noop" },
      });
      const result = await first.publish(lease, { exec: vi.fn() });
      const replay = createChangesPublication(input);
      await replay.barrier.prepare!(lease);
      expect(await replay.publish(lease, { exec: vi.fn() })).toEqual(result);
      const inserts = query.mock.calls.filter(([sql]) =>
        sql.includes('INSERT INTO "operation_intent"'),
      );
      expect(inserts).toHaveLength(1);
      expect(inserts[0]?.[1]?.[2]).toBe(actorKey);
    } finally {
      await lease.close();
    }
  });

  for (const failure of [
    "before-commit",
    "server-commit",
    "lost-commit",
    "unknown-commit",
    "rollback-failed",
    "callback",
  ] as const) {
    test(`reclaims only operation-owned objects with definite rollback: ${failure}`, async (f) => {
      const { input, lease, query } = context(f, failure);
      const write = vi.spyOn(gitWrite, "writeStagedObjectsAsync");
      const remove = vi.spyOn(gitWrite, "removeLooseObjects");
      try {
        await expect(createChangesPublication(input).barrier.prepare!(lease)).rejects.toThrow();
        expect(write).toHaveBeenCalledTimes(1);
        const created = write.mock.calls[0]![2];
        expect(created.length).toBeGreaterThan(0);
        const reclaim =
          failure === "before-commit" || failure === "server-commit" || failure === "callback";
        expect(remove).toHaveBeenCalledTimes(reclaim ? 1 : 0);
        if (reclaim && failure !== "callback") {
          const rollbackIndex = query.mock.calls.findIndex(([sql]) => sql === "ROLLBACK");
          expect(rollbackIndex).toBeGreaterThanOrEqual(0);
          expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(
            query.mock.invocationCallOrder[rollbackIndex]!,
          );
        }
        for (const sha of created)
          expect(existsSync(join(f.repo, "objects", sha.slice(0, 2), sha.slice(2)))).toBe(!reclaim);
        expect(existsSync(join(f.repo, "objects", f.headSha.slice(0, 2), f.headSha.slice(2)))).toBe(
          true,
        );
        if (reclaim) {
          // Missing files are safe on a repeat cleanup (ENOENT is tolerated).
          expect(() => gitWrite.removeLooseObjects(f.repo, created)).not.toThrow();
        }
      } finally {
        await lease.close();
      }
    });
  }
});
