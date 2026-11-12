import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_LOCALE, LOCALE_CHUNK_PREFIX } from "@knowledge-base/config/locales";
import { appShortName, DEFAULT_APP_NAME } from "@knowledge-base/env/app-name";
import { loadRootDotenv } from "@knowledge-base/env/root-env";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { type VitePluginPWAAPI, VitePWA } from "vite-plugin-pwa";
import { configDefaults, defineConfig } from "vitest/config";

// Hydrate the repo-root `.env` into process.env for TanStack Start server
// functions during `vite dev` — they run in THIS Vite process, not in
// apps/server, so nothing else would load it for them. This config file is not
// part of the client/SSR bundle graph, so it stays clear of the rule that the
// production SSR graph must never reach dotenv (see @knowledge-base/env/load-dotenv).
//
// Loading it here means the root `.env` now reaches this process BEFORE config
// evaluation. (It already reached the process eventually — `@knowledge-base/env/shared`
// used to load it when the first SSR module was evaluated — but that was long
// after this file ran.) Two consequences to keep in mind:
//   - Vite's `loadEnv` merges prefix-matching keys from process.env after
//     parsing the app-local files, so a `VITE_*` key would otherwise reach the
//     client from the ROOT .env and outrank apps/web/.env. `VITE_*` belongs in
//     apps/web/.env; the unset below enforces that rather than documenting it.
//     (The root .env is in the `build` task's turbo inputs, so a change to it
//     still busts the build cache.)
//   - `PORT` is a real root variable — it configures apps/server. The dev-port
//     fallback below reads process.env.PORT; see `injectedPort`.
const viteKeysBeforeLoad = new Set(
  Object.keys(process.env).filter((key) => key.startsWith("VITE_")),
);
const rootEnv = loadRootDotenv().parsed;

// Drop `VITE_*` keys that the ROOT .env introduced. Client-bundle config is
// owned by apps/web/.env; a root-file value silently winning over it is a
// footgun (and any such key is inlined into shipped JS, so "it was only in the
// root .env" is not a containment story).
//
// Exact, not heuristic: a key is removed only if the root file declared it AND
// it was absent from process.env before the load — i.e. the file is provably
// where it came from. A genuinely exported `VITE_*` (shell, portless, CI) was
// already present, so it survives untouched.
for (const key of Object.keys(rootEnv)) {
  if (key.startsWith("VITE_") && !viteKeysBeforeLoad.has(key)) {
    delete process.env[key];
  }
}

function getBuildVersion(): string {
  // process.env is correct here — Vite config runs at build time outside the app runtime.
  if (process.env.BUILD_VERSION) return process.env.BUILD_VERSION;
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // Fallback when git is unavailable (e.g. inside the Docker builder image).
    // Kept unique per build purely as a build identifier — update detection is
    // service-worker-driven (see the comment below), not version comparison.
    return `build-${randomUUID()}`;
  }
}

// Exposed to the app as `__APP_VERSION__` (define below). Update detection is
// driven by the service-worker lifecycle (vite-plugin-pwa autoUpdate), NOT by
// comparing this string against a fetched manifest. Kept here as a build
// identifier; pass BUILD_VERSION (the git SHA) in CI/Docker to make it
// deterministic.
const buildVersion = getBuildVersion();

function parseDevPort(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer TCP port between 1 and 65535.`);
  }
  return port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPortlessApiTarget(): string {
  try {
    const raw = readFileSync(path.resolve(__dirname, "../../portless.json"), "utf-8");
    const config: unknown = JSON.parse(raw);
    if (!isRecord(config) || !isRecord(config.apps)) return "https://api.knowledge-base.localhost";
    const server = config.apps["apps/server"];
    if (!isRecord(server) || typeof server.name !== "string" || server.name.length === 0) {
      return "https://api.knowledge-base.localhost";
    }
    return `https://${server.name}.localhost`;
  } catch {
    return "https://api.knowledge-base.localhost";
  }
}

function normalizeProxyTarget(value: string | undefined): { http: string; ws: string } {
  const target =
    value || (process.env.PORTLESS_URL ? getPortlessApiTarget() : "http://localhost:3000");
  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("VITE_DEV_SERVER_URL must start with http:// or https://.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  const wsUrl = new URL(url);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { http: url.toString().replace(/\/$/, ""), ws: wsUrl.toString().replace(/\/$/, "") };
}

export default defineConfig(({ mode }) => {
  // Keep build-time and runtime branding in lockstep by loading the same
  // app-local env files (`apps/web/.env*`) that the client runtime uses.
  const envDir = __dirname;
  const env = loadEnv(mode, envDir, "VITE_");
  const appName = env.VITE_APP_NAME || DEFAULT_APP_NAME;
  // The `PORT` fallback exists for hosts that inject a port for the dev server
  // (portless does this per app). A `PORT` that came from the repo-root `.env`
  // is a different variable — it configures apps/server — and honouring it here
  // would silently bind the web dev server to the API's port.
  //
  // Compare values, not just key presence: `parsed` lists every key the FILE
  // declared, including ones whose value lost to an already-set process.env.
  // Testing `parsed.PORT !== undefined` would therefore also discard a genuine
  // injected PORT whenever the file happens to declare one too. Discard only
  // when the value in play is the one the file supplied.
  const injectedPort =
    process.env.PORT !== undefined && process.env.PORT === rootEnv.PORT
      ? undefined
      : process.env.PORT;
  const devPort = parseDevPort(
    process.env.VITE_DEV_PORT ?? env.VITE_DEV_PORT ?? injectedPort,
    3001,
    "VITE_DEV_PORT",
  );
  const devProxyTarget = normalizeProxyTarget(
    process.env.VITE_DEV_SERVER_URL ?? env.VITE_DEV_SERVER_URL,
  );

  // TanStack Start builds through Vite's environment API (client + ssr
  // environments in one builder run). vite-plugin-pwa re-captures the resolved
  // config in every `configResolved` call, so by build time it holds the LAST
  // environment's config — the ssr one, with `build.ssr: true` and
  // `build.outDir: "dist/server"`. Two consequences this block compensates for:
  //   1. The plugin's own `closeBundle` guards on `!viteConfig.build.ssr`, so
  //      it silently never builds `src/sw.ts` — the deployed app would 404 on
  //      sw.js and precache/offline/autoUpdate would be inert. The companion
  //      plugin below triggers the public `api.generateSW()` from the CLIENT
  //      environment's closeBundle instead.
  //   2. Path resolution would land on `dist/server`, so `outDir` is pinned to
  //      the client environment's output where the SW must live and glob its
  //      precache entries.
  const pwaPlugins = VitePWA({
    strategies: "injectManifest",
    srcDir: "src",
    filename: "sw.ts",
    outDir: "dist/client",
    registerType: "autoUpdate",
    manifest: {
      name: appName,
      short_name: appShortName(appName),
      description: appName,
      // Chrome/Android install criteria: without 192+512 icons, a start_url,
      // and a display mode there is no install prompt and no standalone
      // window. `start_url: "/"` is correct despite /$lang/ routes — the bare
      // root route redirects through locale detection (src/routes/index.tsx).
      icons: [
        { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
        { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
        {
          src: "maskable-icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
      display: "standalone",
      start_url: "/",
      scope: "/",
      // Hardcoded pair: no shared constant with the runtime meta (the hex lives
      // inside the THEME_INIT_SCRIPT string). Must stay in sync with
      // theme-init.ts / use-theme-color-meta.ts on re-skin.
      theme_color: "#0c0c0c",
      background_color: "#0c0c0c",
    },
    // Precache the install-surface icons explicitly rather than relying on the
    // globPatterns png/ico match, so they survive offline even if those globs
    // are narrowed later. Appended to __WB_MANIFEST (injectManifest strategy).
    includeAssets: [
      "pwa-64x64.png",
      "pwa-192x192.png",
      "pwa-512x512.png",
      "maskable-icon-512x512.png",
      "apple-touch-icon-180x180.png",
      "favicon.ico",
    ],
    pwaAssets: { disabled: false, config: true },
    devOptions: { enabled: true, type: "module" },
    injectManifest: {
      globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
    },
  });
  const pwaApi = pwaPlugins.find((p) => p.name === "vite-plugin-pwa")?.api as
    | VitePluginPWAAPI
    | undefined;
  const generateSWAfterClientBuild: Plugin = {
    name: "generate-sw-after-client-build",
    apply: "build",
    enforce: "post",
    closeBundle: {
      sequential: true,
      order: "post",
      async handler() {
        if (this.environment?.name !== "client") return;
        await pwaApi?.generateSW();
      },
    },
  };

  return {
    envDir,
    plugins: [tailwindcss(), tanstackStart(), react(), pwaPlugins, generateSWAfterClientBuild],
    define: {
      __APP_VERSION__: JSON.stringify(buildVersion),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        // Locale JSON bundles live in the shared `@knowledge-base/locales` package.
        // The web app reads them via `import.meta.glob` (see src/i18n/index.ts)
        // for its eager/lazy per-locale code-splitting — glob supports aliased
        // patterns, so this alias points those globs at the package source.
        "@locales": path.resolve(__dirname, "../../packages/locales/src"),
      },
    },
    // The web package selects this Vite config rather than the repo-root
    // Vitest config. Keep the same import-time Redis guard in its test graph
    // without changing web build or development configuration.
    test: {
      // Match the root worker budget: Turbo already runs test packages in parallel.
      maxWorkers: 1,
      setupFiles: [path.resolve(__dirname, "../../scripts/test-io-guard.ts")],
      // Real-browser specs run only under Playwright (`pnpm test:kb -- browser`).
      exclude: [...configDefaults.exclude, "tests/kb-*.spec.ts"],
    },
    build: {
      // Client Vite manifest (dist/client/.vite/manifest.json) maps source paths
      // to content-hashed assets. The API server reads it at startup to emit an
      // SSR `<link rel="modulepreload">` for the active non-default locale's
      // chunk — see apps/server/src/locale-modulepreload.ts. TanStack Start's
      // multi-environment build inherits this into the client environment; the
      // SSR environment's copy is unused.
      //
      // The manifest is written INSIDE the static root, and the production
      // server explicitly denies `/.vite/*` so it is never served over HTTP
      // (apps/server/src/index.ts). Keep that deny route if you keep this flag.
      manifest: true,
      rolldownOptions: {
        output: {
          manualChunks(id) {
            // Every namespace JSON for one non-default locale collapses into a
            // single `locale-<tag>` chunk. i18n/index.ts lazily imports the
            // namespaces individually (`@locales/<locale>/<ns>.json`), so
            // WITHOUT this rule a first visit to /es-MX/ fires one request per
            // namespace; with it, those imports all resolve to one chunk and
            // the browser makes one request.
            //
            // Doing it here rather than via a hand-written per-locale aggregate
            // module means adding a locale stays "drop the JSON in" and adding a
            // namespace needs no per-locale edit — there is no lockstep step to
            // forget, and no silent fallback-to-English when someone forgets it.
            // The default locale is excluded: it ships eagerly in the base
            // bundle and must never also exist as a separate chunk.
            //
            // The chunk NAME is load-bearing: apps/server reads it out of the
            // client Vite manifest to emit the SSR modulepreload, so the prefix
            // is a shared constant rather than a literal in two files.
            const localeMatch = /\/packages\/locales\/src\/([^/]+)\/([^/]+)\.json$/.exec(id);
            if (localeMatch?.[1] && localeMatch[1] !== DEFAULT_LOCALE) {
              return `${LOCALE_CHUNK_PREFIX}${localeMatch[1]}`;
            }
            // Anchor on `/node_modules/<pkg>/` so this matches ONLY the React
            // runtime — NOT every package whose path happens to contain the
            // substring "react" (e.g. `react-i18next`). A loose `/react/` test here pulls those heavy,
            // route-specific deps into the eager base chunk and defeats the
            // per-route code-splitting TanStack Start already does. Keep this
            // list to the libraries every page genuinely needs at first paint.
            if (
              id.includes("/node_modules/react/") ||
              id.includes("/node_modules/react-dom/") ||
              id.includes("/node_modules/scheduler/") ||
              id.includes("/node_modules/react-is/")
            ) {
              return "react-vendor";
            }
            if (
              id.includes("/node_modules/@tanstack/react-router/") ||
              id.includes("/node_modules/@tanstack/react-query/") ||
              id.includes("/node_modules/@tanstack/react-form/")
            ) {
              return "tanstack";
            }
            // `sileo` (Toaster) and `next-themes` (ThemeProvider) render in the
            // root, so they're genuinely needed at first paint — keep them in the
            // eager `ui` chunk. `lucide-react` is NOT listed here on purpose: a
            // named chunk would collapse every icon used anywhere in the app
            // (admin, dashboard, settings…) into one eager chunk, so first paint
            // pays for icons it never renders. Left unlisted, Rollup splits icons
            // into their owning route chunks and hoists shared ones automatically.
            if (id.includes("/node_modules/sileo/") || id.includes("/node_modules/next-themes/")) {
              return "ui";
            }
            if (
              id.includes("/node_modules/@orpc/client/") ||
              id.includes("/node_modules/@orpc/server/") ||
              id.includes("/node_modules/@orpc/tanstack-query/")
            ) {
              return "orpc";
            }
            if (id.includes("/node_modules/better-auth/")) {
              return "auth";
            }
            if (id.includes("/node_modules/zod/")) {
              return "zod";
            }
          },
        },
      },
    },
    server: {
      port: devPort,
      // Opt in to 0.0.0.0 when running inside the agent docker-compose stack
      // (docker-compose.agent.yml sets VITE_DEV_HOST=true). Unset on the host
      // so `pnpm dev` keeps its localhost-only default.
      host: process.env.VITE_DEV_HOST === "true" ? true : undefined,
      // Cloudflare quick tunnels (`pnpm dev:tunnel`)
      // forward requests with Host: <random>.trycloudflare.com, which Vite's
      // host-header check rejects by default. Suffix-allow only that domain —
      // localhost and *.localhost stay allowed regardless, and the server still
      // binds to localhost, so this matters only while a tunnel is up.
      allowedHosts: [".trycloudflare.com"],
      proxy: {
        // OAuth/MCP surfaces bind to the canonical origin (BETTER_AUTH_URL): like the
        // production reverse proxy, keep the browser's Host so the server sees the
        // public origin (changeOrigin would send the API's own host and get a 400).
        // Listed before "/api" so the more specific prefix wins.
        "/api/auth": { target: devProxyTarget.http, changeOrigin: false, secure: false },
        // Exactly /mcp (not the /mcp-consent or /mcp-login pages).
        "^/mcp(?:[/?]|$)": { target: devProxyTarget.http, changeOrigin: false, secure: false },
        "/.well-known/": { target: devProxyTarget.http, changeOrigin: false, secure: false },
        "/api": { target: devProxyTarget.http, changeOrigin: true, secure: false },
        "/rpc": { target: devProxyTarget.http, changeOrigin: true, secure: false },
        // KB media/ZIP/clone helpers use the web origin, including when
        // portless gives the API a separate origin. Preserve browser Origin
        // and Sec-Fetch-Site headers for the authenticated Hono admission.
        "/kb-assets/": { target: devProxyTarget.http, changeOrigin: true, secure: false },
        "/kb-exports/": { target: devProxyTarget.http, changeOrigin: true, secure: false },
        "/git/": { target: devProxyTarget.http, changeOrigin: true, secure: false },
        // Dedicated service-worker renewal endpoint (see
        // `apps/server/src/index.ts → POST /sw/push-renew`). In dev the SW runs
        // on the Vite origin; proxy so the relative fallback still reaches the
        // API server.
        "/sw": { target: devProxyTarget.http, changeOrigin: true, secure: false },
        "/ws": { target: devProxyTarget.ws, ws: true, changeOrigin: true, secure: false },
      },
    },
  };
});
