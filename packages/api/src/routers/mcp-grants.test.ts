import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({ marker: "runtime" }) }));
vi.mock("../lib/mcp-token-access", async (original) => ({
  ...(await original<typeof import("../lib/mcp-token-access")>()),
  countActiveCredentials: vi.fn(),
  endGrantElevation: vi.fn(),
  listGrants: vi.fn(),
  listGrantAcl: vi.fn(),
  revokeAllCredentials: vi.fn(),
  revokeGrant: vi.fn(),
  updateGrant: vi.fn(),
}));
const budget = vi.hoisted(() => vi.fn(async (_key: string) => undefined));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => budget }));

import { ORPCError } from "@orpc/server";
import { KbDomainError } from "../lib/kb/errors";
import {
  countActiveCredentials,
  endGrantElevation,
  listGrantAcl,
  listGrants,
  revokeAllCredentials,
  revokeGrant,
  updateGrant,
} from "../lib/mcp-token-access";
import { mcpGrantsRouter } from "./mcp-grants";

const session = { session: { user: { id: "owner", role: "user", twoFactorEnabled: true } } };
const grantId = "11111111-1111-4111-8111-111111111111";

describe("mcpGrants router", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes exactly list/update/end-elevation/revoke of own grants and denies anonymous callers", async () => {
    expect(Object.keys(mcpGrantsRouter).sort()).toEqual([
      "countActiveMine",
      "endElevationMine",
      "listAclMine",
      "listMine",
      "revokeAllMine",
      "revokeMine",
      "updateMine",
    ]);
    const client = createRouterClient(mcpGrantsRouter, { context: () => ({ session: null }) });
    await expect(client.listMine({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.revokeMine({ id: grantId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.listAclMine({ grantId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.updateMine({ id: grantId, toolGroups: ["read"] })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.endElevationMine({ id: grantId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(updateGrant).not.toHaveBeenCalled();
    expect(endGrantElevation).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();
    expect(listGrantAcl).not.toHaveBeenCalled();
    expect(listGrants).not.toHaveBeenCalled();
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it("scopes list and revoke to the session user", async () => {
    vi.mocked(listGrants).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(revokeGrant).mockResolvedValue({ id: grantId, revoked: true });
    const client = createRouterClient(mcpGrantsRouter, { context: () => session as Context });
    vi.mocked(listGrantAcl).mockResolvedValue({ items: [], nextCursor: null });
    await client.listAclMine({ grantId, limit: 5 });
    expect(listGrantAcl).toHaveBeenCalledWith({ marker: "runtime" }, "owner", {
      grantId,
      limit: 5,
    });
    await client.listMine({ limit: 5 });
    expect(listGrants).toHaveBeenCalledWith({ marker: "runtime" }, "owner", { limit: 5 });
    await expect(client.revokeMine({ id: grantId })).resolves.toEqual({
      id: grantId,
      revoked: true,
    });
    expect(revokeGrant).toHaveBeenCalledWith({ marker: "runtime" }, "owner", grantId);
  });

  it("edits only the session user's grant, after charging that user's edit budget", async () => {
    vi.mocked(updateGrant).mockResolvedValue({ id: grantId, widened: true, narrowed: false });
    const client = createRouterClient(mcpGrantsRouter, { context: () => session as Context });
    const edit = { id: grantId, toolGroups: ["read", "edit"] as ("read" | "edit")[] };
    await expect(client.updateMine(edit)).resolves.toEqual({
      id: grantId,
      widened: true,
      narrowed: false,
    });
    expect(budget).toHaveBeenCalledWith("owner");
    expect(updateGrant).toHaveBeenCalledWith({ marker: "runtime" }, "owner", edit);
  });

  it("refuses an empty edit and maps domain refusals to fixed messages", async () => {
    const client = createRouterClient(mcpGrantsRouter, { context: () => session as Context });
    await expect(client.updateMine({ id: grantId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(updateGrant).not.toHaveBeenCalled();
    vi.mocked(updateGrant).mockRejectedValue(new KbDomainError("NOT_FOUND", "Token not found"));
    await expect(client.updateMine({ id: grantId, allowCreate: false })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Credential operation unavailable",
    });
    budget.mockRejectedValueOnce(new ORPCError("TOO_MANY_REQUESTS", { message: "limited" }));
    await expect(client.updateMine({ id: grantId, allowCreate: false })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(updateGrant).toHaveBeenCalledTimes(1);
  });

  it("validates temporary access input before any work", async () => {
    const client = createRouterClient(mcpGrantsRouter, { context: () => session as Context });
    vi.mocked(updateGrant).mockResolvedValue({ id: grantId, widened: true, narrowed: false });
    const temporary = {
      id: grantId,
      toolGroups: ["read", "kb_admin"] as ("read" | "kb_admin")[],
      duration: "1h" as const,
    };
    await client.updateMine(temporary);
    expect(updateGrant).toHaveBeenCalledWith({ marker: "runtime" }, "owner", temporary);
    vi.mocked(updateGrant).mockClear();
    // Over the 7-day maximum, unknown, scope edits and narrowing caps are refused.
    for (const bad of [
      { ...temporary, duration: "8d" },
      { ...temporary, duration: "30d" },
      { ...temporary, scopes: ["mcp:write"] },
      { ...temporary, aclCap: ["read"] },
    ]) {
      await expect(client.updateMine(bad as typeof temporary)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(updateGrant).not.toHaveBeenCalled();
  });

  it("ends only the session user's elevation, after charging that user's budget", async () => {
    const client = createRouterClient(mcpGrantsRouter, { context: () => session as Context });
    const elevationId = "22222222-2222-4222-8222-222222222222";
    vi.mocked(endGrantElevation).mockResolvedValue({ id: elevationId, ended: true });
    await expect(client.endElevationMine({ id: elevationId })).resolves.toEqual({
      id: elevationId,
      ended: true,
    });
    expect(budget).toHaveBeenCalledWith("owner");
    expect(endGrantElevation).toHaveBeenCalledWith({ marker: "runtime" }, "owner", elevationId);
    vi.mocked(endGrantElevation).mockRejectedValue(new KbDomainError("NOT_FOUND", "nope"));
    await expect(client.endElevationMine({ id: elevationId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Credential operation unavailable",
    });
    await expect(client.endElevationMine({ id: "not-a-uuid" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("counts and revokes all of the caller's own credentials under their own budgets", async () => {
    vi.mocked(countActiveCredentials).mockResolvedValue({ tokens: 2, apps: 1 });
    vi.mocked(revokeAllCredentials).mockResolvedValue({ tokens: 2, apps: 1 });
    const client = createRouterClient(mcpGrantsRouter, { context: () => session as Context });
    await expect(client.countActiveMine()).resolves.toEqual({ tokens: 2, apps: 1 });
    await expect(client.revokeAllMine()).resolves.toEqual({ tokens: 2, apps: 1 });
    expect(countActiveCredentials).toHaveBeenCalledWith({ marker: "runtime" }, "owner");
    expect(revokeAllCredentials).toHaveBeenCalledWith({ marker: "runtime" }, "owner");
    expect(budget).toHaveBeenCalledTimes(2);
    expect(budget).toHaveBeenCalledWith("owner");

    const anonymous = createRouterClient(mcpGrantsRouter, { context: () => ({ session: null }) });
    await expect(anonymous.revokeAllMine()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.countActiveMine()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
