import { Hono } from "hono";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the module loads without Redis / env / auth.
// ---------------------------------------------------------------------------

vi.mock("@knowledge-base/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

// Mutable env stub. The factory returns the OBJECT, not a spread, so the
// family-scaling tests below can mutate a budget and re-import the module
// under test — a spread would snapshot the defaults at first factory run and
// silently ignore every later mutation.
const envMock: Record<string, number | undefined> = {
  RATE_LIMIT_AUTH_POINTS: 30,
  RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
  RATE_LIMIT_RPC_POINTS: 100,
  RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
  RATE_LIMIT_EMAIL_POINTS: 3,
  RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
  TRUST_PROXY_HOPS: undefined,
};

vi.mock("@knowledge-base/env/server", () => ({
  env: envMock,
}));

vi.mock("@knowledge-base/queue", () => ({
  redisConnection: {},
}));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "10.0.0.1" } }));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: mockGetConnInfo,
}));

// Mock RateLimiterRedis so module-level `authLimiter` and `rpcLimiter`
// instantiate without a real Redis connection. We don't test those instances
// directly — we test `createRateLimiterMiddleware` with a RateLimiterMemory.
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const original = await importOriginal<typeof import("rate-limiter-flexible")>();
  return {
    ...original,
    // Replace RateLimiterRedis with RateLimiterMemory so module-level
    // constructors don't need a live Redis client.
    RateLimiterRedis: original.RateLimiterMemory,
  };
});

const { createRateLimiterMiddleware } = await import("./rate-limit.js");

// ---------------------------------------------------------------------------
// Test: rate limiter middleware returns 429 with correct headers
// ---------------------------------------------------------------------------
// Trade-off: We use RateLimiterMemory instead of a real Redis-backed limiter.
// This means the test does NOT verify Redis round-trips, but it does exercise
// the full Hono middleware path including header serialisation, 429 body, and
// the consume → reject flow. For a true integration test against Redis, spin
// up a test container and replace RateLimiterMemory with RateLimiterRedis.
// ---------------------------------------------------------------------------

const LIMIT = 3;

describe("createRateLimiterMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    envMock.TRUST_PROXY_HOPS = undefined;
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });

    // Fresh limiter + app per test so counters reset.
    const limiter = new RateLimiterMemory({
      keyPrefix: "test",
      points: LIMIT,
      duration: 60,
    });

    app = new Hono();
    app.use("/*", createRateLimiterMiddleware(limiter));
    app.get("/ping", (c) => c.text("pong"));
  });

  it("allows requests within the limit and returns rate-limit headers", async () => {
    const res = await app.request("/ping");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(LIMIT));
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("returns 429 with all rate-limit headers on the (limit + 1)th request", async () => {
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.2" } });

    // Exhaust the allowance
    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping");
      expect(res.status).toBe(200);
    }

    // The next request should be rejected
    const rejected = await app.request("/ping");

    expect(rejected.status).toBe(429);

    // Verify all four rate-limit headers are present and non-empty
    expect(rejected.headers.get("X-RateLimit-Limit")).toBe(String(LIMIT));
    expect(rejected.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(rejected.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(rejected.headers.get("Retry-After")).toBeTruthy();

    // Verify numeric values are sensible
    const reset = Number(rejected.headers.get("X-RateLimit-Reset"));
    expect(reset).toBeGreaterThan(0);

    const retryAfter = Number(rejected.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);

    // Verify response body
    const body = await rejected.json();
    expect(body).toEqual({ error: "Too many attempts. Please wait a moment and try again." });
  });

  it("tracks limits per IP independently", async () => {
    // Exhaust allowance for IP A
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.3" } });
    for (let i = 0; i < LIMIT; i++) {
      await app.request("/ping");
    }

    // IP A is blocked
    const blockedA = await app.request("/ping");
    expect(blockedA.status).toBe(429);

    // IP B still has its full allowance
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.4" } });
    const allowedB = await app.request("/ping");
    expect(allowedB.status).toBe(200);
  });

  it("behind one counted proxy (TRUST_PROXY_HOPS=1), keys on the proxy-appended client IP — not the spoofable leftmost X-Forwarded-For", async () => {
    // Socket peer is the proxy. A trusted proxy appends the real client IP as
    // the rightmost entry; the client controls only the left.
    envMock.TRUST_PROXY_HOPS = 1;
    mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.5" } });

    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping", {
        // Vary the spoofed leftmost entry every request; the proxy-appended
        // real client (198.51.100.7) stays constant.
        headers: { "x-forwarded-for": `203.0.113.${i}, 198.51.100.7` },
      });
      expect(res.status).toBe(200);
    }

    const rejected = await app.request("/ping", {
      headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.7" },
    });
    // Throttled despite a fresh spoofed leftmost value: the key is the constant
    // proxy-appended client IP, so X-Forwarded-For spoofing can't escape it.
    expect(rejected.status).toBe(429);
  });

  it("with TRUST_PROXY_HOPS unset (0), a private peer cannot pick its bucket via X-Forwarded-For", async () => {
    // SEC-02: a LAN caller varying a public-looking X-Forwarded-For still
    // shares its socket bucket (behind an uncounted proxy, everyone does).
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.20" } });
    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping", {
        headers: { "x-forwarded-for": `198.51.100.${i}` },
      });
      expect(res.status).toBe(200);
    }
    const rejected = await app.request("/ping", {
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(rejected.status).toBe(429);
  });

  it("on a bare deployment (public socket peer), ignores X-Forwarded-For entirely", async () => {
    // No proxy: the socket peer is the real, public client. A forged
    // X-Forwarded-For must not let it dodge the limit.
    mockGetConnInfo.mockReturnValue({ remote: { address: "198.51.100.50" } });

    for (let i = 0; i < LIMIT; i++) {
      const res = await app.request("/ping", {
        headers: { "x-forwarded-for": `203.0.113.${i}` },
      });
      expect(res.status).toBe(200);
    }

    const rejected = await app.request("/ping", {
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(rejected.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Test: Redis-outage fail mode (fail-open vs fail-closed)
// ---------------------------------------------------------------------------
// A `RateLimiterRes` throw means "over the limit" (→ 429). Any OTHER throw
// means the backing store (Redis) is unavailable. Fail-open limiters let that
// request through; fail-closed limiters (auth/signup) reject it with a 503 so
// credential-stuffing / signup-spam protection can't silently vanish. We drive
// both by stubbing a limiter whose `consume` rejects with a plain Error.
// ---------------------------------------------------------------------------

describe("createRateLimiterMiddleware — Redis outage handling", () => {
  function makeApp(consumeReject: unknown, options?: { failClosed?: boolean }) {
    const limiter = {
      points: LIMIT,
      consume: vi.fn().mockRejectedValue(consumeReject),
    };
    const app = new Hono();
    app.use("/*", createRateLimiterMiddleware(limiter, options));
    app.get("/ping", (c) => c.text("pong"));
    return app;
  }

  it("fails open by default when the store errors (request passes through)", async () => {
    const app = makeApp(new Error("redis connection refused"));
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  it("fails closed with a 503 + Retry-After when configured and the store errors", async () => {
    const app = makeApp(new Error("redis connection refused"), { failClosed: true });
    const res = await app.request("/ping");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body).toEqual({
      error: "Service temporarily unavailable. Please try again in a moment.",
    });
  });

  it("still returns 429 (not 503) for an over-limit RateLimiterRes even when failClosed", async () => {
    // An over-limit rejection must stay a 429 regardless of fail mode — the
    // fail-closed branch is only for store connectivity errors.
    const overLimit = new RateLimiterRes(0, 1000, LIMIT, undefined);
    const app = makeApp(overLimit, { failClosed: true });
    const res = await app.request("/ping");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "Too many attempts. Please wait a moment and try again.",
    });
  });
});

// ---------------------------------------------------------------------------
// Test: each surface limiter has its own bucket
// ---------------------------------------------------------------------------
// The regression this guards: the template shipped one `rpcLimiter` mounted on
// /rpc, /api/images and /sw alike, so every surface shared a single 100/min
// bucket keyed `rl:rpc`. One busy surface exhausted the entire API budget for
// the minute.
// ---------------------------------------------------------------------------

describe("surface limiters", () => {
  it("do not share a key prefix or a budget", async () => {
    const { rpcLimiter, readyLimiter, ssrLimiter } = await import("./rate-limit.js");
    const limiters = [rpcLimiter, readyLimiter, ssrLimiter];
    const prefixes = limiters.map((l) => (l as unknown as { keyPrefix: string }).keyPrefix);
    expect(new Set(prefixes).size).toBe(limiters.length);

    const key = "same-caller";
    for (let i = 0; i < rpcLimiter.points; i++) await rpcLimiter.consume(key);
    await expect(rpcLimiter.consume(key)).rejects.toBeInstanceOf(RateLimiterRes);
    await expect(readyLimiter.consume(key)).resolves.toBeDefined();
  });
});

describe("rate-limit budget families", () => {
  async function importLimiters() {
    return import("./rate-limit.js");
  }

  afterEach(() => {
    vi.resetModules();
    Object.assign(envMock, {
      RATE_LIMIT_AUTH_POINTS: 30,
      RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
      RATE_LIMIT_RPC_POINTS: 100,
      RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
      RATE_LIMIT_EMAIL_POINTS: 3,
      RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
    });
  });

  it("reproduces every shipped default when no budget is overridden", async () => {
    const l = await importLimiters();
    // AUTH family (reference: general auth 30/60s, 5-min block).
    expect(l.authLimiter.points).toBe(30);
    expect(l.credentialLimiter.points).toBe(10);
    expect(l.credentialBurstLimiter.points).toBe(3);
    expect(l.signupLimiter.points).toBe(10);
    expect(l.twoFactorOtpLimiter.points).toBe(3);
    expect(l.twoFactorOtpLimiter).toHaveProperty("duration", 900);
    // EMAIL family (reference: 3 per hour).
    expect(l.emailRecipientLimiter.points).toBe(3);
    expect(l.signupRecipientLimiter.points).toBe(6);
    expect(l.signinRecipientLimiter.points).toBe(10);
    expect(l.emailRecipientLimiter).toHaveProperty("blockDuration", 0);

    expect(l.rpcLimiter.points).toBe(100);
    expect(l.readyLimiter.points).toBe(60);
    expect(l.ssrLimiter.points).toBe(300);
  });

  it("doubling RATE_LIMIT_AUTH_POINTS doubles every auth-family limiter's points, windows untouched", async () => {
    envMock.RATE_LIMIT_AUTH_POINTS = 60; // 2x the 30 reference
    const l = await importLimiters();
    // Reference member and every relative member scale by the same 2x.
    expect(l.authLimiter.points).toBe(60);
    expect(l.credentialLimiter.points).toBe(20);
    expect(l.credentialBurstLimiter.points).toBe(6);
    expect(l.signupLimiter.points).toBe(20);
    expect(l.twoFactorOtpLimiter.points).toBe(6);
    // Points-only override: windows and blocks keep their designed values.
    expect(l.credentialLimiter).toHaveProperty("duration", 60);
    expect(l.credentialLimiter).toHaveProperty("blockDuration", 300);
    expect(l.signupLimiter).toHaveProperty("duration", 3600);
    expect(l.credentialBurstLimiter).toHaveProperty("duration", 10);
    // Other families are untouched.
    expect(l.rpcLimiter.points).toBe(100);
    expect(l.emailRecipientLimiter.points).toBe(3);
  });

  it("doubling RATE_LIMIT_AUTH_WINDOW_SECONDS doubles every auth-family window and block", async () => {
    envMock.RATE_LIMIT_AUTH_WINDOW_SECONDS = 120; // 2x the 60s reference
    const l = await importLimiters();
    expect(l.authLimiter).toHaveProperty("duration", 120);
    expect(l.authLimiter).toHaveProperty("blockDuration", 600);
    expect(l.credentialBurstLimiter).toHaveProperty("duration", 20);
    expect(l.signupLimiter).toHaveProperty("duration", 7200);
    expect(l.signupLimiter).toHaveProperty("blockDuration", 1800);
    expect(l.twoFactorOtpLimiter).toHaveProperty("duration", 1800);
    // Points are untouched by a window override.
    expect(l.credentialLimiter.points).toBe(10);
  });

  it("RATE_LIMIT_EMAIL_POINTS=0 disables the whole recipient family", async () => {
    envMock.RATE_LIMIT_EMAIL_POINTS = 0;
    const l = await importLimiters();
    expect(l.emailRecipientLimiter.points).toBe(0);
    expect(l.signupRecipientLimiter.points).toBe(0);
    expect(l.signinRecipientLimiter.points).toBe(0);
  });
});
