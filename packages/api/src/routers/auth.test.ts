import type { Session } from "@knowledge-base/auth";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { authRouter, passwordCapabilities, verifyEmailTransportBudgetKey } from "./auth";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@knowledge-base/env/server", () => ({
  env: {},
  ADMIN_EMAIL: undefined,
  FORCE_SSO: false,
}));

// authRouter imports verifyTransport for the email-OTP delivery preflight.
const verifyTransportMock = vi.fn<() => Promise<boolean>>();
vi.mock("@knowledge-base/mailer", () => ({
  verifyTransport: () => verifyTransportMock(),
}));

// Capture how the budget is DECLARED, what key it is charged against, and
// let a test make the next consume throw — `createProcedureBudget` itself is
// covered by its own test.
const budget = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  keys: [] as string[],
  errorQueue: [] as unknown[],
}));
vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: (options: Record<string, unknown>) => {
    budget.options.push(options);
    return async (key: string) => {
      budget.keys.push(key);
      const error = budget.errorQueue.shift();
      if (error) throw error;
    };
  },
}));

const { default: prisma } = await import("@knowledge-base/db");

const db = prisma as unknown as {
  account: { findFirst: MockInstance };
  user: { update: MockInstance };
};

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
  clientIp?: string,
): Context {
  if (sessionOverride === null) return { session: null, clientIp };
  return {
    session: {
      user: {
        id: "test-user-id",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.user,
      },
      session: {
        id: "test-session-id",
        userId: sessionOverride?.user?.id ?? "test-user-id",
        token: "test-token",
        expiresAt: new Date(Date.now() + 86_400_000),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        ...sessionOverride?.session,
      },
    } as Session,
    clientIp,
  };
}

describe("authRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    budget.keys.length = 0;
    budget.errorQueue.length = 0;
  });

  describe("passwordCapabilities", () => {
    it("requires authentication", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(authRouter, { context: ctx });

      await expect(client.passwordCapabilities()).rejects.toSatisfy((err: ORPCError) => {
        expect(err).toBeInstanceOf(ORPCError);
        expect(err.code).toBe("UNAUTHORIZED");
        return true;
      });
      expect(db.account.findFirst).not.toHaveBeenCalled();
    });

    it("enables changes for the calling user's password-bearing credential account", async () => {
      db.account.findFirst.mockResolvedValue({ id: "credential-account-id" });

      const ctx = buildContext();
      const client = createRouterClient(authRouter, { context: ctx });

      const result = await client.passwordCapabilities();

      expect(result).toEqual({ canChangePassword: true });
      expect(db.account.findFirst).toHaveBeenCalledWith({
        where: {
          userId: "test-user-id",
          providerId: "credential",
          password: { not: null },
        },
        select: { id: true },
      });
      expect(Object.keys(result)).toEqual(["canChangePassword"]);
      expect(typeof result.canChangePassword).toBe("boolean");
    });

    it("disables changes when no password-bearing credential account exists", async () => {
      db.account.findFirst.mockResolvedValue(null);

      const ctx = buildContext();
      const client = createRouterClient(authRouter, { context: ctx });

      await expect(client.passwordCapabilities()).resolves.toEqual({
        canChangePassword: false,
      });
    });

    it("disables changes when force-SSO policy is active", () => {
      expect(
        passwordCapabilities({
          forceSso: true,
          hasPasswordCredential: true,
        }),
      ).toEqual({ canChangePassword: false });
    });
  });

  describe("updateLocale", () => {
    it("requires authentication (unauthenticated → UNAUTHORIZED)", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(authRouter, { context: ctx });

      await expect(client.updateLocale({ locale: "es-MX" })).rejects.toSatisfy((err: ORPCError) => {
        expect(err).toBeInstanceOf(ORPCError);
        expect(err.code).toBe("UNAUTHORIZED");
        return true;
      });
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("updates the calling user's locale on a valid input", async () => {
      db.user.update.mockResolvedValue({});

      const ctx = buildContext();
      const client = createRouterClient(authRouter, { context: ctx });

      const result = await client.updateLocale({ locale: "es-MX" });

      expect(result).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        data: { locale: "es-MX" },
      });
    });

    it("rejects an unsupported locale at Zod input validation (no Prisma write)", async () => {
      const ctx = buildContext();
      const client = createRouterClient(authRouter, { context: ctx });

      await expect(
        // @ts-expect-error — exercising input validation against an unsupported locale.
        client.updateLocale({ locale: "fr-FR" }),
      ).rejects.toBeInstanceOf(Error);
      expect(db.user.update).not.toHaveBeenCalled();
    });
  });

  describe("verifyEmailTransport", () => {
    it("is public — callable without a session", async () => {
      verifyTransportMock.mockResolvedValue(true);
      const client = createRouterClient(authRouter, { context: buildContext(null) });

      const result = await client.verifyEmailTransport();

      expect(result).toEqual({ ok: true });
    });

    it("reports ok=false when the SMTP transport is unreachable", async () => {
      verifyTransportMock.mockResolvedValue(false);
      const client = createRouterClient(authRouter, { context: buildContext(null) });

      const result = await client.verifyEmailTransport();

      expect(result).toEqual({ ok: false });
      expect(verifyTransportMock).toHaveBeenCalledOnce();
    });

    it("refuses the call over budget WITHOUT opening an SMTP connection", async () => {
      budget.errorQueue.push(
        new ORPCError("TOO_MANY_REQUESTS", {
          message: "Too many email code requests. Try again in 42s.",
          data: { retryAfterSeconds: 42 },
        }),
      );
      const client = createRouterClient(authRouter, {
        context: buildContext(null, "198.51.100.9"),
      });

      await expect(client.verifyEmailTransport()).rejects.toSatisfy((err: ORPCError) => {
        expect(err).toBeInstanceOf(ORPCError);
        expect(err.code).toBe("TOO_MANY_REQUESTS");
        return true;
      });
      // The budget must be consumed BEFORE verifyTransport: a refused call
      // must never reach SMTP.
      expect(verifyTransportMock).not.toHaveBeenCalled();
      expect(budget.keys).toEqual(["ip:198.51.100.9"]);
    });

    it("surfaces the fail-closed SERVICE_UNAVAILABLE mode without touching SMTP", async () => {
      budget.errorQueue.push(new ORPCError("SERVICE_UNAVAILABLE", { message: "unavailable" }));
      const client = createRouterClient(authRouter, {
        context: buildContext(null, "198.51.100.9"),
      });

      await expect(client.verifyEmailTransport()).rejects.toSatisfy((err: ORPCError) => {
        expect(err).toBeInstanceOf(ORPCError);
        expect(err.code).toBe("SERVICE_UNAVAILABLE");
        return true;
      });
      expect(verifyTransportMock).not.toHaveBeenCalled();
    });
  });

  describe("verifyEmailTransport rate budget", () => {
    it("is declared fail-closed with its own SMTP-sized bucket", () => {
      expect(budget.options[0]).toMatchObject({
        keyPrefix: "rl:auth-verify-email-transport",
        points: 5,
        durationSeconds: 600,
        failClosed: true,
      });
    });

    it("charges the budget keyed on the resolved client IP", async () => {
      verifyTransportMock.mockResolvedValue(true);
      const client = createRouterClient(authRouter, {
        context: buildContext(null, "203.0.113.7"),
      });

      await client.verifyEmailTransport();

      expect(budget.keys).toEqual(["ip:203.0.113.7"]);
    });

    it("shares one fallback bucket when the client IP cannot be resolved", async () => {
      verifyTransportMock.mockResolvedValue(true);
      const unknown = createRouterClient(authRouter, { context: buildContext(null, "unknown") });
      const absent = createRouterClient(authRouter, { context: buildContext(null) });

      await unknown.verifyEmailTransport();
      await absent.verifyEmailTransport();

      expect(budget.keys).toEqual(["ip:unknown", "ip:unknown"]);
    });
  });

  describe("verifyEmailTransportBudgetKey", () => {
    it('treats the literal "unknown" and an absent IP alike', () => {
      expect(verifyEmailTransportBudgetKey("198.51.100.1")).toBe("ip:198.51.100.1");
      expect(verifyEmailTransportBudgetKey("unknown")).toBe("ip:unknown");
      expect(verifyEmailTransportBudgetKey(undefined)).toBe("ip:unknown");
      expect(verifyEmailTransportBudgetKey("")).toBe("ip:unknown");
    });
  });
});
