#!/usr/bin/env bash
# Required migration/drop hooks always produce KB's encrypted PG+Git+CAS bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
label=manual
required=0
while [ $# -gt 0 ]; do
  case "$1" in
    --label) [ $# -ge 2 ] || exit 2; label="$2"; shift 2 ;;
    --required) required=1; shift ;;
    *) echo "usage: pre-migrate.sh [--label manual|pre-migrate|pre-drop|daily] [--required]" >&2; exit 2 ;;
  esac
done
case "$label" in manual|pre-migrate|pre-drop|daily) ;; *) echo "Invalid backup label." >&2; exit 2 ;; esac
case "$label" in pre-migrate|pre-drop|daily) required=1 ;; esac
export BACKUP_REQUIRED="$required"
export BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
exec bash "$ROOT/scripts/backup.sh" --label "$label"
