#!/bin/sh
# dev-toolchain-check.sh <usability|immutability> — the AUTHORITATIVE pnpm
# toolchain check. scripts/dev-docker.sh pipes it to `sh -s <mode>` inside the
# built dev image with no network. The Dockerfile lint
# (scripts/lib/dockerfile-pnpm.ts) is only a convenience guard; this inspects
# the real file tree.
#
# usability (run as the runtime/host UID, which may be root):
#   pnpm starts offline, and the store and $HOME are writable.
#
# immutability (any UID; the rule does not depend on who asks): the toolchain
# is immutable by construction for every non-root runtime UID/GID because
#   - there is no indirection: every component of $PNPM_HOME, $COREPACK_HOME
#     and each shim target (as written, never normalized), and every path
#     inside those trees, is a real directory or file. The only symlinks allowed are pnpm's own corepack
#     shims ($PNPM_HOME/pnpm, $PNPM_HOME/pnpx), each one hop to a real file
#     that satisfies these rules, as does that file's package tree;
#   - Corepack's npm global install is checked through the shim targets too;
#     no bundled Corepack location or runtime npm command is required;
#   - everything in those trees (the store excepted) and every ancestor up to
#     / is owned by uid 0 and gid 0 with no group or other write bit;
#   - fail closed: any find/stat/readlink error (an unreadable directory
#     included) fails the check;
#   - the same holds for the node binary the shims run, its directory and
#     ancestors, and every PATH directory searched before it.
#
# TOOLCHAIN_UID / TOOLCHAIN_GID / TOOLCHAIN_ANCESTOR_STOP exist for the host
# tests only (a fixture cannot be root-owned there); dev-docker.sh never sets them.
set -u
mode="${1:-}"
store="$PNPM_HOME/store"

case "$mode" in
usability)
  uid=$(id -u)
  pnpm --version >/dev/null || { echo "pnpm does not run offline as UID $uid" >&2; exit 1; }
  [ -w "$store" ] || { echo "pnpm store $store is not writable by UID $uid" >&2; exit 1; }
  [ -w "$HOME" ] || { echo "HOME $HOME is not writable by UID $uid" >&2; exit 1; }
  exit 0
  ;;
immutability) ;;
*)
  echo "usage: dev-toolchain-check.sh usability|immutability" >&2
  exit 2
  ;;
esac

want_uid="${TOOLCHAIN_UID:-0}"
want_gid="${TOOLCHAIN_GID:-0}"
stop="${TOOLCHAIN_ANCESTOR_STOP:-/}"
bad=""
note() {
  bad="$bad
$1"
}

# uid/gid and no group/other write bit on one non-symlink path.
check_bits() {
  set -- "$1" $(stat -c '%u %g %a' "$1" 2>/dev/null)
  [ $# -eq 4 ] || { note "$1 (unreadable)"; return; }
  [ "$2" = "$want_uid" ] && [ "$3" = "$want_gid" ] || note "$1 (owned by $2:$3)"
  [ $((0$4 & 022)) -eq 0 ] || note "$1 (mode $4: group/other writable)"
}

# Every component of $1 exactly as written (no normalization), from / down:
# a real directory or file with safe bits. A `..` step is only taken from an
# already-checked real directory, so it lands on its real (checked) parent.
check_components() {
  case "$1" in /*) ;; *) note "$1 (not absolute)"; return ;; esac
  # The walk below splits on "/" only if nothing else can split or expand:
  # whitespace, glob or other shell-special characters are refused outright.
  case "$1" in *[!A-Za-z0-9._/+@-]*) note "$1 (unsupported character in a toolchain path)"; return ;; esac
  path=""
  for part in $(printf '%s' "$1" | tr '/' ' '); do
    [ "$part" = . ] && { note "$1 (contains a . component)"; return; }
    path="$path/$part"
    if [ -L "$path" ]; then
      note "$path (symlink in a toolchain path)"
      return
    fi
    case "$stop/" in "$path"/*) continue ;; esac
    check_bits "$path"
  done
  [ "$stop" = / ] && check_bits /
}

# A whole tree: no symlinks except the allowed shims, safe bits everywhere.
check_tree() {
  tree="$1"
  shift
  # Fail closed: an incomplete traversal (unreadable directory, I/O error) fails.
  links=$(find "$tree" -path "$store" -prune -o -type l -print 2>&1) || {
    note "$tree (traversal failed: $(printf '%s' "$links" | head -1))"
    return
  }
  for link in $links; do
    allowed=no
    for shim in "$@"; do [ "$link" = "$shim" ] && allowed=yes; done
    [ "$allowed" = yes ] || note "$link (symlink inside the toolchain)"
  done
  found=$(find "$tree" -path "$store" -prune -o ! -type l \( ! -user "$want_uid" -o ! -group "$want_gid" -o -perm /022 \) -print 2>&1) || {
    note "$tree (traversal failed: $(printf '%s' "$found" | head -1))"
    return
  }
  for path in $found; do
    note "$path (not $want_uid:$want_gid, or group/other writable)"
  done
}

shims="$PNPM_HOME/pnpm $PNPM_HOME/pnpx"
for root in "$PNPM_HOME" "$COREPACK_HOME"; do
  check_components "$root"
  # shellcheck disable=SC2086
  [ -d "$root" ] && check_tree "$root" $shims
done
for shim in $shims; do
  [ -e "$shim" ] || [ -L "$shim" ] || continue
  [ -L "$shim" ] || { note "$shim (shim is not a symlink)"; continue; }
  target=$(readlink "$shim") || { note "$shim (unreadable link)"; continue; }
  # Corepack writes relative shims (../usr/local/...): anchor at the shim's
  # directory and walk the components as written, never normalized.
  case "$target" in /*) ;; *) target="$PNPM_HOME/$target" ;; esac
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    note "$shim -> $target (shim target is not a real file)"
    continue
  fi
  check_components "$target"
  # The npm-installed Corepack package: <global-prefix>/lib/node_modules/corepack/
  # dist/<shim>.js. Check its whole tree, including dist/lib/corepack.cjs,
  # outside the runtime-writable HOME and pnpm store.
  check_tree "$(dirname "$(dirname "$target")")"
done

# Node runs every pnpm entry point (the shims are `#!/usr/bin/env node`), so
# the node binary PATH resolves is part of the toolchain: the binary itself,
# its directory and every ancestor, and every PATH directory searched before
# it (a writable one could shadow node). A missing PATH directory is safe
# exactly when its parent is.
node_bin=$(command -v node 2>/dev/null) || node_bin=""
case "$node_bin" in
/*)
  node_dir=$(dirname "$node_bin")
  old_ifs=$IFS
  IFS=:
  set -f
  # shellcheck disable=SC2086
  set -- $PATH
  set +f
  IFS=$old_ifs
  for entry in "$@"; do
    if [ -z "$entry" ]; then
      note "PATH has an empty entry (the working directory) before node"
    elif [ -e "$entry" ] || [ -L "$entry" ]; then
      check_components "$entry"
    else
      check_components "$(dirname "$entry")"
    fi
    [ "$entry" = "$node_dir" ] && break
  done
  check_components "$node_bin"
  ;;
*) note "node (not found on PATH as an absolute path: '$node_bin')" ;;
esac

bad=$(printf '%s\n' "$bad" | sed '/^$/d' | sort -u)
if [ -n "$bad" ]; then
  echo "pnpm toolchain is not immutable (symlinked, foreign-owned or group/other writable):" >&2
  printf '%s\n' "$bad" | head -20 >&2
  exit 1
fi
