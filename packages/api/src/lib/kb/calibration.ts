export const PROVIDER_CALIBRATION_FAMILIES = [
  "unknown",
  "embeddinggemma-2-q8_0",
  "qwen3-embedding-0.6b-q8_0",
] as const;

export type ProviderCalibrationFamily = (typeof PROVIDER_CALIBRATION_FAMILIES)[number];

export function isKnownCalibrationFamily(
  value: unknown,
): value is Exclude<ProviderCalibrationFamily, "unknown"> {
  return value === "embeddinggemma-2-q8_0" || value === "qwen3-embedding-0.6b-q8_0";
}

export function normalizeCalibrationFamily(
  value: string | null | undefined,
): ProviderCalibrationFamily {
  return isKnownCalibrationFamily(value) ? value : "unknown";
}
