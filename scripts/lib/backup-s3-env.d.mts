export function validateAssetDumpIdentity(env?: Record<string, string | undefined>): void;
export function backupS3Config(): {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
};
