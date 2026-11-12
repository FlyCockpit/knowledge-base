import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @knowledge-base/auth at the module boundary so the gate reads session
// resolution from a stub instead of touching the real Better-Auth instance
// (which would otherwise try to connect to Postgres on import).
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
const { apiReferenceAdminGate } = await import("./api-reference-admin-gate");

const db = prisma as unknown as {
  appSetting: { findMany: ReturnType<typeof vi.fn> };
};

describe("apiReferenceAdminGate", () => {
  let app: Hono;
  // Sentinel — if the gate calls next() the downstream handler runs and we
  // return 200 with a payload the test can assert on. This stands in for the
  // OpenAPI reference page served by the oRPC handler in index.ts.
  const downstream = vi.fn((c: Context) => c.json({ ok: true }));

  beforeEach(() => {
    getSession.mockReset();
    db.appSetting.findMany.mockResolvedValue([]);
    // Force-2FA settings are TTL-cached in-process; reset between tests.
    invalidateForceTwoFactorSettingsCache();
    downstream.mockClear();
    app = new Hono();
    app.use("/api-reference/*", apiReferenceAdminGate);
    app.all("/api-reference/*", downstream);
  });

  it("404s unauthenticated callers (not 401) so the page isn't enumerable", async () => {
    getSession.mockResolvedValue(null);
    const res = await app.request("/api-reference/");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("404s signed-in non-admin callers (not 403)", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", role: "user", emailVerified: true } });
    const res = await app.request("/api-reference/");
    expect(res.status).toBe(404);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("404s unverified admins", async () => {
    getSession.mockResolvedValue({ user: { id: "admin-1", role: "admin", emailVerified: false } });
    const res = await app.request("/api-reference/");
    expect(res.status).toBe(404);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("404s a getSession failure (treated as unauthenticated)", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    const res = await app.request("/api-reference/");
    expect(res.status).toBe(404);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("admits a verified admin and lets the reference page render", async () => {
    getSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin", emailVerified: true, twoFactorEnabled: true },
    });
    const res = await app.request("/api-reference/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it("404s an admin without required 2FA", async () => {
    getSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin", emailVerified: true, twoFactorEnabled: false },
    });
    db.appSetting.findMany.mockResolvedValue([{ key: "force2faInternalUsers", value: "true" }]);
    const res = await app.request("/api-reference/");
    expect(res.status).toBe(404);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("404s an admin without 2FA once the enrollment grace window has closed", async () => {
    getSession.mockResolvedValue({
      user: {
        id: "admin-1",
        role: "admin",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: new Date("2025-01-01"),
      },
    });
    db.appSetting.findMany.mockResolvedValue([]);
    const res = await app.request("/api-reference/");
    expect(res.status).toBe(404);
    expect(downstream).not.toHaveBeenCalled();
  });
});
