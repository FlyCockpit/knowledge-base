import { serveStatic } from "@hono/node-server/serve-static";
import type { Env, Hono } from "hono";

/**
 * Production static file routes for the built web client (`apps/web/dist/client`).
 * Mounted by index.ts ahead of the SSR catch-all; everything they do not serve
 * falls through to it.
 */
export function mountStaticClient<E extends Env>(app: Hono<E>, clientDir: string): void {
  // Vite/rolldown content-hashes every file under /assets, so each URL is
  // immutable: a code change produces a new filename, never a new body at the
  // same URL. Safe to cache for a year. This middleware runs before the
  // serveStatic below (sets the header, then defers to it).
  // IMPORTANT: do NOT add long caching to the catch-all /* serveStatic or the
  // SSR shell — index.html and version.json must stay revalidated so new
  // deploys are picked up.
  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  });
  app.use("/assets/*", serveStatic({ root: clientDir }));
  // A file under /assets that does not exist (a chunk from another build, a
  // typo, a probe) is a plain 404. Without this it would fall through to the
  // SSR catch-all, whose locale redirect answers 307 → /<lang>/assets/... and
  // then renders the app's 404 page as HTML — a module script loader then
  // reports a MIME error instead of a missing file, and the year-long
  // immutable header above would be attached to that redirect. Not cached:
  // the file may exist on the next deploy.
  app.all("/assets/*", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text("Not Found", 404);
  });

  // `build.manifest: true` (apps/web/vite.config.ts) writes the client Vite
  // manifest INTO the static root at `.vite/manifest.json`, and Hono's
  // serveStatic happily serves dotfile directories. That file maps every source
  // path to its hashed asset — including admin-only route chunks — and its
  // node_modules keys leak the exact installed version of every dependency,
  // which is free reconnaissance for anyone probing for a known CVE. The server
  // reads it from disk at startup; nothing needs it over HTTP. Deny it before
  // the catch-all static handler can find it. See locale-modulepreload.ts.
  app.all("/.vite/*", (c) => c.text("Not Found", 404));

  app.use("/*", serveStatic({ root: clientDir }));
}
