#!/usr/bin/env bash
# Project policy checks — grep-based guardrails for things the Rust compiler and
# clippy can't catch. Mirrors the "Agent safety rules" in AGENTS.md so they're
# enforced by CI, not just trusted.
#
# Run locally: bash scripts/policy-checks.sh
# Add a rule: append a `check` call. Keep each rule fast and false-positive-free.

set -euo pipefail

fail=0

# Where to look. We scan tracked source/config, not build output or git
# internals. The CLI workflows live at the repo root, outside this directory.
SCAN_DIRS=(src xtask/src tests scripts docs)

# check <regex> <human message>
# Fails if the (extended) regex matches anywhere in SCAN_DIRS.
check() {
  local pattern="$1" message="$2"
  # -I skips binary files; -n shows line numbers; || true so no-match isn't an error.
  local hits
  hits="$(grep -rInE \
    --include='*.rs' --include='*.sh' --include='*.yml' --include='*.toml' \
    --include='*.md' --include='*.json' \
    --exclude='policy-checks.sh' \
    -- "$pattern" "${SCAN_DIRS[@]}" 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    echo "POLICY VIOLATION: $message"
    echo "$hits"
    echo
    fail=1
  fi
}

# 1. Never bypass git hooks.
check '--no-verify' 'do not bypass commit hooks (--no-verify). See AGENTS.md.'

# 2. No debugging macros left in the tree (clippy also catches dbg! in crate code;
#    this also covers scripts/workflows and is a fast belt-and-suspenders).
check 'dbg!\(' 'remove dbg!() before committing.'

# 3. No obvious committed secrets.
check 'BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY' 'a private key appears to be committed — remove and rotate it.'
check 'AKIA[0-9A-Z]{16}' 'an AWS access key id appears to be committed — remove and rotate it.'

# 4. Don't disable the unsafe ban without discussion.
check 'allow\(unsafe_code\)' 'unsafe is forbidden project-wide; do not allow it locally without sign-off.'

if [[ "$fail" -ne 0 ]]; then
  echo "policy checks failed."
  exit 1
fi
echo "policy checks passed."
