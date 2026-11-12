/** Test-only: a counting `git` wrapper that delegates to the git already on PATH. */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findGitOnPath } from "../git-read";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Writes `<bin>/git`, which appends its first argument (or every argument) to
 * `log` and then runs the git PATH resolved *before* the wrapper is installed
 * (never a hard-coded /usr/bin/git: in the image-git lane that is the image's
 * git, not the host's). Call it before putting `bin` on PATH.
 */
export function writeCountingGitWrapper(
  bin: string,
  log: string,
  record: "first" | "all" = "first",
): string {
  const git = findGitOnPath(process.env.PATH);
  if (git.startsWith(`${bin}/`)) throw new Error("the wrapper must not delegate to itself");
  // In the image-git lane every wrapped call must reach the image's git.
  const lane = process.env.KB_TEST_IMAGE_GIT;
  if (lane && git !== lane)
    throw new Error(`the wrapper would run ${git}, not the image-git lane's ${lane}`);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "${record === "all" ? "$*" : "$1"}" >> ${quote(log)}\nexec ${quote(git)} "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o700);
  return git;
}
