/** Import-pure, role-specific asset configuration. Never performs storage IO. */
export type AssetS3Location = {
  bucket: string;
  endpoint?: string;
  region: string;
  prefix: string;
  forcePathStyle: boolean;
};

export type AssetS3Config = AssetS3Location & {
  credentials: { accessKeyId: string; secretAccessKey: string };
};

export function normalizeAssetS3Location(input: AssetS3Location): AssetS3Location {
  const invalid = () => new Error("Invalid asset storage configuration");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw invalid();
  if (!/^[a-zA-Z0-9-]+$/.test(input.region)) throw invalid();
  if (typeof input.forcePathStyle !== "boolean") throw invalid();
  const prefix = input.prefix.replace(/^\/+|\/+$/g, "");
  if (prefix && !prefix.split("/").every((s) => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(s)))
    throw invalid();
  let endpoint: string | undefined;
  if (input.endpoint !== undefined) {
    const url = new URL(input.endpoint);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw invalid();
    endpoint = url.origin;
  }
  return {
    bucket: input.bucket,
    endpoint,
    region: input.region,
    prefix,
    forcePathStyle: input.forcePathStyle,
  };
}

/** Stable exact location identity; credentials and cache configuration are excluded. */
export function assetS3Locator(input: AssetS3Location): string {
  const l = normalizeAssetS3Location(input);
  return JSON.stringify({
    version: 1,
    mode: "s3",
    endpoint: l.endpoint ?? null,
    bucket: l.bucket,
    region: l.region,
    prefix: l.prefix,
    forcePathStyle: l.forcePathStyle,
  });
}

/** Shared with offline initialization; changing the limit requires both fences. */
export function assetCacheConfiguration(locator: string, limit: bigint) {
  return JSON.stringify({ version: 1, locator, limit: limit.toString() });
}

type AssetSecret = string | { reveal(): string };
export type AssetStorageEnv = {
  KB_ASSET_S3_ENABLED?: boolean;
  KB_ASSET_CACHE_MAX_BYTES?: string;
  KB_ASSET_S3_BUCKET?: string;
  KB_ASSET_S3_ENDPOINT?: string;
  KB_ASSET_S3_REGION?: string;
  KB_ASSET_S3_PREFIX?: string;
  KB_ASSET_S3_FORCE_PATH_STYLE?: string;
  KB_ASSET_S3_ACCESS_KEY_ID?: AssetSecret;
  KB_ASSET_S3_SECRET_ACCESS_KEY?: AssetSecret;
};
export type AssetRuntimeConfig =
  | { mode: "disk" }
  | {
      mode: "s3";
      location: AssetS3Location;
      locator: string;
      cacheMaxBytes: bigint;
    };
const invalidConfig = () => new Error("Invalid KB_ASSET_S3 configuration");
/** Off deliberately ignores incomplete, irrelevant S3 settings. */
export function assetRuntimeConfig(env: AssetStorageEnv): AssetRuntimeConfig {
  if (!env.KB_ASSET_S3_ENABLED) return { mode: "disk" };
  const limit = env.KB_ASSET_CACHE_MAX_BYTES ?? "";
  if (
    !/^[1-9][0-9]*$/.test(limit) ||
    !Number.isSafeInteger(Number(limit)) ||
    Number(limit) < 26214400
  )
    throw invalidConfig();
  const pathStyle = env.KB_ASSET_S3_FORCE_PATH_STYLE ?? "false";
  if (
    !["true", "false"].includes(pathStyle) ||
    !env.KB_ASSET_S3_REGION ||
    (!env.KB_ASSET_S3_ENDPOINT && env.KB_ASSET_S3_REGION === "auto")
  )
    throw invalidConfig();
  let location: AssetS3Location;
  try {
    location = normalizeAssetS3Location({
      bucket: env.KB_ASSET_S3_BUCKET ?? "",
      endpoint: env.KB_ASSET_S3_ENDPOINT || undefined,
      region: env.KB_ASSET_S3_REGION,
      prefix: env.KB_ASSET_S3_PREFIX ?? "",
      forcePathStyle: pathStyle === "true",
    });
  } catch {
    throw invalidConfig();
  }
  return { mode: "s3", location, locator: assetS3Locator(location), cacheMaxBytes: BigInt(limit) };
}
/** The worker has no byte consumers and never needs this credential pair. */
export function assetServerConfig(env: AssetStorageEnv) {
  const selection = assetRuntimeConfig(env);
  if (selection.mode === "disk") return selection;
  const reveal = (value: AssetSecret | undefined) =>
    typeof value === "string" ? value : value?.reveal();
  const accessKeyId = reveal(env.KB_ASSET_S3_ACCESS_KEY_ID);
  const secretAccessKey = reveal(env.KB_ASSET_S3_SECRET_ACCESS_KEY);
  if (!accessKeyId || !secretAccessKey) throw invalidConfig();
  return {
    ...selection,
    config: { ...selection.location, credentials: { accessKeyId, secretAccessKey } },
  };
}
