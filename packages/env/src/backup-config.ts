/**
 * Import-pure backup capability validation. These functions deliberately do
 * not read process.env so a caller can validate its exact profile without
 * booting the shared environment surface.
 */
import type { Secret } from "./secret.js";

/** A credential as the env schema delivers it (a Secret) or as a test passes it. */
type Credential = Secret<string> | string | undefined;
const raw = (value: Credential) => (typeof value === "string" ? value : value?.reveal());

export type BackupConfig = {
  BACKUP_ENABLED?: boolean | undefined;
  BACKUP_S3_BUCKET?: string | undefined;
  BACKUP_S3_ACCESS_KEY_ID?: Credential;
  BACKUP_S3_SECRET_ACCESS_KEY?: Credential;
  BACKUP_S3_ENDPOINT?: string | undefined;
  BACKUP_S3_REGION?: string | undefined;
  BACKUP_MONITOR_S3_ACCESS_KEY_ID?: Credential;
  BACKUP_MONITOR_S3_SECRET_ACCESS_KEY?: Credential;
};

/** The fixed backup configuration warnings, by stable code. */
export const BACKUP_WARNINGS = {
  BUCKET_MISSING:
    "BACKUP_ENABLED=true but BACKUP_S3_BUCKET is not set. Local encrypted full bundles remain valid, but off-site freshness cannot be checked — configure BACKUP_S3_BUCKET with separate bundle-writer and freshness-monitor credentials for off-site coverage.",
  REGION_AUTO:
    "BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset. " +
    'The default "auto" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces.',
  MONITOR_KEY_MISSING:
    "BACKUP_S3_BUCKET is set but BACKUP_MONITOR_S3_ACCESS_KEY_ID / BACKUP_MONITOR_S3_SECRET_ACCESS_KEY are missing. " +
    "The freshness worker needs a dedicated ListBucket-only monitor key.",
  MONITOR_KEY_SHARED:
    "BACKUP_MONITOR_S3_ACCESS_KEY_ID matches BACKUP_S3_ACCESS_KEY_ID. The freshness worker needs a separate ListBucket-only key, not the bundle read/write key.",
} as const;
export type BackupWarningCode = keyof typeof BACKUP_WARNINGS;
/** The stable code of one of the warnings above. */
export function backupWarningCode(message: string): BackupWarningCode | undefined {
  return (Object.keys(BACKUP_WARNINGS) as BackupWarningCode[]).find(
    (code) => BACKUP_WARNINGS[code] === message,
  );
}

/** Shared location settings used by both backup writers and the monitor. */
export function backupCommonConfigWarnings(value: BackupConfig): string[] {
  const warnings: string[] = [];
  if (value.BACKUP_ENABLED && !value.BACKUP_S3_BUCKET)
    warnings.push(BACKUP_WARNINGS.BUCKET_MISSING);
  if (!value.BACKUP_S3_BUCKET) return warnings;
  if (!value.BACKUP_S3_ENDPOINT && value.BACKUP_S3_REGION === "auto")
    warnings.push(BACKUP_WARNINGS.REGION_AUTO);
  return warnings;
}

/** Freshness monitoring needs a distinct ListBucket-only identity. */
export function backupMonitorConfigWarnings(value: BackupConfig): string[] {
  const warnings = backupCommonConfigWarnings(value);
  if (!value.BACKUP_S3_BUCKET) return warnings;
  if (!value.BACKUP_MONITOR_S3_ACCESS_KEY_ID || !value.BACKUP_MONITOR_S3_SECRET_ACCESS_KEY)
    warnings.push(BACKUP_WARNINGS.MONITOR_KEY_MISSING);
  const monitorKey = raw(value.BACKUP_MONITOR_S3_ACCESS_KEY_ID);
  if (monitorKey && monitorKey === raw(value.BACKUP_S3_ACCESS_KEY_ID))
    warnings.push(BACKUP_WARNINGS.MONITOR_KEY_SHARED);
  return warnings;
}
