import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type KbGitRepo = {
  root: string;
  env: NodeJS.ProcessEnv;
  git(...args: string[]): string;
  close(): void;
};

export function createTempGitRepo(options?: { bare?: boolean }): KbGitRepo {
  const root = mkdtempSync(join(tmpdir(), "kb-test-git-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "kb-test",
    GIT_AUTHOR_EMAIL: "kb-test@example.invalid",
    GIT_COMMITTER_NAME: "kb-test",
    GIT_COMMITTER_EMAIL: "kb-test@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", ...(options?.bare ? ["--bare"] : []), "--initial-branch=main", ".");
  return {
    root,
    env,
    git,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
