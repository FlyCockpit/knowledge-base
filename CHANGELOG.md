# Changelog

All notable changes to this project are documented in this file. The project follows [Semantic Versioning](https://semver.org/).

## 1.0.0 — Unreleased

First public release.

- Self-hosted Markdown knowledge bases with Git as the source of truth, a web control plane, Postgres metadata and a dedicated BullMQ worker.
- Per-KB OAuth, personal access token and device grants for the MCP data plane, with independent read, propose, write, review and manage permissions. Instance admins have no implicit private KB access.
- Atomic document changes, client-generated dreams, Git smart-HTTP pushes, reviewed pull requests and human-controlled one-way mirrors.
- Hybrid full-text and vector search over rebuildable SQLite indexes, optional local CPU embedding models and OpenAI-compatible providers.
- Historical content-addressed assets on disk or optional S3 authority, private revision-bound media reads and bounded ZIP exports.
- Human-approved sealed values delivered only as recipient-encrypted envelopes to exact authorized consumers.
- Offline encrypted backup bundles and fenced restore with authority revocation before admission.
- The Rust `kb` CLI and reusable `kb-client` for local and remote MCP, with GitHub Release archives and installers for Linux, macOS and Windows.
- Anonymous rate limits key on the client IP through an explicit `TRUST_PROXY_HOPS` (default `0`: the socket peer; the generated Dokploy Compose sets `1`). `X-Forwarded-For` is never trusted without it; a server behind an uncounted proxy logs `client-ip.proxy-hops` once.
- Container images for server and worker; migrations, encrypted backup and offline restore commands live in the server image, with documented Dokploy deployment and key custody.
