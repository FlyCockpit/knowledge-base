import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `build.manifest: true` in apps/web/vite.config.ts writes the client Vite
// manifest to `dist/client/.vite/manifest.json` — INSIDE the directory the
// production server hands to serveStatic. Hono's static handler serves dotfile
// directories, so without an explicit deny the manifest is publicly fetchable.
// It maps every source path to its hashed chunk (including admin-only routes)
// and its node_modules keys carry exact dependency versions.
//
// Mirrors the production branch in index.ts. Asserting against the real
// serveStatic middleware rather than a path predicate is the point: the leak
// only exists because of how the static handler treats dotfiles, so a test that
// stubbed it would pass while the server still served the file.

let clientDir: string;

function buildApp(withDeny: boolean) {
  const app = new Hono();
  if (withDeny) {
    app.all("/.vite/*", (c) => c.text("Not Found", 404));
  }
  app.use("/*", serveStatic({ root: clientDir }));
  return app;
}

beforeAll(() => {
  clientDir = mkdtempSync(join(tmpdir(), "client-dist-"));
  mkdirSync(join(clientDir, ".vite"), { recursive: true });
  mkdirSync(join(clientDir, "assets"), { recursive: true });
  writeFileSync(
    join(clientDir, ".vite", "manifest.json"),
    JSON.stringify({
      "../../node_modules/.pnpm/some-dep@1.2.3/node_modules/some-dep/index.js": {
        file: "assets/dep-AbCd1234.js",
      },
    }),
  );
  writeFileSync(join(clientDir, "assets", "app-AbCd1234.js"), "export const ok = 1;\n");
  writeFileSync(join(clientDir, "index.html"), "<!doctype html><html></html>\n");
});

afterAll(() => {
  rmSync(clientDir, { recursive: true, force: true });
});

describe("client Vite manifest exposure", () => {
  it("is served by the bare static handler — the reason the deny route exists", async () => {
    const res = await buildApp(false).request("/.vite/manifest.json");
    expect(res.status).toBe(200);
  });

  it("is denied once the /.vite/* route is registered ahead of serveStatic", async () => {
    const res = await buildApp(true).request("/.vite/manifest.json");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("some-dep");
  });

  it("denies every path under .vite, not just the manifest", async () => {
    const res = await buildApp(true).request("/.vite/anything/else.json");
    expect(res.status).toBe(404);
  });

  it("still serves hashed assets and the SSR shell", async () => {
    const app = buildApp(true);
    expect((await app.request("/assets/app-AbCd1234.js")).status).toBe(200);
    expect((await app.request("/index.html")).status).toBe(200);
  });
});
