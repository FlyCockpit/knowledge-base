import type { Session } from "@knowledge-base/auth";
import { createRouterClient } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { oauthClientsRouter } from "./oauth-clients";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@knowledge-base/env/server", () => ({ env: {}, ADMIN_EMAIL: undefined }));
const { default: prisma } = await import("@knowledge-base/db");
const db = prisma as unknown as {
  $queryRaw: MockInstance;
  $transaction: MockInstance;
  oauthClient: { findMany: MockInstance; findUnique: MockInstance; delete: MockInstance };
  mcpGrant: { groupBy: MockInstance; findMany: MockInstance; updateMany: MockInstance };
  auditEvent: { create: MockInstance };
  oauthAccessToken: { deleteMany: MockInstance };
  oauthRefreshToken: { deleteMany: MockInstance };
  oauthConsent: { deleteMany: MockInstance };
  oauthClientResource: { deleteMany: MockInstance };
};
function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };
  db.$queryRaw.mockResolvedValue([
    {
      role: "admin",
      emailVerified: true,
      banned: false,
      banExpires: null,
      twoFactorEnabled: true,
      createdAt: new Date(),
      ...sessionOverride?.user,
    },
  ]);
  return {
    session: {
      user: {
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role: "admin",
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "admin-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

describe("oauth clients admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  });
  it("denies non-admin callers", async () => {
    const client = createRouterClient(oauthClientsRouter, {
      context: buildContext({ user: { role: "user" } }),
    });
    await expect(client.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.oauthClient.findMany).not.toHaveBeenCalled();
  });
  it("pages only safe fields and counts grants for returned clients", async () => {
    const row = {
      id: "one",
      clientId: "client",
      name: null,
      createdAt: new Date(),
      updatedAt: null,
      disabled: false,
      userId: null,
      redirectUris: [],
      _count: { oauthAccessTokens: 1, oauthRefreshTokens: 2, oauthConsents: 0 },
    };
    db.oauthClient.findMany.mockResolvedValue([row, { ...row, id: "two", clientId: "other" }]);
    db.mcpGrant.groupBy.mockResolvedValue([{ clientId: "client", _count: { _all: 3 } }]);
    const client = createRouterClient(oauthClientsRouter, { context: buildContext() });
    const result = await client.list({ limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeTruthy();
    expect(result.items[0]).toMatchObject({ dynamic: true, activeGrantCount: 3 });
    const query = db.oauthClient.findMany.mock.calls[0][0];
    expect(query.take).toBe(2);
    expect(query.select).not.toHaveProperty("clientSecret");
    expect(query.select).not.toHaveProperty("jwks");
    expect(query.select).not.toHaveProperty("softwareStatement");
    expect(db.mcpGrant.groupBy.mock.calls[0][0].where).toEqual({
      clientId: { in: ["client"] },
      revokedAt: null,
    });
  });
  it("revokes active grants and deletes artifacts in the live authority transaction", async () => {
    db.oauthClient.findUnique.mockResolvedValue({ clientId: "client" });
    db.mcpGrant.findMany.mockResolvedValue([{ id: "grant-one", userId: "owner" }]);
    let inTransaction = false;
    db.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await fn(prisma);
      } finally {
        inTransaction = false;
      }
    });
    db.auditEvent.create.mockImplementation(async () => {
      expect(inTransaction).toBe(true);
    });
    const client = createRouterClient(oauthClientsRouter, { context: buildContext() });
    await expect(client.delete({ id: "one" })).resolves.toEqual({
      deleted: true,
      clientId: "client",
    });
    expect(db.mcpGrant.findMany).toHaveBeenCalledWith({
      where: { clientId: "client", revokedAt: null },
      select: { id: true, userId: true },
      orderBy: { id: "asc" },
      take: 100,
    });
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: { clientId: "client", revokedAt: null, id: { in: ["grant-one"] } },
      data: { revokedAt: expect.any(Date), revokeReason: "admin_client_deleted" },
    });
    expect(db.auditEvent.create).toHaveBeenCalledWith({
      data: {
        opId: expect.any(String),
        action: "grant_revoke",
        outcome: "SUCCESS",
        actorKey: "user:admin-user-id",
        actorUserIdSnapshot: "admin-user-id",
        actorUserId: "admin-user-id",
        grantIdSnapshot: "grant-one",
        metadata: { reasonCode: "admin_client_deleted" },
      },
    });
    for (const model of [
      db.oauthAccessToken,
      db.oauthRefreshToken,
      db.oauthConsent,
      db.oauthClientResource,
    ])
      expect(model.deleteMany).toHaveBeenCalledWith({ where: { clientId: "client" } });
    expect(db.oauthClient.delete).toHaveBeenCalledWith({ where: { id: "one" } });
  });
  it("deletes a client with no active grants without an audit event", async () => {
    db.oauthClient.findUnique.mockResolvedValue({ clientId: "client" });
    db.mcpGrant.findMany.mockResolvedValue([]);
    const client = createRouterClient(oauthClientsRouter, { context: buildContext() });
    await expect(client.delete({ id: "one" })).resolves.toEqual({
      deleted: true,
      clientId: "client",
    });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(db.auditEvent.create).not.toHaveBeenCalled();
    expect(db.oauthClient.delete).toHaveBeenCalledWith({ where: { id: "one" } });
  });
  it("returns 404 for a missing client", async () => {
    db.oauthClient.findUnique.mockResolvedValue(null);
    const client = createRouterClient(oauthClientsRouter, { context: buildContext() });
    await expect(client.delete({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.mcpGrant.updateMany).not.toHaveBeenCalled();
  });
});
