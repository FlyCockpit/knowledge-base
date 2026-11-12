import { createHash } from "node:crypto";
import {
  createOfflineAssetVerifier,
  offlineAssetConfig,
} from "@knowledge-base/api/lib/kb/asset-storage-offline";
import { describe, expect, it } from "vitest";
import { createAssetS3Fixture } from "./s3-fixture";

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
describe("offline verification uses the pinned runtime SDK without cache or writes", () => {
  it("cancels backup verification through its parent signal while remote bytes are in flight", async () => {
    const fixture = await createAssetS3Fixture();
    const parent = new AbortController();
    const verifier = createOfflineAssetVerifier(
      offlineAssetConfig({ ...env, KB_ASSET_S3_ENDPOINT: fixture.endpoint }),
      parent.signal,
    );
    fixture.objects.set(`/assets/objects/${hash.slice(7, 9)}/${hash.slice(9)}`, {
      bytes: Buffer.from("asset"),
      metadata: {},
    });
    const pause = fixture.pauseGetsAfter(1);
    try {
      const rejected = expect(verifier.verify(row)).rejects.toThrow();
      await pause.reached;
      parent.abort(new Error("Backup cancelled"));
      await rejected;
      await verifier.close();
      await expect(verifier.verify(row)).rejects.toThrow();
      expect(fixture.requests.every((r) => ["HEAD", "GET"].includes(r.method))).toBe(true);
    } finally {
      await verifier.close();
      await fixture.close();
    }
  });
  it("checks metadata, hashes metadata-free objects, rejects missing/corrupt bytes and drains cancellation", async () => {
    const fixture = await createAssetS3Fixture();
    const config = offlineAssetConfig({ ...env, KB_ASSET_S3_ENDPOINT: fixture.endpoint });
    const verifier = createOfflineAssetVerifier(config);
    const key = `/assets/objects/${hash.slice(7, 9)}/${hash.slice(9)}`;
    try {
      await expect(verifier.verify(row)).rejects.toThrow();
      fixture.objects.set(key, {
        bytes: Buffer.from("asset"),
        metadata: { sha256: hash.slice(7), size: "5" },
      });
      await verifier.verify(row);
      fixture.objects.get(key)!.metadata.sha256 = "0".repeat(64);
      await expect(verifier.verify(row)).rejects.toThrow();
      fixture.objects.get(key)!.metadata = {};
      await verifier.verify(row);
      fixture.corruptGets(true);
      await expect(verifier.verify(row)).rejects.toThrow();
      fixture.corruptGets(false);
      const pause = fixture.pauseGetsAfter(1);
      const pending = verifier.verify(row);
      const observed = expect(pending).rejects.toThrow();
      await pause.reached;
      await verifier.close();
      await observed;
      expect(fixture.requests.every((r) => ["HEAD", "GET"].includes(r.method))).toBe(true);
      expect(
        fixture.requests.every((r) => String(r.headers.authorization).includes("operator-reader")),
      ).toBe(true);
    } finally {
      await verifier.close();
      await fixture.close();
    }
  });
});
