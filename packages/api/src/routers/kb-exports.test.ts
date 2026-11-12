import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { Context } from "../context";
import { KbDomainError } from "../lib/kb/errors";
import { prepareExport } from "../lib/kb/exports";
import { completeExport, readTransfer } from "../lib/kb/transfers";
import { kbExportsRouter } from "./kb-exports";

vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
vi.mock("../lib/kb/exports", () => ({ prepareExport: vi.fn() }));
vi.mock("../lib/kb/transfers", () => ({ readTransfer: vi.fn(), completeExport: vi.fn() }));
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({}) }));
const state = vi.hoisted(() => ({ budget: vi.fn() }));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => state.budget }));
const kbId = "a".repeat(24);
const transferId = "00000000-0000-4000-8000-000000000001";
const input = { kbId, kind: "whole" as const, idempotencyKey: "export-test-key-01" };
function client(authenticated = true) {
  const session = mockDeep<NonNullable<Context["session"]>>();
  session.user.id = "owner";
  session.user.twoFactorEnabled = true;
  session.user.banned = false;
  return createRouterClient(kbExportsRouter, {
    context: () => ({ session: authenticated ? session : null }),
  });
}
beforeEach(() => vi.resetAllMocks());
describe("export router boundary", () => {
  it("requires identity before either domain call or budget", async () => {
    await expect(client(false).prepare(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(false).read({ kbId, transferId, offset: 0 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(prepareExport).not.toHaveBeenCalled();
    expect(readTransfer).not.toHaveBeenCalled();
    expect(state.budget).not.toHaveBeenCalled();
  });
  it("binds the live session actor, preserves pinned input, and passes request cancellation", async () => {
    const signal = new AbortController().signal;
    const pinned = { ...input, rev: "b".repeat(40) };
    await client().prepare(pinned, { signal });
    expect(prepareExport).toHaveBeenCalledWith(
      {},
      { principal: { kind: "browser", userId: "owner" } },
      pinned,
      { signal },
    );
    await client().read({ kbId, transferId, offset: 42, maxBytes: 17 }, { signal });
    expect(readTransfer).toHaveBeenCalledWith(
      {},
      { principal: { kind: "browser", userId: "owner" } },
      { kbId, transferId, offset: 42, maxBytes: 17 },
      { signal },
    );
    expect(state.budget).toHaveBeenCalledWith("owner");
  });
  it("enforces the frame schema and maps domain denials and budgets", async () => {
    await expect(
      client().read({ kbId, transferId, offset: 0, maxBytes: 196609 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(readTransfer).not.toHaveBeenCalled();
    vi.mocked(prepareExport).mockRejectedValue(
      new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch"),
    );
    await expect(client().prepare(input)).rejects.toMatchObject({ code: "CONFLICT" });
    state.budget.mockRejectedValue(new KbDomainError("RATE_LIMITED", "Rate limited"));
    await expect(client().read({ kbId, transferId, offset: 0 })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(readTransfer).not.toHaveBeenCalled();
  });
  it("complete binds the session actor, requires identity and maps denials", async () => {
    await expect(client(false).complete({ kbId, transferId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(completeExport).not.toHaveBeenCalled();
    vi.mocked(completeExport).mockResolvedValue({ transferId, released: true });
    await expect(client().complete({ kbId, transferId })).resolves.toEqual({
      transferId,
      released: true,
    });
    expect(completeExport).toHaveBeenCalledWith(
      {},
      { principal: { kind: "browser", userId: "owner" } },
      { kbId, transferId },
    );
    await expect(client().complete({ kbId, transferId, extra: 1 } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    vi.mocked(completeExport).mockRejectedValue(new KbDomainError("NOT_FOUND", "Not found"));
    await expect(client().complete({ kbId, transferId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
