# Changelog

All notable changes to this project are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## 1.0.0 — Unreleased

First public release.

- Self-hosted Markdown knowledge bases with Git as the source of truth, a web control plane, Postgres metadata and a dedicated BullMQ worker.
- Per-KB OAuth, personal access token and device grants for the MCP data plane, with independent read, propose, write, review and manage permissions, and a dream, edit or both write mode on every write-capable grant. Instance admins have no implicit private KB access.
- Atomic document changes, client-generated dreams, Git smart-HTTP pushes, reviewed pull requests and human-controlled one-way mirrors.
- Hybrid full-text and vector search over rebuildable SQLite indexes, optional local CPU embedding models (llama.cpp v0.9.0 in both the worker and the `kb` CLI, so server and CLI vectors stay at parity) and OpenAI-compatible providers.
- Historical content-addressed assets on disk or optional S3 authority, private revision-bound media reads and bounded ZIP exports. Exports are server-owned background jobs: starting one returns at once, the web app and `kb export` show progress and can cancel, the job survives the browser closing, and a restart or its 30-minute deadline ends it with a clear reason, so no export waits inside one request (safe behind a Cloudflare Tunnel's 100 s budget).
- Human-approved sealed values delivered only as recipient-encrypted envelopes to exact authorized consumers.
- A REST control-plane API (`/api/v1`, OpenAPI at `/api/v1/openapi.json`) for REST API keys from Settings → API keys: create, list, read and delete knowledge bases and mint, list and revoke child MCP tokens, each within the key's chosen reach, permissions and toggles and your live access. Keys last 365 days by default or never expire; their tokens can carry any personal-access-token option and either outlive the key or end with it, and revoking a key asks whether to revoke its tokens too. API keys and MCP tokens are refused on each other's surfaces. See [REST API](docs/rest-api.md).
- Admin → Limits sets the KB create rate per owner (default 5 per hour, shared by the web, MCP and REST), the live KBs per owner (default 20) and the child tokens per API key (default 200).
- Offline encrypted backup bundles and fenced restore with authority revocation before admission.
- Per-KB journal recovery: a KB whose recovery fails is quarantined as `REPAIR_REQUIRED` while the others recover, and a fault that looks host-wide quarantines nothing.
- The Rust `kb` CLI and reusable `kb-client` for local and remote (single- or multi-server) MCP, with GitHub Release archives and installers for Linux, macOS and Windows.
- Container images for server and worker; migrations, encrypted backup and offline restore commands live in the server image, with documented Dokploy deployment and key custody.

### Operator notes

- Backups are off by default (`BACKUP_ENABLED=false`). With `BACKUP_ENABLED=true`, every migrating start needs a destination (a volume mounted at `BACKUP_DIR` or `BACKUP_S3_BUCKET`) and an age recipient, or it is refused. See [backup and restore](docs/backup-restore.md).
- Anonymous rate limits key on the client IP through an explicit `TRUST_PROXY_HOPS` (default `0`; the generated Dokploy Compose sets `1`). See [deploy](docs/deploy.md).
- A home server with no public IP can run behind a Cloudflare Tunnel; the server keeps idle upstream connections open for 95 s, beyond `cloudflared`'s and Traefik's 90 s reuse, and every in-request SMTP send has an absolute deadline. See [deploy](docs/deploy.md#home-server-behind-a-cloudflare-tunnel).
- Both images' entrypoint runs validation and migrations as PID 1, then drops the startup-only backup/asset operator keys before starting the service. See [deploy](docs/deploy.md).
