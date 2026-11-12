import descriptors from "./fixtures/builtin-models.json" with { type: "json" };
import runtime from "./fixtures/embedding-runtime.json" with { type: "json" };

/** The native source identity is part of the vector space, never just a build label. */
export const EMBEDDING_RUNTIME = Object.freeze(runtime);
export const EMBEDDING_CMAKE_OPTIONS = Object.freeze({
  KB_EMBEDDING_RUNTIME: runtime.sourceSha256,
});

export type BuiltinModelDescriptor = Readonly<{
  modelId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  dimensions: number;
  architecture: string;
  pooling: "LAST" | "MEAN";
  poolingType: 1 | 3;
  causal: boolean;
  batchTokens: number | "full-input";
  queryPrefix: string;
  documentPrefix: string;
  addBos: boolean;
  addEos: boolean;
  bosTokenId: number;
  eosTokenId: number;
  contextTiers: readonly number[];
  runtime: typeof EMBEDDING_RUNTIME;
  memory: Readonly<{ baseMiB: number; tokenMiB: number; quadraticMiB: number }>;
}>;

function fromData(data: (typeof descriptors.models)[number]): BuiltinModelDescriptor {
  if (
    (data.pooling !== "LAST" && data.pooling !== "MEAN") ||
    (data.poolingType !== 1 && data.poolingType !== 3) ||
    (typeof data.batchTokens !== "number" && data.batchTokens !== "full-input")
  )
    throw new Error("unsupported built-in descriptor");
  return Object.freeze({
    ...data,
    pooling: data.pooling,
    poolingType: data.poolingType,
    batchTokens: data.batchTokens,
    contextTiers: Object.freeze(data.contextTiers),
    memory: Object.freeze(data.memory),
    runtime: EMBEDDING_RUNTIME,
  });
}
export const QWEN_MODEL = fromData(descriptors.models[0]!);
export const GEMMA_MODEL = fromData(descriptors.models[1]!);
export const BUILTIN_MODELS: Readonly<Record<string, BuiltinModelDescriptor>> = Object.freeze({
  [QWEN_MODEL.modelId]: QWEN_MODEL,
  [GEMMA_MODEL.modelId]: GEMMA_MODEL,
});
// Preserve exported identity: consumers compare these descriptor objects by reference.
export function builtinModel(id: string): BuiltinModelDescriptor {
  if (id === QWEN_MODEL.modelId) return QWEN_MODEL;
  if (id === GEMMA_MODEL.modelId) return GEMMA_MODEL;
  throw new Error("unsupported built-in model");
}
