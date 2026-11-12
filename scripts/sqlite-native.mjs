/**
 * Prove the stock better-sqlite3 prebuilt binary and the sqlite-vec loadable work
 * for one workspace package (decision 21, CL-NATIVE):
 *
 *   node scripts/sqlite-native.mjs apps/server
 *
 * better-sqlite3 13+ ships its N-API prebuilts inside the npm package, so
 * install sites that run `pnpm install --ignore-scripts` (the prod-deps stages of
 * both Dockerfiles and the compose `dev-setup` service) already have the binary:
 * nothing is fetched or compiled. The build fails here, not at first index open,
 * when the platform has no packaged prebuilt or the pair does not load.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_VEC_VERSION = "v0.1.9";

const USAGE = "usage: node scripts/sqlite-native.mjs <workspace dir>";

/** @param {string[]} argv arguments after the script path */
export function parseArgs(argv) {
  if (argv.length !== 1 || argv[0].length === 0 || argv[0].startsWith("-")) {
    throw new Error(USAGE);
  }
  return { workspaceDir: argv[0] };
}

/**
 * Resolve both native packages from the workspace package (the same resolution
 * the bundled app performs at runtime, since both are `neverBundle`).
 * @param {string} workspaceDir
 */
export function resolveNativePackages(workspaceDir) {
  const manifest = join(resolve(workspaceDir), "package.json");
  if (!existsSync(manifest)) throw new Error(`${manifest} does not exist`);
  const fromWorkspace = createRequire(manifest);
  return {
    sqliteEntry: fromWorkspace.resolve("better-sqlite3"),
    vecEntry: fromWorkspace.resolve("sqlite-vec"),
  };
}

/** @param {{ sqliteEntry: string; vecEntry: string }} paths */
function defaultLoader(paths) {
  const load = createRequire(import.meta.url);
  return {
    loadDatabase: () => load(paths.sqliteEntry),
    loadVec: () => load(paths.vecEntry),
  };
}

/** Opens `:memory:`, loads sqlite-vec, checks its version and FTS5. Throws on any failure. */
function probe(loader) {
  const Database = loader.loadDatabase();
  const sqliteVec = loader.loadVec();
  const db = new Database(":memory:");
  try {
    db.loadExtension(sqliteVec.getLoadablePath());
    const version = db.prepare("SELECT vec_version() AS v").get()?.v;
    if (version !== EXPECTED_VEC_VERSION) {
      throw new Error(`vec_version() is ${String(version)}, expected ${EXPECTED_VEC_VERSION}`);
    }
    db.exec("CREATE VIRTUAL TABLE temp.t USING fts5(x)");
  } finally {
    db.close();
  }
}

export function failureMessage(reason, runtime = process) {
  return [
    `sqlite-native: ${reason}`,
    `  platform=${runtime.platform} arch=${runtime.arch} node-abi=${runtime.versions.modules}`,
  ].join("\n");
}

/**
 * @param {{
 *   workspaceDir: string;
 *   resolvePackages?: typeof resolveNativePackages;
 *   loader?: { loadDatabase: () => any; loadVec: () => any };
 *   log?: (line: string) => void;
 * }} options
 */
export function checkSqliteNative(options) {
  const paths = (options.resolvePackages ?? resolveNativePackages)(options.workspaceDir);
  const loader = options.loader ?? defaultLoader(paths);
  const log = options.log ?? ((line) => console.log(line));
  try {
    probe(loader);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(failureMessage(`native probe failed: ${reason}`));
  }
  log(`sqlite-native: better-sqlite3 + sqlite-vec ${EXPECTED_VEC_VERSION} load (fts5 ok)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkSqliteNative(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
