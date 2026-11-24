-- knowledge-base:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- knowledge-base:history-capture (records the history table for the commit marker; keep it here)
DO $knowledge_base$ BEGIN PERFORM set_config('knowledge_base.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $knowledge_base$;

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "ExportArtifactState" ADD VALUE 'PENDING';

ALTER TYPE "ExportArtifactState" ADD VALUE 'FAILED';

ALTER TYPE "ExportArtifactState" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "export_artifact" ADD COLUMN     "failureCode" TEXT;

ALTER TABLE "export_artifact" ADD COLUMN     "leaseOwner" TEXT;

ALTER TABLE "export_artifact" ADD COLUMN     "leaseUntil" TIMESTAMPTZ(3);

ALTER TABLE "export_artifact" ADD COLUMN     "progressBytes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "export_artifact" ADD COLUMN     "totalBytes" INTEGER;

-- CreateTable
CREATE TABLE "export_request_key" (
    "id" UUID NOT NULL,
    "actorKey" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "exportId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_request_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "export_request_key_exportId_idx" ON "export_request_key"("exportId");

-- CreateIndex
CREATE UNIQUE INDEX "export_request_key_actorKey_kbId_idempotencyKey_key" ON "export_request_key"("actorKey", "kbId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "export_artifact_actorKey_kbId_createdAt_idx" ON "export_artifact"("actorKey", "kbId", "createdAt");

-- AddForeignKey
ALTER TABLE "export_request_key" ADD CONSTRAINT "export_request_key_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "export_artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- knowledge-base:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $knowledge_base$ DECLARE history text := current_setting('knowledge_base.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'knowledge-base:committed', history::oid::regclass); END IF; END $knowledge_base$;
COMMIT;
