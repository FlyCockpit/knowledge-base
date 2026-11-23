import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unitVector } from "@knowledge-base/api/lib/kb/index-file/testing";
import { expect } from "vitest";

/** Shared server/CLI fixture: real raw outputs of each built-in model and their unit bytes. */
export const normalizationFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "embedding-normalization.json"), "utf8"),
) as {
  items: Array<{ id: string; purpose: "query" | "document"; text: string }>;
  models: Record<string, Array<{ id: string; raw: number[]; unitF32Hex: string }>>;
};

/**
 * Minimum cosine between a live real-model vector and the shared fixture (recorded by the server
 * worker on x64). x64 reproduces it and keeps the strict 0.9999 bar; every other architecture
 * (arm64) is held to 0.9995. Same weights and llama.cpp source, but float accumulation order in
 * the CPU kernels differs per build (ISA, CPU features, weight repack, compiler and libm):
 * measured d1 against the x64 fixture, macOS arm64 Gemma 0.99990 / Qwen 0.99973, Linux arm64
 * musl and this server worker Qwen 0.99980, Linux arm64 gnu Qwen 0.99972. Real defects (wrong
 * pooling, the wrong model) land far below 0.999; double normalization keeps the direction and is
 * caught by the raw-magnitude checks instead. The CLI twin is
 * `REAL_MODEL_PARITY_MIN_COSINE` in `apps/cli/crates/kb-local/tests/qwen_model.rs`.
 */
export const REAL_MODEL_PARITY_MIN_COSINE = process.arch === "x64" ? 0.9999 : 0.9995;

/**
 * The embedding contract (docs/embeddings.md): a built-in runtime returns the RAW pooled
 * vector and the index format normalizes it exactly once. Enforced before normalizing: finite,
 * the model's dimensions, and a magnitude within 20x of the recorded raw outputs of that model
 * (real Qwen ~100, Gemma ~1,000; norms vary with input length), so an already-normalized vector
 * (norm 1, at most 0.011x) fails. Returns the index's one normalization, `u = f32(v / ‖v‖)`.
 */
export function expectRawEmbedding(raw: number[], modelId: string): number[] {
  const recorded = normalizationFixture.models[modelId];
  if (!recorded?.length) throw new Error(`No recorded raw output for ${modelId}`);
  const dimensions = recorded[0]!.raw.length;
  expect(raw).toHaveLength(dimensions);
  expect(raw.every(Number.isFinite)).toBe(true);
  const norm = Math.hypot(...raw);
  const reference =
    recorded.reduce((sum, row) => sum + Math.hypot(...row.raw), 0) / recorded.length;
  expect(norm / reference, `raw norm ${norm} vs recorded ${reference}`).toBeGreaterThan(0.05);
  expect(norm / reference, `raw norm ${norm} vs recorded ${reference}`).toBeLessThan(20);
  const unit = Array.from(unitVector(raw, dimensions));
  expect(Math.abs(Math.hypot(...unit) - 1)).toBeLessThan(1e-6);
  return unit;
}
