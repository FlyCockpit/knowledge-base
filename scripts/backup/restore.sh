#!/usr/bin/env bash
# Restore remains empty-target-only and enters both native lifetime fences.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ "${1:-}" = --list ]; then
  [ "$#" -eq 1 ] || exit 2
  exec node --input-type=module -e '
    const {completedPairs}=await import(process.argv[2]);
    for (const r of (await completedPairs(process.env.BACKUP_DIR || "/app/backups")).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)))
      console.log(`${r.createdAt} ${r.label} ${r.bundlePath}`);
  ' kb-restore-discovery "$ROOT/scripts/backup/schedule.mjs"
fi
if [ "${1:-}" = latest ]; then
  shift
  file="$(node --input-type=module -e '
    const {completedPairs}=await import(process.argv[2]);
    const r=(await completedPairs(process.env.BACKUP_DIR || "/app/backups")).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    if(!r) process.exit(1); process.stdout.write(r.bundlePath);
  ' kb-restore-discovery "$ROOT/scripts/backup/schedule.mjs")" || { echo 'No completed backup pair found.' >&2; exit 1; }
  set -- "$file" "$@"
fi
exec /usr/local/bin/kb-supervisor --restore -- node "$ROOT/scripts/lib/kb-restore.mjs" "$@"
