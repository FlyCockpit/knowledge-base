/** Create the KB data-volume skeleton without following symlinks. */
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statfsSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_RDONLY, O_RDWR } = constants;

export const DEFAULT_KB_DATA_ROOT = "/var/lib/knowledge-base";

/** Subdirectory names under KB_DATA_ROOT. `packages/env/src/topology.ts` mirrors this. */
export const KB_DATA_LAYOUT = Object.freeze({
  repos: "repos",
  assets: "assets",
  models: "models",
  index: "index",
});

/** @param {string} root */
export function kbDataPaths(root) {
  const abs = resolve(root);
  return {
    reposDir: join(abs, KB_DATA_LAYOUT.repos),
    assetsDir: join(abs, KB_DATA_LAYOUT.assets),
    modelsDir: join(abs, KB_DATA_LAYOUT.models),
    indexDir: join(abs, KB_DATA_LAYOUT.index),
  };
}

/**
 * The complete skeleton: directories (in creation order) and empty fence
 * files, relative to KB_DATA_ROOT. Nothing else is skeleton.
 */
const SKELETON_DIRS = [
  "repos",
  "repos/.private",
  "repos/.private/tmp",
  "assets",
  "assets/.private",
  "assets/.private/staging",
  "assets/.private/tmp",
  "models",
  "models/.private",
  "models/.private/tmp",
  "index",
];
const SKELETON_FILES = ["repos/.private/server.fence", "repos/.private/worker.fence"];

function parseId(raw, name, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65534) {
    throw new Error(`${name} must be a nonroot UID/GID in 1..65534.`);
  }
  return value;
}

function dataRoot(raw) {
  const value = raw || DEFAULT_KB_DATA_ROOT;
  if (!isAbsolute(value)) throw new Error("KB_DATA_ROOT must be an absolute path.");
  return resolve(value);
}

function splitAbs(absPath) {
  const abs = resolve(absPath);
  if (abs === "/") throw new Error("KB data root cannot be /.");
  return abs.slice(1).split("/");
}

function assertSafeName(name) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error(`Invalid path component: ${JSON.stringify(name)}`);
  }
}

/** Linux openat/mkdirat via the already-opened parent descriptor. */
function procChild(parentFd, name) {
  assertSafeName(name);
  return `/proc/self/fd/${parentFd}/${name}`;
}

function openChildDir(parentFd, name) {
  return openSync(procChild(parentFd, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

function lstatChild(parentFd, name) {
  return lstatSync(procChild(parentFd, name));
}

function refuseSymlink(absPath) {
  throw new Error(`Refusing to initialize through symlink: ${absPath}`);
}

function openExistingChild(parentFd, name, absPath, st) {
  if (st.isSymbolicLink()) refuseSymlink(absPath);
  if (!st.isDirectory()) throw new Error(`Not a directory: ${absPath}`);
  try {
    return openChildDir(parentFd, name);
  } catch (error) {
    // O_DIRECTORY|O_NOFOLLOW on a symlink is ELOOP or ENOTDIR depending on kernel.
    if (error.code === "ELOOP" || error.code === "ENOTDIR") refuseSymlink(absPath);
    throw error;
  }
}

function openOrCreateChild(parentFd, name, absPath) {
  try {
    return openExistingChild(parentFd, name, absPath, lstatChild(parentFd, name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    mkdirSync(procChild(parentFd, name), { mode: 0o750 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return openExistingChild(parentFd, name, absPath, lstatChild(parentFd, name));
}

function ensureFile(parentAbs, name, uid, gid) {
  assertSafeName(name);
  const parentFd = openSync(parentAbs, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    const child = procChild(parentFd, name);
    let st;
    try {
      st = lstatSync(child);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (st) {
      if (st.isSymbolicLink()) refuseSymlink(`${parentAbs}/${name}`);
      if (!st.isFile()) throw new Error(`Not a regular file: ${parentAbs}/${name}`);
    }
    const fd = openSync(child, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600);
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile()) throw new Error(`Not a regular file: ${parentAbs}/${name}`);
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        fchownSync(fd, uid, gid);
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    closeSync(parentFd);
  }
}

function ensurePath(absPath, uid, gid) {
  const parts = splitAbs(absPath);
  let fd = openSync("/", O_RDONLY | O_DIRECTORY);
  try {
    for (const part of parts) {
      const child = openOrCreateChild(fd, part, absPath);
      closeSync(fd);
      fd = child;
    }
    const fst = fstatSync(fd);
    if (!fst.isDirectory()) throw new Error(`Not a directory: ${absPath}`);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      fchownSync(fd, uid, gid);
    }
    // Existing volumes may have lost owner access. Provision the same owner
    // read/search/write permission as a newly-created root before its children.
    fchmodSync(fd, (fst.mode & 0o7777) | 0o700);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create (or repair) the data-volume skeleton under `root`. Idempotent; refuses
 * symlinks anywhere on the path; never removes or rewrites existing content.
 * @param {string} root
 * @param {number} [uid]
 * @param {number} [gid]
 */
export function ensureKbDataSkeleton(root, uid = 1000, gid = 1000) {
  const abs = dataRoot(root);
  ensurePath(abs, uid, gid);
  for (const rel of SKELETON_DIRS) ensurePath(`${abs}/${rel}`, uid, gid);
  for (const rel of SKELETON_FILES) {
    const slash = rel.lastIndexOf("/");
    ensureFile(`${abs}/${rel.slice(0, slash)}`, rel.slice(slash + 1), uid, gid);
  }
  return abs;
}

/**
 * True when `root` holds nothing beyond (a subset of) the skeleton: the
 * skeleton directories, each empty apart from its skeleton children, and the
 * two fence files. A missing root is empty. Symlinks are never skeleton.
 * @param {string} root
 */
export function isSkeletonOnly(root) {
  const abs = dataRoot(root);
  const dirs = new Set(SKELETON_DIRS);
  const files = new Set(SKELETON_FILES);
  const walk = (rel) => {
    let names;
    try {
      names = readdirSync(rel ? `${abs}/${rel}` : abs);
    } catch (error) {
      if (error.code === "ENOENT" && !rel) return true;
      throw error;
    }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      const st = lstatSync(`${abs}/${child}`);
      if (st.isDirectory() && dirs.has(child)) {
        if (!walk(child)) return false;
      } else if (!(st.isFile() && files.has(child))) {
        return false;
      }
    }
    return true;
  };
  return walk("");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function initKbVolumes(env = process.env) {
  const uid = parseId(env.KB_RUNTIME_UID, "KB_RUNTIME_UID", 1000);
  const gid = parseId(env.KB_RUNTIME_GID, "KB_RUNTIME_GID", 1000);
  const root = ensureKbDataSkeleton(dataRoot(env.KB_DATA_ROOT), uid, gid);
  return { root, ...kbDataPaths(root), uid, gid };
}

/**
 * The data-volume part of runtime admission (both roles): exactly one mount
 * entry at KB_DATA_ROOT, read-write, a local disk filesystem, root owned by
 * UID/GID 1000 and R|W|X, no symlink, and no mount point strictly below it.
 * Only the mount root is inspected: entrypoint step 3 repairs the skeleton
 * after this check runs. Throws without diagnostics.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function checkDataVolume(env = process.env) {
  const mounts = readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split(" - ");
      const fields = left.split(" ");
      return { path: fields[4], modes: fields[5]?.split(",") ?? [], type: right?.split(" ")[0] };
    });
  const root = dataRoot(env.KB_DATA_ROOT);
  const st = lstatSync(root);
  const at = mounts.filter((m) => m.path === root);
  const below = mounts.some((m) => m.path?.startsWith(`${root}/`));
  if (
    !st.isDirectory() ||
    st.uid !== 1000 ||
    st.gid !== 1000 ||
    realpathSync(root) !== root ||
    at.length !== 1 ||
    below ||
    !["ext4", "xfs", "btrfs", "zfs"].includes(at[0].type) ||
    !at[0].modes.includes("rw")
  )
    throw new Error("KB data volume invalid");
  accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** Verify migration and backup entry artifacts without database/network IO. */
export function checkMigrationArtifacts(
  root,
  artifact = (path) => {
    if (!lstatSync(path).isFile()) throw new Error("Missing migration artifact");
    accessSync(path, constants.R_OK);
  },
) {
  const migrations = join(root, "packages/db/prisma/migrations");
  artifact(join(migrations, "migration_lock.toml"));
  artifact(join(migrations, "0_init/migration.sql"));
  const folders = readdirSync(migrations, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  for (const folder of folders) artifact(join(migrations, folder.name, "migration.sql"));
  for (const relative of [
    "scripts/db/migrate-runtime.mjs",
    "scripts/db/lib/prisma-owner.mjs",
    "scripts/lib/bounded-child.mjs",
    "scripts/backup/pre-migrate.sh",
    "scripts/backup/schedule.mjs",
    "scripts/backup/restore.sh",
    "scripts/backup/drill.mjs",
    "packages/db/node_modules/prisma/build/index.js",
  ])
    artifact(join(root, relative));
}

/** Packaged runtime admission. No repair, disk fallback, or secret diagnostics. */
export function checkRuntimeDeployment(role, env = process.env) {
  try {
    if (role !== "server" && role !== "worker") throw new Error();
    const executable = (path) => {
      if (!statSync(path).isFile()) throw new Error();
      accessSync(path, constants.X_OK);
    };
    executable("/usr/local/bin/kb-supervisor");
    executable("/usr/bin/git");
    const artifact = (path) => {
      if (!lstatSync(path).isFile()) throw new Error();
      accessSync(path, constants.R_OK);
    };
    artifact(`/app/apps/${role}/dist/index.mjs`);
    artifact("/app/scripts/init-kb-volumes.mjs");
    executable("/usr/local/bin/kb-child-guard");
    checkMigrationArtifacts("/app", artifact);
    // Index files (P4): the stock better-sqlite3 binary (its packaged glibc
    // prebuilt) and the sqlite-vec loadable resolve from the role's own package;
    // the server also needs its reader thread entry.
    const roleRequire = createRequire(`/app/apps/${role}/package.json`);
    artifact(
      join(
        dirname(roleRequire.resolve("better-sqlite3/package.json")),
        `prebuilds/linux-${process.arch}.node`,
      ),
    );
    const { getLoadablePath } = roleRequire("sqlite-vec");
    artifact(getLoadablePath());
    if (role === "server") {
      artifact("/app/apps/server/dist/kb-index-reader.mjs");
      executable("/usr/lib/git-core/git-http-backend");
      executable("/app/apps/server/dist/git-pre-receive.mjs");
      if (
        realpathSync("/app/apps/server/dist/hooks/pre-receive") !==
        "/app/apps/server/dist/git-pre-receive.mjs"
      )
        throw new Error();
    } else {
      executable("/usr/bin/ssh");
      executable("/usr/local/bin/kb-child-guard");
      artifact("/app/apps/worker/dist/qwen-child.mjs");
      artifact("/app/apps/worker/dist/ssh-wrapper.mjs");
      const mirror = lstatSync("/run/kb-mirror");
      if (
        !mirror.isDirectory() ||
        mirror.uid !== 1000 ||
        mirror.gid !== 1000 ||
        (mirror.mode & 0o777) !== 0o700 ||
        statfsSync("/run/kb-mirror").type !== 0x01021994
      )
        throw new Error();
    }
    checkDataVolume(env);
  } catch {
    throw new Error("FATAL: KB runtime deployment invalid");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const check = process.argv.indexOf("--check-runtime");
    if (check !== -1) {
      checkRuntimeDeployment(process.argv[check + 1]);
      process.exit(0);
    }
    const result = initKbVolumes(process.env);
    console.log(`[kb-volumes] initialized root=${result.root} uid=${result.uid} gid=${result.gid}`);
  } catch (error) {
    console.error(`[kb-volumes] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
