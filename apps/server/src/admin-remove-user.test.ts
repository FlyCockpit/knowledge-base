import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();

vi.mock("@knowledge-base/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://app.example.com",
    CORS_ORIGIN: "https://web.example.com",
  },
}));

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep<typeof import("@knowledge-base/db").default>();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("@knowledge-base/auth", () => ({
  auth: {
    api: {
      get getSession() {
        return getSession;
      },
    },
  },
}));

const removeUserAccount = vi.fn();

vi.mock("@knowledge-base/api/lib/kb/account-removal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@knowledge-base/api/lib/kb/account-removal")>();
  return {
    ...actual,
    removeUserAccount: (...args: Parameters<typeof actual.removeUserAccount>) =>
      removeUserAccount(...args),
  };
});

vi.mock("@knowledge-base/api/lib/kb/runtime", () => ({
  getKbRuntime: vi.fn(() => ({ runtime: "test" }) as never),
}));

const { default: prisma } = await import("@knowledge-base/db");
const { betterAuthRemoveUser } = await import("./admin-remove-user");
const { getAllowedAccountDeletionMode } = await import(
  "@knowledge-base/auth/account-deletion-policy"
);

const db = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
};

function adminSession() {
  return {
    user: {
      id: "admin-1",
      role: "admin",
      emailVerified: true,
      twoFactorEnabled: true,
    },
  };
}

describe("betterAuthRemoveUser", () => {
  let app: Hono;
  let betterAuthHandlerReached: boolean;

  beforeEach(() => {
    getSession.mockReset();
    getSession.mockResolvedValue(adminSession());
    db.user.findUnique.mockReset();
    db.user.findUnique.mockResolvedValue({ id: "target-1" });
    removeUserAccount.mockReset();
    removeUserAccount.mockResolvedValue({ tombstonedKbCount: 0 });
    betterAuthHandlerReached = false;
    app = new Hono();
    // Registration mirrors apps/server/src/index.ts: the specific route is
    // registered before the catch-all, and a responding handler stops the
    // chain so Better-Auth's cascade never runs for this route.
    app.on("POST", "/api/auth/admin/remove-user", betterAuthRemoveUser);
    app.on(["POST", "GET"], "/api/auth/*", (c) => {
      betterAuthHandlerReached = true;
      return c.json({ via: "better-auth" });
    });
  });

  async function post(body: unknown) {
    const res = await app.request("/api/auth/admin/remove-user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it("delegates to the shared policy in ordinary mode before any credential deletion", async () => {
    const modes: Array<string | undefined> = [];
    removeUserAccount.mockImplementation(async () => {
      modes.push(getAllowedAccountDeletionMode());
      return { tombstonedKbCount: 0 };
    });
    const res = await post({ userId: "target-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(betterAuthHandlerReached).toBe(false);
    expect(removeUserAccount).toHaveBeenCalledTimes(1);
    expect(removeUserAccount.mock.calls[0]?.[1]).toBe("target-1");
    expect(removeUserAccount.mock.calls[0]?.[2]).toEqual({ actingUserId: "admin-1" });
    expect(modes).toEqual(["ordinary"]);
  });

  it("maps a blocked removal to 409 without deleting anything", async () => {
    const { AccountDeletionBlockedError } = await import(
      "@knowledge-base/api/lib/kb/account-removal"
    );
    removeUserAccount.mockRejectedValue(new AccountDeletionBlockedError());
    const res = await post({ userId: "target-1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("conflict");
  });

  it("rejects self-removal before consulting the policy", async () => {
    const res = await post({ userId: "admin-1" });
    expect(res.status).toBe(400);
    expect(removeUserAccount).not.toHaveBeenCalled();
  });

  it("rejects an unknown target with 404", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await post({ userId: "missing" });
    expect(res.status).toBe(404);
    expect(removeUserAccount).not.toHaveBeenCalled();
  });

  it("rejects a missing userId with 400", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(removeUserAccount).not.toHaveBeenCalled();
  });

  it("enforces the verified-admin gate itself", async () => {
    getSession.mockResolvedValue(null);
    const res = await post({ userId: "target-1" });
    expect(res.status).toBe(401);
    expect(removeUserAccount).not.toHaveBeenCalled();
    expect(betterAuthHandlerReached).toBe(false);
  });

  it("rejects a non-JSON content type before touching the session or the policy", async () => {
    // A cross-site <form enctype="text/plain"> (or no-cors fetch) is a
    // simple request that skips preflight; the body must never be parsed
    // as a deletion command.
    const res = await app.request("/api/auth/admin/remove-user", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ userId: "target-1" }),
    });
    expect(res.status).toBe(415);
    expect(getSession).not.toHaveBeenCalled();
    expect(removeUserAccount).not.toHaveBeenCalled();
    expect(betterAuthHandlerReached).toBe(false);
  });

  it("rejects cross-site fetch metadata", async () => {
    const res = await app.request("/api/auth/admin/remove-user", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://web.example.com",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ userId: "target-1" }),
    });
    expect(res.status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(removeUserAccount).not.toHaveBeenCalled();
  });

  it("rejects an untrusted origin", async () => {
    const res = await app.request("/api/auth/admin/remove-user", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://attacker.invalid",
        "Sec-Fetch-Site": "same-site",
      },
      body: JSON.stringify({ userId: "target-1" }),
    });
    expect(res.status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(removeUserAccount).not.toHaveBeenCalled();
  });
});
