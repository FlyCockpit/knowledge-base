import path from "node:path";

import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// ---------------------------------------------------------------------------
// This file is the ONE deliberate exception to "never hand-roll dotenv" — see
// AGENTS.md § Environment variables — schema + manifest, always both
//
// It cannot import `@knowledge-base/env/root-env` the way every other entrypoint does.
//
// Why: `packages/db` has a `postinstall` that runs `prisma generate`, so both
// Dockerfiles must load this config during `pnpm install --frozen-lockfile` —
// which runs BEFORE `COPY . .`. At that point the build context holds only the
// workspace `package.json` files plus `packages/db/prisma*`; no workspace
// SOURCE exists. An import of `@knowledge-base/env/root-env` there fails with
// "Cannot find module '/app/packages/env/src/root-env.ts'" and takes the whole
// image build down. Verified the hard way — do not "fix" this to match the
// other entrypoints without rebuilding both images.
//
// The fixed `../../.env` hop is safe here in a way it was not in
// packages/env/src/shared.ts: Prisma requires this file at the package root, it
// is never bundled, and it is never relocated — so the depth cannot drift.
//
// `pnpm env:check-entrypoints` knows about this exemption
// (DIRECT_DOTENV_ALLOWLIST in scripts/check-load-dotenv-contract.ts); it is an
// enforced carve-out, not an oversight.
//
// dotenv won't override an existing DATABASE_URL, so external values still win.
// ---------------------------------------------------------------------------
dotenv.config({
  path: path.resolve(import.meta.dirname, "../../.env"),
  // Prisma --script stdout is SQL consumed by deployment and CI.
  quiet: true,
});

// Shadow database for `prisma migrate diff --from-migrations` (the
// `pnpm db:migrate` generator and the consistency check). Derived, never a
// separate owner-managed env var: `<database>_shadow` next to DATABASE_URL —
// the same derivation scripts/assert-local-database.sh validates and
// `pnpm db:worktree` provisions. Prisma wipes this database on every diff, so
// the wrappers only run it after that guard accepted the exact local name.
// `migrate deploy` (production) never touches it.
function shadowDatabaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!database) return undefined;
    parsed.pathname = `/${encodeURIComponent(`${database}_shadow`)}`;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.cli.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: shadowDatabaseUrl(process.env.DATABASE_URL),
  },
});
