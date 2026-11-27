import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CORS_ALLOW_HEADERS } from "./cors-headers";

const boundary = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@knowledge-base/auth", () => ({ auth: { api: { getSession: boundary.getSession } } }));
vi.mock("@knowledge-base/api/lib/two-factor-policy", () => ({
  isTwoFactorPolicySatisfied: async () => true,
}));
const { expectedIdentity } = await import("./expected-identity");
const { sessionMiddleware } = await import("./session-middleware");

beforeEach(() => {
  boundary.getSession.mockReset().mockResolvedValue({ user: { id: "b" } });
});

function app({ resolved = false, credential = undefined as string | undefined } = {}) {
  const server = new Hono();
  if (resolved) server.use("*", sessionMiddleware);
  if (credential)
    server.use("*", async (c, next) => {
      c.set("credential" as never, credential);
      await next();
    });
  server.use("*", expectedIdentity);
  server.all("*", (c) => c.json({ wrote: true }));
  return server;
}

describe("expectedIdentity", () => {
  it.each([false, true])(
    "rejects a changed cookie before the write (already resolved: %s)",
    async (resolved) => {
      const response = await app({ resolved }).request("/rpc/update", {
        method: "POST",
        headers: { "X-Expected-User": "a" },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "IDENTITY_CHANGED" });
      expect(boundary.getSession).toHaveBeenCalledTimes(1);
    },
  );
  it("allows a match using one existing session resolution", async () => {
    const response = await app({ resolved: true }).request("/rpc/update", {
      headers: { "X-Expected-User": "b" },
    });
    expect(response.status).toBe(200);
    expect(boundary.getSession).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "compares a policy-rejected cookie owner (already resolved: %s)",
    async (resolved) => {
      boundary.getSession.mockResolvedValue({ user: { id: "b", banned: true } });
      const write = vi.fn();
      const server = new Hono();
      if (resolved) server.use("*", sessionMiddleware);
      server.use("*", expectedIdentity);
      server.post("/rpc/update", async (c) => {
        // Compare the raw owner even though application policy rejected it.
        const session = await boundary.getSession({ headers: c.req.raw.headers });
        write(session.user.id);
        return c.json({ wrote: true });
      });
      const response = await server.request("/rpc/update", {
        method: "POST",
        headers: { "X-Expected-User": "a", cookie: "better-auth.session_token=b" },
      });
      expect(write).not.toHaveBeenCalled();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "IDENTITY_CHANGED" });
      expect(boundary.getSession).toHaveBeenCalledTimes(1);
    },
  );
  it("leaves a matching policy-rejected owner to normal authorization", async () => {
    boundary.getSession.mockResolvedValue({ user: { id: "b", banned: true } });
    const server = new Hono();
    server.use("*", sessionMiddleware);
    server.use("*", expectedIdentity);
    server.post("/rpc/update", (c) => c.json({ refused: !c.get("session" as never) }, 401));
    const response = await server.request("/rpc/update", {
      method: "POST",
      headers: { "X-Expected-User": "b" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ refused: true });
    expect(boundary.getSession).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "rejects a failed precheck before a downstream lookup can write (already resolved: %s)",
    async (resolved) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const write = vi.fn();
      // A transient lookup failure must not become confirmed anonymity.
      boundary.getSession.mockRejectedValueOnce(new Error("temporary lookup failure"));
      const server = new Hono();
      if (resolved) server.use("*", sessionMiddleware);
      server.use("*", expectedIdentity);
      server.post("/rpc/update", async (c) => {
        const session = await boundary.getSession({ headers: c.req.raw.headers });
        write(session.user.id);
        return c.json({ wrote: true });
      });
      try {
        const response = await server.request("/rpc/update", {
          method: "POST",
          headers: { "X-Expected-User": "a", cookie: "better-auth.session_token=b" },
        });
        expect(write).not.toHaveBeenCalled();
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: "SESSION_UNAVAILABLE" });
        expect(boundary.getSession).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    },
  );
  it("does no work without a header", async () => {
    expect((await app().request("/api/auth/update-user")).status).toBe(200);
    expect(boundary.getSession).not.toHaveBeenCalled();
  });
  it("leaves an absent session to normal authorization", async () => {
    boundary.getSession.mockResolvedValue(null);
    expect(
      (await app().request("/rpc/update", { headers: { "X-Expected-User": "a" } })).status,
    ).toBe(200);
  });
  it("does not let an arbitrary bearer header bypass a cookie mismatch", async () => {
    const response = await app().request("/rpc/update", {
      headers: { "X-Expected-User": "a", Authorization: "Bearer ignored" },
    });
    expect(response.status).toBe(409);
    expect(boundary.getSession.mock.calls[0]?.[0].headers.has("authorization")).toBe(false);
  });
  it("allows the expected identity in a CORS preflight", async () => {
    const server = new Hono();
    server.use("*", cors({ origin: "https://web.test", allowHeaders: [...CORS_ALLOW_HEADERS] }));
    const response = await server.request("/rpc/update", {
      method: "OPTIONS",
      headers: {
        origin: "https://web.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "X-Expected-User",
      },
    });
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
      "x-expected-user",
    );
  });
  it("mounts after the limiter and before each cookie handler", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    for (const path of ["/rpc/*", "/api-reference/*", "/sw/*"]) {
      expect(source).toContain(`app.use("${path}", expectedIdentity)`);
    }
    expect(source).not.toContain('app.use("/api/auth/*", expectedIdentity)');
  });
});
