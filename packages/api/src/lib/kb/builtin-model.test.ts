import { describe, expect, it } from "vitest";
import { BUILTIN_MODELS, builtinModel, GEMMA_MODEL, QWEN_MODEL } from "./builtin-model";
import { builtinEmbeddingFingerprint, builtinModelIdentity } from "./fingerprint";
import descriptors from "./fixtures/builtin-models.json" with { type: "json" };
import { QWEN_ARTIFACT } from "./model-artifact";
import {
  assessBuiltinRuntimeConfig,
  chooseBuiltinProbeMode,
  estimateBuiltinPeakBytes,
} from "./qwen-runtime-config";

const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
const MiB = 1024 ** 2;
describe("46r9 model contract", () => {
  it("TS consumes the single Rust/TS descriptor fixture without divergent constants", () => {
    expect(Object.values(BUILTIN_MODELS).map(({ runtime: _runtime, ...model }) => model)).toEqual(
      descriptors.models,
    );
    expect(descriptors.defaultModel).toBe(GEMMA_MODEL.modelId);
    expect(descriptors.defaultContext).toBe(1024);
  });
  it("has exactly two optional descriptors, pinned by commit and checksum; legacy default remains Qwen", () => {
    expect(Object.keys(BUILTIN_MODELS)).toEqual([QWEN_MODEL.modelId, GEMMA_MODEL.modelId]);
    expect(QWEN_ARTIFACT).toMatchObject({
      modelId: QWEN_MODEL.modelId,
      dimensions: 1024,
      pooling: "LAST",
    });
    expect(QWEN_MODEL.batchTokens).toBe(512);
    expect(GEMMA_MODEL).toMatchObject({
      dimensions: 768,
      pooling: "MEAN",
      causal: false,
      addBos: true,
      bosTokenId: 2,
      eosTokenId: 1,
      sizeBytes: 309855456,
      sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
      queryPrefix: "task: search result | query: ",
      documentPrefix: "title: none | text: ",
    });
    for (const model of Object.values(BUILTIN_MODELS)) {
      expect(model.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(model.contextTiers).toEqual([1024, 2048, 4096, 8192]);
      expect(builtinModel(model.modelId)).toBe(model);
    }
    expect(() => builtinModel("unknown")).toThrow();
  });
  it("budgets against patched peaks at every offered tier, without letting measurements lower the envelope", () => {
    const peaks = {
      gemma: [998.5, 1125.9, 1363.7, 1997.4],
      qwen: [1085.5, 1200.9, 1431.2, 1884.9],
    };
    for (const [model, values] of [
      [GEMMA_MODEL, peaks.gemma],
      [QWEN_MODEL, peaks.qwen],
    ] as const)
      for (const [i, contextTokens] of model.contextTiers.entries()) {
        const cfg = { ...config, contextTokens };
        const bytes = estimateBuiltinPeakBytes(model, cfg);
        expect(bytes / MiB).toBeGreaterThan(values[i]!);
        expect(bytes / MiB).toBeLessThan(values[i]! * 1.35);
        expect(assessBuiltinRuntimeConfig(model, cfg, null).level).toBe("unknown");
        expect(assessBuiltinRuntimeConfig(model, cfg, bytes / 0.7).level).toBe("ok");
        expect(assessBuiltinRuntimeConfig(model, cfg, bytes / 0.71).level).toBe("warn");
        expect(assessBuiltinRuntimeConfig(model, cfg, bytes / 0.9).level).toBe("block");
        expect(assessBuiltinRuntimeConfig(model, cfg, bytes / 0.91).level).toBe("block");
      }
  });
  it("Gemma's budget ignores KV types and never extrapolates beyond the measured cap", () => {
    expect(
      estimateBuiltinPeakBytes(GEMMA_MODEL, { ...config, kvKeyType: "q4_0", kvValueType: "q4_0" }),
    ).toBe(estimateBuiltinPeakBytes(GEMMA_MODEL, config));
    expect(() =>
      estimateBuiltinPeakBytes(GEMMA_MODEL, { ...config, contextTokens: 16384 }),
    ).toThrow();
  });
  it("probe budgets share weights only for the same artifact, unknown budget stays exclusive", () => {
    const same = chooseBuiltinProbeMode({
      activeModel: GEMMA_MODEL,
      candidateModel: GEMMA_MODEL,
      active: config,
      candidate: config,
      activePeakBytes: null,
      budgetBytes: 8 * 1024 ** 3,
    });
    expect(same.combinedBytes).toBe(
      2 * estimateBuiltinPeakBytes(GEMMA_MODEL, config) - GEMMA_MODEL.sizeBytes,
    );
    const different = chooseBuiltinProbeMode({
      activeModel: QWEN_MODEL,
      candidateModel: GEMMA_MODEL,
      active: config,
      candidate: config,
      activePeakBytes: null,
      budgetBytes: null,
    });
    expect(different.combinedBytes).toBe(
      estimateBuiltinPeakBytes(QWEN_MODEL, config) + estimateBuiltinPeakBytes(GEMMA_MODEL, config),
    );
    expect(different.mode).toBe("exclusive");
  });
  it("identity separates models and binds artifact, tokenizer, prompts, pooling and native source pins", () => {
    const identity = builtinModelIdentity(GEMMA_MODEL);
    expect(identity).not.toBe(builtinModelIdentity(QWEN_MODEL));
    for (const change of [
      { modelId: "changed" },
      { sha256: "f".repeat(64) },
      { queryPrefix: "other" },
      { documentPrefix: "other" },
      { dimensions: 256 },
      { pooling: "LAST" as const },
      { bosTokenId: 9 },
      { causal: true },
    ])
      expect(builtinModelIdentity({ ...GEMMA_MODEL, ...change })).not.toBe(identity);
    for (const key of ["sourceSha256", "commit", "release", "nodeLlamaCpp"] as const)
      expect(
        builtinModelIdentity(GEMMA_MODEL, { ...GEMMA_MODEL.runtime, [key]: "changed" }),
      ).not.toBe(identity);
    expect(builtinEmbeddingFingerprint(GEMMA_MODEL, config)).not.toBe(
      builtinEmbeddingFingerprint(GEMMA_MODEL, { ...config, contextTokens: 2048 }),
    );
  });
});
