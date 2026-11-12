import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mountSecurityHeaders } from "./security-headers";

function buildApp(cspConnectSrc: string[] = ["'self'"]) {
  const app = new Hono();
  mountSecurityHeaders(app, {
    cspConnectSrc,
    themeInitCspHash: "'sha256-test'",
  });
  app.get("/some-page", (c) => c.text("page"));
  app.get("/kb-exports/k/t", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    return c.body("zip");
  });
  app.get("/kb-assets/k/hash", (c) => {
    c.header("Content-Security-Policy", "default-src 'self'");
    c.header("Cache-Control", "public, max-age=86400");
    return c.json({ error: "NOT_FOUND" }, 404);
  });
  return app;
}

describe("mountSecurityHeaders", () => {
  it("enforces private sandbox headers on asset errors despite downstream overrides", async () => {
    const response = await buildApp().request("/kb-assets/k/hash");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("serves routes with the app CSP", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toBe("sandbox");
  });

  it("does not allow eval or WASM compile in script-src", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    const tokens = (scriptSrc ?? "").split(/\s+/).map((t) => t.replace(/;$/, ""));
    expect(tokens).not.toContain("'unsafe-eval'");
    expect(tokens).not.toContain("'wasm-unsafe-eval'");
    expect(tokens).not.toContain("blob:");
  });

  it("limits worker-src to same-origin workers", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    const workerSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("worker-src"));
    expect(workerSrc).toBeDefined();
    const tokens = (workerSrc ?? "").split(/\s+/);
    expect(tokens).toContain("'self'");
    expect(tokens).not.toContain("blob:");
  });

  it("includes optional connect-src origins supplied by the caller", async () => {
    const res = await buildApp(["'self'", "https://api.example.com"]).request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' https://api.example.com");
  });

  it("keeps the raw-media and export sandbox on success responses", async () => {
    for (const path of ["/kb-exports/k/t"]) {
      const response = await buildApp().request(path);
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("inline KB media relies on same-origin sources; the app CSP admits no remote media", async () => {
    const res = await buildApp().request("/some-page");
    const directives = new Map(
      (res.headers.get("content-security-policy") ?? "")
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .filter((tokens) => tokens[0])
        .map((tokens) => [tokens[0]!, tokens.slice(1)]),
    );
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    // No media-src: audio/video fall back to default-src 'self' (the /kb-assets route).
    expect(directives.has("media-src")).toBe(false);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    for (const [name, tokens] of directives) {
      for (const token of tokens) {
        expect(`${name} ${token}`).not.toMatch(/(^|\s)(\*|https?:|'unsafe-eval')$/);
      }
    }
  });
});
