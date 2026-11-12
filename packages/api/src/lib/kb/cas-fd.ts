import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { KbAdmissionError } from "./principal";

function assertSafeName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Invalid CAS path component");
  }
}

/** Resolves a child name through a pinned directory fd; never re-walks ancestors. */
export function procChild(parentFd: number, name: string): string {
  assertSafeName(name);
  return `/proc/self/fd/${parentFd}/${name}`;
}

function openChildDir(parentFd: number, name: string): number {
  try {
    return openSync(
      procChild(parentFd, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS directory is a symlink");
    }
    throw error;
  }
}

function openExistingChild(parentFd: number, name: string): number {
  const child = procChild(parentFd, name);
  const st = lstatSync(child);
  if (st.isSymbolicLink()) {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS directory is a symlink");
  }
  if (!st.isDirectory()) {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS path is not a directory");
  }
  return openChildDir(parentFd, name);
}

function openOrCreateChild(parentFd: number, name: string, mode: number): number {
  const child = procChild(parentFd, name);
  try {
    return openExistingChild(parentFd, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    mkdirSync(child, { mode });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
  }
  return openExistingChild(parentFd, name);
}

export type CasDirChain = {
  assetsFd: number;
  objectsFd: number;
  shardFd: number;
  leafName: string;
  leafPath: string;
};

export function openCasShardDir(assetsDir: string, shard: string, leaf: string): CasDirChain {
  assertSafeName(shard);
  assertSafeName(leaf);
  const assetsAbs = resolve(assetsDir);
  let assetsFd: number;
  try {
    assetsFd = openSync(
      assetsAbs,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS assets root unavailable");
  }
  try {
    const objectsFd = openOrCreateChild(assetsFd, "objects", 0o750);
    try {
      const shardFd = openOrCreateChild(objectsFd, shard, 0o750);
      const leafPath = procChild(shardFd, leaf);
      return { assetsFd, objectsFd, shardFd, leafName: leaf, leafPath };
    } catch (error) {
      closeSync(objectsFd);
      throw error;
    }
  } catch (error) {
    closeSync(assetsFd);
    throw error;
  }
}

export function closeCasDirChain(chain: CasDirChain): void {
  closeSync(chain.shardFd);
  closeSync(chain.objectsFd);
  closeSync(chain.assetsFd);
}

export type PrivateTmpChain = {
  assetsFd: number;
  privateFd: number;
  tmpFd: number;
};

export function openPrivateTmpDir(assetsDir: string): PrivateTmpChain {
  const assetsAbs = resolve(assetsDir);
  const assetsFd = openSync(
    assetsAbs,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const privateFd = openOrCreateChild(assetsFd, ".private", 0o700);
    try {
      const tmpFd = openOrCreateChild(privateFd, "tmp", 0o700);
      return { assetsFd, privateFd, tmpFd };
    } catch (error) {
      closeSync(privateFd);
      throw error;
    }
  } catch (error) {
    closeSync(assetsFd);
    throw error;
  }
}

export function closePrivateTmpChain(chain: PrivateTmpChain): void {
  closeSync(chain.tmpFd);
  closeSync(chain.privateFd);
  closeSync(chain.assetsFd);
}

export type StagingDirChain = {
  assetsFd: number;
  privateFd: number;
  stagingFd: number;
};

export function openStagingDir(assetsDir: string): StagingDirChain {
  const assetsAbs = resolve(assetsDir);
  const assetsFd = openSync(
    assetsAbs,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const privateFd = openOrCreateChild(assetsFd, ".private", 0o700);
    try {
      const stagingFd = openOrCreateChild(privateFd, "staging", 0o700);
      return { assetsFd, privateFd, stagingFd };
    } catch (error) {
      closeSync(privateFd);
      throw error;
    }
  } catch (error) {
    closeSync(assetsFd);
    throw error;
  }
}

export function closeStagingDirChain(chain: StagingDirChain): void {
  closeSync(chain.stagingFd);
  closeSync(chain.privateFd);
  closeSync(chain.assetsFd);
}

/** Mirrors fsyncCasPublishBarriers: a file fsync alone never persists its directory entry (fsync(2)). */
export function fsyncStagingDirChain(chain: StagingDirChain): void {
  fsyncSync(chain.stagingFd);
  fsyncSync(chain.privateFd);
  fsyncSync(chain.assetsFd);
}

export function openStagedUploadFd(stagingFd: number, uploadId: string, openFlags: number): number {
  assertSafeName(uploadId);
  const child = procChild(stagingFd, uploadId);
  try {
    return openSync(child, openFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Staging path is a symlink");
    }
    throw error;
  }
}

export function unlinkStagedUploadFd(stagingFd: number, uploadId: string): void {
  assertSafeName(uploadId);
  unlinkSync(procChild(stagingFd, uploadId));
}

export function fsyncCasPublishBarriers(chain: CasDirChain, verifiedFd: number): void {
  fsyncSync(verifiedFd);
  fsyncSync(chain.shardFd);
  fsyncSync(chain.objectsFd);
  fsyncSync(chain.assetsFd);
}

/** Async counterpart for request-owned merge I/O. Same descriptor-relative,
 * no-follow boundary as openPrivateTmpDir; handles stay owned until drain. */
export async function openPrivateTmpDirAsync(
  root: string,
): Promise<PrivateTmpChain & { handles: FileHandle[] }> {
  const handles: FileHandle[] = [];
  try {
    const base = await open(
      resolve(root),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(base);
    let parent = base;
    for (const name of [".private", "tmp"]) {
      const child = procChild(parent.fd, name);
      let handle: FileHandle;
      try {
        handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        try {
          await mkdir(child, { mode: 0o700 });
        } catch (created) {
          if (!(created instanceof Error && "code" in created && created.code === "EEXIST"))
            throw created;
        }
        handle = await open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      }
      handles.push(handle);
      parent = handle;
    }
    return { assetsFd: handles[0]!.fd, privateFd: handles[1]!.fd, tmpFd: handles[2]!.fd, handles };
  } catch (error) {
    for (const handle of handles.reverse()) await handle.close();
    throw error;
  }
}
export async function closePrivateTmpChainAsync(
  chain: PrivateTmpChain & { handles: FileHandle[] },
): Promise<void> {
  for (const handle of chain.handles.toReversed()) await handle.close();
}
