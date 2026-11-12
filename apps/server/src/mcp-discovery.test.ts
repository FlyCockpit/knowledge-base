import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { MCP_DISCOVERY_PATHS, mountMcpOAuth } from "./mcp-discovery";

it("passes only the exact MCP resource through to bearer admission (always on)", async () => {
  const app = new Hono();
  mountMcpOAuth(app, {
    baseUrl: "https://kb.example.invalid",
    handler: async () => new Response("oauth"),
  });
  app.post("/mcp", (c) => c.text("bearer boundary", 401));
  expect(
    (
      await app.request("https://kb.example.invalid/mcp", {
        method: "POST",
        headers: { host: "kb.example.invalid" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request("https://kb.example.invalid/mcp/other", {
        method: "POST",
        headers: { host: "kb.example.invalid" },
      })
    ).status,
  ).toBe(404);
});

const baseUrl = "https://kb.example.invalid";
describe("MCP discovery routing", () => {
  it("does not advertise the rejected artifact-only revocation endpoint", async () => {
    const app = new Hono();
    mountMcpOAuth(app, {
      baseUrl,
      handler: async () =>
        Response.json({
          issuer: `${baseUrl}/api/auth`,
          revocation_endpoint: `${baseUrl}/api/auth/oauth2/revoke`,
          revocation_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp:read"],
        }),
    });
    for (const path of MCP_DISCOVERY_PATHS.filter((p) =>
      p.includes("oauth-authorization-server"),
    )) {
      const response = await app.request(baseUrl + path, {
        headers: { host: "kb.example.invalid" },
      });
      expect(await response.json()).toEqual({
        issuer: `${baseUrl}/api/auth`,
        scopes_supported: ["mcp:read"],
      });
    }
  });
  function fixture() {
    const app = new Hono();
    const handler = vi.fn(async (req: Request) =>
      Response.json({ url: req.url, method: req.method }),
    );
    mountMcpOAuth(app, { baseUrl, handler });
    app.all("*", (c) => c.text("shell"));
    return {
      app,
      handler,
      send: (path: string, method = "GET") =>
        app.request(`${baseUrl}${path}`, { method, headers: { host: "kb.example.invalid" } }),
    };
  }
  it("forwards exact aliases; HEAD is bodyless and other methods 405", async () => {
    const f = fixture();
    for (const path of MCP_DISCOVERY_PATHS) {
      expect(await (await f.send(path)).json()).toEqual({ url: baseUrl + path, method: "GET" });
      expect(await (await f.send(path, "HEAD")).text()).toBe("");
      const denied = await f.send(path, "POST");
      expect(denied.status).toBe(405);
      expect(denied.headers.get("allow")).toBe("GET, HEAD");
    }
  });
  it("MCP pages, discovery and OAuth are always routed; nothing is reserved as a 404", async () => {
    const f = fixture();
    for (const path of MCP_DISCOVERY_PATHS) expect((await f.send(path)).status).toBe(200);
    for (const path of ["/en-US/mcp-login", "/en-US/mcp-consent", "/es-MX/mcp-consent"])
      expect(await (await f.send(path)).text()).toBe("shell");
    expect((await f.send("/api/auth/oauth2/authorize")).status).not.toBe(404);
  });
  it.each([
    "/api/auth/oauth2/%61uthorize",
    "/api/auth/oauth2/authorize/",
    "/.well-known/oauth-protected-resource%2fmcp",
    "/api/auth/%6fauth2/authorize",
  ])("rejects noncanonical path %s", async (path) => {
    const f = fixture();
    expect((await f.send(path)).status).toBe(404);
    expect(f.handler).not.toHaveBeenCalled();
  });
});
