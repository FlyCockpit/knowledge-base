#!/usr/bin/env bash
# Claude Code PreToolUse entry. The rules live in pre-tool-use.mjs (next to this
# file) so they are testable; this wrapper only locates Node and fails closed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "BLOCKED: scripts/claude-hooks/pre-tool-use.sh needs Node.js to vet this tool call and none was found on PATH." >&2
  echo "         Install Node — the safety hook fails closed without it." >&2
  exit 2
fi

node "$HERE/pre-tool-use.mjs"
exit_code=$?
if [ "$exit_code" -ne 0 ]; then
  exit 2
fi
exit 0
