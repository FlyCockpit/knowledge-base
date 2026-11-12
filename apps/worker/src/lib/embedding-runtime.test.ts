import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EMBEDDING_RUNTIME } from "@knowledge-base/api/lib/kb/builtin-model";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertLoadedRuntime, verifyEmbeddingRuntime } from "./embedding-runtime";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
describe("46r9 native provenance boundary", () => {
  let runtimeReadme = "";
  beforeAll(() => {
    runtimeReadme = readFileSync(resolve(import.meta.dirname, "../../native/README.md"), "utf8");
  }, 60_000);
  it("pins an unpatched upstream source and names the upstream change that retired the patches", () => {
    expect(Object.keys(EMBEDDING_RUNTIME).sort()).toEqual([
      "commit",
      "nodeLlamaCpp",
      "release",
      "sourceSha256",
      "sourceUrl",
    ]);
    expect(EMBEDDING_RUNTIME.sourceUrl).toBe(
      `https://github.com/ggml-org/llama.cpp/archive/refs/tags/${EMBEDDING_RUNTIME.release}.tar.gz`,
    );
    expect(runtimeReadme).toContain(EMBEDDING_RUNTIME.release);
    expect(runtimeReadme).toContain(EMBEDDING_RUNTIME.commit);
    expect(runtimeReadme).toContain("30445");
  });
  describe("runtime receipt verification", () => {
    const manifest = {
      runtime: EMBEDDING_RUNTIME,
      platform: process.platform,
      arch: process.arch,
      files: { "llama-addon.node": hash("test-addon") },
    };
    describe.each([
      { name: "intact CPU build", receipt: manifest, addon: "test-addon", error: null },
      {
        name: "changed source pin",
        receipt: { ...manifest, runtime: { ...EMBEDDING_RUNTIME, sourceSha256: "missing" } },
        addon: "test-addon",
        error: "embedding runtime provenance mismatch",
      },
      {
        name: "wrong architecture",
        receipt: { ...manifest, arch: "unsupported" },
        addon: "test-addon",
        error: "invalid runtime receipt",
      },
      {
        name: "path escape to an existing file",
        receipt: {
          ...manifest,
          files: { ...manifest.files, "../llama-addon.node": hash("test-addon") },
        },
        addon: "test-addon",
        error: "invalid runtime receipt",
      },
      {
        name: "missing addon entry",
        receipt: { ...manifest, files: {} },
        addon: "test-addon",
        error: "embedding runtime provenance mismatch",
      },
      {
        name: "changed binary",
        receipt: manifest,
        addon: "tampered-addon",
        error: "embedding runtime file mismatch",
      },
    ])("$name", ({ receipt, addon, error }) => {
      let root = "";
      let dir = "";
      beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "kb-runtime-proof-"));
        dir = join(root, "Release");
        mkdirSync(dir);
        // Real files, prepared outside the verification action's unchanged timeout.
        // The escape target exists and has the right hash, so missing files cannot mask the guard.
        writeFileSync(join(root, "llama-addon.node"), "test-addon");
        writeFileSync(join(dir, "llama-addon.node"), "test-addon");
        writeFileSync(join(dir, "kb-runtime.json"), JSON.stringify(manifest));
        expect(verifyEmbeddingRuntime(dir)).toMatchObject(manifest);
        // Mutate the same already-verified directory, so the next verification
        // still detects a cached success. Fixture writes belong to this hook's
        // I/O budget rather than the verification action's unchanged timeout.
        writeFileSync(join(dir, "llama-addon.node"), addon);
        writeFileSync(join(dir, "kb-runtime.json"), JSON.stringify(receipt));
      }, 60_000);
      afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
        root = "";
        dir = "";
      }, 60_000);
      it("verifies receipt and binary provenance", () => {
        if (error) expect(() => verifyEmbeddingRuntime(dir)).toThrow(error);
        else expect(verifyEmbeddingRuntime(dir)).toMatchObject(manifest);
      });
    });
  });
  it("actual loaded binary must be the verified local build, CPU only, with exact source release", () => {
    const runtime = {
      buildType: "localBuild",
      gpu: false,
      llamaCppRelease: { repo: "ggml-org/llama.cpp", release: EMBEDDING_RUNTIME.release },
    } as const;
    const folder = "/verified/Release";
    const maps = "r-xp /verified/Release/llama-addon.node\nr-xp /verified/Release/libllama.so";
    expect(() => assertLoadedRuntime(runtime, folder, maps)).not.toThrow();
    for (const change of [
      { buildType: "prebuilt" },
      { gpu: "cuda" },
      { llamaCppRelease: { repo: "other", release: EMBEDDING_RUNTIME.release } },
      { llamaCppRelease: { repo: "ggml-org/llama.cpp", release: "b1" } },
    ])
      expect(() => assertLoadedRuntime({ ...runtime, ...change }, folder, maps)).toThrow();
    expect(() => assertLoadedRuntime(runtime, folder, "r-xp /prebuilt/llama-addon.node")).toThrow();
    expect(() =>
      assertLoadedRuntime(runtime, folder, maps, { "llama-addon.node": "unused" }),
    ).toThrow();
  });
});
