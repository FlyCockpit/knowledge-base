import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenedGitEnv, runGitAsync } from "./git-read";

/**
 * The oldest git the KB code runs on. The newest requirement is the line merge
 * in pr-merge.ts: `git merge-tree --write-tree` with `-X` strategy options and a
 * tree (not a commit) as `--merge-base` and as both sides, all added in git
 * 2.45. The other version-sensitive calls are older: `rev-list
 * --no-commit-header` (2.33), `init --initial-branch` (2.28).
 * Debian 12 bookworm ships 2.39, so every shipped image uses Debian 13 trixie
 * (R3-W1).
 */
export const MIN_GIT_VERSION = [2, 45, 0] as const;
const MIN_TEXT = MIN_GIT_VERSION.join(".");

/**
 * The line-merge command. pr-merge.ts runs exactly this argv and the startup
 * probe runs it too, so a flag added here is checked at boot on every image.
 */
export function textMergeTreeArgv(base: string, ours: string, theirs: string): string[] {
  return [
    "merge-tree",
    "--write-tree",
    "-z",
    "--name-only",
    "-Xno-renames",
    `--merge-base=${base}`,
    ours,
    theirs,
  ];
}

/** `git version 2.47.3`, `git version 2.39.5 (Apple Git-154)`, `git version 2.45.0.windows.1`. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function isSupportedGitVersion(version: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const have = version[i]!;
    const need = MIN_GIT_VERSION[i]!;
    if (have !== need) return have > need;
  }
  return true;
}

export class UnsupportedGitError extends Error {
  override name = "UnsupportedGitError";
  readonly code = "UNSUPPORTED_GIT";
  /** The installed version, once known (`2.39.5`); the startup log prints it as typed detail. */
  gitVersion?: string;
  logDetail(): Record<string, string> {
    return {
      minGitVersion: MIN_TEXT,
      ...(this.gitVersion ? { gitVersion: this.gitVersion } : {}),
    };
  }
}

/** The whole probe: a stalled or chatty git fails startup instead of hanging it. */
export const GIT_PROBE_DEADLINE_MS = 15_000;
const PROBE_OUTPUT_BYTES = 64 * 1024;

function detail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Command failed: [^\n]*\n?/, "")
    .trim()
    .slice(0, 200);
}

/**
 * Refuse to start on a git the merge code cannot use. Checks the version, then
 * runs the real line-merge argv on a three-way conflict in a throwaway bare
 * repository and requires git to report it. Every child runs through
 * runGitAsync (hardened env, SIGKILL on the shared deadline, drained before
 * return, bounded output). Returns the `git --version` line.
 */
export async function assertSupportedGit(
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  let installed: string | undefined;
  const fail = (text: string) => {
    const error = new UnsupportedGitError(
      `${text}. The knowledge base needs git >= ${MIN_TEXT} (\`git merge-tree --write-tree -X... --merge-base=<tree>\`); use the shipped Debian 13 (trixie) images or upgrade git.`,
    );
    error.gitVersion = installed;
    return error;
  };
  const read = {
    signal: options.signal,
    deadlineAt: Date.now() + (options.deadlineMs ?? GIT_PROBE_DEADLINE_MS),
    maxBuffer: PROBE_OUTPUT_BYTES,
  };
  let versionLine: string;
  try {
    versionLine = (await runGitAsync(tmpdir(), ["--version"], read)).stdout.toString().trim();
  } catch (error) {
    throw fail(`git is not runnable (${detail(error)})`);
  }
  const version = parseGitVersion(versionLine);
  if (!version) throw fail(`Unrecognized \`git --version\` output "${versionLine.slice(0, 80)}"`);
  installed = version.join(".");
  if (!isSupportedGitVersion(version)) throw fail(`Installed ${versionLine} is too old`);

  const dir = await mkdtemp(join(tmpdir(), "kb-git-probe-"));
  try {
    const step = async (args: readonly string[], env?: NodeJS.ProcessEnv) => {
      try {
        return (await runGitAsync(dir, args, { ...read, env: env && hardenedGitEnv(env) })).stdout
          .toString()
          .trim();
      } catch (error) {
        throw fail(`${versionLine} failed the merge probe (git ${args[0]}: ${detail(error)})`);
      }
    };
    await step(["init", "--bare", "--quiet", "repo.git"]);
    const repo = join(dir, "repo.git");
    let n = 0;
    const tree = async (text: string) => {
      n += 1;
      const file = join(dir, `side-${n}`);
      await writeFile(file, text);
      const blob = await step(["--git-dir", repo, "hash-object", "-w", file]);
      const index = { GIT_INDEX_FILE: join(dir, `index-${n}`) };
      await step(
        ["--git-dir", repo, "update-index", "--add", "--cacheinfo", `100644,${blob},f0`],
        index,
      );
      return step(["--git-dir", repo, "write-tree"], index);
    };
    const base = await tree("a\nb\nc\n");
    const ours = await tree("A\nb\nc\n");
    const theirs = await tree("X\nb\nc\n");
    let merged: { stdout: string | Buffer; exitCode?: number };
    try {
      merged = await runGitAsync(repo, textMergeTreeArgv(base, ours, theirs), {
        ...read,
        resultExitCodes: [1],
      });
    } catch (error) {
      throw fail(`${versionLine} failed the merge probe (merge-tree: ${detail(error)})`);
    }
    const records = merged.stdout.toString().split("\0");
    // Exit 1 = conflicts: the result tree, then the conflicted path.
    if (merged.exitCode !== 1 || !/^[a-f0-9]{40}$/.test(records[0] ?? "") || records[1] !== "f0")
      throw fail(
        `${versionLine} failed the merge probe (merge-tree exit ${merged.exitCode} did not report the conflict)`,
      );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return versionLine;
}
