import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});

vi.mock("../lib/procedure-budget", () => ({
  createProcedureBudget: () => async () => {},
}));

vi.mock("../lib/kb/uploads", () => ({
  uploadBegin: vi.fn(async () => ({
    operationId: "op",
    uploadId: "00000000-0000-4000-8000-000000000001",
    offset: 0,
    expiresAt: new Date().toISOString(),
    maxChunkBytes: 196608,
  })),
  uploadWrite: vi.fn(),
  uploadFinish: vi.fn(),
  UPLOAD_MAX_CHUNK_BYTES: 196608,
}));

import { configureKbRuntime, resetKbRuntimeForTests } from "../lib/kb/runtime";
import { kbUploadsRouter } from "./kb-uploads";

describe("kbUploads router", () => {
  beforeEach(() => {
    resetKbRuntimeForTests();
    configureKbRuntime({
      prisma: {} as never,
      connectionString: "postgres://local/test",
      reposDir: "/tmp/repos",
      assetsDir: "/tmp/assets",
      blobStore: createDiskBlobStore("/tmp/assets"),
      canonicalOrigin: "https://kb.example.com",
      cursorSigner: {
        sign: () => "cursor",
        verify: () => {
          throw new Error("unused");
        },
      },
      ratePort: { consume: async () => ({ ok: true }) },
      diskMeter: { freeBytes: async () => 1_000_000_000n },
      coordinator: {
        run: async ({ run }) =>
          run({
            lease: {} as never,
            signal: new AbortController().signal,
            issueWriteCapability: () => ({}) as never,
          }),
      },
    });
  });

  it("requires authentication", async () => {
    const client = createRouterClient(kbUploadsRouter, { context: () => ({ session: null }) });
    await expect(
      client.begin({
        kbId: "kb",
        idempotencyKey: "idem-key-idem-key-idem",
        kind: "markdown",
        size: 1,
        contentHash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        mime: "text/markdown",
      }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
