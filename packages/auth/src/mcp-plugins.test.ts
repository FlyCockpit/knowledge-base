import prisma from "@knowledge-base/db";
import { describe, expect, it, vi } from "vitest";
import { fetchClientMetadataResource } from "./mcp-cimd";
import { registrationRedirectPolicy, resolveMcpPlugins } from "./mcp-plugins";
import { isRegisteredRedirectUri, isStrictLoopbackHttpRedirect } from "./mcp-redirect";

const captured = vi.hoisted(() => ({ mcp: vi.fn(), cimd: vi.fn() }));
vi.mock("@better-auth/mcp", () => ({ mcp: captured.mcp }));
vi.mock("@better-auth/cimd", () => ({ cimd: captured.cimd }));
vi.mock("@knowledge-base/db", () => ({ default: {} }));
describe("pinned MCP plugin composition", () => {
  it("always composes OAuth and pins resource, lifetimes, PKCE and hardened CIMD transport", () => {
    resolveMcpPlugins({
      db: prisma,
      baseUrl: "https://kb.invalid",
      secret: "fixture",
    });
    expect(captured.mcp).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "https://kb.invalid/mcp",
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 600,
        refreshTokenExpiresIn: 259200,
        refreshTokenReuseInterval: 30,
        enforcePerClientResources: true,
        clientRegistrationRequirePKCE: true,
      }),
    );
    expect(captured.cimd).toHaveBeenCalledWith(
      expect.objectContaining({
        metadataProfile: "mcp-2026-07-28",
        fetchClientMetadataResource: expect.any(Function),
      }),
    );
  });
  it("metadata transport refuses HTTP and private loopback before a connection", async () => {
    await expect(fetchClientMetadataResource("http://127.0.0.1/client.json")).rejects.toThrow();
    await expect(fetchClientMetadataResource("https://127.0.0.1/client.json")).rejects.toThrow(
      "public-routable",
    );
  });
});

describe("DCR loopback redirect policy (RFC 8252)", () => {
  const publicClient = (redirect_uris: string[], extra: Record<string, unknown> = {}) => ({
    redirect_uris,
    token_endpoint_auth_method: "none",
    ...extra,
  });
  it.each([
    "http://127.0.0.1:53682/callback",
    "http://[::1]:8080/cb",
    "http://localhost:3000/oauth/callback",
  ])("treats a public client with only loopback http redirects as native: %s", (uri) => {
    expect(registrationRedirectPolicy(publicClient([uri]))).toEqual({ kind: "native" });
  });
  it("leaves explicit native registrations and https web clients to Better Auth", () => {
    expect(
      registrationRedirectPolicy(
        publicClient(["http://127.0.0.1:1/cb"], { application_type: "native" }),
      ),
    ).toBeNull();
    expect(registrationRedirectPolicy(publicClient(["https://app.example/cb"]))).toBeNull();
    expect(registrationRedirectPolicy("not an object")).toBeNull();
  });
  it("still rejects non-loopback http, with a message that says so", () => {
    const decision = registrationRedirectPolicy(publicClient(["http://app.example/cb"]));
    expect(decision).toEqual({
      kind: "reject",
      description: "web clients require https redirect URIs: http://app.example/cb",
    });
  });
  it("explains how to register loopback http for confidential or explicit web clients", () => {
    for (const body of [
      { redirect_uris: ["http://127.0.0.1:53682/callback"] },
      publicClient(["http://127.0.0.1:53682/callback"], { application_type: "web" }),
      publicClient(["http://127.0.0.1:53682/callback", "https://app.example/cb"]),
    ]) {
      const decision = registrationRedirectPolicy(body);
      expect(decision?.kind).toBe("reject");
      expect(decision && "description" in decision && decision.description).toMatch(
        /application_type "native".*http:\/\/127\.0\.0\.1:53682\/callback$/,
      );
      expect(decision && "description" in decision && decision.description).not.toMatch(
        /non-loopback/,
      );
    }
  });
  it("does not promote look-alike hosts or https loopback", () => {
    expect(registrationRedirectPolicy(publicClient(["http://127.0.0.2/cb"]))?.kind).toBe("reject");
    expect(
      registrationRedirectPolicy(publicClient(["http://localhost.evil.example/cb"]))?.kind,
    ).toBe("reject");
    const https = registrationRedirectPolicy(publicClient(["https://localhost/cb"]));
    expect(https && "description" in https && https.description).toMatch(
      /must not use loopback redirect URIs/,
    );
  });
});

describe("strict loopback redirect parsing (fails closed on parser disagreement)", () => {
  it.each([
    "http://127.0.0.1:53682/callback",
    "http://[::1]:8080/cb",
    "http://localhost:3000/oauth/callback",
    "http://LOCALHOST/cb",
    "http://127.0.0.1/cb?x=1",
  ])("accepts %s", (uri) => {
    expect(isStrictLoopbackHttpRedirect(uri)).toBe(true);
  });
  it.each([
    "http://public.example\\@127.0.0.1/cb",
    "http://public.example@127.0.0.1/cb",
    "http://user:pw@localhost/cb",
    "http://127.0.0.1@public.example/cb",
    "http://localhost\\.public.example/cb",
    "http://127.0.0.1/cb\\x",
    "http://%31%32%37.0.0.1/cb",
    "http://127.0.0.1%2F@public.example/cb",
    "http://localhost.public.example/cb",
    "http://127.1/cb",
    "http://127.0.0.2/cb",
    "http://0x7f.0.0.1/cb",
    "http://127.0.0.1:0/cb",
    "http://127.0.0.1:99999/cb",
    "http://127.0.0.1/cb#frag",
    "http:// 127.0.0.1/cb",
    "https://127.0.0.1/cb",
  ])("rejects %s", (uri) => {
    expect(isStrictLoopbackHttpRedirect(uri)).toBe(false);
    expect(
      registrationRedirectPolicy({ redirect_uris: [uri], token_endpoint_auth_method: "none" })
        ?.kind,
    ).not.toBe("native");
  });
});

describe("registered redirect matching (RFC 8252 §7.3, as Better Auth's authorize applies it)", () => {
  // Codex's client metadata document registers portless loopback callbacks.
  const codex = ["http://127.0.0.1/callback", "http://localhost/callback"];

  it("lets only the port of a loopback http redirect vary", () => {
    expect(isRegisteredRedirectUri(codex, "http://127.0.0.1:45853/callback")).toBe(true);
    expect(isRegisteredRedirectUri(codex, "http://localhost:1234/callback")).toBe(true);
    expect(isRegisteredRedirectUri(codex, "http://127.0.0.1/callback")).toBe(true);
    expect(isRegisteredRedirectUri(["http://[::1]:8080/cb"], "http://[::1]:9/cb")).toBe(true);
    expect(
      isRegisteredRedirectUri(["http://127.0.0.1:3000/cb?x=1"], "http://127.0.0.1:4000/cb?x=1"),
    ).toBe(true);
  });

  it.each([
    ["another path", "http://127.0.0.1:45853/other"],
    ["another query", "http://127.0.0.1:45853/callback?x=1"],
    ["another loopback host", "http://[::1]:45853/callback"],
    ["https", "https://127.0.0.1:45853/callback"],
    ["userinfo", "http://evil@127.0.0.1:45853/callback"],
    ["a look-alike host", "http://127.0.0.1.evil.example:45853/callback"],
    ["a fragment", "http://127.0.0.1:45853/callback#x"],
    ["port 0", "http://127.0.0.1:0/callback"],
  ])("refuses %s", (_label, uri) => {
    expect(isRegisteredRedirectUri(codex, uri)).toBe(false);
  });

  it.each([
    "http://127.0.0.1/callback#x",
    "http://127.0.0.1/callback#",
    "https://user:pw@client.example/cb",
    "not a url",
  ])("refuses %s even when it is registered verbatim, as Better Auth does", (uri) => {
    expect(isRegisteredRedirectUri([uri], uri)).toBe(false);
  });

  it("keeps every non-loopback redirect an exact match", () => {
    const web = ["https://client.example/cb"];
    expect(isRegisteredRedirectUri(web, "https://client.example/cb")).toBe(true);
    expect(isRegisteredRedirectUri(web, "https://client.example:8443/cb")).toBe(false);
    expect(
      isRegisteredRedirectUri(["http://client.example/cb"], "http://client.example:80/cb"),
    ).toBe(false);
    expect(isRegisteredRedirectUri([], "http://127.0.0.1:45853/callback")).toBe(false);
  });
});
