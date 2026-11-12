import {
  getAllowedUserCreationMode,
  getUserCreationBlockReason,
} from "@knowledge-base/auth/user-creation-policy";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { adminBootstrapMarker } from "./signup-gate.js";

const PATH = "/api/auth/sign-up/email";
const ADMIN = "admin@example.com";

// Observed better-auth 1.7.1 `signUpEmail` behavior for the cases that matter
// here (better-auth/dist/api/routes/sign-up.mjs): input validation first
// (400s), then the existing-email generic duplicate (200, because
// requireEmailVerification is on), then createUser — where the database hook
// rejects with a plain Error that the route converts to 422
// FAILED_TO_CREATE_USER. member signups that clear the hook succeed (200).
// The stub below replays exactly that order, using the REAL block-reason
// function the hook delegates to, so the suite pins the wiring contract:
// every rejection must be identical for member and non-member addresses.
function buildApp(opts: { signupEnabled: boolean; existingEmails?: Set<string> }) {
  const app = new Hono();
  const seenModes: Array<string | undefined> = [];
  app.use(PATH, adminBootstrapMarker(ADMIN));
  app.post(PATH, async (c) => {
    seenModes.push(getAllowedUserCreationMode());
    const body = (await c.req.json()) as { email?: unknown; password?: unknown };
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ code: "INVALID_EMAIL", message: "Invalid email" }, 400);
    }
    if (password.length < 12) {
      return c.json({ code: "PASSWORD_TOO_SHORT", message: "Password is too short" }, 400);
    }
    if (opts.existingEmails?.has(email)) {
      return c.json({ token: null, user: { email } }, 200);
    }
    const blocked = getUserCreationBlockReason({ signupEnabled: opts.signupEnabled });
    if (blocked) {
      return c.json({ code: "FAILED_TO_CREATE_USER", message: "Failed to create user" }, 422);
    }
    return c.json({ token: "session-token", user: { email } }, 200);
  });
  return { app, seenModes };
}

function post(app: Hono, body: unknown) {
  return app.request(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("adminBootstrapMarker", () => {
  it("never responds itself — member, non-member, and malformed bodies all reach downstream", async () => {
    const { app, seenModes } = buildApp({ signupEnabled: false });
    for (const body of [
      { email: ADMIN, password: "long-enough-password" },
      { email: "stranger@example.com", password: "long-enough-password" },
      { notEmail: true },
    ]) {
      const res = await post(app, body);
      // Every response below comes from downstream, never from the marker:
      // the marker must not emit (or throw) for any body shape.
      expect([200, 400, 422]).toContain(res.status);
    }
    expect(seenModes).toHaveLength(3);
  });

  it("marks only member requests for admin bootstrap", async () => {
    const { app, seenModes } = buildApp({ signupEnabled: true });
    await post(app, { email: ADMIN, password: "long-enough-password" });
    await post(app, { email: "stranger@example.com", password: "long-enough-password" });
    expect(seenModes).toEqual(["admin-bootstrap", undefined]);
  });

  it("passes the body through un-consumed (downstream reads it, as auth.handler does)", async () => {
    const { app } = buildApp({ signupEnabled: true });
    const res = await post(app, { email: ADMIN, password: "long-enough-password" });
    expect(await res.json()).toEqual({
      token: "session-token",
      user: { email: ADMIN },
    });
  });
});

describe("signup-disabled oracle — member vs non-member responses are indistinguishable", () => {
  const VALID_MEMBER = { email: ADMIN, password: "long-enough-password" };
  const VALID_NON_MEMBER = { email: "stranger@example.com", password: "long-enough-password" };

  it("invalid input yields identical 400s before any membership decision", async () => {
    const { app } = buildApp({ signupEnabled: false });
    const memberRes = await post(app, { email: ADMIN, password: "short" });
    const nonMemberRes = await post(app, { email: "stranger@example.com", password: "short" });
    expect(memberRes.status).toBe(nonMemberRes.status);
    expect(await memberRes.json()).toEqual(await nonMemberRes.json());
    expect(memberRes.status).toBe(400);
  });

  it("blocked signups yield identical 422s for different non-member addresses", async () => {
    const { app } = buildApp({ signupEnabled: false });
    const a = await post(app, VALID_NON_MEMBER);
    const b = await post(app, { email: "other@example.com", password: "another-long-password" });
    const aBody = (await a.json()) as Record<string, unknown>;
    const bBody = (await b.json()) as Record<string, unknown>;
    expect(a.status).toBe(422);
    expect(aBody).toEqual(bBody);
    expect(Object.keys(aBody).sort()).toEqual(["code", "message"]);
  });

  it("already-registered emails yield identical generic 200s for member and non-member", async () => {
    const { app } = buildApp({
      signupEnabled: false,
      existingEmails: new Set([ADMIN, "stranger@example.com"]),
    });
    const memberRes = await post(app, VALID_MEMBER);
    const nonMemberRes = await post(app, VALID_NON_MEMBER);
    const memberBody = (await memberRes.json()) as Record<string, unknown>;
    const nonMemberBody = (await nonMemberRes.json()) as Record<string, unknown>;
    expect(memberRes.status).toBe(200);
    expect(nonMemberRes.status).toBe(200);
    // Same status + same body keys. The echoed `email` value necessarily
    // differs (it is the caller-supplied address, which Better-Auth reflects
    // back) — that is not membership information.
    expect(Object.keys(memberBody).sort()).toEqual(Object.keys(nonMemberBody).sort());
    expect(memberBody.token).toBe(nonMemberBody.token);
  });

  it("documents the one necessary divergence: a valid NEW member signup succeeds (bootstrap)", async () => {
    const { app } = buildApp({ signupEnabled: false });
    const memberRes = await post(app, VALID_MEMBER);
    const nonMemberRes = await post(app, VALID_NON_MEMBER);
    expect(memberRes.status).toBe(200);
    expect(nonMemberRes.status).toBe(422);
    // Success inherently creates the account and emails its owner (who did
    // not request it) — noisy, rate-limited, and unusable without mailbox
    // access (requireEmailVerification). That is the pre-claim window the
    // audit accepts; this test pins it as the ONLY member/non-member split.
  });
});
