import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findGitOnPath } from "../git-read";
import { writeCountingGitWrapper } from "./git-wrapper";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-git-wrapper-"));
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  return dir;
};

describe("writeCountingGitWrapper", () => {
  it("delegates to the git resolved before it is installed and counts calls", () => {
    const dir = tmp();
    const git = writeCountingGitWrapper(join(dir, "bin"), join(dir, "log"));
    expect(git).toBe(findGitOnPath(process.env.PATH));
    const out = execFileSync(join(dir, "bin", "git"), ["--version"], { encoding: "utf8" });
    expect(out).toMatch(/^git version /);
    expect(readFileSync(join(dir, "log"), "utf8")).toBe("--version\n");
  });
  it("refuses to bypass the image-git lane's git", () => {
    const dir = tmp();
    vi.stubEnv("KB_TEST_IMAGE_GIT", "/lane/bin/git");
    expect(() => writeCountingGitWrapper(join(dir, "bin"), join(dir, "log"))).toThrow(
      /not the image-git lane's \/lane\/bin\/git/,
    );
  });
});
