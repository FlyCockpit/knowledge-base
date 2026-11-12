/** Synthetic fixture values — no real credentials or production identifiers. */

export const FIXTURE_KB_ID = "abcdefghijklmnopqrstuvwx";
export const FIXTURE_UUID = "00000000-0000-4000-8000-000000000001";
export const FIXTURE_SHA = "0000000000000000000000000000000000000000";
export const FIXTURE_KEY = "fixture-idempotency-key-01";
export const FIXTURE_PATH = "docs/guide.md";

export const FIXTURE_KB_ATTACHMENT = {
  id: FIXTURE_KB_ID,
  name: "Fixture knowledge base",
  slug: "fixture-kb",
  description: "Synthetic KB attachment used only in protocol fixture corpus.",
  defaultBranch: "main" as const,
  headSha: FIXTURE_SHA,
  metadataVersion: 1,
  capabilities: ["read", "propose", "write", "review", "manage"],
  writeMode: "direct" as const,
  embeddingGeneration: null,
  attachmentLocator: "https://kb.example.test/mcp#kb=abcdefghijklmnopqrstuvwx",
  sealedNamespace: FIXTURE_UUID,
};

export const FIXTURE_INDEX_STATUS = {
  activeGenerationId: FIXTURE_KB_ID,
  desiredGenerationId: FIXTURE_KB_ID,
  desiredEpoch: "1",
  activeState: "COMPLETE" as const,
  desiredState: "COMPLETE" as const,
  indexedCommitSha: FIXTURE_SHA,
  headSha: FIXTURE_SHA,
  dimensions: 1024,
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  freshness: "current" as const,
  errorCode: null,
  rebuildPending: null,
};
