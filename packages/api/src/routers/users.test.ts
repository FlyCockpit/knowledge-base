import type { Session } from "@knowledge-base/auth";
import { getAdminMutationActor } from "@knowledge-base/auth/session-authority";
import { getGrantedUserLocale } from "@knowledge-base/auth/user-creation-policy";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { usersRouter } from "./users";

// Mock @knowledge-base/db before importing the module so the router pulls the deep-
// mocked Prisma client.
vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

// `configured`: SMTP_HOST and SMTP_FROM set; `host`: SMTP_HOST set at all.
const mail = vi.hoisted(() => ({ configured: true, host: true }));
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "http://localhost:3000",
    get SMTP_HOST() {
      return mail.host ? "smtp.example.test" : undefined;
    },
  },
  ADMIN_EMAIL: undefined,
}));

// Mock @knowledge-base/auth so the router's `auth.api.createUser` call hits a stub
// instead of pulling in the real better-auth (which needs an env, prisma, etc).
vi.mock("@knowledge-base/auth", () => ({
  auth: {
    api: {
      createUser: vi.fn(),
    },
    $context: Promise.resolve({ options: {} }),
  },
}));

// The link storage and its locks have their own tests (packages/auth); here
// only what the invite mints and records, and when.
const links = vi.hoisted(() => ({
  mintSetPasswordLink: vi.fn(async ({ ttlMs }: { userId: string; ttlMs: number }) => ({
    token: "t".repeat(43),
    expiresAt: new Date(Date.now() + ttlMs),
  })),
  recordResetLinkProof: vi.fn(async (_input: unknown) => true),
}));
vi.mock("@knowledge-base/auth/password-reset-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@knowledge-base/auth/password-reset-links")>()),
  ...links,
}));

// Mock @knowledge-base/mailer so invites don't try to open SMTP. Tests assert on the
// call shape via the mock instead. `renderInviteUser` is stubbed to return a
// stable subject/html so the router can pass them straight through to
// `sendEmail` — the actual rendering is tested in the mailer package.
vi.mock("@knowledge-base/mailer", () => ({
  isEmailConfigured: () => mail.configured,
  sendEmail: vi.fn(),
  renderInviteUser: vi.fn(() => ({
    subject: "You've been invited",
    html: "<html><body>invite</body></html>",
  })),
}));

vi.mock("../lib/kb/runtime", () => ({
  getKbRuntime: vi.fn(() => ({ prisma: {} })),
}));

vi.mock("../lib/kb/account-removal", () => ({
  removeUserAccount: vi.fn(async () => ({ tombstonedKbCount: 0 })),
  mapAccountDeletionError: vi.fn(() => null),
}));

const { default: prisma } = await import("@knowledge-base/db");
const { auth } = await import("@knowledge-base/auth");
const { sendEmail, renderInviteUser } = await import("@knowledge-base/mailer");
const { removeUserAccount } = await import("../lib/kb/account-removal");

const db = prisma as unknown as {
  user: {
    findUnique: MockInstance;
    findMany: MockInstance;
    count: MockInstance;
    update: MockInstance;
    delete: MockInstance;
  };
  session: { deleteMany: MockInstance };
  $transaction: MockInstance;
  $executeRaw: MockInstance;
  $queryRaw: MockInstance;
  $queryRawUnsafe: MockInstance;
};

const authApi = auth as unknown as {
  api: { createUser: MockInstance };
};
const sendEmailMock = sendEmail as unknown as MockInstance;

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
        id: "admin-user-id",
        email: "admin@example.com",
        name: "Admin",
        emailVerified: true,
        role: "admin",
        // Forced admin 2FA is the shipped default (FORCE_2FA_DEFAULTS), so an
        // unenrolled admin would 404 here before the router ever ran.
        twoFactorEnabled: true,
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
        userId: sessionOverride?.user?.id ?? "admin-user-id",
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

describe("usersRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mail.configured = true;
    mail.host = true;
    db.$queryRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('SELECT id, role, "emailVerified"')) {
        const target = await prisma.user.findUnique({ where: { id: String(params[0]) } });
        return target ? [target] : [];
      }
      if (sql.includes("count(*)::int")) return [{ count: 2 }];
      return [];
    });
    db.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  });

  it.each(["setRole", "archive", "unarchive"] as const)(
    "%s fails before changing authority if the shared lock cannot be acquired",
    async (method) => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.$executeRaw.mockRejectedValueOnce(new Error("authority lock unavailable"));
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client[method]({ userId: "other-user-id", role: "user" })).rejects.toThrow(
        "authority lock unavailable",
      );
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.session.deleteMany).not.toHaveBeenCalled();
    },
  );

  describe("auth gates", () => {
    it("list throws NOT_FOUND when no session", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext(null) });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("list throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(client.list()).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("invite throws NOT_FOUND for non-admin role", async () => {
      const client = createRouterClient(usersRouter, {
        context: buildContext({ user: { role: "user" } }),
      });
      await expect(
        client.invite({ email: "x@example.com", name: "X", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("NOT_FOUND");
        return true;
      });
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("returns users + nextCursor without a search filter", async () => {
      db.user.findMany.mockResolvedValue([
        { id: "1", email: "a@x.com", name: "A", role: "user", createdAt: new Date("2025-01-01") },
      ]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list();

      expect(res.users).toHaveLength(1);
      expect(res.nextCursor).toBeNull();
      // No cursor on the first page: the filter stands alone in the AND.
      expect(db.user.findMany.mock.calls[0]?.[0].where).toEqual({ AND: [{}] });
      // Never a per-page count — the UI is an infinite list.
      expect(db.user.count).not.toHaveBeenCalled();
    });

    it("takes limit + 1 to detect hasMore and mints a cursor for a full page", async () => {
      const rows = Array.from({ length: 11 }, (_, i) => ({
        id: `u-${i}`,
        email: `u${i}@x.com`,
        name: `U ${i}`,
        role: "user",
        createdAt: new Date("2025-01-01"),
      }));
      db.user.findMany.mockResolvedValue(rows);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.list({ limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
      expect(res.users).toHaveLength(10);
      expect(res.nextCursor).toEqual(expect.any(String));
    });

    it("applies a case-insensitive OR search across name and email", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ search: "alice", limit: 10 });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            OR: [
              { email: { contains: "alice", mode: "insensitive" } },
              { name: { contains: "alice", mode: "insensitive" } },
            ],
          },
        ],
      });
      expect(call.take).toBe(11);
      expect(call.skip).toBeUndefined();
    });

    it("rejects a malformed cursor", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.list({ cursor: "not-a-cursor" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      expect(db.user.findMany).not.toHaveBeenCalled();
    });

    it("filters archived users in the database (banned=true)", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ banned: true }] });
    });

    it("treats active as not-banned, including NULL banned", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "active" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({ AND: [{ OR: [{ banned: false }, { banned: null }] }] });
    });

    it("combines status and search with AND", async () => {
      db.user.findMany.mockResolvedValue([]);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.list({ status: "archived", search: "alice" });

      const call = db.user.findMany.mock.calls[0]?.[0];
      expect(call.where).toEqual({
        AND: [
          {
            AND: [
              { banned: true },
              {
                OR: [
                  { email: { contains: "alice", mode: "insensitive" } },
                  { name: { contains: "alice", mode: "insensitive" } },
                ],
              },
            ],
          },
        ],
      });
    });
  });

  describe("invite", () => {
    it("carries the inviter identity only through Better Auth creation, keeping SMTP outside", async () => {
      authApi.api.createUser.mockImplementationOnce(async () => {
        expect(getAdminMutationActor()).toBe("admin-user-id");
        return { user: { id: "new-user-id" } };
      });
      sendEmailMock.mockImplementationOnce(async () => {
        expect(getAdminMutationActor()).toBeUndefined();
      });
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.invite({
        email: "new@example.com",
        name: "New User",
        role: "admin",
        locale: "en-US",
      });
      expect(getAdminMutationActor()).toBeUndefined();
      expect(sendEmailMock).toHaveBeenCalledOnce();
    });

    it("creates the user via better-auth and emails them on success", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "NEW@example.com",
        name: "New User",
        role: "user",
        locale: "en-US",
      });

      expect(res.userId).toBe("new-user-id");
      expect(res.emailSent).toBe(true);
      // No password anywhere — not created, not returned, not mailed.
      expect(res).not.toHaveProperty("tempPassword");
      expect(res).not.toHaveProperty("setPasswordUrl");
      // Email should be lowercased by the input zod schema.
      expect(authApi.api.createUser).toHaveBeenCalledWith({
        body: {
          email: "new@example.com",
          name: "New User",
          role: "user",
        },
      });
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "new@example.com" }),
      );
    });

    it("mails a one-time, expiring set-password link in the invitee's chosen language", async () => {
      // The chosen language reaches the user-create hook through the grant
      // (packages/auth seeds `User.locale` from it), not a read-back.
      authApi.api.createUser.mockImplementationOnce(async () => {
        expect(getGrantedUserLocale()).toBe("es-MX");
        return { user: { id: "new-user-id" } };
      });
      sendEmailMock.mockResolvedValue(undefined);
      const before = Date.now();

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.invite({ email: "new@example.com", name: "New User", locale: "es-MX" });
      expect(authApi.api.createUser).toHaveBeenCalledOnce();
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(getGrantedUserLocale()).toBeUndefined();

      // A Better Auth reset token (single use, consumed with the password
      // write), minted under the credential-setup lock, valid 72 hours.
      expect(links.mintSetPasswordLink).toHaveBeenCalledOnce();
      expect(links.mintSetPasswordLink).toHaveBeenCalledWith({
        userId: "new-user-id",
        ttlMs: 72 * 3_600_000,
        noSmtpInviteFor: undefined,
      });
      const minted = await links.mintSetPasswordLink.mock.results[0]?.value;
      const token = minted.token as string;
      expect(minted.expiresAt.getTime()).toBeGreaterThan(before);
      // Mailed, so spending it proves the inbox.
      expect(links.recordResetLinkProof).toHaveBeenCalledWith({
        token,
        userId: "new-user-id",
        email: "new@example.com",
        proof: "mailbox",
      });
      expect(links.recordResetLinkProof.mock.invocationCallOrder[0]).toBeGreaterThan(
        sendEmailMock.mock.invocationCallOrder[0] ?? Infinity,
      );

      const rendered = vi.mocked(renderInviteUser).mock.calls.at(-1)?.[0];
      // Better Auth's token check first, then the localized set-password page.
      const url = new URL(rendered?.setPasswordUrl ?? "");
      expect(url.origin).toBe("http://localhost:3000");
      expect(url.pathname).toBe(`/api/auth/reset-password/${token}`);
      const landing = new URL(url.searchParams.get("callbackURL") ?? "");
      expect(landing.origin).toBe("http://localhost:3000");
      expect(landing.pathname).toBe("/es-MX/reset-password");
      expect(landing.searchParams.get("invite")).toBe("1");
      expect(rendered).not.toHaveProperty("tempPassword");
      expect(rendered?.locale).toBe("es-MX");
    });

    it("requires a supported invitee language", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      for (const locale of [undefined, "fr-FR"]) {
        await expect(
          client.invite({
            email: "new@example.com",
            name: "New User",
            locale: locale as "en-US",
          }),
        ).rejects.toSatisfy((e: ORPCError) => {
          expect(e.code).toBe("BAD_REQUEST");
          return true;
        });
      }
      expect(authApi.api.createUser).not.toHaveBeenCalled();
    });

    it("returns emailSent=false when SMTP throws but the user was still created", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockRejectedValue(new Error("SMTP not configured"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({
        email: "new@example.com",
        name: "New User",
        locale: "en-US",
      });

      expect(res.emailSent).toBe(false);
      expect(res.userId).toBe("new-user-id");
      // Without mail, the admin hands the one-time link over out of band.
      expect(res.setPasswordUrl).toMatch(/^http:\/\/localhost:3000\/api\/auth\/reset-password\//);
      expect(res.setPasswordUrl).toContain(encodeURIComponent("/en-US/reset-password?invite=1"));
      // SMTP exists, so the shown link proves nothing: no record, and the
      // invitee confirms the address by mail at first sign-in.
      expect(links.recordResetLinkProof).not.toHaveBeenCalled();
      expect(res).toMatchObject({ confirmsEmailAtSignIn: true });
    });

    it("treats a half SMTP setup (host, no sender) as broken SMTP: no proof", async () => {
      mail.configured = false;
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({ email: "new@example.com", name: "New", locale: "en-US" });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(res).toMatchObject({ emailSent: false, confirmsEmailAtSignIn: true });
      expect(links.mintSetPasswordLink).toHaveBeenCalledWith(
        expect.objectContaining({ noSmtpInviteFor: undefined }),
      );
    });

    it("on a server with no SMTP, shows the private link and records it as the admin's invite", async () => {
      mail.configured = false;
      mail.host = false;
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.invite({ email: "new@example.com", name: "New", locale: "en-US" });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(res).toMatchObject({ emailSent: false, confirmsEmailAtSignIn: false });
      // The proof is written with the link, in one transaction.
      expect(links.mintSetPasswordLink).toHaveBeenCalledWith({
        userId: "new-user-id",
        ttlMs: 72 * 3_600_000,
        noSmtpInviteFor: "new@example.com",
      });
      expect(links.recordResetLinkProof).not.toHaveBeenCalled();
    });

    it("keeps a mailed invite mailed when recording its proof fails, never revealing the link", async () => {
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      sendEmailMock.mockResolvedValue(undefined);
      links.recordResetLinkProof.mockRejectedValueOnce(new Error("db down"));
      const { captureLog } = await import("@knowledge-base/env/log");
      const log = captureLog();
      const client = createRouterClient(usersRouter, { context: buildContext() });
      try {
        const res = await client.invite({ email: "new@example.com", name: "New", locale: "en-US" });
        expect(res).toEqual({ userId: "new-user-id", emailSent: true });
      } finally {
        log.restore();
      }
      expect(log.records.map((r) => r.site)).toEqual(["users.invite-link-proof"]);
      expect(JSON.stringify(log.records)).not.toContain("reset-password/");
    });

    it("answers CONFLICT when the new account is no longer a pending invite", async () => {
      const { SetPasswordLinkRefusedError } = await import(
        "@knowledge-base/auth/password-reset-links"
      );
      authApi.api.createUser.mockResolvedValue({ user: { id: "new-user-id" } });
      links.mintSetPasswordLink.mockRejectedValueOnce(new SetPasswordLinkRefusedError());
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => e.code === "CONFLICT");
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("translates a duplicate-email error into a CONFLICT", async () => {
      authApi.api.createUser.mockRejectedValue(new Error("User already exists"));

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "dup@example.com", name: "Dup", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("CONFLICT");
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("surfaces a clear error if auth configuration blocks account creation", async () => {
      authApi.api.createUser.mockRejectedValue(
        new Error("Sign-up is currently disabled. Contact an admin if you need access."),
      );

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(
        client.invite({ email: "new@example.com", name: "New User", locale: "en-US" }),
      ).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("BAD_REQUEST");
        expect(e.message).toMatch(/account creation is disabled/i);
        return true;
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
    });
  });

  describe("setRole", () => {
    it("updates the role on a different user", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "other-user-id", role: "admin" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { role: "admin" },
      });
    });

    it("starts the promoted user's 2FA grace before the role write", async () => {
      const steps: string[] = [];
      let graceParams: unknown[] = [];
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.$executeRawUnsafe.mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.includes('SET "twoFactorGraceStartedAt" = clock_timestamp()')) {
          steps.push("grace-start");
          graceParams = params;
        }
        return 0;
      });
      db.user.update.mockImplementation((async () => {
        steps.push("role-write");
        return {};
      }) as never);

      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.setRole({ userId: "other-user-id", role: "admin" });

      expect(steps).toEqual(["grace-start", "role-write"]);
      // The target user and the role being written; the SQL itself only fills
      // a NULL start, and only when the new role is covered and the old wasn't.
      expect(graceParams.slice(-2)).toEqual(["other-user-id", "admin"]);
    });

    it("blocks the admin from demoting themselves", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "admin-user-id", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          expect(e.message).toMatch(/own admin role/i);
          return true;
        },
      );
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("allows promoting yourself to admin (no-op safety net)", async () => {
      // Even though the admin is already admin, the schema allows the call.
      // We only block demotion of self — promoting yourself is harmless.
      db.user.findUnique.mockResolvedValue({ id: "admin-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.setRole({ userId: "admin-user-id", role: "admin" });
      expect(res).toEqual({ success: true });
    });

    it("throws NOT_FOUND for an unknown user id", async () => {
      db.user.findUnique.mockResolvedValue(null);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.setRole({ userId: "missing", role: "user" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("NOT_FOUND");
          return true;
        },
      );
    });
  });

  describe("archive", () => {
    it("bans the user and revokes their sessions in a transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.archive({
        userId: "other-user-id",
        reason: "Inactive",
      });

      expect(res).toEqual({ success: true });
      expect(db.$transaction).toHaveBeenCalledOnce();
    });

    it("tombstones MCP grants and PATs inside the same authority-locked transaction", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      const order: string[] = [];
      db.$executeRaw.mockImplementation((async (strings: TemplateStringsArray) => {
        if (strings.join("").includes("pg_advisory_xact_lock")) order.push("lock");
        return 0;
      }) as never);
      db.user.update.mockImplementation((async () => {
        order.push("ban");
        return {};
      }) as never);
      db.$executeRawUnsafe.mockImplementation((async (sql: string, userId: unknown) => {
        order.push(`${sql.match(/UPDATE "(\w+)"/)?.[1]}:${String(userId)}`);
        return 1;
      }) as never);
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await client.archive({ userId: "other-user-id" });
      expect(order).toEqual([
        "lock",
        "ban",
        "mcp_personal_token:other-user-id",
        "mcp_grant:other-user-id",
        "api_key:other-user-id",
      ]);
    });

    it("blocks self-archive", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.archive({ userId: "admin-user-id" })).rejects.toSatisfy(
        (e: ORPCError) => {
          expect(e.code).toBe("FORBIDDEN");
          return true;
        },
      );
      expect(db.user.update).not.toHaveBeenCalled();
    });
  });

  describe("unarchive", () => {
    it("clears banned + banReason + banExpires", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      db.user.update.mockResolvedValue({});

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.unarchive({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "other-user-id" },
        data: { banned: false, banReason: null, banExpires: null },
      });
      // Never resurrects revoked grant generations.
      expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("delegates to account removal when no FK constraint blocks it", async () => {
      db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
      vi.mocked(removeUserAccount).mockResolvedValue({ tombstonedKbCount: 1 });

      const client = createRouterClient(usersRouter, { context: buildContext() });
      const res = await client.remove({ userId: "other-user-id" });

      expect(res).toEqual({ success: true });
      expect(removeUserAccount).toHaveBeenCalled();
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it("blocks self-delete", async () => {
      const client = createRouterClient(usersRouter, { context: buildContext() });
      await expect(client.remove({ userId: "admin-user-id" })).rejects.toSatisfy((e: ORPCError) => {
        expect(e.code).toBe("FORBIDDEN");
        return true;
      });
      expect(db.user.delete).not.toHaveBeenCalled();
    });

    it.each(["remove", "removeForce"] as const)(
      "%s leaves other deletion conflicts unclassified",
      async (procedure) => {
        db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
        const { mapAccountDeletionError } = await import("../lib/kb/account-removal");
        vi.mocked(mapAccountDeletionError).mockReturnValue(null);
        vi.mocked(removeUserAccount).mockRejectedValue(new Error("foreign key constraint"));
        const client = createRouterClient(usersRouter, { context: buildContext() });
        await expect(client[procedure]({ userId: "other-user-id" })).rejects.toMatchObject({
          code: "CONFLICT",
          data: undefined,
        });
      },
    );

    it.each(["remove", "removeForce"] as const)(
      "%s preserves the ownership conflict reason",
      async (procedure) => {
        db.user.findUnique.mockResolvedValue({ id: "other-user-id" });
        const { mapAccountDeletionError } = await import("../lib/kb/account-removal");
        vi.mocked(removeUserAccount).mockRejectedValue(new Error("blocked"));
        vi.mocked(mapAccountDeletionError).mockReturnValue({
          code: "CONFLICT",
          message: "blocked",
          name: "KbDomainError",
        } as never);

        const client = createRouterClient(usersRouter, { context: buildContext() });
        await expect(client[procedure]({ userId: "other-user-id" })).rejects.toSatisfy(
          (e: ORPCError) => {
            expect(e.code).toBe("CONFLICT");
            expect(e.data).toEqual({ reason: "owns_knowledge_bases" });
            return true;
          },
        );
      },
    );
  });
});

describe("last active verified admin and durable role audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  });
  it.each(["setRole", "archive"] as const)(
    "%s refuses the last usable admin before any write",
    async (method) => {
      db.$queryRawUnsafe.mockImplementation(async (sql: string) =>
        sql.includes("SELECT id, role")
          ? [{ id: "target", role: "user, Admin", emailVerified: true, banned: false }]
          : [{ count: 1 }],
      );
      const client = createRouterClient(usersRouter, { context: buildContext() });
      const write =
        method === "setRole"
          ? client.setRole({ userId: "target", role: "user" })
          : client.archive({ userId: "target" });
      await expect(write).rejects.toMatchObject({
        code: "FORBIDDEN",
        data: { reason: "LAST_ACTIVE_ADMIN" },
      });
      expect(db.user.update).not.toHaveBeenCalled();
      expect(db.session.deleteMany).not.toHaveBeenCalled();
      expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "ReadCommitted",
      });
    },
  );
  it("writes actor, target and old/new roles into the existing audit table in the role transaction", async () => {
    db.$queryRawUnsafe.mockImplementation(async (sql: string) =>
      sql.includes("SELECT id, role")
        ? [{ id: "target", role: "user", emailVerified: true, banned: false }]
        : [],
    );
    const client = createRouterClient(usersRouter, { context: buildContext() });
    await client.setRole({ userId: "target", role: "admin" });
    const calls = vi
      .mocked(prisma.$queryRawUnsafe)
      .mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "audit_event"'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "users.role_changed",
        "admin-user-id",
        JSON.stringify({ shareUserId: "target", before: "user", after: "admin" }),
      ]),
    );
  });
  it("maps a serialization conflict to a translated retry reason", async () => {
    db.$transaction.mockRejectedValueOnce({ code: "P2034" });
    const client = createRouterClient(usersRouter, { context: buildContext() });
    await expect(client.setRole({ userId: "target", role: "admin" })).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "USER_CHANGE_CONFLICT" },
    });
  });
});
