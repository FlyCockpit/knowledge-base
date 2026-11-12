import { assetRuntimeConfig } from "@knowledge-base/env/asset-storage-config";
import { describe, expect, it, vi } from "vitest";
import { createAssetStorageLifecycle } from "./asset-storage-lifecycle";

const state = vi.hoisted(() => ({ cache: vi.fn(), remote: vi.fn() }));
vi.mock("./asset-cache", () => ({ assetCacheBinding: state.cache, createAssetCache: state.cache }));
vi.mock("./blob-store-s3", () => ({ createS3BlobStore: state.remote }));

import { attachRuntimeAssetCache, createRuntimeAssetStore } from "./asset-storage-runtime";

describe("runtime asset selection", () => {
  const input = () => ({
    env: {},
    assetsDir: "/unused/assets",
    connectionString: "unused",
    marker: {
      version: 1 as const,
      mode: "disk" as const,
      activeGeneration: "00000000-0000-4000-8000-000000000007",
    },
    lifecycle: createAssetStorageLifecycle("SERVER"),
    assertRoleFence: vi.fn(),
  });
  it("keeps default disk mode free of cache and S3 initialization", async () => {
    const f = input();
    try {
      expect((await createRuntimeAssetStore(f)).backend).toBe("disk");
      expect(await attachRuntimeAssetCache(f)).toBeUndefined();
      expect(f.assertRoleFence).not.toHaveBeenCalled();
      expect(state.cache).not.toHaveBeenCalled();
      expect(state.remote).not.toHaveBeenCalled();
    } finally {
      await f.lifecycle.stop();
    }
  });
  it.each(["SERVER", "WORKER"] as const)(
    "attaches %s without an inventory-wide deadline or a bucket request",
    async (role) => {
      const f = input();
      const lifecycle = createAssetStorageLifecycle(role);
      const env = {
        KB_ASSET_S3_ENABLED: true,
        KB_ASSET_S3_BUCKET: "assets",
        KB_ASSET_S3_REGION: "us-east-1",
        KB_ASSET_CACHE_MAX_BYTES: "26214400",
      };
      const selection = assetRuntimeConfig(env);
      if (selection.mode !== "s3") throw new Error("Expected S3 selection");
      const cache = { registerOwner: vi.fn(async () => {}), recover: vi.fn(async () => {}) };
      state.cache.mockResolvedValueOnce({}).mockReturnValueOnce(cache);
      try {
        expect(
          await attachRuntimeAssetCache({
            ...f,
            env,
            lifecycle,
            marker: { ...f.marker, mode: "s3", locator: selection.locator },
          }),
        ).toBe(cache);
        expect(cache.registerOwner).toHaveBeenCalledExactlyOnceWith(f.assertRoleFence);
        expect(state.remote).not.toHaveBeenCalled();
      } finally {
        await lifecycle.stop();
        await f.lifecycle.stop();
        vi.clearAllMocks();
      }
    },
  );
  it("refuses a recorded S3 marker even when environment is off", async () => {
    const f = input();
    try {
      await expect(
        createRuntimeAssetStore({ ...f, marker: { ...f.marker, mode: "s3", locator: "recorded" } }),
      ).rejects.toThrow(/offline migration/);
      expect(state.cache).not.toHaveBeenCalled();
      expect(state.remote).not.toHaveBeenCalled();
    } finally {
      await f.lifecycle.stop();
    }
  });
  it("joins attachment cancelled while its volume binding is still in flight", async () => {
    const f = input();
    const parent = new AbortController();
    const lifecycle = createAssetStorageLifecycle("WORKER", parent.signal);
    const binding = Promise.withResolvers<object>();
    const entered = Promise.withResolvers<void>();
    const env = {
      KB_ASSET_S3_ENABLED: true,
      KB_ASSET_S3_BUCKET: "assets",
      KB_ASSET_S3_REGION: "us-east-1",
      KB_ASSET_CACHE_MAX_BYTES: "26214400",
    };
    const selection = assetRuntimeConfig(env);
    if (selection.mode !== "s3") throw new Error("Expected S3 selection");
    state.cache.mockImplementationOnce(() => {
      entered.resolve();
      return binding.promise;
    });
    const rejected = expect(
      attachRuntimeAssetCache({
        ...f,
        env,
        lifecycle,
        marker: { ...f.marker, mode: "s3", locator: selection.locator },
      }),
    ).rejects.toThrow("Cancelled binding");
    try {
      await entered.promise;
      parent.abort(new Error("Cancelled binding"));
      let stopped = false;
      const stopping = lifecycle.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      binding.resolve({});
      await rejected;
      await stopping;
      expect(state.cache).toHaveBeenCalledOnce();
    } finally {
      binding.resolve({});
      await lifecycle.stop();
      await f.lifecycle.stop();
      vi.clearAllMocks();
    }
  });
});
