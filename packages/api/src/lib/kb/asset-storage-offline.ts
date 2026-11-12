/** Import-pure offline entrypoint, bundled into the server image offline tooling. */
import { randomUUID } from "node:crypto";
import { fsyncSync, lstatSync, unlinkSync } from "node:fs";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { AssetS3Config } from "@knowledge-base/env/asset-storage-config";
import {
  assetCacheConfiguration,
  assetS3Locator,
  normalizeAssetS3Location,
} from "@knowledge-base/env/asset-storage-config";
import { CAS_SNIFF_MIME_TYPES, validateCasMediaBytes } from "../sniff-mime";
import { assetCacheBinding, createAssetCache } from "./asset-cache";
import { createAssetPublicationState } from "./asset-publication-state";
import { assetRoleFenceProof } from "./asset-storage-fence";
import { createAssetStorageLifecycle } from "./asset-storage-lifecycle";
import { createAssetCacheTransactions } from "./asset-storage-state";
import { BLOB_FRAME_BYTES } from "./blob-store";
import { createDiskBlobStore, offlineDiskBytes } from "./blob-store-disk";

export { offlineDiskBytes, offlineDiskInventory, removeOfflineDiskObject } from "./blob-store-disk";

import { createS3AssetTransport, createS3BlobStore } from "./blob-store-s3";
import { parseCasHash } from "./cas";
import { closePrivateTmpChain, openPrivateTmpDir } from "./cas-fd";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import {
  assertDiskFloor,
  type DiskMeter,
  releaseQuota,
  reserveQuota,
  statfsDiskMeter,
} from "./quota";

export type OfflineAssetConfig =
  | { mode: "disk" }
  | { mode: "s3"; locator: string; config: AssetS3Config };
export type AssetInventoryRow = { hash: string; size: number };
const invalid = () => new Error("Invalid offline asset storage configuration");
export function offlineAssetConfig(env: Record<string, string | undefined>): OfflineAssetConfig {
  const enabled = env.KB_ASSET_S3_ENABLED ?? "false";
  if (!["true", "false"].includes(enabled)) throw invalid();
  if (enabled === "false") return { mode: "disk" };
  if (
    !env.KB_ASSET_S3_ACCESS_KEY_ID ||
    !env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID ||
    !env.KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY
  )
    throw invalid();
  const pathStyle = env.KB_ASSET_S3_FORCE_PATH_STYLE ?? "false";
  if (!["true", "false"].includes(pathStyle)) throw invalid();
  if (!env.KB_ASSET_S3_REGION || (!env.KB_ASSET_S3_ENDPOINT && env.KB_ASSET_S3_REGION === "auto"))
    throw invalid();
  const location = normalizeAssetS3Location({
    bucket: env.KB_ASSET_S3_BUCKET ?? "",
    endpoint: env.KB_ASSET_S3_ENDPOINT || undefined,
    region: env.KB_ASSET_S3_REGION,
    prefix: env.KB_ASSET_S3_PREFIX ?? "",
    forcePathStyle: pathStyle === "true",
  });
  return {
    mode: "s3",
    locator: assetS3Locator(location),
    config: {
      ...location,
      credentials: {
        accessKeyId: env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID,
        secretAccessKey: env.KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY,
      },
    },
  };
}

export function checkAssetInventoryRow(value: unknown): AssetInventoryRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const row = value as AssetInventoryRow;
  if (Object.keys(row).sort().join(",") !== "hash,size") throw invalid();
  parseCasHash(row.hash);
  if (!Number.isSafeInteger(row.size) || row.size < 1 || row.size > CAS_BLOB_MAX_BYTES)
    throw invalid();
  return row;
}

/** Bounded even for a malicious line without a newline; strict canonical order. */
export async function* readAssetInventory(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<AssetInventoryRow> {
  let line = Buffer.alloc(0);
  let previous = "";
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const stop = end < 0 ? chunk.length : end;
      if (line.length + stop - offset > 256) throw invalid();
      line = Buffer.concat([line, chunk.subarray(offset, stop)]);
      offset = stop + (end < 0 ? 0 : 1);
      if (end < 0) break;
      const row = checkAssetInventoryRow(JSON.parse(line.toString("utf8")));
      if (row.hash <= previous || line.toString("utf8") !== JSON.stringify(row)) throw invalid();
      previous = row.hash;
      line = Buffer.alloc(0);
      yield row;
    }
  }
  if (line.length) throw invalid();
}

export function checkAssetBundleStorage(value: unknown): { mode: "s3"; locator: string } {
  if (!value || typeof value !== "object") throw invalid();
  const storage = value as { mode: string; locator: string };
  if (
    Object.keys(storage).sort().join(",") !== "locator,mode" ||
    storage.mode !== "s3" ||
    typeof storage.locator !== "string"
  )
    throw invalid();
  const l = JSON.parse(storage.locator);
  if (
    l.version !== 1 ||
    l.mode !== "s3" ||
    assetS3Locator({ ...l, endpoint: l.endpoint ?? undefined }) !== storage.locator
  )
    throw invalid();
  return { mode: "s3", locator: storage.locator };
}

export function createOfflineAssetVerifier(config: OfflineAssetConfig, signal?: AbortSignal) {
  if (config.mode !== "s3") throw invalid();
  const lifecycle = createAssetStorageLifecycle("SERVER", signal);
  const { verifyRemote } = createS3AssetTransport(config.config, lifecycle);
  return {
    async verify(row: AssetInventoryRow) {
      checkAssetInventoryRow(row);
      const timeout = AbortSignal.timeout(120000);
      const active = AbortSignal.any([lifecycle.signal, timeout, ...(signal ? [signal] : [])]);
      await lifecycle.track(async () => {
        if (!(await verifyRemote(row.hash, row.size, active)))
          throw new Error("Remote asset verification failed");
      });
    },
    close: () => lifecycle.stop(),
  };
}

export { assetCacheBinding } from "./asset-cache";
/** Shared offline byte operations; no alternate S3 key/hash/publication implementation. */
export {
  assetStorageSelection,
  currentAssetObligation,
  parseAssetStorageMarker,
  sameAssetStorage,
} from "./asset-storage-mode";
export { createAssetCacheTransactions } from "./asset-storage-state";

export function offlineCacheLimit(value: string | undefined) {
  if (
    !value ||
    !/^[1-9][0-9]*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    BigInt(value) < BigInt(CAS_BLOB_MAX_BYTES)
  )
    throw invalid();
  return BigInt(value);
}
export function offlineCacheConfiguration(locator: string, limit: bigint) {
  return assetCacheConfiguration(locator, limit);
}

/** Both role fences are mandatory for offline byte ownership changes. */
export function offlineAssetFenceProof(reposDir: string): () => void {
  const server = assetRoleFenceProof(reposDir, "server");
  const worker = assetRoleFenceProof(reposDir, "worker", "KB_WORKER_FENCE_FD");
  return () => {
    server();
    worker();
  };
}

export function createOfflineAssetCopier(input: {
  config: OfflineAssetConfig;
  assetsDir: string;
  connectionString: string;
  attemptId: string;
  generation: string;
  assertOfflineFences(): void;
  signal?: AbortSignal;
  barrier?: (phase: string) => Promise<void>;
  meter?: DiskMeter;
}) {
  if (input.config.mode !== "s3") throw invalid();
  const config = input.config;
  const lifecycle = createAssetStorageLifecycle("SERVER", input.signal);
  const transactions = createAssetCacheTransactions(input.connectionString);
  const publication = createAssetPublicationState({
    binding: { storageGeneration: input.generation, locator: config.locator },
    transactions,
    offline: { attemptId: input.attemptId, assertOfflineFences: input.assertOfflineFences },
  });
  const remote = createS3BlobStore({
    assetsDir: input.assetsDir,
    config: config.config,
    publication,
    lifecycle,
    offlineScratchName: `migration-${input.attemptId}`,
  });
  const transport = createS3AssetTransport(config.config, lifecycle);
  const disk = createDiskBlobStore(input.assetsDir, `migration-${input.attemptId}`);
  const signal = AbortSignal.any([lifecycle.signal, ...(input.signal ? [input.signal] : [])]);
  const meter = input.meter ?? statfsDiskMeter(input.assetsDir);
  const allocate = async <T>(bytes: bigint, work: () => Promise<T>) => {
    input.assertOfflineFences();
    const lease = await transactions(Date.now() + 5000, (q) =>
      reserveQuota(
        { transactionQuery: q },
        {
          opId: `asset-migration:${input.attemptId}`,
          charges: [],
          expiresAt: new Date(Date.now() + 120000),
          heldForPublication: true,
          disks: [{ path: input.assetsDir, bytes, meter }],
        },
      ),
    );
    try {
      await input.barrier?.("allocation");
      signal.throwIfAborted();
      return await work();
    } finally {
      await transactions(Date.now() + 5000, (q) =>
        releaseQuota({ transactionQuery: q }, lease.reservationIds),
      );
    }
  };
  const mime = (body: Buffer) => {
    for (const type of CAS_SNIFF_MIME_TYPES) if (validateCasMediaBytes(body, type).ok) return type;
    throw invalid();
  };
  return {
    async exists(row: AssetInventoryRow) {
      checkAssetInventoryRow(row);
      return lifecycle.track(() =>
        transport.verifyRemote(
          row.hash,
          row.size,
          AbortSignal.any([signal, AbortSignal.timeout(120000)]),
        ),
      );
    },
    async *list(): AsyncGenerator<AssetInventoryRow> {
      let token: string | undefined;
      const prefix = `${config.config.prefix ? `${config.config.prefix}/` : ""}objects/`;
      do {
        signal.throwIfAborted();
        const page = await lifecycle.track(() =>
          transport.client.send(
            new ListObjectsV2Command({
              Bucket: config.config.bucket,
              Prefix: prefix,
              MaxKeys: 1000,
              ContinuationToken: token,
            }),
            { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) },
          ),
        );
        for (const o of page.Contents ?? []) {
          const relative = o.Key?.slice(prefix.length);
          if (
            !o.Key?.startsWith(prefix) ||
            !relative ||
            !/^[a-f0-9]{2}\/[a-f0-9]{62}$/.test(relative)
          )
            throw invalid();
          yield checkAssetInventoryRow({
            hash: `sha256:${relative.replace("/", "")}`,
            size: o.Size,
          });
        }
        if (
          page.IsTruncated &&
          (!page.NextContinuationToken || page.NextContinuationToken === token)
        )
          throw invalid();
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
    async toRemote(row: AssetInventoryRow) {
      await allocate(BigInt(row.size), () =>
        offlineDiskBytes(
          input.assetsDir,
          row,
          (body) =>
            remote.publishVerified({
              declaredHash: row.hash,
              declaredSize: row.size,
              declaredMime: mime(body),
              bytes: body,
              signal,
            }),
          signal,
        ),
      );
    },
    async retainRemote(row: AssetInventoryRow) {
      await remote.assertDurable({ ...row, signal });
    },
    async toDisk(row: AssetInventoryRow) {
      // Existing verified hits cost no disk growth and do not overwrite corruption.
      try {
        await offlineDiskBytes(input.assetsDir, row, () => {}, signal);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await allocate(BigInt(row.size), async () => {
        const reader = await remote.open({ ...row, purpose: "internal", signal });
        try {
          await reader.preflight();
          const body = Buffer.alloc(row.size);
          for (let at = 0; at < row.size; ) {
            const frame = await reader.readFrame(at, Math.min(BLOB_FRAME_BYTES, row.size - at));
            if (!frame.length) throw invalid();
            body.set(frame, at);
            at += frame.length;
          }
          await reader.complete();
          await disk.publishVerified({
            declaredHash: row.hash,
            declaredSize: row.size,
            declaredMime: mime(body),
            bytes: body,
            signal,
          });
        } finally {
          await reader.close();
        }
      });
    },
    close: () => lifecycle.stop(),
  };
}

/** Retire/recover only this actual cache volume, using P2's owned alias cleanup.
 * Destination disk growth is never admitted or evicted as live cache payload. */
export async function drainOfflineAssetCache(input: {
  assetsDir: string;
  connectionString: string;
  assertOfflineFences(): void;
  /** Restore discards target cache bytes before removing imported bookkeeping. */
  discardReady?: boolean;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  input.assertOfflineFences();
  const transactions = createAssetCacheTransactions(input.connectionString);
  const probe = await assetCacheBinding({
    assetsDir: input.assetsDir,
    storageGeneration: randomUUID(),
    configuration: "probe",
    limit: BigInt(CAS_BLOB_MAX_BYTES),
  });
  const rows = await transactions(Date.now() + 5000, (q) =>
    q<{ storageGeneration: string; configuration: string; effectiveLimit: string }>(
      'SELECT "storageGeneration",configuration,"effectiveLimit" FROM asset_cache_state WHERE id=$1',
      [probe.cacheId],
    ),
  );
  input.signal?.throwIfAborted();
  if (!rows.rows[0]) {
    if (input.discardReady) {
      const lifecycle = createAssetStorageLifecycle("SERVER", input.signal);
      try {
        const cache = createAssetCache({
          ...input,
          transactions,
          lifecycle,
          binding: probe,
          meter: statfsDiskMeter(input.assetsDir),
        });
        // Missing target metadata is safe only for an actually empty namespace.
        // Imported source rows never authorize deleting unknown local aliases.
        await cache.initializeEmpty(input.assertOfflineFences);
      } finally {
        await lifecycle.stop();
      }
    }
    return;
  }
  const row = rows.rows[0];
  for (const role of ["SERVER", "WORKER"] as const) {
    const lifecycle = createAssetStorageLifecycle(role, input.signal);
    try {
      const cache = createAssetCache({
        ...input,
        transactions,
        lifecycle,
        binding: {
          ...probe,
          storageGeneration: row.storageGeneration,
          configuration: row.configuration,
          limit: BigInt(row.effectiveLimit),
        },
        meter: statfsDiskMeter(input.assetsDir),
      });
      await cache.registerOwner(input.assertOfflineFences);
      await cache.recover();
      if (input.discardReady) {
        // P2 owns inode checks, alias removal, all filesystem barriers and
        // quota credit. Dual fences permit draining both roles, never skipping
        // this ownership protocol merely because restore will drop the ledger.
        while (await cache.repair(Date.now() + 5000, undefined, true)) input.assertOfflineFences();
      }
    } finally {
      await lifecycle.stop();
    }
  }
  await transactions(Date.now() + 5000, async (q) => {
    input.signal?.throwIfAborted();
    await q('UPDATE asset_cache_owner SET retired=true WHERE "cacheId"=$1', [probe.cacheId]);
    if (
      (
        await q(
          `SELECT hash FROM asset_cache_entry WHERE "cacheId"=$1 ${input.discardReady ? "" : "AND state<>'READY'"} LIMIT 1`,
          [probe.cacheId],
        )
      ).rows.length
    )
      throw invalid();
    input.signal?.throwIfAborted();
  });
}

export async function initializeOfflineAssetCache(input: {
  assetsDir: string;
  connectionString: string;
  generation: string;
  locator: string;
  limit: bigint;
  assertOfflineFences(): void;
  signal?: AbortSignal;
}) {
  const lifecycle = createAssetStorageLifecycle("SERVER", input.signal);
  try {
    lifecycle.signal.throwIfAborted();
    const binding = await assetCacheBinding({
      assetsDir: input.assetsDir,
      storageGeneration: input.generation,
      configuration: offlineCacheConfiguration(input.locator, input.limit),
      limit: input.limit,
    });
    const cache = createAssetCache({
      ...input,
      binding,
      lifecycle,
      transactions: createAssetCacheTransactions(input.connectionString),
      meter: statfsDiskMeter(input.assetsDir),
    });
    await assertDiskFloor(statfsDiskMeter(input.assetsDir));
    await cache.initializeEmpty(input.assertOfflineFences);
  } finally {
    await lifecycle.stop();
  }
}

/** Native dual fences prove the previous attempt's IO and descendants dead.
 * A deterministic private alias plus exact opId makes partials/charges retryable. */
export async function recoverOfflineMigrationScratch(input: {
  assetsDir: string;
  connectionString: string;
  attemptId: string;
  assertOfflineFences(): void;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  input.assertOfflineFences();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.attemptId))
    throw invalid();
  const chain = openPrivateTmpDir(input.assetsDir);
  try {
    const path = `/proc/self/fd/${chain.tmpFd}/migration-${input.attemptId}`;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink > 2) throw invalid();
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsyncSync(chain.tmpFd);
    fsyncSync(chain.privateFd);
    fsyncSync(chain.assetsFd);
  } finally {
    closePrivateTmpChain(chain);
  }
  const transactions = createAssetCacheTransactions(input.connectionString);
  for (;;) {
    input.signal?.throwIfAborted();
    const count = await transactions(Date.now() + 5000, async (q) => {
      const rows = await q<{ id: string }>(
        `SELECT id FROM quota_reservation WHERE "opId"=$1 AND outcome='RESERVED' ORDER BY id LIMIT 1000`,
        [`asset-migration:${input.attemptId}`],
      );
      await releaseQuota(
        { transactionQuery: q },
        rows.rows.map((r) => r.id),
      );
      return rows.rows.length;
    });
    if (!count) break;
  }
  input.assertOfflineFences();
  input.signal?.throwIfAborted();
}
