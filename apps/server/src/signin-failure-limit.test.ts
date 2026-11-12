import { createHash } from "node:crypto";
import { Hono } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock heavy dependencies so the module loads without Redis / env / auth.
// Same technique as rate-limit.test.ts: swapping RateLimiterRedis for
// RateLimiterMemory lets the REAL ./rate-limit.js load — so these tests
// exercise the real `signinFailureKey`, the real `setRateLimitHeaders`, and
// the real module-level constants rather than mocks of them.
// ---------------------------------------------------------------------------

vi.mock("@knowledge-base/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@knowledge-base/env/server", () => ({
  env: {
    // The six budget pairs every family in ./rate-limit.js reads at module
    // load — a missing one throws in scaleFamily (by design), which fails
    // the whole suite rather than one test.
    RATE_LIMIT_AUTH_POINTS: 30,
    RATE_LIMIT_AUTH_WINDOW_SECONDS: 60,
    RATE_LIMIT_RPC_POINTS: 100,
    RATE_LIMIT_RPC_WINDOW_SECONDS: 60,
    RATE_LIMIT_EMAIL_POINTS: 3,
    RATE_LIMIT_EMAIL_WINDOW_SECONDS: 3600,
    TRUST_PROXY_HOPS: undefined,
  },
}));

vi.mock("@knowledge-base/queue", () => ({
  redisConnection: {},
}));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "10.0.0.1" } }));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: mockGetConnInfo,
}));

// Mock RateLimiterRedis so module-level limiters instantiate without a real
// Redis client (see rate-limit.test.ts).
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const original = await importOriginal<typeof import("rate-limiter-flexible")>();
  return {
    ...original,
    RateLimiterRedis: original.RateLimiterMemory,
  };
});

const {
  SIGNIN_FAILURE_BLOCK_SECONDS,
  SIGNIN_FAILURE_POINTS,
  SIGNIN_FAILURE_WINDOW_SECONDS,
  signinFailureKey,
  signinFailureLimiter,
} = await import("./rate-limit.js");
const { SIGNIN_FAILURE_PATH, signinFailureLimit } = await import("./signin-failure-limit.js");

/**
 * Mounts the middleware in front of a handler standing in for Better-Auth,
 * answering whatever status the test asks for. The handler re-reads
 * `c.req.raw.json()` exactly the way `auth.handler(c.req.raw)` does, so a
 * middleware that consumes the stream instead of cloning fails loudly.
 */
type StubStatus = 200 | 400 | 401 | 403 | 429;
function buildApp(
  limiter: Parameters<typeof signinFailureLimit>[0],
  status: () => StubStatus = () => 401,
) {
  const app = new Hono();
  let reached = 0;
  let seen: unknown = null;
  app.use(SIGNIN_FAILURE_PATH, signinFailureLimit(limiter));
  app.post(SIGNIN_FAILURE_PATH, async (c) => {
    reached++;
    seen = await c.req.raw.json().catch(() => null);
    return c.json({ ok: true }, status());
  });
  return { app, handlerCalls: () => reached, downstream: () => seen };
}

function signIn(app: Hono, email: string, ip?: string) {
  // The varying `x-forwarded-for` values stand in for the rotating-IP campaign
  // this limiter exists to bound. The middleware never reads them — that is
  // the property under test: the bucket keys on the email alone.
  return app.request(SIGNIN_FAILURE_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: JSON.stringify({ email, password: "guess" }),
  });
}

/** A real in-memory limiter with the given shape — the house style for these suites. */
function memoryLimiter(points: number, opts?: { blockDuration?: number }) {
  return new RateLimiterMemory({
    keyPrefix: "test-signin-fail",
    points,
    duration: 900,
    blockDuration: opts?.blockDuration ?? 600,
  });
}

beforeEach(() => {
  mockGetConnInfo.mockReturnValue({ remote: { address: "10.0.0.1" } });
});

describe("signinFailureLimiter — prescribed constants", () => {
  it("is 10 failures / 15 minutes with a 10-minute block, in its own bucket", () => {
    // The anti-lever property lives in these three numbers being SHORT. If a
    // change lengthens any of them, the doc comment in rate-limit.ts has to be
    // re-read first — this assertion makes that a conscious act.
    expect(SIGNIN_FAILURE_POINTS).toBe(10);
    expect(SIGNIN_FAILURE_WINDOW_SECONDS).toBe(15 * 60);
    expect(SIGNIN_FAILURE_BLOCK_SECONDS).toBe(10 * 60);
    expect(signinFailureLimiter.points).toBe(10);
    expect(signinFailureLimiter.duration).toBe(900);
    expect(signinFailureLimiter.blockDuration).toBe(600);
    expect(signinFailureLimiter.keyPrefix).toBe("rl:signin-fail");
  });
});

describe("signinFailureKey — key privacy", () => {
  it("never puts the raw address in the key", () => {
    for (const email of ["victim@example.com", "A@x.com", "  spaced@Outlook.COM  "]) {
      const key = signinFailureKey(email);
      expect(key.startsWith("em:")).toBe(true);
      expect(key).not.toContain(email.trim().toLowerCase());
      expect(key).not.toContain(email);
    }
  });

  it("is the SHA-256 base64url of the normalized address", () => {
    const expected = `em:${createHash("sha256").update("victim@example.com").digest("base64url")}`;
    expect(signinFailureKey("victim@example.com")).toBe(expected);
  });

  it("folds case and whitespace into one bucket", () => {
    // `A@x.com` and ` a@X.com ` are the same account under attack; minting a
    // bucket per spelling would hand the campaign a fresh budget per request.
    expect(signinFailureKey("A@X.com")).toBe(signinFailureKey(" a@x.com "));
  });

  it("separates different accounts", () => {
    expect(signinFailureKey("a@example.com")).not.toBe(signinFailureKey("b@example.com"));
  });
});

describe("signinFailureLimit — the rotating-IP gap", () => {
  it("blocks the next attempt for the email after the budget of failures, across different IPs", async () => {
    // The audit gap: credentialLimiter is IP-keyed, so each rotating source
    // address brings a fresh 10/60s budget against the ONE account. Here every
    // request comes from a different IP and the block still lands.
    const real = memoryLimiter(3);
    const { app, handlerCalls } = buildApp(real, () => 401);
    const email = "victim@example.com";

    for (let i = 0; i < 3; i++) {
      const res = await signIn(app, email, `203.0.113.${i}`);
      expect(res.status).toBe(401); // Better-Auth answered; the attempt was a failure
    }

    const blocked = await signIn(app, email, "198.51.100.99");
    expect(blocked.status).toBe(429);
    // Same response shape createRateLimiterMiddleware emits, so a client
    // cannot tell which layer refused it.
    expect(await blocked.json()).toEqual({
      error: "Too many attempts. Please wait a moment and try again.",
    });
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("3");
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");
    // Refused BEFORE Better-Auth: no 11th password check ever runs.
    expect(handlerCalls()).toBe(3);

    // A different account from yet another IP is untouched — per-EMAIL, not
    // global.
    const other = await signIn(app, "other@example.com", "192.0.2.7");
    expect(other.status).toBe(401);
  });

  it("shares one budget across JSON and form-urlencoded bodies", async () => {
    // `/sign-in/email` accepts both encodings; counting only JSON would let
    // the campaign switch encoding after exhausting the first bucket.
    const real = memoryLimiter(3);
    const { app } = buildApp(real, () => 401);

    expect(
      (
        await app.request(SIGNIN_FAILURE_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            email: "victim@example.com",
            password: "guess",
          }).toString(),
        })
      ).status,
    ).toBe(401);
    expect((await signIn(app, "victim@example.com")).status).toBe(401);
    expect((await signIn(app, "victim@example.com")).status).toBe(401);

    // Budget spent through BOTH encodings → the next form post 429s.
    const blocked = await app.request(SIGNIN_FAILURE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "victim@example.com", password: "x" }).toString(),
    });
    expect(blocked.status).toBe(429);
  });

  it("counts case and whitespace spellings against the same account", async () => {
    const real = memoryLimiter(3);
    const { app } = buildApp(real, () => 401);

    await signIn(app, "victim@example.com");
    await signIn(app, "VICTIM@example.com");
    await signIn(app, "  Victim@Example.com  ");

    expect((await signIn(app, "victim@example.com")).status).toBe(429);
  });
});

describe("signinFailureLimit — what charges (the anti-lever predicate)", () => {
  it("never charges a successful sign-in", async () => {
    // The core anti-lever property: a verified user's own sign-ins must leave
    // no lasting charge, or anyone who knows the address could 429 the victim
    // out of their own login from rotating IPs.
    const real = memoryLimiter(3);
    const { app } = buildApp(real, () => 200);

    for (let i = 0; i < 20; i++) {
      expect((await signIn(app, "victim@example.com", `203.0.113.${i}`)).status).toBe(200);
    }
    expect((await real.get(signinFailureKey("victim@example.com")))?.consumedPoints).toBe(0);
  });

  it.each([403, 400, 429] as const)(
    "never charges a %s response, which is not a credential failure",
    async (status) => {
      // 403: CSRF-origin / EMAIL_NOT_VERIFIED / BANNED_USER — all fire before or
      // without a wrong password (see signinFailedCredentials). 400: malformed
      // body. 429: an earlier limiter already refused it. Charging any of them
      // recreates the unauthenticated lockout lever this design exists to avoid.
      const real = memoryLimiter(3);
      const { app } = buildApp(real, () => status);

      for (let i = 0; i < 10; i++) {
        expect((await signIn(app, "victim@example.com")).status).toBe(status);
      }
      expect((await real.get(signinFailureKey("victim@example.com")))?.consumedPoints).toBe(0);
    },
  );

  it("refunds the reservation when the handler throws, instead of stranding it", async () => {
    const real = memoryLimiter(3);
    const app = new Hono();
    app.use(SIGNIN_FAILURE_PATH, signinFailureLimit(real));
    app.post(SIGNIN_FAILURE_PATH, () => {
      throw new Error("downstream exploded");
    });
    app.onError((_err, c) => c.json({ error: "boom" }, 500));

    expect((await signIn(app, "victim@example.com")).status).toBe(500);
    expect((await real.get(signinFailureKey("victim@example.com")))?.consumedPoints).toBe(0);
  });

  it("does not charge a request whose body names no account", async () => {
    // A malformed-body flood must not burn a real address's budget — it never
    // reaches a password check.
    const consume = vi.fn().mockResolvedValue({});
    const reward = vi.fn().mockResolvedValue({});
    const { app } = buildApp({ points: 3, consume, reward });

    for (const body of [{}, { email: "" }, { email: "   " }, { email: 42 }]) {
      await app.request(SIGNIN_FAILURE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it("skips non-POST requests and bodyless POSTs", async () => {
    const consume = vi.fn().mockResolvedValue({});
    const reward = vi.fn().mockResolvedValue({});
    const app = new Hono();
    app.use(SIGNIN_FAILURE_PATH, signinFailureLimit({ points: 3, consume, reward }));
    app.get(SIGNIN_FAILURE_PATH, (c) => c.text("get"));
    app.post(SIGNIN_FAILURE_PATH, (c) => c.json({ ok: true }));

    expect((await app.request(SIGNIN_FAILURE_PATH)).status).toBe(200);
    expect((await app.request(SIGNIN_FAILURE_PATH, { method: "POST" })).status).toBe(200);
    expect(consume).not.toHaveBeenCalled();
  });

  it("skips the limiter entirely when the budget is disabled", async () => {
    const consume = vi.fn().mockResolvedValue({});
    const reward = vi.fn().mockResolvedValue({});
    const { app } = buildApp({ points: 0, consume, reward });

    expect((await signIn(app, "victim@example.com")).status).toBe(401);
    expect(consume).not.toHaveBeenCalled();
  });
});

describe("signinFailureLimit — block expiry", () => {
  it("unblocks once the short block has elapsed, without operator intervention", async () => {
    // The anti-lever property in the other direction: the block is SHORT, so
    // the worst an attacker achieves is a minutes-long blip for the victim —
    // there is no admin unlock, no permanent lock, and no retry-extension.
    const real = memoryLimiter(2, { blockDuration: 0.08 }); // 80 ms, in seconds
    const { app } = buildApp(real, () => 401);
    const email = "victim@example.com";

    expect((await signIn(app, email)).status).toBe(401);
    expect((await signIn(app, email)).status).toBe(401);
    expect((await signIn(app, email)).status).toBe(429);

    // Retries while blocked do not extend the sentence (rate-limiter-flexible
    // applies the block TTL on the first overshoot only) — but even if they
    // did, the wait below is what proves time heals this on its own.
    expect((await signIn(app, email)).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Block expired: the key is gone, the account starts a fresh count (it can
    // fail again and be re-blocked) — bounded per-account forever, locked out
    // never. points=2, so it takes two fresh failures before the next 429.
    expect((await signIn(app, email)).status).toBe(401);
    expect((await signIn(app, email)).status).toBe(401);
    expect((await signIn(app, email)).status).toBe(429);
  });
});

describe("signinFailureLimit — fail mode", () => {
  it("fails OPEN when the store errors, and does not attempt a refund it never reserved", async () => {
    // Availability over strictness for this layer: the fail-closed IP-keyed
    // credential pair is still enforced on the same route, so a Redis blip
    // restores exactly the pre-this-limiter posture. Failing closed here would
    // 503 one account's sign-in because a counter about it could not be read.
    const reward = vi.fn().mockResolvedValue({});
    const { app, downstream } = buildApp({
      points: 3,
      consume: () => Promise.reject(new Error("redis down")),
      reward,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await signIn(app, "user@example.com");

    expect(res.status).toBe(401); // reached the "auth handler"
    expect(downstream()).toEqual({ email: "user@example.com", password: "guess" });
    expect(reward).not.toHaveBeenCalled();
  });

  it("still 429s on an over-limit rejection even though it fails open on store errors", async () => {
    // The two rejection directions are distinguished by shape, exactly like
    // createRateLimiterMiddleware: RateLimiterRes is a block, an Error is an
    // outage.
    const real = memoryLimiter(1);
    const { app } = buildApp(real, () => 401);

    expect((await signIn(app, "victim@example.com")).status).toBe(401);
    expect((await signIn(app, "victim@example.com")).status).toBe(429);
  });

  it("leaves the request body readable by the real auth handler", async () => {
    // `.clone()` in readEmail tees the stream; the auth handler invoked as
    // `auth.handler(c.req.raw)` further down the chain must still see the full
    // body. Fails loudly if anyone "simplifies" the clone away.
    const real = memoryLimiter(3);
    const { app, downstream } = buildApp(real, () => 401);

    await signIn(app, "user@example.com");
    expect(downstream()).toEqual({ email: "user@example.com", password: "guess" });
  });
});
