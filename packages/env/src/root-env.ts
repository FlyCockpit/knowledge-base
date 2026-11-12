/**
 * Pure helpers for locating and loading the repository-root `.env`.
 *
 * Nothing in this module runs at import time. Importing it has no effect on
 * `process.env` — that is the whole point of keeping it separate from
 * `./load-dotenv`, which is the side-effect entry:
 *
 * - `./load-dotenv` — `import "@knowledge-base/env/load-dotenv";` as the FIRST import
 *   of a process entrypoint. Side effect only, exports nothing.
 * - `./root-env` (this file) — for callers that need to know WHICH keys the
 *   file supplied (see `LoadRootDotenvResult.parsed`). The one such caller today
 *   is `apps/web/vite.config.ts`.
 *
 *   `packages/db/prisma.config.ts` is NOT an example of this, despite looking
 *   like one: it imports `dotenv` directly and must keep doing so. It is loaded
 *   by `prisma generate` during `pnpm install`, before any workspace source
 *   exists in the Docker build context, so routing it through this module breaks
 *   both image builds — a failure `pnpm build`, `pnpm test`, and typecheck all
 *   miss. `scripts/check-load-dotenv-contract.ts` allowlists it deliberately.
 *
 * Either way the rule from `./load-dotenv` still holds: only process
 * entrypoints load. The validation modules (`./shared`, `./server`, `./web`,
 * `./native`) must never import this file — they run inside the production
 * server bundle and the web SSR graph, which must stay free of `dotenv`.
 * `pnpm env:check-entrypoints` enforces both halves of that contract.
 */

import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Files that only exist at the monorepo root. Checked as a set rather than a
 * fixed `../../..` hop from `import.meta.dirname` because that relative depth
 * is only correct for unbundled source under `packages/env/src` — it is wrong
 * for tsdown output, for a Vite SSR chunk, and for anything else that moves the
 * module relative to the root.
 */
const ROOT_MARKERS = ["pnpm-workspace.yaml", "turbo.json"] as const;

export interface LoadRootDotenvResult {
  /** Absolute path to the monorepo root, or `null` if it could not be found. */
  root: string | null;
  /** Absolute path to the root `.env`, or `null` when the root is unknown. */
  envPath: string | null;
  /** True when a `.env` file was found AND parsed. */
  loaded: boolean;
  /**
   * Keys the root `.env` file itself declared, whether or not they won.
   *
   * dotenv never overrides an existing `process.env` value, so this is NOT the
   * same as "keys this call set". It answers a different question: "did this
   * value come from the developer's root `.env`?" — which is what a consumer
   * needs when a root-only variable would otherwise be mistaken for one the
   * platform injected. See `apps/web/vite.config.ts` for the worked case.
   */
  parsed: Record<string, string>;
}

/** Walk up from `startDir` until a directory contains a root marker. */
export function findRepoRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (ROOT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate the monorepo root from this module's location, falling back to the
 * process CWD (covers bundled output that no longer sits inside the repo tree).
 */
export function resolveRepoRoot(): string | null {
  return findRepoRoot(import.meta.dirname) ?? findRepoRoot(process.cwd());
}

/** Absolute path to the root `.env`, or `null` if the root cannot be located. */
export function resolveRootEnvPath(): string | null {
  const root = resolveRepoRoot();
  return root ? path.join(root, ".env") : null;
}

// Warn-once guard. A process may reach this more than once (a side-effect
// import plus a direct call), and repeating the same advice makes it read like
// two distinct problems.

/**
 * Load the repository-root `.env` into `process.env`.
 *
 * Idempotent and safe to call more than once: dotenv never overrides a key that
 * is already present, so values from the real environment always win over the
 * file, and a second call changes nothing.
 *
 * A missing `.env` is a no-op, not an error — production containers inject env
 * vars and ship no `.env` file.
 */
export function loadRootDotenv(): LoadRootDotenvResult {
  const root = resolveRepoRoot();

  if (!root) {
    // No pnpm-workspace.yaml / turbo.json above this module or the cwd (a
    // fully-bundled production binary, or a wrong CWD locally): the root .env
    // is not loaded. Silent by design — this module also loads in tooling that
    // cannot resolve the logger, and env validation names every missing setting.
    return { root: null, envPath: null, loaded: false, parsed: {} };
  }

  const envPath = path.join(root, ".env");
  // quiet: dotenv would otherwise print its own banner to stdout (R3-W3).
  const result = loadEnv({ path: envPath, quiet: true });

  return {
    root,
    envPath,
    loaded: result.parsed !== undefined,
    parsed: result.parsed ?? {},
  };
}
