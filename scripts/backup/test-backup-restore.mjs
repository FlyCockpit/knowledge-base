#!/usr/bin/env node
/** Operator integration entry: delegates the full encrypted drill to host.sh.
 * Requires an existing image/deployment (for role settings), a completed bundle
 * pair and a readable age identity. It provisions an isolated Postgres AND data
 * volume; never uses the live data root as a restore target. No generic dumps.
 * Usage: node scripts/backup/test-backup-restore.mjs <bundle|latest> <identity> --project <project>
 */
import { boundedChild } from "../lib/bounded-child.mjs";

const [file, identity, flag, project, ...rest] = process.argv.slice(2);
if (!file || !identity || flag !== "--project" || !project || rest.length) {
  console.error(
    "usage: test-backup-restore.mjs <bundle|latest> <host-identity> --project <compose-project>",
  );
  process.exitCode = 2;
} else {
  const abort = new AbortController();
  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(name, () => abort.abort());
  try {
    await boundedChild(
      "bash",
      [
        new URL("./host.sh", import.meta.url).pathname,
        "drill",
        file,
        identity,
        "--project",
        project,
      ],
      { signal: abort.signal, cooperative: true },
    ).done;
  } catch {
    console.error("Full-bundle recovery drill failed.");
    process.exitCode = 1;
  }
}
