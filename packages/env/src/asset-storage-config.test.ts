import { describe, expect, it } from "vitest";
import {
  assetRuntimeConfig,
  assetS3Locator,
  assetServerConfig,
  normalizeAssetS3Location,
} from "./asset-storage-config";
import { Secret } from "./secret";

const location = {
  bucket: "kb-assets",
  region: "auto",
  prefix: "/instance/",
  forcePathStyle: true,
  endpoint: "https://S3.example:443/",
};
describe("asset storage location", () => {
  it("normalizes locator identity without credentials", () => {
    expect(normalizeAssetS3Location(location)).toEqual({
      ...location,
      prefix: "instance",
      endpoint: "https://s3.example",
    });
    expect(assetS3Locator(location)).toBe(
      assetS3Locator({ ...location, endpoint: "https://s3.example", prefix: "instance" }),
    );
    expect(assetS3Locator(location)).not.toContain("credentials");
    expect(assetS3Locator(location)).not.toBe(
      assetS3Locator({ ...location, bucket: "other-assets" }),
    );
  });
  it.each(["../other", "a/../b", "a//b", "a?b", "a\\b"])("rejects unsafe prefix %s", (prefix) => {
    expect(() => normalizeAssetS3Location({ ...location, prefix })).toThrow();
  });
  it.each([
    "https://user:pass@s3.example",
    "https://s3.example/path",
    "https://s3.example?key=x",
    "ftp://s3.example",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => normalizeAssetS3Location({ ...location, endpoint })).toThrow();
  });
});

describe("role configuration", () => {
  const env = {
    KB_ASSET_S3_ENABLED: true,
    KB_ASSET_S3_BUCKET: "kb-assets",
    KB_ASSET_S3_REGION: "us-east-1",
    KB_ASSET_CACHE_MAX_BYTES: "26214400",
  };
  it("keeps off mode independent of incomplete S3 configuration", () => {
    expect(
      assetServerConfig({ ...env, KB_ASSET_S3_ENABLED: false, KB_ASSET_CACHE_MAX_BYTES: "bad" }),
    ).toEqual({ mode: "disk" });
    expect(assetRuntimeConfig({})).toEqual({ mode: "disk" });
  });
  it("validates a worker without asset credentials and requires the server pair", () => {
    expect(assetRuntimeConfig(env)).toMatchObject({ mode: "s3", cacheMaxBytes: 26214400n });
    expect(() => assetServerConfig(env)).toThrow();
    expect(() => assetServerConfig({ ...env, KB_ASSET_S3_ACCESS_KEY_ID: "runtime" })).toThrow();
    expect(
      assetServerConfig({
        ...env,
        KB_ASSET_S3_ACCESS_KEY_ID: new Secret("runtime"),
        KB_ASSET_S3_SECRET_ACCESS_KEY: new Secret("secret"),
      }),
    ).toMatchObject({
      config: { credentials: { accessKeyId: "runtime", secretAccessKey: "secret" } },
    });
  });
  it.each([undefined, "", "0", "26214399", "1.5", "1e9", "-1", "9007199254740992", " 26214400"])(
    "rejects invalid limits %s",
    (limit) => {
      expect(() => assetRuntimeConfig({ ...env, KB_ASSET_CACHE_MAX_BYTES: limit })).toThrow();
    },
  );
  it.each([
    { KB_ASSET_S3_FORCE_PATH_STYLE: "yes" },
    { KB_ASSET_S3_REGION: "auto" },
    { KB_ASSET_S3_REGION: "" },
    { KB_ASSET_S3_ENDPOINT: "https://user:sentinel@example.test" },
    { KB_ASSET_S3_ENDPOINT: "https://example.test?secret=sentinel" },
    { KB_ASSET_S3_ENDPOINT: "https://example.test#sentinel" },
    { KB_ASSET_S3_PREFIX: "a/../b" },
  ])("rejects invalid settings without disclosing input", (extra) => {
    expect(() => assetRuntimeConfig({ ...env, ...extra })).toThrow(
      "Invalid KB_ASSET_S3 configuration",
    );
  });
});
