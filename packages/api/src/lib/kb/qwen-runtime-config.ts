/** Built-in runtime configuration and patched CPU memory admission. */

import { z } from "zod";
import { type BuiltinModelDescriptor, QWEN_MODEL } from "./builtin-model";
import descriptors from "./fixtures/builtin-models.json" with { type: "json" };

export const QWEN_CONTEXT_OPTIONS = [1024, 2048, 4096, 8192, 16384, 32768] as const;
export const QWEN_KV_TYPES = ["f16", "q8_0", "q4_0"] as const;
export type QwenKvType = (typeof QWEN_KV_TYPES)[number];

/** Decode batch (and ubatch) size, independent of the context. */
export const QWEN_BATCH_TOKENS = 512;

export const qwenRuntimeConfigSchema = z.strictObject({
  contextTokens: z.union([
    z.literal(1024),
    z.literal(2048),
    z.literal(4096),
    z.literal(8192),
    z.literal(16384),
    z.literal(32768),
  ]),
  kvKeyType: z.enum(QWEN_KV_TYPES),
  kvValueType: z.enum(QWEN_KV_TYPES),
});
export type QwenRuntimeConfig = z.infer<typeof qwenRuntimeConfigSchema>;

export const DEFAULT_QWEN_RUNTIME_CONFIG: QwenRuntimeConfig = Object.freeze({
  contextTokens: 4096,
  kvKeyType: "f16",
  kvValueType: "f16",
});

export function sameQwenRuntimeConfig(a: QwenRuntimeConfig, b: QwenRuntimeConfig): boolean {
  return (
    a.contextTokens === b.contextTokens &&
    a.kvKeyType === b.kvKeyType &&
    a.kvValueType === b.kvValueType
  );
}

/** Stable text form, e.g. for the child env and the supervisor slot key. */
export function qwenRuntimeKey(config: QwenRuntimeConfig): string {
  return `ctx${config.contextTokens}-k${config.kvKeyType}-v${config.kvValueType}`;
}

/** node-llama-cpp spelling of a KV cache type (GgmlType names). */
export const QWEN_KV_GGML_TYPE = Object.freeze({
  f16: "F16",
  q8_0: "Q8_0",
  q4_0: "Q4_0",
} as const satisfies Record<QwenKvType, string>);

// Qwen3-Embedding-0.6B: 28 layers x 8 KV heads x 128 head dims, per K and per V.
const KV_ELEMENTS_PER_TOKEN = descriptors.qwenKvElementsPerToken;
const BYTES_PER_ELEMENT: Record<QwenKvType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };

export function kvBytesPerToken(key: QwenKvType, value: QwenKvType): number {
  return KV_ELEMENTS_PER_TOKEN * (BYTES_PER_ELEMENT[key] + BYTES_PER_ELEMENT[value]);
}

/** The child allocates contextTokens + 1 slots; node-llama-cpp pads to a multiple of 256. */
export function paddedContextTokens(contextTokens: number): number {
  return (
    Math.ceil((contextTokens + descriptors.contextExtra) / descriptors.contextPadding) *
    descriptors.contextPadding
  );
}

const MiB = 1024 * 1024;
/** Patched base; the descriptor documents the fit and residuals. */
export const QWEN_BASE_BYTES = QWEN_MODEL.memory.baseMiB * MiB;
/** Formula estimate of the child's peak RSS for a config. */
export function estimateQwenPeakBytes(config: QwenRuntimeConfig): number {
  return Math.round(
    QWEN_BASE_BYTES +
      paddedContextTokens(config.contextTokens) *
        kvBytesPerToken(config.kvKeyType, config.kvValueType),
  );
}

export const QWEN_WARN_RATIO = 0.7;
export const QWEN_BLOCK_RATIO = 0.9;
export type QwenMemoryLevel = "ok" | "warn" | "block" | "unknown";

/** One boundary for individual admission and combined probe placement. */
function memoryLevel(ratio: number | null): QwenMemoryLevel {
  return ratio === null
    ? "unknown"
    : ratio >= QWEN_BLOCK_RATIO - Number.EPSILON
      ? "block"
      : ratio > QWEN_WARN_RATIO + Number.EPSILON
        ? "warn"
        : "ok";
}

/** Admission uses the conservative formula, calibrated against the patched matrix. */
export function qwenMemoryEstimate(config: QwenRuntimeConfig): {
  bytes: number;
  source: "measured" | "estimated";
} {
  // Admission always uses the envelope, never the smaller measured sample.
  return {
    bytes: estimateQwenPeakBytes(config),
    source: "estimated",
  };
}

/** > 70% of the budget warns (allowed with acknowledgement), >= 90% blocks. */
export function assessQwenRuntimeConfig(
  config: QwenRuntimeConfig,
  budgetBytes: number | null,
): {
  bytes: number;
  source: "measured" | "estimated";
  percent: number | null;
  level: QwenMemoryLevel;
} {
  const estimate = qwenMemoryEstimate(config);
  if (budgetBytes === null || !(budgetBytes > 0))
    return { ...estimate, percent: null, level: "unknown" };
  const ratio = estimate.bytes / budgetBytes;
  return {
    ...estimate,
    percent: ratio * 100,
    level: memoryLevel(ratio),
  };
}

/** Every selectable option with its estimate and level against the reported budget. */
export function qwenRuntimeEstimates(budgetBytes: number | null) {
  const rows: Array<QwenRuntimeConfig & ReturnType<typeof assessQwenRuntimeConfig>> = [];
  for (const contextTokens of QWEN_CONTEXT_OPTIONS)
    for (const kvKeyType of QWEN_KV_TYPES)
      for (const kvValueType of QWEN_KV_TYPES) {
        const config = { contextTokens, kvKeyType, kvValueType };
        rows.push({ ...config, ...assessQwenRuntimeConfig(config, budgetBytes) });
      }
  return rows;
}

/**
 * Size of the mmapped GGUF weights (QWEN_ARTIFACT.sizeBytes; pinned by a test so
 * this module stays free of the artifact module's node:fs imports). Two children
 * of one worker map the same file, so its pages are shared and counted once.
 */
export const QWEN_WEIGHTS_BYTES = 639_150_592;

export type QwenProbeMode = "side-by-side" | "exclusive";

/** Descriptor-specific memory estimate. Gemma has no KV cache; never extrapolate its cap. */
export function estimateBuiltinPeakBytes(
  model: BuiltinModelDescriptor,
  config: { contextTokens: number; kvKeyType: QwenKvType; kvValueType: QwenKvType },
): number {
  if (model.causal) return estimateQwenPeakBytes(qwenRuntimeConfigSchema.parse(config));
  if (!model.contextTiers.includes(config.contextTokens))
    throw new Error("unsupported model context");
  const n = config.contextTokens;
  return Math.ceil(
    (model.memory.baseMiB + model.memory.tokenMiB * n + model.memory.quadraticMiB * n * n) * MiB,
  );
}

export function assessBuiltinRuntimeConfig(
  model: BuiltinModelDescriptor,
  config: Parameters<typeof estimateBuiltinPeakBytes>[1],
  budgetBytes: number | null,
): { bytes: number; source: "estimated"; percent: number | null; level: QwenMemoryLevel } {
  const bytes = estimateBuiltinPeakBytes(model, config);
  const ratio = budgetBytes !== null && budgetBytes > 0 ? bytes / budgetBytes : null;
  return {
    bytes,
    source: "estimated" as const,
    percent: ratio === null ? null : ratio * 100,
    level: memoryLevel(ratio),
  };
}

export function chooseBuiltinProbeMode(input: {
  activeModel: BuiltinModelDescriptor;
  candidateModel: BuiltinModelDescriptor;
  active: Parameters<typeof estimateBuiltinPeakBytes>[1];
  candidate: Parameters<typeof estimateBuiltinPeakBytes>[1];
  activePeakBytes: number | null;
  budgetBytes: number | null;
}): { mode: QwenProbeMode; combinedBytes: number; limitBytes: number | null } {
  const current = Math.max(
    input.activePeakBytes ?? 0,
    estimateBuiltinPeakBytes(input.activeModel, input.active),
  );
  const shared =
    input.activeModel.sha256 === input.candidateModel.sha256 ? input.activeModel.sizeBytes : 0;
  const combinedBytes =
    current + estimateBuiltinPeakBytes(input.candidateModel, input.candidate) - shared;
  const limitBytes =
    input.budgetBytes !== null && input.budgetBytes > 0
      ? input.budgetBytes * QWEN_BLOCK_RATIO
      : null;
  const level = memoryLevel(
    input.budgetBytes !== null && input.budgetBytes > 0 ? combinedBytes / input.budgetBytes : null,
  );
  return {
    mode: level === "ok" || level === "warn" ? "side-by-side" : "exclusive",
    combinedBytes,
    limitBytes,
  };
}
