import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();

vi.mock("@knowledge-base/auth", () => ({
  auth: {
    api: {
      get getSession() {
        return getSession;
      },
    },
  },
}));

const { sessionMiddleware } = await import("./session-middleware");

// The headers `getSession` was actually called with on the last invocation.
function lastHeaders(): Headers {
  const arg = getSession.mock.calls.at(-1)?.[0];
  return (arg as { headers: Headers }).headers;
}

describe("sessionMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    getSession.mockReset();
    getSession.mockResolvedValue(null);

    app = new Hono();
    app.use("*", sessionMiddleware);
    app.get("/", (c) => c.json({ session: c.get("session" as never) ?? null }));
  });

  // The security property. A bearer credential must never authenticate a
  // cookie surface: a Better-Auth plugin that adds one mocks a session for the
  // credential's owner inside `getSession`, and no oRPC procedure here checks a
  // credential's scope. Stripping the header keeps a future token (or one added
  // by a plugin upgrade) from reaching admin mutations on /rpc.
  it("does not forward the Authorization header to getSession", async () => {
    await app.request("/", {
      headers: { authorization: "Bearer some-token" },
    });

    expect(getSession).toHaveBeenCalledTimes(1);
    expect(lastHeaders().get("authorization")).toBeNull();
  });

  it("strips Authorization regardless of header casing", async () => {
    await app.request("/", {
      headers: { AuThOrIzAtIoN: "bEaReR some-token" },
    });

    expect(lastHeaders().get("authorization")).toBeNull();
  });

  it("still forwards cookies, so a bearer header cannot blank out a real session", async () => {
    await app.request("/", {
      headers: {
        authorization: "Bearer some-token",
        cookie: "better-auth.session_token=abc",
      },
    });

    const headers = lastHeaders();
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cookie")).toBe("better-auth.session_token=abc");
  });

  it("resolves a cookie session onto the context", async () => {
    const session = { user: { id: "u1" } };
    getSession.mockResolvedValue(session);

    const res = await app.request("/", {
      headers: { cookie: "better-auth.session_token=abc" },
    });

    expect(await res.json()).toEqual({ session });
  });

  it("treats a getSession failure as anonymous rather than a 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getSession.mockRejectedValue(new Error("db down"));

    const res = await app.request("/");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session: null });
  });
});
