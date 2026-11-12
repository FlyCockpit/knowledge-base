/** Load the exact runtime domain; production ships the bundled artifact. */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateAssetDumpIdentity } from "./backup-s3-env.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
let domain;
export async function assetStorageDomain() {
  if (!domain) {
    try {
      domain = await import(resolve(ROOT, "asset-storage-domain.mjs"));
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      const require = createRequire(resolve(ROOT, "package.json"));
      const { tsImport } = await import(require.resolve("tsx/esm/api"));
      domain = await tsImport(
        resolve(ROOT, "packages/api/src/lib/kb/asset-storage-offline.ts"),
        import.meta.url,
      );
    }
  }
  return domain;
}
const ASSET_OPERATOR_ENV_KEYS = [
  "KB_ASSET_S3_ENABLED",
  "KB_ASSET_CACHE_MAX_BYTES",
  "KB_ASSET_S3_BUCKET",
  "KB_ASSET_S3_ENDPOINT",
  "KB_ASSET_S3_REGION",
  "KB_ASSET_S3_PREFIX",
  "KB_ASSET_S3_FORCE_PATH_STYLE",
  "KB_ASSET_S3_ACCESS_KEY_ID",
  "KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID",
  "KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY",
];
export function assetOperatorEnv(env = process.env) {
  validateAssetDumpIdentity(env);
  return Object.fromEntries(
    ASSET_OPERATOR_ENV_KEYS.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
  );
}
export async function operatorAssetConfig(env = process.env) {
  const roleEnv = assetOperatorEnv(env);
  if (!roleEnv.KB_ASSET_S3_ENABLED || roleEnv.KB_ASSET_S3_ENABLED === "false")
    return { mode: "disk" };
  return (await assetStorageDomain()).offlineAssetConfig(roleEnv);
}

let admissionDomain;
export async function assetStorageAdmissionDomain() {
  if (!admissionDomain) {
    try {
      admissionDomain = await import(resolve(ROOT, "asset-storage-admission.mjs"));
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      const require = createRequire(resolve(ROOT, "package.json"));
      const { tsImport } = await import(require.resolve("tsx/esm/api"));
      admissionDomain = await tsImport(
        resolve(ROOT, "packages/api/src/lib/kb/asset-storage-mode.ts"),
        import.meta.url,
      );
    }
  }
  return admissionDomain;
}
