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

The [README](./README.md#quick-start) covers Node.js 26.13.1+, the pinned pnpm version, local services and `pnpm dev`. The [CLI guide](./docs/cli.md) covers Rust and native build requirements. `pnpm doctor` diagnoses common local setup problems.

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

## Pull requests

- Keep each pull request focused on one change, and describe what it does and why.
- Fill in the pull request template, including the checks you ran.
- Make sure every commit is signed off (see above).
- Update the relevant docs, the access matrix and `sitemap.md` when your change affects them.
