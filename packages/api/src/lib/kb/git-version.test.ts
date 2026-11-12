import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSupportedGit,
  isSupportedGitVersion,
  parseGitVersion,
  textMergeTreeArgv,
  UnsupportedGitError,
} from "./git-version";

const dirs: string[] = [];
const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `git` on PATH that answers `--version` with `version` and delegates the rest. */
function fakeGit(version: string, rest = 'exec git "$@"'): void {
  const dir = mkdtempSync(join(tmpdir(), "kb-fake-git-"));
  dirs.push(dir);
  const real = path ?? "";
  writeFileSync(
    join(dir, "git"),
    `#!/bin/sh\nPATH='${real}'\nif [ "$1" = --version ]; then echo '${version}'; exit 0; fi\n${rest}\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
  process.env.PATH = `${dir}:${real}`;
}

describe("git version floor", () => {
  it("parses distribution version strings", () => {
    expect(parseGitVersion("git version 2.47.3\n")).toEqual([2, 47, 3]);
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual([2, 39, 5]);
    expect(parseGitVersion("git version 2.45.0.windows.1")).toEqual([2, 45, 0]);
    expect(parseGitVersion("git version 3.0")).toEqual([3, 0, 0]);
    expect(parseGitVersion("hub version 2.14")).toBeNull();
  });

  it("requires 2.45.0 or newer", () => {
    expect(isSupportedGitVersion([2, 44, 9])).toBe(false);
    expect(isSupportedGitVersion([2, 39, 5])).toBe(false);
    expect(isSupportedGitVersion([2, 45, 0])).toBe(true);
    expect(isSupportedGitVersion([2, 47, 3])).toBe(true);
    expect(isSupportedGitVersion([3, 0, 0])).toBe(true);
  });

  it("is the argv the PR line merge runs", () => {
    expect(textMergeTreeArgv("b", "o", "t")).toEqual([
      "merge-tree",
      "--write-tree",
      "-z",
      "--name-only",
      "-Xno-renames",
      "--merge-base=b",
      "o",
      "t",
    ]);
  });

  it("accepts the installed git, which must detect a real conflict", async () => {
    await expect(assertSupportedGit()).resolves.toMatch(/^git version \d+\.\d+/);
  });

  it("refuses an old git with the floor in the message", async () => {
    fakeGit("git version 2.39.5");
    const error = await assertSupportedGit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedGitError);
    expect((error as Error).message).toMatch(/2\.39\.5 is too old.*git >= 2\.45\.0/);
  });

  it("refuses a git whose merge-tree rejects the merge flags, whatever its version says", async () => {
    // Bookworm's 2.39 answer to the line-merge argv (R3-W1).
    fakeGit(
      "git version 2.99.0",
      `[ "$1" = merge-tree ] && { echo "error: unknown switch \\\`X'" >&2; exit 129; }\nexec git "$@"`,
    );
    await expect(assertSupportedGit()).rejects.toThrow(/failed the merge probe.*unknown switch/);
  });

  it("bounds a stalled git by the probe deadline", async () => {
    fakeGit("git version 2.99.0", `[ "$1" = init ] && exec sleep 30\nexec git "$@"`);
    const started = Date.now();
    await expect(assertSupportedGit({ deadlineMs: 500 })).rejects.toThrow(
      /failed the merge probe \(git init/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("bounds the probe's output", async () => {
    fakeGit(
      "git version 2.99.0",
      `[ "$1" = init ] && exec head -c 200000 /dev/zero\nexec git "$@"`,
    );
    await expect(assertSupportedGit()).rejects.toThrow(/failed the merge probe \(git init/);
  });

  it("stops when cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(assertSupportedGit({ signal: abort.signal })).rejects.toThrow(/not runnable/);
  });

  it("refuses unrecognized version output", async () => {
    fakeGit("not git");
    await expect(assertSupportedGit()).rejects.toThrow(/Unrecognized/);
  });
});
