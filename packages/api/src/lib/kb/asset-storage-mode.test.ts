import { describe, expect, it, vi } from "vitest";
import {
  admitAssetStorage,
  assetStorageSelection,
  currentAssetObligation,
  parseAssetStorageMarker,
} from "./asset-storage-mode";

const marker = {
  version: 1,
  mode: "disk",
  activeGeneration: "00000000-0000-4000-8000-000000000001",
};
describe("storage authority admission", () => {
  it("rejects pending migration before reading marker or invoking fence/inventory", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("to_regclass")
        ? [{ present: "control" }]
        : sql.includes("state<>")
          ? [{ pending: true }]
          : [],
    }));
    await expect(
      admitAssetStorage({
        query,
        selection: { mode: "disk" },
        assetsDir: "/unused",
        deadlineAt: Date.now(),
        role: "SERVER",
        assertServerFence: vi.fn(),
      }),
    ).rejects.toThrow(/Pending/);
    expect(query.mock.calls.some(([sql]) => sql.includes("FROM app_setting"))).toBe(false);
  });
  it("accepts matching markers without filesystem or remote observation and excludes secrets from selection", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM app_setting") ? [{ value: JSON.stringify(marker) }] : [],
    }));
    const fence = vi.fn(() => {
      throw new Error("not needed for existing marker");
    });
    const selected = assetStorageSelection({
      KB_ASSET_S3_ENABLED: false,
      KB_ASSET_S3_ENDPOINT: "irrelevant invalid value",
    });
    expect(
      await admitAssetStorage({
        query,
        selection: selected,
        assetsDir: "/unused",
        deadlineAt: Date.now(),
        role: "WORKER",
        assertServerFence: fence,
      }),
    ).toEqual(marker);
    expect(fence).not.toHaveBeenCalled();
  });
  it("fails mismatched selection and malformed marker, and defines current obligations by exact generation+locator", () => {
    expect(() =>
      parseAssetStorageMarker(JSON.stringify({ ...marker, activeGeneration: "invalid" })),
    ).toThrow();
    const selection = assetStorageSelection({
      KB_ASSET_S3_ENABLED: true,
      KB_ASSET_S3_BUCKET: "assets",
      KB_ASSET_S3_REGION: "us-east-1",
    });
    if (selection.mode !== "s3") throw new Error("fixture");
    const s3 = parseAssetStorageMarker(JSON.stringify({ ...marker, ...selection }));
    expect(currentAssetObligation(s3)).toEqual({
      generation: marker.activeGeneration,
      locator: selection.locator,
    });
    expect(() => currentAssetObligation(parseAssetStorageMarker(JSON.stringify(marker)))).toThrow();
  });
});
