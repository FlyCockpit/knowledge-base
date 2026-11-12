import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "./index";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

vi.mock("@knowledge-base/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://api.example.test",
    PUBLIC_APP_URL: "https://web.example.test",
    BETTER_AUTH_SECRET: new Secret("sso-unit-fixture-secret-sso-unit-fixture-secret"),
    CORS_ORIGIN: "https://web.example.test",
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
          : vi.fn(async () => (method === "findMany" ? [] : method === "count" ? 0 : null)),
    },
  );
  return {
    default: new Proxy({}, { get: (_target, prop) => (prop === "then" ? undefined : delegate) }),
  };
});

async function fixture() {
  const base = await auth.$context;
  const now = new Date();
  const data = {
    user: {
      id: "user",
      email: "user@example.test",
      emailVerified: true,
      name: "User",
      createdAt: now,
      updatedAt: now,
      twoFactorEnabled: true,
      locale: "es-MX",
    },
    session: {
      id: "session",
      userId: "user",
      token: "new-session-token",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
      updatedAt: now,
    },
  };
  const deleteSession = vi.fn(async (_token: string) => {});
  const createVerificationValue = vi.fn(base.internalAdapter.createVerificationValue);
  createVerificationValue.mockImplementation(async (input) => ({
    ...input,
    id: "verification",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }));
  const findVerificationValue = vi.fn(base.internalAdapter.findVerificationValue);
  findVerificationValue.mockResolvedValue(null);
  const deleteVerificationByIdentifier = vi.fn(async (_identifier: string) => {});
  const findOne = vi.fn(base.adapter.findOne);
  findOne.mockResolvedValue(null);
  const context = {
    ...base,
    newSession: data as typeof base.newSession,
    responseHeaders: new Headers({ location: "https://web.example.test/es-MX/dashboard?tab=kb" }),
    internalAdapter: {
      ...base.internalAdapter,
      deleteSession,
      createVerificationValue,
      findVerificationValue,
      deleteVerificationByIdentifier,
    },
    adapter: { ...base.adapter, findOne },
    setNewSession: vi.fn((value: typeof base.newSession) => {
      context.newSession = value;
    }),
  };
  context.responseHeaders.append("set-cookie", `${base.authCookies.sessionToken.name}=live-token`);
  context.responseHeaders.append("set-cookie", `${base.authCookies.sessionData.name}=live-cache`);
  const run = (path = "/callback/:id", id = "sso", cookie = "") => {
    const input = {
      path,
      params: { id },
      headers: new Headers({ cookie }),
      context,
      returnHeaders: true,
    };
    const result: Promise<unknown> = auth.options.hooks.after(input);
    return result;
  };
  return {
    context,
    data,
    run,
    deleteSession,
    createVerificationValue,
    findVerificationValue,
    deleteVerificationByIdentifier,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("SSO second-factor after hook", () => {
  it("replaces the callback redirect and scrubs session cookies through the HTTP hook pipeline", async () => {
    const f = await fixture();
    const callbackAuth = betterAuth({
      baseURL: "https://api.example.test",
      secret: f.context.secret,
      database: auth.options.database,
      advanced: auth.options.advanced,
      hooks: { after: auth.options.hooks.after },
      plugins: [
        {
          id: "callback-fixture",
          endpoints: {
            callbackOAuth: createAuthEndpoint("/callback/:id", { method: "GET" }, async (ctx) => {
              ctx.context.setNewSession(f.data);
              ctx.setCookie(ctx.context.authCookies.sessionToken.name, "live-token");
              ctx.setCookie(ctx.context.authCookies.sessionData.name, "live-cache");
              throw ctx.redirect("https://web.example.test/es-MX/dashboard");
            }),
          },
        },
      ],
    });
    const context = await callbackAuth.$context;
    context.internalAdapter.deleteSession = f.deleteSession;
    context.internalAdapter.createVerificationValue = f.createVerificationValue;
    context.adapter.findOne = vi.fn(async () => null);
    const response = await callbackAuth.handler(
      new Request("https://api.example.test/api/auth/callback/sso"),
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/es-MX/login");
    const cookies = response.headers.getSetCookie();
    expect(
      cookies.some((cookie) => cookie.includes("live-token") || cookie.includes("live-cache")),
    ).toBe(false);
    expect(cookies.some((cookie) => cookie.includes(".two_factor="))).toBe(true);
    expect(f.deleteSession).toHaveBeenCalledExactlyOnceWith("new-session-token");
  });

  it("deletes the new session, clears its cookies, and creates a signed plugin challenge", async () => {
    const f = await fixture();
    const before = Date.now();
    const error = await f.run().catch((error: unknown) => error);
    expect(error).toMatchObject({ statusCode: 302 });
    if (!(error instanceof Error) || !("headers" in error)) throw new Error("Expected redirect");
    const headers = new Headers(error.headers as Headers);
    const target = new URL(headers.get("location")!);
    expect(target.origin + target.pathname).toBe("https://web.example.test/es-MX/login");
    expect(target.searchParams.get("twoFactor")).toBe("true");
    expect(target.searchParams.get("redirectTo")).toBe("/es-MX/dashboard?tab=kb");
    expect(f.deleteSession).toHaveBeenCalledExactlyOnceWith("new-session-token");
    expect(f.context.newSession).toBeNull();
    expect(f.createVerificationValue).toHaveBeenCalledTimes(2);
    const pending = f.createVerificationValue.mock.calls[0]![0];
    expect(pending).toMatchObject({ value: "user", identifier: expect.stringMatching(/^2fa-/) });
    expect(pending.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(f.createVerificationValue.mock.calls[1]![0]).toMatchObject({
      value: "0",
      identifier: `2fa-attempts-${pending.identifier}`,
      expiresAt: pending.expiresAt,
    });
    const cookies = [...f.context.responseHeaders.getSetCookie(), ...headers.getSetCookie()];
    expect(
      cookies.some((cookie) => cookie.includes("live-token") || cookie.includes("live-cache")),
    ).toBe(false);
    for (const name of [
      f.context.authCookies.sessionToken.name,
      f.context.authCookies.sessionData.name,
    ])
      expect(
        cookies.some((cookie) => cookie.startsWith(`${name}=`) && cookie.includes("Max-Age=0")),
      ).toBe(true);
    const pendingCookie = cookies.find((cookie) => cookie.includes(".two_factor="))!;
    expect(pendingCookie).toContain("Max-Age=600");
    expect(pendingCookie).toContain("HttpOnly");
    expect(pendingCookie).toContain("Secure");
    expect(pendingCookie).toContain("SameSite=None");
    const inspect = createAuthMiddleware(async (ctx) =>
      ctx.getSignedCookie(ctx.context.createAuthCookie("two_factor").name, ctx.context.secret),
    );
    const inspectInput = {
      context: f.context,
      headers: new Headers({ cookie: pendingCookie.split(";")[0]! }),
    };
    await expect(inspect(inspectInput)).resolves.toBe(pending.identifier);
  });

  it.each(["/sign-in/email", "/two-factor/verify-totp", "/oauth2/authorize"])(
    "leaves %s unchanged",
    async (path) => {
      const f = await fixture();
      await f.run(path);
      expect(f.deleteSession).not.toHaveBeenCalled();
      expect(f.createVerificationValue).not.toHaveBeenCalled();
      expect(f.context.newSession).toBe(f.data);
    },
  );

  it("leaves other providers, unenrolled users, and callbacks without a new session unchanged", async () => {
    const f = await fixture();
    await f.run("/callback/:id", "other");
    f.data.user.twoFactorEnabled = false;
    await f.run();
    f.context.newSession = null;
    await f.run();
    expect(f.deleteSession).not.toHaveBeenCalled();
    expect(f.createVerificationValue).not.toHaveBeenCalled();
  });

  it.each([
    ["es-MX", "es-MX"],
    ["unsupported", "en-US"],
  ])("uses locale %s and a local dashboard for a foreign callback", async (locale, lang) => {
    const f = await fixture();
    f.data.user.locale = locale;
    f.context.responseHeaders.set("location", "https://foreign.example/es-MX/private");
    const error = await f.run().catch((error: unknown) => error);
    expect(error).toMatchObject({
      headers: expect.objectContaining({}),
      statusCode: 302,
    });
    if (!(error instanceof Error) || !("headers" in error)) throw new Error("Expected redirect");
    const target = new URL(new Headers(error.headers as Headers).get("location")!);
    expect(target.pathname).toBe(`/${lang}/login`);
    expect(target.searchParams.get("redirectTo")).toBe(`/${lang}/dashboard`);
  });

  it.each(["valid", "expired", "wrong-user", "forged"])(
    "checks a %s trusted device",
    async (kind) => {
      const f = await fixture();
      const trustId = "trust-device-fixture";
      f.findVerificationValue.mockResolvedValue({
        id: "verification",
        identifier: trustId,
        value: kind === "wrong-user" ? "other" : "user",
        expiresAt: new Date(Date.now() + (kind === "expired" ? -60_000 : 60_000)),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const token = createHmac("sha256", f.context.secret)
        .update(`user!${trustId}`)
        .digest("base64url");
      const sign = createAuthMiddleware(async (ctx) => {
        const cookie = ctx.context.createAuthCookie("trust_device");
        await ctx.setSignedCookie(
          cookie.name,
          `${kind === "forged" ? "forged" : token}!${trustId}`,
          ctx.context.secret,
          cookie.attributes,
        );
      });
      const signInput = { context: f.context, returnHeaders: true };
      const signed: unknown = await sign(signInput);
      if (
        !signed ||
        typeof signed !== "object" ||
        !("headers" in signed) ||
        !(signed.headers instanceof Headers)
      )
        throw new Error("Expected cookie headers");
      const result = await f
        .run("/callback/:id", "sso", signed.headers.getSetCookie()[0]!.split(";")[0])
        .catch((error: unknown) => error);
      if (kind !== "valid") {
        expect(result).toMatchObject({ statusCode: 302 });
        expect(f.deleteSession).toHaveBeenCalledExactlyOnceWith("new-session-token");
        expect(f.context.newSession).toBeNull();
        expect(f.createVerificationValue).toHaveBeenCalledWith(
          expect.objectContaining({
            identifier: expect.stringMatching(/^2fa-/),
            value: "user",
          }),
        );
        return;
      }
      if (
        !result ||
        typeof result !== "object" ||
        !("headers" in result) ||
        !(result.headers instanceof Headers)
      )
        throw new Error("Expected hook headers");
      expect(f.deleteSession).not.toHaveBeenCalled();
      expect(f.context.newSession).toBe(f.data);
      expect(f.deleteVerificationByIdentifier).toHaveBeenCalledWith(trustId);
      expect(f.createVerificationValue).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          identifier: expect.stringMatching(/^trust-device-/),
          value: "user",
        }),
      );
      expect(
        result.headers.getSetCookie().some((cookie) => cookie.includes(".trust_device=")),
      ).toBe(true);
    },
  );
});

describe("ID-token social sign-in guard", () => {
  const post = (body: unknown) =>
    auth.handler(
      new Request("https://api.example.test/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://web.example.test" },
        body: JSON.stringify(body),
      }),
    );

  it("refuses ID-token sign-in before any provider verification", async () => {
    const response = await post({ provider: "sso", idToken: { token: "header.payload.sig" } });
    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not refuse the redirect form of social sign-in", async () => {
    const response = await post({ provider: "sso", callbackURL: "/en-US/dashboard" });
    expect(response.status).not.toBe(403);
  });
});
