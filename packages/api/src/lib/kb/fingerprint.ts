import { createHash } from "node:crypto";
import { type BuiltinModelDescriptor, QWEN_MODEL } from "./builtin-model";
import { canonicalizeHttpsEndpointUrl } from "./egress";
import { QWEN_ARTIFACT } from "./model-artifact";
import type { QwenRuntimeConfig } from "./qwen-runtime-config";

/** Bump the matching version when index semantics change; credentials are never inputs. */
export const EMBEDDING_VERSIONS = {
  normalization: "l2-f32-v1",
  chunk: "source-spans-whitespace-400-80-v1",
  tokenizer: "unicode-white-space-v1",
  redaction: "credential-ranges-pem-sealed-v1",
  markdown: "frontmatter-source-v1",
  structured: "gfm-scalar-rows-nfkc-fold-v1",
  citations: "explicit-frontmatter-pinned-assets-v1",
  snippet: "unicode-scalars-240-v1",
  converter: "markdown-only-v1",
  index: "hybrid-v1",
} as const;

export function embeddingFingerprint(
  config: { endpointUrl: string; model: string; dimensions: number },
  versions: Record<keyof typeof EMBEDDING_VERSIONS, string> = EMBEDDING_VERSIONS,
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "OPENAI_COMPAT",
        canonicalizeHttpsEndpointUrl(config.endpointUrl),
        config.model,
        config.dimensions,
        versions.normalization,
        versions.chunk,
        versions.tokenizer,
        versions.redaction,
        versions.markdown,
        versions.structured,
        versions.citations,
        versions.snippet,
        versions.converter,
        versions.index,
      ]),
    )
    .digest("hex")}`;
}

/**
 * Built-in Qwen MODEL IDENTITY. Bump a version when the
 * matching behavior of the forked child changes; the artifact is its SHA. Vectors
 * from two builds with the same identity live in one space, so an index built
 * under older build parameters stays query-compatible with the current child.
 */
export const QWEN_RUNTIME_VERSIONS = {
  artifact: `gguf-sha256:${QWEN_ARTIFACT.sha256}`,
  tokenizer: `gguf-special-off-nobos-eos${QWEN_ARTIFACT.eosTokenId}-once-v1`,
  pooling: "gguf-metadata-last-v1",
  prefix: `query-instruct-v1:${QWEN_ARTIFACT.queryPrefix}`,
  /** Input limit semantics; the limit itself is the contextTokens build parameter. */
  inputLimit: "context-incl-prefix-eos-reject-overflow-v1",
  runtime: JSON.stringify(QWEN_MODEL.runtime),
} as const;

/** Weights, pooling, prefix, dimensions and every index-semantics version; never build parameters. */
export function qwenModelIdentity(
  runtime: Record<keyof typeof QWEN_RUNTIME_VERSIONS, string> = QWEN_RUNTIME_VERSIONS,
  versions: Record<keyof typeof EMBEDDING_VERSIONS, string> = EMBEDDING_VERSIONS,
): string {
  if (runtime === QWEN_RUNTIME_VERSIONS && versions === EMBEDDING_VERSIONS)
    return builtinModelIdentity(QWEN_MODEL);
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "SYSTEM_BUILTIN_IDENTITY",
        QWEN_ARTIFACT.modelId,
        QWEN_ARTIFACT.dimensions,
        runtime.artifact,
        runtime.tokenizer,
        runtime.pooling,
        runtime.prefix,
        runtime.inputLimit,
        runtime.runtime,
        versions.normalization,
        versions.chunk,
        versions.tokenizer,
        versions.redaction,
        versions.markdown,
        versions.structured,
        versions.citations,
        versions.snippet,
        versions.converter,
        versions.index,
      ]),
    )
    .digest("hex")}`;
}

/** Descriptor and source pins determine query compatibility; context remains a build parameter. */
export function builtinModelIdentity(
  model: BuiltinModelDescriptor,
  runtime: BuiltinModelDescriptor["runtime"] = model.runtime,
  versions: Record<keyof typeof EMBEDDING_VERSIONS, string> = EMBEDDING_VERSIONS,
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "BUILTIN_IDENTITY",
        model.modelId,
        model.sha256,
        model.dimensions,
        model.architecture,
        model.pooling,
        model.poolingType,
        model.causal,
        model.batchTokens,
        model.queryPrefix,
        model.documentPrefix,
        model.addBos,
        model.bosTokenId,
        model.addEos,
        model.eosTokenId,
        "special-parsing-off-exact-limit-v1",
        runtime,
        versions,
      ]),
    )
    .digest("hex")}`;
}

export function builtinEmbeddingFingerprint(
  model: BuiltinModelDescriptor,
  config: QwenRuntimeConfig,
): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "BUILTIN",
        builtinModelIdentity(model),
        config.contextTokens,
        config.kvKeyType,
        config.kvValueType,
      ]),
    )
    .digest("hex")}`;
}

/**
 * Full SYSTEM_BUILTIN fingerprint = model identity + build parameters (context
 * length, K and V cache types). A change of either builds a new generation.
 */
export function qwenEmbeddingFingerprint(
  config: QwenRuntimeConfig,
  runtime: Record<keyof typeof QWEN_RUNTIME_VERSIONS, string> = QWEN_RUNTIME_VERSIONS,
  versions: Record<keyof typeof EMBEDDING_VERSIONS, string> = EMBEDDING_VERSIONS,
): string {
  if (runtime === QWEN_RUNTIME_VERSIONS && versions === EMBEDDING_VERSIONS)
    return builtinEmbeddingFingerprint(QWEN_MODEL, config);
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "SYSTEM_BUILTIN",
        qwenModelIdentity(runtime, versions),
        config.contextTokens,
        config.kvKeyType,
        config.kvValueType,
      ]),
    )
    .digest("hex")}`;
}
