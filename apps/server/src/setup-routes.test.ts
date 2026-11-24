import { readFileSync } from "node:fs";
import type { LogRecord } from "@knowledge-base/env/log";
import { Secret } from "@knowledge-base/env/secret";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// rate-limit.ts opens Redis at import time and the setup lib imports
// Prisma/Better-Auth; every dependency is injected below instead.
vi.mock("./rate-limit.js", async () => {
  const { RateLimiterRes } = await import("rate-limiter-flexible");
  return {
    setupLimiter: { points: 0, consume: vi.fn() },
    createRateLimiterMiddleware:
      (limiter: { consume: (key: string) => Promise<unknown> }) =>
      async (
        c: { json: (body: unknown, status: number) => Response },
        next: () => Promise<void>,
      ) => {
        try {
          await limiter.consume("ip");
        } catch (err) {
          if (err instanceof RateLimiterRes) return c.json({ error: "Too many attempts" }, 429);
          return c.json({ error: "unavailable" }, 503);
        }
        await next();
      },
  };
});
vi.mock("./client-ip.js", () => ({ resolveClientIp: () => "203.0.113.5" }));
vi.mock("@knowledge-base/api/lib/setup-admin", () => ({ issueSetupLink: vi.fn() }));

const { captureLog } = await import("@knowledge-base/env/log");
const { mountSetupRoutes, SETUP_ADMIN_PATH, SETUP_LINK_TTL_SECONDS, setupKeyMatches } =
  await import("./setup-routes.js");
const { issueSetupLink } = await import("@knowledge-base/api/lib/setup-admin");

const KEY = "Qm7vT2xK9pL4wN8rB3cZ6hJ1dF5sG0yU-setup";
const LINK = {
  url: "https://app.example.com/en-US/reset-password?setup=1&token=tok",
  expiresAt: new Date("2026-11-23T13:00:00Z"),
  email: "owner@example.com",
};
const READY = { kind: "ready", ...LINK } as const;

let records: LogRecord[];
let restoreLog: () => void;

function build(
  overrides: Partial<Omit<Parameters<typeof mountSetupRoutes>[1], "setupKey">> & {
    setupKey?: string | null;
  } = {},
) {
  const issue = vi.fn().mockResolvedValue(READY);
  const limiter = new RateLimiterMemory({ points: 100, duration: 60 });
  const app = new Hono();
  const { setupKey = KEY, ...rest } = overrides;
  mountSetupRoutes(app, {
    passwordSignInEnabled: true,
    limiter: limiter as never,
    issue,
    ...rest,
    setupKey: setupKey === null ? undefined : new Secret(setupKey),
  });
  return { app, issue };
}

function post(app: Hono, body: unknown, init: RequestInit = {}) {
  return app.request(SETUP_ADMIN_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function audits() {
  return records.filter((record) => record.site === "setup.first-admin");
}
function outcomes() {
  return audits().map((record) => record.reason);
}

beforeEach(() => {
  vi.clearAllMocks();
  ({ records, restore: restoreLog } = captureLog());
});
afterEach(() => restoreLog());

describe("setup route — existence", () => {
  it("is absent (404 for every method) while SETUP_KEY is unset", async () => {
    const { app, issue } = build({ setupKey: null });

    expect((await post(app, { key: KEY, email: "owner@example.com" })).status).toBe(404);
    expect((await app.request(SETUP_ADMIN_PATH)).status).toBe(404);
    expect(issue).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("answers only POST while SETUP_KEY is set", async () => {
    const { app } = build();

    const res = await app.request(SETUP_ADMIN_PATH);
    expect(res.status).toBe(405);
    expect(outcomes()).toEqual(["invalid_request"]);
  });
});

describe("setup route — key", () => {
  it("refuses a wrong key before reading anything else, and audits it", async () => {
    const { app, issue } = build();

    const res = await post(app, { key: `${KEY}x`, email: "owner@example.com" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_key" });
    expect(issue).not.toHaveBeenCalled();
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ reason: "invalid_key", status: 401 });
    // No secret and no caller-supplied address in the record.
    expect(JSON.stringify(records)).not.toContain(KEY);
    expect(JSON.stringify(records)).not.toContain("owner@example.com");
  });

  it("treats a missing, non-string or malformed body as a wrong key", async () => {
    const { app } = build();

    expect((await post(app, { email: "owner@example.com" })).status).toBe(401);
    expect((await post(app, { key: 123, email: "owner@example.com" })).status).toBe(401);
    expect((await post(app, "not json")).status).toBe(401);
    expect(outcomes()).toEqual(["invalid_key", "invalid_key", "invalid_key"]);
  });

  it("compares through equal-length digests (constant-time path for any length)", () => {
    expect(setupKeyMatches(KEY, KEY)).toBe(true);
    expect(setupKeyMatches(KEY.slice(0, -1), KEY)).toBe(false);
    expect(setupKeyMatches(`${KEY}${"x".repeat(500)}`, KEY)).toBe(false);
    expect(setupKeyMatches("", KEY)).toBe(false);
    expect(setupKeyMatches(undefined, KEY)).toBe(false);
  });
});

describe("setup route — issuing", () => {
  it("returns a one-time link; the record holds no email or link", async () => {
    const { app, issue } = build();

    const res = await post(app, { key: KEY, email: "  Owner@Example.com " });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      url: LINK.url,
      expiresAt: LINK.expiresAt.toISOString(),
      email: "owner@example.com",
    });
    expect(issue).toHaveBeenCalledWith("owner@example.com");
    expect(audits()[0]).toMatchObject({ reason: "link_issued", status: 200 });
    expect(JSON.stringify(records)).not.toContain("owner@example.com");
    expect(JSON.stringify(records)).not.toContain("reset-password");
  });

  it.each([["bootstrap_complete"], ["email_not_allowed"]] as const)(
    "refuses with 409 %s",
    async (kind) => {
      const { app } = build({ issue: vi.fn().mockResolvedValue({ kind }) });

      const res = await post(app, { key: KEY, email: "owner@example.com" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: kind });
      expect(outcomes()).toEqual([kind]);
    },
  );

  it("validates the email only after the key", async () => {
    const { app, issue } = build();
    const res = await post(app, { key: KEY, email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["invalid_request"]);
  });

  it("refuses under FORCE_SSO, where a password admin could never sign in", async () => {
    const { app, issue } = build({ passwordSignInEnabled: false });
    const res = await post(app, { key: KEY, email: "owner@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "password_signin_disabled" });
    expect(issue).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["password_signin_disabled"]);
  });

  it("answers a generic 500 and audits it when issuing throws", async () => {
    const { app } = build({ issue: vi.fn().mockRejectedValue(new Error("db down")) });
    const res = await post(app, { key: KEY, email: "owner@example.com" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(outcomes()).toEqual(["error"]);
    expect(records.some((record) => record.site === "setup.first-admin.error")).toBe(true);
    expect(JSON.stringify(records)).not.toContain("db down");
  });

  it("uses the short setup link expiry by default", async () => {
    vi.mocked(issueSetupLink).mockResolvedValue(READY);
    const app = new Hono();
    mountSetupRoutes(app, {
      setupKey: new Secret(KEY),
      passwordSignInEnabled: true,
      limiter: new RateLimiterMemory({ points: 10, duration: 60 }) as never,
    });
    expect((await post(app, { key: KEY, email: "owner@example.com" })).status).toBe(200);
    expect(issueSetupLink).toHaveBeenCalledWith("owner@example.com", {
      ttlSeconds: SETUP_LINK_TTL_SECONDS,
    });
    expect(SETUP_LINK_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
  });

  it("accepts the longest key the env schema allows", async () => {
    const longKey = "Z".repeat(512);
    const { app } = build({ setupKey: longKey });
    expect((await post(app, { key: longKey, email: "owner@example.com" })).status).toBe(200);
  });
});

describe("setup route — rate limit", () => {
  it("blocks after the budget, audits the refusal, and never reaches the key check", async () => {
    const { app, issue } = build({
      limiter: new RateLimiterMemory({ points: 2, duration: 900 }) as never,
    });

    expect((await post(app, { key: "wrong", email: "a@example.com" })).status).toBe(401);
    expect((await post(app, { key: "wrong", email: "a@example.com" })).status).toBe(401);
    const blocked = await post(app, { key: KEY, email: "owner@example.com" });

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("cache-control")).toBe("no-store");
    expect(issue).not.toHaveBeenCalled();
    expect(outcomes()).toEqual(["invalid_key", "invalid_key", "rate_limited"]);
  });
});

describe("setup route — position in the app", () => {
  it("404s a CORS preflight while SETUP_KEY is unset", async () => {
    const app = new Hono();
    mountSetupRoutes(app, { setupKey: undefined, passwordSignInEnabled: true });
    app.use("/*", cors({ origin: "https://web.example.com", credentials: true }));
    const res = await app.request(SETUP_ADMIN_PATH, {
      method: "OPTIONS",
      headers: { origin: "https://web.example.com", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(404);
  });

  it("is mounted in index.ts after the body policy and admission gate, before CORS", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const mount = source.indexOf("mountSetupRoutes(app,");
    expect(mount).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(source.indexOf("bodyPolicyMiddleware({"));
    expect(mount).toBeGreaterThan(source.indexOf("httpGate.admit("));
    expect(mount).toBeLessThan(source.indexOf("cors({"));
  });
});
