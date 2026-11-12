import { describe, expect, it, vi } from "vitest";
import { mutateAsset } from "./assets";
import { buildChangesApplyRequest, createChangesPublication } from "./changes";
import { canonicalManifestBytes } from "./manifest";
import { stageCommitWithTreeFiles } from "./staged-tree";
import { validateStagedCommitTree } from "./validate-tree";

vi.mock("./changes", async (original) => ({
  ...(await original<typeof import("./changes")>()),
  createChangesPublication: vi.fn(() => ({ barrier: {}, publish: vi.fn() })),
}));

describe("asset commit titles", () => {
  it("name the path and stay within the 200-character title bound", async () => {
    const runtime = { prisma: {}, coordinator: { run: vi.fn(async () => null) } };
    for (const path of ["media/p.png", `media/${"x".repeat(191)}.png`]) {
      vi.mocked(createChangesPublication).mockClear();
      await mutateAsset(runtime as never, "user-1", "put", {
        kbId: "a".repeat(24),
        baseRevision: "b".repeat(40),
        idempotencyKey: "k".repeat(16),
        path,
        uploadId: "00000000-0000-4000-8000-000000000001",
      });
      const request = vi.mocked(createChangesPublication).mock.calls[0]![0].request as {
        mode: "edit";
        title: string;
      };
      expect(Array.from(request.title).length).toBeLessThanOrEqual(200);
      expect(request.title.startsWith("Add asset media/")).toBe(true);
      expect(() => buildChangesApplyRequest(request as never)).not.toThrow();
    }
    expect(Array.from(`Add asset media/${"x".repeat(191)}.png`).length).toBeGreaterThan(200);
  });
});

const asset = {
  path: "media/p.png",
  hash: `sha256:${"a".repeat(64)}`,
  size: 20,
  mime: "image/png",
};
const stage = (entries: (typeof asset)[]) =>
  stageCommitWithTreeFiles({
    parentSha: "a".repeat(40),
    message: "fixture",
    files: [
      { segments: ["index.md"], content: Buffer.from("# Title\n") },
      { segments: [".gitignore"], content: Buffer.from("# kb managed\n") },
      {
        segments: [".assets", "manifest.json"],
        content: canonicalManifestBytes({ version: 1, entries }),
      },
    ],
  });
describe("asset tree publication", () => {
  it("accepts the initial empty tree and rejects untrusted nonempty trees by default", () => {
    expect(validateStagedCommitTree(stage([])).ok).toBe(true);
    expect(validateStagedCommitTree(stage([asset]))).toMatchObject({
      ok: false,
      code: "TREE_MANIFEST",
    });
  });
  it("requires both exact catalog metadata and lineage on the final candidate tree", () => {
    const context = {
      trustedBlobs: new Map([[asset.hash, asset]]),
      lineageHashes: new Set([asset.hash]),
    };
    expect(validateStagedCommitTree(stage([asset]), context).ok).toBe(true);
    expect(validateStagedCommitTree(stage([{ ...asset, size: 19 }]), context).ok).toBe(false);
    expect(
      validateStagedCommitTree(stage([asset]), { ...context, lineageHashes: new Set() }).ok,
    ).toBe(false);
    expect(validateStagedCommitTree(stage([{ ...asset, path: "INDEX.md" }]), context).ok).toBe(
      false,
    );
  });
});
