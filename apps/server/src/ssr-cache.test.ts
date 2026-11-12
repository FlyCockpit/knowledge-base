import { beforeEach, describe, expect, it, vi } from "vitest";

// The cache reads env.SSR_CACHE_TTL_SECONDS at call time; a mutable mock lets
// each test pick a TTL. seo.js (imported transitively) resolves the app name
// through the env package at module load, so the mock provides it too.
vi.mock("@knowledge-base/env/server", () => ({
  env: {
    SSR_CACHE_TTL_SECONDS: 60,
    BETTER_AUTH_URL: "https://app.example.com",
  },
  resolveAppName: () => "App",
}));

const { env } = await import("@knowledge-base/env/server");
const {
  clear,
  get,
  set,
  size,
  handleSsrRequest,
  isCacheableRequest,
  isPublicSsrPath,
  hasAuthSessionCookie,
} = await import("./ssr-cache.js");

const BASE = "https://app.example.com";

function htmlResponse(
  body: string,
  init: { status?: number; contentType?: string; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({
    "content-type": init.contentType ?? "text/html; charset=utf-8",
    ...init.headers,
  });
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A render() that returns a fresh Response each call and counts invocations. */
function renderer(factory: () => Response) {
  return vi.fn(async (_req: Request) => factory());
}

function publicGet(path = "/en-US", headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, { method: "GET", headers });
}

beforeEach(() => {
  clear();
  (env as { SSR_CACHE_TTL_SECONDS: number }).SSR_CACHE_TTL_SECONDS = 60;
});

describe("cacheability helpers", () => {
  it("recognizes locale-prefixed public paths and the locale root", () => {
    expect(isPublicSsrPath("/en-US")).toBe(true);
    expect(isPublicSsrPath("/en-US/")).toBe(true); // trailing slash normalized
    expect(isPublicSsrPath("/es-MX")).toBe(true);
    expect(isPublicSsrPath("/es-MX/")).toBe(true);
    expect(isPublicSsrPath("/en-US/dashboard")).toBe(false);
    expect(isPublicSsrPath("/about")).toBe(false); // missing locale segment
  });

  it("over-matches better-auth session cookies (incl. __Secure- prefix)", () => {
    expect(hasAuthSessionCookie(null)).toBe(false);
    expect(hasAuthSessionCookie("theme=dark")).toBe(false);
    expect(hasAuthSessionCookie("better-auth.session_token=abc")).toBe(true);
    expect(hasAuthSessionCookie("__Secure-better-auth.session_token=abc")).toBe(true);
  });

  it("gates eligibility on GET + empty query + no session + public path + ttl", () => {
    expect(isCacheableRequest(publicGet(), 60)).toBe(true);
    expect(isCacheableRequest(publicGet(), 0)).toBe(false); // ttl disabled
    expect(isCacheableRequest(publicGet("/en-US?x=1"), 60)).toBe(false);
    expect(isCacheableRequest(publicGet("/en-US", { cookie: "better-auth.x=1" }), 60)).toBe(false);
    expect(isCacheableRequest(publicGet("/en-US/dashboard"), 60)).toBe(false);
    expect(isCacheableRequest(new Request(`${BASE}/en-US`, { method: "POST" }), 60)).toBe(false);
  });
});

describe("handleSsrRequest", () => {
  it("misses then serves the second identical request from cache", async () => {
    const render = renderer(() => htmlResponse("<html>hi</html>"));

    const first = await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(first.headers.get("x-ssr-cache")).toBe("miss");

    const second = await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(second.headers.get("x-ssr-cache")).toBe("hit");
    expect(await second.text()).toBe("<html>hi</html>");

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("swaps the stored nonce for the current request's nonce on a hit", async () => {
    const render = renderer(() => htmlResponse('<script nonce="NONCE_A">x</script>'));

    await handleSsrRequest({ request: publicGet(), nonce: "NONCE_A", render });
    const hit = await handleSsrRequest({ request: publicGet(), nonce: "NONCE_B", render });

    const body = await hit.text();
    expect(body).toContain('nonce="NONCE_B"');
    expect(body).not.toContain("NONCE_A");
  });

  it("bypasses the cache for querystring requests (no X-SSR-Cache header)", async () => {
    const render = renderer(() => htmlResponse("<html>q</html>"));

    const res = await handleSsrRequest({
      request: publicGet("/en-US?ref=1"),
      nonce: "N1",
      render,
    });

    expect(res.headers.get("x-ssr-cache")).toBeNull();
    await handleSsrRequest({ request: publicGet("/en-US?ref=1"), nonce: "N1", render });
    expect(render).toHaveBeenCalledTimes(2); // never cached
  });

  it("bypasses the cache when a better-auth session cookie is present", async () => {
    const render = renderer(() => htmlResponse("<html>s</html>"));
    const cookie = "__Secure-better-auth.session_token=abc";

    const res = await handleSsrRequest({
      request: publicGet("/en-US", { cookie }),
      nonce: "N1",
      render,
    });
    expect(res.headers.get("x-ssr-cache")).toBeNull();

    await handleSsrRequest({ request: publicGet("/en-US", { cookie }), nonce: "N1", render });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache for non-public paths", async () => {
    const render = renderer(() => htmlResponse("<html>d</html>"));
    const res = await handleSsrRequest({
      request: publicGet("/en-US/dashboard"),
      nonce: "N1",
      render,
    });
    expect(res.headers.get("x-ssr-cache")).toBeNull();
    await handleSsrRequest({ request: publicGet("/en-US/dashboard"), nonce: "N1", render });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does not cache non-200 responses", async () => {
    const render = renderer(() => htmlResponse("<html>err</html>", { status: 500 }));
    const first = await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(first.headers.get("x-ssr-cache")).toBe("miss");
    await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does not cache non-HTML responses", async () => {
    const render = renderer(() => htmlResponse("{}", { contentType: "application/json" }));
    await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("does not cache responses carrying Set-Cookie", async () => {
    const render = renderer(() =>
      htmlResponse("<html>c</html>", { headers: { "set-cookie": "sid=1" } }),
    );
    await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("re-renders after the TTL expires", async () => {
    const render = renderer(() => htmlResponse("<html>t</html>"));
    let clock = 1000;
    const now = () => clock;

    await handleSsrRequest({ request: publicGet(), nonce: "N1", render, now });
    clock = 1000 + 60 * 1000 + 1; // just past the 60s TTL
    const res = await handleSsrRequest({ request: publicGet(), nonce: "N1", render, now });

    expect(res.headers.get("x-ssr-cache")).toBe("miss");
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("disables the cache entirely when TTL is 0", async () => {
    (env as { SSR_CACHE_TTL_SECONDS: number }).SSR_CACHE_TTL_SECONDS = 0;
    const render = renderer(() => htmlResponse("<html>0</html>"));

    const res = await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(res.headers.get("x-ssr-cache")).toBeNull();
    await handleSsrRequest({ request: publicGet(), nonce: "N1", render });
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe("LRU primitives", () => {
  it("evicts the oldest entry past the max size", () => {
    const future = Date.now() + 60_000;
    const entry = (html: string) => ({
      html,
      nonce: "N",
      contentType: "text/html",
      contentLanguage: null,
      expiresAt: future,
    });

    // 201 distinct keys → the first inserted must be evicted.
    for (let i = 0; i < 201; i++) {
      set(`/en-US/p${i}`, entry(`body-${i}`));
    }

    expect(size()).toBe(200);
    expect(get("/en-US/p0")).toBeUndefined(); // evicted
    expect(get("/en-US/p200")?.html).toBe("body-200"); // still present
  });

  it("bumps recency on hit so a re-read entry survives eviction", () => {
    const future = Date.now() + 60_000;
    const entry = (html: string) => ({
      html,
      nonce: "N",
      contentType: "text/html",
      contentLanguage: null,
      expiresAt: future,
    });

    for (let i = 0; i < 200; i++) {
      set(`/en-US/p${i}`, entry(`body-${i}`));
    }
    // Touch the oldest so it becomes newest.
    expect(get("/en-US/p0")?.html).toBe("body-0");
    // One more insert evicts the now-oldest (p1), not the freshly-touched p0.
    set("/en-US/p200", entry("body-200"));

    expect(get("/en-US/p0")?.html).toBe("body-0");
    expect(get("/en-US/p1")).toBeUndefined();
  });

  it("expires entries whose deadline has passed", () => {
    set("/en-US/x", {
      html: "old",
      nonce: "N",
      contentType: "text/html",
      contentLanguage: null,
      expiresAt: 1000,
    });
    expect(get("/en-US/x", 999)).toBeDefined();
    expect(get("/en-US/x", 1000)).toBeUndefined();
  });
});
