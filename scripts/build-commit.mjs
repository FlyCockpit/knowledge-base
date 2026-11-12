#!/usr/bin/env node
/**
 * Prints the full commit SHA an image is built from, or nothing when unknown.
 * Runs inside the Docker build (Dockerfile, builder stage); the server reports
 * the result on `/ready` so `pnpm deploy:check` can tell which release is live.
 *
 *   node scripts/build-commit.mjs [<repo-dir>]
 *
 * Sources, first match wins:
 *   1. BUILD_VERSION, when it is a full 40-hex SHA (CI and the infra workflow
 *      pass `--build-arg BUILD_VERSION=<sha>`).
 *   2. The build context's git metadata. `.dockerignore` lets only
 *      `.git/HEAD`, `.git/packed-refs` and `.git/refs/heads/` through, which
 *      is all a Dokploy clone (shallow or not) needs: HEAD is either a SHA
 *      (detached) or `ref: refs/heads/<branch>`, resolved from the loose ref
 *      file or packed-refs. No git binary needed.
 * Anything else (a worktree's `.git` file, the reftable format, a context
 * without `.git`) prints nothing; the image then reports `commit: null`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;

/** @param {string} file */
function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} repoDir
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function buildCommit(repoDir, env = process.env) {
  const fromArg = (env.BUILD_VERSION ?? "").trim().toLowerCase();
  if (SHA.test(fromArg)) return fromArg;
  const gitDir = path.join(repoDir, ".git");
  const head = read(path.join(gitDir, "HEAD"))?.trim();
  if (!head) return null;
  if (SHA.test(head)) return head;
  const ref = /^ref: (refs\/heads\/[^\s]+)$/.exec(head)?.[1];
  if (!ref || ref.split("/").includes("..")) return null;
  const loose = read(path.join(gitDir, ref))?.trim();
  if (loose && SHA.test(loose)) return loose;
  for (const line of (read(path.join(gitDir, "packed-refs")) ?? "").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commit = buildCommit(path.resolve(process.argv[2] ?? "."));
  if (commit) process.stdout.write(`${commit}\n`);
  else
    console.error(
      "[build-commit] commit unknown (no BUILD_VERSION SHA and no readable .git/HEAD); /ready will report commit: null.",
    );
}
