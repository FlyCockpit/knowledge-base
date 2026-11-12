import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { SimpleCsrfProtectionHandlerPlugin } from "@orpc/server/plugins";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bodyPolicyMiddleware } from "./body-policy.js";

// Execute the actual route registrations without importing index.ts, which
// starts the production lifecycle and opens external services at module scope.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
function mountRoute(app: object, method: string, path: string, bindings: object = {}) {
  const start = source.indexOf(`app.${method}("${path}",`);
  if (start === -1) throw new Error(`Missing ${method} ${path} route`);
  const firstLineEnd = source.indexOf("\n", start);
  const end = source.slice(start, firstLineEnd).endsWith(");")
    ? firstLineEnd
    : source.indexOf("\n});", start) + "\n});".length;
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), { app, ...bindings });
}

// Preserve production ordering: unknown API paths stop before static + SSR.
let clientDir: string;

function buildProductionLikeApp() {
  const app = new Hono();
  app.get("/api/live", (c) => c.json({ live: true }));
  mountRoute(app, "all", "/api/*");
  app.use("/*", serveStatic({ root: clientDir }));
  app.all("/*", (c) => c.html("<!doctype html><html><body>spa</body></html>", 200));
  return app;
}

beforeAll(() => {
  clientDir = mkdtempSync(join(tmpdir(), "client-dist-unknown-api-"));
  writeFileSync(join(clientDir, "index.html"), "<!doctype html><html></html>\n");
});

afterAll(() => {
  rmSync(clientDir, { recursive: true, force: true });
});

describe("unknown API paths", () => {
  it.each([
    ["GET", "/api/assets"],
    ["GET", "/api/unknown/nested"],
    ["POST", "/api/unknown"],
    ["DELETE", "/api/unknown"],
  ])("%s %s returns 404 instead of the SPA shell", async (method, path) => {
    const res = await buildProductionLikeApp().request(path, { method });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("keeps the fallback after live APIs and before static/SSR serving", async () => {
    expect(source.indexOf('app.all("/api/*"')).toBeGreaterThan(
      source.indexOf('app.on(["POST", "GET"], "/api/auth/*"'),
    );
    expect(source.indexOf('app.all("/api/*"')).toBeLessThan(
      source.indexOf('app.use("/*", serveStatic'),
    );
    const res = await buildProductionLikeApp().request("/api/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ live: true });
  });

  it("still serves the SPA shell for unrelated paths", async () => {
    const res = await buildProductionLikeApp().request("/dashboard");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa");
  });
});

describe("oRPC CSRF protection in same-origin deployments", () => {
  it("always wires the CSRF plugin into both production handlers", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("const csrfPlugins = [new SimpleCsrfProtectionHandlerPlugin()];");
    expect(source.match(/\.\.\.csrfPlugins/g)).toHaveLength(2);
  });

  it.each(["rpc", "openapi"] as const)(
    "%s rejects headerless multipart requests and accepts the CSRF header",
    async (kind) => {
      const called = vi.fn(() => ({ success: true }));
      const router = { test: os.route({ method: "POST", path: "/test" }).handler(called) };
      const options = { plugins: [new SimpleCsrfProtectionHandlerPlugin()] };
      const handler =
        kind === "rpc" ? new RPCHandler(router, options) : new OpenAPIHandler(router, options);
      const app = new Hono();
      app.use("*", bodyPolicyMiddleware());
      app.all("/rpc/*", async (c) => {
        const result = await handler.handle(c.req.raw, { prefix: "/rpc", context: {} });
        return result.response ?? c.notFound();
      });
      const post = (headers?: Record<string, string>) => {
        const body = new FormData();
        body.set("data", JSON.stringify({ json: null }));
        return app.request("https://app.example.test/rpc/test", {
          method: "POST",
          headers: { origin: "https://sibling.example.test", ...headers },
          body,
        });
      };
      const denied = await post();
      expect(denied.status).toBe(403);
      expect(called).not.toHaveBeenCalled();
      const wrong = await post({ "x-csrf-token": "wrong" });
      expect(wrong.status).toBe(403);
      expect(called).not.toHaveBeenCalled();
      const allowed = await post({ "x-csrf-token": "orpc" });
      expect(allowed.status).toBe(200);
      expect(called).toHaveBeenCalledOnce();
    },
  );
});

describe("readiness dependency checks", () => {
  function buildApp(commit: string | null = "a".repeat(40)) {
    const app = new Hono();
    const postgres = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
    const redis = vi.fn<() => Promise<string>>().mockResolvedValue("PONG");
    const workers = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const withTimeout = vi.fn((promise: Promise<unknown>, _ms: number, _label: string) => promise);
    mountRoute(app, "get", "/ready", {
      prisma: { $queryRaw: postgres },
      redisConnection: { ping: redis },
      hasExternalConsumer: workers,
      QUEUE_NAMES: { first: "first", second: "second" },
      withTimeout,
      buildCommit: commit,
    });
    return { app, postgres, redis, workers, withTimeout };
  }

  it("includes a null commit when build metadata is unavailable", async () => {
    const response = await buildApp(null).app.request("/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ commit: null });
  });

  it("includes the build commit in the shutdown response before dependency probes", async () => {
    const app = new Hono();
    mountRoute(app, "use", "/ready", {
      lifecycle: { isShuttingDown: () => true },
      buildCommit: "b".repeat(40),
    });
    const response = await app.request("/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      commit: "b".repeat(40),
      checks: { shuttingDown: true },
    });
  });

  it("starts Redis and worker checks while Postgres is still pending", async () => {
    const { app, postgres, redis, workers, withTimeout } = buildApp();
    const slow = Promise.withResolvers<unknown>();
    postgres.mockReturnValue(slow.promise);
    const response = app.request("/ready");
    await vi.waitFor(() => {
      expect(redis).toHaveBeenCalledOnce();
      expect(workers).toHaveBeenCalledOnce();
    });
    slow.resolve([]);
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      JSON.stringify({
        ok: true,
        commit: "a".repeat(40),
        checks: { postgres: true, redis: true, workers: true },
      }),
    );
    expect(withTimeout.mock.calls.map(([, ms, label]) => [ms, label])).toEqual([
      [3000, "postgres readiness check"],
      [3000, "redis readiness check"],
      [3000, "consumer readiness check"],
    ]);
  });

  it.each(["postgres", "redis", "workers", "no workers"] as const)(
    "preserves the status, field order, and failure-prefix values for %s failure",
    async (failed) => {
      const fixture = buildApp();
      if (failed === "no workers") fixture.workers.mockResolvedValue(false);
      else fixture[failed].mockRejectedValue(new Error("unavailable or timed out"));
      const res = await fixture.app.request("/ready");
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(
        JSON.stringify({
          ok: false,
          commit: "a".repeat(40),
          checks: {
            postgres: failed !== "postgres",
            redis: failed !== "postgres" && failed !== "redis",
            workers: false,
          },
        }),
      );
    },
  );

  it("handles synchronous dependency errors without skipping the other probes", async () => {
    const { app, postgres, redis, workers } = buildApp();
    postgres.mockImplementation(() => {
      throw new Error("connection unavailable");
    });
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      commit: "a".repeat(40),
      checks: { postgres: false, redis: false, workers: false },
    });
    expect(redis).toHaveBeenCalledOnce();
    expect(workers).toHaveBeenCalledOnce();
  });
});

describe("push renewal", () => {
  function buildApp(
    error?: Error,
    admission: { banned?: boolean; impersonated?: boolean; twoFactor?: boolean } = {},
  ) {
    const app = new Hono<{ Variables: { session: { user: { id: string } } } }>();
    app.use("*", async (c, next) => {
      c.set("session", { user: { id: "user" } });
      await next();
    });
    app.onError((_error, c) => c.json({ error: "internal error" }, 500));
    const upsert = vi.fn().mockImplementation(async () => {
      if (error) throw error;
    });
    mountRoute(app, "post", "/sw/push-renew", {
      validateSameSiteJsonRequest: () => undefined,
      pushSubscriptionInputSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
      upsertPushSubscription: upsert,
      ORPCError,
      isUserBanned: () => admission.banned ?? false,
      isImpersonatedSession: () => admission.impersonated ?? false,
      isTwoFactorPolicySatisfied: async () => admission.twoFactor ?? true,
    });
    return app;
  }

  it.each([
    [undefined, 200, { success: true }],
    [
      new ORPCError("CONFLICT", { message: "endpoint already registered" }),
      409,
      { error: "endpoint already registered" },
    ],
    [new ORPCError("INTERNAL_SERVER_ERROR"), 500, { error: "internal error" }],
    [new Error("storage unavailable"), 500, { error: "internal error" }],
  ] as const)("returns the expected HTTP status (%s → %s)", async (error, status, body) => {
    const res = await buildApp(error).request("/sw/push-renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "fixture" }),
    });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });
  it.each([
    [{ banned: true }, 401],
    [{ impersonated: true }, 401],
    [{ twoFactor: false }, 403],
  ] as const)("rejects inadmissible renewal before storage: %j", async (admission, status) => {
    const response = await buildApp(new Error("must not write"), admission).request(
      "/sw/push-renew",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(status);
  });
});
