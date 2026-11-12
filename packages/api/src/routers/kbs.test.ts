import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import type { Session } from "@knowledge-base/auth";
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("../lib/kb/bases", () => ({
  listKnowledgeBasesForViewer: vi.fn(async () => ({ items: [], nextCursor: null })),
  getKnowledgeBaseForViewer: vi.fn(),
  createKnowledgeBase: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  mapKbDomainError: vi.fn(() => null),
}));

vi.mock("../lib/kb/index-status", () => ({ getIndexProfile: vi.fn() }));

vi.mock("./kb-members", () => ({
  kbMembersProcedures: {},
}));

import type { Context } from "../context";
import {
  createKnowledgeBase,
  getKnowledgeBaseForViewer,
  listKnowledgeBasesForViewer,
  updateKnowledgeBase,
} from "../lib/kb/bases";
import { configureKbRuntime, resetKbRuntimeForTests } from "../lib/kb/runtime";
import { kbsRouter } from "./kbs";

function sessionContext(): Context {
  return {
    session: {
      user: {
        id: "user-1",
        email: "u@example.com",
        name: "U",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      session: {
        id: "s",
        userId: "user-1",
        token: "t",
        expiresAt: new Date(Date.now() + 60_000),
        ipAddress: null,
        userAgent: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as Session,
  };
}

describe("kbs router", () => {
  beforeEach(() => {
    resetKbRuntimeForTests();
    vi.mocked(listKnowledgeBasesForViewer).mockClear();
    vi.mocked(createKnowledgeBase).mockReset();
    vi.mocked(updateKnowledgeBase).mockReset();
  });

  it("requires authentication", async () => {
    const client = createRouterClient(kbsRouter, { context: () => ({ session: null }) });
    await expect(client.list()).rejects.toBeInstanceOf(ORPCError);
  });

  it("accepts scalar-boundary metadata at create and update and rejects scalar overflow", async () => {
    configureKbRuntime({} as never);
    const client = createRouterClient(kbsRouter, { context: () => sessionContext() });
    const metadata = { name: "😀".repeat(120), description: "😀".repeat(2000) };
    await client.create({ ...metadata, slug: "scalar-bound", idempotencyKey: "create-key" });
    expect(createKnowledgeBase).toHaveBeenCalledWith(expect.anything(), "user-1", {
      ...metadata,
      slug: "scalar-bound",
      idempotencyKey: "create-key",
    });
    const update = { ...metadata, kbId: "kb", metadataVersion: 1, idempotencyKey: "update-key" };
    await client.update(update);
    expect(updateKnowledgeBase).toHaveBeenCalledWith(expect.anything(), "user-1", update);
    for (const changed of [
      { name: "😀".repeat(121) },
      { description: "😀".repeat(2001) },
      { description: "😀".repeat(9) },
      { name: "unpaired\uD800" },
    ]) {
      await expect(client.update({ ...update, ...changed })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(updateKnowledgeBase).toHaveBeenCalledTimes(1);
  });

  it("rejects control-bearing metadata with the shared MCP/browser policy before the service", async () => {
    configureKbRuntime({} as never);
    const client = createRouterClient(kbsRouter, { context: () => sessionContext() });
    const input = { kbId: "kb", metadataVersion: 1, idempotencyKey: "known-key" };
    for (const changed of [
      { name: "bad\u0007name" },
      { description: "description\u0007value" },
      { description: "description\u007fvalue" },
    ]) {
      await expect(client.update({ ...input, ...changed })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    // Markdown whitespace remains permitted in descriptions.
    const permitted = { ...input, description: "description\tvalue\r\nnext" };
    await client.update(permitted);
    expect(updateKnowledgeBase).toHaveBeenCalledTimes(1);
    expect(updateKnowledgeBase).toHaveBeenCalledWith(expect.anything(), "user-1", permitted);
  });

  it("delegates list to domain service when runtime is configured", async () => {
    configureKbRuntime({
      prisma: {} as never,
      connectionString: "postgres://local/test",
      reposDir: "/tmp/repos",
      assetsDir: "/tmp/assets",
      blobStore: createDiskBlobStore("/tmp/assets"),
      canonicalOrigin: "https://kb.example.com",
      cursorSigner: {
        sign: () => "cursor",
        verify: () => {
          throw new Error("unused");
        },
      },
      ratePort: { consume: async () => ({ ok: true }) },
      diskMeter: { freeBytes: async () => 1_000_000_000n },
      coordinator: {
        run: async ({ run }) =>
          run({
            lease: {} as never,
            signal: new AbortController().signal,
            issueWriteCapability: () => ({}) as never,
          }),
      },
    });
    const client = createRouterClient(kbsRouter, { context: () => sessionContext() });
    const result = await client.list({ limit: 10 });
    expect(result.items).toEqual([]);
    // The browser list is the owner-aware one, "all" unless a relation is asked for.
    expect(listKnowledgeBasesForViewer).toHaveBeenLastCalledWith(expect.anything(), "user-1", {
      limit: 10,
      cursor: null,
      relation: "all",
    });
    await client.list({ relation: "owned" });
    expect(vi.mocked(listKnowledgeBasesForViewer).mock.lastCall?.[2]).toMatchObject({
      relation: "owned",
    });
    await client.list({ relation: "shared" });
    expect(vi.mocked(listKnowledgeBasesForViewer).mock.lastCall?.[2]).toMatchObject({
      relation: "shared",
    });
    const metadata = {
      name: "😀".repeat(120),
      description: "😀".repeat(2000),
      idempotencyKey: "metadata-boundary",
    };
    await client.create({ ...metadata, slug: "scalar-boundary" });
    await client.update({ ...metadata, kbId: "kb", metadataVersion: 1 });
    expect(createKnowledgeBase).toHaveBeenLastCalledWith(expect.anything(), "user-1", {
      ...metadata,
      slug: "scalar-boundary",
    });
    expect(updateKnowledgeBase).toHaveBeenLastCalledWith(expect.anything(), "user-1", {
      ...metadata,
      kbId: "kb",
      metadataVersion: 1,
    });
    for (const patch of [
      { name: "😀".repeat(121) },
      { description: "😀".repeat(2001) },
      { description: "description\u0000bad" },
    ]) {
      await expect(client.create({ ...metadata, ...patch, slug: "invalid" })).rejects.toMatchObject(
        { code: "BAD_REQUEST" },
      );
      await expect(
        client.update({ ...metadata, ...patch, kbId: "kb", metadataVersion: 1 }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(client.list({ relation: "everyone" as "all" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("get returns the caller-specific isOwner flag from the viewer read", async () => {
    vi.mocked(getKnowledgeBaseForViewer).mockResolvedValue({
      id: "k".repeat(24),
      isOwner: false,
      capabilities: ["read", "manage"],
    } as never);
    const kbId = "k".repeat(24);
    const { getIndexProfile } = await import("../lib/kb/index-status");
    vi.mocked(getIndexProfile).mockResolvedValue({ index: { activeGenerationId: null } } as never);
    configureKbRuntime({} as never);
    const client = createRouterClient(kbsRouter, { context: () => sessionContext() });
    const result = await client.get({ kbId });
    expect(result?.kb).toMatchObject({ isOwner: false, capabilities: ["read", "manage"] });
    expect(getKnowledgeBaseForViewer).toHaveBeenCalledWith(expect.anything(), "user-1", kbId);
  });
});
