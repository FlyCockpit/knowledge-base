import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import { mockDeep } from "vitest-mock-extended";
import type { Context } from "../context";
import { KbDomainError } from "../lib/kb/errors";
import { SensitiveQueryError } from "../lib/kb/redact-for-embed";
import { searchKnowledgeBase } from "../lib/kb/search";
import { structuredSearchKnowledgeBase } from "../lib/kb/structured-search";
import { searchRouter } from "./search";

vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
vi.mock("@knowledge-base/env/shared", () => ({
  env: { KB_MASTER_KEY: new Secret("test-master") },
}));
vi.mock("../lib/kb/search", () => ({ searchKnowledgeBase: vi.fn() }));
vi.mock("../lib/kb/structured-search", () => ({ structuredSearchKnowledgeBase: vi.fn() }));
vi.mock("../lib/kb/runtime", () => ({
  getKbRuntime: () => ({
    connectionString: "postgres://runtime",
    ratePort: "rate-port",
    cursorSigner: "cursor-signer",
  }),
}));
const state = vi.hoisted(() => ({ budget: vi.fn(async () => {}) }));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => state.budget }));
const kbId = "a".repeat(24);
function client(authenticated = true) {
  const session = mockDeep<NonNullable<Context["session"]>>();
  session.user.id = "reader";
  session.user.twoFactorEnabled = true;
  session.user.banned = false;
  return createRouterClient(searchRouter, {
    context: () => ({ session: authenticated ? session : null }),
  });
}
beforeEach(() => vi.resetAllMocks());

describe("search router", () => {
  it("requires authentication", async () => {
    await expect(client(false).hybrid({ kbId, query: "q" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(searchKnowledgeBase).not.toHaveBeenCalled();
    expect(state.budget).not.toHaveBeenCalled();
  });
  it("rejects oversized query and limit by schema before the service", async () => {
    await expect(client().hybrid({ kbId, query: "x".repeat(1025) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client().hybrid({ kbId, query: "q", limit: 21 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(searchKnowledgeBase).not.toHaveBeenCalled();
  });
  it("delegates with the browser actor and shared runtime quotas", async () => {
    vi.mocked(searchKnowledgeBase).mockResolvedValue({
      results: [],
      generationId: "g".repeat(24),
      freshness: "current",
      indexedCommitSha: "b".repeat(40),
      headSha: "b".repeat(40),
    });
    await client().hybrid({ kbId, query: "q", limit: 3 });
    expect(state.budget).toHaveBeenCalledWith("reader");
    expect(searchKnowledgeBase).toHaveBeenCalledWith(
      { connectionString: "postgres://runtime", masterKey: "test-master", ratePort: "rate-port" },
      { principal: { kind: "browser", userId: "reader" } },
      { kbId, query: "q", limit: 3 },
      undefined,
    );
  });
  it.each([
    [
      new KbDomainError("INDEX_UNAVAILABLE", "x"),
      "SERVICE_UNAVAILABLE",
      { code: "INDEX_UNAVAILABLE" },
    ],
    [
      new KbDomainError("RATE_LIMITED", "x", 5),
      "TOO_MANY_REQUESTS",
      { code: "RATE_LIMITED", retryAfterSeconds: 5 },
    ],
    [
      new KbDomainError("STORAGE_UNAVAILABLE", "x"),
      "SERVICE_UNAVAILABLE",
      { code: "STORAGE_UNAVAILABLE" },
    ],
    [new KbDomainError("NOT_FOUND", "x"), "NOT_FOUND", { code: "NOT_FOUND" }],
    [new SensitiveQueryError(), "BAD_REQUEST", { code: "SENSITIVE_QUERY" }],
    [new Error("select * from secret"), "INTERNAL_SERVER_ERROR", { code: "INTERNAL" }],
  ])("maps failures to fixed messages", async (error, code, data) => {
    vi.mocked(searchKnowledgeBase).mockRejectedValue(error);
    const failure = await client()
      .hybrid({ kbId, query: "q" })
      .catch((e) => e);
    expect(failure).toMatchObject({ code, message: "Search unavailable", data });
  });
  it("consumes the procedure budget before the domain search", async () => {
    state.budget.mockRejectedValueOnce(
      new ORPCError("TOO_MANY_REQUESTS", {
        message: "Too many search requests. Try again in 3s.",
        data: { retryAfterSeconds: 3 },
      }),
    );
    await expect(client().hybrid({ kbId, query: "q" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      data: { retryAfterSeconds: 3 },
    });
    expect(searchKnowledgeBase).not.toHaveBeenCalled();
  });
});

describe("structured search router", () => {
  it("requires authentication and rejects queryless-and-filterless input by schema", async () => {
    await expect(client(false).structured({ kbId, type: "note" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client().structured({ kbId } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(structuredSearchKnowledgeBase).not.toHaveBeenCalled();
  });
  it("delegates with the browser actor, shared budget and the runtime cursor signer", async () => {
    vi.mocked(structuredSearchKnowledgeBase).mockResolvedValue({
      items: [],
      nextCursor: null,
      generationId: "g".repeat(24),
      freshness: "current",
      indexedCommitSha: "b".repeat(40),
      headSha: "b".repeat(40),
    });
    await client().structured({ kbId, type: "note", limit: 2 });
    expect(state.budget).toHaveBeenCalledWith("reader");
    expect(structuredSearchKnowledgeBase).toHaveBeenCalledWith(
      {
        connectionString: "postgres://runtime",
        masterKey: "test-master",
        ratePort: "rate-port",
        cursorSigner: "cursor-signer",
      },
      { principal: { kind: "browser", userId: "reader" } },
      { kbId, type: "note", limit: 2 },
      undefined,
    );
  });
  it("maps a refused cursor to a fixed BAD_REQUEST with the kb/1 code", async () => {
    vi.mocked(structuredSearchKnowledgeBase).mockRejectedValue(
      new KbDomainError("INVALID_CURSOR", "Invalid cursor"),
    );
    const failure = await client()
      .structured({ kbId, type: "note", cursor: "x" })
      .catch((e) => e);
    expect(failure).toMatchObject({
      code: "BAD_REQUEST",
      message: "Search unavailable",
      data: { code: "INVALID_CURSOR" },
    });
  });
});
