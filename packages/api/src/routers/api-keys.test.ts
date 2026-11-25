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
vi.mock("../lib/api-keys", async (original) => ({
  ...(await original<typeof import("../lib/api-keys")>()),
  mintApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
  listApiKeyChildrenForOwner: vi.fn(),
  revokeApiKeyChild: vi.fn(),
  revokeApiKeyChildrenForOwner: vi.fn(),
}));

import {
  listApiKeyChildrenForOwner,
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  revokeApiKeyChild,
  revokeApiKeyChildrenForOwner,
} from "../lib/api-keys";
import { KbDomainError } from "../lib/kb/errors";
import { apiKeysRouter } from "./api-keys";

const session = { session: { user: { id: "owner", role: "user", twoFactorEnabled: true } } };
const keyId = "a".repeat(24);
const mintInput = { name: "automation", reach: "created" as const, bits: ["read" as const] };
const domain = [
  mintApiKey,
  listApiKeys,
  revokeApiKey,
  listApiKeyChildrenForOwner,
  revokeApiKeyChild,
  revokeApiKeyChildrenForOwner,
];

describe("apiKeys router (human control plane only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exposes exactly the owner's key management", () => {
    expect(Object.keys(apiKeysRouter).sort()).toEqual([
      "create",
      "listChildrenMine",
      "listMine",
      "revokeChildMine",
      "revokeChildrenMine",
      "revokeMine",
    ]);
  });

  it("rejects anonymous and bearer-only (kbk_/kbp_) callers before any domain call", async () => {
    for (const authorization of [undefined, "Bearer kbk_x", "Bearer kbp_x"]) {
      const context = {
        session: null,
        ...(authorization ? { headers: new Headers({ authorization }) } : {}),
      };
      const client = createRouterClient(apiKeysRouter, { context: () => context as Context });
      await expect(client.create(mintInput)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(client.listMine({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(client.revokeMine({ id: keyId })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(client.listChildrenMine({ apiKeyId: keyId })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(
        client.revokeChildMine({ apiKeyId: keyId, tokenId: "b".repeat(24) }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(client.revokeChildrenMine({ apiKeyId: keyId })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    for (const fn of domain) expect(fn).not.toHaveBeenCalled();
  });

  it("requires the forced second factor for minting", async () => {
    const client = createRouterClient(apiKeysRouter, {
      context: () =>
        ({
          session: {
            user: { id: "admin", role: "admin", twoFactorEnabled: false, createdAt: new Date(0) },
          },
        }) as Context,
    });
    await expect(client.create(mintInput)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mintApiKey).not.toHaveBeenCalled();
  });

  it("acts for the session user only and never takes a caller-supplied user", async () => {
    vi.mocked(mintApiKey).mockResolvedValue({ key: { id: keyId } as never, secret: "kbk_secret" });
    vi.mocked(listApiKeyChildrenForOwner).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(revokeApiKeyChild).mockResolvedValue({ id: "t", revoked: true });
    const client = createRouterClient(apiKeysRouter, { context: () => session as Context });
    await expect(client.create(mintInput)).resolves.toMatchObject({ secret: "kbk_secret" });
    expect(mintApiKey).toHaveBeenCalledWith({ marker: "runtime" }, "owner", mintInput);
    await client.listChildrenMine({ apiKeyId: keyId, limit: 5 });
    expect(listApiKeyChildrenForOwner).toHaveBeenCalledWith({ marker: "runtime" }, "owner", keyId, {
      limit: 5,
    });
    await client.revokeChildMine({ apiKeyId: keyId, tokenId: "b".repeat(24) });
    expect(revokeApiKeyChild).toHaveBeenCalledWith(
      { marker: "runtime" },
      { userId: "owner", apiKeyId: keyId },
      "b".repeat(24),
    );
    await expect(client.create({ ...mintInput, userId: "victim" } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client.revokeMine({ id: "not-a-key-id" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      client.listChildrenMine({ apiKeyId: keyId, userId: "victim" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mintApiKey).toHaveBeenCalledTimes(1);
  });

  it("revokeMine passes revokeChildren (omitted = the key's own setting); revokeChildrenMine revokes one key's children", async () => {
    vi.mocked(revokeApiKey).mockResolvedValue({ id: keyId, revoked: true, children: 0 });
    vi.mocked(revokeApiKeyChildrenForOwner).mockResolvedValue({ id: keyId, children: 2 });
    const client = createRouterClient(apiKeysRouter, { context: () => session as Context });
    for (const revokeChildren of [true, false, undefined]) {
      await client.revokeMine({ id: keyId, revokeChildren });
      expect(revokeApiKey).toHaveBeenLastCalledWith({ marker: "runtime" }, "owner", keyId, {
        revokeChildren,
      });
    }
    await expect(
      client.revokeMine({ id: keyId, revokeChildren: "yes" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.revokeChildrenMine({ apiKeyId: keyId })).resolves.toEqual({
      id: keyId,
      children: 2,
    });
    expect(revokeApiKeyChildrenForOwner).toHaveBeenCalledWith(
      { marker: "runtime" },
      "owner",
      keyId,
    );
    await expect(
      client.revokeChildrenMine({ apiKeyId: keyId, userId: "victim" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.revokeChildrenMine({ apiKeyId: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(revokeApiKeyChildrenForOwner).toHaveBeenCalledTimes(1);
  });

  it("maps domain rejections without leaking detail", async () => {
    vi.mocked(mintApiKey).mockRejectedValue(new KbDomainError("QUOTA_EXCEEDED", "limit"));
    vi.mocked(revokeApiKey).mockRejectedValue(new KbDomainError("NOT_FOUND", "x"));
    const client = createRouterClient(apiKeysRouter, { context: () => session as Context });
    await expect(client.create(mintInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Credential operation unavailable",
    });
    await expect(client.revokeMine({ id: keyId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
