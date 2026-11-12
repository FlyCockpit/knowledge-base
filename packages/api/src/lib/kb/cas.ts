import type { BlobPublishInput, BlobStore, PublishedCasBlob } from "./blob-store";
import { KbDomainError } from "./errors";

export type { PublishedCasBlob } from "./blob-store";
export type CasPublishInput = BlobPublishInput & { blobStore: BlobStore };

export function parseCasHash(hash: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(hash);
  if (!match) throw new KbDomainError("INVALID_ARGUMENT", "Invalid content hash");
  return match[1]!;
}

/** Common publication boundary; the caller explicitly supplies storage authority. */
export function publishCasBytes({
  blobStore,
  ...input
}: CasPublishInput): Promise<PublishedCasBlob> {
  return blobStore.publishVerified(input);
}
