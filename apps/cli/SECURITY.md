# Security policy

## Reporting a vulnerability

Please report security issues privately through [GitHub private vulnerability reporting](https://github.com/FlyCockpit/knowledge-base/security/advisories/new), rather than opening a public issue. We aim to acknowledge reports within 72 hours and work with you on a fix and disclosure timeline.

## What ships by default

The CLI includes these baseline protections:

- **`unsafe_code` lint** at the crate level — `forbid` in `kb` and `kb-client`,
  `deny` in `kb-local` (its few `unsafe` sites carry explicit, reviewed allows).
- **`cargo-deny`** in CI: a license allowlist, banned/duplicate-crate checks,
  source allowlist (crates.io only), and **RUSTSEC advisory** scanning (this
  subsumes `cargo-audit`).
- **TruffleHog** secret scanning on every PR (repo-root
  `.github/workflows/pr-checks.yml`), beyond the lightweight policy greps.
- **Dependabot** for Cargo crates and GitHub Actions, so dependencies and CI
  actions stay current; every update is gated by CI.
- **Policy checks** (`apps/cli/scripts/policy-checks.sh`) that grep for committed private
  keys, AWS keys, hook-bypass flags, and unsafe-lint overrides.
- **SHA-pinned GitHub Actions** in the hand-maintained CI workflow, with comments
  showing the upstream version tag. Dependabot updates the pinned SHAs.
- **Warnings-as-errors** (`-D warnings`) and `clippy` lints that forbid
  `unwrap()`/`panic!`/`dbg!`/`todo!` in production code.

## Hardening you may want to add

- **Enable GitHub code scanning / CodeQL** if your account has it.
- **Sign releases.** `dist` can be configured to attest/sign artifacts.

## Supported versions

Only the latest release on `main` is supported. Keep deployed binaries current with
reviewed upstream security fixes.

Remote credentials are private and origin/resource-bound; redirects and ambient
proxy credentials are never inherited. The local durable registry is not an
index cache. Native OS-keystore failure refuses provider/sealed operations.
Sealed plaintext is available only to an explicitly approved host resolver,
never the agent tool stream. See [CLI custody](../../docs/cli.md) and
[the root security policy](../../SECURITY.md).
