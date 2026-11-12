import type { PrismaClient } from "@knowledge-base/db/client";
import type { AssetStorageLifecycle } from "./asset-storage-lifecycle";
import type { AuthorityBarrier } from "./authority-lock";
import type { BlobStore } from "./blob-store";
import type { CursorSigner } from "./cursor";
import type { GitMutatingExecutor } from "./git-write";
import type { RatePort } from "./limits";
import type { HeldLockLease } from "./lock";
import type { DiskMeter } from "./quota";
import type { GitWriteCapability } from "./write-capability";

export type KbWriteOperationContext = {
  lease: HeldLockLease;
  signal: AbortSignal;
  issueWriteCapability(kbId: string): GitWriteCapability;
};

export type KbWriteCoordinatorPort = {
  run<T>(options: {
    opId: string;
    kind: "authority" | "git-write";
    kbIds?: readonly string[];
    barrier?: AuthorityBarrier;
    run: (ctx: KbWriteOperationContext) => Promise<T>;
  }): Promise<T>;
};

export type KbRuntimeConfig = {
  prisma: PrismaClient;
  connectionString: string;
  reposDir: string;
  assetsDir: string;
  blobStore: BlobStore;
  assetStorage?: AssetStorageLifecycle;
  canonicalOrigin: string;
  cursorSigner: CursorSigner;
  ratePort: RatePort;
  diskMeter: DiskMeter;
  coordinator: KbWriteCoordinatorPort;
  /** Supervised Git transport for KB create publication (wired by the server). */
  createGitExecutor?: (ctx: KbWriteOperationContext, kbId: string) => GitMutatingExecutor;
};

let configured: KbRuntimeConfig | undefined;

export function configureKbRuntime(config: KbRuntimeConfig): void {
  configured = config;
}

export function getKbRuntime(): KbRuntimeConfig {
  if (!configured) throw new Error("KB runtime is not configured");
  return configured;
}

export function resetKbRuntimeForTests(): void {
  configured = undefined;
}
