import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Debian `git` package ships the CGI at this path (`dpkg -L git`). */
export const GIT_HTTP_BACKEND_PATH = "/usr/lib/git-core/git-http-backend";

export const KB_VOLUME_ROOT = "/var/lib/knowledge-base";
export const KB_RUNTIME_UID = 1000;
export const KB_RUNTIME_GID = 1000;

const REMOTE_FS = new Set([
  "nfs",
  "nfs4",
  "nfs3",
  "cifs",
  "smb",
  "smb2",
  "smb3",
  "fuse.sshfs",
  "fuse.glusterfs",
  "glusterfs",
  "ceph",
  "cephfs",
  "lustre",
  "ocfs2",
  "gfs2",
  "afs",
  "coda",
  "fuse.rclone",
  "fuse.s3fs",
  "fuse.s3ql",
  "fuse.davfs",
]);

/**
 * Subdirectory names under `KB_DATA_ROOT`. Mirrors `KB_DATA_LAYOUT` in
 * `scripts/init-kb-volumes.mjs` (this module is bundled and cannot import
 * that script); `topology.test.ts` asserts both stay equal.
 */
export const KB_DATA_LAYOUT = {
  repos: "repos",
  assets: "assets",
  models: "models",
  index: "index",
} as const;

export type KbDataPaths = {
  reposDir: string;
  assetsDir: string;
  modelsDir: string;
  indexDir: string;
};

/** Derive every KB storage directory from the one data root. */
export function kbDataPaths(root: string): KbDataPaths {
  const abs = resolve(root);
  return {
    reposDir: join(abs, KB_DATA_LAYOUT.repos),
    assetsDir: join(abs, KB_DATA_LAYOUT.assets),
    modelsDir: join(abs, KB_DATA_LAYOUT.models),
    indexDir: join(abs, KB_DATA_LAYOUT.index),
  };
}

export function privateDir(volumeRoot: string, ...segments: string[]): string {
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Private volume segments must be plain directory names.");
  }
  if (segments.some((segment) => segment.includes("/") || segment.includes("\\"))) {
    throw new Error("Private volume segments cannot contain path separators.");
  }
  return join(volumeRoot, ".private", ...segments);
}

export function stagingRoot(assetsDir: string): string {
  return privateDir(assetsDir, "staging");
}

export function tempRoot(volumeRoot: string): string {
  return privateDir(volumeRoot, "tmp");
}

export function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(prefix)) {
    throw new Error(`Path ${candidate} escapes volume root ${root}.`);
  }
  return resolvedCandidate;
}

type Mount = { mountPoint: string; fsType: string };

export function parseMountinfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const left = line.slice(0, separator).split(" ");
    const right = line.slice(separator + 3).split(" ");
    const mountPoint = unescapeMountField(left[4] ?? "");
    const fsType = right[0] ?? "";
    if (mountPoint && fsType) mounts.push({ mountPoint, fsType });
  }
  return mounts;
}

function unescapeMountField(value: string): string {
  return value
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n")
    .replace(/\\134/g, "\\");
}

export function filesystemTypeFor(path: string, mounts: Mount[]): string {
  const abs = resolve(path);
  let best: Mount | undefined;
  for (const mount of mounts) {
    const prefix = mount.mountPoint.endsWith("/") ? mount.mountPoint : `${mount.mountPoint}/`;
    if (abs === mount.mountPoint || abs.startsWith(prefix)) {
      if (!best || mount.mountPoint.length > best.mountPoint.length) best = mount;
    }
  }
  if (!best) throw new Error(`No mount covers ${abs}; refusing unknown storage.`);
  return best.fsType;
}

function existingAncestor(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`No existing ancestor for ${path}.`);
      current = parent;
    }
  }
}

/** Refuse every existing path component that is a symlink, including parents. */
function assertNoSymlinkComponents(path: string, label = path): void {
  const abs = resolve(path);
  const parts = abs === sep ? [] : abs.slice(1).split(sep);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    let st: Stats;
    try {
      st = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink (${current} -> ${realpathSync(current)}).`);
    }
  }
}

export function assertLocalFilesystem(
  path: string,
  options?: { mountinfo?: string; label?: string },
): string {
  if (!isAbsolute(path)) {
    throw new Error(`${options?.label ?? path} must be an absolute local path.`);
  }
  const label = options?.label ?? path;
  assertNoSymlinkComponents(path, label);
  const mountinfo = options?.mountinfo ?? readFileSync("/proc/self/mountinfo", "utf8");
  const probe = options?.mountinfo ? resolve(path) : existingAncestor(path);
  const fsType = filesystemTypeFor(probe, parseMountinfo(mountinfo));
  const kind = fsType.toLowerCase();
  if (
    REMOTE_FS.has(kind) ||
    kind.startsWith("nfs") ||
    kind.startsWith("smb") ||
    kind.startsWith("cifs")
  ) {
    throw new Error(
      `${options?.label ?? path} is on network filesystem ${fsType}; knowledge-base storage must be a local disk on one host.`,
    );
  }
  return fsType;
}

/** The data root must be an absolute path on a local (non-network) filesystem. */
export function assertLocalKbDataRoot(root: string, options?: { mountinfo?: string }): void {
  assertLocalFilesystem(root, { mountinfo: options?.mountinfo, label: "KB_DATA_ROOT" });
}
