import { getAdminMutationActor } from "@knowledge-base/auth/session-authority";
import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep<typeof import("@knowledge-base/db").default>();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@knowledge-base/auth", () => ({
  auth: {
    api: {
      get getSession() {
        return getSession;
      },
    },
  },
}));

const { default: prisma } = await import("@knowledge-base/db");
const { invalidateForceTwoFactorSettingsCache } = await import(
  "@knowledge-base/api/lib/two-factor-policy"
);
const { betterAuthAdminGate } = await import("./better-auth-admin-gate");

const db = prisma as unknown as {
  appSetting: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

describe("betterAuthAdminGate", () => {
  let app: Hono;
  const downstream = vi.fn((c: Context) => c.json({ ok: true }));

  beforeEach(() => {
    getSession.mockReset();
    db.appSetting.findMany.mockResolvedValue([]);
    // Force-2FA settings are TTL-cached in-process; reset between tests.
    invalidateForceTwoFactorSettingsCache();
    downstream.mockClear();
    app = new Hono();
    app.use("/api/auth/admin/*", betterAuthAdminGate);
    app.all("/api/auth/admin/set-role", downstream);
    app.all("/api/auth/admin/impersonate-user", downstream);
  });

  it("binds the verified actor only within the downstream admin request", async () => {
    getSession.mockResolvedValue({
      user: { id: "acting-admin", role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    downstream.mockImplementationOnce((c: Context) => {
      expect(getAdminMutationActor()).toBe("acting-admin");
      return c.json({ ok: true });
    });
    expect(getAdminMutationActor()).toBeUndefined();
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(200);
    expect(getAdminMutationActor()).toBeUndefined();
  });

  it("rejects unauthenticated callers with 401", async () => {
    getSession.mockResolvedValue(null);
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "unauthorized",
      error_description: "Authentication required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers before Better-Auth handles the route", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "user", emailVerified: true } });
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Verified admin access required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects unverified admins", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: false, twoFactorEnabled: true },
    });
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(403);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects admins without 2FA when admin 2FA is required", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "true" }]);
    const res = await app.request("/api/auth/admin/set-user-password", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Two-factor authentication setup is required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  // Forced admin 2FA is the absent-row default, so an established admin who
  // never enrolled is refused without anyone having written the setting.
  it("rejects an established admin without 2FA when the setting row is absent", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "a1",
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date("2025-01-01"),
      },
    });
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "access_denied",
      error_description: "Two-factor authentication setup is required",
    });
    expect(downstream).not.toHaveBeenCalled();
  });

  // The gate must forward `createdAt` to the policy, or the first admin to
  // sign up is locked out before they can reach the enrollment screen.
  it("admits a brand-new admin without 2FA while the enrollment grace window is open", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "a1",
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits verified admins when admin 2FA is explicitly not required", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "false" }]);
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("admits verified admins with 2FA when admin 2FA is required", async () => {
    getSession.mockResolvedValue({
      user: { id: "a1", role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "true" }]);
    const res = await app.request("/api/auth/admin/impersonate-user", { method: "POST" });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  // A refusal re-reads the live row, but only as one consistent snapshot.
  it.each([
    ["demoted to an unforced user inside the cache window", "user"],
    ["live row gone", null],
  ] as const)("keeps refusing a cached admin past grace when %s", async (_name, liveRole) => {
    const old = new Date("2025-01-01");
    getSession.mockResolvedValue({
      user: {
        id: "a1",
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: old,
      },
    });
    db.user.findUnique.mockResolvedValue(
      liveRole === null
        ? null
        : {
            role: liveRole,
            twoFactorEnabled: false,
            createdAt: old,
            twoFactorGraceStartedAt: null,
          },
    );
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(403);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("admits a cached admin whose live grace started after the cache snapshot", async () => {
    const old = new Date("2025-01-01");
    getSession.mockResolvedValue({
      user: {
        id: "a1",
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: old,
      },
    });
    db.user.findUnique.mockResolvedValue({
      role: "admin",
      twoFactorEnabled: false,
      createdAt: old,
      twoFactorGraceStartedAt: new Date(),
    });
    const res = await app.request("/api/auth/admin/set-role", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
