#!/usr/bin/env bash
# Project policy checks — grep-based guardrails for things the compiler and
# linters can't catch. Mirrors the Agent Safety Rules in AGENTS.md so they're
# enforced by CI and lefthook, not just trusted.
#
# Run locally:  bash scripts/policy-checks.sh
# Self-test:    bash scripts/policy-checks.sh --self-test
# Add a rule:   append a `check` / `check_filtered` call. Keep each rule fast
#               and false-positive-free. A missing scan root is a HARD failure
#               (fail closed): patterns/removable/* deletes subtrees, and a
#               silent pass on a missing directory would disable the rule.

set -euo pipefail

# Compatibility contract: this script runs on macOS's stock bash 3.2 — the
# pre-commit hook (lefthook) finds it through `#!/usr/bin/env bash`, which
# resolves to /bin/bash there. Do not reach for the bash-4-only bulk-read
# builtins, associative arrays, or the advanced case-terminator / pipe-stderr
# operators; the --self-test scans this file for them so an incompatible
# addition fails loudly instead of dying mid-commit on a Mac.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0

# -- helpers ----------------------------------------------------------------

assert_root() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "POLICY CHECKS FAIL CLOSED: required scan root missing: $dir" >&2
    echo "If you removed this tree via patterns/removable/*, update scripts/policy-checks.sh in the same change." >&2
    return 1
  fi
  return 0
}

assert_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "POLICY CHECKS FAIL CLOSED: required file or exemption is missing (stale path): $file" >&2
    echo "Update the full path in scripts/policy-checks.sh in the same change." >&2
    return 1
  fi
  return 0
}

require_root() {
  assert_root "$1" || exit 1
}

require_file() {
  assert_file "$1" || exit 1
}

# Print matches (if any) from grep. Never exits non-zero on "no match".
# Callers must have asserted scan roots so a missing directory cannot look like
# a clean pass.
run_grep() {
  grep "$@" 2>/dev/null || true
}

report() {
  local message="$1"
  local hits="$2"
  if [[ -n "$hits" ]]; then
    echo "POLICY VIOLATION: $message"
    echo "$hits"
    echo
    fail=1
  fi
}


# Whole-context marker proof. The structural scanner reads the complete source
# file and accepts only finite, explicitly inert AST carriers. YAML/JSON and
# unknown source carriers fail closed; this wrapper intentionally does not try
# to prove arbitrary program dataflow from a matching line.
destructive_context() {
  local path="$1" line="$2" lineno="$3" context
  if ! context="$(node scripts/check-destructive-operations.mjs --audited-context "$path" "$lineno")"; then
    echo "POLICY CHECKS FAIL CLOSED: cannot establish audited destructive context for $path:$lineno." >&2
    return 1
  fi
  if [[ "$context" != mention && "$context" != live ]]; then
    echo "POLICY CHECKS FAIL CLOSED: destructive context classifier returned an invalid result for $path:$lineno." >&2
    return 1
  fi
  printf '%s\n' "$context"
}

# Drop destructive-pattern hits carrying a `destructive:audited — <why>` marker
# on the same line, or on a comment-only line immediately above (the same escape
# hatch shape as `pagination:audited`). It is a narrow, scanner-proven inert
# exception, not a generic approval for a help, error, or deny-list string.
# Prefer comments or non-command wording when explaining a prohibition; if a
# legitimate message is rejected, reword it rather than weaken this gate.
# In Bash, the only display form supported here is a complete-source,
# program-root `echo` or exact `printf '%s\n'` command. Captures, redirects,
# pipelines, siblings, functions, subshells, controls, assignments,
# configuration, and unknown carriers remain live.
#
# It does NOT weaken detection. The marker is honored ONLY when the match itself
# is a mention — inside a `#` / `//` comment or a quoted string on that line, per
# destructive_context() above. A marked command in command position (a marker
# above a live `prisma db push --force-reset`, a trailing marker after a live
# `psql -c "DROP TABLE …"`) is still reported, with a line saying so.
filter_destructive_audited() {
  local hits="$1"
  if [[ -z "$hits" ]]; then
    return 0
  fi
  local hit path rest lineno text prev marked
  while IFS= read -r hit; do
    if [[ -z "$hit" ]]; then
      continue
    fi
    path="${hit%%:*}"
    rest="${hit#*:}"
    lineno="${rest%%:*}"
    text="${rest#*:}"
    marked=0
    if [[ "$text" == *destructive:audited* ]]; then
      marked=1
    elif [[ "$lineno" =~ ^[0-9]+$ ]] && ((lineno > 1)) && [[ -f "$path" ]]; then
      prev="$(sed -n "$((lineno - 1))p" "$path")"
      # Comment-only previous line: a marker trailing another command does not
      # reach down to the next one.
      if [[ "$prev" == *destructive:audited* && "$prev" =~ ^[[:space:]]*(#|//|\*|/\*) ]]; then
        marked=1
      fi
    fi
    if ((marked == 0)); then
      printf '%s\n' "$hit"
      continue
    fi
    # A line whose value is part of a reviewed operation is never just a
    # mention. In particular, a later shell expansion can consume an assigned
    # flag, so a trailing marker must not turn a duplicated manifest line into
    # an arbitrary bypass.
    if is_reviewed_destructive_line "$path" "$text"; then
      printf '%s\n' "$hit"
      continue
    fi
    local context
    if ! context="$(destructive_context "$path" "$text" "$lineno")"; then
      # Keep the original finding in stdout *and* fail the filter. A failed
      # helper must never look like an exempted mention merely because command
      # substitution produced no output.
      printf '%s\n' "$hit"
      return 1
    fi
    if [[ "$context" == live ]]; then
      printf '%s\n' "$hit"
      printf '%s\n' "    ^ the marker only covers a MENTION (in a comment or a quoted string) — this line runs the command."
    fi
  done <<<"$hits"
}

# Hash and line comments consume the entire line. Block comments deliberately
# do not get this shortcut: `/* note */ db.$executeRawUnsafe(...)` has live
# code after the comment and must remain visible to the scanner.
filter_destructive_comments() {
  local hits="$1"
  [[ -z "$hits" ]] && return 0
  awk -F: '
    {
      text = $0
      sub(/^[^:]*:[0-9]+:/, "", text)
      if (text ~ /^[[:space:]]*(#|\/\/)/) next
      if ($1 ~ /\.sql$/ && text ~ /^[[:space:]]*--/) next
      if (text ~ /^[[:space:]]*--[[:space:]]/) next
      if (text ~ /^[[:space:]]*\*[^/]/) next
      if (text ~ /^[[:space:]]*\/\*[^*]/) {
        if (text !~ /\*\//) next
        remainder = text
        sub(/^[[:space:]]*\/\*.*\*\//, "", remainder)
        if (remainder ~ /^[[:space:]]*$/) next
      }
      print
    }
  ' <<<"$hits"
}

# The only live destructive operations this repository currently ships. Each
# entry pins the path, the SHA-256 of the complete source line, and how often
# that exact line may occur. This is intentionally hand-maintained: deriving
# it from the working tree at gate time would bless an appended command. A
# changed sanctioned operation therefore requires an explicit review of this
# list and the matching AGENTS.md explanation.
#
# Format: path|sha256-of-complete-line|expected-occurrences
REVIEWED_DESTRUCTIVE_OCCURRENCES=(
  "scripts/claude-hooks/settings.json|271ae7c3c40c0981e364ddd9ef8e7f2b951420952b3ef42200bbbe2a395438e2|1"
  "scripts/claude-hooks/settings.json|5e46ae5248130fbf32978d0e99502bd7dccba7bad16c32dafb5733f5599f4896|1"
  "scripts/claude-hooks/settings.json|2a19a15df5c4ff9ccb268a56e3795550d42e7af94cbee20776f3855f65c4b407|1"
  "scripts/claude-hooks/settings.json|5d7830ab4d22761f3433c80d5bd75feb51e88715892773288e44e9867acf3455|1"
  "scripts/claude-hooks/settings.json|253f917e1bc9bc57a687e0335ce56e92359499ec0d7c82ad3d14d21580f02f06|1"
  "scripts/claude-hooks/settings.json|0b3d6979f31fd90aff468b762de54a4beba945a7ed8311c241123c09b235f721|1"
  "scripts/claude-hooks/settings.json|cd9ba3a919183b9c2193de247a3fd3512722e24294763a7c14159ae8641b2231|1"
  "scripts/claude-hooks/settings.json|245194b78555056023f4fd7c4f75bdb6582bde113730d6e25739ef6380b73684|1"
  "scripts/claude-hooks/settings.json|5698653265cb4c9892824843f2f04c9a7c5ef20a2add60a18ffdd721dd59d9f6|1"
  "scripts/claude-hooks/settings.json|735e17e6a6829e484ac78a97a558bf3a8633c5c4e197cf78208b1e50ee89336a|1"
  "scripts/claude-hooks/settings.json|de8a37566d1db36ae0b0805ce54d93911931a9bf3027cb984fa23e1c87d54e15|1"
  "scripts/claude-hooks/settings.json|c08c86a5b33a194732046424d5b9190ab63c053ba15d43398333a63052ff2129|1"
  "scripts/claude-hooks/settings.json|d5767b41a05e144a6b9328383ccc6419b8014635d88290643a0ee907f9bf5051|1"
  "scripts/claude-hooks/settings.json|7c006f49bb29839eb3c8e4c617b52ce3ab40c469526927e5bafcf37a3b5af3ca|1"
  "scripts/claude-hooks/settings.json|7ceab9079e6977714ff0598278729ca29b8dd4b1fadbc25c0f7291bf62c1c359|1"
  "scripts/claude-hooks/settings.json|ea1f077ebe2fb0b803fab34332e0bb8315eeedabcc5c174c964f2c8507b140a5|1"
  "scripts/db/lib/scratch-db.mjs|c9d7a71aa8db53760e64b7d2e60605eccc981086b2d79eacb7112f42debe528b|1"
)

line_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  echo "POLICY CHECKS FAIL CLOSED: sha256sum or shasum is required for reviewed destructive occurrences." >&2
  return 1
}

# A reviewed occurrence is suppressed only while its exact source line appears
# no more than its committed multiplicity. Any edit, append, or duplicate is a
# policy violation; a missing manifest entry is likewise a failure. This is
# deliberately not a path allowlist.
filter_reviewed_destructive_occurrences() {
  local hits="$1"
  # Parallel arrays instead of associative maps: this script runs on macOS's
  # stock bash 3.2, which has no associative arrays. The manifest is small —
  # a handful of reviewed lines — so linear lookups are effectively free.
  local -a expected_keys=() expected_counts=() seen_counts=()
  local spec path digest count key hit rest lineno text actual i manifest_len found
  for spec in "${REVIEWED_DESTRUCTIVE_OCCURRENCES[@]}"; do
    IFS='|' read -r path digest count <<<"$spec"
    expected_keys+=("$path|$digest")
    expected_counts+=("$count")
    seen_counts+=(0)
  done
  manifest_len=${#expected_keys[@]}

  if [[ -n "$hits" ]]; then
    while IFS= read -r hit; do
      [[ -z "$hit" ]] && continue
      path="${hit%%:*}"
      rest="${hit#*:}"
      lineno="${rest%%:*}"
      text="${rest#*:}"
      digest="$(printf '%s' "$text" | line_sha256)" || return 1
      key="$path|$digest"
      found=0
      for ((i = 0; i < manifest_len; i++)); do
        if [[ "${expected_keys[$i]}" == "$key" ]]; then
          found=1
          actual="${seen_counts[$i]}"
          if ((actual < expected_counts[$i])); then
            seen_counts[$i]=$((actual + 1))
          else
            printf '%s\n' "$hit"
          fi
          break
        fi
      done
      if ((found == 0)); then
        printf '%s\n' "$hit"
      fi
    done <<<"$hits"
  fi

  for ((i = 0; i < manifest_len; i++)); do
    if [[ "${seen_counts[$i]}" != "${expected_counts[$i]}" ]]; then
      printf 'REVIEWED DESTRUCTIVE OCCURRENCE MISSING OR CHANGED: %s (expected %s exact occurrence(s), found %s)\n' \
        "${expected_keys[$i]}" "${expected_counts[$i]}" "${seen_counts[$i]}"
      printf '    Update REVIEWED_DESTRUCTIVE_OCCURRENCES in scripts/policy-checks.sh: pin the path, SHA-256 of the complete source line, and expected count after reviewing that exact line. An innocent reformat of a sanctioned file needs a matching manifest edit.\n'
    fi
  done
}

is_reviewed_destructive_line() {
  local path="$1" text="$2" spec manifest_path digest count
  digest="$(printf '%s' "$text" | line_sha256)" || return 1
  for spec in "${REVIEWED_DESTRUCTIVE_OCCURRENCES[@]}"; do
    IFS='|' read -r manifest_path _ count <<<"$spec"
    if [[ "$path" == "$manifest_path" && "$spec" == "$path|$digest|$count" ]]; then
      return 0
    fi
  done
  return 1
}

# Prisma migration files are reviewed, committed SQL whose job is to change the
# schema: DROP TABLE and TRUNCATE are expected there (PR CI summarizes them in
# plain English, and an applied migration is immutable). That covers each
# folder's migration.sql and the contract.sql the deploy runner applies after
# the soak. Only the line-regex hits for those two forms are dropped, and only
# for the exact migration path shape. Everything else stays live in a migration: DROP DATABASE/SCHEMA,
# dropdb, Prisma CLI commands. The structural scanner applies the same rule to
# its own hits (scripts/check-destructive-operations.mjs, isMigrationSqlPath).
MIGRATION_SQL_FORBIDDEN_RE='([Mm][Ii][Gg][Rr][Aa][Tt][Ee][[:space:]]+([Rr][Ee][Ss][Ee][Tt]|[Dd][Ee][Vv])|[Dd][Bb][[:space:]]+([Pp][Uu][Ss][Hh]|[Dd][Rr][Oo][Pp])|--accept-data-los[s]|--force-rese[t]|[Dd][Rr][Oo][Pp][[:space:]]+([Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]|[Ss][Cc][Hh][Ee][Mm][Aa])|[Dd][Rr][Oo][Pp][Dd][Bb]([[:space:]]|$))' # destructive:audited — detector expression, never executed.

is_migration_sql_path() {
  [[ "$1" =~ ^packages/db/prisma/migrations/[^/]+/(migration|contract)\.sql$ ]]
}

filter_migration_sql_hits() {
  local hits="$1" hit path rest text
  [[ -z "$hits" ]] && return 0
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    path="${hit%%:*}"
    if is_migration_sql_path "$path"; then
      rest="${hit#*:}"
      text="${rest#*:}"
      if ! printf '%s\n' "$text" | grep -qE "$MIGRATION_SQL_FORBIDDEN_RE"; then
        continue
      fi
    fi
    printf '%s\n' "$hit"
  done <<<"$hits"
}

# Drop hits whose path (field 1 of grep -n output) is in the allowlist.
filter_paths() {
  local hits="$1"
  shift
  if [[ -z "$hits" ]]; then
    return 0
  fi
  awk -F: -v list="$*" '
    BEGIN {
      n = split(list, a, " ")
      for (i = 1; i <= n; i++) skip[a[i]] = 1
    }
    {
      path = $1
      if (!(path in skip)) print
    }
  ' <<<"$hits"
}

GREP_EXCLUDES=(--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=generated --exclude-dir=.git)

# This finite list is deliberately data rather than a path allowlist: it names
# only formats that may be inert after the candidate's mode and shebang have
# been inspected. The self-test creates an ordinary, executable, and shebang
# fixture for every suffix so a future addition cannot skip identity checks.
DIRECT_AUTOMATION_INERT_SUFFIXES=(
  .md .mdx .markdown .adoc .rst .txt .csv .tsv .html .htm .css .scss .sass .less
  .png .jpg .jpeg .gif .svg .webp .avif .ico .bmp .tiff .pdf .mp3 .wav .ogg
  .mp4 .webm .mov .woff .woff2 .ttf .otf .zip .gz .tgz .tar .map
)

is_direct_automation_inert_suffix() {
  local path="$1" suffix
  for suffix in "${DIRECT_AUTOMATION_INERT_SUFFIXES[@]}"; do
    [[ "$path" == *"$suffix" ]] && return 0
  done
  return 1
}

# Populate DESTRUCTIVE_COLLECTED with destructive-scan candidates. Git supplies
# both tracked and nonignored-untracked paths. Supported source/config suffixes
# are collected at every repository depth, so a new `infra/foo.sh` or
# `.github/scripts/foo.sh` cannot sit outside this policy. Direct automation
# roots retain a fail-closed catch-all for unknown source forms. Documentation
# and assets are excluded only after their actual executable identity is ruled
# out: an executable bit or shebang always wins over a harmless-looking suffix.
# Elsewhere, extensionless files enter only when executable or shebang-headed;
# the structural scanner then gives every collected file a finite JS/TS,
# shell/config/data, or reject classification.
is_destructive_candidate() {
  local path="$1" prefix
  case "$path" in
    packages/locales/*)
      # Locale JSON is user-facing copy, never executed as SQL or Prisma.
      return 1
      ;;
    *.sh|*.bash|*.zsh|*.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonl|*.yml|*.yaml|*.sql|Dockerfile*|*/Dockerfile*)
      return 0
      ;;
  esac
  case "$path" in
    scripts/*|.github/actions/*|.github/workflows/*|.github/scripts/*)
      # A suffix is not an execution identity. Inspect mode and a real file's
      # first bytes before applying the finite documentation/asset exclusion.
      if [[ -x "$path" ]]; then
        return 0
      fi
      if ! prefix="$(LC_ALL=C od -An -tx1 -N2 -- "$path")"; then
        echo "POLICY CHECKS FAIL CLOSED: cannot inspect destructive-scan candidate $path for a shebang." >&2
        return 2
      fi
      if [[ "$prefix" =~ 23[[:space:]]+21 ]]; then
        return 0
      fi
      if is_direct_automation_inert_suffix "$path"; then
        return 1
      fi
      return 0
      ;;
  esac
  if [[ -x "$path" ]]; then
    return 0
  fi
  # Use hex rather than command-substituting raw bytes: an arbitrary root
  # sibling can begin with NUL, and Bash silently discards that byte.
  if ! prefix="$(LC_ALL=C od -An -tx1 -N2 -- "$path")"; then
    echo "POLICY CHECKS FAIL CLOSED: cannot inspect destructive-scan candidate $path for a shebang." >&2
    return 2
  fi
  [[ "$prefix" =~ 23[[:space:]]+21 ]]
}

collect_destructive_targets() {
  local -a candidates=()
  local path candidates_file
  DESTRUCTIVE_COLLECTED=()
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "POLICY CHECKS FAIL CLOSED: destructive scan requires a Git worktree to include untracked source and config files." >&2
    return 1
  fi
  candidates_file="$(mktemp)" || return 1
  if ! git ls-files -co --exclude-standard -z >"$candidates_file"; then
    rm -r "$candidates_file"
    echo "POLICY CHECKS FAIL CLOSED: git ls-files failed while collecting destructive-scan candidates." >&2
    return 1
  fi
  # Bash 3.2-compatible NUL-delimited read (stock macOS bash). `read -d ''`
  # is available there; the array-form bulk reads are not. git ls-files -z
  # always terminates the final entry, so the loop sees every candidate.
  while IFS= read -r -d '' path; do
    candidates+=("$path")
  done <"$candidates_file"
  rm -r "$candidates_file"
  for path in "${candidates[@]}"; do
    # Tracked paths deleted in the working tree are no longer executable inputs.
    [[ -e "$path" ]] || continue
    is_destructive_candidate "$path" || {
      status=$?
      if ((status > 1)); then
        return 1
      fi
      continue
    }
    if [[ ! -f "$path" ]]; then
      echo "POLICY CHECKS FAIL CLOSED: destructive-scan candidate disappeared: $path" >&2
      return 1
    fi
    if [[ ! -r "$path" ]]; then
      echo "POLICY CHECKS FAIL CLOSED: destructive-scan candidate is unreadable: $path" >&2
      return 1
    fi
    DESTRUCTIVE_COLLECTED+=("$path")
  done
}

# AGENTS.md § Dangerous Commands, as two POSIX ERE patterns (portable to the
# BSD grep/awk on macOS — no grep -P, no lookaround).
#
# destructive:audited — documentation of the SQL detector, not a command.
# TRUNCATE: any TRUNCATE followed by whitespace and a target — a bare
# `TRUNCATE users` is exactly as destructive as `TRUNCATE TABLE users;`; the
# target may end at a semicolon, comment, or end of source. Quoted literals
# are handled by the structural scanner, which avoids confusing a Tailwind
# `truncate font` class with SQL. The initial identifier token prevents a
# standalone `truncate` utility from matching.
DESTRUCTIVE_RE='([Mm][Ii][Gg][Rr][Aa][Tt][Ee][[:space:]]+([Rr][Ee][Ss][Ee][Tt]|[Dd][Ee][Vv])|[Dd][Bb][[:space:]]+[Pp][Uu][Ss][Hh]([^a-zA-Z0-9_-]|$)|[Dd][Bb][[:space:]]+[Dd][Rr][Oo][Pp]|--accept-data-loss(=[^[:space:]]+)?|--force-reset(=[^[:space:]]+)?|[Dd][Rr][Oo][Pp][[:space:]]+([Tt][Aa][Bb][Ll][Ee]|[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]|[Ss][Cc][Hh][Ee][Mm][Aa])|[Tt][Rr][Uu][Nn][Cc][Aa][Tt][Ee][[:space:]]+(([Tt][Aa][Bb][Ll][Ee]|[Oo][Nn][Ll][Yy])[[:space:]]+)?["'"'"'`a-zA-Z_][a-zA-Z0-9_."'"'"'`]*([[:space:]]*;|[[:space:]]*(#|$))|[Dd][Rr][Oo][Pp][Dd][Bb]([[:space:]]|$)|\.[Dd][Ee][Ll][Ee][Tt][Ee][Mm][Aa][Nn][Yy][[:space:]]*\([[:space:]]*\{[[:space:]]*\}[[:space:]]*\))' # destructive:audited — detector expression, never executed.

# DELETE is only forbidden *without* a WHERE clause, which a regex alone cannot
# express portably. Production DELETE-FROM detection is structural — the raw
# scanner in scripts/check-destructive-operations.mjs decides — and this
# pattern feeds the AUDIT_MATCH_RE classifier/scanner parity below.
DELETE_RE='[Dd][Ee][Ll][Ee][Tt][Ee][[:space:]]+[Ff][Rr][Oo][Mm][[:space:]]'

# Both scanner patterns as one regex, for destructive_context(): the classifier
# must see exactly what the scanner matched, or a marked hit it cannot find gets
# exempted by accident.
AUDIT_MATCH_RE="($DESTRUCTIVE_RE)|($DELETE_RE)|(\\.[Dd][Ee][Ll][Ee][Tt][Ee][Mm][Aa][Nn][Yy])|([Tt][Rr][Uu][Nn][Cc][Aa][Tt][Ee][[:space:]]+(([Tt][Aa][Bb][Ll][Ee]|[Oo][Nn][Ll][Yy])[[:space:]]+)?[\"'\`a-zA-Z_][a-zA-Z0-9_.\"'\`]*)"


# Unbounded-`findMany` scanner, shared by the rule below and by --self-test.
#
# It walks from `findMany(` to its matching close paren and asks whether a
# `take:` (or a `pagination:audited` marker) appears anywhere in that span, so a
# `take` at the bottom of a long argument object still counts.
#
# strip_literals() removes quoted spans and `//` comments BEFORE the parens are
# counted. Without it a paren inside a string — `contains: "smile :)"` — closes
# the span early and a perfectly well-bounded query is reported. A gate that
# fires on correct code is a gate the developer learns to route around.
FIND_MANY_AWK='
  function strip_literals(s,   out, i, n, c, q) {
    out = ""; q = ""; n = length(s)
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1)
      if (q != "") {
        if (c == "\\") { i++; continue }
        if (c == q) { q = "" }
        continue
      }
      if (c == "\"" || c == "\047" || c == "`") { q = c; continue }
      if (c == "/" && substr(s, i + 1, 1) == "/") break
      out = out c
    }
    return out
  }
  { lines[FNR] = $0 }
  function span_has_take(start,    j, depth, started, text, k, n, c, line, code) {
    depth = 0; started = 0; text = ""
    for (j = start; j <= FNR; j++) {
      line = (j == start) ? substr(lines[j], index(lines[j], "findMany")) : lines[j]
      text = text "\n" line
      code = strip_literals(line)
      n = length(code)
      for (k = 1; k <= n; k++) {
        c = substr(code, k, 1)
        if (c == "(") { depth++; started = 1 }
        else if (c == ")") { depth-- }
      }
      if (started && depth <= 0) break
    }
    return (text ~ /(^|[^A-Za-z0-9_$.])take[ \t]*[:,]/ || text ~ /pagination:audited/)
  }
  END {
    for (i = 1; i <= FNR; i++) {
      if (lines[i] !~ /findMany[ \t]*\(/) continue
      if (lines[i] ~ /^[ \t]*(\/\/|\*|\/\*)/) continue
      if (lines[i] ~ /pagination:audited/) continue
      if (lines[i-1] ~ /pagination:audited/ || lines[i-2] ~ /pagination:audited/) continue
      if (span_has_take(i)) continue
      print FILENAME ":" i ":" lines[i]
    }
  }
'

# -- self-test --------------------------------------------------------------

if [[ "${1:-}" == "--self-test" ]]; then
  echo "== policy-checks self-test =="

  # This script must keep running on macOS's stock bash 3.2 (the pre-commit
  # hook resolves `#!/usr/bin/env bash` to it). The patterns below name the
  # bash-4-only forms; bracket-splitting keeps this check from matching its
  # own pattern text, and the surrounding comments avoid the literal forms.
  bash4_hits="$(
    grep -nE 'mapfil[e]|\breadarra[y]\b|declar[e][[:space:]]+-A|loca[l][[:space:]]+-A|;;[&]|[|]&' "$0" 2>/dev/null || true
  )"
  if [[ -n "$bash4_hits" ]]; then
    echo "self-test FAILED: this script must stay macOS-bash-3.2 compatible; found bash-4+ only construct(s):" >&2
    echo "$bash4_hits" >&2
    echo "Rewrite with while-read loops and parallel arrays instead." >&2
    exit 1
  fi
  echo "ok: no bash-4+ only constructs (runs on macOS stock bash 3.2)"

  if assert_root "$ROOT/this-directory-does-not-exist-policy-self-test"; then
    echo "self-test FAILED: missing scan root was not a hard failure" >&2
    exit 1
  fi
  echo "ok: missing scan root fails closed"

  if assert_file "$ROOT/this-file-does-not-exist-policy-self-test.ts"; then
    echo "self-test FAILED: missing exemption file was not a hard failure" >&2
    exit 1
  fi
  echo "ok: missing exemption file fails closed"

  # destructive:audited — self-test description only, never a SQL execution.
  # Destructive-SQL patterns. A bare TRUNCATE is as destructive as
  # `TRUNCATE TABLE`, and a DELETE with a WHERE clause is allowed — the rule
  # forbids the unqualified one.
  truncate_word="TRUN""CATE"
  if ! printf '%s\n' "$truncate_word users;" | grep -qE "$DESTRUCTIVE_RE"; then
    echo "self-test FAILED: bare $truncate_word was not caught" >&2 # destructive:audited — self-test result text only.
    exit 1
  fi
  echo "ok: bare $truncate_word is caught" # destructive:audited — self-test result text only.

  assert_destructive_match() {
    local label="$1" candidate="$2"
    if ! printf '%s\n' "$candidate" | grep -qE "$DESTRUCTIVE_RE"; then
      echo "self-test FAILED: $label was not caught" >&2
      exit 1
    fi
  }
  # These candidates are inert grep input. Assemble the terms so this checker
  # cannot become an unscanned source of the very strings it detects.
  drop_database="drop"" database fixture_db"
  dropdb_command="drop""db fixture_db"
  prisma_force="prisma db"" push --schema schema.prisma --force""-reset=confirmed"
  empty_bulk="db.user.""deleteMany({})"
  assert_destructive_match "case-insensitive database drop" "$drop_database"
  assert_destructive_match "drop""db command" "$dropdb_command"
  assert_destructive_match "nonadjacent Prisma force-reset option" "$prisma_force"
  assert_destructive_match "equals-form Prisma force-reset option" "$prisma_force"
  assert_destructive_match "standalone Prisma force-reset option" "--force""-reset"
  assert_destructive_match "plain Prisma schema push" "prisma db"" push"
  assert_destructive_match "quoted Prisma schema push" "\"db:sync\": \"prisma db"" push\""
  assert_destructive_match "empty ORM bulk delete" "$empty_bulk"
  echo "ok: case, dropdb, Prisma option, and empty ORM deletion variants are caught"

  # The sanctioned migration flow is not a hit; the resetting subcommands are.
  # Inert grep input, assembled so this source stays subject to its own scan.
  for sanctioned in "prisma migrate ""deploy" "prisma migrate ""diff --from-empty" "prisma migrate ""resolve --applied 0_init" "prisma migrate ""status"; do
    if printf '%s\n' "$sanctioned" | grep -qE "$DESTRUCTIVE_RE"; then
      echo "self-test FAILED: sanctioned '$sanctioned' was flagged" >&2
      exit 1
    fi
  done
  assert_destructive_match "the Prisma migration reset subcommand" "prisma migrate ""reset"
  assert_destructive_match "the Prisma migration dev subcommand" "prisma migrate ""dev --name x"
  echo "ok: migrate deploy/diff/resolve/status pass; the resetting migrate subcommands are caught"

  # Migration files: DROP TABLE / TRUNCATE are expected content there, but
  # DROP SCHEMA / DROP DATABASE stay live, and the same line elsewhere stays
  # live. Fixture hits are synthetic grep output; nothing is read or run.
  migration_path="packages/db/prisma/migrations/20260101000000_x/migration.sql"
  contract_path="packages/db/prisma/migrations/20260101000000_x/contract.sql"
  migration_drop_table="DROP"" TABLE \"legacy\";"
  migration_truncate="TRUN""CATE \"legacy\";"
  migration_drop_schema="DROP"" SCHEMA public CASCADE;"
  migration_input="$(printf '%s\n' \
    "$migration_path:3:$migration_drop_table" \
    "$migration_path:4:$migration_truncate" \
    "$migration_path:5:$migration_drop_schema" \
    "$contract_path:1:$migration_drop_table" \
    "$contract_path:2:$migration_drop_schema" \
    "packages/db/prisma/migrations/20260101000000_x/other.sql:1:$migration_drop_table" \
    "packages/db/prisma/migrations/20260101000000_x/contract.sql.txt:1:$migration_drop_table" \
    "packages/db/prisma/migrations/a/b/migration.sql:1:$migration_drop_table" \
    "packages/db/prisma/migrations/a/b/contract.sql:1:$migration_drop_table" \
    "scripts/x.sql:1:$migration_drop_table")"
  migration_expected="$(printf '%s\n' \
    "$migration_path:5:$migration_drop_schema" \
    "$contract_path:2:$migration_drop_schema" \
    "packages/db/prisma/migrations/20260101000000_x/other.sql:1:$migration_drop_table" \
    "packages/db/prisma/migrations/20260101000000_x/contract.sql.txt:1:$migration_drop_table" \
    "packages/db/prisma/migrations/a/b/migration.sql:1:$migration_drop_table" \
    "packages/db/prisma/migrations/a/b/contract.sql:1:$migration_drop_table" \
    "scripts/x.sql:1:$migration_drop_table")"
  if [[ "$(filter_migration_sql_hits "$migration_input")" != "$migration_expected" ]]; then
    echo "self-test FAILED: migration.sql / contract.sql exemption is wrong (too wide or too narrow)" >&2
    exit 1
  fi
  echo "ok: migration.sql and contract.sql allow table drops and truncation only at the exact path; schema drops stay live"

  if ! node scripts/check-destructive-operations.mjs --self-test; then
    echo "self-test FAILED: structural destructive-operation scanner rejected a required literal form" >&2
    exit 1
  fi
  echo "ok: structural scanner catches literal ORM and token-bounded SQL forms"

  # Feed literal source through the same comment/manifest/audit filters used by
  # production. These strings are written only to a disposable scanner input;
  # no SQL or ORM operation is invoked.
  structural_dir="$(mktemp -d)"
  structural_path="$structural_dir/literal.ts"
  structural_delete_many="dele""teMany"
  structural_delete_from="DELE""TE FROM"
  printf '%s\n' \
    "client.user.$structural_delete_many();" \
    "client.user.$structural_delete_many(undefined);" \
    "client.user.$structural_delete_many(void 0);" \
    "client.user.$structural_delete_many(null);" \
    "client.user.$structural_delete_many({});" \
    "client.user.$structural_delete_many({ limit: 1 });" \
    "client.user.$structural_delete_many({ where: undefined });" \
    "client.user.$structural_delete_many({ [dynamicOption]: value });" \
    "client.user.$structural_delete_many({ [dynamicOption]: value, where: {} });" \
    "const plain = \`$structural_delete_from users;\`;" \
    "const first = \`$structural_delete_from users;\`; const second = \`$structural_delete_from audit WHERE id = 1;\`;" \
    "client.user.$structural_delete_many(); // destructive:audited — marker cannot bless an operation" \
    "client.user.$structural_delete_many({ where: { id: 'known' } });" \
    >"$structural_path"
  structural_hits="$(node scripts/check-destructive-operations.mjs --scan "$structural_path")"
  structural_manifest=("${REVIEWED_DESTRUCTIVE_OCCURRENCES[@]}")
  REVIEWED_DESTRUCTIVE_OCCURRENCES=() # No reviewed operation exists in this disposable fixture.
  structural_kept="$(filter_destructive_audited "$(filter_reviewed_destructive_occurrences "$(filter_destructive_comments "$structural_hits")")")"
  expected_structural_hits="$(printf '%s\n' \
    "$structural_path:1:client.user.$structural_delete_many();" \
    "$structural_path:2:client.user.$structural_delete_many(undefined);" \
    "$structural_path:3:client.user.$structural_delete_many(void 0);" \
    "$structural_path:5:client.user.$structural_delete_many({});" \
    "$structural_path:6:client.user.$structural_delete_many({ limit: 1 });" \
    "$structural_path:7:client.user.$structural_delete_many({ where: undefined });" \
    "$structural_path:9:client.user.$structural_delete_many({ [dynamicOption]: value, where: {} });" \
    "$structural_path:10:const plain = \`$structural_delete_from users;\`;" \
    "$structural_path:11:const first = \`$structural_delete_from users;\`; const second = \`$structural_delete_from audit WHERE id = 1;\`;" \
    "$structural_path:12:client.user.$structural_delete_many(); // destructive:audited — marker cannot bless an operation" \
    '    ^ the marker only covers a MENTION (in a comment or a quoted string) — this line runs the command.')"
  REVIEWED_DESTRUCTIVE_OCCURRENCES=("${structural_manifest[@]}")
  rm -r "$structural_dir"
  if [[ "$structural_kept" != "$expected_structural_hits" ]]; then
    echo "self-test FAILED: literal destructive operations were not preserved through production filters" >&2
    exit 1
  fi
  echo "ok: literal destructive operations retain exact source-line identities through production filters"

  # Manifest entries bind a line, not a file. The fixtures below are only fed
  # to grep/filter helpers; none is executed. Build the banned fragments so
  # this checker source remains subject to its own scan.
  manifest_dir="$(mktemp -d)"
  manifest_flag="--accept-data""-loss"
  manifest_line="prisma db"" push $manifest_flag"
  printf '%s\n' "$manifest_line" >"$manifest_dir/known.sh"
  manifest_digest="$(printf '%s' "$manifest_line" | line_sha256)"
  saved_manifest=("${REVIEWED_DESTRUCTIVE_OCCURRENCES[@]}")
  REVIEWED_DESTRUCTIVE_OCCURRENCES=("$manifest_dir/known.sh|$manifest_digest|1")
  manifest_hits="$(run_grep -HInE "$DESTRUCTIVE_RE" "$manifest_dir/known.sh")"
  if [[ -n "$(filter_reviewed_destructive_occurrences "$manifest_hits")" ]]; then
    echo "self-test FAILED: exact reviewed destructive occurrence was not accepted" >&2
    rm -r "$manifest_dir"
    exit 1
  fi
  printf '%s\n' "$manifest_line" >>"$manifest_dir/known.sh"
  manifest_hits="$(run_grep -HInE "$DESTRUCTIVE_RE" "$manifest_dir/known.sh")"
  if [[ -z "$(filter_reviewed_destructive_occurrences "$manifest_hits")" ]]; then
    echo "self-test FAILED: duplicated reviewed destructive occurrence was accepted" >&2
    rm -r "$manifest_dir"
    exit 1
  fi
  appended_drop="DROP"" DATABASE temp_fixture"
  printf '%s\n' "$appended_drop" >"$manifest_dir/appended.sql"
  manifest_hits="$(run_grep -HInE "$DESTRUCTIVE_RE" "$manifest_dir/appended.sql")"
  if [[ -z "$(filter_reviewed_destructive_occurrences "$manifest_hits")" ]]; then
    echo "self-test FAILED: appended destructive SQL was accepted" >&2
    rm -r "$manifest_dir"
    exit 1
  fi
  REVIEWED_DESTRUCTIVE_OCCURRENCES=("${saved_manifest[@]}")
  rm -r "$manifest_dir"
  echo "ok: reviewed destructive occurrences reject duplicates and appended SQL"

  # Exercise the production path as well: a copied hit for an actual reviewed
  # deny-list line is accepted once, but a second exact occurrence or an
  # appended SQL operation in that file remains visible. No source is edited
  # and nothing is executed.
  real_path="scripts/claude-hooks/settings.json"
  real_grep="$(run_grep -nE "$DESTRUCTIVE_RE" "$real_path" | head -n 1)"
  real_lineno="${real_grep%%:*}"
  real_line="${real_grep#*:}"
  if [[ -z "$real_grep" || ! "$real_lineno" =~ ^[0-9]+$ ]]; then
    echo "self-test FAILED: no reviewed destructive-looking deny prefix found in $real_path" >&2
    exit 1
  fi
  real_digest="$(printf '%s' "$real_line" | line_sha256)"
  REVIEWED_DESTRUCTIVE_OCCURRENCES=("$real_path|$real_digest|1")
  real_hit="$real_path:$real_lineno:$real_line"
  if [[ -n "$(filter_reviewed_destructive_occurrences "$real_hit")" ]]; then
    echo "self-test FAILED: actual reviewed wrapper occurrence was not accepted" >&2
    exit 1
  fi
  if [[ -z "$(filter_reviewed_destructive_occurrences "$real_hit"$'\n'"$real_hit")" ]]; then
    echo "self-test FAILED: duplicated actual wrapper occurrence was accepted" >&2
    exit 1
  fi
  if [[ -z "$(filter_reviewed_destructive_occurrences "$real_hit"$'\n'"$real_path:$((real_lineno + 1)):$appended_drop")" ]]; then
    echo "self-test FAILED: appended SQL in actual wrapper path was accepted" >&2
    exit 1
  fi
  REVIEWED_DESTRUCTIVE_OCCURRENCES=("${saved_manifest[@]}")
  echo "ok: actual wrapper path rejects duplicate occurrence and appended SQL"

  inventory_probe="$(mktemp "$ROOT/scripts/.policy-checks-untracked.XXXXXX")"
  inventory_path="${inventory_probe#"$ROOT/"}"
  root_probe="$(mktemp "$ROOT/.policy-checks-root-shebang.XXXXXX")"
  root_path="${root_probe#"$ROOT/"}"
  printf '%s\n' '#!/usr/bin/env node' 'export {};' >"$inventory_probe"
  printf '%s\n' '#!/usr/bin/env bash' ':' >"$root_probe"
  # Supported direct and ordinary `/usr/bin/env` headers must remain accepted
  # through the full production candidate collector and scanner path.
  accepted_header_dir="$(mktemp -d "$ROOT/scripts/.policy-checks-accepted-header.XXXXXX")"
  printf '%s\n' '#!/usr/bin/node' 'export {};' >"$accepted_header_dir/direct-node"
  printf '%s\n' '#!/usr/bin/bun' 'export {};' >"$accepted_header_dir/direct-bun"
  printf '%s\n' '#!/usr/bin/tsx' 'export {};' >"$accepted_header_dir/direct-tsx"
  printf '%s\n' '#!/bin/sh' ':' >"$accepted_header_dir/direct-shell"
  accepted_header_log="$(mktemp)"
  if ! bash "$ROOT/scripts/policy-checks.sh" >"$accepted_header_log" 2>&1; then
    cat "$accepted_header_log" >&2
    rm -r "$inventory_probe" "$root_probe" "$accepted_header_dir" "$accepted_header_log"
    echo "self-test FAILED: documented direct or env shebang was rejected by the production scan" >&2
    exit 1
  fi
  rm -r "$accepted_header_dir" "$accepted_header_log"

  unclassified_probe="$(mktemp "$ROOT/scripts/.policy-checks-unclassified.XXXXXX")"
  unclassified_path="${unclassified_probe#"$ROOT/"}"
  unclassified_delete_many="dele""teMany"
  printf '%s\n' "client.user.$unclassified_delete_many();" >"$unclassified_probe"
  rejected_header_dir="$(mktemp -d "$ROOT/scripts/.policy-checks-rejected-header.XXXXXX")"
  printf '%s\n' '#!/usr/bin/python node' 'export {};' >"$rejected_header_dir/foreign-later-word"
  printf '%s\n' '#!/usr/bin/env python node' 'export {};' >"$rejected_header_dir/foreign-env-runtime"
  printf '%s\n' '#!/usr/bin/env -S node' 'export {};' >"$rejected_header_dir/env-split"
  printf '%s\n' '#!/usr/bin/env node --inspect' 'export {};' >"$rejected_header_dir/env-argument"
  printf '%s\n' '#!/usr/bin/node --inspect' 'export {};' >"$rejected_header_dir/direct-argument"
  printf '%s\n' '#!/usr/bin/python' 'export {};' >"$rejected_header_dir/python-header.js"
  printf '%s\n' '#!/bin/sh' 'export {};' >"$rejected_header_dir/shell-header.mjs"
  printf '%s\n' '#!/usr/bin/node' ':' >"$rejected_header_dir/node-header.sh"
  printf '%s\n' 'const = ;' >"$rejected_header_dir/malformed.mjs"
  collect_destructive_targets
  inventory_found=0 unclassified_found=0 root_found=0
  for candidate in "${DESTRUCTIVE_COLLECTED[@]}"; do
    [[ "$candidate" == "$inventory_path" ]] && inventory_found=1
    [[ "$candidate" == "$unclassified_path" ]] && unclassified_found=1
    [[ "$candidate" == "$root_path" ]] && root_found=1
  done
  if ((inventory_found == 0 || unclassified_found == 0 || root_found == 0)); then
    rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir"
    echo "self-test FAILED: nonignored extensionless script or root shebang was omitted from destructive scan" >&2
    exit 1
  fi
  for nested_source in infra/review-probe.sh .github/scripts/review-probe.sh; do
    if ! is_destructive_candidate "$nested_source"; then
      rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir"
      echo "self-test FAILED: nested supported source was omitted from destructive scan: $nested_source" >&2
      exit 1
    fi
  done
  identity_fixture_dir="$(mktemp -d "$ROOT/scripts/.policy-checks-identity.XXXXXX")"
  for suffix in "${DIRECT_AUTOMATION_INERT_SUFFIXES[@]}"; do
    ordinary="$identity_fixture_dir/ordinary$suffix"
    mode_only="$identity_fixture_dir/mode-only$suffix"
    shebang_only="$identity_fixture_dir/shebang-only$suffix"
    printf '%s\n' 'ordinary inert asset fixture' >"$ordinary"
    if is_destructive_candidate "$ordinary"; then
      rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir" "$identity_fixture_dir"
      echo "self-test FAILED: ordinary automation-root inert suffix entered destructive classification: $suffix" >&2
      exit 1
    fi
    printf '%s\n' 'mode-only executable fixture' >"$mode_only"
    chmod +x "$mode_only"
    if ! is_destructive_candidate "$mode_only"; then
      rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir" "$identity_fixture_dir"
      echo "self-test FAILED: executable automation-root inert suffix was excluded before mode inspection: $suffix" >&2
      exit 1
    fi
    if node scripts/check-destructive-operations.mjs --scan "$mode_only" >/dev/null 2>&1; then
      rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir" "$identity_fixture_dir"
      echo "self-test FAILED: executable unsupported inert suffix did not fail closed: $suffix" >&2
      exit 1
    fi
    printf '%s\n' '#!/bin/sh' ':' >"$shebang_only"
    if ! is_destructive_candidate "$shebang_only" || ! node scripts/check-destructive-operations.mjs --scan "$shebang_only" >/dev/null; then
      rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir" "$identity_fixture_dir"
      echo "self-test FAILED: shebang automation-root inert suffix was not classified by executable identity: $suffix" >&2
      exit 1
    fi
  done
  rm -r "$identity_fixture_dir"
  echo "ok: every automation-root inert suffix excludes only ordinary assets; mode and shebang identities are scanned"
  rejected_header_paths=(
    "$unclassified_probe"
    "$rejected_header_dir/foreign-later-word"
    "$rejected_header_dir/foreign-env-runtime"
    "$rejected_header_dir/env-split"
    "$rejected_header_dir/env-argument"
    "$rejected_header_dir/direct-argument"
    "$rejected_header_dir/python-header.js"
    "$rejected_header_dir/shell-header.mjs"
    "$rejected_header_dir/node-header.sh"
    "$rejected_header_dir/malformed.mjs"
  )
  for rejected_header_path in "${rejected_header_paths[@]}"; do
    if node scripts/check-destructive-operations.mjs --scan "$rejected_header_path" >/dev/null 2>&1; then
      rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir"
      echo "self-test FAILED: unsupported no-shebang, interpreter, argument, or suffix/header form bypassed structural classification" >&2
      exit 1
    fi
  done
  # Run the ordinary production gate with the same untracked source present:
  # this asserts its collection, scanner dispatch, and fail-closed handling all
  # occur before the mention/occurrence filters. The fixture is never executed.
  unclassified_log="$(mktemp)"
  if bash "$ROOT/scripts/policy-checks.sh" >"$unclassified_log" 2>&1; then
    rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir" "$unclassified_log"
    echo "self-test FAILED: production destructive scan accepted unsupported header or no-shebang source" >&2
    exit 1
  fi
  if ! grep -q 'destructive-operation scanner could not inspect every candidate' "$unclassified_log"; then
    rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir" "$unclassified_log"
    echo "self-test FAILED: production destructive scan failed without the expected classification guardrail" >&2
    exit 1
  fi
  rm -r "$inventory_probe" "$unclassified_probe" "$root_probe" "$rejected_header_dir" "$unclassified_log"
  echo "ok: extensionless scripts are inventoried; no-shebang and unsupported headers fail closed in the production scan"

  # The helper must make an unreadable/disappeared candidate a hard failure;
  # otherwise a failed read could look like a clean destructive scan.
  if node scripts/check-destructive-operations.mjs --scan "$ROOT/.policy-checks-missing-candidate" >/dev/null 2>&1; then
    echo "self-test FAILED: destructive-operation scanner accepted a missing candidate" >&2
    exit 1
  fi
  echo "ok: destructive-operation candidate read failure is closed"

  # Exercise the Git enumeration failure independently of the user's Git
  # configuration. The fake command only makes `ls-files` fail; it does not
  # execute a payload or mutate the worktree.
  git_mock_dir="$(mktemp -d)"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [[ "$1" == "rev-parse" ]]; then printf true; exit 0; fi' \
    'exit 7' >"$git_mock_dir/git"
  chmod +x "$git_mock_dir/git"
  saved_path="$PATH"
  PATH="$git_mock_dir:$PATH"
  if collect_destructive_targets; then
    PATH="$saved_path"
    rm -r "$git_mock_dir"
    echo "self-test FAILED: destructive-scan Git enumeration failure was accepted" >&2
    exit 1
  fi
  PATH="$saved_path"
  rm -r "$git_mock_dir"
  echo "ok: destructive-scan Git enumeration failure is closed"

  # A `destructive:audited` marker (same line or the line above) exempts only
  # a finite scanner-proven inert carrier. A help, error, or deny-list string
  # is not automatically eligible; the direct-root display fixtures below are
  # the shell form that is supported. An unmarked mention still fails, so
  # detection is unchanged.
  # The fixtures use assembled fragments so this source does not get an
  # exemption from the scanner it verifies.
  audit_dir="$(mktemp -d)"
  audit_accept="--accept-data""-loss"
  audit_migrate="prisma migrate ""reset"
  audit_db_drop="db ""drop"
  audit_force="--force""-reset"
  audit_drop_table="DROP"" TABLE marked_live"
  printf '%s\n' \
    '# destructive:audited — this line names the flag, it does not run it.' \
    "echo \"never hand-write $audit_accept\"" \
    "echo \"the banned reset is $audit_migrate\"" \
    "echo \"$audit_db_drop is banned\" # destructive:audited — deny prefix, not a command" \
    '# destructive:audited — a marker cannot bless the command on the next line.' \
    "prisma db"" push $audit_force" \
    "psql \"\$DATABASE_URL\" -c \"$audit_drop_table\" # destructive:audited — it still runs" \
    >"$audit_dir/probe.sh"
  # -H: the real rule greps several targets, so grep prefixes the path; force it
  # for this single-file probe so the filter sees the same `path:line:text` shape.
  audit_hits="$(run_grep -HInE "$DESTRUCTIVE_RE" "$audit_dir/probe.sh")"
  audit_kept="$(filter_destructive_audited "$audit_hits")"
  if [[ "$audit_kept" == *"$audit_accept"* || "$audit_kept" == *"$audit_db_drop"* ]]; then
    echo "self-test FAILED: destructive:audited marker did not exempt a mention" >&2
    exit 1
  fi
  if [[ "$audit_kept" != *"$audit_migrate"* ]]; then
    echo "self-test FAILED: unmarked destructive command was exempted" >&2
    exit 1
  fi
  echo "ok: destructive:audited exempts a mention; an unmarked one still fails"
  # The marker covers mentions only. A command in command position still fails
  # with it — including one whose SQL sits inside quotes but is an argument to
  # psql, which runs it.
  if [[ "$audit_kept" != *"force-reset"* ]]; then
    echo "self-test FAILED: a marked but LIVE destructive command was exempted" >&2
    exit 1
  fi
  if [[ "$audit_kept" != *"$audit_drop_table"* ]]; then
    echo "self-test FAILED: a marked but LIVE psql -c argument was exempted" >&2
    exit 1
  fi
  echo "ok: destructive:audited does not exempt a command that actually runs"

  # An inline interpreter consumes the quoted payload. Its marker cannot turn
  # that payload into a mention. These are scanner inputs only, never run.
  inline_drop="DROP"" TABLE inline_fixture"
  printf '%s\n' \
    '# destructive:audited — fixture marker must not bless an interpreter.' \
    "eval '$inline_drop'" \
    "bash -c '$inline_drop' # destructive:audited — still executable" \
    "node -e '$inline_drop' # destructive:audited — still executable" \
    "/bin/bash -c '$inline_drop' # destructive:audited — still executable" \
    "/usr/bin/node --eval='$inline_drop' # destructive:audited — still executable" \
    >"$audit_dir/inline.sh"
  inline_hits="$(run_grep -HInE "$DESTRUCTIVE_RE" "$audit_dir/inline.sh")"
  inline_kept="$(filter_destructive_audited "$inline_hits")"
  if [[ "$inline_kept" != *"eval"* || "$inline_kept" != *"bash -c"* || "$inline_kept" != *"node -e"* || "$inline_kept" != *"/bin/bash -c"* || "$inline_kept" != *"/usr/bin/node --eval"* ]]; then
    echo "self-test FAILED: an audited inline interpreter payload was exempted" >&2
    exit 1
  fi
  echo "ok: destructive:audited never exempts eval, shell -c, or node eval payloads"

  # The display exception is a complete-source CST proof, not a line parser.
  # These marked fixtures are scanner/filter input only; they are never
  # sourced or executed. The two direct root displays must be exempted, while
  # every enclosing output consumer or malformed complete source stays live.
  printf '%s\n' \
    "echo \"$audit_drop_table\" # destructive:audited — direct-root echo fixture" \
    "printf '%s\\n' '$audit_drop_table' # destructive:audited — direct-root printf fixture" \
    'eval "$(' \
    "  echo \"$audit_drop_table\" # destructive:audited — eval-substitution fixture" \
    ')"' \
    'payload=`' \
    "  echo \"$audit_drop_table\" # destructive:audited — backtick-capture fixture" \
    '`' \
    'eval "$payload"' \
    "echo \"$audit_drop_table\"; : # destructive:audited — sibling fixture" \
    "echo \"$audit_drop_table\" > audit-output # destructive:audited — redirect fixture" \
    "echo \"$audit_drop_table\" | cat # destructive:audited — pipeline fixture" \
    'fixture() {' \
    "  echo \"$audit_drop_table\" # destructive:audited — function fixture" \
    '}' \
    '(' \
    "  echo \"$audit_drop_table\" # destructive:audited — subshell fixture" \
    ')' \
    "cat <<'AUDIT_FIXTURE'" \
    "$audit_drop_table # destructive:audited — heredoc fixture" \
    'AUDIT_FIXTURE' \
    >"$audit_dir/containment-probe.sh"
  printf '%s\n' \
    "echo \"$audit_drop_table\" # destructive:audited — malformed-source fixture" \
    'if [[ x == x ]]; then' \
    >"$audit_dir/malformed-containment-probe.sh"
  containment_hits="$(run_grep -HInE "$DESTRUCTIVE_RE" "$audit_dir/containment-probe.sh" "$audit_dir/malformed-containment-probe.sh")"
  containment_kept="$(filter_destructive_audited "$containment_hits")"
  if [[ "$containment_kept" == *"direct-root echo fixture"* || "$containment_kept" == *"direct-root printf fixture"* ]]; then
    rm -r "$audit_dir"
    echo "self-test FAILED: complete-source direct display was not exempted" >&2
    exit 1
  fi
  for containment_label in \
    eval-substitution backtick-capture sibling redirect pipeline function subshell heredoc malformed-source; do
    if [[ "$containment_kept" != *"$containment_label fixture"* ]]; then
      rm -r "$audit_dir"
      echo "self-test FAILED: complete-source $containment_label carrier was exempted" >&2
      exit 1
    fi
  done
  echo "ok: complete-source shell containment permits only direct displays"

  # Whole-file marker proof must retain a marked value when its enclosing YAML
  # block or JavaScript carrier executes later. These fixtures are scanner input
  # only: no command is launched. The JS cases cover a multiline array and a
  # template assignment with sibling executors, not merely same-line syntax.
  printf '%s\n' "run: \"$audit_migrate\" # destructive:audited — run field remains executable" >"$audit_dir/probe.yaml"
  printf '%s\n' "const command = \"$audit_migrate\"; // destructive:audited — assigned command remains executable" >"$audit_dir/probe.mjs"
  printf '%s\n' \
    'run: |' \
    "  command=\"$audit_migrate\" # destructive:audited — block scalar remains executable" \
    '  eval "$command"' \
    >"$audit_dir/block-probe.yaml"
  printf '%s\n' \
    'const parts = [' \
    "  \"$audit_migrate\", // destructive:audited — array element remains executable" \
    '];' \
    'const command = parts.join(" ");' \
    'exec(command);' \
    "const template = \`$audit_migrate\`; // destructive:audited — template remains executable" \
    'exec(template);' \
    >"$audit_dir/carrier-probe.mjs"
  config_hits="$(run_grep -HInE "$DESTRUCTIVE_RE" "$audit_dir/probe.yaml" "$audit_dir/probe.mjs" "$audit_dir/block-probe.yaml" "$audit_dir/carrier-probe.mjs")"
  config_kept="$(filter_destructive_audited "$config_hits")"
  if [[ "$config_kept" != *"probe.yaml"* || "$config_kept" != *"probe.mjs"* || "$config_kept" != *"block-probe.yaml"* || "$config_kept" != *"carrier-probe.mjs"* ]]; then
    rm -r "$audit_dir"
    echo "self-test FAILED: audit marker exempted a YAML block or JavaScript carrier" >&2
    exit 1
  fi

  # This calls the production filter end-to-end with an inert marked hit. A
  # failed helper and an invalid helper result must both retain that hit and
  # fail the filter; neither may collapse to an empty successful exemption.
  classifier_failure_hit="$audit_dir/classifier-failure.sh:1:echo \"$audit_migrate\" # destructive:audited — classifier failure fixture"
  node() { return 73; }
  classifier_failure_status=0
  if classifier_failure_output="$(filter_destructive_audited "$classifier_failure_hit")"; then
    classifier_failure_status=0
  else
    classifier_failure_status=$?
  fi
  unset -f node
  if ((classifier_failure_status == 0)) || [[ "$classifier_failure_output" != *"classifier-failure.sh"* ]]; then
    rm -r "$audit_dir"
    echo "self-test FAILED: audited-context helper failure suppressed a destructive finding" >&2
    exit 1
  fi
  node() { printf 'not-a-context\n'; }
  classifier_invalid_status=0
  if classifier_invalid_output="$(filter_destructive_audited "$classifier_failure_hit")"; then
    classifier_invalid_status=0
  else
    classifier_invalid_status=$?
  fi
  unset -f node
  if ((classifier_invalid_status == 0)) || [[ "$classifier_invalid_output" != *"classifier-failure.sh"* ]]; then
    rm -r "$audit_dir"
    echo "self-test FAILED: invalid audited-context result suppressed a destructive finding" >&2
    exit 1
  fi
  rm -r "$audit_dir"
  echo "ok: destructive:audited retains YAML/JavaScript carriers and helper failures"

  # A comment or Tailwind class on the same line cannot hide a second operation.
  # The strings are synthetic filter input only.
  same_line_drop="DROP"" TABLE same_line_fixture"
  block_comment_hit="probe.ts:1:/* note */ psql -c \"$same_line_drop\""
  if [[ -z "$(filter_destructive_comments "$block_comment_hit")" ]]; then
    echo "self-test FAILED: block-comment prefix hid live same-line SQL" >&2
    exit 1
  fi
  tailwind_only='className="font-medium truncate"'
  tailwind_plus_sql="$tailwind_only; $same_line_drop"
  if printf '%s\n' "$tailwind_only" | grep -qE "$DESTRUCTIVE_RE"; then
    echo "self-test FAILED: Tailwind $truncate_word matched SQL grammar" >&2
    exit 1
  fi
  if ! printf '%s\n' "$tailwind_plus_sql" | grep -qE "$DESTRUCTIVE_RE"; then
    echo "self-test FAILED: Tailwind class hid same-line SQL" >&2
    exit 1
  fi
  echo "ok: comment handling and SQL grammar preserve same-line live operations"

  # The unbounded-findMany walk must not count parens inside string literals.
  probe_find_many() {
    printf '%s\n' "$@" | awk "$FIND_MANY_AWK"
  }

  if [[ -n "$(probe_find_many \
    'const rows = await db.user.findMany({' \
    '  where: { name: { contains: "smile :)" } },' \
    '  take: 10,' \
    '});')" ]]; then
    echo "self-test FAILED: a paren inside a string literal ended the findMany span early" >&2
    exit 1
  fi
  echo "ok: a paren inside a string literal does not shorten the findMany span" # destructive:audited — self-test result text only.

  if [[ -z "$(probe_find_many \
    'const rows = await db.user.findMany({' \
    '  where: { name: { contains: "smile :)" } },' \
    '});')" ]]; then
    echo "self-test FAILED: unbounded findMany was not caught" >&2
    exit 1
  fi
  echo "ok: unbounded findMany is still caught"

  if ! node scripts/check-agent-rules.ts --self-test; then
    echo "self-test FAILED: agent-rules scanner rejected a required fixture" >&2
    exit 1
  fi
  echo "ok: agent-rules scanner catches route value exports, hardcoded JSX copy, and sitemap drift"

  echo "policy-checks self-test passed."
  exit 0
fi

# -- required scan roots (fail closed) --------------------------------------

require_root "apps"
require_root "packages"
require_root "scripts"
require_root "apps/web/src"
require_root "apps/web/src/components"
require_root "apps/web/src/routes"
require_root "apps/web/src/hooks"
require_root "packages/api/src"
require_root ".github/workflows"

SESSION_EXEMPTION="apps/web/src/hooks/use-auth-session.ts"
require_file "$SESSION_EXEMPTION"

# -- rules ------------------------------------------------------------------

# AGENTS.md: "Never use `transition: all` or the `transition-all` utility —
# list only the properties you animate"
hits="$(
  run_grep -rInE --include='*.css' --include='*.tsx' --include='*.ts' \
    "${GREP_EXCLUDES[@]}" \
    -E '(transition:[[:space:]]*["'"'"'`]?all|transition-all)' \
    apps packages
)"
report "Found 'transition-all' / 'transition: all' — explicitly list properties instead." "$hits"

# AGENTS.md: "any user-copyable value goes through CopyField (single-line) /
# CodeSnippet (multi-line block) from packages/ui — never a hand-rolled <pre>"
hits="$(
  run_grep -rIn --include='*.ts' --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -e '<pre' \
    apps/web/src
)"
report "Use CodeSnippet / CopyField from packages/ui instead of a raw <pre> (design-system.md § Copyable text and code)." "$hits"

# AGENTS.md / design-system: do not disable pinch zoom. The iOS focus-zoom
# issue is fixed by 16px mobile form-control text, never by locking the viewport.
hits="$(
  run_grep -rInE \
    "${GREP_EXCLUDES[@]}" \
    -E 'maximum-scale|user-scalable=no' \
    apps/web/src
)"
report "Do not disable pinch zoom (maximum-scale / user-scalable=no) — fix form-control font sizes instead." "$hits"

# AGENTS.md: "Use orpc.<router>.<procedure>.queryOptions({ input }) /
# .mutationOptions({ onSuccess }) — never a hand-rolled useQuery/useMutation
# on the oRPC client."
hits="$(
  run_grep -rInE --include='*.ts' --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -E 'orpc(\.[a-zA-Z][a-zA-Z0-9]*){2,}\.(useQuery|useMutation)\(' \
    apps packages
)"
report "Use queryOptions() / mutationOptions() instead of .useQuery() / .useMutation()." "$hits"

# AGENTS.md: "Do not add any or as any to silence TypeScript errors" — and
# never @ts-ignore (use @ts-expect-error with a reason).
hits="$(
  run_grep -rIn --include='*.ts' --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -e '@ts-ignore' \
    apps packages
)"
report "Use @ts-expect-error with a reason instead of @ts-ignore." "$hits"

# AGENTS.md: "Direct useEffect calls are banned in apps/web/src/components/**
# and apps/web/src/routes/**." Approved escape: '// effect:audited — <reason>'
# on the line immediately before. An empty tree is a pass (nothing to scan);
# a missing tree already failed assert_root.
use_effect_files=()
while IFS= read -r -d '' use_effect_file; do
  use_effect_files+=("$use_effect_file")
done < <(
  find apps/web/src/components apps/web/src/routes \
    -type f \( -name '*.ts' -o -name '*.tsx' \) -print0
)
if ((${#use_effect_files[@]} > 0)); then
  hits="$(
    awk '
      FNR == 1 { prev = "" }
      /useEffect\(/ && $0 !~ /import.*useEffect/ && prev !~ /effect:audited/ && $0 !~ /\/\/ eslint-disable/ {
        print FILENAME ":" FNR ":" $0
      }
      { prev = $0 }
    ' "${use_effect_files[@]}"
  )"
  report "Found unaudited useEffect in components/routes. Move to a custom hook or add '// effect:audited — <reason>' comment." "$hits"
fi

# AGENTS.md: "never a hand-rolled useMutation({ mutationFn: ....call() })"
hits="$(
  run_grep -rInE --include='*.ts' --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -E 'mutationFn:[[:space:]]*.*\.(call|mutate)\(' \
    apps packages
)"
report "Use mutationOptions() instead of mutationFn with .call()." "$hits"

# AGENTS.md: "Use isPending (not isLoading) for first-load gating"
# Only flags the destructure pattern `{ isLoading } = useQuery(` — not local useState.
hits="$(
  run_grep -rInE --include='*.tsx' --include='*.ts' \
    "${GREP_EXCLUDES[@]}" \
    -E 'isLoading.+= use(Query|Mutation|InfiniteQuery|Suspense)' \
    apps/web/src
)"
report "Use isPending instead of isLoading from TanStack Query hooks." "$hits"

# AGENTS.md / auth-and-routing: route access uses getRouteSession() so
# navigation is backed by auth.api.getSession() on the server.
hits="$(
  run_grep -rInE --include='*.ts' --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -E 'authClient\.getSession[[:space:]]*\(' \
    apps/web/src/routes
)"
report "Route files must use getRouteSession() from apps/web/src/server/auth-session.ts instead of authClient.getSession()." "$hits"

# AGENTS.md: Better Auth is the only reactive client session store. The
# useAuthSession adapter is the only production code allowed to call any
# .useSession() method.
hits="$(
  run_grep -rInE --include='*.ts' --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -E '\.useSession[[:space:]]*\(' \
    apps/web/src
)"
hits="$(filter_paths "$hits" "$SESSION_EXEMPTION")"
report "Use useAuthSession() instead of consuming a client useSession() hook directly." "$hits"

# AGENTS.md: "Dangerous Commands — Never Run These"
# prisma migrate reset / migrate dev / db push --force-reset / db drop /
# --accept-data-loss / raw DROP TABLE|DROP DATABASE|DROP SCHEMA| TRUNCATE /
# DELETE without a WHERE clause. `prisma migrate deploy|diff|resolve` are the
# sanctioned migration flow and are not flagged. Inside
# packages/db/prisma/migrations/*/migration.sql and */contract.sql, DROP TABLE,
# TRUNCATE, and DELETE are expected migration content (see
# filter_migration_sql_hits).
#
# Scan tracked files plus nonignored untracked files. The candidate list is
# intentionally built from Git rather than a fixed directory list: a new root
# script, action, or helper cannot silently sit outside the policy. Generated
# and vendor output remain excluded by GREP_EXCLUDES above; only source,
# executable, and CI/config extensions enter this scanner.
collect_destructive_targets || exit 1
destructive_targets=("${DESTRUCTIVE_COLLECTED[@]}")
if ((${#destructive_targets[@]} == 0)); then
  echo "POLICY CHECKS FAIL CLOSED: destructive scan found no source/config candidates." >&2
  exit 1
fi

hits="$(
  run_grep -rInE \
    "${GREP_EXCLUDES[@]}" \
    -E "$DESTRUCTIVE_RE" \
    "${destructive_targets[@]}"
)"
hits="$(filter_migration_sql_hits "$hits")"
if ! operation_hits="$(node scripts/check-destructive-operations.mjs --scan "${destructive_targets[@]}")"; then
  echo "POLICY CHECKS FAIL CLOSED: destructive-operation scanner could not inspect every candidate." >&2
  exit 1
fi
if [[ -n "$operation_hits" ]]; then
  hits="${hits:+$hits$'\n'}$operation_hits"
fi
if [[ -n "$hits" ]]; then
  hits="$(printf '%s\n' "$hits" | awk -F: 'NF >= 2 && !seen[$1 FS $2]++')"
fi
hits="$(filter_destructive_comments "$hits")"
hits="$(filter_reviewed_destructive_occurrences "$hits")"
hits="$(filter_destructive_audited "$hits")"
report "Found forbidden destructive Prisma or SQL command. Schema changes go through pnpm db:migrate migrations (docs/schema-migrations.md); destructive SQL belongs only in a reviewed packages/db/prisma/migrations/*/migration.sql. destructive:audited is a narrow, proven-inert exception, not a generic bypass for help/error/deny text: prefer comments or non-command wording, and reword a rejected legitimate message rather than weaken the gate. In shell, only a complete-source program-root echo or exact printf display is supported; captures, wrappers/functions, assignments, configuration, and executable commands remain live." "$hits"

# AGENTS.md: "Do not use git commit --no-verify to skip pre-commit hooks —
# fix the failing check instead."
# Only flag actual command invocations in committed automation/config.
hits="$(
  run_grep -rInE --include='*.sh' --include='*.ts' --include='*.tsx' \
    --include='*.js' --include='*.yml' --include='*.yaml' --include='*.json' \
    "${GREP_EXCLUDES[@]}" \
    -E 'git[[:space:]]+commit[[:space:]].*--no-verify' \
    lefthook.yml package.json scripts apps packages .github
)"
hits="$(filter_paths "$hits" scripts/policy-checks.sh)"
report "Do not bypass commit hooks (git commit --no-verify). Fix the failing check instead." "$hits"

# AGENTS.md: "Do not run sudo commands. If a task requires sudo, stop, print
# the exact command block, and ask the user to run it themselves."
hits="$(
  run_grep -rInE --include='*.sh' --include='*.ts' --include='*.tsx' \
    --include='*.js' --include='*.mjs' --include='*.yml' --include='*.yaml' \
    --include='*.json' \
    "${GREP_EXCLUDES[@]}" \
    -E 'sudo[[:space:]]' \
    apps packages scripts
)"
# The Claude Code hook names the privilege-escalation command as a DENY pattern
# (and in its self-test fixtures); the installed settings repeat it as a prefix.
hits="$(filter_paths "$hits" scripts/policy-checks.sh scripts/claude-hooks/pre-tool-use.mjs scripts/claude-hooks/settings.json)"
report "Do not run sudo from agent-owned scripts. Print the command block and ask the developer to run it." "$hits"

# AGENTS.md rule 8: "Every list query is bounded (`cursorPageInput` + `take`)".
# A `findMany` with no `take:` in its argument list reads the whole table — it
# is fine on ten rows and an outage on ten million, and the difference does not
# show up in review. Approved escape: `// pagination:audited — <what bounds it>`
# on the call or the two lines above it.
#
# The scan walks from `findMany(` to its matching close paren, so a `take:` at
# the bottom of a long argument object still counts. Comment lines are skipped.
#
# Empty, and it stays that way: every `findMany` in the repo now carries either
# a real bound or an audited comment naming what bounds it. Do not add a file
# here to land a new unbounded query — bound the query instead.
PAGINATION_ALLOWLIST=()
find_many_files=()
while IFS= read -r find_many_file; do
  [[ -n "$find_many_file" ]] && find_many_files+=("$find_many_file")
done < <(
  run_grep -rlI --include='*.ts' --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -e 'findMany' \
    packages/api/src apps |
    grep -E '/src/' |
    grep -vE '\.(test|spec)\.tsx?$' || true
)
if ((${#find_many_files[@]} > 0)); then
  # One awk invocation per file: the scan needs the whole file in memory (to
  # walk from `findMany(` to its matching paren), and awk's END block runs once
  # for the last file only.
  hits=""
  for find_many_file in "${find_many_files[@]}"; do
    file_hits="$(awk "$FIND_MANY_AWK" "$find_many_file")"
    if [[ -n "$file_hits" ]]; then
      hits="${hits:+$hits$'\n'}$file_hits"
    fi
  done
  hits="$(filter_paths "$hits" "${PAGINATION_ALLOWLIST[*]}")"
  report "Unbounded prisma findMany (no \`take:\`). Use cursorPageInput + pageTake()/cursorPage() from packages/api/src/lib/pagination.ts, or add '// pagination:audited — <what bounds it>' above the call." "$hits"
fi

# Network-fanout tripwire. Conservative: flag unbounded Promise.allSettled over
# a mapped collection in oRPC routers (the push.subscriptions pattern), and
# the literal Promise.all(rows.map N+1. Allowlisted current hits must shrink.
FANOUT_ALLOWLIST=(
  packages/api/src/routers/push.ts
)
hits="$(
  run_grep -rInE --include='*.ts' \
    "${GREP_EXCLUDES[@]}" \
    -E 'Promise\.allSettled[[:space:]]*\(|Promise\.all\(rows\.map' \
    packages/api/src/routers
)"
hits="$(filter_paths "$hits" "${FANOUT_ALLOWLIST[*]}")"
report "Possible N+1 network fanout (Promise.allSettled over a mapped collection / Promise.all(rows.map)). Batch the work or add this file to the dated allowlist in scripts/policy-checks.sh with a reason." "$hits"

# Hand-rolled label wiring on form fields. `htmlFor={field.name}` (paired with
# `id={field.name}` on the control) is the pre-TextField pattern: TextField,
# TextareaField, and SelectField from @knowledge-base/ui own the id/label/aria/error
# pairing via useId, and hand-rolled copies drift from it (colliding ids
# across two forms on one page, missing aria-describedby). Field-bound inputs
# and selects must use those primitives.
hits="$(
  run_grep -rInE --include='*.tsx' \
    "${GREP_EXCLUDES[@]}" \
    -E 'htmlFor=\{field\.name\}' \
    apps/web/src
)"
report "Hand-rolled htmlFor={field.name} on a form field — use TextField/TextareaField/SelectField from @knowledge-base/ui (they own the id/label/aria/error wiring)." "$hits"

# Tests never run a hard-coded host git: the image-git lane (scripts/test-kb.mjs,
# R3-W1) can only redirect git that is resolved from PATH. Wrappers delegate to
# the git resolved before they are installed (fixtures/git-wrapper.ts).
require_root "apps"
require_root "packages"
hits="$(
  run_grep -rnE --include='*.test.ts' --include='*.test.mjs' \
    "${GREP_EXCLUDES[@]}" \
    -e '/usr/(local/)?bin/git\b' \
    apps packages
)"
report "Hard-coded /usr/bin/git in a test bypasses the image-git lane — resolve git from PATH (writeCountingGitWrapper / findGitOnPath)." "$hits"

# AGENTS.md rules that grep cannot express — enforced by the TS scanner in
# scripts/check-agent-rules.ts (fail-closed on unparsable input):
#   1. "Never `export` a component function from a route file" (code splitting).
#   2. "Every user-facing string goes through t()" — conservative JSX-literal
#      heuristic with a reviewed allowlist that only shrinks
#      (scripts/lib/agent-rules-allowlist.json).
#   3. sitemap.md must list every PUBLIC_PATHS entry from apps/server/src/seo.ts.
AGENT_RULES_ALLOWLIST="scripts/lib/agent-rules-allowlist.json"
require_file "$AGENT_RULES_ALLOWLIST"
require_file "sitemap.md"
require_file "apps/server/src/seo.ts"
agent_rules_status=0
agent_rules_output="$(node scripts/check-agent-rules.ts)" || agent_rules_status=1
if ((agent_rules_status != 0)); then
  printf '%s\n' "$agent_rules_output"
  echo "POLICY VIOLATION: agent-rules gate failed (route exports / t() coverage / sitemap sync)."
  fail=1
fi

# CAS byte/path ownership: focused AST checks also scan their explicit fixtures.
if ! node --test scripts/check-cas-ownership.test.mjs || ! node scripts/check-cas-ownership.mjs; then
  echo "POLICY VIOLATION: CAS source ownership failed."
  fail=1
fi

# -- summary ----------------------------------------------------------------

if [[ "$fail" -ne 0 ]]; then
  echo "policy checks failed."
  exit 1
fi
echo "policy checks passed."
