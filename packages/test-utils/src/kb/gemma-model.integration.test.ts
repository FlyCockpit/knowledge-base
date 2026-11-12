import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GEMMA_MODEL, QWEN_MODEL } from "@knowledge-base/api/lib/kb/builtin-model";
import {
  retrievalCorpus,
  scoreRetrieval,
  unitVector,
} from "@knowledge-base/api/lib/kb/index-file/testing";
import { downloadModelArtifact } from "@knowledge-base/api/lib/kb/model-artifact";
import { estimateBuiltinPeakBytes } from "@knowledge-base/api/lib/kb/qwen-runtime-config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildArtifactPath, requireBuiltArtifact } from "./build-artifacts.mjs";
import { modelInference } from "./model-inference";
import { expectRawEmbedding, normalizationFixture } from "./raw-embedding";

// Dynamic URL avoids crossing this composite project's root.
const { createQwenSupervisor } = await import(
  new URL("../../../../apps/worker/src/lib/qwen-lifecycle.ts", import.meta.url).href
);
const { probeQwenRuntime } = await import(
  new URL("../../../../apps/worker/src/lib/qwen-probe.ts", import.meta.url).href
);
const root = resolve(import.meta.dirname, "../../../..");
const scratch = mkdtempSync(join(tmpdir(), "kb-gemma-test-"));
const modelPath = process.env.KB_GEMMA_MODEL_PATH;
const reference = JSON.parse(
  readFileSync(join(import.meta.dirname, "gemma-reference.json"), "utf8"),
) as {
  items: Array<{ id: string; purpose: "query" | "document"; text: string; vector: number[] }>;
};
const supervisors: Array<{ close(): Promise<void> }> = [];
const runtime = (contextTokens: number) => ({
  modelId: GEMMA_MODEL.modelId,
  epoch: 1,
  config: { contextTokens, kvKeyType: "f16", kvValueType: "f16" } as const,
});
function make() {
  if (!modelPath) throw new Error("KB_GEMMA_MODEL_PATH required; no skip path");
  const supervisor = createQwenSupervisor({
    childEntry: join(root, "apps/worker/dist/qwen-child.mjs"),
    modelPath,
    guardPath: buildArtifactPath("child-guard"),
    lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
  });
  supervisors.push(supervisor);
  return supervisor;
}
beforeAll(() => {
  requireBuiltArtifact(
    join(root, "apps/worker/dist/qwen-child.mjs"),
    "pnpm test:kb --build-only qwen-model",
    false,
  );
  requireBuiltArtifact(buildArtifactPath("child-guard"), "pnpm test:kb --build-only qwen-model");
});
afterEach(async () => {
  // Also restore on a Vitest wall-clock timeout, before closing/reaping children.
  vi.useRealTimers();
  for (const s of supervisors.splice(0)) await s.close();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const cosine = (a: number[], b: number[]) =>
  a.reduce((s, v, i) => s + v * b[i]!, 0) / (Math.hypot(...a) * Math.hypot(...b));
describe("46r9 real Gemma runtime", () => {
  it.each([QWEN_MODEL, GEMMA_MODEL])(
    "downloads $modelId through production HTTPS/DNS/redirect/hash publication from an empty volume",
    { timeout: 300_000 },
    async (model) => {
      const dir = mkdtempSync(join(scratch, "download-"));
      try {
        const result = await downloadModelArtifact({
          dir,
          epoch: 1,
          expected: model,
          signal: AbortSignal.timeout(290_000),
          onProgress: () => {},
        });
        expect(result.outcome).toBe("PUBLISHED");
        expect(result.path).toBe(join(dir, model.fileName));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
  it(
    "READY capability probe at the smallest tier accepts Gemma query/document and reaps the child",
    {
      timeout: 180_000,
    },
    modelInference(async () => {
      const config = runtime(1024).config;
      const measured = await probeQwenRuntime({
        modelId: GEMMA_MODEL.modelId,
        childEntry: join(root, "apps/worker/dist/qwen-child.mjs"),
        modelPath: modelPath ?? "",
        guardPath: buildArtifactPath("child-guard"),
        config,
      });
      expect(measured.dimensions).toBe(GEMMA_MODEL.dimensions);
      expect(measured.peakRssBytes).toBeGreaterThan(0);
      expect(measured.peakRssBytes).toBeLessThan(estimateBuiltinPeakBytes(GEMMA_MODEL, config));
    }),
  );
  it(
    "all 39 inputs agree with Google's float32 reference, including empty query, Unicode and >512-token document",
    {
      timeout: 600_000,
    },
    modelInference(async () => {
      const supervisor = make();
      let min = 1;
      for (const item of reference.items) {
        const [vector] = await supervisor.embed({
          purpose: item.purpose,
          texts: [item.text],
          runtime: runtime(4096),
        });
        expectRawEmbedding(vector, GEMMA_MODEL.modelId);
        const score = cosine(vector, item.vector);
        expect(score, item.id).toBeGreaterThanOrEqual(0.999);
        min = Math.min(min, score);
      }
      console.log(
        `GEMMA_REFERENCE ${JSON.stringify({ inputs: reference.items.length, minCosine: min })}`,
      );
    }),
  );
  // Share the bounded CPU measurement budget with the Qwen tiers. Product
  // deadline behavior is asserted independently in qwen-lifecycle.test.ts.
  it.each([1024, 2048, 4096, 8192])(
    "fills %i-token tier in one sequence, peak under patched formula, overflow rejects while same child survives",
    { timeout: 1_260_000 },
    modelInference(async (contextTokens: number) => {
      const supervisor = make();
      const rt = runtime(contextTokens);
      const measured = await supervisor.probe(rt, { timeoutMs: 1_200_000 });
      expect(measured.peakRssBytes).toBeGreaterThan(0);
      expect(measured.peakRssBytes).toBeLessThan(estimateBuiltinPeakBytes(GEMMA_MODEL, rt.config));
      const [warm] = await supervisor.embed({ purpose: "document", texts: ["hello"], runtime: rt });
      expect(warm).toHaveLength(768);
      const pid = supervisor.snapshot().pid;
      await expect(
        supervisor.embed({ purpose: "document", texts: [" a".repeat(contextTokens)], runtime: rt }),
      ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LONG" });
      expect(supervisor.snapshot().pid).toBe(pid);
      const [again] = await supervisor.embed({
        purpose: "document",
        texts: ["hello"],
        runtime: rt,
      });
      expect(again).toEqual(warm);
      console.log(
        `GEMMA_TIER ${JSON.stringify({ contextTokens, peakRssBytes: measured.peakRssBytes, estimate: estimateBuiltinPeakBytes(GEMMA_MODEL, rt.config) })}`,
      );
    }),
  );
});

it("46r10 one supervisor switches Qwen to Gemma and back, choosing each artifact and dimension, reaping the previous child", {
  timeout: 180_000,
}, async () => {
  const qwenPath = process.env.KB_QWEN_MODEL_PATH;
  if (!qwenPath || !modelPath) throw new Error("Both pinned artifacts are required");
  const dir = mkdtempSync(join(scratch, "selection-"));
  symlinkSync(qwenPath, join(dir, QWEN_MODEL.fileName));
  symlinkSync(modelPath, join(dir, GEMMA_MODEL.fileName));
  const supervisor = createQwenSupervisor({
    modelPath: qwenPath,
    modelsDir: dir,
    childEntry: join(root, "apps/worker/dist/qwen-child.mjs"),
    guardPath: buildArtifactPath("child-guard"),
    lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
  });
  supervisors.push(supervisor);
  let previous: number | null = null;
  for (const [index, model] of [QWEN_MODEL, GEMMA_MODEL, QWEN_MODEL].entries()) {
    const [vector] = await modelInference(() =>
      supervisor.embed({
        purpose: "query",
        texts: ["bread"],
        runtime: { ...runtime(1024), epoch: index + 1, modelId: model.modelId },
      }),
    )();
    expectRawEmbedding(vector, model.modelId);
    const pid = supervisor.snapshot().pid;
    expect(pid).not.toBeNull();
    expect(pid).not.toBe(previous);
    if (previous) expect(() => readFileSync(`/proc/${previous}/stat`)).toThrow();
    previous = pid;
  }
  await supervisor.close();
  expect(() => readFileSync(`/proc/${previous}/stat`)).toThrow();
});

// Server/CLI normalization parity: the shared fixture records each built-in model's raw
// output for fixed inputs and the index format's one normalization of it. The CLI checks the same
// bytes (kb-local index_format tests) and its own live model output (tests/qwen_model.rs).
it("real-model normalization parity: live raw vectors normalize to the shared fixture's unit vectors", {
  timeout: 600_000,
}, async () => {
  const qwenPath = process.env.KB_QWEN_MODEL_PATH;
  if (!qwenPath || !modelPath) throw new Error("Both pinned artifacts are required");
  const fixture = normalizationFixture;
  const dir = mkdtempSync(join(scratch, "normalization-"));
  symlinkSync(qwenPath, join(dir, QWEN_MODEL.fileName));
  symlinkSync(modelPath, join(dir, GEMMA_MODEL.fileName));
  const supervisor = createQwenSupervisor({
    modelPath: qwenPath,
    modelsDir: dir,
    childEntry: join(root, "apps/worker/dist/qwen-child.mjs"),
    guardPath: buildArtifactPath("child-guard"),
    lease: { acquire: async () => true, renew: async () => true, release: async () => {} },
  });
  supervisors.push(supervisor);
  const hex = (unit: Float32Array) =>
    Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength).toString("hex");
  for (const [index, model] of [QWEN_MODEL, GEMMA_MODEL].entries()) {
    for (const item of fixture.items) {
      const [raw] = await modelInference(() =>
        supervisor.embed({
          purpose: item.purpose,
          texts: [item.text],
          runtime: { ...runtime(1024), epoch: index + 1, modelId: model.modelId },
        }),
      )();
      expectRawEmbedding(raw, model.modelId);
      const unit = unitVector(raw, model.dimensions);
      const recorded = fixture.models[model.modelId]!.find((row) => row.id === item.id)!;
      // Same input: the live raw magnitude matches the recorded one (raw, not pre-normalized).
      expect(Math.abs(Math.hypot(...raw) / Math.hypot(...recorded.raw) - 1)).toBeLessThan(0.01);
      // Same raw input -> the exact recorded bytes (the CLI asserts these bytes too).
      const replay = unitVector(recorded.raw, model.dimensions);
      expect(hex(replay)).toBe(recorded.unitF32Hex);
      // The live model reproduces the recorded direction.
      expect(cosine(Array.from(unit), Array.from(replay))).toBeGreaterThanOrEqual(0.9999);
    }
  }
});

// Real-model lane (CLI twin `qwen_model::gemma_retrieval_quality`): the shared corpus embedded
// by the real Gemma 1K child, built through the real writer and ranked by the real hybrid read.
it("retrieval quality: real Gemma hybrid search ranks the shared semantic and keyword queries", {
  timeout: 600_000,
}, async () => {
  const supervisor = make();
  const rt = runtime(1024);
  const embed = (purpose: "query" | "document", text: string) =>
    modelInference(async () => {
      const [vector] = await supervisor.embed({ purpose, texts: [text], runtime: rt });
      return vector!;
    })();
  const score = await scoreRetrieval(mkdtempSync(join(scratch, "retrieval-")), {
    dimensions: GEMMA_MODEL.dimensions,
    document: (_path, text) => embed("document", text),
    query: (text) => embed("query", text),
  });
  console.log(`GEMMA_RETRIEVAL ${JSON.stringify(score)}`);
  const t = retrievalCorpus.thresholds.gemma;
  expect(score.semanticHit1, JSON.stringify(score)).toBeGreaterThanOrEqual(t.semanticHit1);
  expect(score.semanticHit3, JSON.stringify(score)).toBeGreaterThanOrEqual(t.semanticHit3);
  expect(score.keywordHit1, JSON.stringify(score)).toBeGreaterThanOrEqual(t.keywordHit1);
});
