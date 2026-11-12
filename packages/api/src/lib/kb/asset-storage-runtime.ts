export { assetRoleFenceProof } from "./asset-storage-fence";

/** Runtime attachment is deliberately separate from fenced offline initialization. */
import {
  type AssetStorageEnv,
  assetCacheConfiguration,
  assetRuntimeConfig,
  assetServerConfig,
} from "@knowledge-base/env/asset-storage-config";
import { assetCacheBinding, createAssetCache } from "./asset-cache";
import { createAssetPublicationState } from "./asset-publication-state";
import type { AssetStorageLifecycle } from "./asset-storage-lifecycle";
import { type AssetStorageMarker, sameAssetStorage } from "./asset-storage-mode";
import { createAssetCacheTransactions } from "./asset-storage-state";
import { createDiskBlobStore } from "./blob-store-disk";
import { createS3BlobStore } from "./blob-store-s3";
import { statfsDiskMeter } from "./quota";

export async function attachRuntimeAssetCache(input: {
  env: AssetStorageEnv;
  assetsDir: string;
  connectionString: string;
  marker: AssetStorageMarker;
  lifecycle: AssetStorageLifecycle;
  assertRoleFence(): void;
}) {
  return input.lifecycle.track(async () => {
    const selected = assetRuntimeConfig(input.env);
    if (!sameAssetStorage(selected, input.marker))
      throw new Error("Asset storage requires offline migration");
    if (selected.mode === "disk") return undefined;
    const binding = await assetCacheBinding({
      assetsDir: input.assetsDir,
      storageGeneration: input.marker.activeGeneration,
      configuration: assetCacheConfiguration(selected.locator, selected.cacheMaxBytes),
      limit: selected.cacheMaxBytes,
    });
    input.lifecycle.signal.throwIfAborted();
    const transactions = createAssetCacheTransactions(input.connectionString);
    const cache = createAssetCache({
      assetsDir: input.assetsDir,
      binding,
      transactions,
      lifecycle: input.lifecycle,
      meter: statfsDiskMeter(input.assetsDir),
    });
    // Missing/mismatched metadata refuses service. Only dual-fenced offline
    // migration/reconciliation can establish or change the cache configuration.
    // A cache is bounded in bytes, not entry count. Startup makes cancellable
    // progress in bounded transactions, without a deadline for the whole volume.
    await cache.registerOwner(input.assertRoleFence);
    input.lifecycle.registerRecovery(cache.recover);
    return cache;
  });
}

export async function createRuntimeAssetStore(
  input: Parameters<typeof attachRuntimeAssetCache>[0],
) {
  return input.lifecycle.track(async () => {
    const selected = assetServerConfig(input.env);
    if (selected.mode === "disk") {
      if (!sameAssetStorage(selected, input.marker))
        throw new Error("Asset storage requires offline migration");
      return createDiskBlobStore(input.assetsDir);
    }
    const cache = await attachRuntimeAssetCache(input);
    if (!cache) throw new Error("Missing asset cache");
    input.lifecycle.signal.throwIfAborted();
    const transactions = createAssetCacheTransactions(input.connectionString);
    return createS3BlobStore({
      assetsDir: input.assetsDir,
      config: selected.config,
      cache,
      lifecycle: input.lifecycle,
      publication: createAssetPublicationState({
        binding: { storageGeneration: input.marker.activeGeneration, locator: selected.locator },
        transactions,
      }),
    });
  });
}
