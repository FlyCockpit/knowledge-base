# Product

General-purpose, single-instance, multi-user, self-hosted Markdown knowledge bases. No organizations, anonymous KBs, server-side dreaming, PDF/DOCX conversion, or public content sharing. Git is authoritative for Markdown and the asset manifest. PostgreSQL holds authority and operational metadata. The search index is a set of rebuildable SQLite files (FTS5 + sqlite-vec) on the data volume.

License Apache-2.0. Package scope `@knowledge-base`. Rust CLI binary `kb`.

## Instance admin vs KB authority

Instance admin (Better Auth `admin` role) and knowledge-base authority are independent.

- Instance admin: users, jobs, instance settings, invites, forced 2FA, web push. Developers seed a local database with `pnpm db:seed`; there is no admin seed page. Bootstrap is one `ADMIN_EMAIL` and a durable `BootstrapState` singleton.
- KB authority bits expand before intersection: `manage => write, review`; `write => propose`; `propose => read`; `review => read`. Write never implies review.
- Admin has no implicit private KB read or manage. Admin may force-tombstone owned KBs when deleting an account (with audit) but cannot browse private content by role.

## Human-only control plane

These stay on live browser identity (or local owner commands) and are excluded from both MCP catalogs:

- shares, ownership transfer
- embedding credential registration and revoke
- mirror configuration, keys, and push
- sealed-value enrollment and consumer authorization
- OAuth / PAT mint, list, revoke
- devices
- instance settings and users

## Common data-plane parity

The entire common data-plane catalog in the protocol contract is identical and functional locally and remotely: KB lifecycle, proposals, assets/exports, indexing, and sealed resolution. Scoped remote connections see the subset their tool groups allow. Local control commands configure providers and the local owner; server control pages configure users. A single local owner has all bits.

The complete live catalog and exclusions are generated in
[MCP tool coverage](./mcp-tool-coverage.md); [access notes](./access-matrix.md)
record procedure gates. There are no unsupported stubs. Optional Gemma/Qwen
built-ins start disabled, one active at a time; each KB can instead use a user
provider. Asset CAS retains historical bytes. Raw Markdown editing and reviewed
PRs preserve human authority. See [client guides](./mcp.md),
[operator deployment](./deploy.md) and [Cockpit seams](./cockpit-adapter.md).

## Optional asset authority

Disk CAS remains the default. Opt-in S3 makes remote objects authoritative and
local asset payload a strictly bounded shared cache; staging/ZIPs still need
local disk capacity. Logical lineage quotas and live read/revision/manifest/KB
authority checks stay unchanged. Downloads remain server-streamed and private;
there is no signed public bypass or remote deletion. See the
[operator role/configuration matrix](./assets.md#opt-in-s3-operation-and-role-configuration)
for writer/operator/dump identity separation, advisory recency, outage behavior,
dual-fenced initialization/migration/reconciliation and reference-only backup
retention. One server and one worker still share one host/local volume.
