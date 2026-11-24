/** Helpers shared by the local (developer/agent) db:* wrappers. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./prisma.mjs";

export const ENV_PATH = path.join(ROOT, ".env");

/** DATABASE_URL exactly as Prisma will see it: process env first, else .env (last wins). */
export function resolveDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (!existsSync(ENV_PATH)) return undefined;
  const dotenv = createRequire(path.join(ROOT, "package.json"))("dotenv");
  return dotenv.parse(readFileSync(ENV_PATH)).DATABASE_URL || undefined;
}

/**
 * Run scripts/assert-local-database.sh for `command`; exit on refusal.
 * @returns {string} the DATABASE_URL it accepted
 */
export function assertLocal(command, { shadow = false } = {}) {
  const args = [path.join(ROOT, "scripts/assert-local-database.sh"), command];
  if (shadow) args.push("--shadow");
  const result = spawnSync("bash", args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const url = resolveDatabaseUrl();
  if (!url) {
    console.error("FATAL: DATABASE_URL is not set.");
    process.exit(1);
  }
  return url;
}

export function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** origin/<default branch>, best effort. */
export function defaultBaseRef() {
  for (const candidate of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]) {
    const result = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", candidate],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    if (result.status === 0) {
      if (candidate.endsWith("HEAD")) {
        const target = spawnSync("git", ["symbolic-ref", "--quiet", candidate], {
          cwd: ROOT,
          encoding: "utf8",
        });
        if (target.status === 0) return target.stdout.trim().replace(/^refs\/remotes\//, "");
      }
      return candidate.replace(/^refs\/remotes\//, "");
    }
  }
  return null;
}

/** Migration folder names present at `ref` (sorted). */
export function migrationFoldersAt(ref) {
  const out = git(["ls-tree", "-r", "--name-only", ref, "--", "packages/db/prisma/migrations"]);
  const names = new Set();
  for (const line of out.split("\n")) {
    const match = /^packages\/db\/prisma\/migrations\/([^/]+)\/migration\.sql$/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

/** Release tags: `git tag --list $RELEASE_TAG_PATTERN` (default `v*`). */
export function releaseTags(pattern = process.env.RELEASE_TAG_PATTERN || "v*") {
  return git(["tag", "--list", pattern]).split("\n").filter(Boolean).sort();
}

/** Every migration folder that is in at least one release tag. */
export function releasedFolders(tags = releaseTags()) {
  const out = new Set();
  for (const tag of tags) for (const name of migrationFoldersAt(tag)) out.add(name);
  return out;
}

/** The newest release tag reachable from `ref`, or null. */
export function lastReleaseTag(ref, pattern = process.env.RELEASE_TAG_PATTERN || "v*") {
  const result = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", pattern, ref], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
