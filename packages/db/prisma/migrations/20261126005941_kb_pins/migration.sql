-- knowledge-base:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- knowledge-base:history-capture (records the history table for the commit marker; keep it here)
DO $knowledge_base$ BEGIN PERFORM set_config('knowledge_base.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $knowledge_base$;

-- CreateTable
CREATE TABLE "kb_pin" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "kbId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "kb_pin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_pin_userId_position_idx" ON "kb_pin"("userId", "position");

-- CreateIndex
CREATE INDEX "kb_pin_kbId_idx" ON "kb_pin"("kbId");

-- CreateIndex
CREATE UNIQUE INDEX "kb_pin_user_kb_unique" ON "kb_pin"("userId", "kbId");

-- AddForeignKey
ALTER TABLE "kb_pin" ADD CONSTRAINT "kb_pin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_pin" ADD CONSTRAINT "kb_pin_kbId_fkey" FOREIGN KEY ("kbId") REFERENCES "knowledge_base"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- knowledge-base:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $knowledge_base$ DECLARE history text := current_setting('knowledge_base.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'knowledge-base:committed', history::oid::regclass); END IF; END $knowledge_base$;
COMMIT;
