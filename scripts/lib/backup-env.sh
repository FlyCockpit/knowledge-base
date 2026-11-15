#!/usr/bin/env bash
# Shared backup toggles for backup.sh and migration backup hooks.
# shellcheck shell=bash

_backup_env_truthy() {
  case "${1:-}" in
    true) return 0 ;;
    false | "") return 1 ;;
    *)
      echo "FATAL: invalid boolean value '$1' (use true or false)." >&2
      exit 1
      ;;
  esac
}

# Backups are opt-in, including migration hooks.
backup_enabled() {
  _backup_env_truthy "${BACKUP_ENABLED:-false}"
}

backup_s3_configured() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] \
    && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] \
    && [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]
}
