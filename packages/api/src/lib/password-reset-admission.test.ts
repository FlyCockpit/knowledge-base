import { auth } from "@knowledge-base/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LockQuery } from "./kb/lock";
import { assertTokenAdmissible } from "./kb/principal";
import { createGrantCredentialVerifier } from "./mcp-token-access";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));
const io = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn() }));
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://api.example.test",
    PUBLIC_APP_URL: "https://web.example.test",
    BETTER_AUTH_SECRET: new Secret("reset-unit-fixture-secret-reset-unit-fixture-secret"),
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
        method === "then" ? undefined : vi.fn(async () => (method === "findMany" ? [] : null)),
    },
  );
  return {
    default: new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "$transaction" ? io.transaction : prop === "then" ? undefined : delegate,
      },
    ),
  };
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

/** Exercise the actual pinned reset endpoint and configured hooks, with only IO mocked. */
async function resetFixture() {
  const now = new Date();
  const f = {
    context: await auth.$context,
    data: {
      user: {
        id: "user",
        email: "user@example.test",
        emailVerified: true,
        name: "User",
        createdAt: now,
        updatedAt: now,
        twoFactorEnabled: true,
      },
    },
  };
  const resetAuth = auth;
  const context = await resetAuth.$context;
  let tokenLive = true;
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
  vi.spyOn(context.internalAdapter, "findVerificationValue").mockImplementation(async (id) =>
    tokenLive && id === verification.identifier ? verification : null,
  );
  const consume = vi
    .spyOn(context.internalAdapter, "consumeVerificationValue")
    .mockImplementation(async () => {
      if (!tokenLive) return null;
      tokenLive = false;
      return verification;
    });
  vi.spyOn(context.internalAdapter, "findUserById").mockResolvedValue(f.data.user);
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
    verification,
    consume,
    deleteSessions,
    updatePassword,
    hash: vi.mocked(context.password.hash),
    endSessions: async ({ where }: { where: { userId: string } }) => {
      expect(where).toEqual({ userId: f.data.user.id });
      const count = sessionLive ? 1 : 0;
      sessionLive = false;
      return { count };
    },
    state: () => ({ tokenLive, password, sessionLive }),
  };
}

it("reset route tombstones live grants so cached and in-flight token replies cannot authorize access", async () => {
  const f = await resetFixture();
  const grantId = "11111111-1111-4111-8111-111111111111";
  const grants = [
    {
      id: grantId,
      userId: "user",
      kind: "OAUTH",
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      revokedAt: null as Date | null,
    },
  ];
  const principal = {
    kind: "token" as const,
    userId: "user",
    grantId,
    grantGeneration: grantId,
    scopes: ["mcp:read"],
    expiresAt: new Date(Date.now() + 60_000),
    storedAcl: new Map(),
  };
  const query = (async (sql: string) => {
    const rows = sql.includes('FROM "mcp_grant"')
      ? grants.filter((g) => g.id === principal.grantId)
      : sql.includes('FROM "user"')
        ? [{ role: "user", twoFactorEnabled: true, banned: false, createdAt: new Date() }]
        : [];
    return { rows, rowCount: rows.length };
  }) as LockQuery;
  const verifier = createGrantCredentialVerifier(query);
  // Model replies after JWT verification, bypassing the claims hook entirely,
  // as the upstream rotation cache and an already-running token request can.
  const cachedReply = structuredClone(principal);
  const release = Promise.withResolvers<typeof principal>();
  const inFlightReply = release.promise;
  await expect(assertTokenAdmissible(cachedReply, verifier)).resolves.toMatchObject({
    generationActive: true,
  });
  io.execute.mockImplementation(async (sql: string) => {
    if (sql.includes('UPDATE "mcp_grant"'))
      for (const grant of grants) grant.revokedAt = new Date();
    return 1;
  });
  io.transaction.mockImplementation(async (run) =>
    run({
      $executeRaw: vi.fn(async () => 0),
      $executeRawUnsafe: io.execute,
      deviceCode: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      session: { deleteMany: vi.fn(f.endSessions) },
    }),
  );
  // A separate sign-in could introduce a grant before the defense-in-depth sweep.
  f.deleteSessions.mockImplementation(async () => {
    grants.push({ ...grants[0]!, id: "gap", revokedAt: null });
  });
  expect((await f.post()).status).toBe(200);
  expect(io.transaction).toHaveBeenCalledTimes(2);
  expect(grants.every((g) => g.revokedAt !== null)).toBe(true);
  release.resolve(principal);
  for (const reply of [cachedReply, await inFlightReply]) {
    await expect(assertTokenAdmissible(reply, verifier)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      details: { reason: "CREDENTIAL_ENDED" },
    });
  }
});

it("actual revocation retry exhaustion refuses reset before writes and preserves the same link", async () => {
  const f = await resetFixture();
  io.transaction.mockRejectedValue(new Error("lock unavailable"));
  expect((await f.post()).status).toBe(503);
  expect(io.transaction).toHaveBeenCalledTimes(3);
  expect(f.state()).toEqual({ tokenLive: true, password: "old-password-hash", sessionLive: true });
  expect(f.consume).not.toHaveBeenCalled();
  expect(f.updatePassword).not.toHaveBeenCalled();
  expect(f.deleteSessions).not.toHaveBeenCalled();
  io.transaction.mockImplementation(async (run) =>
    run({
      $executeRaw: vi.fn(async () => 0),
      $executeRawUnsafe: vi.fn(async () => 1),
      deviceCode: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      session: { deleteMany: vi.fn(f.endSessions) },
    }),
  );
  expect((await f.post()).status).toBe(200);
  expect(io.transaction).toHaveBeenCalledTimes(5);
  expect(f.state()).toEqual({
    tokenLive: false,
    password: "new-password-hash",
    sessionLive: false,
  });
});

it("a later reset failure leaves the old password and link intact but signs out all sessions", async () => {
  const f = await resetFixture();
  io.transaction.mockImplementation(async (run) =>
    run({
      $executeRaw: vi.fn(async () => 0),
      $executeRawUnsafe: vi.fn(async () => 1),
      deviceCode: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      session: { deleteMany: vi.fn(f.endSessions) },
    }),
  );
  f.hash.mockRejectedValueOnce(new Error("hash unavailable"));
  expect((await f.post()).status).toBe(500);
  expect(io.transaction).toHaveBeenCalledOnce();
  expect(f.state()).toEqual({
    tokenLive: true,
    password: "old-password-hash",
    sessionLive: false,
  });
  expect(f.consume).not.toHaveBeenCalled();
  expect(f.updatePassword).not.toHaveBeenCalled();
  expect(f.deleteSessions).not.toHaveBeenCalled();
});
