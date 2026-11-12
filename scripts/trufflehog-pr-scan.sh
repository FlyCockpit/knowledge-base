#!/usr/bin/env bash
# Scan the PR commit range with TruffleHog, then apply the exact template-placeholder
# filter. Fails closed on scanner errors, malformed JSON, or any non-exempt finding.
set -euo pipefail

BASE="${1:?base commit sha required}"
HEAD="${2:?head commit sha required}"
# v3.99.8
readonly TRUFFLEHOG_IMAGE="ghcr.io/trufflesecurity/trufflehog@sha256:674b2f187620a19df77f44cf9a7d77efcc581a5662accef2f2739cbb46ba4a3a"
readonly TRUFFLEHOG_FINDINGS_EXIT=183

# GitHub supplies immutable, full object IDs. Reject revision expressions,
# missing objects, and an empty commit range before the scanner runs: an exit-0
# scan with no reachable commits is not evidence that a PR is clean.
for commit in "$BASE" "$HEAD"; do
  if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::TruffleHog requires a full, lowercase 40-character commit SHA" >&2
    exit 1
  fi
  resolved="$(git rev-parse --verify --quiet "${commit}^{commit}" 2>/dev/null || true)"
  if [ "$resolved" != "$commit" ]; then
    echo "::error::TruffleHog commit is not an immutable, locally available commit object" >&2
    exit 1
  fi
done

commit_count="$(git rev-list --count "$BASE..$HEAD" 2>/dev/null || true)"
if ! [[ "$commit_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::TruffleHog commit range is empty or could not be enumerated" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if [ "${TRUFFLEHOG_WRAPPER_SELF_TEST:-}" != "1" ]; then
  node scripts/filter-trufflehog-results.mjs --cli-test
fi

# Keep every result class, including findings TruffleHog labels
# `filtered_unverified`. The post-filter below is the sole allowlist.
set +e
docker run --rm \
  -v "$PWD:/repo:ro" \
  -w /repo \
  "$TRUFFLEHOG_IMAGE" \
  git file:///repo \
  --since-commit "$BASE" \
  --branch "$HEAD" \
  --results=verified,unverified,unknown,filtered_unverified \
  --json \
  --no-update \
  --fail >"$tmp"
scan_status=$?
set -e

if ! [[ "$scan_status" =~ ^[0-9]+$ ]]; then
  echo "::error::TruffleHog scanner returned non-integer exit ${scan_status}" >&2
  exit 1
fi

if [ "$scan_status" -eq 0 ]; then
  node scripts/filter-trufflehog-results.mjs <"$tmp"
  exit $?
fi

if [ "$scan_status" -ne "$TRUFFLEHOG_FINDINGS_EXIT" ]; then
  echo "::error::TruffleHog scanner failed with operational exit ${scan_status}" >&2
  exit "$scan_status"
fi

if [ ! -s "$tmp" ]; then
  echo "::error::TruffleHog exit ${TRUFFLEHOG_FINDINGS_EXIT} with no findings output" >&2
  exit 1
fi

node scripts/filter-trufflehog-results.mjs <"$tmp"
