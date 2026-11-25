-- knowledge-base:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- knowledge-base:history-capture (records the history table for the commit marker; keep it here)
DO $knowledge_base$ BEGIN PERFORM set_config('knowledge_base.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $knowledge_base$;

-- AlterTable
ALTER TABLE "api_key" ADD COLUMN     "childAllowCreate" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "api_key" ADD COLUMN     "childrenEndWithKey" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "api_key" ALTER COLUMN "expiresAt" DROP NOT NULL;

-- Keys minted before this migration were minted with children that end with the key:
-- keep that, never silently let their children outlive them.
UPDATE "api_key" SET "childrenEndWithKey" = true;

-- knowledge-base:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $knowledge_base$ DECLARE history text := current_setting('knowledge_base.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'knowledge-base:committed', history::oid::regclass); END IF; END $knowledge_base$;
COMMIT;
