export function restoreOffline(input: {
  file: string;
  identity: string;
  attemptId: string;
  connectionString: string;
  dataDir: string;
  masterKey?: string;
  authSecret?: string;
  assetSourceRemap?: boolean;
  signal?: AbortSignal;
  barrier?: (phase: string) => Promise<void>;
}): Promise<{ epoch: string }>;
export function extractBundle(
  file: string,
  identity: string,
  stage: string,
  options?: { maxBytes?: number; signal?: AbortSignal },
): Promise<{
  metadata: {
    version: number;
    storage: { mode: "s3"; locator: string } | { mode: "disk" };
    instanceId: string;
    authorityEpoch: string;
    cutoff: string;
    heads: Array<{ id: string; headSha: string | null; state: string }>;
    migrationHistory: {
      version: 1;
      schema: string;
      migrations: Array<{ name: string; checksum: string; contractChecksum: string | null }>;
      applied: Array<{ name: string; checksum: string }>;
      contracts: unknown[];
    };
    sourceCatalog: Array<{ kind: string; identity: string; definition: string }>;
  };
  inventory: Array<{ path: string; size: number; sha256: string }>;
}>;

/** Required SQL columns and enum labels for offline restore preflight. */
export declare const RESTORE_SURFACE: {
  columns: Record<string, string>;
  enums: Record<string, string>;
};
