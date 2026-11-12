import { createRouterClient, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: () => async () => {},
}));

import { KbDomainError } from "../lib/kb/errors";
import { documentErrorToOrpc, documentsRouter } from "./documents";

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
