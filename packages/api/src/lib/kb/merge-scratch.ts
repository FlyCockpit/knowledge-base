import { randomUUID } from "node:crypto";
import { mkdir, opendir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { closePrivateTmpChainAsync, openPrivateTmpDirAsync, procChild } from "./cas-fd";
import { assertGitReadActive, type GitReadOptions } from "./git-read";
import { KB_TREE_LIMITS } from "./limits";
import { assertDiskFloor, statfsDiskMeter } from "./quota";

// A generated attempt name is the durable inventory/charge identity, even if
// the process dies before a publication journal exists. Never use OS temp.
const NAME = /^merge-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const live = new Map<string, Set<string>>();
// Two input trees plus intermediate merge objects and loose-object overhead.
export const MERGE_SCRATCH_BYTES = BigInt(KB_TREE_LIMITS.maxUncompressedObjectBytes * 4);
export type ScratchAdmission = (opId: string, bytes: bigint) => Promise<() => Promise<void>>;

/** The caller holds authority -> KB. Register before async admission/creation;
 * retain ownership until native children and all I/O have drained and cleanup
 * finishes. The server's lifetime volume fence drains predecessor descendants. */
export async function createMergeScratch(
  root: string,
  options: GitReadOptions,
  admit?: ScratchAdmission,
) {
  const key = resolve(root);
  const name = `merge-${randomUUID()}`;
  let names = live.get(key);
  if (!names) {
    names = new Set();
    live.set(key, names);
  }
  names.add(name);
  let chain: Awaited<ReturnType<typeof openPrivateTmpDirAsync>>;
  try {
    chain = await openPrivateTmpDirAsync(root);
  } catch (error) {
    names.delete(name);
    if (!names.size) live.delete(key);
    throw error;
  }
  const path = procChild(chain.tmpFd, name);
  let release: (() => Promise<void>) | undefined;
  let created = false;
  const dispose = async () => {
    try {
      if (created) await rm(path, { recursive: true, force: true });
      await release?.();
    } finally {
      names.delete(name);
      if (!names.size) live.delete(key);
      await closePrivateTmpChainAsync(chain);
    }
  };
  try {
    assertGitReadActive(options);
    // Inventory precedes the recoverable effect; startup can find any later
    // objects even if reservation, merge-tree, or cleanup is interrupted.
    await mkdir(path, { mode: 0o700 });
    created = true;
    release = admit ? await admit(name, MERGE_SCRATCH_BYTES) : undefined;
    if (!admit) await assertDiskFloor(statfsDiskMeter(root), MERGE_SCRATCH_BYTES);
    assertGitReadActive(options);
    // Persist the generated inventory identity before any recoverable object
    // work. New private/tmp directory entries need every parent barrier too.
    for (const handle of chain.handles.toReversed()) {
      await handle.sync();
      assertGitReadActive(options);
    }
    // Git's /proc/self points at Git, so refer to the owning server's pinned fd.
    return { path: path.replace("/proc/self/", `/proc/${process.pid}/`), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Startup and periodic recovery share this inventory. The fence proves former
 * processes/children drained; the registry excludes every live current attempt.
 * Never follow a planted directory symlink or inspect arbitrary temp names. */
export async function sweepMergeScratch(
  root: string,
  assertFence: () => void,
  release: (opId: string) => Promise<void> = async () => {},
) {
  assertFence();
  const chain = await openPrivateTmpDirAsync(root);
  try {
    const entries = await opendir(`/proc/self/fd/${chain.tmpFd}`);
    for await (const entry of entries) {
      if (!NAME.test(entry.name) || live.get(resolve(root))?.has(entry.name)) continue;
      assertFence();
      await rm(procChild(chain.tmpFd, entry.name), { recursive: true, force: true });
      assertFence();
      await release(entry.name);
    }
  } finally {
    await closePrivateTmpChainAsync(chain);
  }
}
