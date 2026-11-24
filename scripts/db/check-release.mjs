#!/usr/bin/env node
/**
 * `pnpm db:check-release <last-tag>` — the release PR's migration check,
 * see docs/schema-migrations.md § Releases
 * Needs CHECK_DATABASE_URL, like
 * `pnpm db:check-migrations`, whose checks it runs with the base set to the
 * last release tag:
 *
 *   Guard A (equivalence)   check 1: the head's migrations reproduce the
 *                           Prisma schema from empty (A) and from <last-tag>
 *                           (B); check 6: the release migration is the
 *                           replaced SQL verbatim, and a database built from
 *                           EVERY prefix of the replaced chain (with and
 *                           without its scheduled deletions run), reconciled
 *                           by the runner's code, ends with the fresh
 *                           database's exact schema.
 *   Guard B (upgrade test)  check 4: <last-tag>'s migrations with its fixture
 *                           data, then this release: every row survives and
 *                           every fixtures/*.check.sql returns no rows.
 *   Immutability            check 3 against the tag: nothing released changed.
 *
 *   pnpm db:check-release --auto --base <ref>
 *     CI: a no-op unless the change adds a release folder (one with
 *     replaces.json) compared with <ref>; then the last release tag
 *     reachable from <ref> is the base.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lastReleaseTag, migrationFoldersAt } from "./lib/local.mjs";
import { MIGRATIONS_DIR } from "./lib/prisma.mjs";
import { readReleases } from "./lib/replaces.mjs";

const USAGE =
  "usage: pnpm db:check-release <last-tag>   |   pnpm db:check-release --auto --base <ref>   (needs CHECK_DATABASE_URL)";

function main() {
  const args = process.argv.slice(2);
  let tag = args.find((a) => !a.startsWith("--"));
  if (args.includes("--auto")) {
    const i = args.indexOf("--base");
    const base = i >= 0 ? args[i + 1] : undefined;
    if (!base) {
      console.error(USAGE);
      process.exit(2);
    }
    const onBase = new Set(migrationFoldersAt(base));
    const added = readReleases(MIGRATIONS_DIR).releases.filter((r) => !onBase.has(r.name));
    if (!added.length) {
      console.log(`Not a release PR (no release migration added since ${base}); nothing to check.`);
      return 0;
    }
    tag = lastReleaseTag(base);
    if (!tag) {
      console.error(
        `FATAL: ${added.map((r) => r.name).join(", ")} is a release migration, but no release tag is reachable from ${base}. ` +
          "A release squash replaces what was added since the last release tag.",
      );
      return 1;
    }
    console.log(`Release PR: checking ${added.map((r) => r.name).join(", ")} against ${tag}.`);
  }
  if (!tag) {
    console.error(USAGE);
    return 2;
  }
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-migrations.mjs");
  const result = spawnSync(process.execPath, [script, "--base", tag, "--require-release"], {
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

process.exitCode = main();
