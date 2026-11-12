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
  mintPersonalToken: vi.fn(),
  listPersonalTokens: vi.fn(),
  revokePersonalToken: vi.fn(),
}));

import { KbDomainError } from "../lib/kb/errors";
import {
  listPersonalTokens,
  mintPersonalToken,
  revokePersonalToken,
} from "../lib/mcp-token-access";
import { mcpTokensRouter } from "./mcp-tokens";

const session = { session: { user: { id: "owner", role: "user", twoFactorEnabled: true } } };
const kbId = "a".repeat(24);

describe("mcpTokens router (human control plane only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes exactly create/listMine/revokeMine", () => {
    expect(Object.keys(mcpTokensRouter).sort()).toEqual(["create", "listMine", "revokeMine"]);
  });

  it("rejects anonymous and bearer-only (PAT) callers before any domain call", async () => {
    for (const context of [
      { session: null },
      // A presented PAT is never an oRPC session: the context carries only the
      // Better Auth cookie session, so a bearer header alone is anonymous.
      { session: null, headers: new Headers({ authorization: "Bearer kbp_x" }) },
    ]) {
      const client = createRouterClient(mcpTokensRouter, { context: () => context as Context });
      await expect(
        client.create({ name: "t", scopes: ["mcp:read"], toolGroups: ["read"], acl: [] }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(client.listMine({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(client.revokeMine({ id: "tok" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    expect(mintPersonalToken).not.toHaveBeenCalled();
  });

  it("requires the forced second factor for minting", async () => {
    const client = createRouterClient(mcpTokensRouter, {
      context: () =>
        ({
          session: {
            user: { id: "admin", role: "admin", twoFactorEnabled: false, createdAt: new Date(0) },
          },
        }) as Context,
    });
    await expect(
      client.create({ name: "t", scopes: ["mcp:read"], toolGroups: ["read"], acl: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mintPersonalToken).not.toHaveBeenCalled();
  });

  it("mints for the session user only and returns the secret from the domain once", async () => {
    vi.mocked(mintPersonalToken).mockResolvedValue({
      token: { id: "tok", name: "t", expiresAt: new Date(), lookupPrefix: "p" },
      secret: "kbp_secret",
    });
    const client = createRouterClient(mcpTokensRouter, { context: () => session as Context });
    const input = {
      name: "t",
      scopes: ["mcp:write" as const],
      toolGroups: ["read" as const, "kb_admin" as const],
      acl: [{ kbId, bits: ["read" as const] }],
      allowCreate: true,
      createdKbBits: ["read" as const],
    };
    await expect(client.create(input)).resolves.toMatchObject({ secret: "kbp_secret" });
    expect(mintPersonalToken).toHaveBeenCalledWith({ marker: "runtime" }, "owner", input);
  });

  it("rejects extra fields (no caller-supplied user id, no refresh scope)", async () => {
    const client = createRouterClient(mcpTokensRouter, { context: () => session as Context });
    await expect(
      client.create({
        name: "t",
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [],
        userId: "victim",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.create({
        name: "t",
        scopes: ["offline_access"],
        toolGroups: ["read"],
        acl: [],
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Every PAT names a non-empty set of known tool groups.
    for (const toolGroups of [undefined, [], ["admin"]])
      await expect(
        client.create({ name: "t", scopes: ["mcp:read"], toolGroups, acl: [] } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mintPersonalToken).not.toHaveBeenCalled();
  });

  it("maps domain rejections without leaking detail", async () => {
    vi.mocked(mintPersonalToken).mockRejectedValue(new KbDomainError("CONFLICT", "limit"));
    vi.mocked(listPersonalTokens).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(revokePersonalToken).mockRejectedValue(new KbDomainError("NOT_FOUND", "x"));
    const client = createRouterClient(mcpTokensRouter, { context: () => session as Context });
    await expect(
      client.create({ name: "t", scopes: ["mcp:read"], toolGroups: ["read"], acl: [] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.listMine({})).resolves.toEqual({ items: [], nextCursor: null });
    await expect(client.revokeMine({ id: "tok" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
