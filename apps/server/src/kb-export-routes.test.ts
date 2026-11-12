import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { downloadExport } from "@knowledge-base/api/lib/kb/transfers";
import { captureLog } from "@knowledge-base/env/log";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKbExportRoutes } from "./kb-export-routes";
import { mountSecurityHeaders } from "./security-headers";

vi.mock("@knowledge-base/api/lib/kb/transfers", () => ({ downloadExport: vi.fn() }));
const path = `/kb-exports/${"a".repeat(24)}/11111111-1111-4111-8111-111111111111`;
function app(user = true) {
  const app = new Hono();
  mountSecurityHeaders(app, { cspConnectSrc: ["'self'"], themeInitCspHash: "'sha256-test'" });
  app.use("*", cors({ origin: "https://foreign.invalid", credentials: true }));
  app.route(
    "/",
    createKbExportRoutes({
      runtime: () => ({ canonicalOrigin: "https://kb.example.invalid" }) as KbRuntimeConfig,
      session: async () => (user ? { user: { id: "owner" } } : null),
    }),
  );
  return app;
}
beforeEach(() => vi.resetAllMocks());
describe("private ZIP browser route", () => {
  it("passes bearer principal and live verifier to the stream without consulting cookies", async () => {
    const session = vi.fn();
    const principal = {
      kind: "token" as const,
      userId: "owner",
      grantId: "g",
      grantGeneration: "g",
      scopes: ["mcp:read"],
      storedAcl: new Map(),
      expiresAt: new Date("2099-01-01"),
    };
    const verifier = { inspect: vi.fn() };
    vi.mocked(downloadExport).mockResolvedValue({
      size: 0,
      body: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    });
    const routes = createKbExportRoutes({
      runtime: () => ({ canonicalOrigin: "https://kb.example.invalid" }) as KbRuntimeConfig,
      session,
      bearer: async () => ({ principal, verifier }),
    });
    expect(
      (
        await routes.request(path, {
          headers: { authorization: "Bearer fixture", cookie: "session=owner" },
        })
      ).status,
    ).toBe(200);
    expect(session).not.toHaveBeenCalled();
    // Export downloads demand the `export` tool group on every live recheck.
    expect(vi.mocked(downloadExport).mock.calls[0]![1]).toEqual({
      principal: { ...principal, toolGroupDemands: [["export"]] },
      verifier,
    });
  });
  it("streams exact artifact with final sandbox/no-store/attachment headers", async () => {
    vi.mocked(downloadExport).mockResolvedValue({
      size: 3,
      body: new ReadableStream({
        start(c) {
          c.enqueue(Buffer.from("zip"));
          c.close();
        },
      }),
    });
    const response = await app().request(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("zip");
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="knowledge-base.zip"',
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(vi.mocked(downloadExport).mock.calls[0]![1]).toEqual({
      principal: { kind: "browser", userId: "owner" },
    });
  });
  it("denies anonymous, bearer+cookie and cross-origin requests before file lookup", async () => {
    expect((await app(false).request(path)).status).toBe(401);
    expect(
      (await app().request(path, { headers: { authorization: "Bearer invalid-fixture" } })).status,
    ).toBe(401);
    expect(
      (await app().request(path, { headers: { origin: "https://foreign.invalid" } })).status,
    ).toBe(403);
    expect(
      (await app().request(path, { headers: { "sec-fetch-site": "cross-site" } })).status,
    ).toBe(403);
    expect(downloadExport).not.toHaveBeenCalled();
  });
  it("rejects malformed paths, extra parameters and methods without SPA fallthrough", async () => {
    expect((await app().request("/kb-exports/bad/bad")).status).toBe(400);
    expect((await app().request(`${path}?token=fixture`)).status).toBe(400);
    expect((await app().request(path, { method: "POST" })).status).toBe(404);
    expect((await app().request(path, { method: "HEAD" })).status).toBe(404);
    expect(downloadExport).not.toHaveBeenCalled();
  });
  it.each([
    ["NOT_FOUND", 404],
    ["UNAUTHORIZED", 401],
    ["FORBIDDEN", 403],
    ["STORAGE_UNAVAILABLE", 503],
  ])("redacts %s errors", async (code, status) => {
    vi.mocked(downloadExport).mockRejectedValue(
      Object.assign(new Error("private disk path"), { code }),
    );
    const response = await app().request(path);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private disk path");
  });
  it("logs only unmapped failures, as a fixed record", async () => {
    const logged = captureLog();
    try {
      vi.mocked(downloadExport).mockRejectedValue(
        Object.assign(new Error("private disk path"), { code: "NOT_FOUND" }),
      );
      expect((await app().request(path)).status).toBe(404);
      expect(logged.records).toEqual([]);
      vi.mocked(downloadExport).mockRejectedValue(
        Object.assign(new Error("private disk path"), { code: "STORAGE_UNAVAILABLE" }),
      );
      expect((await app().request(path)).status).toBe(503);
      expect(logged.records).toEqual([
        {
          level: "error",
          site: "http.unhandled",
          message: "unhandled error in an HTTP route",
          errorClass: "Error",
          errorCode: "STORAGE_UNAVAILABLE",
          method: "GET",
          route: "/kb-exports/:kbId/:transferId",
          code: "STORAGE_UNAVAILABLE",
        },
      ]);
    } finally {
      logged.restore();
    }
  });
});
