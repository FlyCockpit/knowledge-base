/**
 * Shared backup-bucket config for upload/download helpers.
 *
 * Backups use BACKUP_S3_* only — never the app upload key (S3_*). A stolen
 * app-upload credential must not access dumps.
 *
 * These rules are enforced HERE and in scripts/backup.sh — at the moment a dump
 * is written or read — never in packages/env, which the web server and worker
 * boot on: a backup-only misconfiguration must not crash-loop the app. The env
 * package logs only shared bucket/region warnings; it does not infer whether a
 * monitor-only worker has this dump-writer identity.
 */
export function validateAssetDumpIdentity(env = process.env) {
  const runtime = env.KB_ASSET_S3_ACCESS_KEY_ID;
  const operator = env.KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID;
  const dump = env.BACKUP_S3_ACCESS_KEY_ID;
  if (env.KB_ASSET_S3_ENABLED && !["true", "false"].includes(env.KB_ASSET_S3_ENABLED))
    throw new Error("Invalid KB_ASSET_S3_ENABLED");
  if (
    (env.KB_ASSET_S3_ENABLED === "true" && (!runtime || !operator)) ||
    ((operator || env.KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY) && !runtime)
  )
    throw new Error(
      "Asset dump consumers require KB_ASSET_S3_ACCESS_KEY_ID and KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID comparison identities",
    );
  if (dump && ((runtime && dump === runtime) || (operator && dump === operator)))
    throw new Error("BACKUP_S3_ACCESS_KEY_ID must differ from both asset identities");
}
export function backupS3Config() {
  validateAssetDumpIdentity();
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (!bucket) {
    console.error("FATAL: BACKUP_S3_BUCKET is not set.");
    process.exit(1);
  }

  const accessKeyId = process.env.BACKUP_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BACKUP_S3_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    console.error("FATAL: BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY are required.");
    console.error(
      "       Use a dedicated dump-writer key with GetObject, PutObject, and AbortMultipartUpload only.",
    );
    console.error("       Do not reuse S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.");
    process.exit(1);
  }

  if (process.env.S3_ACCESS_KEY_ID && accessKeyId === process.env.S3_ACCESS_KEY_ID) {
    console.error(
      "FATAL: BACKUP_S3_ACCESS_KEY_ID matches S3_ACCESS_KEY_ID. Backups need a distinct key so a",
    );
    console.error("       stolen app-upload credential cannot read database dumps.");
    process.exit(1);
  }

  const region = process.env.BACKUP_S3_REGION || "auto";
  // "auto" is a Cloudflare R2 convention. With no endpoint the AWS SDK addresses
  // the bucket at the nonexistent host s3.auto.amazonaws.com, so every request
  // fails with a DNS error that names nothing useful. Say what to fix instead.
  if (!process.env.BACKUP_S3_ENDPOINT && region === "auto") {
    console.error(
      "FATAL: BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset.",
    );
    console.error(
      '       The default "auto" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces.',
    );
    process.exit(1);
  }

  const prefix = (process.env.BACKUP_S3_PREFIX ?? "database").replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    console.error("FATAL: BACKUP_S3_PREFIX must not be empty.");
    process.exit(1);
  }

  return {
    bucket,
    prefix,
    region,
    endpoint: process.env.BACKUP_S3_ENDPOINT,
    forcePathStyle: process.env.BACKUP_S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId, secretAccessKey },
  };
}
