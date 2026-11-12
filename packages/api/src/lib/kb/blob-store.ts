import type { CasSniffMime } from "../sniff-mime";

export const BLOB_FRAME_BYTES = 256 * 1024;
export type BlobReadPurpose = "download" | "internal";

export type BlobPublishInput = {
  declaredMime: string;
  declaredHash: string;
  declaredSize: number;
  bytes: Buffer | AsyncIterable<Buffer>;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** Test hook invoked after durable bytes, before catalog insert. */
  afterDurableBytes?: () => Promise<void>;
};

/** Verified content and durability, never a filesystem path or inode. */
export type PublishedCasBlob = {
  hash: string;
  size: number;
  mime: CasSniffMime;
  durability:
    | { backend: "disk"; newBytes: boolean }
    | { backend: "s3"; storageGeneration: string; locator: string };
};

/** The owner must close on every exit, including failed verification/cancellation.
 * No descriptor or pathname escapes. close is idempotent and drains owned IO.
 * preflight prepares the source; the disk backend fully verifies before delivery.
 * complete guarantees full-object integrity/EOF before HEAD or the final requested frame.
 */
export type BlobReader = {
  readonly verified: boolean;
  /** Preserve caller shutdown/admission checks between bounded verification reads. */
  preflight(checkActive?: () => void): Promise<void>;
  readFrame(offset: number, length: number): Promise<Uint8Array>;
  complete(): Promise<void>;
  close(): Promise<void>;
  /** Non-throwing advisory sample, called only after successful download enqueue. */
  sampleDownload?(): void;
};

/** Import-pure dependency: construction performs no IO or ambient mode selection. */
export type BlobStore = {
  readonly backend: "disk" | "s3";
  publishVerified(input: BlobPublishInput): Promise<PublishedCasBlob>;
  open(input: {
    hash: string;
    size: number;
    purpose: BlobReadPurpose;
    signal: AbortSignal;
    deadlineAt?: number;
  }): Promise<BlobReader>;
  assertDurable(input: {
    hash: string;
    size: number;
    signal: AbortSignal;
    deadlineAt?: number;
  }): Promise<void>;
};
