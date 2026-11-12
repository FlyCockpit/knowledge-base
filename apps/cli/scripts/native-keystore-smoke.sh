#!/usr/bin/env bash
# Disposable native store; no real credentials. Never run against a user keychain.
set -euo pipefail
if [[ $(uname -s) == Linux && ${1:-} != --inside ]]; then
  command -v dbus-run-session >/dev/null
  command -v gnome-keyring-daemon >/dev/null
  exec timeout 120s dbus-run-session -- bash "$0" --inside
fi
scratch=$(mktemp -d "${TMPDIR:?}/kb-native-smoke.XXXXXX")
service_pid=
original_keychain=
cleanup() {
  if [[ -n "$service_pid" ]]; then kill -CONT "$service_pid" 2>/dev/null || true; kill "$service_pid" 2>/dev/null || true; wait "$service_pid" 2>/dev/null || true; fi
  if [[ -n "$original_keychain" ]]; then
    security default-keychain -d user -s "$original_keychain"
    security delete-keychain "$scratch/smoke.keychain-db"
  fi
  # Only this script's private mktemp directory.
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$scratch"
}
trap cleanup EXIT
if [[ $(uname -s) == Linux ]]; then
  export XDG_RUNTIME_DIR="$scratch/runtime" XDG_DATA_HOME="$scratch/data" XDG_CONFIG_HOME="$scratch/config"
  mkdir -m 700 "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$scratch/control"
  printf '%s' disposable-native-smoke | gnome-keyring-daemon --foreground --unlock --components=secrets --control-directory "$scratch/control" >"$scratch/service.log" 2>&1 &
  service_pid=$!
  export KB_TEST_SECRET_SERVICE_PID="$service_pid"
  # Query the bus itself without activating any fallback daemon. Only the
  # foreground service with these owned XDG paths may satisfy readiness.
  ready=false
  for _ in {1..100}; do
    kill -0 "$service_pid"
    owner=$(dbus-send --session --type=method_call --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets)
    if [[ "$owner" == *"boolean true"* ]]; then ready=true; break; fi
    sleep 0.1
  done
  [[ "$ready" == true ]]
else
  original_keychain=$(security default-keychain -d user | tr -d '"' | xargs)
  security create-keychain -p disposable-smoke "$scratch/smoke.keychain-db"
  security unlock-keychain -p disposable-smoke "$scratch/smoke.keychain-db"
  security default-keychain -d user -s "$scratch/smoke.keychain-db"
fi
cargo build -p kb --locked
cargo test -p kb-local --test providers actual_native_ --locked -- --ignored --test-threads=1 --nocapture
