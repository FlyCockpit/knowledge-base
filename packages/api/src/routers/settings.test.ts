import type { Session } from "@knowledge-base/auth";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { settingsRouter } from "./settings";

// Mock @knowledge-base/db before importing the module
vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

const adminEmailState = { value: undefined as string | undefined };
vi.mock("@knowledge-base/env/server", () => ({
  env: {},
  get ADMIN_EMAIL() {
    return adminEmailState.value;
  },
}));

// Re-import the mocked module so we can configure return values
const { default: prisma } = await import("@knowledge-base/db");

// Type-safe handle to the mocked Prisma methods
const db = prisma as unknown as {
  $transaction: MockInstance;
  $executeRaw: MockInstance;
  $executeRawUnsafe: MockInstance;
  $queryRaw: MockInstance;
  appSetting: {
    findMany: MockInstance;
    findUnique: MockInstance;
    upsert: MockInstance;
  };
  user: {
    findMany: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
  };
};

/** Build a minimal oRPC context for testing. */
function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };

  db.$queryRaw.mockResolvedValue([
    {
      role: "admin",
      emailVerified: true,
      banned: false,
      banExpires: null,
      twoFactorEnabled: true,
      createdAt: new Date(),
      ...sessionOverride?.user,
    },
  ]);
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
  };
}

describe("settingsRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
    adminEmailState.value = undefined;
  });

  describe("getAll", () => {
    it("returns allowlisted settings as a key-value map and filters at the DB", async () => {
      db.appSetting.findMany.mockResolvedValue([
        { key: "force2faPublicUsers", value: "false" },
        { key: "force2faInternalUsers", value: "true" },
      ]);

      const ctx = buildContext(); // authenticated user
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.getAll();

      expect(result).toEqual({
        force2faPublicUsers: "false",
        force2faInternalUsers: "true",
      });
      expect(db.appSetting.findMany).toHaveBeenCalledOnce();
      // Verify the allowlist is enforced at the query level so non-allowlisted
      // keys (e.g. future secrets/integration flags) never leave the DB.
      const call = db.appSetting.findMany.mock.calls[0]?.[0] as {
        where: { key: { in: string[] } };
      };
      expect(call.where.key.in).toContain("force2faPublicUsers");
      expect(call.where.key.in).toContain("force2faInternalUsers");
      expect(call.where.key.in).not.toContain("siteName");
    });

    it("remains readable when scoped 2FA is enabled and the user has not enrolled yet", async () => {
      db.appSetting.findMany.mockResolvedValue([{ key: "force2faPublicUsers", value: "true" }]);

      const ctx = buildContext({ user: { twoFactorEnabled: false } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.getAll()).resolves.toEqual({ force2faPublicUsers: "true" });
    });

    it("returns an empty object when no settings exist", async () => {
      db.appSetting.findMany.mockResolvedValue([]);

      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.getAll();

      expect(result).toEqual({});
    });

    it("throws UNAUTHORIZED for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.getAll()).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    });
  });

  describe("myNotificationPreferences", () => {
    it("returns the user's operational alert preference", async () => {
      db.user.findUnique.mockResolvedValue({ operationalAlerts: false });

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(client.myNotificationPreferences()).resolves.toEqual({
        operationalAlerts: false,
      });
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        select: { operationalAlerts: true },
      });
    });

    it("defaults operational alerts on when the row is unavailable", async () => {
      db.user.findUnique.mockResolvedValue(null);

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(client.myNotificationPreferences()).resolves.toEqual({
        operationalAlerts: true,
      });
    });
  });

  describe("updateMyNotificationPreferences", () => {
    it("updates the user's operational alert preference", async () => {
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(settingsRouter, { context: buildContext() });

      await expect(
        client.updateMyNotificationPreferences({ operationalAlerts: false }),
      ).resolves.toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "test-user-id" },
        data: { operationalAlerts: false },
      });
    });
  });

  describe("adminSetupStatus", () => {
    it("reports no admin when ADMIN_EMAIL is unset and no account holds the admin role", async () => {
      db.user.findMany.mockResolvedValueOnce([{ role: "kb_admin_custom" }]);
      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.adminSetupStatus();

      expect(result).toEqual({ adminEmailsEmpty: true, adminExists: false });
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: expect.any(Number), select: { role: true } }),
      );
    });

    it("reports the bootstrapped first-account admin when ADMIN_EMAIL is unset", async () => {
      db.user.findMany.mockResolvedValueOnce([{ role: "user,admin" }]);
      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.adminSetupStatus();

      expect(result).toEqual({ adminEmailsEmpty: true, adminExists: true });
    });

    it("returns adminEmailsEmpty: false without a user probe when ADMIN_EMAIL is set", async () => {
      adminEmailState.value = "admin@example.com";
      db.user.findMany.mockClear();

      const ctx = buildContext();
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.adminSetupStatus();

      expect(result).toEqual({ adminEmailsEmpty: false, adminExists: true });
      expect(db.user.findMany).not.toHaveBeenCalled();
    });

    it("throws UNAUTHORIZED for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.adminSetupStatus()).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    });
  });

  describe("update", () => {
    it("cannot change forced-2FA policy without the shared authority lock", async () => {
      db.$executeRaw.mockRejectedValueOnce(new Error("authority lock unavailable"));
      const client = createRouterClient(settingsRouter, {
        context: buildContext({ user: { role: "admin", twoFactorEnabled: true } }),
      });
      await expect(client.update({ key: "force2faInternalUsers", value: "true" })).rejects.toThrow(
        "authority lock unavailable",
      );
      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    it("settles the outgoing and incoming policy inside the authority transaction", async () => {
      const steps: string[] = [];
      db.$executeRaw.mockImplementation(async (sql: TemplateStringsArray) => {
        if (sql.join("").includes("pg_advisory_xact_lock")) steps.push("lock");
      });
      db.$executeRawUnsafe.mockImplementation(async (sql: string) => {
        if (sql.startsWith("CREATE TEMP")) steps.push("witness-table");
        else if (sql.startsWith("INSERT INTO pg_temp")) steps.push("witness");
        else if (sql.startsWith("WITH outgoing")) steps.push("settle-outgoing");
        else if (sql.includes('SET "twoFactorGraceStartedAt" = u."createdAt"'))
          steps.push("materialize");
        else if (sql.includes('SET "twoFactorGraceStartedAt"')) steps.push("grace-start");
        else steps.push("settle");
        return 0;
      });
      db.appSetting.upsert.mockImplementation(async () => {
        steps.push("write");
      });
      const client = createRouterClient(settingsRouter, {
        context: buildContext({ user: { role: "admin", twoFactorEnabled: true } }),
      });
      for (const value of ["true", "false"] as const) {
        steps.length = 0;
        await client.update({ key: "force2faPublicUsers", value });
        expect(steps).toEqual([
          "lock",
          // Under the OUTGOING policy, before any write: covered users' NULL
          // grace start is written down as createdAt.
          "materialize",
          "witness-table",
          "witness",
          "settle",
          "write",
          // Turning the policy on starts the newly covered users' grace
          // before the incoming lapse settlement reads it.
          ...(value === "true" ? ["grace-start"] : []),
          "settle-outgoing",
          "settle",
          "settle-outgoing",
        ]);
      }
    });

    it("starts the enrollment grace of the newly covered population only on activation", async () => {
      const graceWrites: unknown[][] = [];
      const materialized: unknown[][] = [];
      db.$executeRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('SET "twoFactorGraceStartedAt" = clock_timestamp()'))
          graceWrites.push([sql, ...params]);
        else if (sql.includes('SET "twoFactorGraceStartedAt" = u."createdAt"'))
          materialized.push([sql, ...params]);
        return 0;
      });
      const client = createRouterClient(settingsRouter, {
        context: buildContext({ user: { role: "admin", twoFactorEnabled: true } }),
      });

      // Public users: absent row defaults to off, so "true" is an activation.
      db.appSetting.findUnique.mockResolvedValue(null);
      await client.update({ key: "force2faPublicUsers", value: "true" });
      expect(graceWrites).toHaveLength(1);
      const [sql, isInternal] = graceWrites[0] as [string, boolean];
      // Only users whose grace never started; never moves a recorded start.
      expect(sql).toContain('"twoFactorGraceStartedAt" IS NULL');
      expect(isInternal).toBe(false);

      // Already on: writing "true" again is not a new activation.
      graceWrites.length = 0;
      db.appSetting.findUnique.mockResolvedValue({ value: "true" } as never);
      await client.update({ key: "force2faPublicUsers", value: "true" });
      expect(graceWrites).toHaveLength(0);

      // Internal users default to on: re-enabling after an explicit "false".
      db.appSetting.findUnique.mockResolvedValue({ value: "false" } as never);
      await client.update({ key: "force2faInternalUsers", value: "true" });
      expect(graceWrites).toHaveLength(1);
      expect(graceWrites[0]?.[1]).toBe(true);

      // Turning it off never starts a grace. Every policy write first writes
      // down the covered users' createdAt-based start (all users, under the
      // outgoing policy), so a later re-enable can't grant a second one.
      graceWrites.length = 0;
      materialized.length = 0;
      db.appSetting.findUnique.mockResolvedValue({ value: "true" } as never);
      await client.update({ key: "force2faInternalUsers", value: "false" });
      expect(graceWrites).toHaveLength(0);
      expect(materialized).toHaveLength(1);
      // userId parameter is null: the whole covered population.
      expect(materialized[0]?.at(-1)).toBeNull();
    });

    it("upserts the setting and returns success", async () => {
      db.appSetting.upsert.mockResolvedValue({
        key: "force2faPublicUsers",
        value: "false",
      });

      const ctx = buildContext({ user: { role: "admin", twoFactorEnabled: true } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      const result = await client.update({
        key: "force2faPublicUsers",
        value: "false",
      });

      expect(result).toEqual({ success: true });
      expect(db.appSetting.upsert).toHaveBeenCalledWith({
        where: { key: "force2faPublicUsers" },
        update: { value: "false" },
        create: { key: "force2faPublicUsers", value: "false" },
      });
    });

    // The escape hatch for an owner who does not want forced admin 2FA: the
    // internal default is on, so turning it off has to be reachable during the
    // enrollment grace window, before the gate starts rejecting them.
    it("lets an admin inside the enrollment grace window turn internal enforcement off", async () => {
      db.appSetting.upsert.mockResolvedValue({
        key: "force2faInternalUsers",
        value: "false",
      });

      const ctx = buildContext({
        user: { role: "admin", twoFactorEnabled: false, createdAt: new Date(Date.now() - 60_000) },
      });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(
        client.update({ key: "force2faInternalUsers", value: "false" }),
      ).resolves.toEqual({ success: true });
    });

    it("rejects unknown setting keys", async () => {
      const ctx = buildContext({ user: { role: "admin", twoFactorEnabled: true } });
      const client = createRouterClient(settingsRouter, { context: ctx });
      const update = client.update as (input: { key: string; value: string }) => Promise<unknown>;

      await expect(update({ key: "siteName", value: "Nope" })).rejects.toThrow();
      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    // Inside the enrollment grace window this admin still gets past
    // `adminOr404Procedure`, so the self-2FA precondition is the check that
    // actually answers — which is what this test is about.
    it("throws FORBIDDEN when enabling scoped 2FA without 2FA on own account", async () => {
      const ctx = buildContext({
        user: { role: "admin", twoFactorEnabled: false, createdAt: new Date(Date.now() - 60_000) },
      });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(
        client.update({ key: "force2faInternalUsers", value: "true" }),
      ).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("FORBIDDEN");
        expect(error.message).toMatch(/enable 2FA/i);
        return true;
      });

      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    it("rejects writes to keys outside the writable enum", async () => {
      const ctx = buildContext({ user: { role: "admin", twoFactorEnabled: true } });
      const client = createRouterClient(settingsRouter, { context: ctx });
      const update = client.update as (input: { key: string; value: string }) => Promise<unknown>;

      await expect(update({ key: "siteName", value: "false" })).rejects.toThrow();
      expect(db.appSetting.upsert).not.toHaveBeenCalled();
    });

    it("throws NOT_FOUND for unauthenticated requests", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2faPublicUsers", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    it("throws NOT_FOUND for non-admin users", async () => {
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2faPublicUsers", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });

    it("throws NOT_FOUND when admin email is not verified", async () => {
      const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
      const client = createRouterClient(settingsRouter, { context: ctx });

      await expect(client.update({ key: "force2faPublicUsers", value: "false" })).rejects.toSatisfy(
        (error: ORPCError) => {
          expect(error).toBeInstanceOf(ORPCError);
          expect(error.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });
});
