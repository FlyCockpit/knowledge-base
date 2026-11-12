#!/usr/bin/env bash
# dev-docker.sh — port-parameterized local docker-compose stack for agents.
#
# This wrapper:
#   1. detects docker/podman (override via CONTAINER_RUNTIME)
#   2. validates the requested port
#   3. sets COMPOSE_PROJECT_NAME=<repo-slug>-<path-hash>-<port> so runs isolate
#      by repo+port
#   4. generates (once) a per-project KB_MASTER_KEY unless the caller set one
#   5. writes .agent-ports.json with the URL + helper commands
#   6. execs compose up
#
# Development stack only. The production images are tested by
# `pnpm smoke:image` (scripts/image-smoke.sh), not by this stack.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/dev-docker-runtime.sh
. "$SCRIPT_DIR/lib/dev-docker-runtime.sh"

usage() {
  cat >&2 <<'EOF_USAGE'
Usage: pnpm dev:docker <port> [--reset]

Start a local dev stack on <port>. Web dev server is published on
127.0.0.1:<port> (loopback only — see BIND_ADDR below); postgres and redis are
internal to the compose network (not exposed on the host).

Production images are not run here: `pnpm smoke:image` builds Dockerfile +
Dockerfile.worker and checks them behind HTTPS.

Flags:
  --reset    Tear the stack down (wiping the ephemeral database) before
             starting. Equivalent to running `pnpm dev:docker:down <port>`
             first.
  -h, --help Show this help.

Environment:
  CONTAINER_RUNTIME   Force "docker" or "podman". Default: auto-detect.
  BIND_ADDR           Host interface the published ports bind to. Default
                      127.0.0.1 (loopback only) so the stack is never reachable
                      off-box — important on a shared VPS, where Docker bypasses
                      ufw/firewalld. Set BIND_ADDR=0.0.0.0 to reach it from
                      another device on your LAN (e.g. the PWA on a real phone).
  KB_MASTER_KEY       Use this key instead of the generated per-project one.
                      Default: generated once (base64 of 32 random bytes) and
                      kept 0600 in .docker-volumes/<project>/kb-master-key;
                      `pnpm dev:docker:down` / --reset delete it with the data.

Multi-agent isolation: COMPOSE_PROJECT_NAME=<repo-slug>-<path-hash>-<port>
(the repo directory name + a short hash of its canonical path + the port), so
each project+port gets its own isolated network, containers, and ephemeral
volumes — two different template-derived projects on the same host (e.g. a
shared VPS) never collide even if both repos are named the same thing.

Examples:
  pnpm dev:docker 3100
  pnpm dev:docker 3100 --reset
EOF_USAGE
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
PORT=""
PROFILE="dev"
RESET=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --prod)
      echo "error: --prod was removed; run \`pnpm smoke:image\` to test the production images" >&2
      exit 1
      ;;
    --reset)   RESET=1; shift ;;
    --)        shift; break ;;
    -*)        echo "error: unknown flag: $1" >&2; usage; exit 1 ;;
    *)
      if [ -z "$PORT" ]; then
        PORT="$1"
        shift
      else
        echo "error: unexpected argument: $1" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [ -z "$PORT" ]; then
  echo "error: <port> is required" >&2
  usage
  exit 1
fi

case "$PORT" in
  ''|*[!0-9]*)
    echo "error: port must be numeric, got: $PORT" >&2
    exit 1
    ;;
esac

if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "error: port must be between 1024 and 65535" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Runtime + compose detection
# ---------------------------------------------------------------------------
RUNTIME=$(dev_docker_detect_runtime)
COMPOSE=$(dev_docker_pick_compose "$RUNTIME")

cd "$ROOT_DIR"

dev_docker_export_project_name "$ROOT_DIR" "$PORT"
export WEB_PORT="$PORT"
# Mailpit's web UI / REST API host port. Derived from WEB_PORT with a +5000
# offset so it lands in a separate band (8100..9100 for the default 3100..4100
# web range) and never collides with another instance's web port. Mailpit is
# the dev profile's local SMTP sink — captured signup/verification emails are
# readable at http://localhost:$MAILPIT_PORT (UI) and .../api/v1/messages.
export MAILPIT_PORT="$((PORT + 5000))"
# Host interface the published ports bind to. Default 127.0.0.1 (loopback only)
# so the stack is never reachable off-box — critical on a shared VPS, where
# Docker's iptables rules sit ahead of ufw/firewalld and a 0.0.0.0 binding
# would be public even behind a closed host firewall. Opt in for LAN access
# (e.g. testing the PWA on a real phone) with: BIND_ADDR=0.0.0.0 pnpm dev:docker <port>.
export BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
# Pass the host UID/GID through so the dev container runs as the same user
# that owns the bind-mounted repo. Without this, the container runs as root
# and every file it writes inside /app (turbo cache, vite cache, generated
# prisma client, dist output, etc.) lands on the host owned by root.
HOST_UID=$(id -u)
HOST_GID=$(id -g)
export HOST_UID HOST_GID

COMPOSE_FILE="docker-compose.agent.yml"

# ---------------------------------------------------------------------------
# Per-project node_modules live in a gitignored repo dir instead of Docker
# named volumes (see docker-compose.agent.yml). Export the absolute root for
# compose interpolation and pre-create the subdirs as the host user so the
# container (which runs as HOST_UID:HOST_GID) can write into them — Docker
# would otherwise create missing bind sources as root.
# ---------------------------------------------------------------------------
dev_docker_export_volume_root "$ROOT_DIR"

# Enumerate every workspace package that gets its own node_modules (any
# apps/* or packages/* dir with a package.json). Derived from the filesystem,
# not a hardcoded list, so it can never drift as packages are added/removed.
workspace_pkg_dirs() {
  for d in "$ROOT_DIR"/apps/*/ "$ROOT_DIR"/packages/*/; do
    [ -f "${d}package.json" ] || continue
    printf '%s\n' "${d%/}"
  done
}

# nm_<slug> where slug is the workspace-relative path with "/" → "_"
# (apps/api → nm_apps_api, packages/api → nm_packages_api). Path-derived, NOT
# basename, so duplicate leaf names across apps/ and packages/ can never share
# a host cache dir. `nm_root` is the repo-root /app/node_modules.
nm_slug() {
  local rel="${1#"$ROOT_DIR"/}"
  printf 'nm_%s\n' "${rel//\//_}"
}

create_volume_dirs() {
  mkdir -p "$AGENT_VOLUME_ROOT/nm_root" "$ROOT_DIR/node_modules"
  while IFS= read -r d; do
    mkdir -p "$AGENT_VOLUME_ROOT/$(nm_slug "$d")"
    # worker-dev mounts the repo read-only, so Docker cannot create a missing
    # mountpoint inside it. A package with no dependencies (packages/config)
    # has no host node_modules after `pnpm install`; pre-create the
    # (gitignored) mountpoint for every package.
    mkdir -p "$d/node_modules"
  done < <(workspace_pkg_dirs)
}

# Rot guard: a workspace package with no bind mount in the compose file means
# `pnpm install` in the container writes that package's deps into the host repo
# and multi-agent runs collide (the whole point of these mounts). Fail loudly
# with the exact missing entries instead of leaking silently.
assert_volume_coverage() {
  local uncovered="" rel
  while IFS= read -r d; do
    rel="${d#"$ROOT_DIR"/}"
    # Writable mounts for app-dev/dev-setup and the read-only one for worker-dev.
    grep -qF "/$(nm_slug "$d"):/app/$rel/node_modules" "$COMPOSE_FILE" ||
      uncovered="$uncovered $rel"
    grep -qF "/$(nm_slug "$d"):/app/$rel/node_modules:ro" "$COMPOSE_FILE" ||
      uncovered="$uncovered $rel(worker-dev :ro)"
  done < <(workspace_pkg_dirs)
  if [ -n "$uncovered" ]; then
    echo "error: $COMPOSE_FILE is missing node_modules bind mounts for:$uncovered" >&2
    echo "       add, under app-dev volumes, for each:" >&2
    echo '         - ${AGENT_VOLUME_ROOT}/nm_<pkg>:/app/<path>/node_modules' >&2
    echo '       and under worker-dev volumes the same entry with :ro' >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# --reset: tear the project down first (wipes the ephemeral DB + deps cache)
# ---------------------------------------------------------------------------
if [ "$RESET" = "1" ]; then
  echo "[dev-docker] --reset: tearing down $COMPOSE_PROJECT_NAME…"
  # Aborts (keeping the KB_MASTER_KEY) unless the stack's volumes are gone.
  dev_docker_teardown "$RUNTIME" "$COMPOSE" "$COMPOSE_FILE" || exit 1
fi

# ---------------------------------------------------------------------------
# KB_MASTER_KEY — dev-setup and the runtimes refuse to start without one.
# Generate it once per project (canonical base64 of 32 random bytes, the shape
# scripts/lib/validate-kb-master-key.mjs requires), keep it 0600 next to the
# project's other local state, and export it for compose interpolation only.
# A caller-supplied KB_MASTER_KEY wins. The value is never printed.
# ---------------------------------------------------------------------------
ensure_kb_master_key() {
  local key_file="$AGENT_VOLUME_ROOT/kb-master-key" tmp
  if [ -n "${KB_MASTER_KEY:-}" ]; then
    echo "[dev-docker] KB_MASTER_KEY: using the value from the environment"
    return 0
  fi
  if [ ! -s "$key_file" ]; then
    mkdir -p "$AGENT_VOLUME_ROOT"
    tmp="$key_file.tmp.$$"
    (
      umask 077
      head -c 32 /dev/urandom | base64 | tr -d '\n' > "$tmp"
    )
    mv -f "$tmp" "$key_file"
    echo "[dev-docker] KB_MASTER_KEY: generated a per-project key in $key_file"
  fi
  chmod 600 "$key_file"
  KB_MASTER_KEY="$(cat "$key_file")"
  if [ "${#KB_MASTER_KEY}" -ne 44 ]; then
    echo "error: $key_file is not a base64 32-byte key; delete it to regenerate" >&2
    exit 1
  fi
  export KB_MASTER_KEY
}

# ---------------------------------------------------------------------------
# Port availability — allow the port if our own project already owns it
# ---------------------------------------------------------------------------
if dev_docker_port_in_use "$PORT"; then
  owner=$("$RUNTIME" ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" -q 2>/dev/null || true)
  if [ -z "$owner" ]; then
    echo "error: port $PORT is already in use by another process." >&2
    echo "       Pick a different port, or run: pnpm find-free-port" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Persist chosen port for agent discovery
# ---------------------------------------------------------------------------
cat > .agent-ports.json <<EOF_JSON
{
  "port": $PORT,
  "project": "$COMPOSE_PROJECT_NAME",
  "volumeRoot": "$AGENT_VOLUME_ROOT",
  "runtime": "$RUNTIME",
  "profile": "$PROFILE",
  "url": "http://localhost:$PORT",
  "mailpit": "http://localhost:$MAILPIT_PORT",
  "logs": "pnpm dev:docker:logs $PORT",
  "down": "pnpm dev:docker:down $PORT"
}
EOF_JSON

# ---------------------------------------------------------------------------
# Up
# ---------------------------------------------------------------------------
echo "[dev-docker] runtime=$RUNTIME  compose=\"$COMPOSE\"  project=$COMPOSE_PROJECT_NAME  profile=$PROFILE"
echo "[dev-docker] web will be reachable at: http://localhost:$PORT"
if [ "$BIND_ADDR" != "127.0.0.1" ] && [ "$BIND_ADDR" != "localhost" ]; then
  echo "[dev-docker] WARNING: BIND_ADDR=$BIND_ADDR — ports are published beyond" >&2
  echo "[dev-docker]          loopback. On a public host this exposes the dev" >&2
  echo "[dev-docker]          stack (and its default credentials) to the network." >&2
fi
echo "[dev-docker] tail logs: pnpm dev:docker:logs $PORT"
echo "[dev-docker] tear down: pnpm dev:docker:down $PORT"
echo

assert_volume_coverage
create_volume_dirs
ensure_kb_master_key

# The dev runtimes run pnpm as the host UID. pnpm must be complete in the
# image: pnpm 12 otherwise downloads its native binary on first use, which an
# arbitrary UID cannot write into the build-time toolchain dirs. Fail fast here,
# offline and as the runtime UID, instead of in dev-setup.
# shellcheck disable=SC2086
$COMPOSE -f "$COMPOSE_FILE" --profile "$PROFILE" build app-dev
# Offline, two probes of the built image as the runtime (host) UID, which may
# be root: usability (pnpm starts; store and $HOME writable) and immutability
# (no symlinked or foreign-owned toolchain path, no group/other write bit on
# it or any ancestor). The immutability rule does not depend on the caller.
for mode in usability immutability; do
  if ! "$RUNTIME" run --rm -i --network none --user "$HOST_UID:$HOST_GID" --entrypoint sh \
    "${COMPOSE_PROJECT_NAME}-dev-toolchain" -s "$mode" <"$ROOT_DIR/scripts/lib/dev-toolchain-check.sh"; then
    echo "[dev-docker] Dockerfile.dev: the pnpm toolchain failed the $mode probe." >&2
    echo "[dev-docker] It must be installed at build time, run offline, and stay root:root, not group/other writable." >&2
    exit 1
  fi
done

# shellcheck disable=SC2086
exec $COMPOSE -f "$COMPOSE_FILE" --profile "$PROFILE" up --build
