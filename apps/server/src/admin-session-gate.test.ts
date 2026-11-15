import { beforeEach, describe, expect, it, vi } from "vitest";

// The Better-Auth plugin gate maps the shared admin rule (checkAdminAuthority in
// @knowledge-base/api) to HTTP results. These are the exact results the two
// gates built on it (better-auth-admin-gate.ts, api-reference-admin-gate.ts)
// turn into responses.
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
const { requireVerifiedAdminSession } = await import("./admin-session-gate");

const db = prisma as unknown as {
  appSetting: { findMany: ReturnType<typeof vi.fn> };
};

function sessionFor(user: Record<string, unknown>) {
  return {
    user: {
      id: "u1",
      role: "admin",
      emailVerified: true,
      twoFactorEnabled: true,
      banned: false,
      banExpires: null,
      createdAt: new Date("2025-01-01"),
      ...user,
    },
    session: { id: "s1", userId: "u1" },
  };
}

const UNAUTHENTICATED = {
  ok: false,
  status: 401,
  error: "unauthorized",
  errorDescription: "Authentication required",
};
const NOT_VERIFIED_ADMIN = {
  ok: false,
  status: 403,
  error: "access_denied",
  errorDescription: "Verified admin access required",
};
const TWO_FACTOR_REQUIRED = {
  ok: false,
  status: 403,
  error: "access_denied",
  errorDescription: "Two-factor authentication setup is required",
};

describe("requireVerifiedAdminSession", () => {
  beforeEach(() => {
    getSession.mockReset();
    db.appSetting.findMany.mockResolvedValue([]);
    invalidateForceTwoFactorSettingsCache();
  });

  it("admits a verified admin with a second factor", async () => {
    const session = sessionFor({});
    getSession.mockResolvedValue(session);
    await expect(requireVerifiedAdminSession(new Headers())).resolves.toEqual({
      ok: true,
      session,
    });
  });

  it("answers 401 to no session and to a getSession failure", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireVerifiedAdminSession(new Headers())).resolves.toEqual(UNAUTHENTICATED);
    getSession.mockRejectedValue(new Error("db down"));
    await expect(requireVerifiedAdminSession(new Headers())).resolves.toEqual(UNAUTHENTICATED);
  });

  it("answers 401 to an impersonated session, even of a verified admin", async () => {
    getSession.mockResolvedValue({
      ...sessionFor({}),
      session: { id: "s1", userId: "u1", impersonatedBy: "admin-2" },
    });
    await expect(requireVerifiedAdminSession(new Headers())).resolves.toEqual(UNAUTHENTICATED);
  });

  it("resolves the session from cookies only", async () => {
    getSession.mockResolvedValue(null);
    await requireVerifiedAdminSession(
      new Headers({ authorization: "Bearer token", cookie: "session=abc" }),
    );
    const headers = getSession.mock.calls[0]?.[0]?.headers as Headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBe("session=abc");
  });

  it("refuses a banned admin, an unverified admin and a non-admin with the same 403", async () => {
    for (const user of [
      { banned: true },
      { emailVerified: false },
      { role: "user" },
      // A ban outranks the 2FA message: the ban check runs first.
      { banned: true, twoFactorEnabled: false },
      { role: "user", twoFactorEnabled: false },
    ]) {
      getSession.mockResolvedValue(sessionFor(user));
      await expect(
        requireVerifiedAdminSession(new Headers()),
        JSON.stringify(user),
      ).resolves.toEqual(NOT_VERIFIED_ADMIN);
    }
  });

  it("admits an admin whose temporary ban has lapsed", async () => {
    getSession.mockResolvedValue(
      sessionFor({ banned: true, banExpires: new Date(Date.now() - 1000) }),
    );
    await expect(requireVerifiedAdminSession(new Headers())).resolves.toMatchObject({ ok: true });
  });

  it("asks an established admin without a second factor to set one up", async () => {
    getSession.mockResolvedValue(sessionFor({ twoFactorEnabled: false }));
    await expect(requireVerifiedAdminSession(new Headers())).resolves.toEqual(TWO_FACTOR_REQUIRED);
  });

  it("reports the unverified email before the missing second factor", async () => {
    getSession.mockResolvedValue(sessionFor({ emailVerified: false, twoFactorEnabled: false }));
    await expect(requireVerifiedAdminSession(new Headers())).resolves.toEqual(NOT_VERIFIED_ADMIN);
  });
});
