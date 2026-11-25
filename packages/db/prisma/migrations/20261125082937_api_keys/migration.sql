-- knowledge-base:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- knowledge-base:history-capture (records the history table for the commit marker; keep it here)
DO $knowledge_base$ BEGIN PERFORM set_config('knowledge_base.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $knowledge_base$;

-- CreateEnum
CREATE TYPE "ApiKeyReach" AS ENUM ('ALL', 'SELECTED', 'CREATED');

-- AlterEnum
ALTER TYPE "McpGrantKind" ADD VALUE 'API_KEY';

-- AlterTable
ALTER TABLE "mcp_grant" ADD COLUMN     "allKbsBits" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "mcp_personal_token" ADD COLUMN     "idempotencyKey" TEXT;

ALTER TABLE "mcp_personal_token" ADD COLUMN     "parentApiKeyId" TEXT;

ALTER TABLE "mcp_personal_token" ADD COLUMN     "requestHash" TEXT;

-- CreateTable
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userIdSnapshot" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "lookupPrefix" TEXT NOT NULL,
    "secretDigest" TEXT NOT NULL,
    "grantId" UUID NOT NULL,
    "reach" "ApiKeyReach" NOT NULL,
    "bits" TEXT[],
    "allowDelete" BOOLEAN NOT NULL DEFAULT false,
    "allowMintChildren" BOOLEAN NOT NULL DEFAULT false,
    "childToolGroups" TEXT[],
    "childAuthoringMode" "McpAuthoringMode",
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_key_grantId_key" ON "api_key"("grantId");

-- CreateIndex
CREATE INDEX "api_key_userId_revokedAt_expiresAt_idx" ON "api_key"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_lookup_prefix" ON "api_key"("lookupPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_secret_digest" ON "api_key"("secretDigest");

-- CreateIndex
CREATE INDEX "mcp_personal_token_parentApiKeyId_revokedAt_expiresAt_idx" ON "mcp_personal_token"("parentApiKeyId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_personal_token_parent_idempotency" ON "mcp_personal_token"("parentApiKeyId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "mcp_personal_token_parentApiKeyId_id_idx" ON "mcp_personal_token"("parentApiKeyId", "id");

-- AddForeignKey
ALTER TABLE "mcp_personal_token" ADD CONSTRAINT "mcp_personal_token_parentApiKeyId_fkey" FOREIGN KEY ("parentApiKeyId") REFERENCES "api_key"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "mcp_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only an API key's grant reaches every KB its owner can access.
ALTER TABLE "mcp_grant" ADD CONSTRAINT "mcp_grant_all_kbs_bits_api_key_only" CHECK (coalesce(cardinality("allKbsBits"), 0) = 0 OR "kind"::text = 'API_KEY');

-- A child-mint idempotency key exists only on a child token.
ALTER TABLE "mcp_personal_token" ADD CONSTRAINT "mcp_personal_token_idempotency_child_only" CHECK ("idempotencyKey" IS NULL OR "parentApiKeyId" IS NOT NULL);

-- knowledge-base:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $knowledge_base$ DECLARE history text := current_setting('knowledge_base.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'knowledge-base:committed', history::oid::regclass); END IF; END $knowledge_base$;
COMMIT;
