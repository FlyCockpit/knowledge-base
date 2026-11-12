import { describe, expect, it } from "vitest";
import {
  EMBEDDING_VERSIONS,
  embeddingFingerprint,
  QWEN_RUNTIME_VERSIONS,
  qwenEmbeddingFingerprint,
  qwenModelIdentity,
} from "./fingerprint";
import {
  DEFAULT_QWEN_RUNTIME_CONFIG,
  QWEN_CONTEXT_OPTIONS,
  QWEN_KV_TYPES,
} from "./qwen-runtime-config";

const config = {
  endpointUrl: "https://EXAMPLE.com:443/v1/embeddings",
  model: "embed",
  dimensions: 2,
};
describe("embedding fingerprints", () => {
  it("canonicalizes hosts/default ports but preserves port, full path, model and dimensions", () => {
    const hash = embeddingFingerprint(config);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      embeddingFingerprint({ ...config, endpointUrl: "https://example.com/v1/embeddings" }),
    ).toBe(hash);
    for (const delta of [
      { endpointUrl: "https://example.com:8443/v1/embeddings" },
      { endpointUrl: "https://example.com/tenant/v1/embeddings" },
      { model: "other" },
      { dimensions: 3 },
    ])
      expect(embeddingFingerprint({ ...config, ...delta })).not.toBe(hash);
  });
  it("includes each algorithm version and ignores credentials even on a wider input object", () => {
    const hash = embeddingFingerprint(config);
    for (const key of Object.keys(EMBEDDING_VERSIONS))
      expect(embeddingFingerprint(config, { ...EMBEDDING_VERSIONS, [key]: "next" })).not.toBe(hash);
    const rotated = { ...config, apiKey: "canary-rotated", ciphertext: "different" };
    expect(embeddingFingerprint(rotated)).toBe(hash);
  });
  it("SYSTEM_BUILTIN model identity covers artifact, tokenizer, pooling, prefix, input limit and runtime, never build parameters", () => {
    const identity = qwenModelIdentity();
    expect(identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(qwenModelIdentity()).toBe(identity);
    for (const key of [
      "artifact",
      "tokenizer",
      "pooling",
      "prefix",
      "inputLimit",
      "runtime",
    ] as const) {
      expect(Object.keys(QWEN_RUNTIME_VERSIONS)).toContain(key);
      expect(qwenModelIdentity({ ...QWEN_RUNTIME_VERSIONS, [key]: "next" })).not.toBe(identity);
    }
    for (const key of Object.keys(EMBEDDING_VERSIONS))
      expect(
        qwenModelIdentity(QWEN_RUNTIME_VERSIONS, { ...EMBEDDING_VERSIONS, [key]: "next" }),
      ).not.toBe(identity);
    // The artifact version is the pinned SHA-256, not a mutable name.
    expect(QWEN_RUNTIME_VERSIONS.artifact).toContain(
      "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
    );
  });

  it("SYSTEM_BUILTIN fingerprint = identity + build parameters: context and each KV type change it", () => {
    const base = DEFAULT_QWEN_RUNTIME_CONFIG;
    const hash = qwenEmbeddingFingerprint(base);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(qwenEmbeddingFingerprint({ ...base })).toBe(hash);
    expect(hash).not.toBe(qwenModelIdentity());
    expect(hash).not.toBe(
      embeddingFingerprint({
        endpointUrl: "https://example.com/v1",
        model: "qwen",
        dimensions: 1024,
      }),
    );
    const seen = new Set<string>();
    for (const contextTokens of QWEN_CONTEXT_OPTIONS)
      for (const kvKeyType of QWEN_KV_TYPES)
        for (const kvValueType of QWEN_KV_TYPES)
          seen.add(qwenEmbeddingFingerprint({ contextTokens, kvKeyType, kvValueType }));
    expect(seen.size).toBe(QWEN_CONTEXT_OPTIONS.length * QWEN_KV_TYPES.length ** 2);
    for (const delta of [
      { contextTokens: 8192 as const },
      { kvKeyType: "q8_0" as const },
      { kvValueType: "q8_0" as const },
    ])
      expect(qwenEmbeddingFingerprint({ ...base, ...delta })).not.toBe(hash);
    // An identity change also changes every fingerprint.
    expect(qwenEmbeddingFingerprint(base, { ...QWEN_RUNTIME_VERSIONS, runtime: "next" })).not.toBe(
      hash,
    );
  });
});
