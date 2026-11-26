import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const mocks = vi.hoisted(() => ({
  budget: vi.fn(async (_userId: string) => {}),
  authorize: vi.fn(async (_input: unknown) => {}),
  readDocument: vi.fn(),
  resolve: vi.fn(async () => "e".repeat(40)),
  history: vi.fn(),
  deleted: vi.fn(),
  findUnique: vi.fn(async () => ({ headSha: "e".repeat(40), state: "ACTIVE" })),
}));

vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: () => mocks.budget,
}));
vi.mock("../lib/kb/runtime", () => ({
  getKbRuntime: () => ({
    reposDir: "/repos",
    prisma: { knowledgeBase: { findUnique: mocks.findUnique } },
  }),
}));
vi.mock("../lib/kb/documents-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/kb/documents-read")>()),
  authorizeDocumentRead: mocks.authorize,
  readDocumentAtRevision: mocks.readDocument,
  resolvePinnedRevision: mocks.resolve,
}));
vi.mock("../lib/kb/deleted-documents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/kb/deleted-documents")>()),
  readDeletedDocuments: mocks.deleted,
}));
vi.mock("../lib/kb/document-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/kb/document-history")>()),
  readDocumentHistory: mocks.history,
}));

import type { Context } from "../context";
import { invalidArgument, pathExists } from "../lib/kb/argument-reasons";
import { KbDomainError } from "../lib/kb/errors";
import { documentErrorToOrpc, documentsRouter } from "./documents";

function signedIn() {
  return createRouterClient(documentsRouter, {
    context: () => ({
      session: {
        user: { id: "reader", twoFactorEnabled: true, banned: false },
      } as unknown as NonNullable<Context["session"]>,
    }),
  });
}

describe("documents router", () => {
  it("requires authentication", async () => {
    const client = createRouterClient(documentsRouter, { context: () => ({ session: null }) });
    await expect(client.list({ kbId: "kb1" })).rejects.toBeInstanceOf(ORPCError);
  });

  it("exposes the readable conflict head so the editor can show it", () => {
    const head = "2".repeat(40);
    let thrown: unknown;
    try {
      documentErrorToOrpc(
        new KbDomainError("CONFLICT", "stale", undefined, { headSha: head, proposalNumber: 3 }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as ORPCError<string, unknown>).code).toBe("CONFLICT");
    expect((thrown as ORPCError<string, unknown>).data).toEqual({
      code: "CONFLICT",
      details: { headSha: head, proposalNumber: 3 },
    });
  });

  it("forwards a PROPOSAL_CONFLICT's paths and revisions, never its contents", () => {
    const main = "3".repeat(40);
    const proposal = "4".repeat(40);
    const base = "1".repeat(40);
    let thrown: unknown;
    try {
      documentErrorToOrpc(
        new KbDomainError("CONFLICT", "clash", undefined, {
          headSha: main,
          proposalNumber: 2,
          reason: "PROPOSAL_CONFLICT",
          baseSha: base,
          proposalHeadSha: proposal,
          contentIncluded: true,
          paths: [
            {
              path: "a.md",
              kind: "document",
              base: "secret",
              theirs: null,
              yours: null,
              baseSha: base,
              theirsSha: main,
              yoursSha: proposal,
            },
          ],
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ORPCError<string, unknown>).data).toEqual({
      code: "CONFLICT",
      details: {
        headSha: proposal,
        proposalNumber: 2,
        reason: "PROPOSAL_CONFLICT",
        mainSha: main,
        paths: [
          { path: "a.md", kind: "document", baseSha: base, theirsSha: main, yoursSha: proposal },
        ],
      },
    });
    expect(JSON.stringify((thrown as ORPCError<string, unknown>).data)).not.toContain("secret");
  });

  it("never forwards non-conflict details or malformed conflict details", () => {
    for (const error of [
      new KbDomainError("NOT_FOUND", "x", undefined, { headSha: "2".repeat(40) }),
      new KbDomainError("CONFLICT", "x", undefined, { headSha: "not-a-sha", secret: "y" }),
    ]) {
      let thrown: unknown;
      try {
        documentErrorToOrpc(error);
      } catch (e) {
        thrown = e;
      }
      const data = (thrown as ORPCError<string, unknown>).data as { details?: unknown } | undefined;
      expect(data?.details ?? {}).toEqual({});
    }
  });

  it("forwards only the reason of a missing path at a readable revision", () => {
    let thrown: unknown;
    try {
      documentErrorToOrpc(
        new KbDomainError("NOT_FOUND", "Document not found", undefined, {
          reason: "PATH_NOT_FOUND",
          field: "/path",
          secret: "y",
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
    expect((thrown as ORPCError<string, unknown>).data).toEqual({
      code: "NOT_FOUND",
      details: { reason: "PATH_NOT_FOUND" },
    });
  });
});

describe("documents refusal details", () => {
  const thrownBy = (error: unknown) => {
    try {
      documentErrorToOrpc(error);
    } catch (e) {
      return e as ORPCError<string, unknown>;
    }
    throw new Error("expected a throw");
  };

  it("forwards an argument refusal's closed reason and field pointer only", () => {
    const thrown = thrownBy(
      invalidArgument("only markdown document paths are supported", "NOT_MARKDOWN_PATH", "/path"),
    );
    expect(thrown.code).toBe("BAD_REQUEST");
    expect(thrown.data).toEqual({
      code: "INVALID_ARGUMENT",
      details: { reason: "NOT_MARKDOWN_PATH", field: "/path" },
    });
  });

  it("drops an unknown reason, an unsafe field and any other detail", () => {
    expect(
      thrownBy(
        new KbDomainError("INVALID_ARGUMENT", "x", undefined, { reason: "MADE_UP", secret: "y" }),
      ).data,
    ).toEqual({ code: "INVALID_ARGUMENT" });
    expect(
      thrownBy(
        new KbDomainError("INVALID_ARGUMENT", "x", undefined, {
          reason: "INVALID_PATH",
          field: "/path/../x y",
          secret: "y",
        }),
      ).data,
    ).toEqual({ code: "INVALID_ARGUMENT", details: { reason: "INVALID_PATH" } });
  });

  it("names an existing path on create as PATH_EXISTS, without the path", () => {
    const thrown = thrownBy(pathExists("path already exists: secret/plan.md", "/path"));
    expect(thrown.code).toBe("CONFLICT");
    expect(thrown.data).toEqual({ code: "CONFLICT", details: { reason: "PATH_EXISTS" } });
    expect(JSON.stringify(thrown.data)).not.toContain("secret");
  });
});

describe("documents.get provenance and documents.history", () => {
  const kbId = "a".repeat(24);
  const head = "e".repeat(40);
  beforeEach(() => vi.clearAllMocks());

  it("labels the served document from its front matter (browser output only)", async () => {
    mocks.readDocument.mockResolvedValue({
      path: "a.md",
      frontMatter: { provenance: "agent", title: "A" },
      markdown: "x",
    });
    await expect(signedIn().get({ kbId, path: "a.md" })).resolves.toMatchObject({
      provenance: "agent",
    });
    mocks.readDocument.mockResolvedValue({ path: "a.md", frontMatter: {}, markdown: "x" });
    await expect(signedIn().get({ kbId, path: "a.md" })).resolves.toMatchObject({
      provenance: "absent",
    });
  });

  it("requires a session and validates bounds before any read", async () => {
    const anonymous = createRouterClient(documentsRouter, { context: () => ({ session: null }) });
    await expect(anonymous.history({ kbId, path: "a.md" })).rejects.toBeInstanceOf(ORPCError);
    await expect(signedIn().history({ kbId, path: "a.md", limit: 51 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // The cursor is opaque but strict: a bare sha, a zero or
    // padded offset, or anything else is refused before any read.
    for (const cursor of [
      "not-a-sha",
      "c".repeat(40),
      `v1.${"c".repeat(40)}.0`,
      `v1.${"c".repeat(40)}.01`,
      `v1.${"c".repeat(40)}.100000`,
      `v1.${"C".repeat(40)}.5`,
      `v2.${"c".repeat(40)}.5`,
    ]) {
      await expect(signedIn().history({ kbId, path: "a.md", cursor })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.budget).not.toHaveBeenCalled();
  });

  it("uses the documents-read budget and read admission, before and after the history read", async () => {
    const page = {
      items: [
        {
          sha: head,
          committedAt: "2026-11-22T00:00:00.000Z",
          subject: "Pushed",
          provenance: "agent",
          deleted: false,
          actor: { kind: "unattributed", name: null, via: null },
        },
      ],
      nextCursor: null,
    };
    mocks.history.mockResolvedValue(page);
    const cursor = `v1.${"c".repeat(40)}.20`;
    await expect(signedIn().history({ kbId, path: "a.md", cursor, limit: 5 })).resolves.toEqual(
      page,
    );
    expect(mocks.budget).toHaveBeenCalledWith("reader");
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.authorize.mock.calls[0]?.[0]).toMatchObject({
      principal: { kind: "browser", userId: "reader" },
      kbId,
      operation: "read",
    });
    expect(mocks.history).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: head, path: "a.md", cursor, limit: 5 }),
    );
  });

  it("a refused read never reaches Git", async () => {
    mocks.authorize.mockRejectedValueOnce(new KbDomainError("FORBIDDEN", "no"));
    await expect(signedIn().history({ kbId, path: "a.md" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("a tombstoned knowledge base has no history", async () => {
    mocks.findUnique.mockResolvedValueOnce({ headSha: head, state: "TOMBSTONED" });
    await expect(signedIn().history({ kbId, path: "a.md" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mocks.history).not.toHaveBeenCalled();
  });
});

describe("documents.deleted", () => {
  const kbId = "a".repeat(24);
  const head = "e".repeat(40);
  beforeEach(() => vi.clearAllMocks());

  it("requires a session and validates bounds before any read", async () => {
    const anonymous = createRouterClient(documentsRouter, { context: () => ({ session: null }) });
    await expect(anonymous.deleted({ kbId })).rejects.toBeInstanceOf(ORPCError);
    await expect(signedIn().deleted({ kbId, limit: 51 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(signedIn().deleted({ kbId, path: "x".repeat(513) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // A history cursor is not a deleted-list cursor.
    await expect(signedIn().deleted({ kbId, cursor: `v1.${head}.1` })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(mocks.deleted).not.toHaveBeenCalled();
    expect(mocks.budget).not.toHaveBeenCalled();
  });

  it("uses the documents-read budget and read admission, before and after the scan", async () => {
    const page = { items: [], nextCursor: null };
    mocks.deleted.mockResolvedValue(page);
    await expect(signedIn().deleted({ kbId, path: "notes/a.md", limit: 1 })).resolves.toEqual(page);
    expect(mocks.budget).toHaveBeenCalledWith("reader");
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(mocks.authorize.mock.calls[0]?.[0]).toMatchObject({
      principal: { kind: "browser", userId: "reader" },
      kbId,
      operation: "read",
    });
    expect(mocks.deleted).toHaveBeenCalledWith(
      expect.objectContaining({ headSha: head, path: "notes/a.md", cursor: null, limit: 1 }),
    );
  });

  it("a refused read never reaches Git, and a tombstoned KB has no deleted list", async () => {
    mocks.authorize.mockRejectedValueOnce(new KbDomainError("FORBIDDEN", "no"));
    await expect(signedIn().deleted({ kbId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.findUnique.mockResolvedValueOnce({ headSha: head, state: "TOMBSTONED" });
    await expect(signedIn().deleted({ kbId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.deleted).not.toHaveBeenCalled();
  });
});
