import { z } from "zod";
import { builtinModel, GEMMA_MODEL, QWEN_MODEL } from "./builtin-model";
import {
  assessBuiltinRuntimeConfig,
  QWEN_KV_TYPES,
  qwenRuntimeEstimates,
} from "./qwen-runtime-config";

const BUILTIN_CONTEXT_TIERS = [1024, 2048, 4096, 8192] as const;
export const builtinModelIdSchema = z.enum([GEMMA_MODEL.modelId, QWEN_MODEL.modelId]);
const selection = z.strictObject({
  modelId: builtinModelIdSchema,
  contextTokens: z.union([z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192)]),
  kvKeyType: z.enum(QWEN_KV_TYPES),
  kvValueType: z.enum(QWEN_KV_TYPES),
});
export const builtinSelectionSchema = selection.refine(
  (c) => builtinModel(c.modelId).causal || (c.kvKeyType === "f16" && c.kvValueType === "f16"),
  { message: "Gemma does not use a KV cache" },
);

/** Retrieval quality: Gemma first; measured tier quality 1K >= 2K >= 4K >= 8K.
 * Admission uses the worker's detected limit, never a host-memory guess.
 */
export function builtinRecommendations(budgetBytes: number | null) {
  const rows = [GEMMA_MODEL, QWEN_MODEL].flatMap((model) =>
    BUILTIN_CONTEXT_TIERS.map((contextTokens) => {
      const config = { contextTokens, kvKeyType: "f16" as const, kvValueType: "f16" as const };
      return {
        modelId: model.modelId,
        ...config,
        ...assessBuiltinRuntimeConfig(model, config, budgetBytes),
        recommended: false,
        smaller: false,
      };
    }),
  );
  const best = rows.find((r) => r.level === "ok" || r.level === "warn");
  if (best) {
    best.recommended = true;
    for (const row of rows)
      row.smaller = row.bytes < best.bytes && (row.level === "ok" || row.level === "warn");
  }
  return rows;
}

/** Preserve Qwen's admin cache controls alongside the eight measured model/tier rows. */
export function builtinRuntimeEstimates(budgetBytes: number | null) {
  const measured = builtinRecommendations(budgetBytes);
  const best = measured.find((r) => r.recommended);
  return [
    ...measured,
    ...qwenRuntimeEstimates(budgetBytes)
      .filter((r) => r.contextTokens <= 8192 && (r.kvKeyType !== "f16" || r.kvValueType !== "f16"))
      .map((r) => ({
        ...r,
        modelId: QWEN_MODEL.modelId,
        recommended: false,
        smaller: !!best && r.bytes < best.bytes && (r.level === "ok" || r.level === "warn"),
      })),
  ];
}
