import { describe, expect, it } from "vitest";
import { canonicalOAuthRequest, guardMcpAuthorize } from "./mcp-authorize-scope-guard";

const base = "https://kb.example.invalid";
const path = "/api/auth/oauth2/authorize";
function request(query = "", init: RequestInit = {}) {
  return new Request(`${base}${path}?${query}`, {
    ...init,
    headers: { host: "kb.example.invalid", ...init.headers },
  });
}
describe("authorize boundary", () => {
  it.each(["", "scope=", "scope=+", "scope=%09"])(
    "rejects blank scope locally: %s",
    async (query) => {
      const response = await guardMcpAuthorize(
        request(`${query}&redirect_uri=https://evil.invalid`),
        base,
      );
      expect(response?.status).toBe(400);
      expect(response?.headers.get("location")).toBeNull();
      expect(await response?.json()).toMatchObject({ error: "invalid_scope" });
    },
  );
  it.each(["", "https://evil.invalid/mcp", `${base}/mcp/`, `${base}/mcp#kb=x`])(
    "rejects foreign/missing resource: %s",
    async (resource) => {
      const response = await guardMcpAuthorize(
        request(new URLSearchParams({ scope: "mcp:read", resource }).toString()),
        base,
      );
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({ error: "invalid_target" });
    },
  );
  it("accepts exact scope/resource; rejects duplicates and unrecognized scopes", async () => {
    const good = new URLSearchParams({
      scope: "mcp:write offline_access",
      resource: `${base}/mcp`,
    });
    expect(await guardMcpAuthorize(request(good.toString()), base)).toBeNull();
    for (const extra of ["&scope=mcp:read", "&resource=https://evil.invalid", "&scope=openid"]) {
      expect((await guardMcpAuthorize(request(good + extra), base))?.status).toBe(400);
    }
  });
  it("checks last form value without consuming original body; rejects hybrid content types", async () => {
    const body = `scope=mcp:read&resource=${encodeURIComponent(`${base}/mcp`)}&scope=+`;
    const req = request("", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(await (await guardMcpAuthorize(req, base))?.json()).toMatchObject({
      error: "invalid_scope",
    });
    expect(await req.text()).toBe(body);
    expect(
      (
        await guardMcpAuthorize(
          request("", {
            method: "POST",
            headers: { "content-type": "application/json+application/x-www-form-urlencoded" },
            body: "{}",
          }),
          base,
        )
      )?.status,
    ).toBe(415);
  });
  it("rebuilds public origin and strips forwarding, proxy and nominated headers", async () => {
    const req = new Request(`http://kb.example.invalid${path}`, {
      headers: {
        host: "kb.example.invalid",
        forwarded: "host=evil.invalid",
        "x-forwarded-host": "evil.invalid",
        "x-forwarded-proto": "http",
        connection: "x-private, set-cookie",
        "x-private": "secret",
        "proxy-authorization": "secret",
        "set-cookie": "secret",
        authorization: "Bearer fixture",
      },
    });
    const clone = canonicalOAuthRequest(req, base);
    expect(clone.url).toBe(`${base}${path}`);
    for (const key of [
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
      "connection",
      "x-private",
      "proxy-authorization",
      "set-cookie",
    ])
      expect(clone.headers.has(key)).toBe(false);
    expect(clone.headers.get("authorization")).toBe("Bearer fixture");
  });
  it.each([
    { host: "evil.invalid" },
    { host: "kb.example.invalid, evil.invalid" },
    { origin: "https://evil.invalid" },
    { origin: `${base}/` },
    { origin: "null" },
  ])("rejects spoofed authority %j", (headers) => {
    expect(() => canonicalOAuthRequest(request("", { headers }), base)).toThrow();
  });
});
