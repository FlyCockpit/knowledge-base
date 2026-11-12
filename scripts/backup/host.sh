#!/usr/bin/env bash
# Host adapter: list | backup | restore <bundle|latest> <host-identity> <attempt-uuid>
#               drill <bundle|latest> <host-identity> | hold-deletions [days|--clear]
# Add --project <compose-project>. Restore only accepts an empty target; retain
# the source and attempt UUID for an interrupted retry. Download S3 bundle AND
# its .complete marker before using this helper. The identity is mounted read-only.
set -euo pipefail
die() { echo "ERROR: $*" >&2; exit 1; }
action="${1:-}"; [ -n "$action" ] || die "Choose list, backup, restore, drill or hold-deletions."; shift
project=""; args=()
while [ $# -gt 0 ]; do
  if [ "$1" = --project ]; then [ $# -ge 2 ] || die "--project needs a name"; project="$2"; shift 2
  else args+=("$1"); shift; fi
done
if [ -z "$project" ]; then
  mapfile -t projects < <(docker ps -a -f label=io.knowledge-base.role=server --format '{{.Label "com.docker.compose.project"}}' | sort -u)
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
[ -n "$data_root" ] && [ -n "$backup_root" ] || die "Server lacks its data/backup mounts."
mount_source() { docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1"; }
data_source="$(mount_source "$server" "$data_root")"
backup_source="$(mount_source "$server" "$backup_root")"
[ -n "$data_source" ] && [ -n "$backup_source" ] || die "Data and backup mounts are required."
app_env() {
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$server" |
    grep -E '^(DATABASE_URL|KB_DATA_ROOT|KB_MASTER_KEY|BETTER_AUTH_SECRET|BACKUP_[A-Z_]+|KB_ASSET_[A-Z_]+|S3_ACCESS_KEY_ID)=' |
    sed '/^KB_ASSET_S3_SECRET_ACCESS_KEY=/d;/^KB_INSTANCE_ID=/d'
}
run_image() {
  docker run --rm --network "$network" --mount "type=bind,src=$data_source,dst=$data_root" \
    --mount "type=bind,src=$backup_source,dst=$backup_root" --env-file <(app_env) "$image" "$@"
}
case "$action" in
  list) run_image restore --list ;;
  backup) run_image backup ;;
  hold-deletions) run_image hold-deletions "${args[@]}" ;;
  restore|drill)
    [ ${#args[@]} -ge 2 ] || die "$action requires a completed bundle (or latest) and absolute host identity path."
    source="${args[0]}"; identity="${args[1]}"
    [[ "$source" = latest || "$source" = "$backup_root/"* ]] || die "Put the bundle and marker in $backup_root; use its container path."
    [[ "$identity" = /* && -f "$identity" && -r "$identity" ]] || die "Identity must be an absolute readable host file (also readable by image UID 1000)."
    if [ "$action" = restore ]; then
      [ ${#args[@]} -eq 3 ] || die "restore requires the same attempt UUID on every retry."
      [ -t 0 ] || die "Use a terminal to confirm the offline restore."
      read -r -p "Type the compose project '$project' to stop writers and restore into an EMPTY target: " answer
      [ "$answer" = "$project" ] || die "Cancelled."
      writers=()
      # The proxy-facing server service is named "<project>-server" (no shared
      # unqualified alias on the proxy network); find it by its role label.
      while IFS= read -r id; do [ -z "$id" ] || writers+=("$id"); done < <(docker ps -q -f "label=com.docker.compose.project=$project" -f label=io.knowledge-base.role=server)
      for service in worker backup; do
        while IFS= read -r id; do [ -z "$id" ] || writers+=("$id"); done < <(docker ps -q -f "label=com.docker.compose.project=$project" -f "label=com.docker.compose.service=$service")
      done
      for id in "${writers[@]}"; do docker stop -t 60 "$id" >/dev/null; done
      if docker run --rm --network "$network" --mount "type=bind,src=$data_source,dst=$data_root" \
        --mount "type=bind,src=$backup_source,dst=$backup_root" --mount "type=bind,src=$identity,dst=/run/kb-restore.identity,readonly" \
        --env-file <(app_env) "$image" restore "$source" /run/kb-restore.identity "${args[2]}"; then
        for id in "${writers[@]}"; do docker start "$id" >/dev/null; done
      else
        die "Restore incomplete; writers remain stopped. Retry the same source/attempt offline."
      fi
    else
      [ ${#args[@]} -eq 2 ] || die "drill accepts only source and identity."
      suffix="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
      drill_net="knowledge-base-drill-$suffix"; drill_db="knowledge-base-drill-pg-$suffix"; drill_data="knowledge-base-drill-data-$suffix"
      password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
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
        if docker exec "$drill_db" pg_isready -q -h 127.0.0.1 -U postgres -d restore_drill; then ready=$((ready+1)); else ready=0; fi
        [ "$ready" -lt 2 ] || break
        sleep 1
      done
      [ "$ready" -ge 2 ] || die "Throwaway Postgres did not become ready."
      docker run --rm --user root --entrypoint node --mount "type=volume,src=$drill_data,dst=/drill-data" \
        -e KB_DATA_ROOT=/drill-data -e KB_RUNTIME_UID=1000 -e KB_RUNTIME_GID=1000 "$image" /app/scripts/init-kb-volumes.mjs
      drill_env() {
        app_env | sed '/^DATABASE_URL=/d;/^KB_DATA_ROOT=/d'
        printf 'DATABASE_URL=postgresql://postgres:%s@drill-db:5432/restore_drill\nKB_DATA_ROOT=/drill-data\n' "$password"
      }
      docker run --rm --network "$drill_net" --mount "type=volume,src=$drill_data,dst=/drill-data" \
        --mount "type=bind,src=$backup_source,dst=$backup_root,readonly" --mount "type=bind,src=$identity,dst=/run/kb-restore.identity,readonly" \
        --env-file <(drill_env) "$image" restore-drill "$source" /run/kb-restore.identity
    fi
    ;;
  *) die "Choose list, backup, restore, drill or hold-deletions." ;;
esac
