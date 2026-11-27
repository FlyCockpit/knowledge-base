import { createHmac } from "node:crypto";
import prisma from "@knowledge-base/db";
import { captureLog } from "@knowledge-base/env/log";
import { betterAuth } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  revokeCredentialsAfterPasswordChange,
  revokeCredentialsAfterPasswordReset,
} from "./credential-revocation";
import { auth, passwordPepper } from "./index";

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
vi.mock("./credential-revocation", () => ({
  revokeCredentialsAfterPasswordChange: vi.fn(),
  revokeCredentialsAfterPasswordReset: vi.fn(),
}));
const resetLinks = vi.hoisted(() => ({ deleteMany: vi.fn() }));
const queryAuthority = vi.hoisted(() => vi.fn());

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
    default: new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "then"
            ? undefined
            : prop === "verification"
              ? resetLinks
              : prop === "$queryRaw"
                ? queryAuthority
                : delegate,
      },
    ),
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
      authorityVersion: 0,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(revokeCredentialsAfterPasswordReset).mockReset();
  vi.mocked(revokeCredentialsAfterPasswordChange).mockReset();
  resetLinks.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  queryAuthority.mockReset().mockResolvedValue([{ identity: null, authorityVersion: 0 }]);
});
afterEach(() => vi.restoreAllMocks());

/** Exercise the actual pinned reset endpoint and configured hooks, with only IO mocked. */
async function resetFixture(emailVerified = true) {
  const f = await fixture();
  const resetAuth = betterAuth({
    baseURL: "https://api.example.test",
    secret: f.context.secret,
    database: auth.options.database,
    advanced: auth.options.advanced,
    emailAndPassword: auth.options.emailAndPassword,
    hooks: { before: auth.options.hooks.before },
    logger: auth.options.logger,
  });
  const context = await resetAuth.$context;
  let tokenLive = true;
  let otherLinkLive = true;
  let password = "old-password-hash";
  let sessionLive = true;
  const verification = {
    id: "reset-verification",
    identifier: "reset-password:retry-token",
    value: f.data.user.id,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  vi.spyOn(context.internalAdapter, "findSession").mockResolvedValue(null);
  const lookup = vi
    .spyOn(context.internalAdapter, "findVerificationValue")
    .mockImplementation(async (id) =>
      id === "reset-password:other-token" && otherLinkLive
        ? { ...verification, identifier: id }
        : tokenLive && id === verification.identifier
          ? verification
          : null,
    );
  const consume = vi
    .spyOn(context.internalAdapter, "consumeVerificationValue")
    .mockImplementation(async () => {
      if (!tokenLive) return null;
      tokenLive = false;
      return verification;
    });
  vi.spyOn(context.internalAdapter, "findUserById").mockResolvedValue({
    ...f.data.user,
    emailVerified,
  });
  vi.spyOn(context.internalAdapter, "findCredentialAccount").mockResolvedValue({
    id: "account",
    userId: "user",
    providerId: "credential",
    accountId: "user",
    password,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const deleteSessions = vi
    .spyOn(context.internalAdapter, "deleteUserSessions")
    .mockImplementation(async () => {
      sessionLive = false;
    });
  const updatePassword = vi
    .spyOn(context.internalAdapter, "updatePassword")
    .mockImplementation(async (_id, hash) => {
      password = hash;
    });
  vi.spyOn(context.password, "hash").mockResolvedValue("new-password-hash");
  context.adapter.transaction = async (run) => run(context.adapter);
  const post = (token = "retry-token", query = false) =>
    resetAuth.handler(
      new Request(
        `https://api.example.test/api/auth/reset-password${query ? `?token=${token}` : ""}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://web.example.test" },
          body: JSON.stringify({
            newPassword: "long-enough-new-password",
            ...(query ? {} : { token }),
          }),
        },
      ),
    );
  return {
    post,
    lookup,
    verification,
    consume,
    deleteSessions,
    updatePassword,
    otherLinkLive: () => otherLinkLive,
    finishOtherLinks: () => {
      resetLinks.deleteMany.mockImplementation(async ({ where }) => {
        if (where.value === "user" && where.identifier.startsWith === "reset-password:")
          otherLinkLive = false;
        return { count: 1 };
      });
    },
    state: () => ({ tokenLive, password, sessionLive }),
  };
}

describe("password reset", () => {
  it("maps pre-sweep token lookup failure to 503 with the password and token intact", async () => {
    const f = await resetFixture();
    f.lookup.mockRejectedValueOnce(new Error("private verification lookup detail"));
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      message:
        "We couldn't finish securing your account. Nothing was changed — try the link again.",
    });
    expect(f.state()).toEqual({
      tokenLive: true,
      password: "old-password-hash",
      sessionLive: true,
    });
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.updatePassword).not.toHaveBeenCalled();
    expect(f.deleteSessions).not.toHaveBeenCalled();
    expect(revokeCredentialsAfterPasswordReset).not.toHaveBeenCalled();
    expect((await f.post()).status).toBe(200);
  });

  it("refuses before password/token/session writes on revocation failure; the SAME link retries", async () => {
    const f = await resetFixture();
    vi.mocked(revokeCredentialsAfterPasswordReset).mockRejectedValueOnce(
      new Error("private database detail"),
    );
    const first = await f.post();
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({
      message:
        "We couldn't finish securing your account. Nothing was changed — try the link again.",
    });
    expect(f.state()).toEqual({
      tokenLive: true,
      password: "old-password-hash",
      sessionLive: true,
    });
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.updatePassword).not.toHaveBeenCalled();
    expect(f.deleteSessions).not.toHaveBeenCalled();
    expect((await f.post()).status).toBe(200);
    expect(f.state()).toEqual({
      tokenLive: false,
      password: "new-password-hash",
      sessionLive: false,
    });
    expect(revokeCredentialsAfterPasswordReset).toHaveBeenCalledTimes(3);
  });

  it.each(["invalid", "expired"])(
    "leaves %s tokens to the pinned endpoint without revoking anyone",
    async (kind) => {
      const f = await resetFixture();
      if (kind === "expired") f.verification.expiresAt = new Date(0);
      expect((await f.post(kind === "invalid" ? "unknown" : "retry-token")).status).toBe(400);
      expect(revokeCredentialsAfterPasswordReset).not.toHaveBeenCalled();
      expect(f.state().password).toBe("old-password-hash");
    },
  );

  it("protects the pinned endpoint's query-token fallback too", async () => {
    const f = await resetFixture();
    vi.mocked(revokeCredentialsAfterPasswordReset).mockRejectedValueOnce(new Error("lock timeout"));
    expect((await f.post("retry-token", true)).status).toBe(503);
    expect(f.consume).not.toHaveBeenCalled();
  });

  it("after-sweep still revokes any credential present after the password transaction", async () => {
    const f = await resetFixture();
    let active = false;
    vi.mocked(revokeCredentialsAfterPasswordReset).mockImplementation(async () => {
      active = false;
    });
    f.deleteSessions.mockImplementation(async () => {
      active = true;
    });
    expect((await f.post()).status).toBe(200);
    expect(active).toBe(false);
    expect(revokeCredentialsAfterPasswordReset).toHaveBeenCalledTimes(2);
  });

  it("finishes invite verification and kills another reset link before reporting post-sweep failure", async () => {
    const f = await resetFixture(false);
    const context = await auth.$context;
    f.finishOtherLinks();
    // The pinned endpoint calls the hook after its password transaction commits.
    const resetContextUser = { ...(await fixture()).data.user, emailVerified: false };
    const updateUser = vi
      .spyOn(context.internalAdapter, "updateUser")
      .mockResolvedValue(resetContextUser);
    const error = new Error("post-sweep exhausted");
    vi.mocked(revokeCredentialsAfterPasswordReset)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error);
    expect((await f.post()).status).toBe(500);
    expect(f.state()).toMatchObject({ tokenLive: false, password: "new-password-hash" });
    expect(updateUser).toHaveBeenCalledExactlyOnceWith("user", { emailVerified: true });
    expect(prisma.verification.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { value: "user", identifier: { startsWith: "reset-password:" } },
    });
    expect(f.otherLinkLive()).toBe(false);
    expect((await f.post("other-token")).status).toBe(400);
  });

  it("revokes every session and checks cached snapshots against live authority", () => {
    expect(auth.options.emailAndPassword.revokeSessionsOnPasswordReset).toBe(true);
    expect(auth.options.session.cookieCache.enabled).toBe(true);
    expect(auth.options.session.cookieCache.version).toBeTypeOf("function");
    expect("secondaryStorage" in auth.options).toBe(false);
  });

  it.each([true, false])(
    "revokes standing credentials when emailVerified is %s, preserving invite verification",
    async (emailVerified) => {
      const { data } = await fixture();
      const context = await auth.$context;
      const updateUser = vi
        .spyOn(context.internalAdapter, "updateUser")
        .mockResolvedValue(data.user);
      await auth.options.emailAndPassword.onPasswordReset({
        user: { ...data.user, emailVerified },
      });
      expect(revokeCredentialsAfterPasswordReset).toHaveBeenCalledExactlyOnceWith(data.user.id);
      if (emailVerified) {
        expect(updateUser).not.toHaveBeenCalled();
      } else {
        expect(updateUser).toHaveBeenCalledExactlyOnceWith(data.user.id, { emailVerified: true });
        expect(
          vi.mocked(revokeCredentialsAfterPasswordReset).mock.invocationCallOrder[0],
        ).toBeLessThan(updateUser.mock.invocationCallOrder[0]!);
      }
    },
  );

  it.each([true, false])(
    "logs and rethrows revocation failure for emailVerified=%s",
    async (emailVerified) => {
      const { data } = await fixture();
      const context = await auth.$context;
      const updateUser = vi
        .spyOn(context.internalAdapter, "updateUser")
        .mockResolvedValue(data.user);
      const log = captureLog();
      const error = new Error("revocation unavailable");
      vi.mocked(revokeCredentialsAfterPasswordReset).mockRejectedValueOnce(error);
      await expect(
        auth.options.emailAndPassword.onPasswordReset({ user: { ...data.user, emailVerified } }),
      ).rejects.toBe(error);
      log.restore();
      expect(log.records).toEqual([
        expect.objectContaining({
          level: "error",
          reason: "SECURITY.password_reset",
          userId: data.user.id,
          errorClass: "Error",
        }),
      ]);
      expect(JSON.stringify(log.records)).not.toContain(error.message);
      if (emailVerified) expect(updateUser).not.toHaveBeenCalled();
      else expect(updateUser).toHaveBeenCalledWith(data.user.id, { emailVerified: true });
    },
  );

  it("preserves verification failure semantics after revoking credentials", async () => {
    const { data } = await fixture();
    const context = await auth.$context;
    const error = new Error("verification unavailable");
    vi.spyOn(context.internalAdapter, "updateUser").mockRejectedValueOnce(error);
    await expect(
      auth.options.emailAndPassword.onPasswordReset({
        user: { ...data.user, emailVerified: false },
      }),
    ).rejects.toBe(error);
    expect(revokeCredentialsAfterPasswordReset).toHaveBeenCalledExactlyOnceWith(data.user.id);
  });
});

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
  ])("uses locale %s and the signed-in home for a foreign callback", async (locale, lang) => {
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
    expect(target.searchParams.get("redirectTo")).toBe(`/${lang}/kbs`);
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

// Admin invites (packages/api users.invite) create the account server-side
// under the "admin-invite" grant, whose locale is the invitee's language. A
// server-side createUser carries no locale header, so the grant must win.
describe("user-create hook locale", () => {
  type Before = (
    user: Record<string, unknown>,
    context: { path?: string; headers?: Headers } | null,
  ) => Promise<{ data: Record<string, unknown> }>;
  const before = () => auth.options.databaseHooks?.user?.create?.before as unknown as Before;
  const user = { email: "invitee@example.test", name: "Invitee", emailVerified: true };

  it("seeds an invited user's locale from the grant, unverified", async () => {
    const { runWithAllowedUserCreation } = await import("./user-creation-policy");
    const { ADMIN_CREATE_USER_PATH } = await import("./user-columns");
    const result = await runWithAllowedUserCreation(
      "admin-invite",
      () => before()(user, { path: ADMIN_CREATE_USER_PATH, headers: new Headers() }),
      { locale: "es-MX" },
    );
    expect(result.data).toMatchObject({ locale: "es-MX", emailVerified: false });
  });

  it("keeps the client's locale header for a sign-up without a grant locale", async () => {
    const { APP_LOCALE_HEADER } = await import("@knowledge-base/config/locales");
    const headers = new Headers({ [APP_LOCALE_HEADER]: "es-MX" });
    const result = await before()(user, { path: "/sign-up/email", headers });
    expect(result.data).toMatchObject({ locale: "es-MX", emailVerified: true });
    const { runWithAllowedUserCreation } = await import("./user-creation-policy");
    const bootstrap = await runWithAllowedUserCreation("admin-bootstrap", () =>
      before()(user, { path: "/sign-up/email", headers }),
    );
    expect(bootstrap.data).toMatchObject({ locale: "es-MX" });
  });
});

it("uses the password pepper for Better Auth hashing and verification", async () => {
  const context = await auth.$context;
  const sealed = await context.password.hash("fixture-password");
  expect(sealed.startsWith(`pw1:${passwordPepper.fingerprint}:`)).toBe(true);
  expect(await context.password.verify({ hash: sealed, password: "fixture-password" })).toBe(true);
  expect(await context.password.verify({ hash: sealed, password: "incorrect" })).toBe(false);
});

describe("Better Auth write session authority", () => {
  async function writeFixture() {
    const { data: sample } = await fixture();
    const data = { ...sample, user: { ...sample.user, role: "admin" } };
    const writeAuth = betterAuth({
      baseURL: "https://api.example.test",
      secret: "write-session-fixture-secret-write-session-fixture-secret",
      database: auth.options.database,
      advanced: auth.options.advanced,
      // Use the origin cache policy unchanged. The live authority read below
      // models the version query completing just before the session is revoked.
      session: auth.options.session,
      user: auth.options.user,
      hooks: auth.options.hooks,
      plugins: [
        ...auth.options.plugins.filter((plugin) => plugin.id === "admin"),
        {
          id: "cookie-fixture",
          endpoints: {
            // The pinned client/device credential surfaces do not authorize by
            // browser session; isolate that distinction from their separate IO.
            ...Object.fromEntries(
              [
                "/oauth2/token",
                "/oauth2/introspect",
                "/oauth2/revoke",
                "/device/code",
                "/device/token",
              ].map((path) => [
                path,
                createAuthEndpoint(path, { method: "POST" }, async (ctx) =>
                  ctx.json({ status: true }),
                ),
              ]),
            ),
            seed: createAuthEndpoint("/fixture-session", { method: "GET" }, async (ctx) => {
              await setSessionCookie(ctx, data);
              return ctx.json({ status: true });
            }),
          },
        },
      ],
    });
    const context = await writeAuth.$context;
    const findSession = vi.spyOn(context.internalAdapter, "findSession").mockResolvedValue(data);
    const updateUser = vi.spyOn(context.internalAdapter, "updateUser").mockResolvedValue(data.user);
    vi.spyOn(context.internalAdapter, "updateSession").mockResolvedValue(data.session);
    vi.spyOn(context.internalAdapter, "findVerificationValue").mockResolvedValue(null);
    const seeded = await writeAuth.handler(
      new Request("https://api.example.test/api/auth/fixture-session"),
    );
    const cookie = seeded.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const post = (path = "/update-user") =>
      writeAuth.handler(
        new Request(`https://api.example.test/api/auth${path}`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            origin: "https://web.example.test",
          },
          body: JSON.stringify({
            name: "Updated",
            userId: "target-user",
            token: "invalid",
            newPassword: "long-enough-password",
            currentPassword: "current-password",
          }),
        }),
      );
    const changePassword = () =>
      writeAuth.api.changePassword({
        headers: new Headers({ cookie, origin: "https://web.example.test" }),
        body: { currentPassword: "current-password", newPassword: "long-enough-password" },
      });
    return { context, data, findSession, updateUser, post, changePassword };
  }

  it.each(["success", "sweep failure", "wrong password"])(
    "change-password sweeps only after commit and logs/rethrows failure: %s",
    async (kind) => {
      const f = await writeFixture();
      let committed = false;
      f.context.adapter.transaction = async (run) => {
        const result = await run(f.context.adapter);
        committed = true;
        return result;
      };
      const account = {
        id: "account",
        userId: "user",
        providerId: "credential",
        accountId: "user",
        password: "old-hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      vi.spyOn(f.context.internalAdapter, "findCredentialAccount").mockResolvedValue(account);
      vi.spyOn(f.context.password, "hash").mockResolvedValue("new-hash");
      vi.spyOn(f.context.password, "verify").mockResolvedValue(kind !== "wrong password");
      const updateAccount = vi
        .spyOn(f.context.internalAdapter, "updateAccount")
        .mockResolvedValue({ ...account, password: "new-hash" });
      const failure = new Error("sweep failure with sensitive text");
      vi.mocked(revokeCredentialsAfterPasswordChange).mockImplementation(async () => {
        expect(committed).toBe(true);
        if (kind === "sweep failure") throw failure;
      });
      const log = captureLog();
      try {
        if (kind === "sweep failure") {
          await expect(f.changePassword()).rejects.toBe(failure);
          expect(log.records).toContainEqual(
            expect.objectContaining({
              level: "error",
              reason: "SECURITY.password_change",
              userId: "user",
              errorClass: "Error",
            }),
          );
          expect(JSON.stringify(log.records)).not.toContain(failure.message);
        } else {
          expect((await f.post("/change-password")).status).toBe(kind === "success" ? 200 : 400);
        }
        if (kind === "wrong password") {
          expect(committed).toBe(false);
          expect(updateAccount).not.toHaveBeenCalled();
          expect(revokeCredentialsAfterPasswordChange).not.toHaveBeenCalled();
        } else {
          expect(updateAccount).toHaveBeenCalledExactlyOnceWith("account", {
            password: "new-hash",
          });
          expect(revokeCredentialsAfterPasswordChange).toHaveBeenCalledExactlyOnceWith("user");
        }
      } finally {
        log.restore();
      }
    },
  );

  it.each(["missing", "expired"])(
    "refuses a %s row even with an accepted cache, clearing cookies without renewal",
    async (kind) => {
      const f = await writeFixture();
      f.findSession.mockClear().mockResolvedValue(
        kind === "missing"
          ? null
          : {
              ...f.data,
              session: { ...f.data.session, expiresAt: new Date(0) },
            },
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await f.post();
        expect(response.status).toBe(401);
        const cookies = response.headers.getSetCookie();
        for (const name of [
          f.context.authCookies.sessionToken.name,
          f.context.authCookies.sessionData.name,
        ]) {
          const entries = cookies.filter((entry) => entry.startsWith(`${name}=`));
          expect(entries.length).toBeGreaterThan(0);
          expect(entries.every((entry) => /Max-Age=0/i.test(entry))).toBe(true);
        }
      }
      expect(f.findSession).toHaveBeenCalledWith(f.data.session.token);
      expect(f.updateUser).not.toHaveBeenCalled();
    },
  );

  it("permits a live session to update and renew its cache", async () => {
    const f = await writeFixture();
    f.findSession.mockClear();
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(f.findSession).toHaveBeenCalledWith(f.data.session.token);
    expect(f.updateUser).toHaveBeenCalledOnce();
    expect(
      response.headers
        .getSetCookie()
        .some(
          (entry) =>
            entry.startsWith(`${f.context.authCookies.sessionData.name}=`) &&
            !/Max-Age=0/i.test(entry),
        ),
    ).toBe(true);
  });

  it("leaves anonymous reset errors to the reset endpoint despite a stale session cookie", async () => {
    const f = await writeFixture();
    f.findSession.mockResolvedValue(null);
    expect((await f.post("/reset-password")).status).toBe(400);
  });

  it("keeps admin impersonation disabled even for a live admin session (item d is inapplicable)", async () => {
    const f = await writeFixture();
    const createSession = vi.spyOn(f.context.internalAdapter, "createSession");
    const response = await f.post("/admin/impersonate-user");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "YOU_ARE_NOT_ALLOWED_TO_IMPERSONATE_USERS",
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    "/oauth2/token",
    "/oauth2/introspect",
    "/oauth2/revoke",
    "/device/code",
    "/device/token",
  ])(
    "leaves %s client/device authorization independent of an incidental stale browser cookie",
    async (path) => {
      const f = await writeFixture();
      f.findSession.mockClear().mockResolvedValue(null);
      const response = await f.post(path);
      expect(response.status).toBe(200);
      expect(f.findSession).not.toHaveBeenCalled();
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );
});
