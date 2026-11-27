import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("@knowledge-base/auth/ban", () => ({ settleLapsedTwoFactorMcpGrants: vi.fn() }));
const { default: prisma } = await import("@knowledge-base/db");
const { reapExpiredAuthTokens } = await import("./auth-token-retention");
const now = new Date("2026-10-31T00:00:00Z");

describe("unused OAuth client retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const model of [
      prisma.session,
      prisma.verification,
      prisma.deviceCode,
      prisma.deviceApproval,
      prisma.oauthAccessToken,
      prisma.oauthClientAssertion,
      prisma.consentIntent,
    ])
      (model.findMany as unknown as MockInstance).mockResolvedValue([]);
    (prisma.$transaction as unknown as MockInstance).mockImplementation(
      async (callback: (db: typeof prisma) => Promise<unknown>) => {
        if (typeof callback !== "function") throw new Error("expected callback");
        return callback(prisma);
      },
    );
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
  });
  it("selects and rechecks a bounded page after token and consent cleanup", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "old" }])
      .mockResolvedValueOnce([{ id: "old" }]);
    vi.mocked(prisma.oauthClient.deleteMany).mockResolvedValue({ count: 1 });
    const result = await reapExpiredAuthTokens(now);
    expect(result.deleted.oauthClients).toBe(1);
    expect(prisma.oauthClient.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old"] } } });
    const calls = vi.mocked(prisma.$queryRaw).mock.calls;
    const sql = String.raw({ raw: calls[1][0] as TemplateStringsArray });
    expect(sql).toContain('c."userId" IS NULL');
    expect(sql).toContain("'kb-cli'");
    expect(sql).toContain('COALESCE(c."updatedAt", c."createdAt") <');
    for (const table of [
      "oauth_access_token",
      "oauth_refresh_token",
      "oauth_consent",
      "mcp_grant",
      "consent_intent",
    ])
      expect(sql).toContain(table);
    expect(sql).toContain('g."clientId" = c."clientId" AND g."revokedAt" IS NULL');
    expect(sql).toContain('ci."expiresAt" >');
    expect(calls[1]).toContainEqual(new Date("2026-10-01T00:00:00Z"));
    expect(calls[1]).toContain(1000);
  });
  it("does not delete candidates that no longer qualify after locking", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "changed" }])
      .mockResolvedValueOnce([]);
    vi.mocked(prisma.oauthClient.deleteMany).mockResolvedValue({ count: 0 });
    expect((await reapExpiredAuthTokens(now)).deleted.oauthClients).toBe(0);
    expect(prisma.oauthClient.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [] } } });
  });
});
