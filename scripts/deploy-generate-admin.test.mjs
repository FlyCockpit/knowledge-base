import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interpret,
  parseArgs,
  parseEmail,
  parseOrigin,
  requestLink,
  SETUP_PATH,
  successText,
  UsageError,
} from "./deploy-generate-admin.mjs";

test("parseArgs takes --url and --email, and refuses a key on argv", () => {
  assert.deepEqual(parseArgs(["--url", "https://a.example.com", "--email=o@example.com"]), {
    url: "https://a.example.com",
    email: "o@example.com",
  });
  assert.throws(() => parseArgs(["--key", "secret"]), /never taken as an argument/);
  assert.throws(() => parseArgs(["--key=secret"]), /never taken as an argument/);
  assert.throws(() => parseArgs(["positional"]), UsageError);
  assert.throws(() => parseArgs(["--url"]), /needs a value/);
});

test("parseOrigin requires https except on this machine", () => {
  assert.equal(parseOrigin("https://kb.example.com/some/path"), "https://kb.example.com");
  assert.equal(parseOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(parseOrigin("http://knowledge-base.localhost"), "http://knowledge-base.localhost");
  assert.throws(() => parseOrigin("http://kb.example.com"), /https/);
  assert.throws(() => parseOrigin("https://user:pw@kb.example.com"), /credentials/);
  assert.throws(() => parseOrigin("https://kb.example.com/?q=1"), /query/);
  assert.throws(() => parseOrigin("not a url"), /not valid/);
});

test("parseEmail normalizes and validates", () => {
  assert.equal(parseEmail("  Owner@Example.COM "), "owner@example.com");
  assert.throws(() => parseEmail("owner"), UsageError);
});

test("requestLink posts JSON to the setup route without following redirects", async () => {
  /** @type {{ url: string, init: RequestInit } | null} */
  let seen = null;
  const fetchImpl = /** @type {typeof fetch} */ (
    async (url, init) => {
      seen = { url: String(url), init: /** @type {RequestInit} */ (init) };
      return new Response(JSON.stringify({ error: "invalid_key" }), { status: 401 });
    }
  );
  const answer = await requestLink(
    "https://kb.example.com",
    { key: "k", email: "o@example.com" },
    { fetchImpl },
  );
  assert.deepEqual(answer, { status: 401, body: { error: "invalid_key" }, retryAfter: null });
  assert.ok(seen);
  assert.equal(seen.url, `https://kb.example.com${SETUP_PATH}`);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.redirect, "manual");
  assert.deepEqual(JSON.parse(String(seen.init.body)), { key: "k", email: "o@example.com" });
});

test("requestLink reports a network failure instead of throwing", async () => {
  const fetchImpl = /** @type {typeof fetch} */ (
    async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
  );
  assert.deepEqual(
    await requestLink("https://a.example.com", { key: "k", email: "e" }, { fetchImpl }),
    { error: "ECONNREFUSED" },
  );
});

test("interpret: success", () => {
  const result = interpret({
    status: 200,
    retryAfter: null,
    body: { url: "https://x/l", expiresAt: "2026-11-23T13:00:00.000Z", email: "o@x.io" },
  });
  assert.deepEqual(result, {
    ok: true,
    url: "https://x/l",
    expiresAt: "2026-11-23T13:00:00.000Z",
    email: "o@x.io",
  });
});

test("interpret: every refusal has a plain next step", () => {
  /** @param {number} status @param {unknown} [body] */
  const msg = (status, body = {}) => {
    const r = interpret({ status, body, retryAfter: "900" });
    assert.equal(r.ok, false);
    return /** @type {{ message: string }} */ (r).message;
  };
  assert.match(msg(404), /SETUP_KEY is not set/);
  assert.match(msg(401, { error: "invalid_key" }), /Wrong setup key/);
  assert.match(msg(409, { error: "bootstrap_complete" }), /already complete.*remove SETUP_KEY/s);
  assert.match(msg(409, { error: "email_not_allowed" }), /ADMIN_EMAIL/);
  assert.match(msg(409, { error: "password_signin_disabled" }), /FORCE_SSO/);
  assert.match(msg(413), /too large/);
  assert.match(msg(429), /900 seconds/);
  assert.match(msg(308), /redirect/);
  assert.match(msg(503), /temporarily unavailable/);
  assert.match(msg(500, { error: "internal_error" }), /HTTP 500: internal_error/);
  assert.match(
    /** @type {{ message: string }} */ (interpret({ error: "ENOTFOUND" })).message,
    /ENOTFOUND/,
  );
});

test("successText prints the link and the remove-the-key reminder", () => {
  const text = successText(
    { url: "https://x/l", expiresAt: "2026-11-23T13:00:00.000Z", email: "o@x.io" },
    new Date("2026-11-23T12:00:00.000Z"),
  );
  assert.match(text, /admin o@x\.io/);
  assert.match(text, /creates the account/);
  assert.match(text, /about 60 minutes/);
  assert.match(text, /\n {2}https:\/\/x\/l\n/);
  assert.match(text, /REMOVE SETUP_KEY/);
});
