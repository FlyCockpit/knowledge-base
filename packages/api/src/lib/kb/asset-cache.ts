import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  opendirSync,
  openSync,
  read,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { setImmediate } from "node:timers/promises";
import { forEachPage } from "../pagination";
import { type AssetStorageLifecycle, createAssetCacheTouch } from "./asset-storage-lifecycle";
import {
  type AssetCacheBinding,
  type AssetCacheTransactions,
  type CacheEntry,
  type CacheFingerprint,
  type CachePin,
  cacheUnavailable,
  createAssetStorageState,
} from "./asset-storage-state";
import { BLOB_FRAME_BYTES, type BlobReader } from "./blob-store";
import { parseCasHash } from "./cas";
import {
  closeCasDirChain,
  closePrivateTmpChain,
  fsyncCasPublishBarriers,
  openCasShardDir,
  openPrivateTmpDir,
  procChild,
} from "./cas-fd";
import { type DiskMeter, diskVolumeIdentity } from "./quota";

function fingerprint(st: BigIntStats): CacheFingerprint {
  if (!st.isFile()) throw cacheUnavailable();
  return {
    device: st.dev.toString(),
    inode: st.ino.toString(),
    mtimeNs: st.mtimeNs.toString(),
    ctimeNs: st.ctimeNs.toString(),
  };
}
function sameInode(e: CacheEntry, st: BigIntStats) {
  if (!st.isFile() || e.device !== st.dev.toString() || e.inode !== st.ino.toString())
    throw cacheUnavailable();
}
function unchanged(e: CacheEntry, st: BigIntStats) {
  sameInode(e, st);
  if (
    st.size !== BigInt(e.size) ||
    st.mtimeNs.toString() !== e.mtimeNs ||
    st.ctimeNs.toString() !== e.ctimeNs
  )
    throw cacheUnavailable();
}
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function statAlias(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
function syncTmp(chain: ReturnType<typeof openPrivateTmpDir>) {
  fsyncSync(chain.tmpFd);
  fsyncSync(chain.privateFd);
  fsyncSync(chain.assetsFd);
}
function checkRoot(binding: AssetCacheBinding, fd: number) {
  const s = fstatSync(fd, { bigint: true });
  if (binding.cacheId !== `${binding.volumeId}:${s.dev}:${s.ino}`) throw cacheUnavailable();
}

function directoryIdentity(...fds: number[]): string {
  return fds
    .map((fd) => {
      const s = fstatSync(fd, { bigint: true });
      return `${s.dev}:${s.ino}`;
    })
    .join("/");
}
function verifyFd(fd: number, entry: CacheEntry): CacheFingerprint {
  const before = fstatSync(fd, { bigint: true });
  sameInode(entry, before);
  if (before.size !== BigInt(entry.size)) throw cacheUnavailable();
  const buf = Buffer.alloc(Math.min(BLOB_FRAME_BYTES, entry.size));
  const digest = createHash("sha256");
  for (let offset = 0; offset < entry.size; ) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, entry.size - offset), offset);
    if (!n) throw cacheUnavailable();
    digest.update(buf.subarray(0, n));
    offset += n;
  }
  const after = fstatSync(fd, { bigint: true });
  sameInode(entry, after);
  if (
    `sha256:${digest.digest("hex")}` !== entry.hash ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw cacheUnavailable();
  return fingerprint(after);
}

export async function assetCacheBinding(input: {
  assetsDir: string;
  storageGeneration: string;
  configuration: string;
  limit: bigint;
}): Promise<AssetCacheBinding> {
  const chain = openPrivateTmpDir(input.assetsDir);
  try {
    const st = fstatSync(chain.assetsFd, { bigint: true });
    const volumeId = await diskVolumeIdentity(`/proc/${process.pid}/fd/${chain.assetsFd}`);
    return {
      cacheId: `${volumeId}:${st.dev}:${st.ino}`,
      volumeId,
      storageGeneration: input.storageGeneration,
      configuration: input.configuration,
      limit: input.limit,
    };
  } finally {
    closePrivateTmpChain(chain);
  }
}

/** The only cache payload writer/remover. Constructing it does no IO, mode
 * inference, recovery or owner registration. P3/P4 supply remote byte policies.
 */
export function createAssetCache(input: {
  assetsDir: string;
  binding: AssetCacheBinding;
  transactions: AssetCacheTransactions;
  lifecycle: AssetStorageLifecycle;
  meter: DiskMeter;
  /** Deterministic integration crash/fault barriers, outside SQL transactions. */
  barrier?: (name: string) => Promise<void>;
}) {
  const { assetsDir, binding, lifecycle } = input;
  const state = createAssetStorageState(input);
  const barrier = async (name: string) => {
    await input.barrier?.(name);
  };
  const budget = () => Date.now() + 5000;
  let repairTask: Promise<void> | undefined;
  let repairRequested = false;
  const invalidations = new Map<string, Set<AbortController>>();
  const cancelReaders = (entry: CacheEntry) => {
    for (const c of invalidations.get(entry.incarnation) ?? []) c.abort(cacheUnavailable());
  };
  const invalidate = async (entry: CacheEntry) => {
    await state.invalidate(entry, budget());
    cancelReaders(entry);
  };
  const cleanup = async (entry: CacheEntry, deadline: number) => {
    // This conditional cleanup owner is held until all synchronous IO drains.
    let payloadClosed = true;
    try {
      const tmp = openPrivateTmpDir(assetsDir);
      try {
        checkRoot(binding, tmp.assetsFd);
        const hex = parseCasHash(entry.hash);
        const final = openCasShardDir(assetsDir, hex.slice(0, 2), hex.slice(2));
        try {
          checkRoot(binding, final.assetsFd);
          if (entry.tempName !== `cache-${entry.incarnation}`) throw cacheUnavailable();
          if (
            entry.tempDirectory &&
            entry.tempDirectory !== directoryIdentity(tmp.assetsFd, tmp.privateFd, tmp.tmpFd)
          )
            throw cacheUnavailable();
          if (
            entry.finalAlias &&
            entry.finalDirectory !==
              directoryIdentity(final.assetsFd, final.objectsFd, final.shardFd)
          )
            throw cacheUnavailable();
          const aliases = [
            procChild(tmp.tmpFd, entry.tempName),
            ...(entry.finalAlias ? [final.leafPath] : []),
          ];
          const present = aliases
            .map((path) => ({ path, st: statAlias(path) }))
            .filter((a): a is { path: string; st: BigIntStats } => a.st !== undefined);
          for (const a of present) {
            sameInode(entry, a.st);
            // An untracked hardlink could retain payload after credit. Require offline recovery.
            if (a.st.nlink !== BigInt(present.length)) throw cacheUnavailable();
          }
          let removedFd: number | undefined;
          try {
            if (present[0]) {
              removedFd = openSync(
                present[0].path,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              );
              payloadClosed = false;
              sameInode(entry, fstatSync(removedFd, { bigint: true }));
            }
            await barrier("cleanup-before-unlink");
            for (const a of present) {
              const now = statAlias(a.path);
              if (!now) continue;
              sameInode(entry, now);
              unlinkSync(a.path);
            }
            await barrier("cleanup-after-unlink");
            if (removedFd !== undefined && fstatSync(removedFd, { bigint: true }).nlink !== 0n)
              throw cacheUnavailable();
          } finally {
            if (removedFd !== undefined) {
              try {
                closeSync(removedFd);
                payloadClosed = true;
              } catch {
                lifecycle.failOwnership();
              }
            }
          }
          if (!payloadClosed) throw cacheUnavailable();
          // ENOENT is not proof of a durable unlink. Always repeat ALL barriers.
          syncTmp(tmp);
          fsyncSync(final.shardFd);
          fsyncSync(final.objectsFd);
          fsyncSync(final.assetsFd);
          await barrier("cleanup-after-fsync");
        } finally {
          closeCasDirChain(final);
        }
      } finally {
        closePrivateTmpChain(tmp);
      }
      await state.finishCleanup(entry, deadline);
      await barrier("cleanup-after-credit");
    } finally {
      // If credit committed but its ACK was lost, this is an exact-attempt no-op.
      // If it failed, retain EVICTING/charge and let ordinary recovery retry.
      if (payloadClosed) {
        await state.relinquishCleanup(entry, budget());
      }
    }
  };
  const repair = async (deadline: number, hash?: string, evictReady = false) => {
    const e = await state.claimCleanup(deadline, hash, evictReady);
    if (!e) return false;
    await cleanup(e, deadline);
    return true;
  };
  const runSweep = async () => {
    await state.relinquishDrainedCleanups();
    await forEachPage(
      async ({ afterId }) =>
        (await state.repairPage(afterId ?? "", budget())).map((hash) => ({ id: hash })),
      100,
      async (rows) => {
        for (const { id: hash } of rows) {
          lifecycle.signal.throwIfAborted();
          try {
            await repair(budget(), hash);
          } catch {
            /* charge and retry eligibility retained */
          }
        }
      },
    );
  };
  // Request-triggered and periodic recovery join the same in-flight work.
  // Returning while a sibling sweep still owns removal would hide incomplete cleanup.
  const sweep = (): Promise<void> => {
    if (repairTask) {
      repairRequested = true;
      return repairTask;
    }
    const task = (async () => {
      do {
        repairRequested = false;
        await runSweep();
      } while (repairRequested && !lifecycle.signal.aborted);
    })();
    repairTask = task;
    void task
      .finally(() => {
        if (repairTask === task) repairTask = undefined;
      })
      .catch(() => {});
    return task;
  };
  const scheduleRepair = () => {
    if (lifecycle.signal.aborted) return;
    if (repairTask) {
      repairRequested = true;
      return;
    }
    try {
      void lifecycle.track(sweep).catch(() => {});
    } catch {
      /* durable recovery retains ownership */
    }
  };
  lifecycle.registerRecovery(sweep);

  const reconcile = async (assertRoleFence: () => void, deadline?: number) => {
    const nextDeadline = () => deadline ?? budget();
    const check = () => {
      lifecycle.signal.throwIfAborted();
      assertRoleFence();
      if (deadline !== undefined && Date.now() >= deadline) throw cacheUnavailable();
    };
    check();
    await state.checkAccounting(nextDeadline());
    const tmp = openPrivateTmpDir(assetsDir);
    const inspectDirectory = async (
      parent: number,
      column: "hash" | "tempName",
      directory: string,
      key: (name: string) => string | undefined,
    ) => {
      const dir = opendirSync(`/proc/self/fd/${parent}`);
      try {
        for (;;) {
          check();
          const names = new Map<string, string>();
          // Bound directory enumeration, SQL work and synchronous inode checks
          // together. No inventory-sized transaction or per-alias connection.
          let exhausted = false;
          for (let read = 0; read < 100; read++) {
            const child = dir.readSync();
            if (!child) {
              exhausted = true;
              break;
            }
            const value = key(child.name);
            if (value) names.set(value, child.name);
          }
          if (!names.size) {
            if (exhausted) break;
            await setImmediate();
            continue;
          }
          const corrupt: CacheEntry[] = [];
          await state.inspectAliases(column, [...names.keys()], nextDeadline(), (value, e) => {
            check();
            const current = statAlias(procChild(parent, names.get(value)!));
            if (!current) return;
            if (!e || !current.isFile()) throw cacheUnavailable();
            if (column === "hash" && (!e.finalAlias || e.finalDirectory !== directory))
              throw cacheUnavailable();
            if (column === "tempName" && e.tempDirectory !== null && e.tempDirectory !== directory)
              throw cacheUnavailable();
            if (e.inode === null) {
              if (e.state !== "FILLING" || column !== "tempName" || current.size !== 0n)
                throw cacheUnavailable();
            } else sameInode(e, current);
            if (current.size > BigInt(e.size) || current.nlink > (e.state === "READY" ? 1n : 2n))
              throw cacheUnavailable();
            if (e.state === "READY" && column === "hash") {
              try {
                unchanged(e, current);
              } catch {
                corrupt.push(e);
              }
            }
          });
          for (const e of corrupt) {
            check();
            await invalidate(e);
            await repair(nextDeadline(), e.hash);
          }
          // Let stop/maintenance observe progress even with fast local SQL.
          await setImmediate();
        }
      } finally {
        dir.closeSync();
      }
    };
    try {
      checkRoot(binding, tmp.assetsFd);
      await inspectDirectory(
        tmp.tmpFd,
        "tempName",
        directoryIdentity(tmp.assetsFd, tmp.privateFd, tmp.tmpFd),
        (name) => (name.startsWith("cache-") ? name : undefined),
      );
      let objects: number | undefined;
      try {
        objects = openSync(
          procChild(tmp.assetsFd, "objects"),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        const shards = opendirSync(`/proc/self/fd/${objects}`);
        try {
          for (let shard = shards.readSync(); shard; shard = shards.readSync()) {
            check();
            if (!/^[0-9a-f]{2}$/.test(shard.name)) throw cacheUnavailable();
            const dir = openSync(
              procChild(objects, shard.name),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            try {
              const prefix = shard.name;
              await inspectDirectory(
                dir,
                "hash",
                directoryIdentity(tmp.assetsFd, objects, dir),
                (leaf) => {
                  if (!/^[0-9a-f]{62}$/.test(leaf)) throw cacheUnavailable();
                  return `sha256:${prefix}${leaf}`;
                },
              );
            } finally {
              closeSync(dir);
            }
          }
        } finally {
          shards.closeSync();
        }
      } catch (error) {
        if (!missing(error)) throw error;
      } finally {
        if (objects !== undefined) closeSync(objects);
      }
      check();
    } finally {
      closePrivateTmpChain(tmp);
    }
  };

  const release = async (pin: CachePin) => {
    await state.release(pin, budget());
    scheduleRepair();
  };

  return {
    state,
    /** Only the explicit offline initializer may establish missing metadata.
     * Unknown payload is refused, never interpreted as disposable disk CAS.
     */
    initializeEmpty: (assertOfflineFences: () => void, deadline = budget()) =>
      lifecycle.track(async () => {
        const check = () => {
          lifecycle.signal.throwIfAborted();
          assertOfflineFences();
        };
        const scan = async (fd: number, inspect: (name: string) => Promise<void> | void) => {
          const dir = opendirSync(`/proc/self/fd/${fd}`);
          try {
            let count = 0;
            for (let child = dir.readSync(); child; child = dir.readSync()) {
              check();
              await inspect(child.name);
              if (++count % 100 === 0) await setImmediate();
            }
            check();
          } finally {
            dir.closeSync();
          }
        };
        check();
        const tmp = openPrivateTmpDir(assetsDir);
        try {
          checkRoot(binding, tmp.assetsFd);
          let objects: number | undefined;
          try {
            objects = openSync(
              procChild(tmp.assetsFd, "objects"),
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            const objectsFd = objects;
            await scan(objectsFd, async (shard) => {
              if (!/^[0-9a-f]{2}$/.test(shard)) throw cacheUnavailable();
              const dir = openSync(
                procChild(objectsFd, shard),
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
              );
              try {
                await scan(dir, () => {
                  throw cacheUnavailable();
                });
              } finally {
                closeSync(dir);
              }
            });
          } catch (error) {
            if (!missing(error)) throw error;
          } finally {
            if (objects !== undefined) closeSync(objects);
          }
          await scan(tmp.tmpFd, (name) => {
            if (name.startsWith("cache-")) throw cacheUnavailable();
          });
          await state.initializeEmpty(check, deadline);
        } finally {
          closePrivateTmpChain(tmp);
        }
      }),
    registerOwner: (assertRoleFence: () => void, deadline?: number) =>
      lifecycle.track(async () => {
        await state.registerOwner(assertRoleFence, deadline);
        await sweep();
        await reconcile(assertRoleFence, deadline);
        lifecycle.signal.throwIfAborted();
        assertRoleFence();
      }),
    recover: () => lifecycle.track(sweep),
    /** One attempt; caller may wait/retry within its existing operation deadline.
     * READY => acquire; FILLING => wait; oversized => bypass. No speculative IO.
     */
    beginFill(
      hash: string,
      size: number,
      deadline: number,
      signal?: AbortSignal,
      // A parent reader owns nested fills and closes them after its source IO
      // drains. Standalone publication fills belong directly to the lifecycle.
      own: AssetStorageLifecycle["own"] = lifecycle.own,
    ) {
      return lifecycle.track(async () => {
        lifecycle.signal.throwIfAborted();
        signal?.throwIfAborted();
        parseCasHash(hash);
        if (!Number.isSafeInteger(size) || size < 1) throw cacheUnavailable();
        if (BigInt(size) > binding.limit) return;
        let tmp: ReturnType<typeof openPrivateTmpDir> | undefined = openPrivateTmpDir(assetsDir);
        let pin: CachePin | undefined;
        try {
          checkRoot(binding, tmp.assetsFd);
          const allocationPath = `/proc/${process.pid}/fd/${tmp.assetsFd}`;
          pin = await state.reserve(hash, size, deadline, allocationPath);
          if (!pin) {
            const existing = await state.inspectAlias("hash", hash, deadline);
            const reclaimed = existing
              ? (existing.state === "INVALID" || existing.state === "EVICTING") &&
                (await repair(deadline, hash))
              : await repair(deadline, undefined, true);
            if (reclaimed) pin = await state.reserve(hash, size, deadline, allocationPath);
          }
          if (!pin) {
            closePrivateTmpChain(tmp);
            return;
          }
        } catch (error) {
          closePrivateTmpChain(tmp);
          throw error;
        }
        const owned = pin;
        const fillTouch = createAssetCacheTouch(lifecycle, () =>
          state.touch(owned.entry, Math.min(deadline, Date.now() + 250)),
        );
        let entry = pin.entry;
        let fd: number | undefined;
        let sizeWritten = 0;
        const hashState = createHash("sha256");
        let completed = false;
        let failed = false;
        let closing: Promise<void> | undefined;
        let active: Promise<void> | undefined;
        const check = () => {
          lifecycle.signal.throwIfAborted();
          signal?.throwIfAborted();
          if (Date.now() >= deadline || closing || completed || failed) throw cacheUnavailable();
        };
        const exclusive = (work: () => Promise<void>) => {
          check();
          if (active) return Promise.reject(cacheUnavailable());
          const task = work().catch((error: unknown) => {
            // Completion can consume the digest or partially publish aliases.
            // No failed mutation may ever be retried on this fill.
            failed = true;
            throw error;
          });
          active = task;
          void task
            .finally(() => {
              if (active === task) active = undefined;
            })
            .catch(() => {});
          return task;
        };
        let disown = () => {};
        const close = (): Promise<void> => {
          if (closing) return closing;
          fillTouch.stop();
          closing = (async () => {
            await active?.catch(() => {});
            await barrier("fill-before-close");
            // Close failure retains the durable pin and charge.
            if (fd !== undefined) {
              closeSync(fd);
              fd = undefined;
            }
            if (tmp) {
              closePrivateTmpChain(tmp);
              tmp = undefined;
            }
            if (!completed) await invalidate(entry);
            await release(owned);
            disown();
          })();
          return closing;
        };
        try {
          disown = own(close);
          checkRoot(binding, tmp.assetsFd);
          const path = procChild(tmp.tmpFd, entry.tempName);
          fd = openSync(
            path,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          const identity = fingerprint(fstatSync(fd, { bigint: true }));
          entry = { ...entry, ...identity };
          syncTmp(tmp);
          await barrier("fill-created");
          await state.recordFile(
            owned.entry,
            identity,
            directoryIdentity(tmp.assetsFd, tmp.privateFd, tmp.tmpFd),
            deadline,
          );
          check();
          return {
            incarnation: entry.incarnation,
            sampleDownload: () => fillTouch.sample(),
            /** No write occurs beyond the FULL prior reservation/declared length. */
            write(bytes: Uint8Array) {
              try {
                check();
                if (
                  active ||
                  bytes.length > BLOB_FRAME_BYTES ||
                  sizeWritten + bytes.length > entry.size ||
                  fd === undefined
                )
                  throw cacheUnavailable();
                let offset = 0;
                while (offset < bytes.length) {
                  const n = writeSync(fd, bytes, offset, bytes.length - offset, sizeWritten);
                  if (n < 1) throw cacheUnavailable();
                  // Charge every successful syscall before any subsequent IO.
                  sizeWritten += n;
                  hashState.update(bytes.subarray(offset, offset + n));
                  offset += n;
                }
              } catch (error) {
                failed = true;
                throw error;
              }
            },
            complete: () =>
              exclusive(async () => {
                if (
                  fd === undefined ||
                  !tmp ||
                  sizeWritten !== entry.size ||
                  `sha256:${hashState.digest("hex")}` !== entry.hash
                )
                  throw cacheUnavailable();
                fsyncSync(fd);
                const before = fstatSync(fd, { bigint: true });
                sameInode(entry, before);
                if (before.size !== BigInt(entry.size)) throw cacheUnavailable();
                verifyFd(fd, entry);
                const hex = parseCasHash(entry.hash);
                const final = openCasShardDir(assetsDir, hex.slice(0, 2), hex.slice(2));
                try {
                  checkRoot(binding, final.assetsFd);
                  await state.beforeLink(
                    entry,
                    directoryIdentity(final.assetsFd, final.objectsFd, final.shardFd),
                    deadline,
                  );
                  if (closing || lifecycle.signal.aborted) throw cacheUnavailable();
                  const src = procChild(tmp.tmpFd, entry.tempName);
                  sameInode(entry, lstatSync(src, { bigint: true }));
                  linkSync(src, final.leafPath); // EEXIST never overwrites or re-baselines ownership.
                  await barrier("fill-after-link");
                  sameInode(entry, lstatSync(final.leafPath, { bigint: true }));
                  fsyncCasPublishBarriers(final, fd);
                  unlinkSync(src);
                  syncTmp(tmp);
                  fsyncCasPublishBarriers(final, fd);
                  entry = {
                    ...entry,
                    ...fingerprint(fstatSync(fd, { bigint: true })),
                    finalAlias: true,
                  };
                  await barrier("fill-before-ready");
                  const verified = verifyFd(fd, entry);
                  await state.ready(entry, verified, deadline);
                  unchanged({ ...entry, ...verified }, fstatSync(fd, { bigint: true }));
                  completed = true;
                } finally {
                  closeCasDirChain(final);
                }
              }),
            close,
          };
        } catch (error) {
          await close();
          throw error;
        }
      });
    },
    /** Persist the pin BEFORE opening, then verify the full object before serving.
     * No S3 call: a verified cache hit works during a remote outage.
     */
    open(
      hash: string,
      size: number,
      deadline: number,
      signal: AbortSignal,
    ): Promise<(BlobReader & { sampleDownload(): void }) | undefined> {
      return lifecycle.track(async () => {
        lifecycle.signal.throwIfAborted();
        signal.throwIfAborted();
        const pin = await state.acquire(hash, size, deadline);
        if (!pin) return;
        const e = pin.entry;
        const canceled = new AbortController();
        const readers = invalidations.get(e.incarnation) ?? new Set<AbortController>();
        readers.add(canceled);
        invalidations.set(e.incarnation, readers);
        const touch = createAssetCacheTouch(lifecycle, () =>
          state.touch(e, Math.min(deadline, Date.now() + 250)),
        );
        let fd: number | undefined;
        let verified = false;
        let closing: Promise<void> | undefined;
        let active: Promise<unknown> | undefined;
        let disown = () => {};
        const check = () => {
          signal.throwIfAborted();
          lifecycle.signal.throwIfAborted();
          canceled.signal.throwIfAborted();
          if (Date.now() >= deadline || closing) throw cacheUnavailable();
        };
        const io = <T>(work: () => Promise<T>): Promise<T> => {
          check();
          if (active) return Promise.reject(cacheUnavailable());
          const task = (async () => {
            try {
              return await work();
            } catch (error) {
              await invalidate(e);
              throw error;
            }
          })();
          active = task;
          void task
            .finally(() => {
              if (active === task) active = undefined;
            })
            .catch(() => {});
          return task;
        };
        const close = (): Promise<void> => {
          if (closing) return closing;
          touch.stop();
          closing = (async () => {
            await active?.catch(() => {});
            await barrier("reader-before-close");
            if (fd !== undefined) {
              closeSync(fd);
              fd = undefined;
            }
            await release(pin);
            readers.delete(canceled);
            if (!readers.size) invalidations.delete(e.incarnation);
            disown();
          })();
          return closing;
        };
        try {
          disown = lifecycle.own(close);
          const hex = parseCasHash(hash);
          const final = openCasShardDir(assetsDir, hex.slice(0, 2), hex.slice(2));
          try {
            checkRoot(binding, final.assetsFd);
            fd = openSync(
              final.leafPath,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            unchanged(e, fstatSync(fd, { bigint: true }));
          } finally {
            closeCasDirChain(final);
          }
          check();
          return {
            get verified() {
              return verified;
            },
            preflight: (checkActive) =>
              io(async () => {
                check();
                checkActive?.();
                const buf = Buffer.alloc(Math.min(BLOB_FRAME_BYTES, size));
                const digest = createHash("sha256");
                for (let offset = 0; offset < size; ) {
                  check();
                  checkActive?.();
                  const n = await new Promise<number>((resolve, reject) => {
                    read(fd!, buf, 0, Math.min(buf.length, size - offset), offset, (error, n) => {
                      if (error) reject(error);
                      else resolve(n);
                    });
                  });
                  check();
                  checkActive?.();
                  if (!n) throw cacheUnavailable();
                  digest.update(buf.subarray(0, n));
                  offset += n;
                }
                if (`sha256:${digest.digest("hex")}` !== hash) throw cacheUnavailable();
                unchanged(e, fstatSync(fd!, { bigint: true }));
                if (!(await state.isReady(e, deadline))) throw cacheUnavailable();
                check();
                verified = true;
              }),
            readFrame: (offset, length) =>
              io(async () => {
                if (
                  !verified ||
                  !Number.isSafeInteger(offset) ||
                  offset < 0 ||
                  !Number.isSafeInteger(length) ||
                  length < 1 ||
                  length > BLOB_FRAME_BYTES ||
                  offset + length > size
                )
                  throw cacheUnavailable();
                if (!(await state.isReady(e, deadline))) throw cacheUnavailable();
                check();
                unchanged(e, fstatSync(fd!, { bigint: true }));
                const bytes = Buffer.alloc(length);
                const n = readSync(fd!, bytes, 0, length, offset);
                unchanged(e, fstatSync(fd!, { bigint: true }));
                if (!n) throw cacheUnavailable();
                check();
                return bytes.subarray(0, n);
              }),
            complete: () =>
              io(async () => {
                if (!verified) throw cacheUnavailable();
                unchanged(e, fstatSync(fd!, { bigint: true }));
                if (!(await state.isReady(e, deadline))) throw cacheUnavailable();
                check();
              }),
            sampleDownload: () => touch.sample(),
            close,
          };
        } catch (error) {
          try {
            await invalidate(e);
          } finally {
            await close();
          }
          throw error;
        }
      });
    },
    repair: (deadline: number, hash?: string, evictReady = false) =>
      lifecycle.track(() => repair(deadline, hash, evictReady)),
  };
}

export type AssetCache = ReturnType<typeof createAssetCache>;
