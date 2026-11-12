import { readFileSync } from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{40}$/;

/**
 * The commit this server was built from, reported on `/ready` so an outside
 * check (`pnpm deploy:check`) can tell which release is serving. The image
 * build writes it next to the bundle (`apps/server/dist/BUILD_COMMIT`,
 * scripts/build-commit.mjs); dev servers and images built without git
 * metadata report `null`. Read once at boot.
 */
export function readBuildCommit(entry: string | undefined = process.argv[1]): string | null {
  if (!entry) return null;
  try {
    const value = readFileSync(path.join(path.dirname(entry), "BUILD_COMMIT"), "utf8")
      .trim()
      .toLowerCase();
    return SHA.test(value) ? value : null;
  } catch {
    return null;
  }
}
