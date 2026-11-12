<p align="center">
  <img src=".github/assets/logo.png" alt="" width="160" height="160">
</p>

<h1 align="center">Knowledge Base</h1>

<p align="center">A self-hosted knowledge-base MCP server: Markdown in Git, searchable by agents over MCP, managed through a web control plane.</p>

<p align="center">
  <a href="LICENSE"><img src="https://shieldcn.dev/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="https://github.com/FlyCockpit/knowledge-base/releases"><img src="https://shieldcn.dev/github/FlyCockpit/knowledge-base/release.svg" alt="GitHub release"></a>
  <a href="https://nodejs.org"><img src="https://shieldcn.dev/badge/Node.js-26-339933.svg?logo=nodedotjs" alt="Node.js 26"></a>
  <a href="https://www.rust-lang.org/tools/install"><img src="https://shieldcn.dev/badge/Rust-1.96%2B-orange.svg?logo=rust" alt="Rust 1.96+"></a>
  <a href="https://github.com/FlyCockpit"><img src="https://shieldcn.dev/badge/part%20of-FlyCockpit-0ea5e9.svg" alt="Part of FlyCockpit"></a>
</p>

Knowledge Base stores Markdown documents in Git. Postgres holds application metadata. Search runs over rebuildable SQLite index files on the data volume. The web app is the human control plane, agents connect over MCP, and the companion Rust CLI is `kb`.

Private per-KB OAuth/PAT/device grants connect agents to a complete local/remote MCP data plane. Clients dream; the server deterministically validates and commits atomic change sets. The human control plane manages sharing, credentials and instance policy; admins have no implicit private KB access.

## Features

- **Per-KB grants.** OAuth, personal access token and device grants connect MCP clients to individual knowledge bases.
- **Git native.** Git smart-HTTP push, pull-request review and one-way mirrors.
- **Hybrid search.** Full-text plus vector search on rebuildable SQLite indexes, with local embeddings or any OpenAI-compatible endpoint.
- **Assets.** Content-addressed disk storage or S3, with media reads and ZIP downloads.
- **Backups.** Offline encrypted backup and restore.
- **`kb` CLI.** A Rust CLI and stdio MCP bridge for local and remote knowledge bases.

## How it works

A React SPA talks to a Hono/oRPC/MCP server, and a BullMQ worker runs background jobs. Postgres holds metadata and Valkey holds queues (Valkey is Redis-compatible; Redis also works). Git repositories and SQLite search indexes live on the data volume. The `kb` CLI offers the same MCP catalog against a local store or a remote server.

## Quick start

Prerequisites: Node.js 26.13.1+, Docker or Podman, and `portless` (`npm install -g portless`). Node 26 no longer bundles Corepack; install it before enabling pnpm (pinned with integrity in `packageManager`):

```bash
npm install --global corepack@0.36.0
corepack enable pnpm
pnpm install
pnpm run setup
pnpm dev
```

`pnpm run setup` copies env examples, starts Postgres/Valkey/mailpit (`docker-compose.dev.yml`), and applies committed migrations. The app is then at **https://knowledge-base.localhost**.

## Installation

- **Server.** Dokploy on a Linux VPS is the supported target, with one server and one dedicated worker on the same host. See [deployment and key custody](./docs/deploy.md).
- **CLI.** Download `kb` from [GitHub Releases](https://github.com/FlyCockpit/knowledge-base/releases), or build it from `apps/cli` with Rust 1.96 or newer. Native dependencies, release targets and remote login are covered in the [CLI guide](./docs/cli.md) and the [CLI README](./apps/cli/README.md).

## Configuration

The main settings are `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `KB_DATA_ROOT`, `KB_MASTER_KEY`, `ADMIN_EMAIL`, `SIGNUP_ENABLED`, `SMTP_*`, `SSO_*`, `KB_ASSET_S3_*`, `BACKUP_*` and `MIGRATE_ON_START`. The `.env.example` files are generated from the env manifest (`pnpm env:sync`). See [deployment and key custody](./docs/deploy.md) for roles, custody and mounts.

## Usage

- [MCP and protocol examples](./docs/mcp.md)
- [Git pushes, PR review and mirrors](./docs/git.md)
- [Assets, media and ZIPs](./docs/assets.md)
- [Schema migrations](./docs/schema-migrations.md) and [change recipes](./docs/schema-changes-recipe.md)
- [CLI local/remote operation](./docs/cli.md)

## Development

Useful commands:

| Command | What it does |
| --- | --- |
| `pnpm gate` | Per-commit gate (lint, types, tests, knip, env, policy, citations, docker COPY). No Docker or running Postgres/Valkey required. |
| `pnpm test:kb -- <suite>` | Run a KB integration suite with disposable services and prebuilt fixtures. |
| `pnpm test:kb -- --reap-dead-runs` | Coordinator cleanup of abandoned KB test resources. Run separately from suites. |
| `pnpm verify:fast` | Affected-subset lint/types/tests plus policy greps. |
| `pnpm verify` | Full CI suite. |
| `pnpm dev:services` | Start local Postgres, Valkey, and mailpit. |
| `pnpm db:migrate <name>` | Generate a reviewed migration and optional delayed deletions. |
| `pnpm db:migrate:apply` | Apply committed migrations to this checkout’s local Postgres. |
| `pnpm db:worktree` | Provision this checkout’s local/shadow databases. |
| `pnpm deploy:check <url>` | Confirm the deployed commit and readiness. |
| `pnpm env:sync` | Regenerate `.env.example` files from the env manifest. |

`test-kb.mjs` runs suite-specific build prerequisites before Vitest or Playwright starts: CLI
and SDK test executables, native helpers, worker/server bundles, browser harness, and fixture images.
The parity suite prebuilds both `kb` and `kb-parity-fixture`; for standalone Vitest,
run `pnpm test:kb --build-only parity` first. Tests and hooks never compile these artifacts.
Builds have their own 30-minute bound, with owned process-group drain on timeout or
SIGINT/SIGTERM; test, hook, and network deadlines stay unchanged.
Missing artifacts fail fast. For standalone Vitest runs, first use
`pnpm test:kb --build-only <suite>` (in the same shell/TMPDIR); failure messages
name the appropriate command. `pnpm test` also prebuilds the native supervisor
before its unit-test consumers run.
Docker image prerequisites require Buildx build history: the runner gives each build
a unique name and waits for daemon completion after client exit, however slowly the
daemon answers, within the same build-only bound. If that readback cannot confirm
completion within it, it retains the build namespace and reports an incomplete
drain; inspect that namespace before retrying. The real-daemon cancellation proof
runs in its own `build` suite (`pnpm test:kb -- build`).

The git-heavy suites (`pr`, `changes`, `git-push`, `git-http`, `mcp`) run against the
git the images ship, not the host's: the runner builds Dockerfile's `base` stage,
copies its git binary, exec path and templates out, and puts that git first on
`PATH` (it must report the image's own `git --version`). The server spawns its
smart-HTTP backend with the same resolved git, and the exec path's `git` is
replaced by a logging dispatcher, so receive-pack and the pre-receive hook use
it too; after the run, the suite fails unless the backend, receive-pack and the
hook's own git calls appear in that log. A host git that is newer than the
image's can therefore never hide a flag the image lacks. The host needs glibc
2.38 or newer to run it.

Each suite cleans up its own project. A coordinator can explicitly run
`pnpm test:kb -- --reap-dead-runs` to reclaim abandoned run resources, including
labelled SSH, memory, push-hook and fence fixtures. Cleanup requires the owning
runner to have exited and no surviving process to carry its project. Conflicting
or absent container labels and uncertain process liveness preserve the resource.
Removal is best effort; later coordinator invocations can reclaim any remainder.

The Rust CLI lives in `apps/cli` (outside pnpm/turbo):

```bash
cd apps/cli
cargo test --workspace --all-targets --locked
cargo run -- --help
```

### Layout

```
apps/web/       React SPA (TanStack Router, i18n under /$lang)
apps/server/    Hono API, Better-Auth, SEO routes
apps/worker/    BullMQ consumers
apps/cli/       Rust CLI `kb`
packages/api    oRPC routers
packages/db     Prisma schema
packages/auth   Better-Auth
packages/env    Env validation (schema + manifest)
packages/queue  BullMQ + Valkey
packages/ui     shadcn/ui
```

## Documentation

- [MCP and protocol examples](./docs/mcp.md) and the generated [MCP tool coverage](./docs/mcp-tool-coverage.md)
- [Git pushes, PR review and mirrors](./docs/git.md)
- [Assets, media and ZIPs](./docs/assets.md)
- [Embedding choices and execution evidence](./docs/embeddings.md)
- [Deployment and key custody](./docs/deploy.md)
- [Offline encrypted backup/restore](./docs/backup-restore.md)
- [CLI local/remote operation](./docs/cli.md) and the [CLI README](./apps/cli/README.md)
- [Cockpit adapter contract](./docs/cockpit-adapter.md)
- [Product model](./docs/product.md), [access matrix](./docs/access-matrix.md) and [hosting](./docs/hosting.md)
- [Changelog](./CHANGELOG.md)

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md), the [Code of Conduct](./CODE_OF_CONDUCT.md) and [AGENTS.md](./AGENTS.md). Run `pnpm gate` before opening a pull request; Rust changes also require the CLI checks described in the contributing guide.

## Security

Please use [GitHub private vulnerability reporting](https://github.com/FlyCockpit/knowledge-base/security/advisories/new). See [SECURITY.md](./SECURITY.md) and, for the CLI, [apps/cli/SECURITY.md](./apps/cli/SECURITY.md).

## License

Copyright 2026 FlyCockpit LLC. Licensed under the [Apache License, Version 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution. Third-party notices are in [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md).
