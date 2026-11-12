import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import {
  checkAssetBundleStorage,
  offlineAssetConfig,
  readAssetInventory,
} from "./asset-storage-offline";

const env = {
  KB_ASSET_S3_ENABLED: "true",
  KB_ASSET_S3_BUCKET: "assets",
  KB_ASSET_S3_REGION: "us-east-1",
  KB_ASSET_S3_FORCE_PATH_STYLE: "true",
  KB_ASSET_S3_ACCESS_KEY_ID: "runtime-only-comparison",
  KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID: "operator-reader",
  KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: "fixture-only-secret",
};
const hash = `sha256:${createHash("sha256").update("asset").digest("hex")}`;
const row = { hash, size: 5 };
async function read(text: string) {
  const rows = [];
  for await (const value of readAssetInventory(Readable.from([Buffer.from(text)])))
    rows.push(value);
  return rows;
}
it("bounds and validates sorted streamed inventory independently of bundle headers", async () => {
  const line = JSON.stringify(row) + "\n";
  expect(await read(line)).toEqual([row]);
  for (const text of [
    line + line,
    line.trim(),
    "x".repeat(257),
    JSON.stringify({ ...row, extra: true }) + "\n",
    JSON.stringify({ ...row, size: 0 }) + "\n",
    JSON.stringify({ ...row, hash: "bad" }) + "\n",
  ])
    await expect(read(text)).rejects.toThrow();
  expect(await read("")).toEqual([]);
});
it("selects explicit operator credentials and validates credential-free locators", () => {
  expect(offlineAssetConfig({})).toEqual({ mode: "disk" });
  expect(() => offlineAssetConfig({ ...env, KB_ASSET_S3_ACCESS_KEY_ID: undefined })).toThrow();
  expect(() =>
    offlineAssetConfig({ ...env, KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY: undefined }),
  ).toThrow();
  const config = offlineAssetConfig(env);
  expect(config.mode).toBe("s3");
  if (config.mode !== "s3") throw Error("fixture");
  expect(config.config.credentials.accessKeyId).toBe(env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID);
  expect(config.locator).not.toContain("comparison");
  expect(checkAssetBundleStorage({ mode: "s3", locator: config.locator }).locator).toBe(
    config.locator,
  );
  expect(() =>
    checkAssetBundleStorage({ mode: "s3", locator: config.locator, secret: "forbidden" }),
  ).toThrow();
});

it("streams an inventory larger than the bundle header budget with bounded row memory", async () => {
  let count = 0;
  async function* source() {
    for (let i = 0; i < 200000; i++)
      yield Buffer.from(
        JSON.stringify({ hash: `sha256:${i.toString(16).padStart(64, "0")}`, size: 1 }) + "\n",
      );
  }
  for await (const _row of readAssetInventory(source())) count++;
  expect(count).toBe(200000);
  await expect(
    read(
      JSON.stringify({ hash: `sha256:${"f".repeat(64)}`, size: 1 }) +
        "\n" +
        JSON.stringify(row) +
        "\n",
    ),
  ).rejects.toThrow();
});
