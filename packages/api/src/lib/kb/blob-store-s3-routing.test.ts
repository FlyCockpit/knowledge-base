import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { assetS3Locator } from "@knowledge-base/env/asset-storage-config";
import { describe, expect, it, vi } from "vitest";
import { createAssetStorageLifecycle } from "./asset-storage-lifecycle";
import { createS3AssetTransport } from "./blob-store-s3";

describe("real SDK asset authority routing", () => {
  it.each(["service env", "global env", "profile"])(
    "ignores %s endpoint discovery for PUT, HEAD and GET",
    async (source) => {
      const root = mkdtempSync(join(tmpdir(), "kb-s3-routing-"));
      const lifecycle = createAssetStorageLifecycle("SERVER");
      const rogue = "http://127.0.0.1:1";
      const profile = `fixture-${source.replaceAll(" ", "-")}`;
      const configFile = join(root, "config");
      const credentialsFile = join(root, "credentials");
      writeFileSync(
        configFile,
        `[profile ${profile}]\nendpoint_url = ${rogue}\nservices = assets\n[services assets]\ns3 =\n  endpoint_url = ${rogue}\n`,
      );
      writeFileSync(credentialsFile, "");
      vi.stubEnv("AWS_PROFILE", profile);
      vi.stubEnv("AWS_CONFIG_FILE", configFile);
      vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
      vi.stubEnv("AWS_ENDPOINT_URL", source === "global env" ? rogue : undefined);
      vi.stubEnv("AWS_ENDPOINT_URL_S3", source === "service env" ? rogue : undefined);
      vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "true");
      vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "true");
      try {
        // Control: prove the real SDK actually sees each hostile source. This
        // guards against a passing test caused by an unread profile/cache.
        const inherited = new S3Client({
          region: "us-east-2",
          forcePathStyle: true,
          maxAttempts: 1,
          useFipsEndpoint: false,
          useDualstackEndpoint: false,
          credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
        });
        try {
          let inheritedHost = "";
          inherited.middlewareStack.add(
            () => async (args) => {
              inheritedHost = (args.request as { hostname: string }).hostname;
              return { response: {}, output: { $metadata: {} } };
            },
            { step: "finalizeRequest", priority: "low", name: "captureAmbientAuthority" },
          );
          await inherited.send(new HeadObjectCommand({ Bucket: "assets", Key: "fixture" }));
          expect(inheritedHost).toBe("127.0.0.1");
        } finally {
          inherited.destroy();
        }
        for (const endpoint of [undefined, "http://127.0.0.1:12345/"]) {
          const config = {
            endpoint,
            bucket: "assets",
            region: "us-east-2",
            prefix: "fixture",
            forcePathStyle: true,
            credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
          };
          const { client } = createS3AssetTransport(config, lifecycle);
          const requests: { hostname: string; protocol: string; port?: number; method: string }[] =
            [];
          // Run the real SDK endpoint resolution, serialization and signing.
          // Stop at the HTTP boundary: no real credentials or AWS requests.
          client.middlewareStack.add(
            () => async (args) => {
              requests.push(args.request as (typeof requests)[number]);
              return { response: {}, output: { $metadata: {} } };
            },
            { step: "finalizeRequest", priority: "low", name: "captureAssetAuthority" },
          );
          const params = { Bucket: config.bucket, Key: "fixture/objects/hash" };
          await client.send(new PutObjectCommand({ ...params, Body: Buffer.from("fixture") }));
          await client.send(new HeadObjectCommand(params));
          await client.send(new GetObjectCommand(params));
          expect(requests.map((r) => r.method)).toEqual(["PUT", "HEAD", "GET"]);
          for (const request of requests) {
            expect(request.hostname).toBe(endpoint ? "127.0.0.1" : "s3.us-east-2.amazonaws.com");
            expect(request.protocol).toBe(endpoint ? "http:" : "https:");
            expect(request.port).toBe(endpoint ? 12345 : undefined);
          }
          expect(JSON.parse(assetS3Locator(config)).endpoint).toBe(
            endpoint ? "http://127.0.0.1:12345" : null,
          );
        }
      } finally {
        await lifecycle.stop();
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
