#!/usr/bin/env bash
# Enabled migration/drop hooks produce KB's encrypted PG+Git+CAS bundle.
# --check-destination (the runner, brand-new database only): no bundle, but
# BACKUP_ENABLED=true refuses without a usable destination.
# --startup-notice (the entrypoint, once per migrating start, the `migrate`
# job included, and for a waiting server): never a bundle, no database access.
# BACKUP_ENABLED unset/false: print the backups-off notice and exit 0.
# BACKUP_ENABLED=true: the --check-destination check (recipient, a mounted
# BACKUP_DIR or BACKUP_S3_BUCKET, BACKUP_S3_* settings), so a deploy that asked
# for backups fails at startup, even with nothing pending.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
label=manual
check=false
notice=false
while [ $# -gt 0 ]; do
  case "$1" in
    --label) [ $# -ge 2 ] || exit 2; label="$2"; shift 2 ;;
    --check-destination) check=true; shift ;;
    --startup-notice) notice=true; shift ;;
    *) echo "usage: pre-migrate.sh [--label manual|pre-migrate|pre-drop|daily] | --check-destination | --startup-notice" >&2; exit 2 ;;
  esac
done
case "$label" in manual|pre-migrate|pre-drop|daily) ;; *) echo "Invalid backup label." >&2; exit 2 ;; esac
export BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
if [ "$notice" = true ]; then
  case "${BACKUP_ENABLED:-}" in
    "" | false)
      echo "NOTICE: Backups are off (BACKUP_ENABLED is false, the default). Migrations and scheduled deletions run without a backup. To enable, set BACKUP_ENABLED=true and BACKUP_AGE_RECIPIENT, and mount a volume at BACKUP_DIR and/or set BACKUP_S3_BUCKET with BACKUP_S3_* (Dokploy generator: --backups true); set BACKUP_SCHEDULE=daily for scheduled backups. See docs/backup-restore.md." >&2
      exit 0
      ;;
    true) exec bash "$ROOT/scripts/backup.sh" --check-destination ;;
    *) echo "FATAL: BACKUP_ENABLED must be true or false (got \"$BACKUP_ENABLED\")." >&2; exit 1 ;;
  esac
fi
if [ "$check" = true ]; then exec bash "$ROOT/scripts/backup.sh" --check-destination; fi
exec bash "$ROOT/scripts/backup.sh" --label "$label"
