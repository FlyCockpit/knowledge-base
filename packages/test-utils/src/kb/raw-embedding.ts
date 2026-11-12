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
 * The embedding contract (§1.4, docs/embeddings.md): a built-in runtime returns the RAW pooled
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
