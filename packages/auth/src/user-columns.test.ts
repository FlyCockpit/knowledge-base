import { describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import {
  ADMIN_CREATE_USER_PATH,
  sanitizeUserCreateData,
  sanitizeUserUpdateData,
} from "./user-columns";

// The real auth config's create hook, with import-time IO mocked as in
// prisma-schema-parity.test.ts.
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://kb.example.test",
    PUBLIC_APP_URL: "https://kb.example.test",
    BETTER_AUTH_SECRET: new Secret("user-columns-fixture-secret-user-columns"),
    CORS_ORIGIN: "",
  },
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
  FORCE_SSO: false,
}));
vi.mock("@knowledge-base/mailer", () => ({
  isEmailConfigured: () => false,
  renderResetPassword: vi.fn(),
  renderTwoFactorOtp: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));
vi.mock("@knowledge-base/db", () => {
  const delegate = new Proxy(
    {},
    {
      get: (_target, method) =>
        method === "then"
          ? undefined
          : async () => (method === "findMany" ? [] : method === "count" ? 0 : null),
    },
  );
  return {
    default: new Proxy({}, { get: (_target, prop) => (prop === "then" ? undefined : delegate) }),
  };
});

const smuggled = {
  id: "chosen-id",
  createdAt: new Date("2099-01-01"),
  updatedAt: new Date("2099-01-01"),
  twoFactorEnabled: true,
  twoFactorGraceStartedAt: new Date("2099-01-01"),
  operationalAlerts: false,
  somethingCustom: "x",
};

describe("server-owned user columns", () => {
  it("create keeps only identity/profile fields and sets server-owned ones", () => {
    const now = new Date("2026-10-24T00:00:00Z");
    const out = sanitizeUserCreateData(
      {
        ...smuggled,
        name: "Ann",
        email: "ann@example.test",
        emailVerified: true,
        image: null,
        role: "user",
        banned: false,
        locale: "es-MX",
      },
      now,
    );
    expect(out).toEqual({
      name: "Ann",
      email: "ann@example.test",
      emailVerified: true,
      image: null,
      role: "user",
      banned: false,
      locale: "es-MX",
      createdAt: now,
      updatedAt: now,
      twoFactorEnabled: false,
    });
  });

  it("update never writes id, createdAt or the grace start", () => {
    expect(
      sanitizeUserUpdateData({
        id: "x",
        createdAt: new Date("2099-01-01"),
        twoFactorGraceStartedAt: new Date("2099-01-01"),
        role: "admin",
        twoFactorEnabled: true,
        emailVerified: true,
      }),
    ).toEqual({ role: "admin", twoFactorEnabled: true, emailVerified: true });
  });

  it("the auth create hook makes admin-created accounts unverified, and only those", async () => {
    const { auth } = await import("./index");
    const before = auth.options.databaseHooks?.user?.create?.before;
    if (!before) throw new Error("missing user.create.before hook");
    const user = { name: "Ann", email: "ann@example.test", emailVerified: true };
    const admin = await before(user as never, { path: ADMIN_CREATE_USER_PATH } as never);
    expect(admin && typeof admin === "object" && admin.data.emailVerified).toBe(false);
    const sso = await before(user as never, { path: "/oauth2/callback/sso" } as never);
    expect(sso && typeof sso === "object" && sso.data.emailVerified).toBe(true);
  });
});
