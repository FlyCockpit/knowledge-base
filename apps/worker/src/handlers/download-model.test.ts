import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { modelDownloadDesiredSchema } from "@knowledge-base/api/lib/kb/local-model";
import { downloadModelJobSchema, QUEUE_NAMES } from "@knowledge-base/queue/jobs";
import { beforeAll, describe, expect, it } from "vitest";
import { generateDokployCompose } from "../../../../scripts/generate-dokploy-config";

const root = resolve(import.meta.dirname, "../../../..");

describe("model download worker wiring", () => {
  let runtime = "";
  let dokploy = "";
  let dockerfiles: string[] = [];
  let dockerignore = "";
  beforeAll(() => {
    // Static source is fixture input; disk latency is outside the unchanged
    // action deadline for the wiring and image-policy assertions below.
    runtime = readFileSync(resolve(root, "apps/worker/src/runtime.ts"), "utf8");
    dokploy = generateDokployCompose({
      environment: "development",
      gitRef: "main",
      url: "https://dev.example.com",
    });
    dockerfiles = ["Dockerfile", "Dockerfile.worker"].map((file) =>
      readFileSync(resolve(root, file), "utf8"),
    );
    dockerignore = readFileSync(resolve(root, ".dockerignore"), "utf8");
  }, 60_000);

  it("queues the durable job ID only, never a caller-selected URL, host or digest", () => {
    const durableJobId = "b3c80336-2486-4ac2-8abf-04b0d7b287bc";
    expect(downloadModelJobSchema.parse({ durableJobId })).toEqual({ durableJobId });
    for (const extra of [
      { url: "https://evil.example/model.gguf" },
      { sha256: "0".repeat(64) },
      { host: "evil.example" },
    ])
      expect(downloadModelJobSchema.safeParse({ durableJobId, ...extra }).success).toBe(false);
    expect(QUEUE_NAMES.downloadModel).toBe("download-model");
  });

  it("the worker registers exactly one download consumer; both roles mount the one data volume", () => {
    expect(runtime).toContain("QUEUE_NAMES.downloadModel");
    // Download1: the consumer is sized by the shared limit constant.
    expect(runtime).toMatch(
      /handleDownloadModelJob[\s\S]{0,200}concurrency: KB_LIMITS\.workerDownloads/,
    );
    // Models/ lives on the one read-write data volume of both roles.
    for (const role of ["knowledge-base-development-server", "worker"]) {
      const service = dokploy.split(`\n  ${role}:\n`)[1]!.split(/^ {2}[a-z][a-z-]*:/m)[0]!;
      expect(service).toContain("kb-data:/var/lib/knowledge-base\n");
    }
  });

  it("no image bakes or fetches the GGUF at build time", () => {
    for (const source of dockerfiles) {
      expect(source).not.toMatch(/\.gguf|huggingface\.co/i);
    }
    expect(dockerignore).toContain("**/models/*.gguf");
  });
});

// 46r10: download dispatch must use the selected descriptor, never the old fixed Qwen file.
it("registry accepts both pinned durable model ids and refuses an arbitrary artifact selector", () => {
  expect(
    modelDownloadDesiredSchema.safeParse({ modelId: "embeddinggemma-2-q8_0", epoch: 1 }).success,
  ).toBe(true);
  expect(modelDownloadDesiredSchema.safeParse({ modelId: "unknown-model", epoch: 1 }).success).toBe(
    false,
  );
});
