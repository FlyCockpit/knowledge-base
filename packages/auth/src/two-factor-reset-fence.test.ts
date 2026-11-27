import { renderTwoFactorOtp } from "@knowledge-base/mailer";
import { betterAuth } from "better-auth";
import type { twoFactor } from "better-auth/plugins";
import { beforeEach, expect, it, vi } from "vitest";
import { createBootstrapDatabaseAdapter } from "./bootstrap";
import { revokeCredentialsAfterPasswordReset } from "./credential-revocation";
import { auth } from "./index";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));
const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  rows: { oauthResource: [] } as Record<string, Record<string, unknown>[]>,
}));
vi.mock("@knowledge-base/db", () => ({ default: db }));
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://kb.example.test",
    BETTER_AUTH_SECRET: new Secret("two-factor-reset-fixture-secret-two-factor-reset"),
  },
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
  FORCE_SSO: false,
}));
vi.mock("@knowledge-base/mailer", () => ({
  isEmailConfigured: () => true,
  renderTwoFactorOtp: vi.fn(() => ({ subject: "otp", html: "" })),
  renderResetPassword: vi.fn(),
  renderVerifyEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

// Only database IO is replaced: use Better Auth's real memory adapter beneath
// our production authority wrapper and the configured, pinned 2FA plugin.
vi.mock("better-auth/adapters/prisma", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return {
    prismaAdapter:
      (client: { rows: Record<string, Record<string, unknown>[]> }) =>
      (options: Parameters<ReturnType<typeof memoryAdapter>>[0]) =>
        memoryAdapter(client.rows)(options),
  };
});

beforeEach(() => vi.clearAllMocks());

async function fixture() {
  const now = new Date();
  const rows: Record<string, Record<string, unknown>[]> = {
    user: [
      {
        id: "user",
        name: "User",
        email: "user@example.test",
        emailVerified: true,
        twoFactorEnabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    oauthResource: [],
    account: [],
    session: [],
    verification: [],
    twoFactor: [],
  };
  const client = {
    rows,
    bootstrapState: { findUnique: async () => ({ completedAt: now }) },
    user: { findUnique: async () => ({ locale: "en-US" }) },
  };
  Object.assign(db, client);
  db.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone(rows);
    let locked = false;
    const tx = {
      ...client,
      $queryRaw: async () => [{ completedAt: now }],
      $executeRaw: async (sql: TemplateStringsArray) => {
        if (sql.join("").includes("pg_advisory_xact_lock")) locked = true;
        return 0;
      },
      $executeRawUnsafe: async (sql: string, userId: string) => {
        if (!sql.includes('FROM "verification" v')) return 0;
        expect(locked).toBe(true);
        // Exact pinned identifiers/values. SQL shape is pinned separately in
        // credential-revocation.test.ts; this fixture models its row effects.
        const challenges = rows
          .verification!.filter(
            (row) => row.value === userId && String(row.identifier).startsWith("2fa-"),
          )
          .map((row) => row.identifier);
        rows.verification = rows.verification!.filter(
          (row) =>
            !(
              (row.value === userId && /^(2fa-|trust-device-)/.test(String(row.identifier))) ||
              challenges.some((id) =>
                [`2fa-attempts-${id}`, `2fa-otp-${id}`].includes(String(row.identifier)),
              ) ||
              String(row.identifier).startsWith(`2fa-otp-${userId}!`)
            ),
        );
        return 1;
      },
      deviceCode: { deleteMany: async () => ({ count: 0 }) },
      session: {
        deleteMany: async () => {
          rows.session = [];
          return { count: 1 };
        },
      },
    };
    try {
      return await run(tx);
    } catch (error) {
      // A real interactive transaction rolls back writes even when the handler
      // throws an expected APIError. Keep the memory adapter honest about that.
      for (const key of Object.keys(rows)) delete rows[key];
      Object.assign(rows, snapshot);
      throw error;
    }
  });
  const plugin = auth.options.plugins.find((plugin) => plugin.id === "two-factor") as ReturnType<
    typeof twoFactor
  >;
  const instance = betterAuth({
    baseURL: "https://kb.example.test",
    secret: "two-factor-reset-fixture-secret-two-factor-reset",
    database: createBootstrapDatabaseAdapter(
      db as unknown as Parameters<typeof createBootstrapDatabaseAdapter>[0],
    ),
    hooks: auth.options.hooks,
    emailAndPassword: auth.options.emailAndPassword,
    // Use the application's configured plugin, including hashed email OTPs.
    plugins: [plugin],
  });
  const context = await instance.$context;
  // Generate the challenge and attempt rows using the real sign-in after-hook.
  const challengeContext = {
    ...context,
    newSession: { user: rows.user![0], session: { token: "temporary" } },
    responseHeaders: new Headers(),
    setNewSession: vi.fn(),
    internalAdapter: { ...context.internalAdapter, deleteSession: vi.fn() },
  };
  const hook = plugin.hooks!.after[0]!;
  const input = {
    path: "/sign-in/email",
    context: challengeContext,
    headers: new Headers(),
    returnHeaders: true,
  };
  // The middleware's return type omits Better Call's returnHeaders envelope.
  const result: unknown = await hook.handler(input);
  if (
    !result ||
    typeof result !== "object" ||
    !("headers" in result) ||
    !(result.headers instanceof Headers)
  ) {
    throw new Error("2FA challenge did not return cookie headers");
  }
  const cookies = result.headers
    .getSetCookie()
    .map((cookie: string) => cookie.split(";")[0])
    .join("; ");
  const challenge = String(rows.verification!.find((row) => row.value === "user")!.identifier);
  expect(challenge).toMatch(/^2fa-.{20}$/);
  expect(
    rows.verification!.find((row) => row.identifier === `2fa-attempts-${challenge}`)?.value,
  ).toBe("0");
  const post = (path: string, body: unknown) =>
    instance.handler(
      new Request(`https://kb.example.test/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookies },
        body: JSON.stringify(body),
      }),
    );
  // Use the real send endpoint and capture its code at the mocked mail boundary.
  expect((await post("/two-factor/send-otp", {})).status).toBe(200);
  const otp = rows.verification!.find((row) => row.identifier === `2fa-otp-${challenge}`)!;
  expect(otp.value).toMatch(/^[^:]+:0$/);
  const code = vi.mocked(renderTwoFactorOtp).mock.calls.at(-1)![0].otp;
  return {
    rows,
    challenge,
    post,
    code,
    instance,
    context,
  };
}

it("a pre-reset challenge cannot complete with its valid OTP after both sweeps succeed", async () => {
  const f = await fixture();
  await revokeCredentialsAfterPasswordReset("user");
  await revokeCredentialsAfterPasswordReset("user");
  expect((await f.post("/two-factor/verify-otp", { code: f.code, trustDevice: true })).status).toBe(
    401,
  );
  expect(f.rows.session).toEqual([]);
  expect((await f.post("/two-factor/send-otp", {})).status).toBe(401);
});

it("both sweeps kill a pre-reset 2FA login, its OTP/attempts and trusted devices only for that user", async () => {
  const f = await fixture();
  f.rows.verification!.push(
    { id: "trust", identifier: "trust-device-existing", value: "user" },
    { id: "session-otp", identifier: "2fa-otp-user!session", value: "hash:0" },
    { id: "other", identifier: "2fa-other-user", value: "other-user" },
    { id: "reset", identifier: "reset-password:link", value: "user" },
  );
  await revokeCredentialsAfterPasswordReset("user");
  expect(f.rows.verification!.map((row) => row.identifier)).toEqual([
    "2fa-other-user",
    "reset-password:link",
  ]);
  // A second sweep must also remove a newly queued challenge/trust record.
  f.rows.verification!.push(
    { id: "late", identifier: "trust-device-late", value: "user" },
    { id: "late-challenge", identifier: "2fa-late", value: "user" },
    { id: "late-otp", identifier: "2fa-otp-2fa-late", value: "hash:0" },
    { id: "late-attempts", identifier: "2fa-attempts-2fa-late", value: "0" },
  );
  await revokeCredentialsAfterPasswordReset("user");
  expect(f.rows.verification!.map((row) => row.identifier)).toEqual([
    "2fa-other-user",
    "reset-password:link",
  ]);
  expect((await f.post("/two-factor/verify-otp", { code: f.code, trustDevice: true })).status).toBe(
    401,
  );
  expect(f.rows.session).toEqual([]);
});

it("reset sweeps revoke a completed OTP login and its newly trusted device", async () => {
  const f = await fixture();
  expect((await f.post("/two-factor/verify-otp", { code: f.code, trustDevice: true })).status).toBe(
    200,
  );
  expect(f.rows.session).toHaveLength(1);
  expect(
    f.rows.verification!.some((row) => String(row.identifier).startsWith("trust-device-")),
  ).toBe(true);
  await revokeCredentialsAfterPasswordReset("user");
  await revokeCredentialsAfterPasswordReset("user");
  expect(f.rows.session).toEqual([]);
  expect(
    f.rows.verification!.filter((row) => String(row.identifier).startsWith("trust-device-")),
  ).toEqual([]);
});

it("the fixture rolls back writes when a transaction throws", async () => {
  const f = await fixture();
  const before = structuredClone(f.rows);
  const error = new Error("rollback probe");
  await expect(
    db.$transaction(async () => {
      f.rows.verification = [];
      f.rows.session!.push({ id: "uncommitted" });
      throw error;
    }),
  ).rejects.toBe(error);
  expect(f.rows).toEqual(before);
});

it.each([false, true])(
  "failed OTPs persist their five-guess budget despite APIError (TwoFactor row: %s)",
  async (hasTwoFactor) => {
    const f = await fixture();
    if (hasTwoFactor) {
      f.rows.twoFactor!.push({ id: "factor", userId: "user", failedVerificationCount: 0 });
    }
    const wrongCode = f.code === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await f.post("/two-factor/verify-otp", { code: wrongCode });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "INVALID_CODE" });
      expect(
        f.rows.verification!.find((row) => row.identifier === `2fa-otp-${f.challenge}`)?.value,
      ).toMatch(new RegExp(`:${attempt}$`));
      if (hasTwoFactor) {
        expect(f.rows.twoFactor![0]!.failedVerificationCount).toBe(attempt);
      }
    }
    // A valid code cannot redeem the exhausted OTP, even on a fresh request.
    const exhausted = await f.post("/two-factor/verify-otp", { code: f.code });
    expect(exhausted.status).toBe(400);
    expect(await exhausted.json()).toMatchObject({
      code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
    });
    expect(f.rows.session).toEqual([]);
  },
);

it("change-password keeps its rotated caller session, revokes others and uses the real revocation helper", async () => {
  const f = await fixture();
  f.rows.user![0]!.twoFactorEnabled = false;
  await f.context.adapter.create({
    model: "account",
    data: {
      userId: "user",
      accountId: "user",
      providerId: "credential",
      password: "old-hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  vi.spyOn(f.context.password, "hash").mockResolvedValue("new-hash");
  vi.spyOn(f.context.password, "verify").mockResolvedValue(true);
  const signedIn = await f.instance.api.signInEmail({
    body: { email: "user@example.test", password: "old-password" },
    asResponse: true,
  });
  expect(signedIn.status).toBe(200);
  await f.context.internalAdapter.createSession("user");
  expect(f.rows.session).toHaveLength(2);
  const oldTokens = f.rows.session!.map((row) => row.token);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  const pendingTwoFactor = structuredClone(f.rows.verification);
  const changed = await f.instance.api.changePassword({
    headers: new Headers({ cookie }),
    body: {
      currentPassword: "old-password",
      newPassword: "long-enough-new-password",
      revokeOtherSessions: true,
    },
    returnHeaders: true,
  });
  const body = changed.response;
  expect(body.token).toEqual(expect.any(String));
  expect(oldTokens).not.toContain(body.token);
  expect(f.rows.session!.map((row) => row.token)).toEqual([body.token]);
  // The response cookie actually authenticates; this catches a dead rotated cookie.
  const changedCookie = changed.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  const session = await f.instance.api.getSession({
    headers: new Headers({ cookie: changedCookie }),
  });
  expect(session?.session.token).toBe(body.token);
  expect(f.rows.account![0]!.password).toBe("new-hash");
  expect(f.rows.verification).toEqual(pendingTwoFactor);
});
