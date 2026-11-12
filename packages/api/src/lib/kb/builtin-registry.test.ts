import { describe, expect, it } from "vitest";
import { BUILTIN_MODELS, GEMMA_MODEL, QWEN_MODEL } from "./builtin-model";
import { builtinRecommendations, builtinSelectionSchema } from "./builtin-registry";
import { estimateBuiltinPeakBytes } from "./qwen-runtime-config";

const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
describe("46r10 built-in registry and recommendation", () => {
  it("has exactly the two pinned optional models and four measured tiers each", () => {
    const rows = builtinRecommendations(null);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.level === "unknown" && !r.recommended && !r.smaller)).toBe(true);
    for (const model of Object.values(BUILTIN_MODELS)) {
      expect(model.url).toMatch(/\/resolve\/[a-f0-9]{40}\//);
      expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(rows.filter((r) => r.modelId === model.modelId).map((r) => r.contextTokens)).toEqual([
        1024, 2048, 4096, 8192,
      ]);
    }
  });
  it.each([512, 1024, 1280, 1536, 2048, 4096])(
    "ranks quality first at %i MiB and offers only strictly smaller fitting alternatives",
    (mib) => {
      const rows = builtinRecommendations(mib * 1024 ** 2);
      const fitting = rows.filter((r) => r.level === "ok" || r.level === "warn");
      const best = rows.find((r) => r.recommended);
      if (!fitting.length) expect(best).toBeUndefined();
      else {
        expect(best).toMatchObject({ modelId: GEMMA_MODEL.modelId, contextTokens: 1024 });
        expect(rows.filter((r) => r.recommended)).toHaveLength(1);
        for (const row of rows.filter((r) => r.smaller)) {
          expect(row.bytes).toBeLessThan(best!.bytes);
          expect(["ok", "warn"]).toContain(row.level);
        }
      }
      for (const row of rows)
        expect(row.bytes).toBe(
          estimateBuiltinPeakBytes(BUILTIN_MODELS[row.modelId]!, {
            contextTokens: row.contextTokens,
            kvKeyType: row.kvKeyType,
            kvValueType: row.kvValueType,
          }),
        );
    },
  );
  it("blocks at exactly 90%, permits below it, and requires known memory for recommendation", () => {
    const need = estimateBuiltinPeakBytes(GEMMA_MODEL, config);
    expect(
      builtinRecommendations(need / 0.9).find(
        (r) => r.modelId === GEMMA_MODEL.modelId && r.contextTokens === 1024,
      ),
    ).toMatchObject({ level: "block", recommended: false });
    expect(builtinRecommendations(need / 0.899).some((r) => r.recommended)).toBe(true);
    expect(builtinRecommendations(0).every((r) => !r.recommended)).toBe(true);
  });
  it("accepts only registered model/tier/cache selections, never URLs, hashes, unknown ids or unmeasured tiers", () => {
    for (const model of [GEMMA_MODEL, QWEN_MODEL])
      expect(builtinSelectionSchema.parse({ ...config, modelId: model.modelId })).toMatchObject({
        ...config,
        modelId: model.modelId,
      });
    for (const extra of [
      { modelId: "__proto__" },
      { contextTokens: 16384 },
      { url: QWEN_MODEL.url },
      { sha256: QWEN_MODEL.sha256 },
    ])
      expect(
        builtinSelectionSchema.safeParse({ ...config, modelId: GEMMA_MODEL.modelId, ...extra })
          .success,
      ).toBe(false);
    expect(
      builtinSelectionSchema.safeParse({
        ...config,
        modelId: GEMMA_MODEL.modelId,
        kvValueType: "q4_0",
      }).success,
    ).toBe(false);
  });
});
