import type { Context } from "hono";
import { Hono } from "hono";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The module under test imports ./rate-limit.js, which constructs
// RateLimiterRedis instances against a live IORedis connection at import time.
// Mock it so the suite never opens a socket (see AGENTS.md § Testing).
const { limiter, signupLimiter } = vi.hoisted(() => ({
  limiter: {
    points: 3,
    consume: vi.fn<(key: string) => Promise<unknown>>(),
  },
  signupLimiter: {
    points: 6,
    consume: vi.fn<(key: string) => Promise<unknown>>(),
  },
}));

vi.mock("./rate-limit.js", () => ({
  emailRecipientLimiter: limiter,
  signupRecipientLimiter: signupLimiter,
  emailRateLimitKey: (email: string) => email.trim().toLowerCase(),
}));

const {
  EMAIL_RECIPIENT_PATHS,
  emailRecipientLimit,
  FORM_OR_JSON_MEDIA_TYPES,
  SIGNIN_RECIPIENT_PATH,
  signinSentMail,
  SIGNUP_RECIPIENT_PATH,
} = await import("./email-recipient-limit.js");

const PATH = "/api/auth/send-verification-email";

/**
 * Wires the middleware in front of a handler that reads the body the same way
 * the real auth handler does — `auth.handler(c.req.raw)`. If the middleware
 * consumes the stream instead of cloning, `seen` stays null and the assertions
 * below catch it.
 */
function buildApp() {
  const app = new Hono();
  let seen: unknown = null;
  app.use(PATH, emailRecipientLimit());
  app.post(PATH, async (c) => {
    seen = await c.req.raw.json();
    return c.json({ status: true });
  });
  return { app, downstream: () => seen };
}

function post(app: Hono, body: unknown) {
  return app.request(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  limiter.points = 3;
  limiter.consume.mockReset();
  limiter.consume.mockResolvedValue({});
  signupLimiter.points = 6;
  signupLimiter.consume.mockReset();
  signupLimiter.consume.mockResolvedValue({});
});

describe("signup recipient limiting", () => {
  // Signup mails a caller-supplied address too (`sendOnSignUp`), and its only
  // other ceiling is the IP-keyed signupLimiter — the control rotating IPs
  // defeat. It must consume from its OWN bucket, so a signup flood can never
  // eat the budget a legitimate user needs to reset their own password.
  function buildSignupApp() {
    const app = new Hono();
    app.use(SIGNUP_RECIPIENT_PATH, emailRecipientLimit(signupLimiter));
    app.post(SIGNUP_RECIPIENT_PATH, (c) => c.json({ status: true }));
    return app;
  }

  it("consumes from the signup bucket, never the shared email bucket", async () => {
    const app = buildSignupApp();
    const res = await app.request(SIGNUP_RECIPIENT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "New.User@Example.com ", password: "hunter2" }),
    });

    expect(res.status).toBe(200);
    expect(signupLimiter.consume).toHaveBeenCalledWith("new.user@example.com");
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("429s once the signup budget for that address is spent", async () => {
    const app = buildSignupApp();
    signupLimiter.consume.mockRejectedValue(new RateLimiterRes(0, 45_000));

    const res = await app.request(SIGNUP_RECIPIENT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "victim@example.com", password: "hunter2" }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("45");
  });

  it("is skipped entirely when the signup budget is disabled", async () => {
    signupLimiter.points = 0;
    const app = buildSignupApp();

    const res = await app.request(SIGNUP_RECIPIENT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "hunter2" }),
    });

    expect(res.status).toBe(200);
    expect(signupLimiter.consume).not.toHaveBeenCalled();
  });
});

describe("emailRecipientLimit", () => {
  it("lets a request through and leaves the body readable downstream", async () => {
    const { app, downstream } = buildApp();
    const res = await post(app, { email: "user@example.com" });

    expect(res.status).toBe(200);
    // The auth handler must still be able to parse the body — this is what
    // `.clone()` in readEmail buys, and it fails loudly without it.
    expect(downstream()).toEqual({ email: "user@example.com" });
  });

  it("keys on the normalized recipient, not the caller", async () => {
    const { app } = buildApp();
    await post(app, { email: "  User@Example.COM  " });
    expect(limiter.consume).toHaveBeenCalledWith("user@example.com");
  });

  it("rejects with 429 and Retry-After once the address is over its cap", async () => {
    const { app, downstream } = buildApp();
    limiter.consume.mockRejectedValue(new RateLimiterRes(0, 60_000));

    const res = await post(app, { email: "victim@example.com" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    // Blocked before the auth handler, so no mail is sent.
    expect(downstream()).toBeNull();
  });

  it("does not consume a point when the body has no usable email", async () => {
    // A malformed-body flood must not burn a real address's budget.
    const { app } = buildApp();
    for (const body of [{}, { email: "" }, { email: "   " }, { email: 42 }]) {
      await post(app, body);
    }
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("passes through non-JSON bodies for Better-Auth to reject", async () => {
    // The middleware must not 429 (or throw) on an unparseable body — it hands
    // off so Better-Auth can return its own validation error. The stub handler
    // below re-parses and throws, hence the 500; what matters is that the
    // request reached it and no budget was consumed.
    const app = new Hono();
    let reached = false;
    app.use(PATH, emailRecipientLimit());
    app.post(PATH, (c) => {
      reached = true;
      return c.json({ status: true });
    });

    const res = await app.request(PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });

    expect(limiter.consume).not.toHaveBeenCalled();
    expect(reached).toBe(true);
    expect(res.status).toBe(200);
  });

  // Regression: this middleware must classify a request EXACTLY as better-call
  // does. Better-Auth sets a global `allowedMediaTypes: ["application/json"]`
  // (better-auth/dist/api/index.mjs:161) and `/sign-up/email` widens it to also
  // accept form-urlencoded (sign-up.mjs:28). Accepting less than Better-Auth is
  // a bypass; accepting more burns a victim's budget on mail never sent.
  describe("media-type handling", () => {
    // `buildApp`'s downstream handler re-parses the body as JSON (to prove the
    // clone), which would itself throw on these encodings. These cases care
    // only about what the middleware consumed, so use a body-agnostic handler.
    function buildAnyBodyApp(allowed?: readonly string[]) {
      const app = new Hono();
      app.use(PATH, emailRecipientLimit(limiter, allowed));
      app.post(PATH, (c) => c.json({ status: true }));
      return app;
    }

    it("counts a form-urlencoded recipient on the signup path, which allows it", async () => {
      // This is the encoding the JSON-only version let through unmetered.
      const app = buildAnyBodyApp(FORM_OR_JSON_MEDIA_TYPES);
      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "Victim@Example.com" }).toString(),
      });

      expect(res.status).toBe(200);
      expect(limiter.consume).toHaveBeenCalledWith("victim@example.com");
    });

    it("shares one budget across encodings, so switching format cannot reset it", async () => {
      // The actual attack: spend the JSON budget, then retry as a form post.
      const real = new RateLimiterMemory({ points: 3, duration: 3600 });
      limiter.consume.mockImplementation((key: string) => real.consume(key));

      const app = buildAnyBodyApp(FORM_OR_JSON_MEDIA_TYPES);
      for (let i = 0; i < 3; i++) {
        expect((await post(app, { email: "victim@example.com" })).status).toBe(200);
      }

      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "victim@example.com" }).toString(),
      });
      expect(res.status).toBe(429);
    });

    it("matches on the media type's BASE, not a substring of the whole header", async () => {
      // The bypass a loose `includes("application/json")` reopens: better-call
      // reads the base type (`split(";")[0]`), so Better-Auth parses this as a
      // form and sends the mail. A substring check would see "application/json"
      // in the charset parameter, fail to parse it as JSON, and wave it through
      // with no point consumed.
      const app = buildAnyBodyApp(FORM_OR_JSON_MEDIA_TYPES);
      const res = await app.request(PATH, {
        method: "POST",
        headers: {
          "Content-Type": 'application/x-www-form-urlencoded; charset="application/json"',
        },
        body: new URLSearchParams({ email: "victim@example.com" }).toString(),
      });

      expect(res.status).toBe(200);
      expect(limiter.consume).toHaveBeenCalledWith("victim@example.com");
    });

    it("consumes nothing for a media type whose essence formData() refuses", async () => {
      // Looks like a bypass, isn't one — and this test exists to stop someone
      // "fixing" it back. The header clears the acceptance gate (base
      // `includes()`) and reaches the urlencoded branch, but `Request.formData()`
      // rejects any body whose MIME essence is not exactly urlencoded or
      // multipart. Better-call calls the same `request.formData()` with no
      // try/catch (`utils.mjs:34`), so it throws there too and Better-Auth sends
      // no mail. Consuming no point is therefore CORRECT: charging the victim's
      // budget for a request that can never mail them is the "too permissive"
      // failure this middleware is explicitly written to avoid.
      const app = buildAnyBodyApp(FORM_OR_JSON_MEDIA_TYPES);
      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencodedx" },
        body: new URLSearchParams({ email: "victim@example.com" }).toString(),
      });

      expect(res.status).toBe(200);
      expect(limiter.consume).not.toHaveBeenCalled();
    });

    it("still parses JSON when the header carries parameters", async () => {
      const app = buildAnyBodyApp();
      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ email: "victim@example.com" }),
      });

      expect(res.status).toBe(200);
      expect(limiter.consume).toHaveBeenCalledWith("victim@example.com");
    });

    it("refuses a media type Better-Auth would refuse, without consuming budget", async () => {
      // Form-urlencoded on a JSON-only path. Better-Auth 415s this itself, so
      // consuming a point would spend a victim's budget on mail never sent.
      const app = new Hono();
      let reached = false;
      app.use(PATH, emailRecipientLimit());
      app.post(PATH, (c) => {
        reached = true;
        return c.json({ status: true });
      });

      const res = await app.request(PATH, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: "victim@example.com" }).toString(),
      });

      expect(res.status).toBe(415);
      expect(reached).toBe(false);
      expect(limiter.consume).not.toHaveBeenCalled();
    });

    it("refuses multipart, which no protected route accepts", async () => {
      const app = buildAnyBodyApp(FORM_OR_JSON_MEDIA_TYPES);
      const form = new FormData();
      form.set("email", "victim@example.com");
      const res = await app.request(PATH, { method: "POST", body: form });

      expect(res.status).toBe(415);
      expect(limiter.consume).not.toHaveBeenCalled();
    });

    it("lets a bodyless POST through for Better-Auth to 400", async () => {
      // better-call returns early on `!request.body` before it ever checks the
      // media type, so this must not become a 415.
      const app = buildAnyBodyApp();
      const res = await app.request(PATH, { method: "POST" });

      expect(res.status).toBe(200);
      expect(limiter.consume).not.toHaveBeenCalled();
    });
  });

  it("fails OPEN when Redis is unavailable", async () => {
    // Unlike authLimiter, a store outage must not block password resets — the
    // fail-closed IP limiter still guards this route.
    const { app, downstream } = buildApp();
    limiter.consume.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await post(app, { email: "user@example.com" });

    expect(res.status).toBe(200);
    expect(downstream()).toEqual({ email: "user@example.com" });
  });

  it("skips the limiter entirely when POINTS is 0", async () => {
    const { app } = buildApp();
    limiter.points = 0;

    const res = await post(app, { email: "user@example.com" });

    expect(res.status).toBe(200);
    expect(limiter.consume).not.toHaveBeenCalled();
  });

  it("covers every anonymous endpoint that mails a caller-supplied address", () => {
    // `/forget-password` is deliberately absent: in better-auth 1.6.23 the core
    // password routes are `/request-password-reset` and `/reset-password`, and
    // the only `/forget-password*` endpoint ships with the emailOTP plugin as
    // `/forget-password/email-otp` — a path this entry would not have matched
    // anyway. Enabling that plugin means adding its routes explicitly; see the
    // note on EMAIL_RECIPIENT_PATHS.
    expect([...EMAIL_RECIPIENT_PATHS]).toEqual([
      "/api/auth/send-verification-email",
      "/api/auth/request-password-reset",
    ]);
  });

  it("accounts for all four recipient-controlled mailers across the three constants", () => {
    // The shared list is only part of the picture — signup and sign-in are held
    // separately because each needs its own bucket. Asserting the union here is
    // what makes "did we miss an endpoint?" a single place to look. `/sign-in`
    // is the one that is a mailer by CONFIG rather than by route: it mails only
    // because `requireEmailVerification` + `sendOnSignIn` are both on.
    expect([...EMAIL_RECIPIENT_PATHS, SIGNUP_RECIPIENT_PATH, SIGNIN_RECIPIENT_PATH].sort()).toEqual(
      [
        "/api/auth/request-password-reset",
        "/api/auth/send-verification-email",
        "/api/auth/sign-in/email",
        "/api/auth/sign-up/email",
      ],
    );
  });
});

describe("emailRecipientLimit — enumeration safety", () => {
  it("returns the same response for an unknown and a real address", async () => {
    // The counter is driven by how often an address was *asked for*, never by
    // whether an account exists — so responses cannot be used as an oracle.
    const { app } = buildApp();
    const unknown = await post(app, { email: "nobody@example.com" });
    const real = await post(app, { email: "registered@example.com" });

    expect(unknown.status).toBe(real.status);
    expect(await unknown.json()).toEqual(await real.json());
  });
});

describe("emailRecipientLimiter budget", () => {
  it("blocks the 4th request for one address while leaving another untouched", async () => {
    // End-to-end against a real (in-memory) limiter: proves the key actually
    // partitions per recipient rather than sharing one global bucket.
    const real = new RateLimiterMemory({ points: 3, duration: 3600 });
    limiter.consume.mockImplementation((key: string) => real.consume(key));

    const { app } = buildApp();
    const victim = { email: "victim@example.com" };

    for (let i = 0; i < 3; i++) {
      expect((await post(app, victim)).status).toBe(200);
    }
    expect((await post(app, victim)).status).toBe(429);

    // A different mailbox is unaffected.
    expect((await post(app, { email: "someone-else@example.com" })).status).toBe(200);
  });

  it("counts case and whitespace variants against the same budget", async () => {
    const real = new RateLimiterMemory({ points: 3, duration: 3600 });
    limiter.consume.mockImplementation((key: string) => real.consume(key));

    const { app } = buildApp();
    await post(app, { email: "victim@example.com" });
    await post(app, { email: "VICTIM@example.com" });
    await post(app, { email: "  Victim@Example.com  " });

    expect((await post(app, { email: "victim@example.com" })).status).toBe(429);
  });
});

describe("emailRecipientLimit — deferred mode (consumeWhen)", () => {
  const SIGNIN = "/api/auth/sign-in/email";

  /**
   * Mounts the middleware in deferred mode in front of a handler that returns
   * whatever status the test asks for, standing in for Better-Auth: 200 for a
   * verified sign-in, 401 for a bad password, 403 for the unverified case that
   * actually sends the verification mail.
   */
  function buildSigninApp(realLimiter: RateLimiterMemory, status: () => 200 | 401 | 403) {
    const deferred = {
      points: realLimiter.points,
      consume: (key: string) => realLimiter.consume(key),
      reward: (key: string) => realLimiter.reward(key),
    };
    const app = new Hono();
    app.use(
      SIGNIN,
      emailRecipientLimit(deferred, FORM_OR_JSON_MEDIA_TYPES, (c) => c.res.status === 403),
    );
    app.post(SIGNIN, (c) => c.json({ ok: true }, status()));
    return app;
  }

  function signIn(app: Hono, email: string) {
    return app.request(SIGNIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "whatever" }),
    });
  }

  it("never charges a verified sign-in, so a flood cannot lock the user out", async () => {
    // The regression this guards. Charging per-attempt would let anyone who
    // knows an address 429 that user out of their own login from rotating IPs —
    // strictly worse than the unmetered mailer the limiter exists to bound.
    const real = new RateLimiterMemory({ points: 2, duration: 3600 });
    const app = buildSigninApp(real, () => 200);

    for (let i = 0; i < 20; i++) {
      expect((await signIn(app, "victim@example.com")).status).toBe(200);
    }
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(0);
  });

  it("never charges a wrong-password attempt either", async () => {
    const real = new RateLimiterMemory({ points: 2, duration: 3600 });
    const app = buildSigninApp(real, () => 401);

    for (let i = 0; i < 20; i++) {
      expect((await signIn(app, "victim@example.com")).status).toBe(401);
    }
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(0);
  });

  it("reserves only mail-sending responses, and refuses past the cap", async () => {
    const real = new RateLimiterMemory({ points: 2, duration: 3600 });
    const app = buildSigninApp(real, () => 403);

    // Two mail-sending sign-ins are allowed through and keep their reservations.
    expect((await signIn(app, "victim@example.com")).status).toBe(403);
    expect((await signIn(app, "victim@example.com")).status).toBe(403);
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(2);

    // The third is refused BEFORE the handler runs.
    const blocked = await signIn(app, "victim@example.com");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();

    // A different mailbox is unaffected.
    expect((await signIn(app, "other@example.com")).status).toBe(403);
  });

  it("accepts a form-urlencoded sign-in instead of 415ing it", async () => {
    // `/sign-in/email` widens Better-Auth's global JSON-only media types exactly
    // as `/sign-up/email` does (`sign-in.mjs:155`). Declaring JSON-only here
    // would turn a legitimate form post into a 415 before the handler ran.
    const real = new RateLimiterMemory({ points: 2, duration: 3600 });
    const app = buildSigninApp(real, () => 403);

    const res = await app.request(SIGNIN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "victim@example.com", password: "x" }).toString(),
    });

    expect(res.status).toBe(403);
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(1);
  });

  it("fails open on a limiter error rather than blocking sign-in", async () => {
    const real = new RateLimiterMemory({ points: 2, duration: 3600 });
    const deferred = {
      points: 2,
      consume: (key: string) => real.consume(key),
      reward: (key: string) => real.reward(key),
    };
    const app = new Hono();
    app.use(
      SIGNIN,
      emailRecipientLimit(deferred, FORM_OR_JSON_MEDIA_TYPES, () => false),
    );
    app.post(SIGNIN, (c) => c.json({ ok: true }));

    expect((await signIn(app, "victim@example.com")).status).toBe(200);
  });

  it("does not refund when reserving failed before a Redis error", async () => {
    const reward = vi.fn().mockResolvedValue({});
    const app = new Hono();
    app.use(
      SIGNIN,
      emailRecipientLimit(
        {
          points: 2,
          consume: () => Promise.reject(new Error("redis down")),
          reward,
        },
        FORM_OR_JSON_MEDIA_TYPES,
        () => false,
      ),
    );
    app.post(SIGNIN, (c) => c.json({ ok: true }));

    expect((await signIn(app, "victim@example.com")).status).toBe(200);
    expect(reward).not.toHaveBeenCalled();
  });

  it("atomically reserves capacity before concurrent mail sends", async () => {
    const real = new RateLimiterMemory({ points: 2, duration: 3600 });
    let releaseHandler!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let started = 0;
    const deferred = {
      points: real.points,
      consume: (key: string) => real.consume(key),
      reward: (key: string) => real.reward(key),
    };
    const app = new Hono();
    app.use(
      SIGNIN,
      emailRecipientLimit(deferred, FORM_OR_JSON_MEDIA_TYPES, (c) => c.res.status === 403),
    );
    app.post(SIGNIN, async (c) => {
      started++;
      await handlerStarted;
      return c.json({ ok: true }, 403);
    });

    const requests = Array.from({ length: 8 }, () => signIn(app, "victim@example.com"));
    await vi.waitFor(() => expect(started).toBe(2));
    releaseHandler();
    const responses = await Promise.all(requests);

    expect(responses.filter((response) => response.status === 403)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(6);
  });
});

describe("signinSentMail — the real predicate", () => {
  const SIGNIN = "/api/auth/sign-in/email";

  /**
   * Same shape as the block above, but wired to the SHIPPING predicate rather
   * than a `status === 403` stand-in, and with a handler that reproduces
   * Better-Auth's actual error bodies (`APIError.from` emits `{ message, code }`
   * and better-call serializes it as the JSON body).
   */
  function buildApp(realLimiter: RateLimiterMemory, respond: (c: Context) => Response) {
    const deferred = {
      points: realLimiter.points,
      consume: (key: string) => realLimiter.consume(key),
      reward: (key: string) => realLimiter.reward(key),
    };
    const app = new Hono();
    app.use(SIGNIN, emailRecipientLimit(deferred, FORM_OR_JSON_MEDIA_TYPES, signinSentMail));
    app.post(SIGNIN, respond);
    return app;
  }

  function signIn(app: Hono, email: string) {
    return app.request(SIGNIN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "whatever" }),
    });
  }

  it("charges the 403 that actually sent a verification mail", async () => {
    const real = new RateLimiterMemory({ points: 10, duration: 3600 });
    const app = buildApp(real, (c) =>
      c.json({ message: "Email not verified", code: "EMAIL_NOT_VERIFIED" }, 403),
    );

    await signIn(app, "victim@example.com");
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(1);
  });

  it("does NOT charge the CSRF 403, which fires before any password is read", async () => {
    // The regression this exists for. `/sign-in/email` runs `formCsrfMiddleware`,
    // so a request carrying a Cookie header with no Origin gets FORBIDDEN /
    // MISSING_OR_NULL_ORIGIN — with no password, no account, and no mail. A
    // status-only predicate charged it, which handed anyone who knows an address
    // an unauthenticated way to fill that address's bucket and 429 the victim out
    // of their own login.
    const real = new RateLimiterMemory({ points: 10, duration: 3600 });
    const app = buildApp(real, (c) =>
      c.json({ message: "Origin header is missing or null", code: "MISSING_OR_NULL_ORIGIN" }, 403),
    );

    for (let i = 0; i < 30; i++) {
      expect((await signIn(app, "victim@example.com")).status).toBe(403);
    }
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(0);
  });

  it("does not charge the cross-site-navigation 403 either", async () => {
    const real = new RateLimiterMemory({ points: 10, duration: 3600 });
    const app = buildApp(real, (c) =>
      c.json({ message: "Blocked", code: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED" }, 403),
    );

    await signIn(app, "victim@example.com");
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(0);
  });

  it("does not charge the banned-user 403, which sends no mail", async () => {
    const real = new RateLimiterMemory({ points: 10, duration: 3600 });
    const app = buildApp(real, (c) =>
      c.json({ message: "You have been banned from this application", code: "BANNED_USER" }, 403),
    );

    await signIn(app, "victim@example.com");
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(0);
  });

  it("refunds rather than charges when a 403 body is not parseable JSON", async () => {
    // Refund is the safe direction: failing to meter a mail leaves a mailer that
    // still needs a correct password, whereas charging a non-mail 403 is a lockout.
    const real = new RateLimiterMemory({ points: 10, duration: 3600 });
    const app = buildApp(real, (c) => c.text("<html>gateway error</html>", 403));

    await signIn(app, "victim@example.com");
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(0);
  });

  it("leaves the response body intact for the client after inspecting it", async () => {
    // The predicate reads a clone; the original stream must still reach the client.
    const real = new RateLimiterMemory({ points: 10, duration: 3600 });
    const app = buildApp(real, (c) =>
      c.json({ message: "Email not verified", code: "EMAIL_NOT_VERIFIED" }, 403),
    );

    const response = await signIn(app, "victim@example.com");
    expect(await response.json()).toEqual({
      message: "Email not verified",
      code: "EMAIL_NOT_VERIFIED",
    });
  });

  it("refunds the reservation when the handler throws, instead of stranding it", async () => {
    const real = new RateLimiterMemory({ points: 10, duration: 3600 });
    const app = buildApp(real, () => {
      throw new Error("downstream exploded");
    });
    app.onError((_err, c) => c.json({ error: "boom" }, 500));

    expect((await signIn(app, "victim@example.com")).status).toBe(500);
    expect((await real.get("victim@example.com"))?.consumedPoints).toBe(0);
  });
});
