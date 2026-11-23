/**
 * host.sh and pre-migrate.sh are Linux-only (they run on the deployment
 * server and inside the Debian app image, with GNU find/mktemp/mountpoint).
 * Their tests run directly on Linux (CI), inside
 * a throwaway Linux container where Docker exists, and are skipped with a
 * clear message otherwise.
 *
 * Usage in a test file:
 *   const linuxTest = linuxOnlyTest(import.meta.url);
 *   linuxTest("…", () => { … });
 * On Linux `linuxTest` is node:test's `test`. Elsewhere the file registers
 * one test that re-runs the whole file in a container of the app image's
 * pinned Node base (Dockerfile), or one skipped test with the reason.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * @param {string} testFileUrl the calling test file's import.meta.url
 * @returns {boolean} true when the caller must NOT register its own tests
 */
function delegateToLinux(testFileUrl, platform = process.platform) {
  if (platform === "linux") return false;
  const file = path.relative(ROOT, fileURLToPath(testFileUrl));
  const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
  if (docker.status !== 0) {
    test(`${file}: Linux-only (host.sh / pre-migrate.sh)`, {
      skip: "SKIPPED: not Linux and Docker is unavailable; Linux CI runs these tests",
    }, () => {});
    return true;
  }
  // The app image's own pinned base: the same Debian userland the scripts get.
  const image = /^FROM (\S+)/m.exec(readFileSync(path.join(ROOT, "Dockerfile"), "utf8"))?.[1];
  if (!image) throw new Error("Dockerfile has no FROM line.");
  test(`${file}: run in a Linux container (${image.split("@")[0]})`, () => {
    const result = spawnSync(
      "docker",
      ["run", "--rm", "-v", `${ROOT}:/repo:ro`, "-w", "/repo", image, "node", "--test", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  });
  return true;
}

/**
 * @param {string} testFileUrl
 * @returns {typeof test} `test` on Linux, a no-op registrar elsewhere
 */
export function linuxOnlyTest(testFileUrl) {
  if (!delegateToLinux(testFileUrl)) return test;
  return /** @type {typeof test} */ (/** @type {unknown} */ (() => undefined));
}
