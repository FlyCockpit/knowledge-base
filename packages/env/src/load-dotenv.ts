/**
 * Load the repository-root `.env` into `process.env` for local dev and tooling.
 *
 * This module is a SIDE EFFECT ONLY — it exports nothing. The logic lives in
 * `./root-env`, which is import-time pure; import that instead if you need the
 * helpers without loading anything.
 *
 * ## Validation vs loading
 *
 * - **Validation** (`./shared`, `./server`, `./web`) only reads
 *   `process.env` via `@t3-oss/env-core` + Zod. Those modules must never import
 *   `dotenv`, `./root-env`, or this file, and must never touch the filesystem
 *   for env files — they run inside the production server bundle and the web
 *   SSR graph (auth → env). Production injects env vars; a runtime `dotenv`
 *   dependency there breaks Docker/SSR.
 * - **Loading** is this module (or an explicit `loadRootDotenv()` call). Import
 *   it as a side effect from process entrypoints *before* any
 *   `@knowledge-base/env/shared` or `@knowledge-base/env/server` import (or before any
 *   package that imports those, e.g. `@knowledge-base/db`, `@knowledge-base/i18n-translate`):
 *
 *     import "@knowledge-base/env/load-dotenv";
 *     import { env } from "@knowledge-base/env/server";
 *
 * First-party entrypoints that must load the root `.env`:
 * - `apps/server/src/bootstrap.ts`, `apps/worker/src/bootstrap.ts` — the BUILT
 *   entries. A bare first import is not enough once bundled (see below); these
 *   wrappers import this module and then hand off with a dynamic `import()`.
 * - `apps/server/src/index.ts`, `apps/worker/src/index.ts` (side-effect import,
 *   first) — the `tsx` dev entries, where plain ESM ordering applies
 * - `scripts/doctor.ts` (side-effect import, first)
 * - `scripts/translate-locale-bundles.ts` (side-effect import, first)
 * - `packages/db/prisma/seed.cli.ts` (side-effect import, first)
 * - `apps/web/vite.config.ts` — `loadRootDotenv()` call; config-time only, not
 *   in the SSR output graph
 *
 * ## Bundling inverts import order
 *
 * Being the first import is correct under plain ESM. After bundling it is not:
 * rolldown inlines this module's body into the entry chunk's body while
 * hoisting `@knowledge-base/env/shared` into a separate statically-imported chunk, and
 * ESM evaluates static imports before the importer's own statements — so
 * validation ran, and threw, before the `.env` was read. Hence the bootstrap
 * wrappers, whose one hard rule is: no static import other than this one.
 *
 * That list is enforced, not documentation: `pnpm env:check-entrypoints`
 * (CI `lint` job) asserts each entry loads the root `.env` in its declared mode,
 * that side-effect ones do it as their FIRST import, that bundled ones have no
 * other static import and that their tsdown config targets the wrapper, that no
 * validation module imports dotenv, and that nothing outside a small allowlist
 * imports `dotenv` directly. Add an entrypoint → add it to
 * `scripts/check-load-dotenv-contract.ts` (ENTRYPOINTS in that file is the
 * source of truth).
 *
 * Do not import this from libraries (`@knowledge-base/auth`, `@knowledge-base/db`,
 * `@knowledge-base/api`, …) or from any module that lands in the web SSR output graph
 * — that graph must stay free of `dotenv`.
 *
 * Files allowed to import `dotenv` directly, and only these:
 * `./root-env` (the one implementation), `scripts/generate-secrets.ts`
 * (`parse` only), and `packages/db/prisma.config.ts` (must stay self-contained
 * — it is loaded by `prisma generate` during `pnpm install`, before any
 * workspace source exists in the Docker build context). Vite's own `loadEnv`
 * for build-time `VITE_*` is unrelated to dotenv-the-package.
 */
import { loadRootDotenv } from "./root-env.js";

loadRootDotenv();
