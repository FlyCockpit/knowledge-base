#!/usr/bin/env bash
# dev-tunnel.sh — expose the running dev web server through a Cloudflare quick
# tunnel (a random https://<name>.trycloudflare.com URL) so people outside the
# machine can try the development build. The intended caller is an AI agent
# acting for a nontechnical user who asked for "a link to try the app".
#
# Usage:
#   bash scripts/dev-tunnel.sh            # up (default): start the tunnel
#   bash scripts/dev-tunnel.sh status     # is a tunnel running? print its URL
#   bash scripts/dev-tunnel.sh url        # print just the URL (script-friendly)
#   bash scripts/dev-tunnel.sh down       # stop the tunnel
#
# Options for `up`:
#   --port N      target http://localhost:N (default 3001, the Vite dev port
#                 used by `pnpm dev:raw` / `pnpm -F web dev`)
#   --url URL     target an explicit origin instead (http or https)
#
# Quick tunnels are Cloudflare's free no-account mode: testing only, 200
# concurrent requests, and NO Server-Sent Events. The URL changes
# on every restart.
#
# State lives in tmp/dev-tunnel/ (gitignored): pid, log, url.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$ROOT/tmp/dev-tunnel"
PID_FILE="$STATE_DIR/cloudflared.pid"
LOG_FILE="$STATE_DIR/cloudflared.log"
URL_FILE="$STATE_DIR/url"
DEFAULT_PORT=3001
URL_WAIT_SECONDS=45

die() {
  echo "dev-tunnel: $*" >&2
  exit 1
}

cloudflared_install_hint() {
  # Only the non-root install commands are printed here; the Linux .deb install
  # needs root, and agent-owned scripts must not carry privileged commands —
  # the user runs that one themselves.
  cat <<'EOF'
cloudflared is not installed (it is a global machine tool, never a package.json
dependency). Ask the user to install it:

  macOS:    brew install cloudflared
  Windows:  winget install Cloudflare.cloudflared
  Linux:    install the cloudflared .deb package — it requires root, so
            print the command and let the user run it.

Then re-run: pnpm dev:tunnel
EOF
}

tunnel_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  if kill -0 "$pid" 2>/dev/null; then
    echo "$pid"
    return 0
  fi
  return 1
}

tunnel_url() {
  [[ -f "$URL_FILE" ]] || return 1
  local url
  url="$(cat "$URL_FILE" 2>/dev/null || true)"
  [[ -n "$url" ]] || return 1
  echo "$url"
}

cmd_status() {
  local pid url
  if pid="$(tunnel_pid)"; then
    url="$(tunnel_url || echo '<waiting — not established yet>')"
    echo "dev-tunnel: running (pid $pid)"
    echo "  url: $url"
    echo "  log: $LOG_FILE"
  else
    echo "dev-tunnel: not running"
    return 1
  fi
}

cmd_url() {
  local url
  url="$(tunnel_url)" || die "no tunnel URL on file — start one with: pnpm dev:tunnel"
  echo "$url"
}

cmd_down() {
  local pid
  if pid="$(tunnel_pid)"; then
    kill "$pid"
    # Wait briefly so the port is actually free when the command returns.
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    echo "dev-tunnel: stopped (was pid $pid)"
  else
    echo "dev-tunnel: not running"
  fi
  rm -f "$PID_FILE" "$URL_FILE"
}

cmd_up() {
  local target="http://localhost:$DEFAULT_PORT"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        [[ $# -ge 2 ]] || die "--port needs a value"
        target="http://localhost:$2"
        shift 2
        ;;
      --url)
        [[ $# -ge 2 ]] || die "--url needs a value"
        target="$2"
        shift 2
        ;;
      *)
        die "unknown option for \`up\`: $1 (expected --port N or --url URL)"
        ;;
    esac
  done

  command -v cloudflared >/dev/null 2>&1 || {
    cloudflared_install_hint >&2
    exit 1
  }

  # Idempotent for agents: an existing healthy tunnel is reused, not replaced
  # (a new one would rotate the URL the user may already have).
  local pid
  if pid="$(tunnel_pid)" && tunnel_url >/dev/null 2>&1; then
    echo "dev-tunnel: already running (pid $pid)"
    cmd_url
    exit 0
  fi
  cmd_down >/dev/null 2>&1 || true

  # Preflight: the dev server must answer on the target, or the tunnel will
  # happily serve 502s from a dead origin.
  if ! curl -fsS --max-time 3 -o /dev/null "$target" 2>/dev/null; then
    cat >&2 <<EOF
dev-tunnel: nothing is answering on $target.

Start the dev web server first, then re-run. Common layouts:
  pnpm dev:raw            web dev server on http://localhost:$DEFAULT_PORT
  pnpm -F web dev         same port, web app only
  pnpm dev                portless assigns each app its own PORT — find the
                          vite port (e.g. \`ss -ltnp | grep -E 'vite|node'\`)
                          and re-run with: pnpm dev:tunnel --port <N>
EOF
    exit 1
  fi

  mkdir -p "$STATE_DIR"
  : >"$LOG_FILE"
  # --no-autoupdate: a backgrounded updater can restart the binary out from
  # under the pid we are tracking, rotating the URL without warning.
  nohup cloudflared tunnel --url "$target" --no-autoupdate >"$LOG_FILE" 2>&1 &
  local new_pid=$!
  echo "$new_pid" >"$PID_FILE"

  # cloudflared prints the assigned URL in its startup banner (stderr, which
  # the redirect above captured). Poll for it instead of sleeping blind.
  local waited=0 url=""
  while (( waited < URL_WAIT_SECONDS )); do
    if ! kill -0 "$new_pid" 2>/dev/null; then
      echo "dev-tunnel: cloudflared exited early — last log lines:" >&2
      tail -n 15 "$LOG_FILE" >&2
      rm -f "$PID_FILE" "$URL_FILE"
      exit 1
    fi
    url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)"
    [[ -n "$url" ]] && break
    sleep 1
    waited=$((waited + 1))
  done

  if [[ -z "$url" ]]; then
    echo "dev-tunnel: no URL appeared after ${URL_WAIT_SECONDS}s — last log lines:" >&2
    tail -n 15 "$LOG_FILE" >&2
    rm -f "$PID_FILE" "$URL_FILE"
    exit 1
  fi

  echo "$url" >"$URL_FILE"
  echo "dev-tunnel: $url"
  echo "  → proxies to $target (stop with: pnpm dev:tunnel down)"
  echo "  → quick-tunnel limits: 200 concurrent requests, NO Server-Sent Events"
  echo "    (Server-Sent Events will not work through this URL), URL rotates on restart."
  echo "  → anyone with this URL reaches the dev build and its dev database."
}

case "${1:-up}" in
  up)
    shift $(( $# > 0 ? 1 : 0 ))
    cmd_up "$@"
    ;;
  down)
    cmd_down
    ;;
  status)
    cmd_status
    ;;
  url)
    cmd_url
    ;;
  help | -h | --help)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    die "unknown command: $1 (expected up | down | status | url)"
    ;;
esac
