#!/usr/bin/env bash
# Scheduled/operator backup: quiesced, encrypted PostgreSQL + Git + CAS bundle.
# Every backup is a full encrypted bundle. Required hooks fail if disabled.
# Connection credentials are passed via PG* variables, never argv.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/backup-env.sh
source "$ROOT/scripts/lib/backup-env.sh"
source "$ROOT/scripts/lib/owned-child.sh"

label=manual
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = --label ] || { echo 'usage: backup.sh [--label manual|pre-migrate|pre-drop|daily]' >&2; exit 2; }
  label="$2"
fi
case "$label" in manual|pre-migrate|pre-drop|daily) ;; *) echo 'Invalid backup label.' >&2; exit 2 ;; esac

if ! backup_enabled; then
  if [ "${BACKUP_REQUIRED:-0}" = "1" ]; then
    echo "FATAL: required full-bundle backup is disabled by BACKUP_ENABLED=false." >&2
    exit 1
  fi
  echo "WARNING: BACKUP_ENABLED=false — skipping backup." >&2
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL is not set." >&2
  echo "       Export it before running: DATABASE_URL=postgresql://... $0" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [ ! -w "$BACKUP_DIR" ]; then
  echo "FATAL: backup directory '$BACKUP_DIR' is not writable by $(id -un)." >&2
  echo "       Set BACKUP_DIR to a writable path (containers should pass a mktemp dir)." >&2
  exit 1
fi

KB_BACKUP_RUN_ID="${KB_BACKUP_RUN_ID:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')}"
export KB_BACKUP_RUN_ID
OUTFILE="$BACKUP_DIR/backup-$KB_BACKUP_RUN_ID.age"
# Each direct writer drains before its parent may clean its control channel.
backup_writer_pid=""
backup_writer_control=""
backup_writer_starting=0
backup_writer_signal=""
backup_writer_pending_signal=""
drain_backup_writer() {
  local signal="$1"
  [ -z "$backup_writer_signal" ] || return
  backup_writer_signal="$signal"
  trap '' HUP INT TERM
  if [ -n "$backup_writer_pid" ]; then
    owned_child_cancel 6
    owned_child_wait "$backup_writer_control" 6 "$backup_writer_pid" || true
    backup_writer_pid=""
  fi
}
request_backup_writer_shutdown() {
  local signal="$1"
  if [ "$backup_writer_starting" = 1 ]; then
    [ -n "$backup_writer_pending_signal" ] || backup_writer_pending_signal="$signal"
    return
  fi
  drain_backup_writer "$signal"
}
run_backup_writer() {
  # Enter the start state before looking at shutdown.  A caught signal before
  # this helper's admission is rejected below without a fork; one that arrives
  # while the start is in progress is retained until `$!` is recorded, then
  # drained by this same owner.  The state therefore covers the whole handoff,
  # rather than treating a pre-start check as atomic.
  backup_writer_starting=1
  if [ -n "$backup_writer_signal" ]; then
    backup_writer_starting=0
    case "$backup_writer_signal" in
      HUP) return 129 ;;
      INT) return 130 ;;
      TERM) return 143 ;;
    esac
  fi
  backup_writer_control="$OUTFILE.control"
  owned_child_open "$backup_writer_control" 6 || return $?
  local owner_kind=native
  if [ "${2:-}" = "$ROOT/scripts/lib/kb-backup.mjs" ]; then owner_kind=cooperative; fi
  owned_child_run "$backup_writer_control" 6 "$owner_kind" 0 "$@" &
  backup_writer_pid=$!
  backup_writer_starting=0
  if [ -n "$backup_writer_pending_signal" ]; then
    drain_backup_writer "$backup_writer_pending_signal"
  fi
  if [ -n "$backup_writer_signal" ]; then
    case "$backup_writer_signal" in
      HUP) return 129 ;;
      INT) return 130 ;;
      TERM) return 143 ;;
    esac
  fi
  local status=0
  if owned_child_wait "$backup_writer_control" 6 "$backup_writer_pid"; then
    status=0
  else
    status=$?
  fi
  case "$backup_writer_signal" in
    HUP) status=129 ;;
    INT) status=130 ;;
    TERM) status=143 ;;
  esac
  backup_writer_pid=""
  if [ ! -f "$backup_writer_control.drained" ]; then exit 125; fi
  local drained_control="$backup_writer_control"
  backup_writer_control=""
  owned_child_clear "$drained_control"
  return "$status"
}
cleanup_backup_writer() {
  trap '' HUP INT TERM
  if [ -n "$backup_writer_pid" ]; then
    owned_child_cancel 6
    owned_child_wait "$backup_writer_control" 6 "$backup_writer_pid" || true
    backup_writer_pid=""
  fi
  if ! owned_child_clear "$backup_writer_control"; then exit 125; fi
}
trap cleanup_backup_writer EXIT
trap 'request_backup_writer_shutdown HUP' HUP
trap 'request_backup_writer_shutdown INT' INT
trap 'request_backup_writer_shutdown TERM' TERM

# The helpers below also check this boundary, but checking here prevents a
# caught signal before the first stage from doing further backup work first.
if [ -n "$backup_writer_signal" ]; then
  case "$backup_writer_signal" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
fi

echo "Writing backup to $OUTFILE"

# Parse the connection URL into PG* env vars so the password never appears in
# argv. node emits each field NUL-terminated; `read -d ''` assigns the raw bytes
# literally, so passwords containing $, backticks, backslashes, or spaces are
# handled correctly (an `eval` of quoted strings is not safe for those).
{
  IFS= read -r -d '' PGHOST
  IFS= read -r -d '' PGPORT
  IFS= read -r -d '' PGDATABASE
  IFS= read -r -d '' PGUSER
  IFS= read -r -d '' PGPASSWORD
  IFS= read -r -d '' DB_SSLMODE
} < <(
  node -e '
const url = new URL(process.env.DATABASE_URL);
const fields = [
  url.hostname,
  url.port || "5432",
  url.pathname.replace(/^\/+/, "").split("?")[0],
  decodeURIComponent(url.username),
  decodeURIComponent(url.password),
  url.searchParams.get("sslmode") || "",
];
process.stdout.write(fields.map((value) => `${value}\0`).join(""));
'
)
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
[ -n "$DB_SSLMODE" ] && export PGSSLMODE="$DB_SSLMODE"

# pg_dump can dump a server OLDER than itself, never a newer one. If the image's
# postgresql-client falls behind the managed Postgres major, every backup fails
# with a message most people cannot act on — so check it here and say what to fix.
pg_client_supports_server() {
  [ "$1" -ge "$2" ]
}

if ! SERVER_VERSION_NUM="$(PGCONNECT_TIMEOUT=10 PGOPTIONS='-c statement_timeout=60s -c lock_timeout=5s' node "$ROOT/scripts/lib/bounded-child.mjs" 75000 psql -X -Atqc 'SHOW server_version_num' 2>&1)"; then
  echo "FATAL: could not read the server version from $PGHOST:$PGPORT/$PGDATABASE." >&2
  echo "       psql said: $SERVER_VERSION_NUM" >&2
  echo "       pg_dump would fail on the same connection — fix DATABASE_URL or network access." >&2
  exit 1
fi
if [ -n "$backup_writer_signal" ]; then
  case "$backup_writer_signal" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
fi
case "$SERVER_VERSION_NUM" in
  '' | *[!0-9]*)
    echo "FATAL: unexpected server_version_num from Postgres: '$SERVER_VERSION_NUM'." >&2
    exit 1
    ;;
esac
SERVER_MAJOR=$((SERVER_VERSION_NUM / 10000))
CLIENT_MAJOR="$(pg_dump --version | awk '{print $3}' | sed 's/[^0-9].*//')"
if [ -z "$CLIENT_MAJOR" ]; then
  echo "FATAL: could not parse the pg_dump version ($(pg_dump --version 2>&1))." >&2
  exit 1
fi
if ! pg_client_supports_server "$CLIENT_MAJOR" "$SERVER_MAJOR"; then
  echo "FATAL: pg_dump is version $CLIENT_MAJOR but the server is version $SERVER_MAJOR." >&2
  echo "       A newer client can dump an older server; the reverse is not supported." >&2
  echo "       Raise ARG PG_MAJOR in Dockerfile and Dockerfile.worker" >&2
  echo "       to $SERVER_MAJOR (and your Postgres server's major), rebuild the images," >&2
  echo "       then re-run. \`pnpm docker:check-copy\` verifies the files agree." >&2
  exit 1
fi
echo "INFO: pg_dump client major $CLIENT_MAJOR, server major $SERVER_MAJOR."

# Backup-bucket configuration is enforced HERE, at the moment a dump would be
# written — not in packages/env, which the web server and the worker boot on.
# A backup-only mistake must never crash-loop the app; it must stop the backup
# and say exactly what to fix. The same writer rules are re-checked in
# scripts/lib/backup-s3-env.mjs (the upload/download helpers). Shared env boot
# logs only bucket/region warnings because the normal worker does not hold this
# dump-writer credential.
# Validate both unshadowed asset IDs even for full bundles.
node --input-type=module -e 'const {validateAssetDumpIdentity}=await import(process.argv[1]);validateAssetDumpIdentity();' "$ROOT/scripts/lib/backup-s3-env.mjs" || exit 1

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if [ -z "${BACKUP_S3_ACCESS_KEY_ID:-}" ] || [ -z "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]; then
    echo "FATAL: BACKUP_S3_BUCKET is set but BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY are missing." >&2
    echo "       Use a dedicated dump-writer key (GetObject/PutObject/AbortMultipartUpload only)." >&2
    echo "       Never S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY." >&2
    exit 1
  fi
  if [ -n "${S3_ACCESS_KEY_ID:-}" ] && [ "${BACKUP_S3_ACCESS_KEY_ID}" = "${S3_ACCESS_KEY_ID}" ]; then
    echo "FATAL: BACKUP_S3_ACCESS_KEY_ID matches S3_ACCESS_KEY_ID. Backups need a distinct key so a" >&2
    echo "       stolen app-upload credential cannot read database dumps." >&2
    exit 1
  fi
  # "auto" is a Cloudflare R2 convention. With no endpoint the AWS SDK would
  # address the bucket at the nonexistent host s3.auto.amazonaws.com and every
  # upload would fail with a DNS error that names nothing useful.
  if [ -z "${BACKUP_S3_ENDPOINT:-}" ] && [ "${BACKUP_S3_REGION:-auto}" = "auto" ]; then
    echo "FATAL: BACKUP_S3_REGION must be a real AWS region when BACKUP_S3_ENDPOINT is unset." >&2
    echo "       The default \"auto\" is an R2 convention — set BACKUP_S3_ENDPOINT for R2/MinIO/B2/Spaces." >&2
    exit 1
  fi
fi

# The coordinator owns all database, Git, CAS, encryption and upload children.
run_backup_writer node "$ROOT/scripts/lib/kb-backup.mjs" coordinate "$label"
