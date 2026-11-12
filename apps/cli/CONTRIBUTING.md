# Contributing

The [root contributing guide](../../CONTRIBUTING.md) covers Apache-2.0 licensing,
DCO sign-off and the [Code of Conduct](../../CODE_OF_CONDUCT.md).

Thanks for helping out! The conventions live in [`AGENTS.md`](AGENTS.md) — it's
the single source of truth for both humans and AI coding agents. Please skim it
before your first change.

## Before you open a PR

Run the same gates CI runs (from `apps/cli`):

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --locked
cargo test --workspace --doc --locked
cargo xtask sync-docs --check
```

Optionally (also enforced in CI):

```sh
cargo deny check        # cargo install cargo-deny
typos                   # cargo install typos-cli
bash scripts/policy-checks.sh
```

## Ground rules

- **Edit `AGENTS.md`, never the generated mirror** (`CLAUDE.md`). Run
  `cargo xtask sync-docs` after editing.
- **Don't weaken a check to go green.** Fix the cause. A narrow, commented
  `#[allow(...)]` is acceptable with a one-line justification.
- Release orchestration lives in the root `.github/workflows/release.yml`;
  cargo-dist artifact settings live in `dist-workspace.toml` here. See
  `docs/releasing.md` before changing either.
- Keep the dependency set small; discuss new dependencies in the PR.

## Commit messages

Short imperative subject line (e.g. `add config init command`). Reference an
issue if there is one.
