import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * Minimum cosine between a live real-model vector and the reference recorded on the same platform
 * (`embedding-parity/server-<platform>.json`). Strict on every platform: a platform is only ever
 * compared with its own recording. Real defects (wrong pooling, the wrong model) land far below
 * 0.999; double normalization keeps the direction and is caught by the raw-magnitude checks
 * instead. The CLI twin is `REAL_MODEL_PARITY_MIN_COSINE` in
 * `apps/cli/crates/kb-local/tests/qwen_model.rs`.
 */
export const REAL_MODEL_PARITY_MIN_COSINE = 0.9999;

/**
 * The platform whose numerics the server worker's vectors carry. `scripts/build-embedding-runtime.mjs`
 * builds the pinned llama.cpp for Linux x64/arm64 only, with `GGML_NATIVE=OFF` (ggml's fixed
 * non-native instruction-set defaults) and the host toolchain, so the kernels are fixed by the
 * architecture and not by the host CPU's features.
 */
export const parityPlatform = () => `${process.platform}-${process.arch}`;

const parityReferencePath = (platform: string) =>
  join(import.meta.dirname, "embedding-parity", `server-${platform}.json`);

const parityRegeneration = (platform: string) =>
  `record it on ${platform}: pnpm test:kb --build-only qwen-model, then KB_RECORD_EMBEDDING_PARITY=1 ` +
  "pnpm test:kb -- qwen-model, or on CI: gh workflow run kb-model-smoke.yml -f record_parity=true " +
  "and commit the embedding-parity-* artifacts (docs/embeddings.md)";

type ParityRow = { id: string; purpose: string; text: string; unitF32Hex: string };

/**
 * Record mode (exactly `KB_RECORD_EMBEDDING_PARITY=1`; unset or empty compares): write the live
 * vectors as this platform's reference instead of comparing. Any other value is refused rather
 * than silently recording.
 */
export function recordingParity() {
  const value = process.env.KB_RECORD_EMBEDDING_PARITY;
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new Error(`KB_RECORD_EMBEDDING_PARITY must be 1 or unset, not ${JSON.stringify(value)}`);
}

/**
 * A model's recorded unit vectors for `platform`, checked against the shared inputs. A missing or
 * stale reference fails with the command that records it; another platform's recording is never
 * substituted.
 */
export function parityReference(platform: string, modelId: string): Map<string, Float32Array> {
  const path = parityReferencePath(platform);
  if (!existsSync(path))
    throw new Error(
      `No server embedding parity reference for ${platform} (${path}); ${parityRegeneration(platform)}`,
    );
  const reference = JSON.parse(readFileSync(path, "utf8")) as {
    runtime: string;
    platform: string;
    models: Record<string, ParityRow[]>;
  };
  if (reference.runtime !== "server" || reference.platform !== platform)
    throw new Error(`${path} is not the server reference for ${platform}`);
  const rows = reference.models[modelId];
  if (!rows) throw new Error(`${path} has no ${modelId} rows; ${parityRegeneration(platform)}`);
  const inputs = (row: { id: string; purpose: string; text: string }) =>
    JSON.stringify([row.id, row.purpose, row.text]);
  if (rows.map(inputs).join("\n") !== normalizationFixture.items.map(inputs).join("\n"))
    throw new Error(
      `${path} ${modelId} was recorded for other inputs than embedding-normalization.json; ${parityRegeneration(platform)}`,
    );
  return new Map(
    rows.map((row) => {
      const bytes = Buffer.from(row.unitF32Hex, "hex");
      return [row.id, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];
    }),
  );
}

/** Record mode: write a model's rows into the platform's reference, keeping the other models'. */
export function recordParityReference(platform: string, modelId: string, rows: ParityRow[]) {
  const path = parityReferencePath(platform);
  const models: Record<string, ParityRow[]> = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { models: Record<string, ParityRow[]> }).models
    : {};
  models[modelId] = rows;
  const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ runtime: "server", platform, models: sorted }, null, 2)}\n`,
  );
  console.log(`recorded ${modelId} parity reference ${path}`);
}

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
