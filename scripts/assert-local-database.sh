#!/usr/bin/env bash
# Positive allowlist for commands that can mutate a Postgres database.
#
# Usage:  bash scripts/assert-local-database.sh <COMMAND_NAME> [--shadow]
#         bash scripts/assert-local-database.sh --self-test
#   COMMAND_NAME is one of
#     db:seed | db:studio | db:migrate:apply          (escape hatch allowed)
#     db:migrate | db:migrate:rebase | db:worktree    (use the shadow DB; no escape hatch)
#     db:reset:local                                  (drops this checkout's DB; no escape hatch)
#     db:seed:e2e                                     (known-credential demo seed; no escape hatch)
#   --shadow additionally validates the shadow URL derived from DATABASE_URL
#   (the same derivation as packages/db/prisma.config.ts: `<db>_shadow`).
#
# Allowed DATABASE_URL shape (all must match):
#   host     localhost | 127.0.0.1 | ::1
#   port     $EXPECTED_PORT (default 5432; empty in the URL → 5432)
#   database EXACTLY this checkout's name (scripts/db/lib/local-db-name.mjs):
#              main checkout   → knowledge_base (or $EXPECTED_DB)
#              linked worktree → knowledge_base_wt_<10 hex of sha256(git dir)>
#   shadow   EXACTLY <that name>_shadow, validated independently
#
# Explicitly rejected: postgres, db, database, host.docker.internal, 10.*,
# 172.16–31.*, 192.168.* — the hostnames and ranges a VPC / Dokploy /
# compose-service Postgres actually uses.
#
# Renamed your local database or moved it off 5432? Export EXPECTED_DB /
# EXPECTED_PORT (EXPECTED_DB applies to the main checkout only; worktree names
# are always derived). The host allowlist is what keeps this local.
#
# Escape hatch — only for db:seed, db:studio, db:migrate:apply, and only for a
# database you are willing to destroy (distinct per command):
#   ALLOW_NONLOCAL_DB_SEED=I_UNDERSTAND_THIS_CAN_DESTROY_DATA
#   ALLOW_NONLOCAL_DB_STUDIO=I_UNDERSTAND_THIS_CAN_DESTROY_DATA
#   ALLOW_NONLOCAL_DB_MIGRATE_APPLY=I_UNDERSTAND_THIS_CAN_DESTROY_DATA
# Generic override (same magic string): ASSERT_LOCAL_DB_ESCAPE=...
# db:reset:local and every shadow-DB command (or --shadow) REFUSE every
# override: they drop/recreate databases, so they only ever touch the exact
# per-checkout names on localhost.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="${1:-}"
WANT_SHADOW="${2:-}"
ESCAPE_VALUE="I_UNDERSTAND_THIS_CAN_DESTROY_DATA"
ALLOWED_HOSTS="localhost 127.0.0.1 ::1"
EXPECTED_PORT="${EXPECTED_PORT:-5432}"

# Read DATABASE_URL out of a .env file EXACTLY the way Prisma will read it.
#
# packages/db/prisma.config.ts loads the repo-root .env with dotenv, and dotenv
# is last-wins for a duplicated key. A guard that stopped at the FIRST
# `DATABASE_URL=` line would clear itself on a .env whose first entry is the
# local URL and whose last entry is a production one — and then Prisma would
# connect to production. Parsing with dotenv itself is the only way the two
# cannot drift; it also gives us dotenv's `export ` prefix and quoting rules
# for free.
read_dotenv_database_url() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const { createRequire } = require("node:module");
    const [root, envFile] = process.argv.slice(1);
    let dotenv;
    try {
      dotenv = createRequire(path.join(root, "package.json"))("dotenv");
    } catch {
      process.stderr.write(
        "FATAL: cannot load dotenv from the repo root. Run `pnpm install` first.\n",
      );
      process.exit(2);
    }
    const parsed = dotenv.parse(fs.readFileSync(envFile));
    process.stdout.write(parsed.DATABASE_URL ?? "");
  ' "$1" "$2"
}

# host \n port \n database \n shadow-database   (credentials never printed)
parse_url() {
  DATABASE_URL="$1" node -e '
    try {
      const url = new URL(process.env.DATABASE_URL);
      // The pg driver (and libpq) let query parameters override the host,
      // port, and database in the URL authority/path: `?host=prod.example`
      // would pass the hostname check below while connecting elsewhere.
      // Accept only parameters that cannot change where the connection goes.
      const SAFE_PARAMS = new Set([
        "schema", "sslmode", "sslaccept", "connection_limit", "pool_timeout",
        "connect_timeout", "socket_timeout", "statement_cache_size",
        "application_name", "pgbouncer",
      ]);
      for (const key of url.searchParams.keys()) {
        if (!SAFE_PARAMS.has(key.toLowerCase())) {
          process.stderr.write(
            `FATAL: DATABASE_URL query parameter "${key}" is not allowed here: it can redirect the connection. Remove it.\n`,
          );
          process.exit(3);
        }
      }
      let host = url.hostname;
      if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
      const port = url.port || "5432";
      const db = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0]);
      // Same derivation as packages/db/prisma.config.ts.
      const shadow = new URL(url.toString());
      shadow.pathname = "/" + encodeURIComponent(db + "_shadow");
      const shadowDb = decodeURIComponent(shadow.pathname.replace(/^\/+/, ""));
      process.stdout.write([host, port, db, shadowDb].join("\n"));
    } catch {
      process.stderr.write("FATAL: DATABASE_URL is not a valid URL.\n");
      process.exit(2);
    }
  '
}

expected_main() {
  node "$ROOT/scripts/db/lib/local-db-name.mjs" main --cwd "$ROOT"
}

# -- self-test ---------------------------------------------------------------
# Wired into `pnpm verify` through the `policy:local-db-guard` script, so a
# regression in the parsing or the allowlist fails CI. Run it directly while
# working on either:
#   bash scripts/assert-local-database.sh --self-test
if [[ "$CMD" == "--self-test" ]]; then
  echo "== assert-local-database self-test =="
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  failed=0

  # dotenv is last-wins: a production URL appended below a local one must be the
  # value this guard judges, because it is the value Prisma will connect to.
  printf '%s\n' \
    'DATABASE_URL=postgresql://localhost:5432/knowledge_base' \
    'DATABASE_URL="postgresql://db.example.com:5432/prod"' \
    >"$tmp/dup.env"
  if [[ "$(read_dotenv_database_url "$ROOT" "$tmp/dup.env")" != "postgresql://db.example.com:5432/prod" ]]; then
    echo "self-test FAILED: duplicate DATABASE_URL did not resolve last-wins" >&2
    failed=1
  fi

  # dotenv accepts an `export ` prefix; so must this.
  printf '%s\n' 'export DATABASE_URL=postgresql://db.example.com:5432/prod' >"$tmp/export.env"
  if [[ "$(read_dotenv_database_url "$ROOT" "$tmp/export.env")" != "postgresql://db.example.com:5432/prod" ]]; then
    echo "self-test FAILED: 'export DATABASE_URL=' line was not parsed" >&2
    failed=1
  fi

  # Worktree identity is covered by injected-Git unit tests in local-db-name.test.mjs.

  self_test_guard() {
    # $1 = command, $2 = DATABASE_URL, $3 = expected exit status, $4 = label, rest = extra env
    local cmd="$1" url="$2" want="$3" label="$4"
    shift 4
    local got=0
    local -a cmd_args=("$cmd")
    if [[ "$cmd" == *"+shadow" ]]; then cmd_args=("${cmd%+shadow}" --shadow); fi
    env -u ASSERT_LOCAL_DB_ESCAPE -u ALLOW_NONLOCAL_DB_SEED -u ALLOW_NONLOCAL_DB_RESET_LOCAL \
      -u ALLOW_NONLOCAL_DB_MIGRATE -u EXPECTED_DB -u EXPECTED_PORT \
      DATABASE_URL="$url" "$@" bash "$ROOT/scripts/assert-local-database.sh" "${cmd_args[@]}" >/dev/null 2>&1 || got=$?
    if [[ "$got" != "$want" ]]; then
      echo "self-test FAILED: $label (expected exit $want, got $got)" >&2
      failed=1
    fi
  }

  here="$(env -u EXPECTED_DB node "$ROOT/scripts/db/lib/local-db-name.mjs" main --cwd "$ROOT")"
  esc="$ESCAPE_VALUE"
  self_test_guard db:seed "postgresql://localhost:5432/$here" 0 "this checkout's exact name accepted"
  self_test_guard db:migrate+shadow "postgresql://127.0.0.1:5432/$here" 0 "shadow derivation accepted"
  self_test_guard db:seed "postgresql://db.example.com:5432/$here" 1 "remote host rejected"
  self_test_guard db:seed "postgresql://host.docker.internal:5432/$here" 1 "host.docker.internal rejected"
  self_test_guard db:seed "postgresql://localhost:5432/prod" 1 "unexpected database name rejected"
  self_test_guard db:seed "postgresql://localhost:5432/${here}_shadow" 1 "shadow name rejected as the main DB"
  self_test_guard db:seed "postgresql://localhost:5432/knowledge_base_wt_0000000000" 1 "another worktree's name rejected"
  self_test_guard db:seed "postgresql://db.example.com:5432/prod" 0 "escape hatch works for db:seed" ALLOW_NONLOCAL_DB_SEED="$esc"
  self_test_guard db:reset:local "postgresql://db.example.com:5432/prod" 1 "db:reset:local refuses the per-command escape" ALLOW_NONLOCAL_DB_RESET_LOCAL="$esc"
  self_test_guard db:reset:local "postgresql://db.example.com:5432/prod" 1 "db:reset:local refuses the generic escape" ASSERT_LOCAL_DB_ESCAPE="$esc"
  self_test_guard db:migrate+shadow "postgresql://db.example.com:5432/prod" 1 "shadow commands refuse the escape" ASSERT_LOCAL_DB_ESCAPE="$esc"
  self_test_guard db:seed:e2e "postgresql://localhost:5432/$here" 0 "db:seed:e2e accepts this checkout's DB"
  self_test_guard db:seed:e2e "postgresql://db.example.com:5432/$here" 1 "db:seed:e2e rejects a remote host"
  self_test_guard db:seed:e2e "postgresql://db.example.com:5432/prod" 1 "db:seed:e2e refuses the generic escape" ASSERT_LOCAL_DB_ESCAPE="$esc"
  self_test_guard db:push "postgresql://localhost:5432/$here" 1 "removed command db:push rejected"
  self_test_guard db:reset:local "postgresql://localhost:5432/$here?host=db.example.com" 1 "?host= override rejected"
  self_test_guard db:seed "postgresql://localhost:5432/$here?hostaddr=10.0.0.5" 1 "?hostaddr= override rejected"
  self_test_guard db:seed "postgresql://localhost:5432/$here?port=6543" 1 "?port= override rejected"
  self_test_guard db:seed "postgresql://localhost:5432/$here?dbname=prod" 1 "?dbname= override rejected"
  self_test_guard db:seed "postgresql://localhost:5432/$here?options=-c%20search_path%3Dx" 1 "unknown parameter rejected"
  self_test_guard db:seed "postgresql://localhost:5432/$here?schema=public&sslmode=disable" 0 "routing-neutral parameters accepted"
  if [[ "$here" == "knowledge_base" ]]; then
    self_test_guard db:seed "postgresql://localhost:5432/myapp" 0 "EXPECTED_DB override accepted" EXPECTED_DB=myapp
    self_test_guard db:seed "postgresql://db.example.com:5432/myapp" 1 "EXPECTED_DB does not widen the host allowlist" EXPECTED_DB=myapp
  fi

  if [[ "$failed" -ne 0 ]]; then
    echo "assert-local-database self-test FAILED." >&2
    exit 1
  fi
  echo "assert-local-database self-test passed."
  exit 0
fi

ESCAPABLE=0
case "$CMD" in
  db:seed | db:studio | db:migrate:apply) ESCAPABLE=1 ;;
  db:migrate | db:migrate:rebase | db:worktree | db:reset:local | db:seed:e2e) ESCAPABLE=0 ;;
  *)
    echo "FATAL: usage: $0 <COMMAND_NAME> [--shadow]" >&2
    echo "       COMMAND_NAME is db:seed | db:studio | db:migrate | db:migrate:apply |" >&2
    echo "       db:migrate:rebase | db:worktree | db:reset:local | db:seed:e2e" >&2
    exit 1
    ;;
esac
case "$WANT_SHADOW" in
  "") ;;
  --shadow) ESCAPABLE=0 ;;
  *) echo "FATAL: unexpected argument $WANT_SHADOW" >&2; exit 1 ;;
esac

CMD_KEY="$(printf '%s' "$CMD" | sed 's/[:.-]/_/g' | tr '[:lower:]' '[:upper:]')"
ESCAPE_VAR="ALLOW_NONLOCAL_${CMD_KEY}"

# Do not print DATABASE_URL. Load it from the repo-root .env only when unset
# so the wrappers keep working for developers who never export it.
if [[ -z "${DATABASE_URL:-}" && -f "$ROOT/.env" ]]; then
  DATABASE_URL="$(read_dotenv_database_url "$ROOT" "$ROOT/.env")" || exit 1
  export DATABASE_URL
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "FATAL: DATABASE_URL is not set (and was not found in the repo-root .env). Run \`pnpm db:worktree\`." >&2
  exit 1
fi

parsed="$(parse_url "$DATABASE_URL")" || {
  echo "FATAL: could not parse DATABASE_URL." >&2
  exit 1
}

HOST="$(printf '%s' "$parsed" | sed -n '1p')"
PORT="$(printf '%s' "$parsed" | sed -n '2p')"
DB="$(printf '%s' "$parsed" | sed -n '3p')"
SHADOW_DB="$(printf '%s' "$parsed" | sed -n '4p')"
EXPECTED_MAIN="$(expected_main)" || {
  echo "FATAL: could not compute this checkout's local database name." >&2
  exit 1
}
EXPECTED_SHADOW="${EXPECTED_MAIN}_shadow"

allowed=0
for candidate in $ALLOWED_HOSTS; do
  if [[ "$HOST" == "$candidate" ]]; then
    allowed=1
    break
  fi
done

main_ok=0
if [[ "$allowed" -eq 1 && "$PORT" == "$EXPECTED_PORT" && "$DB" == "$EXPECTED_MAIN" ]]; then
  main_ok=1
fi
shadow_ok=1
if [[ "$WANT_SHADOW" == "--shadow" || "$ESCAPABLE" -eq 0 ]]; then
  # Validated on its own, not inferred from the main check.
  if [[ "$allowed" -ne 1 || "$PORT" != "$EXPECTED_PORT" || "$SHADOW_DB" != "$EXPECTED_SHADOW" ]]; then
    shadow_ok=0
  fi
fi

if [[ "$main_ok" -eq 1 && "$shadow_ok" -eq 1 ]]; then
  exit 0
fi

if [[ "$ESCAPABLE" -eq 1 ]]; then
  eval "escape_val=\${${ESCAPE_VAR}:-}"
  if [[ "$escape_val" == "$ESCAPE_VALUE" || "${ASSERT_LOCAL_DB_ESCAPE:-}" == "$ESCAPE_VALUE" ]]; then
    echo "WARNING: $CMD proceeding against host=$HOST port=$PORT db=$DB because an escape hatch is set." >&2
    exit 0
  fi
fi

cat >&2 <<EOF
FATAL: Refusing $CMD — DATABASE_URL is not this checkout's local database.

Parsed (credentials omitted): host=$HOST port=$PORT database=$DB (shadow $SHADOW_DB)
Expected: host in {localhost, 127.0.0.1, ::1}, port $EXPECTED_PORT, database $EXPECTED_MAIN (shadow $EXPECTED_SHADOW)

What to do:

  * Run \`pnpm db:worktree\`: it creates this checkout's databases and points
    .env DATABASE_URL at them. Each git worktree gets its own database so
    parallel agents never overwrite each other's schema.
  * Main checkout with a renamed local database? export EXPECTED_DB=$DB.
    Postgres on a different PORT? export EXPECTED_PORT=$PORT.
  * If DATABASE_URL points at a shared, staging, or production database, that
    is what this guard is for. Production schema changes ship as committed
    migrations applied by the deploy (docs/schema-migrations.md).
EOF
if [[ "$ESCAPABLE" -eq 1 ]]; then
  cat >&2 <<EOF

Last resort — only if that database is genuinely disposable and you accept
losing everything in it:

  $ESCAPE_VAR=$ESCAPE_VALUE pnpm $CMD
EOF
else
  echo "" >&2
  echo "$CMD has no override: it only ever touches this checkout's exact local databases." >&2
fi
exit 1
