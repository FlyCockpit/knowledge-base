#!/usr/bin/env bash
# image-smoke.sh — build the production images and smoke them behind HTTPS.
#
# Usage: pnpm smoke:image [port]        (default port 3443, loopback only)
#
# Builds Dockerfile + Dockerfile.worker (unless SMOKE_SERVER_IMAGE and
# SMOKE_WORKER_IMAGE name prebuilt images), runs them with NODE_ENV=production
# plus postgres/redis/mailpit and a Caddy `tls internal` front
# (docker-compose.image-smoke.yml), and asserts:
#   a. GET /en-US is 200 with server-rendered content and GET /en-US/login
#      (a client-rendered route) is 200 with the app shell; neither renders
#      the root error page
#   b. every bare import in apps/web/dist/server, apps/server/dist (server
#      image) and apps/worker/dist (worker image) resolves from its importing
#      directory inside the running image
#   c. OAuth dynamic client registration (public native client, loopback
#      redirect) returns 201
#   d. an unauthenticated MCP POST /mcp is 401 with a resource_metadata
#      challenge
#   e. an OAuth bearer at /mcp is verified against the in-process signing keys:
#      the server cannot reach its own public origin in this graph, so a
#      self-fetch of the JWKS would answer 503; a forged token must get 401
#      and the server must log no signing-key outage
#   f-h. with the public origin proven unreachable from inside the server
#      container: sign up (mailpit verification) → sign in → create a KB, then
#      a PAT minted through oRPC and an OAuth token (DCR → authorize + PKCE →
#      consent procedures → code → token) each get MCP tools/list 200 with the
#      read tools (scripts/image-smoke-flows.mjs)
# Always tears the graph down with `down -v` and removes only images it built.
# Secrets are generated per run and never printed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/dev-docker-runtime.sh
. "$SCRIPT_DIR/lib/dev-docker-runtime.sh"

PORT="${1:-3443}"
case "$PORT" in
  ''|*[!0-9]*) echo "error: port must be numeric, got: $PORT" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "error: port must be between 1024 and 65535" >&2
  exit 1
fi
if dev_docker_port_in_use "$PORT"; then
  echo "error: port $PORT is already in use; pass another: pnpm smoke:image <port>" >&2
  exit 1
fi
for tool in curl node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 1; }
done

RUNTIME=$(dev_docker_detect_runtime)
COMPOSE=$(dev_docker_pick_compose "$RUNTIME")
cd "$ROOT_DIR"

RUN_ID="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export COMPOSE_PROJECT_NAME="kb-image-smoke-$RUN_ID"
export SMOKE_PORT="$PORT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/kb-image-smoke.XXXXXX")"
BUILT_IMAGES=()
FAILED=0
ORIGIN="https://localhost:$PORT"

log() { printf '[image-smoke] %s\n' "$*"; }
pass() { printf '[image-smoke] PASS %s\n' "$*"; }
fail() { printf '[image-smoke] FAIL %s\n' "$*" >&2; FAILED=1; }
compose() {
  # shellcheck disable=SC2086
  $COMPOSE -f docker-compose.image-smoke.yml "$@"
}

cleanup() {
  local status=$?
  if [ "$FAILED" != 0 ] || [ "$status" != 0 ]; then
    log "server/worker logs (tail):"
    compose logs --no-color --tail 60 server worker 2>&1 | sed 's/^/    /' >&2 || true
  fi
  log "tearing down $COMPOSE_PROJECT_NAME"
  compose down -v --remove-orphans --timeout 10 >/dev/null 2>&1 || true
  if [ "${#BUILT_IMAGES[@]}" -gt 0 ]; then
    "$RUNTIME" image rm "${BUILT_IMAGES[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Disposable per-run secrets, only ever in this process's environment.
KB_MASTER_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
BETTER_AUTH_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')"
export KB_MASTER_KEY BETTER_AUTH_SECRET

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------
build_image() {
  local dockerfile="$1" tag="$2"
  log "building $tag from $dockerfile"
  "$RUNTIME" build -f "$dockerfile" -t "$tag" . >"$WORK/build-$(basename "$dockerfile").log" 2>&1 || {
    tail -40 "$WORK/build-$(basename "$dockerfile").log" >&2
    echo "error: $dockerfile build failed" >&2
    exit 1
  }
  BUILT_IMAGES+=("$tag")
}
if [ -n "${SMOKE_SERVER_IMAGE:-}" ] && [ -n "${SMOKE_WORKER_IMAGE:-}" ]; then
  log "using prebuilt images $SMOKE_SERVER_IMAGE and $SMOKE_WORKER_IMAGE"
else
  export SMOKE_SERVER_IMAGE="kb-image-smoke-server:$RUN_ID"
  export SMOKE_WORKER_IMAGE="kb-image-smoke-worker:$RUN_ID"
  build_image Dockerfile "$SMOKE_SERVER_IMAGE"
  build_image Dockerfile.worker "$SMOKE_WORKER_IMAGE"
fi

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
log "starting $COMPOSE_PROJECT_NAME on $ORIGIN"
compose up -d --quiet-pull >"$WORK/up.log" 2>&1 || { cat "$WORK/up.log" >&2; exit 1; }

CA="$WORK/caddy-root.crt"
deadline=$((SECONDS + 600))
until compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$CA" >/dev/null 2>&1 &&
  [ "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA" "$ORIGIN/ready" || true)" = 200 ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "error: $ORIGIN/ready did not become 200 within 600s" >&2
    exit 1
  fi
  for service in server worker; do
    if [ "$(compose ps -a --format '{{.State}}' "$service" 2>/dev/null)" = exited ]; then
      echo "error: $service exited during startup" >&2
      exit 1
    fi
  done
  sleep 3
done
pass "server and worker ready behind HTTPS ($ORIGIN/ready)"

req() { curl -sS --cacert "$CA" --max-time 30 "$@"; }

# a. SSR: the public index is server-rendered; the login route is
#    client-rendered by design (`/$lang/_app` has `ssr: false`), so its SSR
#    response must be the working app shell. Neither may be the root error page.
error_page() { grep -Eq "didn(&#x27;|&#39;|')t load|Something went wrong" "$1"; }
status="$(req -o "$WORK/index.html" -w '%{http_code}' "$ORIGIN/en-US")"
if [ "$status" = 200 ] && grep -q '<h1' "$WORK/index.html" && ! error_page "$WORK/index.html"; then
  pass "a. GET /en-US 200 with server-rendered content"
else
  fail "a. GET /en-US: status $status, no SSR'd heading or error page rendered"
fi
status="$(req -o "$WORK/login.html" -w '%{http_code}' "$ORIGIN/en-US/login")"
if [ "$status" = 200 ] && grep -q '<script type="module"' "$WORK/login.html" &&
  ! error_page "$WORK/login.html"; then
  pass "a. GET /en-US/login 200 with the client app shell (login is ssr:false)"
else
  fail "a. GET /en-US/login: status $status, missing app shell or error page rendered"
fi

# b. bare-import resolution inside the running images
resolve_in() {
  local service="$1" label="$2" result
  shift 2
  if result="$(compose exec -T "$service" node --no-warnings --experimental-vm-modules \
    --experimental-import-meta-resolve --input-type=module - "$@" <scripts/image-smoke-resolve.mjs)"; then
    pass "b. $label: every bare import resolves ($result)"
  else
    fail "b. $label: unresolved bare imports: $result"
  fi
}
resolve_in server "server image (web SSR + server dist)" /app/apps/web/dist/server /app/apps/server/dist
resolve_in worker "worker image (worker dist)" /app/apps/worker/dist

# The mirror helper answers on its dedicated reply descriptor (fd 3), never on
# stdout/stderr or the logger. An invalid sha fails before any network use.
# stdin stays open after GO: its EOF is the parent's cancellation signal.
reply="$(compose exec -T worker sh -c '
  dir=$(mktemp -d /run/kb-mirror/smoke-XXXXXX) &&
  printf "{\"dir\":\"%s\",\"repo\":\"%s\",\"sha\":\"x\",\"timeoutMs\":5000}" "$dir" "$dir" >"$dir/config.json" &&
  { printf GO; sleep 3; } | node /app/apps/worker/dist/ssh-wrapper.mjs --run "$dir/config.json" 3>&1 1>/dev/null 2>/dev/null
  status=$?; rm -rf "$dir"; exit $status' 2>&1)"
if [ "$reply" = "FAILED TRANSPORT_UNAVAILABLE" ]; then
  pass "b. worker image mirror helper replies on its dedicated descriptor ($reply)"
else
  fail "b. worker image mirror helper reply: '$reply'"
fi

# c. OAuth dynamic client registration
status="$(req -o "$WORK/dcr.json" -w '%{http_code}' -X POST "$ORIGIN/api/auth/oauth2/register" \
  -H 'content-type: application/json' \
  --data '{"client_name":"image smoke","redirect_uris":["http://127.0.0.1:53682/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"],"application_type":"native"}')"
if [ "$status" = 201 ] && grep -q '"client_id"' "$WORK/dcr.json"; then
  pass "c. POST /api/auth/oauth2/register 201 (public native client, loopback redirect)"
else
  fail "c. POST /api/auth/oauth2/register: status $status"
fi

# d. unauthenticated MCP request
MCP_BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"image-smoke","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
status="$(req -o /dev/null -D "$WORK/mcp-anon.headers" -w '%{http_code}' -X POST "$ORIGIN/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-method: tools/list' -H 'mcp-protocol-version: 2026-07-28' --data "$MCP_BODY")"
if [ "$status" = 401 ] &&
  grep -iq "^www-authenticate: Bearer resource_metadata=\"$ORIGIN/.well-known/oauth-protected-resource/mcp\"" "$WORK/mcp-anon.headers"; then
  pass "d. unauthenticated POST /mcp 401 with a resource_metadata challenge"
else
  fail "d. unauthenticated POST /mcp: status $status or missing WWW-Authenticate challenge"
fi

# e. OAuth bearer verification uses in-process keys (no hairpin to $ORIGIN)
FORGED="$(ORIGIN="$ORIGIN" node -e '
const { generateKeyPairSync, sign } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const o = process.env.ORIGIN;
const part = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const msg = part({ alg: "RS256", kid: "image-smoke-forged", typ: "JWT" }) + "." +
  part({ iss: o + "/api/auth", aud: o + "/mcp", sub: "smoke", client_id: "smoke",
         exp: Math.floor(Date.now() / 1000) + 600 });
process.stdout.write(msg + "." + sign("RSA-SHA256", Buffer.from(msg), privateKey).toString("base64url"));
')"
status="$(req -o "$WORK/mcp-forged.json" -w '%{http_code}' -X POST "$ORIGIN/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-method: tools/list' -H 'mcp-protocol-version: 2026-07-28' -H "authorization: Bearer $FORGED" --data "$MCP_BODY")"
keys="$(req "$ORIGIN/api/auth/jwks" | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).keys.length)}catch{console.log(0)}})')"
if [ "$status" = 401 ] && [ "$keys" -ge 1 ] &&
  ! compose logs --no-color server 2>&1 | grep -q 'signing-key service unavailable'; then
  pass "e. OAuth bearer verified against in-process signing keys ($keys key(s)); forged token 401, no hairpin fetch"
else
  fail "e. OAuth bearer at /mcp: status $status ($(head -c 200 "$WORK/mcp-forged.json")), jwks keys $keys"
fi

# f-h. authenticated flows, while the server cannot reach its public origin:
# any self-fetch of keys would fail, so a 200 proves in-process verification.
if compose exec -T server node -e "
  fetch(process.argv[1], { signal: AbortSignal.timeout(5000) })
    .then(() => process.exit(1), () => process.exit(0))" "$ORIGIN/health"; then
  pass "public origin $ORIGIN is unreachable from inside the server container"
else
  fail "the server container can reach $ORIGIN; the OAuth checks would not prove in-process keys"
fi
MAILPIT_URL="http://$(compose port mailpit 8025)"
if NODE_EXTRA_CA_CERTS="$CA" SMOKE_ORIGIN="$ORIGIN" SMOKE_MAILPIT="$MAILPIT_URL" \
  node scripts/image-smoke-flows.mjs >"$WORK/flows.log" 2>&1; then
  flows_ok=1
else
  flows_ok=0
fi
while IFS= read -r line; do
  case "$line" in
    PASS\ *) pass "${line#PASS }" ;;
    FAIL\ *) fail "${line#FAIL }" ;;
    *) log "  $line" ;;
  esac
done <"$WORK/flows.log"
[ "$flows_ok" = 1 ] || fail "authenticated flows did not complete"
if compose logs --no-color server 2>&1 | grep -q 'signing-key service unavailable'; then
  fail "server logged a signing-key outage during the authenticated flows"
fi

if [ "$FAILED" != 0 ]; then
  log "image smoke FAILED"
  exit 1
fi
log "image smoke passed"
