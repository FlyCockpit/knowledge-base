import { authorizedAssetStream } from "@knowledge-base/api/lib/kb/authorized-stream";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import type { PrismaClient } from "@knowledge-base/db/client";
import { captureLog } from "@knowledge-base/env/log";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RateLimiterRes } from "rate-limiter-flexible";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import { bodyPolicyMiddleware } from "./body-policy";
import { createKbAssetRoutes } from "./kb-asset-routes";
import { mountSecurityHeaders } from "./security-headers";

vi.mock("@knowledge-base/api/lib/kb/authorized-stream", async (original) => ({
  ...(await original<typeof import("@knowledge-base/api/lib/kb/authorized-stream")>()),
  authorizedAssetStream: vi.fn(),
}));
const path = `/kb-assets/${"a".repeat(24)}/sha256:${"b".repeat(64)}?rev=${"c".repeat(40)}`;
const session = vi.fn(async (_headers: Headers) => ({ user: { id: "owner" } }));
const runtime = (): Pick<
  KbRuntimeConfig,
  "prisma" | "reposDir" | "blobStore" | "canonicalOrigin"
> => ({
  prisma: mockDeep<PrismaClient>(),
  reposDir: "/fixture/repos",
  blobStore: createDiskBlobStore("/fixture/assets"),
  canonicalOrigin: "https://kb.example.invalid",
});
function app(authenticated = true) {
  const app = new Hono();
  mountSecurityHeaders(app, { cspConnectSrc: ["'self'"], themeInitCspHash: "'sha256-test'" });
  app.use("*", bodyPolicyMiddleware());
  app.use("*", cors({ origin: "https://foreign.invalid", credentials: true }));
  app.route(
    "/",
    createKbAssetRoutes({ runtime, session: authenticated ? session : async () => null }),
  );
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
});
describe("asset HTTP boundary", () => {
  it.each(["image/png", "application/pdf"])(
    "final headers for %s survive all middleware",
    async (mime) => {
      vi.mocked(authorizedAssetStream).mockResolvedValue({
        asset: { path: "untrusted-name", hash: "hash", size: 3, mime },
        range: { start: 0, end: 2, partial: false },
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
        }),
      });
      const response = await app().request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mime);
      expect(response.headers.get("content-disposition")).toBe(
        mime === "application/pdf" ? "attachment" : "inline",
      );
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
      expect(response.headers.has("access-control-allow-credentials")).toBe(false);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    },
  );
  it("anonymous and bearer+cookie requests get no asset or existence detail", async () => {
    for (const url of [path, "/kb-assets/bad/nope"]) {
      const response = await app(false).request(url);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(authorizedAssetStream).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    // A valid cookie must not rescue a rejected credential or broaden its ACL.
    for (const authorization of ["Bearer test-only-invalid", "Basic test-only-invalid", ""]) {
      const response = await app().request(path, {
        headers: { authorization, cookie: "test-only-valid-session" },
      });
      expect(response.status).toBe(401);
    }
    expect(session).not.toHaveBeenCalled();
    expect(authorizedAssetStream).not.toHaveBeenCalled();
  });
  it("a bearer asset read demands the read tool group on every recheck", async () => {
    vi.mocked(authorizedAssetStream).mockResolvedValue({
      asset: { path: "a", hash: "hash", size: 0, mime: "image/png" },
      range: { start: 0, end: -1, partial: false },
      body: null,
    });
    const principal = {
      kind: "token" as const,
      userId: "u",
      grantId: "g",
      grantGeneration: "g",
      scopes: ["mcp:read"],
      expiresAt: null,
      storedAcl: new Map(),
    };
    const verifier = { inspect: vi.fn() };
    const routes = new Hono();
    routes.route(
      "/",
      createKbAssetRoutes({ runtime, session, bearer: async () => ({ principal, verifier }) }),
    );
    await routes.request(path, { headers: { authorization: "Bearer fixture" } });
    expect(vi.mocked(authorizedAssetStream).mock.calls[0]![0]).toMatchObject({
      principal: { ...principal, toolGroupDemands: [["read"]] },
      verifier,
    });
    expect(session).not.toHaveBeenCalled();
  });
  it.each([
    { origin: "https://foreign.invalid" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ])("rejects foreign origin metadata %j", async (headers) => {
    expect((await app().request(path, { headers })).status).toBe(403);
    expect(authorizedAssetStream).not.toHaveBeenCalled();
  });
  it("rejects missing, duplicate or extra revision query input before storage", async () => {
    for (const url of [
      path.split("?")[0]!,
      `${path}&rev=${"d".repeat(40)}`,
      `${path}&token=test-only`,
    ]) {
      expect((await app().request(url)).status).toBe(400);
    }
    expect(authorizedAssetStream).not.toHaveBeenCalled();
  });
  it("maps work-budget exhaustion to 429 with Retry-After", async () => {
    vi.mocked(authorizedAssetStream).mockRejectedValue(new RateLimiterRes(0, 45_000));
    const response = await app().request(path);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(await response.json()).toEqual({
      error: "Too many attempts. Please wait a moment and try again.",
    });
  });
  it("logs an unexpected failure as a fixed record and answers only 503", async () => {
    vi.mocked(authorizedAssetStream).mockRejectedValue(new TypeError("private disk path"));
    const logged = captureLog();
    try {
      const response = await app().request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "STORAGE_UNAVAILABLE" });
      expect(logged.records).toEqual([
        {
          level: "error",
          site: "http.unhandled",
          message: "unhandled error in an HTTP route",
          errorClass: "TypeError",
          method: "GET",
          route: "/kb-assets/:kbId/:hash",
        },
      ]);
    } finally {
      logged.restore();
    }
  });
  it("does not log a mapped failure", async () => {
    vi.mocked(authorizedAssetStream).mockRejectedValue(
      Object.assign(new Error("gone"), { code: "NOT_FOUND" }),
    );
    const logged = captureLog();
    try {
      expect((await app().request(path)).status).toBe(404);
      expect(logged.records).toEqual([]);
    } finally {
      logged.restore();
    }
  });
  it("does not read unsupported method bodies", async () => {
    const pull = vi.fn();
    const request = new Request(`https://kb.example.invalid${path}`, {
      method: "POST",
      body: new ReadableStream({ pull }, { highWaterMark: 0 }),
      ...{ duplex: "half" },
    });
    const response = await app().request(request);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(pull).not.toHaveBeenCalled();
    expect(authorizedAssetStream).not.toHaveBeenCalled();
    await request.body!.cancel();
  });
});
