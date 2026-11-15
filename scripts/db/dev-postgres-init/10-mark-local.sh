#!/usr/bin/env bash
# Runs once, inside the dev Postgres container, when docker-compose.dev.yml
# initializes a fresh volume (/docker-entrypoint-initdb.d). It marks the
# database the image just created (POSTGRES_DB, `knowledge_base`) as a disposable
# local database, the mark `pnpm db:reset:local` requires
# (scripts/db/lib/scratch-db.mjs LOCAL_DB_MARK; keep the two strings identical).
# Only databases created here or by `pnpm db:worktree` carry it, so a
# localhost URL that tunnels to another server never passes the reset guard.
#
# No `set -euo pipefail`: the Postgres entrypoint SOURCES an init script that is
# not executable (a checkout can lose the +x bit), and `set -u` would then leak
# into its own shell. psql's ON_ERROR_STOP and the script's exit status (psql
# is the last command) already fail the init.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" <<'SQL'
COMMENT ON DATABASE :"db" IS 'knowledge-base:disposable-local-database v1';
SQL
