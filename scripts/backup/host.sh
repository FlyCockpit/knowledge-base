#!/usr/bin/env bash
# Host adapter: list | backup | restore <bundle|latest> <host-identity> <attempt-uuid>
#               drill <bundle|latest> <host-identity> | hold-deletions [days|--clear]
# Add --project <compose-project>. Restore only accepts an empty target; retain
# the source and attempt UUID for an interrupted retry. Download S3 bundle AND
# its .complete marker before using this helper. The identity is mounted read-only.
#
# restore exit status: 0 restored, writers (server, worker, backup) started
# again; 3 cancelled at the typed-project prompt (decline, EOF, Ctrl-C/TERM/HUP),
# nothing stopped, or refused by the restore before it changed anything
# (bad arguments, busy or non-empty target, no completed pair, …), writers
# started again; anything else: the restore did not finish, the writers stay
# stopped, and the exact `docker start` command and the retry (same source and
# attempt UUID) are printed. `restore … | tee restore.log` works: only stdin
# must be a terminal; read `${PIPESTATUS[0]}` (or `set -o pipefail`) for the
# helper's status.
#
# Linux only: it runs on the deployment server (bash, GNU coreutils, docker).
# Its tests (scripts/backup/host.test.mjs) run on Linux, or in a Linux container.
set -euo pipefail

die() {
  echo "ERROR: $*" >&2
  exit 1
}
say() { echo "[kb-host] $*"; }
# The prompt reads stdin, which must be a terminal; stdout may be a pipe.
read_answer() { read -r -p "$1" answer; }
stdin_is_terminal() { [ -t 0 ]; }

# The typed-project stop prompt. Declining (any other text, Enter, EOF) exits 3:
# nothing was stopped, so nothing is started (the EXIT trap is not installed
# yet). So does Ctrl-C (INT), TERM or HUP while it waits. The signal traps cover
# the prompt only; the previous ones are restored right after it. A `| tee`
# reader that left while the prompt waited must not turn the 3 into a SIGPIPE
# death (141) or a failed write (1), so the message is best effort.
cancel_stop() {
  trap '' PIPE
  say "Cancelled. Nothing was changed; no writer was stopped." 2>/dev/null || true
  exit 3
}
confirm_stop() {
  local previous declined=0 answer=""
  previous="$(trap -p INT TERM HUP)"
  # PIPE is ignored before any output: stderr may feed a dead `2>&1 | tee`.
  trap 'trap "" PIPE; echo >&2 2>/dev/null || true; cancel_stop' INT TERM HUP
  read_answer "Type the compose project '$project' to stop writers and restore into an EMPTY target: " ||
    declined=1
  trap - INT TERM HUP
  eval "$previous"
  [ "$declined" = 0 ] && [ "$answer" = "$project" ] || cancel_stop
}

parse_args() {
  action="${1:-}"
  [ -n "$action" ] || die "Choose list, backup, restore, drill or hold-deletions."
  shift
  case "$action" in
    list | backup | restore | drill | hold-deletions) ;;
    *) die "Choose list, backup, restore, drill or hold-deletions." ;;
  esac
  project=""
  args=()
  while [ $# -gt 0 ]; do
    if [ "$1" = --project ]; then
      [ $# -ge 2 ] || die "--project needs a name"
      project="$2"
      shift 2
    else
      args+=("$1")
      shift
    fi
  done
  if [ "$action" = restore ] || [ "$action" = drill ]; then
    [ ${#args[@]} -ge 2 ] || die "$action requires a completed bundle (or latest) and absolute host identity path."
    if [ "$action" = restore ]; then
      [ ${#args[@]} -eq 3 ] || die "restore requires the same attempt UUID on every retry."
    else
      [ ${#args[@]} -eq 2 ] || die "drill accepts only source and identity."
    fi
  fi
}

discover_app() {
  if [ -z "$project" ]; then
    mapfile -t projects < <(docker ps -a -f label=io.knowledge-base.role=server \
      --format '{{.Label "com.docker.compose.project"}}' | sed '/^$/d; /^<no value>$/d' | sort -u)
    [ ${#projects[@]} -eq 1 ] || die "Pass --project to select exactly one deployment."
    project="${projects[0]}"
  fi
  mapfile -t servers < <(docker ps -a -q -f "label=com.docker.compose.project=$project" -f label=io.knowledge-base.role=server)
  [ ${#servers[@]} -eq 1 ] || die "Expected one server container for this project."
  server="${servers[0]}"
  image="$(docker inspect -f '{{.Image}}' "$server")"
  # Derive the private network from Postgres, never the shared proxy network.
  postgres="$(docker ps -a -q -f "label=com.docker.compose.project=$project" -f label=com.docker.compose.service=postgres)"
  [ -n "$postgres" ] || die "No project Postgres container found."
  mapfile -t networks < <(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$postgres" | sed '/^$/d')
  [ ${#networks[@]} -eq 1 ] || die "Expected one private Postgres network."
  network="${networks[0]}"
  data_root="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server" | sed -n 's/^KB_DATA_ROOT=//p')"
  backup_root="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server" | sed -n 's/^BACKUP_DIR=//p')"
  [ -n "$data_root" ] || die "Server lacks its data mount (KB_DATA_ROOT)."
  data_source="$(mount_source "$server" "$data_root")"
  backup_source=""
  [ -z "$backup_root" ] || backup_source="$(mount_source "$server" "$backup_root")"
  [ -n "$data_source" ] || die "The data mount is required."
}
# list, backup, restore and drill read or write bundles in the backups mount.
# A deployment generated with backups off (the default) has none; only
# hold-deletions works without it.
require_backups() {
  [ -n "$backup_root" ] && [ -n "$backup_source" ] ||
    die "This deployment has no backups mount (BACKUP_DIR volume), which $action needs. Regenerate the deployment with backups on (pnpm dokploy:config --backups true) and redeploy, then put the bundle and its .complete marker in that mount (docs/backup-restore.md)."
}
mount_source() { docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1"; }
app_env() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server" |
    grep -E '^(DATABASE_URL|KB_DATA_ROOT|KB_MASTER_KEY|BETTER_AUTH_SECRET|BACKUP_[A-Z_]+|KB_ASSET_[A-Z_]+|S3_ACCESS_KEY_ID)=' |
    sed '/^KB_ASSET_S3_SECRET_ACCESS_KEY=/d;/^KB_INSTANCE_ID=/d'
}
run_image() {
  local backup_mount=()
  [ -z "$backup_source" ] || backup_mount=(--mount "type=bind,src=$backup_source,dst=$backup_root")
  docker run --rm --network "$network" --mount "type=bind,src=$data_source,dst=$data_root" \
    "${backup_mount[@]}" --env-file <(app_env) "$image" "$@"
}
check_source_identity() {
  source="${args[0]}"
  identity="${args[1]}"
  [[ "$source" = latest || "$source" = "$backup_root/"* ]] || die "Put the bundle and marker in $backup_root; use its container path."
  [[ "$identity" = /* && -f "$identity" && -r "$identity" ]] || die "Identity must be an absolute readable host file (also readable by image UID 1000)."
}

# Start first, talk second: after Ctrl-C under `restore | tee log` the pipe's
# reader is gone, and a write to it would kill this shell (SIGPIPE) before the
# writers are started again. The trap ignores INT/TERM/HUP/PIPE, starts the
# writers when that is safe, then reports on stderr, ignoring write errors.
# shellcheck disable=SC2329 # Called by the EXIT trap.
note() { echo "[kb-host] $*" >&2 2>/dev/null || true; }
# shellcheck disable=SC2329 # Called by the EXIT trap, including failures.
restore_exit() {
  local exit_status=$?
  trap '' INT TERM HUP PIPE
  if [ "$restore_invoked" = 0 ] || [ "$exit_status" -eq 0 ] || [ "$exit_status" -eq 3 ]; then
    # After a completed restore every writer starts (stopped ones included,
    # so a completed retry brings back what an earlier failed attempt left
    # stopped). When nothing was restored (not invoked, or refused: 3) only
    # the writers that were running before this helper stopped them start
    # again: one stopped by an earlier failed attempt, or by the operator,
    # stays stopped.
    local restart=("${writers[@]}")
    [ "$restore_invoked" = 1 ] && [ "$exit_status" -eq 0 ] || restart=("${running_writers[@]}")
    # `docker stop` first: an interrupted stop (Ctrl-C kills the client, the
    # daemon keeps stopping) would make a bare `docker start` a no-op on a
    # container that then exits. Stopping waits for that; it is a no-op for a
    # container already stopped.
    local failed=()
    for id in "${restart[@]}"; do
      docker stop -t 60 "$id" >/dev/null 2>&1 || true
      docker start "$id" >/dev/null 2>&1 || failed+=("$id")
    done
    if [ "$restore_invoked" = 0 ]; then
      note "Restore was not invoked; nothing was restored."
    elif [ "$exit_status" -eq 3 ]; then
      note "Refused; nothing was changed (see the REFUSED: line above). Fix the cause and run it again."
    else
      note "Restore done."
    fi
    if [ ${#failed[@]} -gt 0 ]; then
      note "Could not start: docker start ${failed[*]}"
    elif [ ${#restart[@]} -gt 0 ]; then
      note "Started the writers again."
    fi
    if [ ${#restart[@]} -lt ${#writers[@]} ]; then
      local kept=() id
      for id in "${writers[@]}"; do
        [[ " ${restart[*]} " == *" $id "* ]] || kept+=("$id")
      done
      note "Left stopped (they were not running before): ${kept[*]}"
    fi
  else
    if [ "$exit_status" -ge 125 ] && [ "$exit_status" -le 127 ]; then
      note "docker run failed (exit $exit_status): the restore container may not have started."
    fi
    note "The restore did not finish (exit $exit_status). The writers stay stopped."
    note "Retry offline with the same source and attempt UUID:"
    note "  bash $0 restore ${args[*]} --project $project"
    [ ${#writers[@]} -eq 0 ] ||
      note "Only after a completed restore, or to abandon it: docker start ${writers[*]}"
  fi
  return "$exit_status"
}

# list_writers [-a]: the server, worker and backup containers of the project
# (with -a stopped ones too), one id per line.
list_writers() {
  docker ps "$@" -q -f "label=com.docker.compose.project=$project" -f label=io.knowledge-base.role=server
  for service in worker backup; do
    docker ps "$@" -q -f "label=com.docker.compose.project=$project" -f "label=com.docker.compose.service=$service"
  done
}

run_restore() {
  check_source_identity
  stdin_is_terminal || die "Use a terminal to confirm the offline restore."
  writers=()
  # The proxy-facing server service is named "<project>-server" (no shared
  # unqualified alias on the proxy network); find it by its role label.
  # Stopped ones too (-a): after a failed attempt left them stopped, the
  # same-attempt retry must start them again when it completes.
  while IFS= read -r id; do [ -z "$id" ] || writers+=("$id"); done < <(list_writers -a)
  # The ones running now: the only ones started again when nothing gets restored.
  running_writers=()
  while IFS= read -r id; do [ -z "$id" ] || running_writers+=("$id"); done < <(list_writers)
  confirm_stop
  restore_invoked=0
  trap restore_exit EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  # From here on a dead stdout reader (`| tee` killed by Ctrl-C) must not kill
  # this shell outright: a failed write ends it through set -e and the EXIT
  # trap still runs.
  trap '' PIPE
  for id in "${writers[@]}"; do
    say "Stopping $id ..."
    docker stop -t 60 "$id" >/dev/null
  done
  local status=0
  restore_invoked=1
  docker run --rm --network "$network" --mount "type=bind,src=$data_source,dst=$data_root" \
    --mount "type=bind,src=$backup_source,dst=$backup_root" --mount "type=bind,src=$identity,dst=/run/kb-restore.identity,readonly" \
    --env-file <(app_env) "$image" restore "$source" /run/kb-restore.identity "${args[2]}" || status=$?
  exit "$status"
}

run_drill() {
  check_source_identity
  suffix="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  drill_net="knowledge-base-drill-$suffix"
  drill_db="knowledge-base-drill-pg-$suffix"
  drill_data="knowledge-base-drill-data-$suffix"
  password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  # shellcheck disable=SC2329 # Called by the EXIT trap.
  cleanup() {
    docker rm -f -v "$drill_db" >/dev/null 2>&1 || true
    docker volume rm "$drill_data" >/dev/null 2>&1 || true
    docker network rm "$drill_net" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  docker network create "$drill_net" >/dev/null
  docker volume create "$drill_data" >/dev/null
  pg_image="$(docker inspect -f '{{.Config.Image}}' "$postgres")"
  docker run -d --name "$drill_db" --network "$drill_net" --network-alias drill-db \
    --env-file <(printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=restore_drill\n' "$password") "$pg_image" >/dev/null
  ready=0
  for _ in {1..90}; do
    if docker exec "$drill_db" pg_isready -q -h 127.0.0.1 -U postgres -d restore_drill; then ready=$((ready + 1)); else ready=0; fi
    [ "$ready" -lt 2 ] || break
    sleep 1
  done
  [ "$ready" -ge 2 ] || die "Throwaway Postgres did not become ready."
  docker run --rm --user root --entrypoint node --mount "type=volume,src=$drill_data,dst=/drill-data" \
    -e KB_DATA_ROOT=/drill-data -e KB_RUNTIME_UID=1000 -e KB_RUNTIME_GID=1000 "$image" /app/scripts/init-kb-volumes.mjs
  drill_env() {
    app_env | sed '/^DATABASE_URL=/d;/^KB_DATA_ROOT=/d'
    printf 'DATABASE_URL=%s\nKB_DATA_ROOT=/drill-data\n' "postgresql://postgres:$password@drill-db:5432/restore_drill"
  }
  docker run --rm --network "$drill_net" --mount "type=volume,src=$drill_data,dst=/drill-data" \
    --mount "type=bind,src=$backup_source,dst=$backup_root,readonly" --mount "type=bind,src=$identity,dst=/run/kb-restore.identity,readonly" \
    --env-file <(drill_env) "$image" restore-drill "$source" /run/kb-restore.identity
}

main() {
  parse_args "$@"
  command -v docker >/dev/null || die "docker is not installed on this machine."
  docker info >/dev/null 2>&1 || die "cannot talk to Docker. Run this on the deployment server as a user who can run docker."
  discover_app
  case "$action" in
    list) require_backups && run_image restore --list ;;
    backup) require_backups && run_image backup ;;
    hold-deletions) run_image hold-deletions "${args[@]}" ;;
    restore) require_backups && run_restore ;;
    drill) require_backups && run_drill ;;
  esac
}

# `${BASH_SOURCE[0]:-$0}`: piped into `bash -s` there is no source file (set -u).
# Sourced (the tests), it only defines the functions.
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
