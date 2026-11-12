#!/usr/bin/env bash
# Four shell owners use separate descriptors: lock operation 7, backup 8,
# restore writer 9, backup writer 6. PIDs are used only by Bash's cached wait.
# The private FIFO is opened before fork; even a completed/reaped supervisor
# receives only bytes on its original channel, never a numeric-PID signal.
OWNED_CHILD_SUPERVISOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bounded-child.mjs"

owned_child_run() {
  local channel="$1" descriptor="$2" mode="$3"
  shift 3
  local cooperative=""
  [ "$mode" != cooperative ] || cooperative=--cooperative
  exec node "$OWNED_CHILD_SUPERVISOR" --control "$channel" "$descriptor" ${cooperative:+"$cooperative"} "$@"
}

owned_child_open() {
  local channel="$1" descriptor="$2"
  case "$descriptor" in 6 | 7 | 8 | 9) ;; *) return 1 ;; esac
  owned_child_drained[$descriptor]=""
  mkfifo "$channel" || return $?
  # O_RDWR avoids blocking before the reader starts and avoids SIGPIPE after
  # it exits. The supervisor closes this inherited descriptor before spawning.
  eval 'exec '"$descriptor"'<>"$channel"'
}

owned_child_cancel() {
  local descriptor="$1"
  case "$descriptor" in 6 | 7 | 8 | 9) ;; *) return 1 ;; esac
  # Closing the sole write peer is also cancellation, including a failed write.
  eval 'printf x >&'"$descriptor" 2>/dev/null || true
  eval 'exec '"$descriptor"'>&-'
}

owned_child_wait() {
  local channel="$1" descriptor="$2" child_pid="$3" status=0
  if wait "$child_pid"; then :; else status=$?; fi
  # A trap may interrupt wait before the child closes. Its drain handler runs
  # another wait before returning; the status is cached and safe to read again.
  case "$descriptor" in 6 | 7 | 8 | 9) ;; *) return 1 ;; esac
  eval 'exec '"$descriptor"'>&-'
  if [ -f "$channel.drained" ]; then
    owned_child_drained[$descriptor]="$channel"
  elif [ "${owned_child_drained[$descriptor]:-}" != "$channel" ]; then
    echo "FATAL: child drain was not acknowledged; retain its artifacts and inspect the stopped job before recovery." >&2
    return 125
  fi
  return "$status"
}

owned_child_clear() {
  local channel="$1"
  [ -z "$channel" ] && return 0
  [ -f "$channel.drained" ] || return 125
  rm -f "$channel" "$channel.drained"
}
