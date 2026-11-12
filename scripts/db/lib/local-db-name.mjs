/**
 * Exact local database names for THIS checkout.
 *
 *   main checkout  (git dir == git common dir) → `knowledge_base` (or $EXPECTED_DB)
 *   linked worktree                            → `knowledge_base_wt_<10 hex>`
 *   shadow DB (either)                         → `<name>_shadow`
 *
 * The hash is the first 10 hex chars of sha256(absolute git dir), so it is
 * stable for the life of a worktree, unique per worktree, and far below
 * PostgreSQL's 63-byte identifier limit. No slug normalization → no collisions.
 *
 * Used by scripts/assert-local-database.sh (via the CLI below), the db:*
 * wrappers, and packages/db/prisma.config.ts's shadow URL derivation is kept
 * consistent with `shadowName()`.
 *
 * CLI:  node scripts/db/lib/local-db-name.mjs [main|shadow|json] [--cwd <dir>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
export const SHADOW_SUFFIX = "_shadow";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ main: string, shadow: string, worktree: boolean, gitDir: string | null }}
 */
export function localDatabaseNames(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const gitRead = options.gitRead ?? git;
  const base = env.EXPECTED_DB || "knowledge_base";
  let gitDir = null;
  let commonDir = null;
  try {
    gitDir = path.resolve(cwd, gitRead(cwd, ["rev-parse", "--git-dir"]));
    commonDir = path.resolve(cwd, gitRead(cwd, ["rev-parse", "--git-common-dir"]));
  } catch {
    // Not a git checkout (tarball, image): behave as the main checkout.
  }
  const worktree = Boolean(gitDir && commonDir && gitDir !== commonDir);
  const main = worktree ? worktreeName(gitDir) : base;
  return { main, shadow: shadowName(main), worktree, gitDir };
}

export function worktreeName(absoluteGitDir) {
  const hash = createHash("sha256").update(absoluteGitDir).digest("hex").slice(0, 10);
  return `knowledge_base_wt_${hash}`;
}

export function shadowName(name) {
  return `${name}${SHADOW_SUFFIX}`;
}

/** Replace the database name in a postgres URL (credentials untouched). */
export function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/** @returns {{ host: string, port: string, database: string }} */
export function describeUrl(url) {
  const parsed = new URL(url);
  let host = parsed.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return {
    host,
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "").split("/")[0]),
  };
}

export function isLocalHost(host) {
  return LOCAL_HOSTS.includes(host);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cwdIndex = args.indexOf("--cwd");
  const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
  const what =
    args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--cwd") ?? "main";
  const names = localDatabaseNames({ cwd });
  if (what === "json") process.stdout.write(`${JSON.stringify(names)}\n`);
  else if (what === "shadow") process.stdout.write(`${names.shadow}\n`);
  else if (what === "main") process.stdout.write(`${names.main}\n`);
  else {
    process.stderr.write("usage: local-db-name.mjs [main|shadow|json] [--cwd <dir>]\n");
    process.exit(2);
  }
}
