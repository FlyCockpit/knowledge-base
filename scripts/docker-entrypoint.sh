#!/bin/sh
# Server startup leads committed migrations; worker startup waits and registers.
# One-shots bypass runtime registration and the server/worker lifetime fences.
set -e

# Never trust an inherited identity, including on one-shot commands.
unset KB_INSTANCE_ID
case "${1:-}" in
  migrate)
    shift
    [ "$#" -eq 0 ] || { echo "FATAL: migrate takes no arguments." >&2; exit 1; }
    exec env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/db/migrate-runtime.mjs apply
    ;;
  hold-deletions)
    shift
    exec env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/db/migrate-runtime.mjs hold "$@"
    ;;
  backup)
    shift
    exec env -u KB_ASSET_S3_SECRET_ACCESS_KEY bash /app/scripts/backup/pre-migrate.sh --label manual "$@"
    ;;
  backup-schedule)
    shift
    [ "$#" -eq 0 ] || { echo "FATAL: backup-schedule takes no arguments." >&2; exit 1; }
    exec env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/backup/schedule.mjs run
    ;;
  restore)
    shift
    exec env -u KB_ASSET_S3_SECRET_ACCESS_KEY bash /app/scripts/backup/restore.sh "$@"
    ;;
  asset-storage)
    shift
    # The existing coordinator enters kb-supervisor's native offline storage role.
    exec env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/lib/asset-storage-migration.mjs "$@"
    ;;
  restore-drill)
    shift
    exec env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/backup/drill.mjs "$@"
    ;;
esac

# --- 1. Required env vars ---
missing=""
required_vars="DATABASE_URL REDIS_URL"
kb_volume_role=all
case " $* " in
  *" apps/server/dist/index.mjs"*|*" apps/server/"*|*"/apps/server/dist/index.mjs"*)
    required_vars="$required_vars BETTER_AUTH_SECRET"
    kb_volume_role=server
    ;;
  *" apps/worker/dist/index.mjs"*|*" apps/worker/"*|*"/apps/worker/dist/index.mjs"*)
    kb_volume_role=worker
    ;;
esac

for var in $required_vars; do
  eval val=\$$var
  if [ -z "$val" ]; then
    missing="$missing $var"
  fi
done

if [ "$kb_volume_role" = server ] || [ "$kb_volume_role" = worker ] || [ -n "${KB_MASTER_KEY:-}" ]; then
  node /app/scripts/lib/validate-kb-master-key.mjs || exit 1
fi

if [ -n "$missing" ]; then
  echo "FATAL: Missing required environment variable(s):$missing" >&2
  echo "       Set them in your orchestrator (e.g. Dokploy)." >&2
  # Deliberate: this check reads the process environment only. The Node bundle
  # CAN read a repo-root .env (see @knowledge-base/env/load-dotenv), so a mounted
  # /app/.env would satisfy the app but not this gate — and that asymmetry is
  # confusing enough to name here. The container contract is injected env: the
  # image ships no .env, and this check plus the migration runner both
  # depend on the values being in the environment.
  echo "       A mounted /app/.env does not satisfy this check — the container" >&2
  echo "       contract is injected environment variables, not an env file." >&2
  exit 1
fi

if [ "$NODE_ENV" = "production" ] && [ -z "$ADMIN_EMAIL" ]; then
  # Matches the Node env-layer boot guard in packages/env/src/server.ts:
  # production first-user creation requires ADMIN_EMAIL even when public
  # signup is enabled. The server keeps booting (provisioned installs hold
  # their admins in the database) — this is the best-effort early signal for
  # the fresh-install case.
  echo "WARNING: ADMIN_EMAIL is empty. A fresh production instance cannot" >&2
  echo "         bootstrap its first admin (including when SIGNUP_ENABLED=true)." >&2
  echo "         Set ADMIN_EMAIL to one operator address before the first signup." >&2
fi

# Packaged artifacts and the data-volume mount must be valid before schema/network
# IO. The check inspects only the KB_DATA_ROOT mount root, so it runs before
# step 3 repairs the skeleton (an empty bind mount passes, then is initialized).
if [ "$kb_volume_role" != all ]; then
  if [ ! -f /app/scripts/init-kb-volumes.mjs ]; then
    echo "FATAL: KB runtime deployment invalid" >&2
    exit 1
  fi
  node /app/scripts/init-kb-volumes.mjs --check-runtime "$kb_volume_role"
fi

if [ "$kb_volume_role" != all ]; then
# One fresh identity per runtime start, shared with the application's heartbeat.
# Wait mode registers too; it is not a read-only operation.
KB_INSTANCE_ID="$(node -p 'require("node:crypto").randomUUID()')"
export KB_INSTANCE_ID
if [ "$kb_volume_role" = server ]; then
  MIGRATE_ON_START="${MIGRATE_ON_START:-true}"
else
  MIGRATE_ON_START="${MIGRATE_ON_START:-false}"
fi
case "$MIGRATE_ON_START" in
  true)
    env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/db/migrate-runtime.mjs apply --role "$kb_volume_role"
    ;;
  false)
    if ! env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/db/migrate-runtime.mjs wait --role "$kb_volume_role"; then
      echo "FATAL: migration wait failed. A full bundle can exceed the 300s wait;" >&2
      echo "       retry this runtime after the server finishes migrating. Restart policy retries automatically." >&2
      exit 1
    fi
    ;;
  *) echo "FATAL: MIGRATE_ON_START must be true or false." >&2; exit 1 ;;
esac
fi

# --- 3. Data-volume skeleton (no-follow; nonroot UID/GID when running as root) ---
# Role-free: server and worker both mount the one KB_DATA_ROOT volume
# read-write. Fresh named volumes receive the image's UID/GID 1000 skeleton via
# Docker copy-up (see the Dockerfiles); this repairs any missing piece. It runs
# after the step-1 runtime check, which inspects only the mount root.
if [ -f /app/scripts/init-kb-volumes.mjs ]; then
  node /app/scripts/init-kb-volumes.mjs
fi

# The migration/backup child above needs the asset reader and backup writer.
# The long-running application must not retain those offline credentials.
# One-shot dispatch exits before this boundary and keeps its operator inputs.
unset KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY
unset BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_HEARTBEAT_URL
if [ "$kb_volume_role" = worker ]; then
  unset KB_ASSET_S3_ACCESS_KEY_ID KB_ASSET_S3_SECRET_ACCESS_KEY
fi

# --- 4. Hand off to the output supervisor, which starts kb-supervisor and the
# service behind private pipes. The native supervisor still owns all fences.
exec "$@"
