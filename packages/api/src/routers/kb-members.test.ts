import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

// The router is the boundary that reads KB_MASTER_KEY and hands it to the library.
vi.mock("@knowledge-base/env/server", () => ({
  env: { KB_MASTER_KEY: new Secret("router-master-key-fixture") },
}));

vi.mock("../lib/kb/shares", () => ({
  shareInvite: vi.fn(async () => ({ accepted: true, requestId: "req" })),
  shareAccept: vi.fn(),
  shareList: vi.fn(async () => ({ items: [], nextCursor: null })),
  shareRevoke: vi.fn(),
  shareUpdate: vi.fn(async (_runtime, _actor, input) => ({
    shareUserId: input.shareUserId,
    bits: input.permissions,
  })),
  shareSetSealedValues: vi.fn(async (_runtime, _actor, input) => ({
    shareUserId: input.shareUserId,
    includeSealedValues: input.includeSealedValues,
  })),
  sharePermissionSchemaValues: ["read", "propose", "write", "review", "manage"],
}));

vi.mock("../lib/kb/transfer", () => ({
  transferRequest: vi.fn(),
  transferAccept: vi.fn(),
}));

import type { Session } from "@knowledge-base/auth";

import type { Context } from "../context";
import { configureKbRuntime, resetKbRuntimeForTests } from "../lib/kb/runtime";
import { shareInvite, shareSetSealedValues, shareUpdate } from "../lib/kb/shares";
import { kbMembersProcedures } from "./kb-members";

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

describe("kb-members router", () => {
  beforeEach(() => {
    resetKbRuntimeForTests();
    configureKbRuntime({
      prisma: {} as never,
      connectionString: "postgres://local/test",
      reposDir: "/tmp/repos",
      assetsDir: "/tmp/assets",
      blobStore: createDiskBlobStore("/tmp/assets"),
      canonicalOrigin: "https://kb.example.com",
      cursorSigner: { sign: () => "c", verify: () => ({ lastKey: "" }) },
      ratePort: { consume: async () => ({ ok: true }) },
      diskMeter: { freeBytes: async () => 1n },
      coordinator: {
        run: async ({ run }) =>
          run({
            lease: {} as never,
            signal: new AbortController().signal,
            issueWriteCapability: () => ({}) as never,
          }),
      },
    });
  });

  it("requires authentication", async () => {
    const client = createRouterClient(kbMembersProcedures, {
      context: () => ({ session: null }),
    });
    await expect(
      client.shareInvite({
        kbId: "kb1",
        email: "x@example.com",
        permissions: ["read"],
        idempotencyKey: "k1",
      }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("returns neutral invite output", async () => {
    const client = createRouterClient(kbMembersProcedures, {
      context: sessionContext,
    });
    await expect(
      client.shareInvite({
        kbId: "kb1",
        email: "x@example.com",
        permissions: ["read"],
        idempotencyKey: "k1",
      }),
    ).resolves.toEqual({ accepted: true, requestId: "req" });
    expect(vi.mocked(shareInvite).mock.calls.at(-1)?.[3]).toBe("router-master-key-fixture");
  });

  it("passes the inviter's UI locale for the email and rejects unsupported ones", async () => {
    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await client.shareInvite({
      kbId: "kb1",
      email: "x@example.com",
      permissions: ["read"],
      idempotencyKey: "k2",
      locale: "es-MX",
    });
    expect(vi.mocked(shareInvite).mock.calls.at(-1)?.[2]).toMatchObject({ locale: "es-MX" });
    await expect(
      client.shareInvite({
        kbId: "kb1",
        email: "x@example.com",
        permissions: ["read"],
        idempotencyKey: "k3",
        locale: "fr-FR" as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("shareUpdate requires a session and validates the permission list", async () => {
    const anonymous = createRouterClient(kbMembersProcedures, {
      context: () => ({ session: null }),
    });
    await expect(
      anonymous.shareUpdate({ kbId: "kb1", shareUserId: "u2", permissions: ["read"] }),
    ).rejects.toBeInstanceOf(ORPCError);
    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await expect(
      client.shareUpdate({ kbId: "kb1", shareUserId: "u2", permissions: [] }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      client.shareUpdate({ kbId: "kb1", shareUserId: "u2", permissions: ["write"] }),
    ).resolves.toEqual({ shareUserId: "u2", bits: ["write"] });
    expect(vi.mocked(shareUpdate).mock.calls.at(-1)?.[1]).toBe("user-1");
  });

  it("shareSetSealedValues requires a session and hands the actor to the owner-only service", async () => {
    const anonymous = createRouterClient(kbMembersProcedures, {
      context: () => ({ session: null }),
    });
    await expect(
      anonymous.shareSetSealedValues({ kbId: "kb1", shareUserId: "u2", includeSealedValues: true }),
    ).rejects.toBeInstanceOf(ORPCError);
    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await expect(
      client.shareSetSealedValues({ kbId: "kb1", shareUserId: "u2", includeSealedValues: true }),
    ).resolves.toEqual({ shareUserId: "u2", includeSealedValues: true });
    expect(vi.mocked(shareSetSealedValues).mock.calls.at(-1)?.[1]).toBe("user-1");
  });
});
