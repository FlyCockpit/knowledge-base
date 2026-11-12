import { describe, expect, it } from "vitest";
import { GEMMA_MODEL, QWEN_MODEL } from "./builtin-model";
import { QWEN_ARTIFACT } from "./model-artifact";
import {
  assessQwenRuntimeConfig,
  chooseBuiltinProbeMode,
  DEFAULT_QWEN_RUNTIME_CONFIG,
  estimateBuiltinPeakBytes,
  estimateQwenPeakBytes,
  kvBytesPerToken,
  paddedContextTokens,
  QWEN_BATCH_TOKENS,
  QWEN_BLOCK_RATIO,
  QWEN_CONTEXT_OPTIONS,
  QWEN_KV_TYPES,
  QWEN_WARN_RATIO,
  QWEN_WEIGHTS_BYTES,
  type QwenRuntimeConfig,
  qwenMemoryEstimate,
  qwenRuntimeConfigSchema,
  qwenRuntimeEstimates,
} from "./qwen-runtime-config";

const MiB = 1024 * 1024;

describe("built-in Qwen runtime config", () => {
  it("accepts exactly the decided value sets and defaults to {4096, f16, f16}", () => {
    expect(QWEN_CONTEXT_OPTIONS).toEqual([1024, 2048, 4096, 8192, 16384, 32768]);
    expect(QWEN_KV_TYPES).toEqual(["f16", "q8_0", "q4_0"]);
    expect(DEFAULT_QWEN_RUNTIME_CONFIG).toEqual({
      contextTokens: 4096,
      kvKeyType: "f16",
      kvValueType: "f16",
    });
    expect(QWEN_BATCH_TOKENS).toBe(512);
    for (const contextTokens of QWEN_CONTEXT_OPTIONS)
      for (const kvKeyType of QWEN_KV_TYPES)
        for (const kvValueType of QWEN_KV_TYPES)
          expect(
            qwenRuntimeConfigSchema.safeParse({ contextTokens, kvKeyType, kvValueType }).success,
          ).toBe(true);
    for (const bad of [
      { ...DEFAULT_QWEN_RUNTIME_CONFIG, contextTokens: 4097 },
      { ...DEFAULT_QWEN_RUNTIME_CONFIG, contextTokens: 512 },
      { ...DEFAULT_QWEN_RUNTIME_CONFIG, kvKeyType: "q4_1" },
      { ...DEFAULT_QWEN_RUNTIME_CONFIG, kvValueType: "f32" },
      { ...DEFAULT_QWEN_RUNTIME_CONFIG, batchSize: 4096 },
      { contextTokens: 4096, kvKeyType: "f16" },
    ])
      expect(qwenRuntimeConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("KV bytes per token follow 28 layers x 8 KV heads x 128 dims with f16 2, q8_0 34/32, q4_0 18/32", () => {
    const elements = 28 * 8 * 128;
    expect(kvBytesPerToken("f16", "f16")).toBe(elements * 4);
    expect(kvBytesPerToken("q8_0", "q8_0")).toBe(elements * (34 / 32) * 2);
    expect(kvBytesPerToken("q8_0", "q4_0")).toBe(elements * (34 / 32 + 18 / 32));
    expect(kvBytesPerToken("f16", "q4_0")).toBe(elements * (2 + 18 / 32));
  });

  it("pads the context (N + 1 slot) up to node-llama-cpp's multiple of 256", () => {
    expect(paddedContextTokens(4096)).toBe(4352);
    expect(paddedContextTokens(8192)).toBe(8448);
    expect(paddedContextTokens(1024)).toBe(1280);
  });

  it("the patched estimator conservatively covers the fresh-process peaks", () => {
    const measured = [
      [1024, 1085.5],
      [2048, 1200.9],
      [4096, 1431.2],
      [8192, 1884.9],
    ] as const;
    for (const [contextTokens, peak] of measured) {
      const estimate =
        estimateQwenPeakBytes({ contextTokens, kvKeyType: "f16", kvValueType: "f16" }) / MiB;
      expect(estimate).toBeGreaterThan(peak);
      expect(estimate).toBeLessThan(peak * 1.1);
    }
  });

  it("lists every option with the conservative formula labelled estimated and its budget percent", () => {
    const budget = 4 * 1024 * MiB;
    const rows = qwenRuntimeEstimates(budget);
    expect(rows).toHaveLength(QWEN_CONTEXT_OPTIONS.length * QWEN_KV_TYPES.length ** 2);
    const byKey = new Map(
      rows.map((r) => [`${r.contextTokens}:${r.kvKeyType}:${r.kvValueType}`, r]),
    );
    expect(byKey.get("4096:f16:f16")).toMatchObject({ source: "estimated" });
    expect(byKey.get("4096:f16:q4_0")).toMatchObject({ source: "estimated" });
    for (const row of rows) {
      expect(row.percent).toBeCloseTo((row.bytes / budget) * 100, 6);
      expect(row.level).toBe(assessQwenRuntimeConfig(row, budget).level);
    }
    // No budget reported yet: every option is unknown, never silently "ok".
    for (const row of qwenRuntimeEstimates(null)) {
      expect(row.percent).toBeNull();
      expect(row.level).toBe("unknown");
    }
  });

  it("classifies > 70% as warn and >= 90% as block; 70% stays in the lower band", () => {
    const config = DEFAULT_QWEN_RUNTIME_CONFIG;
    const { bytes } = qwenMemoryEstimate(config);
    expect(QWEN_WARN_RATIO).toBe(0.7);
    expect(QWEN_BLOCK_RATIO).toBe(0.9);
    expect(assessQwenRuntimeConfig(config, bytes / 0.7).level).toBe("ok");
    expect(assessQwenRuntimeConfig(config, bytes / 0.71).level).toBe("warn");
    expect(assessQwenRuntimeConfig(config, bytes / 0.9).level).toBe("block");
    expect(assessQwenRuntimeConfig(config, bytes / 0.91).level).toBe("block");
    expect(assessQwenRuntimeConfig(config, null).level).toBe("unknown");
  });
});

describe("adaptive config probe placement", () => {
  const active: QwenRuntimeConfig = DEFAULT_QWEN_RUNTIME_CONFIG;
  const candidate: QwenRuntimeConfig = {
    contextTokens: 8192,
    kvKeyType: "f16",
    kvValueType: "f16",
  };
  const activeBytes = qwenMemoryEstimate(active).bytes;
  const candidateBytes = qwenMemoryEstimate(candidate).bytes;
  // Two children share one mmapped weights file: counted once.
  const combined = activeBytes + candidateBytes - QWEN_WEIGHTS_BYTES;

  it("counts the mmapped weights exactly once (the artifact size)", () => {
    expect(QWEN_WEIGHTS_BYTES).toBe(QWEN_ARTIFACT.sizeBytes);
    const decision = chooseBuiltinProbeMode({
      activeModel: QWEN_MODEL,
      candidateModel: QWEN_MODEL,
      active,
      activePeakBytes: null,
      candidate,
      budgetBytes: 64 * 1024 * MiB,
    });
    expect(decision.combinedBytes).toBe(combined);
  });

  it("probes side by side when old child + probe child fit under the 90% block level", () => {
    const budget = combined / 0.899;
    expect(
      chooseBuiltinProbeMode({
        activeModel: QWEN_MODEL,
        candidateModel: QWEN_MODEL,
        active,
        activePeakBytes: null,
        candidate,
        budgetBytes: budget,
      }).mode,
    ).toBe("side-by-side");
    // Would NOT fit if the weights were counted twice: the dedup is load-bearing.
    expect(activeBytes + candidateBytes).toBeGreaterThan(QWEN_BLOCK_RATIO * budget);
  });

  it("stops the current child first when both would exceed the 90% block level", () => {
    const budget = Math.floor(combined / QWEN_BLOCK_RATIO) - 1;
    expect(
      chooseBuiltinProbeMode({
        activeModel: QWEN_MODEL,
        candidateModel: QWEN_MODEL,
        active,
        activePeakBytes: null,
        candidate,
        budgetBytes: budget,
      }).mode,
    ).toBe("exclusive");
  });

  it("uses the measured peak of the running config when one was recorded", () => {
    const budget = Math.ceil(combined / QWEN_BLOCK_RATIO);
    const decision = chooseBuiltinProbeMode({
      activeModel: QWEN_MODEL,
      candidateModel: QWEN_MODEL,
      active,
      activePeakBytes: activeBytes + 512 * MiB,
      candidate,
      budgetBytes: budget,
    });
    expect(decision.combinedBytes).toBe(combined + 512 * MiB);
    expect(decision.mode).toBe("exclusive");
  });

  it("an unknown budget never risks two children", () => {
    expect(
      chooseBuiltinProbeMode({
        activeModel: QWEN_MODEL,
        candidateModel: QWEN_MODEL,
        active,
        activePeakBytes: null,
        candidate,
        budgetBytes: null,
      }).mode,
    ).toBe("exclusive");
  });
  it.each([
    { activeModel: QWEN_MODEL, candidateModel: QWEN_MODEL },
    { activeModel: GEMMA_MODEL, candidateModel: GEMMA_MODEL },
    { activeModel: QWEN_MODEL, candidateModel: GEMMA_MODEL },
    { activeModel: GEMMA_MODEL, candidateModel: QWEN_MODEL },
  ])(
    "blocks combined children at exactly90% for $activeModel.modelId -> $candidateModel.modelId",
    ({ activeModel, candidateModel }) => {
      const combinedBytes =
        estimateBuiltinPeakBytes(activeModel, active) +
        estimateBuiltinPeakBytes(candidateModel, candidate) -
        (activeModel.sha256 === candidateModel.sha256 ? activeModel.sizeBytes : 0);
      const input = { activeModel, candidateModel, active, candidate, activePeakBytes: null };
      expect(chooseBuiltinProbeMode({ ...input, budgetBytes: combinedBytes / 0.9 }).mode).toBe(
        "exclusive",
      );
      expect(chooseBuiltinProbeMode({ ...input, budgetBytes: combinedBytes / 0.901 }).mode).toBe(
        "exclusive",
      );
      expect(chooseBuiltinProbeMode({ ...input, budgetBytes: combinedBytes / 0.899 }).mode).toBe(
        "side-by-side",
      );
      expect(chooseBuiltinProbeMode({ ...input, budgetBytes: null }).mode).toBe("exclusive");
    },
  );
});
