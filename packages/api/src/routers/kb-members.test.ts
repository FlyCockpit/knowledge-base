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
  SIGNUP_ENABLED: false,
}));

const previewBudget = vi.hoisted(() => vi.fn(async (_key: string) => {}));
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => previewBudget }));

vi.mock("../lib/kb/shares", () => ({
  shareInvite: vi.fn(async () => ({ accepted: true, requestId: "req" })),
  shareAccept: vi.fn(),
  shareInbox: vi.fn(async () => ({ items: [], nextCursor: null })),
  shareList: vi.fn(async () => ({ items: [], nextCursor: null })),
  hasSharedKnowledgeBase: vi.fn(async () => true),
  sharePendingList: vi.fn(async () => ({ items: [], nextCursor: null })),
  shareInviteCancel: vi.fn(async () => ({ cancelled: true })),
  shareInviteResend: vi.fn(async () => ({ resent: true })),
  shareInvitePreview: vi.fn(async () => ({
    kbId: "kb1",
    kbName: "Team notes",
    inviterName: "Ana",
    bits: ["read"],
  })),
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
import { KbDomainError } from "../lib/kb/errors";
import { configureKbRuntime, resetKbRuntimeForTests } from "../lib/kb/runtime";
import {
  hasSharedKnowledgeBase,
  shareInbox,
  shareInvite,
  shareInviteCancel,
  shareInvitePreview,
  shareInviteResend,
  sharePendingList,
  shareSetSealedValues,
  shareUpdate,
} from "../lib/kb/shares";
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

  it("shareStatusMine answers for the caller only and needs a session", async () => {
    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await expect(client.shareStatusMine()).resolves.toEqual({ shared: true });
    expect(vi.mocked(hasSharedKnowledgeBase).mock.calls.at(-1)?.[1]).toBe("user-1");
    const anonymous = createRouterClient(kbMembersProcedures, {
      context: () => ({ session: null }),
    });
    await expect(anonymous.shareStatusMine()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
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
    // The server's sign-up mode decides the email's sign-up section.
    expect(vi.mocked(shareInvite).mock.calls.at(-1)?.[2]).toMatchObject({ signupOpen: false });
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

  it("pending invitations, cancel and resend require a session and hand the actor to the manage-gated services", async () => {
    const anonymous = createRouterClient(kbMembersProcedures, {
      context: () => ({ session: null }),
    });
    await expect(anonymous.sharePendingList({ kbId: "kb1" })).rejects.toBeInstanceOf(ORPCError);
    await expect(
      anonymous.shareInviteCancel({
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    await expect(
      anonymous.shareInviteResend({
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(sharePendingList).not.toHaveBeenCalled();

    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await expect(client.sharePendingList({ kbId: "kb1", limit: 51 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await client.sharePendingList({ kbId: "kb1", limit: 20, cursor: null });
    expect(vi.mocked(sharePendingList).mock.calls.at(-1)?.[1]).toBe("user-1");
    await expect(
      client.shareInviteCancel({
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
      }),
    ).resolves.toEqual({
      cancelled: true,
    });
    expect(vi.mocked(shareInviteCancel).mock.calls.at(-1)?.slice(1)).toEqual([
      "user-1",
      { kbId: "kb1", invitationId: "inv1", sentAt: "2026-11-20T10:00:00.000Z" },
    ]);
    await expect(
      client.shareInviteResend({
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "k1",
        locale: "es-MX",
      }),
    ).resolves.toEqual({ resent: true });
    expect(vi.mocked(shareInviteResend).mock.calls.at(-1)?.slice(1)).toEqual([
      "user-1",
      {
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "k1",
        locale: "es-MX",
        signupOpen: false,
      },
    ]);
    await expect(
      client.shareInviteResend({
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "bad key",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("requires the listed sentAt on cancel and resend", async () => {
    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await expect(
      client.shareInviteCancel({ kbId: "kb1", invitationId: "inv1" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.shareInviteResend({
        kbId: "kb1",
        invitationId: "inv1",
        idempotencyKey: "k2",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps a cancel of a non-pending invitation to NOT_FOUND", async () => {
    vi.mocked(shareInviteCancel).mockRejectedValueOnce(new KbDomainError("NOT_FOUND", "Not found"));
    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await expect(
      client.shareInviteCancel({
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("previews an invitation for the signed-in user under its own read budget", async () => {
    const anonymous = createRouterClient(kbMembersProcedures, {
      context: () => ({ session: null }),
    });
    const requestId = "11111111-1111-4111-8111-111111111111";
    await expect(anonymous.shareInvitePreview({ requestId })).rejects.toBeInstanceOf(ORPCError);
    const client = createRouterClient(kbMembersProcedures, { context: sessionContext });
    await expect(client.shareInvitePreview({ requestId: "not-a-uuid" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client.shareInvitePreview({ requestId })).resolves.toEqual({
      kbId: "kb1",
      kbName: "Team notes",
      inviterName: "Ana",
      bits: ["read"],
    });
    expect(previewBudget).toHaveBeenLastCalledWith("user-1");
    expect(vi.mocked(shareInvitePreview).mock.calls.at(-1)?.slice(1)).toEqual([
      "user-1",
      { requestId },
    ]);
    vi.mocked(shareInvitePreview).mockRejectedValueOnce(
      new KbDomainError("NOT_FOUND", "Not found"),
    );
    await expect(client.shareInvitePreview({ requestId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Over budget: refused before the lookup runs.
    const calls = vi.mocked(shareInvitePreview).mock.calls.length;
    previewBudget.mockRejectedValueOnce(new ORPCError("TOO_MANY_REQUESTS"));
    await expect(client.shareInvitePreview({ requestId })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(vi.mocked(shareInvitePreview).mock.calls.length).toBe(calls);
  });

  describe("recipient invitation inbox", () => {
    it("uses the authenticated recipient and bounded default page", async () => {
      const client = createRouterClient(kbMembersProcedures, { context: sessionContext() });
      await expect(client.shareInbox({})).resolves.toEqual({ items: [], nextCursor: null });
      expect(shareInbox).toHaveBeenLastCalledWith(expect.anything(), "user-1", { limit: 20 });
    });

    it("rejects oversized pages and malformed cursors", async () => {
      const client = createRouterClient(kbMembersProcedures, { context: sessionContext() });
      await expect(client.shareInbox({ limit: 101 })).rejects.toThrow();
      await expect(client.shareInbox({ cursor: "not-a-cursor" })).rejects.toThrow();
    });

    it("requires an authenticated recipient", async () => {
      const client = createRouterClient(kbMembersProcedures, {
        context: { ...sessionContext(), session: null },
      });
      await expect(client.shareInbox({})).rejects.toThrow();
    });
  });
});
