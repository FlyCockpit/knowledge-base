import { Hono } from "hono";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { describe, expect, it, vi } from "vitest";

// The module under test imports ./rate-limit.js, which constructs
// RateLimiterRedis instances against a live IORedis connection at import time.
// Mock it so the suite never opens a socket (see AGENTS.md § Testing).
vi.mock("./rate-limit.js", () => ({
  twoFactorOtpLimiter: { points: 0, consume: vi.fn() },
}));

const { TWO_FACTOR_OTP_PATH, twoFactorOtpLimit } = await import("./two-factor-otp-limit.js");

/** Mounts the middleware in front of a handler standing in for the auth handler. */
function buildApp(limiter: { points: number; consume: (key: string) => Promise<unknown> }) {
  const app = new Hono();
  let sends = 0;
  app.use(TWO_FACTOR_OTP_PATH, twoFactorOtpLimit(limiter as never));
  app.post(TWO_FACTOR_OTP_PATH, (c) => {
    sends++;
    return c.json({ status: true });
  });
  return { app, sends: () => sends };
}

function post(app: Hono, cookie?: string) {
  return app.request(TWO_FACTOR_OTP_PATH, {
    method: "POST",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function memory(points: number) {
  const real = new RateLimiterMemory({ points, duration: 900 });
  return { points, consume: (key: string) => real.consume(key) };
}

describe("twoFactorOtpLimit", () => {
  it("caps resends for one challenge cookie", async () => {
    // The regression this guards. Better-Auth's send-otp handler has NO
    // per-challenge cap and only consumes the challenge on a successful verify
    // (`two-factor/otp/index.mjs:67-91`), so without this the same signed cookie
    // could be replayed forever, mailing the owner every time.
    const { app, sends } = buildApp(memory(3));
    const cookie = "better-auth.two_factor=challenge-abc";

    for (let i = 0; i < 3; i++) {
      expect((await post(app, cookie)).status).toBe(200);
    }
    const blocked = await post(app, cookie);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(sends()).toBe(3);
  });

  it("gives each challenge its own bucket, so one caller cannot deny another", async () => {
    // Why the key is the challenge and not the recipient: a per-user bucket here
    // would let anyone who knows an address exhaust it and lock that user out of
    // their own second factor — i.e. out of login entirely.
    const limiter = memory(1);
    const { app } = buildApp(limiter);

    expect((await post(app, "better-auth.two_factor=challenge-a")).status).toBe(200);
    expect((await post(app, "better-auth.two_factor=challenge-a")).status).toBe(429);
    // A different challenge — including the victim's own — is untouched.
    expect((await post(app, "better-auth.two_factor=challenge-b")).status).toBe(200);
  });

  it("also keys the session branch, which reaches the mailer too", async () => {
    // `verifyTwoFactor` has two branches: no session → the two_factor cookie is
    // the challenge; session present → the session is. Both mail, so both need a
    // key, or an already-signed-in user re-verifying 2FA is unbounded.
    const { app } = buildApp(memory(1));

    expect((await post(app, "better-auth.session_token=sess-1")).status).toBe(200);
    expect((await post(app, "better-auth.session_token=sess-1")).status).toBe(429);
  });

  it("cannot bypass a session-backed challenge with changing two_factor cookies", async () => {
    const { app, sends } = buildApp(memory(1));

    expect(
      (await post(app, "better-auth.session_token=sess-1; better-auth.two_factor=attacker-a"))
        .status,
    ).toBe(200);
    expect(
      (await post(app, "better-auth.session_token=sess-1; better-auth.two_factor=attacker-b"))
        .status,
    ).toBe(429);
    expect(sends()).toBe(1);
  });

  it("cannot bypass a two_factor challenge with changing junk session cookies", async () => {
    const { app, sends } = buildApp(memory(1));

    expect(
      (await post(app, "better-auth.two_factor=challenge-abc; better-auth.session_token=junk-a"))
        .status,
    ).toBe(200);
    expect(
      (await post(app, "better-auth.two_factor=challenge-abc; better-auth.session_token=junk-b"))
        .status,
    ).toBe(429);
    expect(sends()).toBe(1);
  });

  it("recognizes the __Secure- prefixed cookie used in production", async () => {
    const { app } = buildApp(memory(1));

    expect((await post(app, "__Secure-better-auth.two_factor=challenge-abc")).status).toBe(200);
    expect((await post(app, "__Secure-better-auth.two_factor=challenge-abc")).status).toBe(429);
  });

  it("never puts the raw cookie value in the limiter key", async () => {
    // The challenge is a signed bearer credential; it must not sit in a Redis
    // key (or a key-space dump, or a slow-log) for the life of the window.
    const consume = vi.fn().mockResolvedValue({});
    const { app } = buildApp({ points: 3, consume });

    await post(app, "better-auth.two_factor=super-secret-challenge");

    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]?.[0]).not.toContain("super-secret-challenge");
  });

  it("passes a cookie-less request through without consuming", async () => {
    // verifyTwoFactor 401s these before reaching sendOTP, so there is nothing to
    // bound — and charging them would let a cookie-less flood burn a bucket.
    const consume = vi.fn().mockResolvedValue({});
    const { app, sends } = buildApp({ points: 3, consume });

    expect((await post(app)).status).toBe(200);
    expect(consume).not.toHaveBeenCalled();
    expect(sends()).toBe(1);
  });

  it("skips the limiter entirely when the budget is disabled", async () => {
    const consume = vi.fn();
    const { app } = buildApp({ points: 0, consume });

    expect((await post(app, "better-auth.two_factor=challenge-abc")).status).toBe(200);
    expect(consume).not.toHaveBeenCalled();
  });

  it("fails OPEN when Redis is unavailable, rather than blocking a second factor", async () => {
    // Failing closed here would deny a legitimate user their second factor —
    // i.e. their login — during a blip. The fail-closed IP-keyed credential
    // limiters still guard this route.
    const { app, sends } = buildApp({
      points: 3,
      consume: () => Promise.reject(new Error("redis down")),
    });

    expect((await post(app, "better-auth.two_factor=challenge-abc")).status).toBe(200);
    expect(sends()).toBe(1);
  });
});
