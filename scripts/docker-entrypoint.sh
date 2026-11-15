#!/bin/sh
# Docker entrypoint — PID 1 of the server and worker images (Dockerfile and
# Dockerfile.worker set ENTRYPOINT to this script, not to tini). It runs before
# the container CMD.
#
# Startup-only credentials stay out of the long-running runtime: this script
# holds the asset operator pair (KB_ASSET_S3_OPERATOR_*), the backup writer pair
# (BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY) and
# BACKUP_HEARTBEAT_URL only while the migration runner (and its pre-migration /
# pre-drop full-bundle backups) runs as its child, then unsets them (and, for
# the worker, the asset writer pair) and `exec`s tini with the CMD. tini becomes
# PID 1 with that clean environment, so neither /proc/1/environ nor the
# runtime's own environment carries those keys. The non-secret BACKUP_S3_*
# location settings stay for the freshness monitor (BACKUP_MONITOR_S3_*). The
# one-shot commands keep their operator inputs: that is their job. The
# migration runner and every one-shot run with KB_ASSET_S3_SECRET_ACCESS_KEY
# removed (env -u); the short KB_MASTER_KEY and volume checks before the runner
# see the full startup environment, and the CMD keeps the asset writer pair on
# the server (the worker's is unset).
#
# Image commands:
#   migrate              run the migration runner once and exit with its status
#                        (container platforms: a one-shot job before rollout).
#   hold-deletions [days|--clear]   owner hold on scheduled deletions.
#   backup [args...]     take a full encrypted bundle now (label `manual`).
#   backup-schedule      the optional daily-backup service.
#   restore <args...>    offline restore (scripts/backup/restore.sh).
#   asset-storage <...>  offline asset-storage migration coordinator.
#   restore-drill <...>  restore into a throwaway target and verify it.
#   anything else        the normal CMD (server or worker, `--fenced`: tini →
#                        node output supervisor → kb-supervisor → service),
#                        after:
#     1. required env, KB_MASTER_KEY and packaged-runtime/volume checks;
#     2. migrations — MIGRATE_ON_START=true (default for the server):
#        `migrate-runtime.mjs apply --role server` (classification, the
#        pre-migration full-bundle backup when BACKUP_ENABLED=true, deploy,
#        due deletions); MIGRATE_ON_START=false (default for the worker):
#        `migrate-runtime.mjs wait`. Both register a fresh KB_INSTANCE_ID
#        that the CMD's heartbeat keeps alive; one-shots register nothing;
#     3. the data-volume skeleton repair;
#     4. drop the startup-only keys and exec tini with the CMD.
#
# See docs/schema-migrations.md and docs/deploy.md.

# Stop signals: handlers go in before validation or any child (even the
# `node -p` that mints the instance id), so there is no gap between steps where
# a `docker stop` is dropped — a shell running as PID 1 ignores TERM unless it
# traps it — and the runner or the CMD starts anyway. They stay through `exec`
# (exec resets caught signals itself), so there is no untrapped gap between
# steps. (Before the first trap and between `exec` and tini installing its
# own handlers, a TERM to PID 1 is dropped; sh cannot close those windows.)
#
# A supervised child gets TERM for every stop signal: this non-interactive
# shell starts background children with SIGINT ignored, and bash keeps that,
# so a forwarded INT could not stop it. The entrypoint still exits with the
# signal's own status (143 TERM, 130 INT, 129 HUP).
child_pid=""
child_start=""
launching_child=false
stop_signal=""
stopping=false
have_proc=false
if [ -r /proc/self/stat ]; then have_proc=true; fi
# With a supervised child, the handler itself repeats the TERM until the child
# is gone (stop_child): a signal that lands just before supervise's `wait` runs
# the handler and then lets `wait` block, so nothing after it could repeat a
# TERM the child missed. During the launch the child is not identified yet:
# the handler only records the signal, and supervise forwards it. A signal
# that lands while a stop is already under way only records itself: a nested
# handler that drove the child to gone (letting dash reap it and free its PID)
# would make the interrupted check-then-kill outside it signal a stale PID.
# Without /proc nothing repeats the TERM, so there every signal sends one, as
# before.
stop_startup() {
  stop_signal="$1"
  [ "$stopping" = false ] || [ "$have_proc" = false ] || return 0
  if [ -n "$child_pid" ]; then
    stopping=true
    stop_child
  elif [ "$launching_child" = false ]; then
    exit "$2"
  fi
}
trap 'stop_startup TERM 143' TERM
trap 'stop_startup INT 130' INT
trap 'stop_startup HUP 129' HUP
set -e

# The pause between repeated TERMs: 0.2 s where sleep takes fractions, else
# 1 s. Decided once, here: in dash a trap that runs during another trap leaves
# $? at the outer trap's status, so the loop cannot branch on sleep's status.
stop_pause=1
if sleep 0.01 2>/dev/null; then stop_pause=0.2; fi

# proc_start <pid>: sets proc_start_value to the start time of a live (not
# zombie) process, field 22 of /proc/<pid>/stat, or to "" for a process that is
# gone or a zombie. It tells the supervised child apart from a later process
# that reuses its PID once it has been reaped (dash reaps a background child
# while it waits for any foreground command, such as `sleep`). Builtins only,
# no fork: the trap handler runs it, and a container at its pids limit cannot
# fork, so the first TERM always gets out. (stop_child's pause does fork
# `sleep`: at a full pids limit dash exits 2 there, after that TERM, and the
# container's teardown ends the child.) The stop guard keeps two calls from
# interleaving.
proc_start() {
  proc_start_value=""
  stat_line=""
  read -r stat_line 2>/dev/null <"/proc/$1/stat" || [ -n "$stat_line" ] || return 0
  # Field 2 (comm) is in parentheses and may contain spaces: drop through ") ".
  # shellcheck disable=SC2086
  set -- ${stat_line##*) }
  [ $# -ge 20 ] || return 0
  [ "$1" != Z ] || return 0
  shift 19
  proc_start_value=$1
}

# child_alive: the supervised child still runs (same start time as at launch;
# without /proc, `kill -0`).
child_alive() {
  if [ "$have_proc" = true ]; then
    [ -n "$child_start" ] || return 1
    proc_start "$child_pid"
    [ "$proc_start_value" = "$child_start" ]
  else
    kill -0 "$child_pid" 2>/dev/null
  fi
}

# term_child: TERM the supervised child, checked right before the kill, so a
# reaped child's reused PID is not signalled (a gap of microseconds remains
# between the check and the kill builtin; it matters only if the PID space
# wraps around within it).
term_child() {
  [ -n "$child_pid" ] || return 0
  if [ "$have_proc" = false ] || child_alive; then
    kill -TERM "$child_pid" 2>/dev/null || :
  fi
}

# stop_child: TERM the child every 0.2 s until it is gone (where /proc
# identifies it; elsewhere, once). One TERM is not enough: one that lands in
# the instant after the fork, before the forked shell has reset the traps it
# inherited from this one, is swallowed there, and the command would run to
# its end. Repeating it is harmless: the master-key and volume checks have no
# TERM handler, and the migration runner's handler only aborts its own work
# (idempotently): it forwards one TERM to a running backup hook, never starts
# another, and drains its children before it exits.
stop_child() {
  term_child
  # Without /proc a reaped child's PID could be reused: one TERM only, which
  # the fork window can swallow. The image always has /proc; only a local run
  # of this script elsewhere (not Linux) takes this path.
  [ "$have_proc" = true ] || return 0
  # (The pause forks `sleep`; the TERM itself never needs a fork.)
  while child_alive; do
    sleep "$stop_pause" 2>/dev/null || :
    term_child
  done
}

# supervise <command...>: run one startup child (the master-key and volume
# checks, the migration runner) in the background so a stop signal reaches it —
# a trapped signal only runs between commands, so a foreground child (a stalled
# data-volume mount) would keep it from running — then wait for the child's own exit, so
# PID 1 stays alive while the child drains. Returns the child's status. After a
# stop signal neither a later step nor the CMD ever starts: the child gets TERM
# until it is gone, then the entrypoint exits with the signal's status.
supervise() {
  launching_child=true
  "$@" &
  child_pid=$!
  # Its identity for every later TERM, read with builtins only, so dash cannot
  # reap the child (and free its PID) before the read. A child that already
  # exited reads as gone and is never signalled. Until
  # launching_child is false, a signal is only recorded (term_child skips a
  # child it cannot identify yet) and handled just below.
  if [ "$have_proc" = true ]; then
    proc_start "$child_pid"
    child_start=$proc_start_value
  fi
  launching_child=false
  set +e
  if [ -z "$stop_signal" ]; then
    wait "$child_pid"
    child_status=$?
  fi
  # A stop signal recorded during the launch (the handler has already stopped
  # the child for any later one): TERM the child until it is gone, then
  # collect it.
  if [ -n "$stop_signal" ]; then
    stopping=true
    stop_child
    wait "$child_pid" 2>/dev/null
    # Without /proc: a further signal interrupts that wait; wait again while
    # the child still runs.
    while [ "$have_proc" = false ] && kill -0 "$child_pid" 2>/dev/null; do
      wait "$child_pid" 2>/dev/null
    done
  fi
  set -e
  child_pid=""
  child_start=""
  case "$stop_signal" in
    TERM) exit 143 ;;
    INT) exit 130 ;;
    HUP) exit 129 ;;
  esac
  return "$child_status"
}
run_runner() { supervise env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/db/migrate-runtime.mjs "$@"; }
# Backups notice / check, once per start: the backups-off notice, or with
# BACKUP_ENABLED=true a refusal without a usable destination (no bundle, no
# database access; scripts/backup/pre-migrate.sh --startup-notice).
startup_notice() { supervise env -u KB_ASSET_S3_SECRET_ACCESS_KEY bash /app/scripts/backup/pre-migrate.sh --startup-notice; }

# --- Strict switches ---
case "${BACKUP_ENABLED:-}" in
  "" | true | false) ;;
  *)
    echo "FATAL: BACKUP_ENABLED must be true or false (got \"$BACKUP_ENABLED\")." >&2
    exit 1
    ;;
esac

# Server startup leads committed migrations; worker startup waits and registers.
# One-shots bypass runtime registration and the server/worker lifetime fences.
# Never trust an inherited identity, including on one-shot commands.
unset KB_INSTANCE_ID

# --- One-shot image commands ---
# Each one except `migrate` is exec'd under tini (signal forwarding, zombie
# reaping), which becomes PID 1.
case "${1:-}" in
  migrate)
    shift
    [ "$#" -eq 0 ] || { echo "FATAL: migrate takes no arguments." >&2; exit 1; }
    # The container-platform `migrate` job: the runner is PID 1's supervised
    # child (a stop signal reaches it and PID 1 waits for its drain), and the
    # job exits with the runner's status. The backups check comes first, as
    # for every migrating start.
    startup_notice
    status=0
    run_runner apply || status=$?
    exit "$status"
    ;;
  hold-deletions)
    shift
    exec tini -- env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/db/migrate-runtime.mjs hold "$@"
    ;;
  backup)
    shift
    exec tini -- env -u KB_ASSET_S3_SECRET_ACCESS_KEY bash /app/scripts/backup/pre-migrate.sh --label manual "$@"
    ;;
  backup-schedule)
    shift
    [ "$#" -eq 0 ] || { echo "FATAL: backup-schedule takes no arguments." >&2; exit 1; }
    exec tini -- env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/backup/schedule.mjs run
    ;;
  restore)
    shift
    exec tini -- env -u KB_ASSET_S3_SECRET_ACCESS_KEY bash /app/scripts/backup/restore.sh "$@"
    ;;
  asset-storage)
    shift
    # The existing coordinator enters kb-supervisor's native offline storage role.
    exec tini -- env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/lib/asset-storage-migration.mjs "$@"
    ;;
  restore-drill)
    shift
    exec tini -- env -u KB_ASSET_S3_SECRET_ACCESS_KEY node /app/scripts/backup/drill.mjs "$@"
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
  supervise node /app/scripts/lib/validate-kb-master-key.mjs || exit 1
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

if [ "$kb_volume_role" = server ] && [ "$NODE_ENV" = "production" ] && [ -z "$ADMIN_EMAIL" ]; then
  # Matches the Node env-layer boot guard in packages/env/src/server.ts:
  # production first-user creation requires ADMIN_EMAIL even when public
  # signup is enabled. The server keeps booting (provisioned installs hold
  # their admins in the database) — this is the best-effort early signal for
  # the fresh-install case. Only the server bootstraps admins, and the Dokploy
  # generator gives ADMIN_EMAIL to the server alone, so the worker and the
  # one-shot commands never warn.
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
  supervise node /app/scripts/init-kb-volumes.mjs --check-runtime "$kb_volume_role"
fi

# --- 2. Migrations ---
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
  # Backups notice / check, once per start, even with no pending SQL. A start
  # that migrates (apply) refuses when BACKUP_ENABLED=true has no usable
  # destination. One that only waits needs none: a waiting server runs the
  # check only when backups are off, to print the notice; waiting workers stay
  # quiet.
  case "$MIGRATE_ON_START" in
    true)
      startup_notice
      run_runner apply --role "$kb_volume_role"
      ;;
    false)
      if [ "$kb_volume_role" = server ] && [ "${BACKUP_ENABLED:-false}" != true ]; then
        startup_notice
      fi
      if ! run_runner wait --role "$kb_volume_role"; then
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
  supervise node /app/scripts/init-kb-volumes.mjs
fi

# The migration/backup child above needs the asset reader and backup writer.
# The long-running application must not retain those offline credentials.
# One-shot dispatch exits before this boundary and keeps its operator inputs.
unset KB_ASSET_S3_OPERATOR_ACCESS_KEY_ID KB_ASSET_S3_OPERATOR_SECRET_ACCESS_KEY
unset BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_HEARTBEAT_URL
if [ "$kb_volume_role" = worker ]; then
  unset KB_ASSET_S3_ACCESS_KEY_ID KB_ASSET_S3_SECRET_ACCESS_KEY
fi

# --- 4. Hand off to tini, which replaces this shell as PID 1 with the cleaned
# environment and starts the CMD: the node output supervisor, which starts
# kb-supervisor and the service behind private pipes. The native supervisor
# still owns all fences.
exec tini -- "$@"
