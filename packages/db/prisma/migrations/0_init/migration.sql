-- knowledge-base:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- knowledge-base:history-capture (records the history table for the commit marker; keep it here)
DO $knowledge_base$ BEGIN PERFORM set_config('knowledge_base.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $knowledge_base$;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateEnum
CREATE TYPE "KbAssetLineageSource" AS ENUM ('UPLOAD', 'IMPORT');

-- CreateEnum
CREATE TYPE "StagedUploadKind" AS ENUM ('MARKDOWN', 'ASSET');

-- CreateEnum
CREATE TYPE "StagedUploadState" AS ENUM ('WRITING', 'READY', 'CONSUMED', 'EXPIRED', 'ABORTED');

-- CreateEnum
CREATE TYPE "CasPublicationState" AS ENUM ('PENDING', 'FINALIZED', 'ABORTED');

-- CreateEnum
CREATE TYPE "ExportArtifactState" AS ENUM ('WRITING', 'READY', 'ABORTED', 'DOWNLOADED');

-- CreateEnum
CREATE TYPE "AssetCacheStatus" AS ENUM ('FILLING', 'READY', 'INVALID', 'EVICTING');

-- CreateEnum
CREATE TYPE "AssetStorageRole" AS ENUM ('SERVER', 'WORKER');

-- CreateEnum
CREATE TYPE "AssetRetainedStatus" AS ENUM ('PENDING', 'DURABLE');

-- CreateEnum
CREATE TYPE "IndexGenerationState" AS ENUM ('PENDING', 'BUILDING', 'INDEXING', 'COMPLETE', 'FAILED', 'SUPERSEDED', 'PURGED');

-- CreateEnum
CREATE TYPE "GenerationDocumentState" AS ENUM ('INDEXED', 'EMPTY', 'SKIPPED_REDACTED');

-- CreateEnum
CREATE TYPE "QueryEmbeddingState" AS ENUM ('PENDING', 'RUNNING', 'READY', 'DELIVERED', 'CANCELLED', 'DEADLINE_EXCEEDED', 'INDEX_UNAVAILABLE', 'EMBEDDING_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DurableJobState" AS ENUM ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRY', 'COMPLETE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DurableJobKind" AS ENUM ('PROBE', 'PROVIDER_PROBE', 'INDEX_KB', 'QUERY_EMBEDDING', 'PUSH_MIRROR', 'DOWNLOAD_MODEL', 'KB_EMAIL');

-- CreateEnum
CREATE TYPE "KbRemoteState" AS ENUM ('DISCONNECTED', 'PENDING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "DeployKeyState" AS ENUM ('PENDING', 'ACTIVE', 'RETIRED', 'DESTROYED');

-- CreateEnum
CREATE TYPE "MirrorAttemptState" AS ENUM ('QUEUED', 'RESERVED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LocalModelState" AS ENUM ('DISABLED', 'DOWNLOADING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "QwenProbeMode" AS ENUM ('SIDE_BY_SIDE', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "QwenReembedState" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "OperationIntentPhase" AS ENUM ('PREPARED', 'COMMITTING', 'FINALIZED', 'ABORTED');

-- CreateEnum
CREATE TYPE "BranchOwnerPurpose" AS ENUM ('USER', 'AUTO_PR');

-- CreateEnum
CREATE TYPE "PullRequestStatus" AS ENUM ('OPEN', 'CONFLICT', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "EmbeddingProviderKind" AS ENUM ('OPENAI_COMPAT', 'SYSTEM_BUILTIN');

-- CreateEnum
CREATE TYPE "KbTransferState" AS ENUM ('PENDING', 'ACCEPTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KnowledgeBaseState" AS ENUM ('CREATING', 'ACTIVE', 'TOMBSTONED', 'REPAIR_REQUIRED');

-- CreateEnum
CREATE TYPE "QuotaDimension" AS ENUM ('OWNER_LIVE_KB', 'KB_BRANCH', 'KB_HISTORY_BYTES', 'KB_LINEAGE_BYTES', 'OWNER_LINEAGE_BYTES', 'DISK_VOLUME');

-- CreateEnum
CREATE TYPE "QuotaReservationOutcome" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateEnum
CREATE TYPE "IndexQuantization" AS ENUM ('INT8', 'BINARY_INT8_RESCORE');

-- CreateEnum
CREATE TYPE "McpGrantKind" AS ENUM ('PAT', 'OAUTH');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "locale" TEXT NOT NULL DEFAULT 'en-US',
    "banned" BOOLEAN,
    "banReason" TEXT,
    "banExpires" TIMESTAMPTZ(3),
    "twoFactorEnabled" BOOLEAN,
    "twoFactorGraceStartedAt" TIMESTAMPTZ(3),
    "authorityVersion" INTEGER NOT NULL DEFAULT 0,
    "operationalAlerts" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "impersonatedBy" TEXT,
    "activeOrganizationId" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "issuer" TEXT NOT NULL DEFAULT 'local:credential',

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "userId" TEXT NOT NULL,

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_setting" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value" TEXT NOT NULL,

    CONSTRAINT "app_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "push_subscription" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bootstrap_state" (
    "id" TEXT NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "userId" TEXT,

    CONSTRAINT "bootstrap_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staged_upload" (
    "id" UUID NOT NULL,
    "kbId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "actorUserId" TEXT,
    "kind" "StagedUploadKind" NOT NULL,
    "declaredSize" INTEGER NOT NULL,
    "declaredHash" TEXT NOT NULL,
    "declaredMime" TEXT NOT NULL,
    "offset" INTEGER NOT NULL DEFAULT 0,
    "rollingHashHex" TEXT NOT NULL DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    "reservationIds" TEXT[],
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "readyExpiresAt" TIMESTAMPTZ(3),
    "state" "StagedUploadState" NOT NULL DEFAULT 'WRITING',
    "finishResponse" JSONB,
    "reservedByOpId" UUID,
    "consumedByOpId" UUID,
    "stagingReclaimedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staged_upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cas_publication" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "reservationIds" TEXT[],
    "state" "CasPublicationState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "cas_publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_blob" (
    "hash" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_blob_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "kb_asset_lineage" (
    "kbId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKey" TEXT NOT NULL,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "actorUserId" TEXT,
    "source" "KbAssetLineageSource" NOT NULL,
    "sourceKbId" TEXT,
    "sourceRev" TEXT
);

-- CreateTable
CREATE TABLE "export_artifact" (
    "id" UUID NOT NULL,
    "kbId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "rev" TEXT NOT NULL,
    "size" INTEGER,
    "contentHash" TEXT,
    "fileIdentity" TEXT,
    "frameHashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "offset" INTEGER NOT NULL DEFAULT 0,
    "reservationIds" TEXT[],
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "state" "ExportArtifactState" NOT NULL,
    "reclaimedAt" TIMESTAMPTZ(3),
    "downloadCompletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_cache_state" (
    "id" TEXT NOT NULL,
    "storageGeneration" UUID NOT NULL,
    "configuration" TEXT NOT NULL,
    "effectiveLimit" BIGINT NOT NULL,
    "chargedBytes" BIGINT NOT NULL DEFAULT 0,
    "fetchSequence" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "asset_cache_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_cache_owner" (
    "epoch" UUID NOT NULL,
    "cacheId" TEXT NOT NULL,
    "role" "AssetStorageRole" NOT NULL,
    "retired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "asset_cache_owner_pkey" PRIMARY KEY ("epoch")
);

-- CreateTable
CREATE TABLE "asset_cache_entry" (
    "cacheId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "incarnation" UUID NOT NULL,
    "size" INTEGER NOT NULL,
    "state" "AssetCacheStatus" NOT NULL,
    "fillOwner" UUID NOT NULL,
    "tempName" TEXT NOT NULL,
    "device" TEXT,
    "inode" TEXT,
    "mtimeNs" TEXT,
    "ctimeNs" TEXT,
    "tempDirectory" TEXT,
    "finalDirectory" TEXT,
    "finalAlias" BOOLEAN NOT NULL DEFAULT false,
    "cleanupAttempt" UUID,
    "cleanupOwner" UUID,
    "quotaReservations" TEXT[],
    "lastFetchSequence" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "asset_cache_entry_pkey" PRIMARY KEY ("cacheId","hash")
);

-- CreateTable
CREATE TABLE "asset_cache_pin" (
    "id" UUID NOT NULL,
    "incarnation" UUID NOT NULL,
    "ownerEpoch" UUID NOT NULL,

    CONSTRAINT "asset_cache_pin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_retained_object" (
    "storageGeneration" UUID NOT NULL,
    "locator" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "state" "AssetRetainedStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "asset_retained_object_pkey" PRIMARY KEY ("storageGeneration","locator","hash")
);

-- CreateTable
CREATE TABLE "index_generation" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "epoch" BIGINT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "providerId" TEXT,
    "providerVersion" INTEGER,
    "fingerprint" TEXT,
    "dimensions" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "state" "IndexGenerationState" NOT NULL DEFAULT 'PENDING',
    "documentCount" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(3),
    "quotaReservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "index_generation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "query_embedding_request" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "principal" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "queryCiphertext" TEXT,
    "resultCiphertext" TEXT,
    "state" "QueryEmbeddingState" NOT NULL DEFAULT 'PENDING',
    "deadline" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scrubAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "query_embedding_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_lease" (
    "requestId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "generation_lease_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "generation_document" (
    "generationId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "blobSha" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "originalWindowCount" INTEGER NOT NULL,
    "retainedWindowCount" INTEGER NOT NULL,
    "state" "GenerationDocumentState" NOT NULL,

    CONSTRAINT "generation_document_pkey" PRIMARY KEY ("generationId","path")
);

-- CreateTable
CREATE TABLE "durable_job" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupKey" TEXT NOT NULL,
    "kind" "DurableJobKind" NOT NULL,
    "desired" JSONB NOT NULL,
    "state" "DurableJobState" NOT NULL DEFAULT 'PENDING',
    "attemptEpoch" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "dispatchOwner" TEXT,
    "dispatchClaimUntil" TIMESTAMPTZ(3),
    "workerOwner" TEXT,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "nextRunAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,

    CONSTRAINT "durable_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "durable_job_probe_effect" (
    "jobId" TEXT NOT NULL,
    "attemptEpoch" INTEGER NOT NULL,
    "marker" TEXT NOT NULL,

    CONSTRAINT "durable_job_probe_effect_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "kb_remote" (
    "kbId" TEXT NOT NULL,
    "remoteVersion" INTEGER NOT NULL DEFAULT 0,
    "state" "KbRemoteState" NOT NULL DEFAULT 'DISCONNECTED',
    "activeKeyId" TEXT,
    "pendingKeyId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_remote_pkey" PRIMARY KEY ("kbId")
);

-- CreateTable
CREATE TABLE "kb_deploy_key_version" (
    "id" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "remoteVersion" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "hostKeys" TEXT[],
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ciphertext" TEXT,
    "state" "DeployKeyState" NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),
    "destroyedAt" TIMESTAMPTZ(3),

    CONSTRAINT "kb_deploy_key_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_mirror_attempt" (
    "id" UUID NOT NULL,
    "kbId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "remoteVersion" INTEGER NOT NULL,
    "actorKey" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "mainSha" TEXT NOT NULL,
    "state" "MirrorAttemptState" NOT NULL DEFAULT 'QUEUED',
    "resultCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "kb_mirror_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_local_model" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL DEFAULT 'embeddinggemma-2-q8_0',
    "pendingModelId" TEXT,
    "state" "LocalModelState" NOT NULL DEFAULT 'DISABLED',
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "bytesDownloaded" BIGINT NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "jobId" TEXT,
    "quotaReservationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "readyAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contextTokens" INTEGER NOT NULL DEFAULT 1024,
    "kvKeyType" TEXT NOT NULL DEFAULT 'f16',
    "kvValueType" TEXT NOT NULL DEFAULT 'f16',
    "configEpoch" INTEGER NOT NULL DEFAULT 0,
    "runtimeIdentity" TEXT,
    "pendingRuntimeIdentity" TEXT,
    "peakRssBytes" BIGINT,
    "memoryBudgetBytes" BIGINT,
    "memoryAvailableBytes" BIGINT,
    "memoryBudgetSource" TEXT,
    "memoryReportedAt" TIMESTAMPTZ(3),
    "pendingContextTokens" INTEGER,
    "pendingKvKeyType" TEXT,
    "pendingKvValueType" TEXT,
    "probeEpoch" INTEGER NOT NULL DEFAULT 0,
    "probeMode" "QwenProbeMode",
    "probeOwner" TEXT,
    "probeLeaseUntil" TIMESTAMPTZ(3),
    "configError" JSONB,
    "removeRequestedEpoch" INTEGER,

    CONSTRAINT "kb_local_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_qwen_reembed" (
    "kbId" TEXT NOT NULL,
    "configEpoch" INTEGER NOT NULL,
    "state" "QwenReembedState" NOT NULL,
    "lastQueriedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_qwen_reembed_pkey" PRIMARY KEY ("kbId")
);

-- CreateTable
CREATE TABLE "kb_qwen_reembed_lease" (
    "id" TEXT NOT NULL,
    "kbId" TEXT,
    "generationId" TEXT,
    "configEpoch" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_qwen_reembed_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_model_volume_lease" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "fence" INTEGER NOT NULL DEFAULT 1,
    "leaseUntil" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_model_volume_lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_intent" (
    "opId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "kbId" TEXT,
    "reservedKbId" TEXT,
    "actorKey" TEXT NOT NULL,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "actorUserId" TEXT,
    "operation" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "phase" "OperationIntentPhase" NOT NULL DEFAULT 'PREPARED',
    "refName" TEXT,
    "oldRef" TEXT,
    "newRef" TEXT,
    "preparedDelta" JSONB,
    "responseBody" JSONB,
    "resultRevision" TEXT,
    "resultStatus" TEXT,
    "publishNonce" TEXT NOT NULL,
    "abortReason" TEXT,
    "compactedAt" TIMESTAMPTZ(3),

    CONSTRAINT "operation_intent_pkey" PRIMARY KEY ("opId")
);

-- CreateTable
CREATE TABLE "branch_owner" (
    "kbId" TEXT NOT NULL,
    "refName" TEXT NOT NULL,
    "ownerActorKey" TEXT NOT NULL,
    "purpose" "BranchOwnerPurpose" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_owner_pkey" PRIMARY KEY ("kbId","refName")
);

-- CreateTable
CREATE TABLE "pull_request" (
    "kbId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "sourceBranch" TEXT NOT NULL,
    "targetBranch" TEXT NOT NULL DEFAULT 'main',
    "baseSha" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "targetSha" TEXT NOT NULL,
    "status" "PullRequestStatus" NOT NULL,
    "authorActorKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "mergeCommitSha" TEXT,
    "mergedByActorKey" TEXT,
    "isAutoPr" BOOLEAN NOT NULL DEFAULT false,
    "dreamMetadata" JSONB,
    "mergeCheckedSha" TEXT,
    "mergeCheckedKey" TEXT,
    "mergeCheckedEpoch" BIGINT,
    "pendingConflicts" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL
);

-- CreateTable
CREATE TABLE "embedding_provider" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "kind" "EmbeddingProviderKind" NOT NULL DEFAULT 'OPENAI_COMPAT',
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "embedding_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_revision" (
    "providerId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "ciphertext" TEXT,
    "aadVersion" INTEGER NOT NULL DEFAULT 1,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "ownerSnapshot" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "modelIdentity" TEXT,

    CONSTRAINT "provider_revision_pkey" PRIMARY KEY ("providerId","version")
);

-- CreateTable
CREATE TABLE "sealed_record" (
    "namespace" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "kbId" TEXT NOT NULL,
    "ownerId" TEXT,
    "ownerSnapshot" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "ciphertext" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "sealed_record_pkey" PRIMARY KEY ("namespace","recordId")
);

-- CreateTable
CREATE TABLE "sealed_consumer_grant" (
    "namespace" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "consumerKind" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "recipientKeyId" UUID NOT NULL,
    "recipientPublicKey" TEXT NOT NULL,
    "grantId" UUID,
    "authorizerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sealed_consumer_grant_pkey" PRIMARY KEY ("namespace","recordId","consumerKind","consumerId","recipientKeyId")
);

-- CreateTable
CREATE TABLE "kb_transfer" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kbId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "metadataVersion" INTEGER NOT NULL,
    "state" "KbTransferState" NOT NULL DEFAULT 'PENDING',
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "formerOwnerBits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "acceptedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "kb_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "state" "KnowledgeBaseState" NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "headSha" TEXT,
    "metadataVersion" INTEGER NOT NULL DEFAULT 1,
    "desiredEpoch" BIGINT NOT NULL DEFAULT 0,
    "sealedPolicyGeneration" BIGINT NOT NULL DEFAULT 0,
    "profileProviderId" TEXT,
    "profileVersion" INTEGER,
    "activeGenerationId" TEXT,
    "nextPrNumber" INTEGER NOT NULL DEFAULT 1,
    "lastQueriedAt" TIMESTAMPTZ(3),
    "indexQuantization" "IndexQuantization" NOT NULL DEFAULT 'BINARY_INT8_RESCORE',
    "indexChunkLimit" INTEGER,

    CONSTRAINT "knowledge_base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_share" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kbId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bits" TEXT[],
    "includeSealedValues" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "kb_share_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_invitation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kbId" TEXT NOT NULL,
    "inviterUserId" TEXT NOT NULL,
    "canonicalEmail" TEXT NOT NULL,
    "emailCiphertext" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "bits" TEXT[],
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "share_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_account" (
    "id" TEXT NOT NULL,
    "dimension" "QuotaDimension" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "committed" BIGINT NOT NULL DEFAULT 0,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quota_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_reservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "opId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "outcome" "QuotaReservationOutcome" NOT NULL DEFAULT 'RESERVED',
    "heldForPublication" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" "AuditOutcome" NOT NULL,
    "actorKey" TEXT NOT NULL,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "actorUserId" TEXT,
    "grantIdSnapshot" TEXT,
    "kbId" TEXT,
    "revision" TEXT,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_grant" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "userId" TEXT,
    "kind" "McpGrantKind" NOT NULL,
    "clientId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "scopes" TEXT[],
    "toolGroups" TEXT[],
    "allowCreate" BOOLEAN NOT NULL DEFAULT false,
    "createdKbBits" TEXT[],
    "revokedAt" TIMESTAMPTZ(3),
    "revokeReason" TEXT,
    "widenedAt" TIMESTAMPTZ(3),

    CONSTRAINT "mcp_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_kb_acl" (
    "grantId" UUID NOT NULL,
    "kbId" TEXT NOT NULL,
    "bits" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grant_kb_acl_pkey" PRIMARY KEY ("grantId","kbId")
);

-- CreateTable
CREATE TABLE "mcp_grant_elevation" (
    "id" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "toolGroups" TEXT[],
    "allowCreate" BOOLEAN NOT NULL DEFAULT false,
    "createdKbBits" TEXT[],
    "createdByUserIdSnapshot" TEXT NOT NULL,

    CONSTRAINT "mcp_grant_elevation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_elevation_kb_acl" (
    "elevationId" UUID NOT NULL,
    "kbId" TEXT NOT NULL,
    "bits" TEXT[],

    CONSTRAINT "grant_elevation_kb_acl_pkey" PRIMARY KEY ("elevationId","kbId")
);

-- CreateTable
CREATE TABLE "mcp_personal_token" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userIdSnapshot" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "lookupPrefix" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "grantId" UUID NOT NULL,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "mcp_personal_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_intent" (
    "id" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "nonce" UUID NOT NULL,
    "sessionDigest" TEXT NOT NULL,
    "queryDigest" TEXT NOT NULL,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "userId" TEXT,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "selection" JSONB,
    "grantId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "approvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "consent_intent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientDiscoveryId" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" TEXT[],
    "clientCredentialsScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT,
    "createdAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" TEXT[],
    "postLogoutRedirectUris" TEXT[],
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "applicationType" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" TEXT[],
    "responseTypes" TEXT[],
    "requirePKCE" BOOLEAN,
    "dpopBoundAccessTokens" BOOLEAN DEFAULT false,
    "referenceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "oauth_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_resource" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" JSONB,
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "policyVersion" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "oauth_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client_resource" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_client_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_refresh_token" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMPTZ(3),
    "rotatedAt" TIMESTAMPTZ(3),
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" TIMESTAMPTZ(3),
    "authTime" TIMESTAMPTZ(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "oauth_refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_access_token" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "refreshId" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMPTZ(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "oauth_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_consent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "scopes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client_assertion" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "oauth_client_assertion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "alg" TEXT,
    "crv" TEXT,

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_code" (
    "id" TEXT NOT NULL,
    "deviceCodeDigest" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL,
    "lastPolledAt" TIMESTAMPTZ(3),
    "pollingInterval" INTEGER,
    "clientId" TEXT,
    "scope" TEXT,
    "recipientKey" JSONB,

    CONSTRAINT "device_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_approval" (
    "id" TEXT NOT NULL,
    "deviceCodeDigest" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "nonce" UUID NOT NULL,
    "sessionDigest" TEXT NOT NULL,
    "actorUserIdSnapshot" TEXT NOT NULL,
    "userId" TEXT,
    "resource" TEXT NOT NULL,
    "selection" JSONB,
    "patExpiresAt" TIMESTAMPTZ(3),
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "approvedAt" TIMESTAMPTZ(3),
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "device_approval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_role_idx" ON "user"("role");

-- CreateIndex
CREATE INDEX "user_email_idx" ON "user" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "user_name_idx" ON "user" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expiresAt_idx" ON "verification"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_userId_key" ON "two_factor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscription_endpoint_key" ON "push_subscription"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscription_userId_idx" ON "push_subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "bootstrap_state_userId_key" ON "bootstrap_state"("userId");

-- CreateIndex
CREATE INDEX "staged_upload_kbId_state_idx" ON "staged_upload"("kbId", "state");

-- CreateIndex
CREATE INDEX "staged_upload_expiresAt_state_idx" ON "staged_upload"("expiresAt", "state");

-- CreateIndex
CREATE INDEX "staged_upload_readyExpiresAt_state_idx" ON "staged_upload"("readyExpiresAt", "state");

-- CreateIndex
CREATE INDEX "staged_upload_state_stagingReclaimedAt_idx" ON "staged_upload"("state", "stagingReclaimedAt");

-- CreateIndex
CREATE INDEX "cas_publication_state_kbId_id_idx" ON "cas_publication"("state", "kbId", "id");

-- CreateIndex
CREATE INDEX "kb_asset_lineage_hash_idx" ON "kb_asset_lineage"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "kb_asset_lineage_kb_hash_unique" ON "kb_asset_lineage"("kbId", "hash");

-- CreateIndex
CREATE INDEX "export_artifact_state_expiresAt_idx" ON "export_artifact"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "export_artifact_reclaimedAt_id_idx" ON "export_artifact"("reclaimedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "export_artifact_actorKey_kbId_idempotencyKey_key" ON "export_artifact"("actorKey", "kbId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "asset_cache_owner_cacheId_role_retired_idx" ON "asset_cache_owner"("cacheId", "role", "retired");

-- CreateIndex
CREATE UNIQUE INDEX "asset_cache_entry_incarnation_key" ON "asset_cache_entry"("incarnation");

-- CreateIndex
CREATE INDEX "asset_cache_entry_cacheId_state_hash_idx" ON "asset_cache_entry"("cacheId", "state", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "asset_cache_entry_cacheId_tempName_key" ON "asset_cache_entry"("cacheId", "tempName");

-- CreateIndex
CREATE INDEX "asset_cache_pin_incarnation_idx" ON "asset_cache_pin"("incarnation");

-- CreateIndex
CREATE INDEX "asset_cache_pin_ownerEpoch_id_idx" ON "asset_cache_pin"("ownerEpoch", "id");

-- CreateIndex
CREATE UNIQUE INDEX "index_generation_jobId_key" ON "index_generation"("jobId");

-- CreateIndex
CREATE INDEX "index_generation_state_retiredAt_idx" ON "index_generation"("state", "retiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "index_generation_kbId_id_key" ON "index_generation"("kbId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "index_generation_kbId_epoch_key" ON "index_generation"("kbId", "epoch");

-- CreateIndex
CREATE INDEX "query_embedding_request_userId_deadline_idx" ON "query_embedding_request"("userId", "deadline");

-- CreateIndex
CREATE INDEX "query_embedding_request_scrubAt_idx" ON "query_embedding_request"("scrubAt");

-- CreateIndex
CREATE INDEX "generation_lease_generationId_expiresAt_idx" ON "generation_lease"("generationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "durable_job_dedupKey_key" ON "durable_job"("dedupKey");

-- CreateIndex
CREATE INDEX "durable_job_state_nextRunAt_idx" ON "durable_job"("state", "nextRunAt");

-- CreateIndex
CREATE INDEX "durable_job_dispatchClaimUntil_idx" ON "durable_job"("dispatchClaimUntil");

-- CreateIndex
CREATE UNIQUE INDEX "kb_deploy_key_version_kbId_keyVersion_key" ON "kb_deploy_key_version"("kbId", "keyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "kb_deploy_key_version_kbId_id_key" ON "kb_deploy_key_version"("kbId", "id");

-- CreateIndex
CREATE INDEX "kb_mirror_attempt_kbId_state_idx" ON "kb_mirror_attempt"("kbId", "state");

-- CreateIndex
CREATE INDEX "kb_mirror_attempt_kbId_createdAt_id_idx" ON "kb_mirror_attempt"("kbId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "kb_local_model_jobId_key" ON "kb_local_model"("jobId");

-- CreateIndex
CREATE INDEX "kb_qwen_reembed_state_configEpoch_idx" ON "kb_qwen_reembed"("state", "configEpoch");

-- CreateIndex
CREATE INDEX "operation_intent_kbId_phase_idx" ON "operation_intent"("kbId", "phase");

-- CreateIndex
CREATE INDEX "operation_intent_phase_createdAt_idx" ON "operation_intent"("phase", "createdAt");

-- CreateIndex
CREATE INDEX "operation_intent_compactedAt_createdAt_idx" ON "operation_intent"("compactedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "operation_intent_actor_kb_op_key" ON "operation_intent"("actorKey", "kbId", "operation", "idempotencyKey");

-- CreateIndex
CREATE INDEX "branch_owner_kbId_ownerActorKey_idx" ON "branch_owner"("kbId", "ownerActorKey");

-- CreateIndex
CREATE INDEX "pull_request_kbId_status_idx" ON "pull_request"("kbId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pull_request_kbId_number_key" ON "pull_request"("kbId", "number");

-- CreateIndex
CREATE INDEX "embedding_provider_ownerId_createdAt_id_idx" ON "embedding_provider"("ownerId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "provider_revision_jobId_idx" ON "provider_revision"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_revision_ownerSnapshot_idempotencyKey_key" ON "provider_revision"("ownerSnapshot", "idempotencyKey");

-- CreateIndex
CREATE INDEX "sealed_record_kbId_namespace_recordId_idx" ON "sealed_record"("kbId", "namespace", "recordId");

-- CreateIndex
CREATE INDEX "sealed_record_ownerSnapshot_idx" ON "sealed_record"("ownerSnapshot");

-- CreateIndex
CREATE INDEX "sealed_consumer_grant_authorizerId_idx" ON "sealed_consumer_grant"("authorizerId");

-- CreateIndex
CREATE INDEX "sealed_consumer_grant_grantId_idx" ON "sealed_consumer_grant"("grantId");

-- CreateIndex
CREATE UNIQUE INDEX "kb_transfer_requestId_key" ON "kb_transfer"("requestId");

-- CreateIndex
CREATE INDEX "kb_transfer_kbId_state_idx" ON "kb_transfer"("kbId", "state");

-- CreateIndex
CREATE INDEX "kb_transfer_toUserId_idx" ON "kb_transfer"("toUserId");

-- CreateIndex
CREATE UNIQUE INDEX "kb_transfer_owner_kb_key_unique" ON "kb_transfer"("fromUserId", "kbId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "knowledge_base_ownerId_idx" ON "knowledge_base"("ownerId");

-- CreateIndex
CREATE INDEX "knowledge_base_state_idx" ON "knowledge_base"("state");

-- CreateIndex
CREATE INDEX "kb_share_userId_idx" ON "kb_share"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "kb_share_kb_user_unique" ON "kb_share"("kbId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "share_invitation_requestId_key" ON "share_invitation"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "share_invitation_kb_email_unique" ON "share_invitation"("kbId", "canonicalEmail");

-- CreateIndex
CREATE UNIQUE INDEX "share_invitation_inviter_kb_key_unique" ON "share_invitation"("inviterUserId", "kbId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "quota_account_dimension_subject" ON "quota_account"("dimension", "subjectId");

-- CreateIndex
CREATE INDEX "quota_reservation_expiresAt_idx" ON "quota_reservation"("expiresAt");

-- CreateIndex
CREATE INDEX "quota_reservation_opId_idx" ON "quota_reservation"("opId");

-- CreateIndex
CREATE INDEX "audit_event_kbId_idx" ON "audit_event"("kbId");

-- CreateIndex
CREATE INDEX "audit_event_actorUserId_idx" ON "audit_event"("actorUserId");

-- CreateIndex
CREATE INDEX "audit_event_createdAt_id_idx" ON "audit_event"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_event_op_action_outcome" ON "audit_event"("opId", "action", "outcome");

-- CreateIndex
CREATE INDEX "mcp_grant_userId_revokedAt_idx" ON "mcp_grant"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_grant_actor_client_reference" ON "mcp_grant"("actorUserIdSnapshot", "clientId", "referenceId");

-- CreateIndex
CREATE INDEX "grant_kb_acl_kbId_idx" ON "grant_kb_acl"("kbId");

-- CreateIndex
CREATE INDEX "mcp_grant_elevation_grantId_revokedAt_expiresAt_idx" ON "mcp_grant_elevation"("grantId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "grant_elevation_kb_acl_kbId_idx" ON "grant_elevation_kb_acl"("kbId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_personal_token_grantId_key" ON "mcp_personal_token"("grantId");

-- CreateIndex
CREATE INDEX "mcp_personal_token_userId_revokedAt_expiresAt_idx" ON "mcp_personal_token"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_personal_token_lookup_prefix" ON "mcp_personal_token"("lookupPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_personal_token_secret_digest" ON "mcp_personal_token"("secretDigest");

-- CreateIndex
CREATE UNIQUE INDEX "consent_intent_referenceId_key" ON "consent_intent"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "consent_intent_nonce_key" ON "consent_intent"("nonce");

-- CreateIndex
CREATE INDEX "consent_intent_grantId_idx" ON "consent_intent"("grantId");

-- CreateIndex
CREATE INDEX "consent_intent_approvedAt_grantId_expiresAt_idx" ON "consent_intent"("approvedAt", "grantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "consent_intent_sessionDigest_queryDigest_key" ON "consent_intent"("sessionDigest", "queryDigest");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_clientId_key" ON "oauth_client"("clientId");

-- CreateIndex
CREATE INDEX "oauth_client_userId_idx" ON "oauth_client"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_resource_identifier_key" ON "oauth_resource"("identifier");

-- CreateIndex
CREATE INDEX "oauth_client_resource_clientId_idx" ON "oauth_client_resource"("clientId");

-- CreateIndex
CREATE INDEX "oauth_client_resource_resourceId_idx" ON "oauth_client_resource"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_resource_clientId_resourceId_key" ON "oauth_client_resource"("clientId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_refresh_token_token_key" ON "oauth_refresh_token"("token");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_clientId_idx" ON "oauth_refresh_token"("clientId");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_sessionId_idx" ON "oauth_refresh_token"("sessionId");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_userId_idx" ON "oauth_refresh_token"("userId");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_expiresAt_idx" ON "oauth_refresh_token"("expiresAt");

-- CreateIndex
CREATE INDEX "oauth_refresh_token_authorizationCodeId_idx" ON "oauth_refresh_token"("authorizationCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_token_token_key" ON "oauth_access_token"("token");

-- CreateIndex
CREATE INDEX "oauth_access_token_clientId_idx" ON "oauth_access_token"("clientId");

-- CreateIndex
CREATE INDEX "oauth_access_token_sessionId_idx" ON "oauth_access_token"("sessionId");

-- CreateIndex
CREATE INDEX "oauth_access_token_userId_idx" ON "oauth_access_token"("userId");

-- CreateIndex
CREATE INDEX "oauth_access_token_authorizationCodeId_idx" ON "oauth_access_token"("authorizationCodeId");

-- CreateIndex
CREATE INDEX "oauth_access_token_refreshId_idx" ON "oauth_access_token"("refreshId");

-- CreateIndex
CREATE INDEX "oauth_access_token_expiresAt_idx" ON "oauth_access_token"("expiresAt");

-- CreateIndex
CREATE INDEX "oauth_consent_clientId_idx" ON "oauth_consent"("clientId");

-- CreateIndex
CREATE INDEX "oauth_consent_userId_idx" ON "oauth_consent"("userId");

-- CreateIndex
CREATE INDEX "oauth_client_assertion_expiresAt_idx" ON "oauth_client_assertion"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_code_deviceCodeDigest_key" ON "device_code"("deviceCodeDigest");

-- CreateIndex
CREATE UNIQUE INDEX "device_code_userCode_key" ON "device_code"("userCode");

-- CreateIndex
CREATE INDEX "device_code_expiresAt_idx" ON "device_code"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "device_approval_deviceCodeDigest_key" ON "device_approval"("deviceCodeDigest");

-- CreateIndex
CREATE UNIQUE INDEX "device_approval_nonce_key" ON "device_approval"("nonce");

-- CreateIndex
CREATE INDEX "device_approval_expiresAt_idx" ON "device_approval"("expiresAt");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bootstrap_state" ADD CONSTRAINT "bootstrap_state_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staged_upload" ADD CONSTRAINT "staged_upload_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staged_upload" ADD CONSTRAINT "staged_upload_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cas_publication" ADD CONSTRAINT "cas_publication_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_asset_lineage" ADD CONSTRAINT "kb_asset_lineage_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_asset_lineage" ADD CONSTRAINT "kb_asset_lineage_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_asset_lineage" ADD CONSTRAINT "kb_asset_lineage_hash_fkey" FOREIGN KEY ("hash") REFERENCES "asset_blob"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_artifact" ADD CONSTRAINT "export_artifact_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_cache_owner" ADD CONSTRAINT "asset_cache_owner_cacheId_fkey" FOREIGN KEY ("cacheId") REFERENCES "asset_cache_state"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_cache_entry" ADD CONSTRAINT "asset_cache_entry_cacheId_fkey" FOREIGN KEY ("cacheId") REFERENCES "asset_cache_state"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_cache_pin" ADD CONSTRAINT "asset_cache_pin_incarnation_fkey" FOREIGN KEY ("incarnation") REFERENCES "asset_cache_entry"("incarnation") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_cache_pin" ADD CONSTRAINT "asset_cache_pin_ownerEpoch_fkey" FOREIGN KEY ("ownerEpoch") REFERENCES "asset_cache_owner"("epoch") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_generation" ADD CONSTRAINT "index_generation_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_generation" ADD CONSTRAINT "index_generation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "durable_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "index_generation" ADD CONSTRAINT "index_generation_providerId_providerVersion_fkey" FOREIGN KEY ("providerId", "providerVersion") REFERENCES "provider_revision"("providerId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "query_embedding_request" ADD CONSTRAINT "query_embedding_request_id_fkey" FOREIGN KEY ("id") REFERENCES "durable_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "query_embedding_request" ADD CONSTRAINT "query_embedding_request_kbId_generationId_fkey" FOREIGN KEY ("kbId", "generationId") REFERENCES "index_generation"("kbId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_lease" ADD CONSTRAINT "generation_lease_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "query_embedding_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_lease" ADD CONSTRAINT "generation_lease_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "index_generation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_document" ADD CONSTRAINT "generation_document_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "index_generation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "durable_job_probe_effect" ADD CONSTRAINT "durable_job_probe_effect_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "durable_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_remote" ADD CONSTRAINT "kb_remote_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_deploy_key_version" ADD CONSTRAINT "kb_deploy_key_version_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "kb_remote"("kbId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_mirror_attempt" ADD CONSTRAINT "kb_mirror_attempt_kbId_keyId_fkey" FOREIGN KEY ("kbId", "keyId") REFERENCES "kb_deploy_key_version"("kbId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_local_model" ADD CONSTRAINT "kb_local_model_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "durable_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_qwen_reembed" ADD CONSTRAINT "kb_qwen_reembed_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_intent" ADD CONSTRAINT "operation_intent_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_intent" ADD CONSTRAINT "operation_intent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_owner" ADD CONSTRAINT "branch_owner_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_kbId_sourceBranch_fkey" FOREIGN KEY ("kbId", "sourceBranch") REFERENCES "branch_owner"("kbId", "refName") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embedding_provider" ADD CONSTRAINT "embedding_provider_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_revision" ADD CONSTRAINT "provider_revision_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "embedding_provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_revision" ADD CONSTRAINT "provider_revision_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "durable_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_record" ADD CONSTRAINT "sealed_record_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_record" ADD CONSTRAINT "sealed_record_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_consumer_grant" ADD CONSTRAINT "sealed_consumer_grant_namespace_recordId_fkey" FOREIGN KEY ("namespace", "recordId") REFERENCES "sealed_record"("namespace", "recordId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sealed_consumer_grant" ADD CONSTRAINT "sealed_consumer_grant_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "mcp_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_transfer" ADD CONSTRAINT "kb_transfer_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_transfer" ADD CONSTRAINT "kb_transfer_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_transfer" ADD CONSTRAINT "kb_transfer_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_profileProviderId_profileVersion_fkey" FOREIGN KEY ("profileProviderId", "profileVersion") REFERENCES "provider_revision"("providerId", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_id_activeGenerationId_fkey" FOREIGN KEY ("id", "activeGenerationId") REFERENCES "index_generation"("kbId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "kb_share" ADD CONSTRAINT "kb_share_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_share" ADD CONSTRAINT "kb_share_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_invitation" ADD CONSTRAINT "share_invitation_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_invitation" ADD CONSTRAINT "share_invitation_inviterUserId_fkey" FOREIGN KEY ("inviterUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_reservation" ADD CONSTRAINT "quota_reservation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "quota_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_grant" ADD CONSTRAINT "mcp_grant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_kb_acl" ADD CONSTRAINT "grant_kb_acl_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "mcp_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_kb_acl" ADD CONSTRAINT "grant_kb_acl_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_grant_elevation" ADD CONSTRAINT "mcp_grant_elevation_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "mcp_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_elevation_kb_acl" ADD CONSTRAINT "grant_elevation_kb_acl_elevationId_fkey" FOREIGN KEY ("elevationId") REFERENCES "mcp_grant_elevation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_elevation_kb_acl" ADD CONSTRAINT "grant_elevation_kb_acl_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_personal_token" ADD CONSTRAINT "mcp_personal_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_personal_token" ADD CONSTRAINT "mcp_personal_token_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "mcp_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_intent" ADD CONSTRAINT "consent_intent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_intent" ADD CONSTRAINT "consent_intent_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "mcp_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "oauth_refresh_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oauth_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consent" ADD CONSTRAINT "oauth_consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_approval" ADD CONSTRAINT "device_approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Folded from knowledge-constraints.sql; future changes belong in a new migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.knowledge_base'::regclass
      AND conname = 'knowledge_base_active_requires_owner_head'
  ) THEN
    ALTER TABLE public.knowledge_base
      ADD CONSTRAINT knowledge_base_active_requires_owner_head
      CHECK ((state <> 'ACTIVE'::"KnowledgeBaseState") OR ("ownerId" IS NOT NULL AND "headSha" IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quota_account'::regclass
      AND conname = 'quota_account_nonnegative'
  ) THEN
    ALTER TABLE public.quota_account
      ADD CONSTRAINT quota_account_nonnegative
      CHECK (committed >= (0)::bigint AND reserved >= (0)::bigint);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.quota_reservation'::regclass
      AND conname = 'quota_reservation_positive_amount'
  ) THEN
    ALTER TABLE public.quota_reservation
      ADD CONSTRAINT quota_reservation_positive_amount
      CHECK (amount > (0)::bigint);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_base_live_owner_slug
  ON public.knowledge_base ("ownerId", slug)
  WHERE "ownerId" IS NOT NULL AND state <> 'TOMBSTONED'::"KnowledgeBaseState";

-- Folded from kb-operations-constraints.sql; future changes belong in a new migration.
-- KB_CREATE idempotency: actor+operation+key unique for create reservations.
CREATE UNIQUE INDEX IF NOT EXISTS operation_intent_kb_create_actor_key
  ON "operation_intent" ("actorKey", operation, "idempotencyKey")
  WHERE operation = 'KB_CREATE';

-- Folded from pr-constraints.sql; future changes belong in a new migration.
-- Partial unique indexes for active pull requests (OPEN and CONFLICT are active).
CREATE UNIQUE INDEX IF NOT EXISTS pull_request_active_per_source
  ON public.pull_request ("kbId", "sourceBranch")
  WHERE status IN ('OPEN'::"PullRequestStatus", 'CONFLICT'::"PullRequestStatus");

CREATE UNIQUE INDEX IF NOT EXISTS pull_request_active_auto_pr_per_actor
  ON public.pull_request ("kbId", "authorActorKey")
  WHERE "isAutoPr" = true
    AND status IN ('OPEN'::"PullRequestStatus", 'CONFLICT'::"PullRequestStatus");

-- Folded from kb-assets-constraints.sql; future changes belong in a new migration.
-- Asset catalog and lineage checks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.asset_blob'::regclass
      AND conname = 'asset_blob_hash_format'
  ) THEN
    ALTER TABLE public.asset_blob
      ADD CONSTRAINT asset_blob_hash_format
      CHECK (hash ~ '^sha256:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.asset_blob'::regclass
      AND conname = 'asset_blob_size_bounds'
  ) THEN
    ALTER TABLE public.asset_blob
      ADD CONSTRAINT asset_blob_size_bounds
      CHECK (size > 0 AND size <= 26214400);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.staged_upload'::regclass
      AND conname = 'staged_upload_declared_hash_format'
  ) THEN
    ALTER TABLE public.staged_upload
      ADD CONSTRAINT staged_upload_declared_hash_format
      CHECK ("declaredHash" ~ '^sha256:[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.staged_upload'::regclass
      AND conname = 'staged_upload_declared_size_bounds'
  ) THEN
    ALTER TABLE public.staged_upload
      ADD CONSTRAINT staged_upload_declared_size_bounds
      CHECK ("declaredSize" > 0 AND "declaredSize" <= 26214400);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.staged_upload'::regclass
      AND conname = 'staged_upload_offset_bounds'
  ) THEN
    ALTER TABLE public.staged_upload
      ADD CONSTRAINT staged_upload_offset_bounds
      CHECK ("offset" >= 0 AND "offset" <= "declaredSize");
  END IF;
END
$$;

-- Folded from generation-constraints.sql; future changes belong in a new migration.
-- The application role owns public; nobody else may create objects there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Row triggers already hold table/row locks. Waiting for the builder's attempt fence here
-- could deadlock a writer transaction, so the fence is a try-lock (55P03 when busy).
CREATE OR REPLACE FUNCTION public.kb_lock_generation(generation_id text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(generation_id, 23)) THEN
    RAISE EXCEPTION 'Generation build fence busy' USING ERRCODE = '55P03';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = 'public.index_generation'::regclass AND conname = 'generation_snapshot_bounds') THEN
    ALTER TABLE public.index_generation ADD CONSTRAINT generation_snapshot_bounds CHECK (
      dimensions >= 1 AND dimensions <= 2000 AND epoch >= 0 AND attempt > 0
      AND "documentCount" >= 0 AND "chunkCount" >= 0
      AND id ~ '^[a-z0-9]{24,32}$' AND "commitSha" ~ '^[a-f0-9]{40}$'
      AND fingerprint ~ '^sha256:[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid = 'public.generation_document'::regclass AND conname = 'generation_document_bounds') THEN
    ALTER TABLE public.generation_document ADD CONSTRAINT generation_document_bounds CHECK (
      "blobSha" ~ '^[a-f0-9]{40}$' AND "contentHash" ~ '^sha256:[a-f0-9]{64}$'
      AND "originalWindowCount" >= 0 AND "retainedWindowCount" BETWEEN 0 AND "originalWindowCount"
      AND ((state = 'EMPTY' AND "originalWindowCount" = 0)
        OR (state = 'SKIPPED_REDACTED' AND "originalWindowCount" > 0 AND "retainedWindowCount" = 0)
        OR (state = 'INDEXED' AND "retainedWindowCount" > 0)));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.kb_guard_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM public.kb_lock_generation(NEW.id);
  IF TG_OP = 'UPDATE' AND
    (OLD.id, OLD."kbId", OLD.epoch, OLD."commitSha", OLD."providerId", OLD."providerVersion", OLD.fingerprint, OLD.dimensions, OLD."jobId")
    IS DISTINCT FROM
    (NEW.id, NEW."kbId", NEW.epoch, NEW."commitSha", NEW."providerId", NEW."providerVersion", NEW.fingerprint, NEW.dimensions, NEW."jobId") THEN
    RAISE EXCEPTION 'Immutable generation snapshot' USING ERRCODE = '23514';
  END IF;
  -- I1: disk reservations belong only to the live BUILDING attempt; publish and failure release
  -- them and clear the ids in the same statement as the state change.
  IF cardinality(NEW."quotaReservationIds") > 0 AND NEW.state <> 'BUILDING' THEN
    RAISE EXCEPTION 'Reservations outside BUILDING' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.attempt IS DISTINCT FROM NEW.attempt OR
    (OLD."documentCount", OLD."chunkCount") IS DISTINCT FROM (NEW."documentCount", NEW."chunkCount") OR
    (NEW.state = 'BUILDING' AND OLD.state IN ('FAILED', 'INDEXING'))
  ) AND NOT (
    NEW.state = 'BUILDING' AND OLD.state IN ('PENDING','BUILDING','INDEXING','FAILED')
    AND NEW.attempt >= OLD.attempt
    AND (OLD.state IN ('PENDING','BUILDING') OR NEW.attempt > OLD.attempt)
    AND EXISTS (SELECT FROM public.durable_job j WHERE j.id = NEW."jobId"
      AND j."attemptEpoch" = NEW.attempt AND j.state = 'RUNNING'
      AND j."cancelledAt" IS NULL AND j."leaseUntil" > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Invalid generation attempt or accounting' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- A lexical-only (FTS5) generation pins no embedding profile: all four columns are null.
    IF NEW.state <> 'PENDING' OR NOT (
      (NEW."providerId" IS NULL AND NEW."providerVersion" IS NULL
        AND NEW.fingerprint IS NULL AND NEW.dimensions IS NULL)
      OR EXISTS (SELECT FROM public.provider_revision
        WHERE "providerId" = NEW."providerId" AND version = NEW."providerVersion"
          AND dimensions = NEW.dimensions AND fingerprint = NEW.fingerprint)) THEN
      RAISE EXCEPTION 'Invalid generation snapshot' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'PENDING' AND NEW.state IN ('BUILDING', 'FAILED', 'SUPERSEDED')) OR
    (OLD.state = 'BUILDING' AND NEW.state IN ('INDEXING', 'FAILED', 'SUPERSEDED')) OR
    (OLD.state = 'INDEXING' AND NEW.state IN ('COMPLETE', 'FAILED', 'SUPERSEDED')) OR
    (OLD.state = 'COMPLETE' AND NEW.state = 'SUPERSEDED') OR
    (OLD.state IN ('FAILED','INDEXING') AND NEW.state = 'BUILDING' AND NEW.attempt > OLD.attempt) OR
    (OLD.state IN ('SUPERSEDED','FAILED') AND NEW.state = 'PURGED')) THEN
    RAISE EXCEPTION 'Invalid generation transition' USING ERRCODE = '23514';
  END IF;
  -- Retention tombstone: only a retired, unleased generation without build accounting rows.
  -- Its index file is unlinked after this transaction commits.
  IF TG_OP = 'UPDATE' AND NEW.state = 'PURGED' AND OLD.state <> 'PURGED' AND (
    EXISTS (SELECT FROM public.knowledge_base WHERE "activeGenerationId" = OLD.id)
    OR EXISTS (SELECT FROM public.generation_lease WHERE "generationId" = OLD.id AND "expiresAt" > clock_timestamp())
    OR EXISTS (SELECT FROM public.generation_document WHERE "generationId" = OLD.id)) THEN
    RAISE EXCEPTION 'Generation still referenced' USING ERRCODE = '23514';
  END IF;
  -- Retention clock: owned by this trigger, never by callers.
  IF TG_OP = 'INSERT' THEN
    NEW."retiredAt" := NULL;
  ELSIF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW."retiredAt" := CASE WHEN NEW.state IN ('SUPERSEDED', 'FAILED') THEN clock_timestamp()
      WHEN NEW.state = 'PURGED' THEN OLD."retiredAt" ELSE NULL END;
  ELSE
    NEW."retiredAt" := OLD."retiredAt";
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'COMPLETE' AND NEW.state = 'SUPERSEDED' AND
    EXISTS (SELECT FROM public.knowledge_base WHERE "activeGenerationId" = OLD.id) THEN
    RAISE EXCEPTION 'Invalid generation transition' USING ERRCODE = '23514';
  END IF;
  -- COMPLETE only with exact accounting; the worker verified the published file's counts
  -- against these before INDEXING.
  IF NEW.state = 'COMPLETE' AND (
    NEW."documentCount" <> (SELECT count(*) FROM public.generation_document WHERE "generationId" = NEW.id)
    OR NEW."chunkCount" <> (SELECT COALESCE(sum("retainedWindowCount"), 0) FROM public.generation_document
      WHERE "generationId" = NEW.id)) THEN
    RAISE EXCEPTION 'Incomplete generation accounting' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER generation_guard BEFORE INSERT OR UPDATE ON public.index_generation
  FOR EACH ROW EXECUTE FUNCTION public.kb_guard_generation();

CREATE OR REPLACE FUNCTION public.kb_guard_document() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.kb_lock_generation(OLD."generationId");
    PERFORM FROM public.index_generation WHERE id = OLD."generationId" FOR UPDATE;
    IF NOT EXISTS (SELECT FROM public.index_generation WHERE id = OLD."generationId" AND state IN ('BUILDING', 'FAILED', 'SUPERSEDED'))
      OR EXISTS (SELECT FROM public.knowledge_base WHERE "activeGenerationId" = OLD."generationId")
      OR EXISTS (SELECT FROM public.generation_lease WHERE "generationId" = OLD."generationId" AND "expiresAt" > clock_timestamp()) THEN
      RAISE EXCEPTION 'Immutable generation document' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM public.kb_lock_generation(NEW."generationId");
  IF TG_OP = 'UPDATE' OR NOT EXISTS (SELECT FROM public.index_generation WHERE id = NEW."generationId" AND state = 'BUILDING') THEN
    RAISE EXCEPTION 'Immutable generation document' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER generation_document_guard BEFORE INSERT OR UPDATE OR DELETE ON public.generation_document
  FOR EACH ROW EXECUTE FUNCTION public.kb_guard_document();

CREATE OR REPLACE FUNCTION public.kb_guard_active_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."activeGenerationId" IS NOT NULL AND
    (TG_OP = 'INSERT' OR NEW."activeGenerationId" IS DISTINCT FROM OLD."activeGenerationId") AND
    (NEW.state <> 'ACTIVE' OR NOT EXISTS (SELECT FROM public.index_generation
      WHERE id = NEW."activeGenerationId" AND "kbId" = NEW.id AND state = 'COMPLETE')) THEN
    RAISE EXCEPTION 'Invalid active generation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER active_generation_guard BEFORE INSERT OR UPDATE ON public.knowledge_base
  FOR EACH ROW EXECUTE FUNCTION public.kb_guard_active_generation();

-- A lease pins only a queryable generation. KEY SHARE waits for retention's FOR UPDATE and
-- re-reads the committed state, so a lease can never attach to a generation being purged.
CREATE OR REPLACE FUNCTION public.kb_guard_lease() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM public.index_generation WHERE id = NEW."generationId"
      AND state IN ('COMPLETE', 'SUPERSEDED') FOR KEY SHARE) THEN
    RAISE EXCEPTION 'Generation is not leasable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER generation_lease_guard BEFORE INSERT OR UPDATE ON public.generation_lease
  FOR EACH ROW EXECUTE FUNCTION public.kb_guard_lease();

-- I2: an index job cannot be cancelled while its generation references an unreleased disk
-- reservation. Index cancellers release first (cancelIndexBuildJobs). No lock: the target job
-- row is locked before a BEFORE ROW trigger fires, and PL/pgSQL reads a fresh snapshot.
CREATE OR REPLACE FUNCTION public.kb_guard_index_job_cancel() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT FROM public.index_generation g
      JOIN public.quota_reservation r ON r.id = ANY (g."quotaReservationIds")
      WHERE g."jobId" = NEW.id AND r.outcome = 'RESERVED' AND r."releasedAt" IS NULL) THEN
    RAISE EXCEPTION 'Index job holds unreleased reservations' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER index_job_cancel_guard BEFORE UPDATE OF state ON public.durable_job
  FOR EACH ROW WHEN (NEW.state = 'CANCELLED' AND OLD.state IS DISTINCT FROM 'CANCELLED')
  EXECUTE FUNCTION public.kb_guard_index_job_cancel();

-- Folded from auth-authority.sql; future changes belong in a new migration.
-- Per-user authority version. The session cookie cache is bound to it
-- (packages/auth/src/session-authority.ts): a cached user snapshot is only
-- reused while its "authorityVersion" equals the live row's. The trigger is
-- the sole writer, so no adapter, Prisma or raw-SQL writer can forget to
-- invalidate cached sessions when an authority-relevant column changes.
CREATE OR REPLACE FUNCTION public.kb_user_authority_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.role, NEW.email, NEW."emailVerified", NEW.banned, NEW."banReason", NEW."banExpires",
      NEW."twoFactorEnabled", NEW."twoFactorGraceStartedAt")
     IS DISTINCT FROM
     (OLD.role, OLD.email, OLD."emailVerified", OLD.banned, OLD."banReason", OLD."banExpires",
      OLD."twoFactorEnabled", OLD."twoFactorGraceStartedAt")
     OR NEW."authorityVersion" = OLD."authorityVersion" + 1 THEN
    -- A relevant change, or an explicit bump (credential changes below).
    NEW."authorityVersion" := OLD."authorityVersion" + 1;
  ELSE
    -- Never set, lowered or reused by a caller.
    NEW."authorityVersion" := OLD."authorityVersion";
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER user_authority_version BEFORE UPDATE ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.kb_user_authority_version();

-- Credential changes (password set or reset, linked or unlinked account)
-- bump the owner's authority version too.
CREATE OR REPLACE FUNCTION public.kb_account_authority_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.password IS NOT DISTINCT FROM OLD.password
     AND NEW."userId" = OLD."userId" THEN
    RETURN NULL;
  END IF;
  UPDATE public."user" SET "authorityVersion" = "authorityVersion" + 1
   WHERE id IN (
     SELECT "userId" FROM (VALUES (CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."userId" END),
                                  (CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."userId" END)) AS v("userId")
      WHERE "userId" IS NOT NULL);
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER account_authority_version AFTER INSERT OR UPDATE OR DELETE ON public.account
  FOR EACH ROW EXECUTE FUNCTION public.kb_account_authority_version();

-- Folded from kb-cache-constraints.sql; future changes belong in a new migration.
-- Byte-accounting bounds. Transitions additionally serialize on asset_cache_state.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='public.asset_cache_state'::regclass AND conname='asset_cache_state_bounds') THEN
    ALTER TABLE public.asset_cache_state ADD CONSTRAINT asset_cache_state_bounds CHECK (
      "effectiveLimit" >= 26214400 AND "chargedBytes" >= 0 AND "chargedBytes" <= "effectiveLimit" AND "fetchSequence" >= 0);
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='public.asset_cache_entry'::regclass AND conname='asset_cache_entry_bounds') THEN
    ALTER TABLE public.asset_cache_entry ADD CONSTRAINT asset_cache_entry_bounds CHECK (
      size > 0 AND hash ~ '^sha256:[0-9a-f]{64}$' AND "lastFetchSequence" >= 0
      AND "tempName" = 'cache-' || incarnation::text
      AND ((device IS NULL AND inode IS NULL AND "tempDirectory" IS NULL)
        OR (device IS NOT NULL AND inode IS NOT NULL AND "tempDirectory" IS NOT NULL))
      AND (NOT "finalAlias" OR "finalDirectory" IS NOT NULL)
      AND (state <> 'READY' OR (inode IS NOT NULL AND "mtimeNs" IS NOT NULL AND "ctimeNs" IS NOT NULL AND "finalAlias"))
      AND (state <> 'EVICTING' OR "cleanupAttempt" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='public.asset_retained_object'::regclass AND conname='asset_retained_object_bounds') THEN
    ALTER TABLE public.asset_retained_object ADD CONSTRAINT asset_retained_object_bounds CHECK (
      size > 0 AND size <= 26214400 AND hash ~ '^sha256:[0-9a-f]{64}$');
  END IF;
END $$;

-- Each victim probe fixes one state, preserving the complete stable LRU order.
CREATE INDEX IF NOT EXISTS asset_cache_entry_victim_idx
  ON public.asset_cache_entry ("cacheId", state, "lastFetchSequence", hash COLLATE "C")
  WHERE "cleanupOwner" IS NULL;

-- Recovery spans two states; a state-first index cannot supply its hash order.
CREATE INDEX IF NOT EXISTS asset_cache_entry_repair_idx
  ON public.asset_cache_entry ("cacheId", hash)
  WHERE state IN ('INVALID', 'EVICTING');

-- knowledge-base:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $knowledge_base$ DECLARE history text := current_setting('knowledge_base.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'knowledge-base:committed', history::oid::regclass); END IF; END $knowledge_base$;
COMMIT;
