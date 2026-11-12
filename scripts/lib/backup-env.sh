#!/usr/bin/env bash
# Shared backup toggles for backup.sh and migration backup hooks.
# shellcheck shell=bash

_backup_env_truthy() {
  case "${1:-}" in
    true | 1 | yes | on | TRUE | YES | ON) return 0 ;;
    false | 0 | no | off | FALSE | NO | OFF | "") return 1 ;;
    *)
      echo "FATAL: invalid boolean value '$1' (use true or false)." >&2
      exit 1
      ;;
  esac
}

# Required migration hooks reject disabled backups; manual backups may no-op.
backup_enabled() {
  _backup_env_truthy "${BACKUP_ENABLED:-true}"
}

backup_s3_configured() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] \
    && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] \
    && [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]
}
