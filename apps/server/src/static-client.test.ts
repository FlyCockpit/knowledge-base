import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mountStaticClient } from "./static-client.js";

// The real static routes, then a stand-in for the SSR catch-all that behaves
// like the router does for any unknown, locale-less path: 307 to /en-US/...
let clientDir: string;

function buildApp() {
  const app = new Hono();
  mountStaticClient(app, clientDir);
  app.all("/*", (c) => c.redirect(`/en-US${c.req.path}`, 307));
  return app;
}

beforeAll(() => {
  clientDir = mkdtempSync(join(tmpdir(), "static-client-"));
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  mkdirSync(join(clientDir, ".vite"), { recursive: true });
  writeFileSync(join(clientDir, "assets", "app-AbCd1234.js"), "export const ok = 1;\n");
  writeFileSync(join(clientDir, ".vite", "manifest.json"), "{}");
  writeFileSync(join(clientDir, "robots-static.txt"), "ok\n");
});

afterAll(() => {
  rmSync(clientDir, { recursive: true, force: true });
});

describe("static client routes", () => {
  it("serves a hashed asset with the immutable cache header", async () => {
    const res = await buildApp().request("/assets/app-AbCd1234.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toContain("export const ok");
  });

  it("answers a missing /assets file with a plain, uncached 404 — no locale redirect", async () => {
    for (const path of [
      "/assets/missing-Zz999999.js",
      "/assets/missing.css",
      "/assets/nested/missing.js",
    ]) {
      const res = await buildApp().request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("content-type"), path).toMatch(/^text\/plain/);
      expect(await res.text(), path).toBe("Not Found");
    }
    const head = await buildApp().request("/assets/missing.js", { method: "HEAD" });
    expect(head.status).toBe(404);
  });

  it("denies the .vite manifest and leaves other paths to the SSR catch-all", async () => {
    const app = buildApp();
    expect((await app.request("/.vite/manifest.json")).status).toBe(404);
    expect((await app.request("/robots-static.txt")).status).toBe(200);
    const page = await app.request("/pricing");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("/en-US/pricing");
  });
});
