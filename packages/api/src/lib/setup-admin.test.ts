import { createHash } from "node:crypto";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const policy = {
  nodeEnv: "production",
  adminEmail: "owner@example.com" as string | undefined,
};
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://app.example.com",
    get NODE_ENV() {
      return policy.nodeEnv;
    },
  },
  get ADMIN_EMAIL() {
    return policy.adminEmail;
  },
  SIGNUP_ENABLED: false,
}));
vi.mock("@knowledge-base/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: {
        hash: async (password: string) => `hashed:${password}`,
        config: { minPasswordLength: 12, maxPasswordLength: 128 },
      },
    }),
  },
}));
const lockIdentityAuthority = vi.fn(async () => {});
vi.mock("@knowledge-base/db/authority-lock", () => ({ lockIdentityAuthority }));
const recordTwoFactorGraceStartAtCreation = vi.fn(async () => {});
vi.mock("@knowledge-base/auth/ban", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordTwoFactorGraceStartAtCreation,
}));

const { default: prisma } = await import("@knowledge-base/db");
const { bootstrapAdminName, claimSetupLink, issueSetupLink, setupTokenIdentifier } = await import(
  "./setup-admin"
);

const db = prisma as unknown as {
  $transaction: MockInstance;
  $executeRaw: MockInstance;
  $executeRawUnsafe: MockInstance;
  $queryRaw: MockInstance;
  bootstrapState: { findUnique: MockInstance; update: MockInstance };
  user: { findFirst: MockInstance; create: MockInstance };
  account: { create: MockInstance };
  verification: { findFirst: MockInstance; deleteMany: MockInstance; create: MockInstance };
};

/** The SQL text of a tagged-template raw call. */
function sqlOf(call: unknown[] | undefined): string {
  const strings = call?.[0] as TemplateStringsArray | undefined;
  return strings ? strings.join("?") : "";
}

/** First invocation order of each mock. */
function order(...mocks: MockInstance[]): number[] {
  return mocks.map((mock) => mock.mock.invocationCallOrder[0] ?? -1);
}

const NOW = new Date("2026-11-23T12:00:00Z");
const TTL = 3600;
const issue = (email = "owner@example.com") => issueSetupLink(email, { ttlSeconds: TTL, now: NOW });
const bootstrapDone = () =>
  db.bootstrapState.findUnique.mockResolvedValue({ completedAt: new Date("2026-01-01") });
const liveLink = (email = "owner@example.com") =>
  db.verification.findFirst.mockResolvedValue({ id: "v1", value: email });

beforeEach(() => {
  vi.clearAllMocks();
  policy.nodeEnv = "production";
  policy.adminEmail = "owner@example.com";
  db.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) => operation(db));
  db.$executeRaw.mockResolvedValue(1);
  db.$executeRawUnsafe.mockResolvedValue(1);
  db.$queryRaw.mockResolvedValue([]);
  db.bootstrapState.findUnique.mockResolvedValue({ completedAt: null });
  db.bootstrapState.update.mockResolvedValue({});
  db.user.findFirst.mockResolvedValue(null);
  db.user.create.mockResolvedValue({ id: "new-admin" });
  db.account.create.mockResolvedValue({ id: "acc" });
  db.verification.findFirst.mockResolvedValue(null);
  db.verification.deleteMany.mockResolvedValue({ count: 0 });
  db.verification.create.mockResolvedValue({ id: "v1" });
});

describe("issueSetupLink", () => {
  it("writes no user, only the hash of a one-hour setup token naming the address", async () => {
    const result = await issue();

    expect(result.kind).toBe("ready");
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
    expect(db.bootstrapState.update).not.toHaveBeenCalled();
    if (result.kind !== "ready") throw new Error("expected ready");
    const link = new URL(result.url);
    expect(`${link.origin}${link.pathname}`).toBe("https://app.example.com/en-US/reset-password");
    expect(link.searchParams.get("setup")).toBe("1");
    const token = link.searchParams.get("token") ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const written = db.verification.create.mock.calls[0]?.[0].data;
    // Only the hash is stored, under a prefix no Better-Auth endpoint reads.
    expect(written).toEqual({
      identifier: `setup-admin:${createHash("sha256").update(token).digest("base64url")}`,
      value: "owner@example.com",
      expiresAt: new Date(NOW.getTime() + TTL * 1000),
    });
    expect(written.identifier).not.toContain(token);
    expect(result.expiresAt).toEqual(written.expiresAt);
    expect(result.email).toBe("owner@example.com");
  });

  it("replaces every earlier link: one live link at a time", async () => {
    await issue();
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: { startsWith: "setup-admin:" } },
    });
    const [deleted, created] = order(db.verification.deleteMany, db.verification.create);
    expect(deleted).toBeLessThan(created ?? 0);
  });

  it("decides under the BootstrapState row lock", async () => {
    await issue();
    expect(sqlOf(db.$executeRaw.mock.calls[0])).toContain("INSERT INTO bootstrap_state");
    expect(sqlOf(db.$queryRaw.mock.calls[0])).toContain("FOR UPDATE");
    const [locked, written] = order(db.$queryRaw, db.verification.create);
    expect(locked).toBeLessThan(written ?? 0);
  });

  it("is closed for good once bootstrap completed", async () => {
    bootstrapDone();
    expect(await issue()).toEqual({ kind: "bootstrap_complete" });
    expect(db.verification.create).not.toHaveBeenCalled();
    expect(db.verification.deleteMany).not.toHaveBeenCalled();
  });

  it("adopts users of a database without a completed singleton and refuses", async () => {
    db.user.findFirst.mockResolvedValue({ id: "existing" });
    expect(await issue()).toEqual({ kind: "bootstrap_complete" });
    expect(db.bootstrapState.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { completedAt: expect.any(Date), userId: "existing" },
    });
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("in production admits only the ADMIN_EMAIL identity", async () => {
    expect(await issue("someone@example.com")).toEqual({ kind: "email_not_allowed" });
    policy.adminEmail = undefined;
    expect(await issue("owner@example.com")).toEqual({ kind: "email_not_allowed" });
    expect(db.verification.create).not.toHaveBeenCalled();
  });

  it("outside production admits any address, like the first sign-up", async () => {
    policy.nodeEnv = "development";
    policy.adminEmail = undefined;
    expect((await issue("dev@example.com")).kind).toBe("ready");
    expect(db.verification.create.mock.calls[0]?.[0].data.value).toBe("dev@example.com");
  });
});

describe("claimSetupLink", () => {
  const claim = (overrides: Partial<Parameters<typeof claimSetupLink>[0]> = {}) =>
    claimSetupLink({ token: "tok", newPassword: "correct horse battery", ...overrides });

  it("creates the admin, its credential account and completes bootstrap in one transaction", async () => {
    liveLink();

    expect(await claim()).toEqual({ kind: "claimed", userId: "new-admin" });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.user.create).toHaveBeenCalledWith({
      data: {
        email: "owner@example.com",
        name: "owner",
        emailVerified: true,
        role: "admin",
      },
      select: { id: true },
    });
    expect(db.account.create).toHaveBeenCalledWith({
      data: {
        userId: "new-admin",
        providerId: "credential",
        accountId: "new-admin",
        password: "hashed:correct horse battery",
      },
      select: { id: true },
    });
    expect(recordTwoFactorGraceStartAtCreation).toHaveBeenCalledWith(
      expect.any(Function),
      "new-admin",
    );
    expect(db.bootstrapState.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { completedAt: expect.any(Date), userId: "new-admin" },
    });
    expect(db.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: { startsWith: "setup-admin:" } },
    });
  });

  it("takes the identity authority lock, then the bootstrap lock, then re-reads the link", async () => {
    liveLink();
    await claim();
    const [authority, bootstrapRow, created] = order(
      lockIdentityAuthority as unknown as MockInstance,
      db.$queryRaw,
      db.user.create,
    );
    expect(authority).toBeLessThan(bootstrapRow ?? 0);
    expect(bootstrapRow).toBeLessThan(created ?? 0);
    // The re-read happens under the bootstrap lock, so a link an issuer
    // replaced while holding that lock is never taken as live.
    const reread = db.verification.findFirst.mock.invocationCallOrder[1] ?? -1;
    expect(bootstrapRow).toBeLessThan(reread);
    // Looked up once before hashing, once more under the locks.
    expect(db.verification.findFirst).toHaveBeenCalledTimes(2);
    expect(db.verification.findFirst).toHaveBeenLastCalledWith({
      where: { identifier: setupTokenIdentifier("tok"), expiresAt: { gt: expect.any(Date) } },
      select: { value: true },
    });
  });

  it("refuses an unknown, expired or replaced link before hashing anything", async () => {
    expect(await claim()).toEqual({ kind: "invalid_token" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("re-checks expiry with a fresh clock under the locks", async () => {
    db.verification.findFirst.mockResolvedValueOnce({ id: "v1" }).mockResolvedValueOnce(null);
    expect(await claim()).toEqual({ kind: "invalid_token" });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("refuses once bootstrap completed, even with a live link", async () => {
    liveLink();
    bootstrapDone();
    expect(await claim()).toEqual({ kind: "invalid_token" });
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.bootstrapState.update).not.toHaveBeenCalled();
  });

  it("refuses when users already exist (adopted completion)", async () => {
    liveLink();
    db.user.findFirst.mockResolvedValue({ id: "existing" });
    expect(await claim()).toEqual({ kind: "invalid_token" });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("refuses when ADMIN_EMAIL changed since the link was issued", async () => {
    liveLink("owner@example.com");
    policy.adminEmail = "new-owner@example.com";
    expect(await claim()).toEqual({ kind: "invalid_token" });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("enforces Better-Auth's password length policy", async () => {
    liveLink();
    expect(await claim({ newPassword: "short" })).toEqual({ kind: "password_too_short" });
    expect(await claim({ newPassword: "x".repeat(129) })).toEqual({ kind: "password_too_long" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("rolls back as invalid when the address was taken under it", async () => {
    liveLink();
    db.user.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    expect(await claim()).toEqual({ kind: "invalid_token" });
  });

  it("rethrows any other failure", async () => {
    liveLink();
    db.account.create.mockRejectedValueOnce(new Error("db down"));
    await expect(claim()).rejects.toThrow("db down");
  });
});

describe("bootstrapAdminName", () => {
  it("uses the local part, bounded, with a fallback", () => {
    expect(bootstrapAdminName("owner@example.com")).toBe("owner");
    expect(bootstrapAdminName("@example.com")).toBe("Admin");
    expect(bootstrapAdminName(`${"a".repeat(150)}@example.com`)).toHaveLength(100);
  });
});
