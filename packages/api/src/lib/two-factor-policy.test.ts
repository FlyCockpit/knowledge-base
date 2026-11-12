import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@knowledge-base/db");
const { invalidateForceTwoFactorSettingsCache, isTwoFactorPolicySatisfied } = await import(
  "./two-factor-policy"
);

const db = prisma as unknown as {
  appSetting: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};
const DAY = 86_400_000;

describe("isTwoFactorPolicySatisfied", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateForceTwoFactorSettingsCache();
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faPublicUsers", value: "true" }]);
  });

  const stale = {
    id: "user-1",
    role: "user",
    twoFactorEnabled: false,
    createdAt: new Date(Date.now() - 10 * DAY),
    twoFactorGraceStartedAt: null,
  };

  it("re-reads the live row when a cached snapshot predates the grace start", async () => {
    db.user.findUnique.mockResolvedValue({ ...stale, twoFactorGraceStartedAt: new Date() });
    await expect(isTwoFactorPolicySatisfied(stale)).resolves.toBe(true);
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
  });

  it("still refuses when the live row has no grace left", async () => {
    db.user.findUnique.mockResolvedValue(stale);
    await expect(isTwoFactorPolicySatisfied(stale)).resolves.toBe(false);
  });

  it("never reads the row when the snapshot already satisfies the policy", async () => {
    await expect(
      isTwoFactorPolicySatisfied({ ...stale, twoFactorGraceStartedAt: new Date() }),
    ).resolves.toBe(true);
    await expect(isTwoFactorPolicySatisfied({ ...stale, twoFactorEnabled: true })).resolves.toBe(
      true,
    );
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses an id-less or vanished user", async () => {
    await expect(isTwoFactorPolicySatisfied({ ...stale, id: undefined })).resolves.toBe(false);
    db.user.findUnique.mockResolvedValue(null);
    await expect(isTwoFactorPolicySatisfied(stale)).resolves.toBe(false);
  });

  it("refuses when the cached role differs from the live row (demotion in the cache window)", async () => {
    // Unenrolled admin past grace, cached as admin; live row already demoted
    // to an unforced public user. The live policy for "user" would pass, but
    // the caller is about to authorize the cached admin role.
    db.appSetting.findMany.mockResolvedValue([]);
    const cachedAdmin = { ...stale, role: "admin" };
    db.user.findUnique.mockResolvedValue({ ...stale, role: "user" });
    await expect(isTwoFactorPolicySatisfied(cachedAdmin)).resolves.toBe(false);
  });
});
