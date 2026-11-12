export type BackupFile = { path: string; size: number; sha256: string; bytes: Buffer };
export type BackupMetadata = {
  version: number;
  storage: { mode: "s3"; locator: string } | { mode: "disk" };
  cutoff: string;
  instanceId: string;
  authorityEpoch: string;
  heads: { id: string; headSha: string | null; state: string }[];
  migrationHistory: {
    version: 1;
    schema: string;
    migrations: Array<{ name: string; checksum: string; contractChecksum: string | null }>;
    applied: Array<{ name: string; checksum: string }>;
    contracts: unknown[];
  };
  sourceCatalog: Array<{ kind: string; identity: string; definition: string }>;
};
export function readBundle(
  file: string,
  identity: string,
  options?: { maxBytes?: number },
): Promise<{ metadata: BackupMetadata; files: BackupFile[] }>;
export function verifyEncryptedBundle(file: string): Promise<{ size: number; sha256: string }>;
export function coordinateBackup(options: {
  assetEnvironment?: Record<string, string | undefined>;
  connectionString: string;
  dataDir: string;
  backupDir: string;
  recipient: string;
  schemaDir?: string;
  supervisor?: string;
  signal?: AbortSignal;
  timeout?: number;
  now?: () => number;
  runId?: string;
  barrier?: (stage: string) => Promise<void>;
}): Promise<string>;

export function encryptBundle(options: {
  file: string;
  metadata: BackupMetadata;
  sources: Array<{ path: string; source: string }>;
  recipient: string;
  signal?: AbortSignal;
  stageDir?: string;
  beforeComplete?: () => Promise<void>;
  barrier?: (stage: string) => Promise<void>;
}): Promise<string>;
