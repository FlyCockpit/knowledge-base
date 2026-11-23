-- knowledge-base:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- knowledge-base:history-capture (records the history table for the commit marker; keep it here)
DO $knowledge_base$ BEGIN PERFORM set_config('knowledge_base.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $knowledge_base$;

-- CreateEnum
CREATE TYPE "McpAuthoringMode" AS ENUM ('DREAM', 'EDIT', 'BOTH');

-- AlterTable
ALTER TABLE "mcp_grant" ADD COLUMN     "authoringMode" "McpAuthoringMode";

-- knowledge-base:reviewed existing write grants keep exactly today's authority (both dream and edit); read grants stay NULL
UPDATE "mcp_grant" SET "authoringMode" = 'BOTH' WHERE 'mcp:write' = ANY("scopes");

-- knowledge-base:reviewed a write grant always carries a write mode and a read-only grant never does
ALTER TABLE "mcp_grant" ADD CONSTRAINT "mcp_grant_authoring_mode_matches_write" CHECK (("authoringMode" IS NULL) = NOT (coalesce('mcp:write' = ANY("scopes"), false)));

-- knowledge-base:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $knowledge_base$ DECLARE history text := current_setting('knowledge_base.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'knowledge-base:committed', history::oid::regclass); END IF; END $knowledge_base$;
COMMIT;
