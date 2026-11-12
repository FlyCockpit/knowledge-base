import type { Session } from "@knowledge-base/auth";
import { captureLog } from "@knowledge-base/env/log";
import { createRouterClient, ORPCError } from "@orpc/server";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Context } from "../context";
import { pushRouter } from "./push";

// Mock @knowledge-base/db before importing the module
vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

// Mock @knowledge-base/env/server to provide VAPID_PUBLIC_KEY
vi.mock("@knowledge-base/env/server", () => ({
  env: { VAPID_PUBLIC_KEY: "test-vapid-key" },
}));

// The web-push lib is the seam, not its internals: `send` must pre-flight the
// VAPID configuration through `isWebPushConfigured` and deliver through
// `sendPushNotification`. Default is the configured deployment; the gate
// itself is covered in the `send` tests below.
vi.mock("../lib/web-push", () => ({
  isWebPushConfigured: vi.fn(() => true),
  sendPushNotification: vi.fn(),
}));

const { default: prisma } = await import("@knowledge-base/db");
const { isWebPushConfigured, sendPushNotification } = await import("../lib/web-push");
const isConfiguredMock = vi.mocked(isWebPushConfigured);
const sendMock = vi.mocked(sendPushNotification);

const db = prisma as unknown as {
  pushSubscription: {
    create: MockInstance;
    findUnique: MockInstance;
    update: MockInstance;
    findMany: MockInstance;
    delete: MockInstance;
  };
};

/** Build a minimal oRPC context for testing. */
function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null, clientIp: undefined };

  return {
    clientIp: undefined,
    session: {
      user: {
        id: "test-user-id",
        email: "test@example.com",
        name: "Test User",
        emailVerified: true,
        role: "user",
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

describe("push router — auth gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation(async (run) => {
      if (typeof run !== "function") throw new Error("Expected an interactive transaction");
      return run(prisma);
    });
    vi.mocked(prisma.pushSubscription.findMany).mockResolvedValue([]);
  });

  // ─── Protected procedure: vapidPublicKey ───────────────────────

  describe("subscribe (protectedProcedure)", () => {
    const validInput = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
      keys: {
        p256dh: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]).toString("base64url"),
        auth: Buffer.alloc(16).toString("base64url"),
      },
    };

    it("stores new HTTPS browser push-service endpoints", async () => {
      db.pushSubscription.findUnique.mockResolvedValue(null);
      db.pushSubscription.create.mockResolvedValue({});
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(pushRouter, { context: ctx });

      const result = await client.subscribe(validInput);

      expect(result).toEqual({ success: true });
      expect(db.pushSubscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            endpoint: validInput.endpoint,
            userId: "test-user-id",
          }),
        }),
      );
    });

    it("refreshes keys when the endpoint already belongs to the same user", async () => {
      db.pushSubscription.findUnique.mockResolvedValue({ userId: "test-user-id" });
      db.pushSubscription.update.mockResolvedValue({});
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(pushRouter, { context: ctx });

      const result = await client.subscribe(validInput);

      expect(result).toEqual({ success: true });
      expect(db.pushSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endpoint: validInput.endpoint },
          data: {
            p256dh: validInput.keys.p256dh,
            auth: validInput.keys.auth,
          },
        }),
      );
      expect(db.pushSubscription.create).not.toHaveBeenCalled();
    });

    it("rejects endpoints already registered to another user", async () => {
      db.pushSubscription.findUnique.mockResolvedValue({ userId: "other-user-id" });
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.subscribe(validInput)).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("CONFLICT");
        return true;
      });

      expect(db.pushSubscription.update).not.toHaveBeenCalled();
      expect(db.pushSubscription.create).not.toHaveBeenCalled();
    });

    it("rejects non-HTTPS or non-push-service endpoints", async () => {
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(
        client.subscribe({
          ...validInput,
          endpoint: "http://127.0.0.1:8080/push",
        }),
      ).rejects.toThrow();

      await expect(
        client.subscribe({
          ...validInput,
          endpoint: "https://example.com/push",
        }),
      ).rejects.toThrow();

      expect(db.pushSubscription.findUnique).not.toHaveBeenCalled();
      expect(db.pushSubscription.create).not.toHaveBeenCalled();
      expect(db.pushSubscription.update).not.toHaveBeenCalled();
    });
  });

  describe("vapidPublicKey (protectedProcedure)", () => {
    it("throws UNAUTHORIZED when no session is provided", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.vapidPublicKey()).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("UNAUTHORIZED");
        return true;
      });
    });

    it("succeeds for an authenticated user (any role)", async () => {
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(pushRouter, { context: ctx });

      const result = await client.vapidPublicKey();

      expect(result).toEqual({ key: "test-vapid-key" });
    });
  });

  // ─── Admin-or-404 procedure: send ──────────────────────────────

  describe("send (adminOr404Procedure)", () => {
    const validInput = {
      title: "Test",
      body: "Hello",
    };

    it("throws NOT_FOUND when no session is provided", async () => {
      const ctx = buildContext(null);
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.send(validInput)).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("throws NOT_FOUND when user has role 'user' instead of 'admin'", async () => {
      const ctx = buildContext({ user: { role: "user" } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.send(validInput)).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("throws NOT_FOUND when user email is not verified", async () => {
      const ctx = buildContext({ user: { role: "admin", emailVerified: false } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.send(validInput)).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("NOT_FOUND");
        return true;
      });
    });

    it("rejects an absolute notification URL", async () => {
      const ctx = buildContext({ user: { role: "admin", emailVerified: true } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(
        client.send({ ...validInput, url: "https://evil.example/phish" }),
      ).rejects.toThrow();
      expect(db.pushSubscription.findMany).not.toHaveBeenCalled();
    });

    it("accepts a same-origin path and pages subscriptions", async () => {
      db.pushSubscription.findMany.mockResolvedValue([]);
      const ctx = buildContext({ user: { role: "admin", emailVerified: true } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.send({ ...validInput, url: "/dashboard" })).resolves.toEqual({
        sent: 0,
        total: 0,
        failed: 0,
      });
      expect(db.pushSubscription.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
          select: { id: true, endpoint: true, p256dh: true, auth: true },
        }),
      );
    });

    it("throws SERVICE_UNAVAILABLE before any scan when VAPID is not configured", async () => {
      isConfiguredMock.mockReturnValueOnce(false);
      const ctx = buildContext({ user: { role: "admin", emailVerified: true } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.send(validInput)).rejects.toSatisfy((error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("SERVICE_UNAVAILABLE");
        return true;
      });

      // The refusal is at the edge: nothing scanned, nothing sent.
      expect(db.pushSubscription.findMany).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("continues beyond a concurrency batch after a stalled recipient times out", async () => {
      vi.useFakeTimers();
      try {
        db.pushSubscription.findMany.mockResolvedValue(
          Array.from({ length: 9 }, (_, i) => ({
            id: `sub-${i}`,
            endpoint: `https://fcm.googleapis.com/fcm/send/${i}`,
            p256dh: "key",
            auth: "auth",
          })),
        );
        sendMock
          .mockImplementationOnce(
            () =>
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error("Socket timed out")), 10_000);
              }),
          )
          .mockResolvedValue({ statusCode: 201, body: "", headers: {} });
        const client = createRouterClient(pushRouter, {
          context: buildContext({ user: { role: "admin" } }),
        });
        const delivery = client.send(validInput);
        await vi.waitFor(() => expect(sendMock).toHaveBeenCalledTimes(8));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await delivery).toEqual({ sent: 8, total: 9, failed: 1 });
        expect(sendMock).toHaveBeenCalledTimes(9);
        expect(db.pushSubscription.delete).not.toHaveBeenCalled();
      } finally {
        sendMock.mockReset();
        vi.useRealTimers();
      }
    });

    it("deletes a 410'd subscription and counts the survivor as sent", async () => {
      const gone = Object.assign(new Error("Subscription no longer exists"), { statusCode: 410 });
      db.pushSubscription.findMany.mockResolvedValue([
        {
          id: "sub-1",
          endpoint: "https://fcm.googleapis.com/fcm/send/gone-token",
          p256dh: "p256dh-1",
          auth: "auth-1",
        },
        {
          id: "sub-2",
          endpoint: "https://fcm.googleapis.com/fcm/send/kept-token",
          p256dh: "p256dh-2",
          auth: "auth-2",
        },
      ]);
      db.pushSubscription.delete.mockResolvedValue({});
      sendMock.mockRejectedValueOnce(gone).mockResolvedValueOnce({ statusCode: 201, body: "" });
      const ctx = buildContext({ user: { role: "admin", emailVerified: true } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.send(validInput)).resolves.toEqual({ sent: 1, total: 2, failed: 1 });

      expect(db.pushSubscription.delete).toHaveBeenCalledTimes(1);
      expect(db.pushSubscription.delete).toHaveBeenCalledWith({ where: { id: "sub-1" } });
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "https://fcm.googleapis.com/fcm/send/gone-token" }),
        expect.any(String),
      );
    });

    it("counts transient failures without deleting, and logs host + status only", async () => {
      const warning = captureLog();
      const throttled = Object.assign(new Error("Too many requests"), { statusCode: 429 });
      const network = new Error("ECONNRESET");
      const endpoints = [
        "https://fcm.googleapis.com/fcm/send/ok-token",
        "https://fcm.googleapis.com/fcm/send/throttled-token",
        "https://updates.push.services.mozilla.com/wpush/v1/network-token",
      ];
      db.pushSubscription.findMany.mockResolvedValue(
        endpoints.map((endpoint, i) => ({
          id: `sub-${i + 1}`,
          endpoint,
          p256dh: `p256dh-${i + 1}`,
          auth: `auth-${i + 1}`,
        })),
      );
      sendMock
        .mockResolvedValueOnce({ statusCode: 201, body: "" })
        .mockRejectedValueOnce(throttled)
        .mockRejectedValueOnce(network);
      const ctx = buildContext({ user: { role: "admin", emailVerified: true } });
      const client = createRouterClient(pushRouter, { context: ctx });

      await expect(client.send(validInput)).resolves.toEqual({ sent: 1, total: 3, failed: 2 });

      // Transient failures must not reap the subscription — only 410/404 do.
      expect(db.pushSubscription.delete).not.toHaveBeenCalled();
      // One aggregated line per (host, status) failure class...
      expect(warning.records).toHaveLength(2);
      expect(warning.records[0]).toMatchObject({
        site: "push.delivery",
        host: "fcm.googleapis.com",
        status: "429",
        count: 1,
      });
      expect(warning.records[1]).toMatchObject({
        site: "push.delivery",
        host: "updates.push.services.mozilla.com",
        status: "network",
        count: 1,
      });
      // ...and nothing logged carries the per-subscription endpoint secrets.
      for (const record of warning.records) {
        expect(JSON.stringify(record)).not.toContain("/fcm/send/");
        expect(JSON.stringify(record)).not.toContain("wpush/v1/");
      }
      warning.restore();
    });
  });
});
