import { describe, expect, it, vi } from "vitest";
import { createAssetStorageLifecycle } from "./asset-storage-lifecycle";
import { createAssetStorageState } from "./asset-storage-state";

describe("cache configuration bounds", () => {
  it("refuses a below-maximum limit before opening a transaction", async () => {
    const lifecycle = createAssetStorageLifecycle("SERVER");
    const transactions = vi.fn();
    expect(() =>
      createAssetStorageState({
        assetsDir: "unused",
        binding: {
          cacheId: "fixture",
          volumeId: "fixture",
          storageGeneration: "fixture",
          configuration: "fixture",
          limit: 26214399n,
        },
        transactions,
        lifecycle,
        meter: { freeBytes: async () => 0n },
      }),
    ).toThrow("Asset cache unavailable");
    expect(transactions).not.toHaveBeenCalled();
    await lifecycle.stop();
  });
});
