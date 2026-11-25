# Contributing to Knowledge Base

Thanks for your interest in improving Knowledge Base. Please open an issue to discuss larger changes before you start on them.

Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Reporting security issues

Do not open public issues or pull requests for security problems. Report them privately as described in [SECURITY.md](./SECURITY.md).

## Licensing and the Developer Certificate of Origin

Knowledge Base is licensed under `Apache-2.0` (see [LICENSE](./LICENSE)). Contributions are accepted under the same license: by submitting a contribution you agree that it is licensed to the project and its users under `Apache-2.0` (inbound = outbound). There is no separate contributor license agreement.

Every commit must be signed off to certify the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) 1.1, reproduced below. Sign off by adding a `Signed-off-by` trailer with your real name and an email address you can be reached at:

```text
Signed-off-by: Jane Doe <jane@example.com>
```

`git commit -s` adds the trailer for you, using your `user.name` and `user.email`. Each sign-off certifies your right to submit that contribution under Apache-2.0.

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Development setup

The [README](./README.md#quick-start) covers Node.js 26.13.1+, the pinned pnpm version, local services and `pnpm dev`. The [CLI guide](./docs/cli.md) covers Rust and native build requirements. `pnpm doctor:app` diagnoses common local setup problems.

## Repository rules

[AGENTS.md](./AGENTS.md) is the rulebook for this repository, for people and coding agents alike. Read it before your first change. In particular:

- [docs/access-matrix.md](./docs/access-matrix.md) is the authorization contract. A pull request that adds or changes an oRPC procedure, route gate or schema field updates it in the same change; `pnpm policy:access-matrix` enforces this.
- The [product model](./docs/product.md) and [hosting guide](./docs/hosting.md) describe data placement. Git is authoritative; the SQLite search indexes are rebuildable. Instance administration never grants private KB access.
- Keep the diff to the task. Unrelated refactors, reformatting or dependency bumps belong in their own pull request, and a new dependency should be discussed first.
- User-facing strings go through `t()`, and new environment variables require both the env schema and manifest followed by `pnpm env:sync`, as described in [AGENTS.md](./AGENTS.md).

## Checks

Before opening a pull request, run:

```sh
pnpm gate
```

It runs lint, types, tests, dependency and policy checks. If you changed Rust code, also run from `apps/cli`, with native builds capped at three jobs:

```sh
cargo fmt --all --check
CARGO_BUILD_JOBS=3 cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
CARGO_BUILD_JOBS=3 cargo test --workspace --all-targets --locked
CARGO_BUILD_JOBS=3 cargo test --workspace --doc --locked
cargo xtask sync-docs --check
cargo deny check
```

Unit tests mock database, queue and other import-time IO. Integration suites use disposable services through `pnpm test:kb -- <suite>`; never point them at shared data. Do not skip hooks with `git commit --no-verify`; fix the failing check instead.

On Linux, the native credential smoke starts its own throwaway D-Bus session and Secret Service, so it never touches your keyring. It needs `dbus-daemon`, `dbus-bin` and `gnome-keyring`:

```sh
cd apps/cli && TMPDIR=/tmp bash scripts/native-keystore-smoke.sh
```

### Test baseline

`main` stays green: a change that leaves a failing or newly flaky test does not land. Tests that need the backup tooling find the repo's pinned, checksum-verified `age` through `scripts/lib/age-pin.mjs`; it does not have to be on `PATH`.

All of these pass on Linux, with every Rust step run on both the stable toolchain and the newest one (1.100): `pnpm check:ci`, the `policy:*` checks, `check-types`, `test`, `test:setup`, `knip`, `env:check`, the `*:test-unit` suites, `build`, every cargo command above, `node --test scripts/test-clean.test.mjs`, `typos` (1.52.0), `cargo deny` and the native keystore smoke. On macOS (Apple silicon, 1.99 and 1.100), `cargo fmt`, `cargo clippy` and the full cargo test suite pass. CI runs the cargo tests through `node scripts/test-clean.mjs cargo test …`, which gives the run a private TMPDIR and HOME. On macOS those sit behind the root-owned `/var` → `private/var` symlink, as a real user's do: `kb` resolves its store, data, cache and runtime paths once at entry, following only such root-owned system links. The KB model smoke's real-model parity bar is cosine ≥ 0.9999 against the shared x64 fixture on x64 and ≥ 0.9995 on every other build, because CPU kernel float order differs per build (see [docs/embeddings.md](docs/embeddings.md)). The model lanes run on the SHA-256-keyed, re-verified CI cache (one download fills it on a miss); the live Hugging Face download of the pinned artifacts through the production downloader is checked weekly and on demand by `.github/workflows/kb-model-live-download.yml` (`pnpm kb:models:live-download`), which gates no push or pull request. These GitHub reds were already failing and remain open:

- CLI CI on Windows: credential-protection (DPAPI/ACL) tests fail on the hosted runner.

### Go builder for age

The server and worker images build `age` and `age-keygen` v1.3.2 from the tag's pinned commit with a digest-pinned `golang` image (the `age-tooling` stage, identical in `Dockerfile` and `Dockerfile.worker`). The image Trivy scans run with no ignore file, so a new Go standard library advisory turns them red until the builder carries the fix. To bump it, find the first Go release that fixes the advisory (`go.dev/doc/devel/release`), take the multi-arch index digest of the matching `golang:<version>-trixie` tag (`docker buildx imagetools inspect golang:<version>-trixie`), and set that `FROM` line in both Dockerfiles; Dependabot's `docker` updates bump the same reference weekly. `pnpm docker:check-copy` fails if the two stages differ. A new `age` release also changes `AGE_VERSION`, `AGE_COMMIT` (the tag's commit, `git ls-remote https://github.com/FiloSottile/age refs/tags/<tag>`) and the test archive checksums in `scripts/lib/age-pin.mjs`, and the matching `ARG`s in both stages.

## Pull requests

- Keep each pull request focused on one change, and describe what it does and why.
- Fill in the pull request template, including the checks you ran.
- Make sure every commit is signed off (see above).
- Update the relevant docs, the access matrix and `sitemap.md` when your change affects them.
