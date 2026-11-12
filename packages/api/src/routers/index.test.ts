import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";

// Mutable env mock — emailEnabled reads SMTP_HOST/SMTP_FROM (via the mailer's
// isEmailConfigured, mocked below against this same object) at call time, so
// flipping them between tests exercises both branches of the flag.
const envMock = {
  SMTP_HOST: undefined as string | undefined,
  SMTP_FROM: undefined as string | undefined,
  SSO_PROVIDER_NAME: "SSO",
  SSO_ENABLED: false,
  FORCE_SSO: false,
  SIGNUP_ENABLED: true,
  NODE_ENV: "test",
  RATE_LIMIT_AUTH_POINTS: 30,
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
  RATE_LIMIT_RPC_POINTS: 100,
  RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
  RATE_LIMIT_EMAIL_POINTS: 3,
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
};
const adminEmailState = { value: undefined as string | undefined };
vi.mock("@knowledge-base/env/server", () => ({
  env: envMock,
  get SSO_ENABLED() {
    return envMock.SSO_ENABLED;
  },
  get FORCE_SSO() {
    return envMock.FORCE_SSO;
  },
  get SIGNUP_ENABLED() {
    return envMock.SIGNUP_ENABLED;
  },
  get ADMIN_EMAIL() {
    return adminEmailState.value;
  },
}));

// `@knowledge-base/env/shared` VALIDATES process.env at module load and throws when it
// is empty — which is exactly CI, so importing the full router graph pulls it
// in. Same module-load boundary rule as the queue mock below.
vi.mock("@knowledge-base/env/shared", () => ({
  env: {},
}));

// Mock @knowledge-base/db so importing the full appRouter graph never touches Postgres.
vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.bootstrapState.findUnique.mockResolvedValue(null);
  db.user.findFirst.mockResolvedValue(null);
  return { default: db };
});

// @knowledge-base/queue opens IORedis sockets at import time — mock every producer the
// import graph touches or the suite hangs in CI (no Redis).
vi.mock("@knowledge-base/queue", async () => {
  const fakeQueue = { add: vi.fn() };
  return {
    echoQueue: fakeQueue,
    seedQueue: fakeQueue,
    reapExpiredAuthTokensQueue: fakeQueue,
    checkBackupFreshnessQueue: fakeQueue,
    notifyDataDeletionsQueue: fakeQueue,
    durableProbeQueue: fakeQueue,
    providerProbeQueue: fakeQueue,
    indexKbQueue: fakeQueue,
    queryEmbeddingQueue: fakeQueue,
    pushMirrorQueue: fakeQueue,
    downloadModelQueue: fakeQueue,
    kbEmailQueue: fakeQueue,
    kbRetentionQueue: fakeQueue,
    kbGitRollupQueue: fakeQueue,
    echoJobSchema: { parse: (v: unknown) => v },
    ensureRunnableJob: vi.fn(),
    QUEUE_NAMES: (await import("@knowledge-base/queue/jobs")).QUEUE_NAMES,
    redisConnection: {},
  };
});

// @knowledge-base/auth builds the Better-Auth instance (prismaAdapter, plugins) at
// import time — stub it so the graph loads without that machinery.
vi.mock("@knowledge-base/auth", () => ({
  auth: { api: {} },
}));

// @knowledge-base/mailer would open SMTP — stub the surface the import graph uses.
// isEmailConfigured mirrors the real implementation against the env mock.
vi.mock("@knowledge-base/mailer", () => ({
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
  isEmailConfigured: () => Boolean(envMock.SMTP_HOST && envMock.SMTP_FROM),
}));

const { default: prisma } = await import("@knowledge-base/db");
const { appRouter } = await import("./index");

const publicContext: Context = { session: null };

describe("health", () => {
  it("exposes only the cheap check — no RPC readiness probe on the datastore", () => {
    // A DB-touching `ready` procedure was removed as an anonymous
    // datastore-drain vector bounded only by the generic /rpc limiter;
    // readiness is the HTTP /ready route with its own readyLimiter bucket.
    expect(Object.keys(appRouter.health)).toEqual(["check"]);
  });

  it("answers check without a session", async () => {
    const client = createRouterClient(appRouter, { context: publicContext });

    await expect(client.health.check()).resolves.toBe("OK");
  });
});

describe("appConfig", () => {
  beforeEach(() => {
    envMock.SMTP_HOST = undefined;
    envMock.SMTP_FROM = undefined;
    envMock.SSO_ENABLED = false;
    envMock.FORCE_SSO = false;
    envMock.SIGNUP_ENABLED = true;
    envMock.SSO_PROVIDER_NAME = "SSO";
    envMock.NODE_ENV = "test";
    adminEmailState.value = undefined;
    prisma.bootstrapState.findUnique.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
  });

  it("reports emailEnabled=false when SMTP_HOST is unset", async () => {
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(false);
  });

  it("reports emailEnabled=true when SMTP_HOST and SMTP_FROM are configured", async () => {
    envMock.SMTP_HOST = "smtp.example.com";
    envMock.SMTP_FROM = "App <no-reply@example.com>";
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(true);
  });

  it("reports emailEnabled=false when SMTP_HOST is set without SMTP_FROM", async () => {
    envMock.SMTP_HOST = "smtp.example.com";
    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.emailEnabled).toBe(false);
  });

  it("surfaces the SSO and signup flags alongside emailEnabled", async () => {
    envMock.SSO_ENABLED = true;
    envMock.FORCE_SSO = true;
    envMock.SIGNUP_ENABLED = false;
    envMock.SSO_PROVIDER_NAME = "Okta";
    envMock.SMTP_HOST = "smtp.example.com";
    envMock.SMTP_FROM = "App <no-reply@example.com>";

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config).toEqual({
      ssoEnabled: true,
      forceSso: true,
      ssoProviderName: "Okta",
      signupEnabled: false,
      adminBootstrapSignupEnabled: true,
      emailEnabled: true,
    });
  });

  it("hides bootstrap signup in production when ADMIN_EMAIL is unset", async () => {
    envMock.SIGNUP_ENABLED = false;
    envMock.NODE_ENV = "production";
    adminEmailState.value = undefined;

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.adminBootstrapSignupEnabled).toBe(false);
  });

  it("surfaces the admin bootstrap signup carve-out when signup is otherwise disabled", async () => {
    envMock.SIGNUP_ENABLED = false;
    adminEmailState.value = "admin@example.com";

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.adminBootstrapSignupEnabled).toBe(true);
  });

  it("hides bootstrap signup when users already exist even if the singleton is empty", async () => {
    envMock.SIGNUP_ENABLED = false;
    adminEmailState.value = "admin@example.com";
    prisma.user.findFirst.mockResolvedValue({ id: "existing" });

    const client = createRouterClient(appRouter, { context: publicContext });
    const config = await client.appConfig();

    expect(config.adminBootstrapSignupEnabled).toBe(false);
  });
});

describe("appRouter surface", () => {
  it("does not expose removed chat, projects, or demo privateData routers", () => {
    expect(appRouter).not.toHaveProperty("chat");
    expect(appRouter).not.toHaveProperty("projects");
    expect(appRouter).not.toHaveProperty("privateData");
  });

  it("keeps the remaining live routers", () => {
    expect(Object.keys(appRouter).sort()).toEqual(
      [
        "appConfig",
        "auth",
        "cliCredentials",
        "documents",
        "embeddingProviders",
        "health",
        "kbUploads",
        "kbAssets",
        "kbExports",
        "kbIndex",
        "kbMirror",
        "kbModel",
        "kbSealed",
        "kbs",
        "mcpConsent",
        "mcpGrants",
        "mcpTokens",
        "pullRequests",
        "push",
        "queue",
        "search",
        "settings",
        "users",
      ].sort(),
    );
  });
});
