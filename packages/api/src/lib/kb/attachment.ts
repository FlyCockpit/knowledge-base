import { createHash } from "node:crypto";

// RFC 4122 NAMESPACE_URL 6ba7b811-9dad-11d1-80b4-00c04fd430c8.
const UUID_NAMESPACE_URL = "6ba7b8119dad11d180b400c04fd430c8";

import { KbDomainError } from "./errors";
import type { Permission } from "./permissions";

export type KbWriteMode = "direct" | "proposal_required" | "read_only";

export type IndexState = "PENDING" | "BUILDING" | "INDEXING" | "COMPLETE" | "FAILED" | "SUPERSEDED";

export type Freshness = "current" | "stale" | "building" | "failed" | "unavailable";

export type IndexStatus = {
  activeGenerationId: string | null;
  desiredGenerationId: string | null;
  desiredEpoch: string;
  activeState: IndexState | null;
  desiredState: IndexState | null;
  indexedCommitSha: string | null;
  headSha: string;
  dimensions: number | null;
  fingerprint: string | null;
  freshness: Freshness;
  errorCode: string | null;
  /** The active generation was built under previous built-in embedder settings. */
  rebuildPending: IndexRebuildReason | null;
};
export type IndexRebuildReason =
  | "EMBEDDING_SETTINGS_CHANGED"
  | "EMBEDDING_MODEL_CHANGED"
  | "EMBEDDING_RUNTIME_RELOADING";

/**
 * Reasons that make every query vector unusable, so search runs the lexical arm
 * alone: an older model identity, or the built-in runtime being
 * stopped for a stop-then-probe config load probe.
 */
export function isLexicalOnlyReason(reason: IndexRebuildReason | null): boolean {
  return reason === "EMBEDDING_MODEL_CHANGED" || reason === "EMBEDDING_RUNTIME_RELOADING";
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

export function unavailableIndexStatus(headSha: string | null): IndexStatus {
  return {
    activeGenerationId: null,
    desiredGenerationId: null,
    desiredEpoch: "",
    activeState: null,
    desiredState: "PENDING",
    indexedCommitSha: null,
    headSha: headSha ?? ZERO_SHA,
    dimensions: null,
    fingerprint: null,
    freshness: "unavailable",
    errorCode: null,
    rebuildPending: null,
  };
}

export type KbAttachment = {
  id: string;
  name: string;
  slug: string;
  description: string;
  defaultBranch: "main";
  headSha: string;
  metadataVersion: number;
  capabilities: Permission[];
  writeMode: KbWriteMode;
  embeddingGeneration: string | null;
  attachmentLocator: string;
  sealedNamespace: string;
};

const REMOTE_ATTACHMENT_PREFIX = Buffer.from(
  "flycockpit/knowledge-attachment/v1\0remote\0",
  "utf8",
);

export function remoteAttachmentLocator(canonicalOrigin: string, kbId: string): string {
  const origin = canonicalOrigin.replace(/\/$/, "");
  return `${origin}/mcp#kb=${kbId}`;
}

/** UUIDv5 over NAMESPACE_URL over the attachment prefix and locator bytes (deterministic across renames). */
export function sealedNamespaceUuidV5(locator: string): string {
  return namespaceUuidV5(locator, UUID_NAMESPACE_URL);
}

function namespaceUuidV5(locator: string, namespace: string): string {
  const name = Buffer.concat([REMOTE_ATTACHMENT_PREFIX, Buffer.from(locator, "utf8")]);
  const hash = createHash("sha1").update(Buffer.from(namespace, "hex")).update(name).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function remoteSealedNamespace(canonicalOrigin: string, kbId: string): string {
  return sealedNamespaceUuidV5(remoteAttachmentLocator(canonicalOrigin, kbId));
}

export function writeModeFor(bits: readonly Permission[]): KbWriteMode {
  if (bits.includes("write")) return "direct";
  if (bits.includes("propose")) return "proposal_required";
  return "read_only";
}

export type KnowledgeBaseRow = {
  activeGenerationId: string | null;
  id: string;
  name: string;
  slug: string;
  description: string;
  headSha: string | null;
  metadataVersion: number;
  state: string;
};

export function buildKbAttachment(
  row: KnowledgeBaseRow,
  bits: readonly Permission[],
  canonicalOrigin: string,
): KbAttachment {
  if (row.state !== "ACTIVE" || !row.headSha) {
    throw new KbDomainError("REPAIR_REQUIRED", "Knowledge base requires repair");
  }
  return { ...buildKbViewerAttachment(row, bits, canonicalOrigin), headSha: row.headSha };
}

/** Human diagnostics retain unreadied KBs; they are never common attachments. */
export function buildKbViewerAttachment(
  row: KnowledgeBaseRow,
  bits: readonly Permission[],
  canonicalOrigin: string,
): Omit<KbAttachment, "headSha"> & { headSha: string | null } {
  const locator = remoteAttachmentLocator(canonicalOrigin, row.id);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    defaultBranch: "main",
    headSha: row.headSha,
    metadataVersion: row.metadataVersion,
    capabilities: [...bits],
    writeMode: writeModeFor(bits),
    embeddingGeneration: row.activeGenerationId,
    attachmentLocator: locator,
    sealedNamespace: remoteSealedNamespace(canonicalOrigin, row.id),
  };
}
