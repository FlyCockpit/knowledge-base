# Product

General-purpose, single-instance, multi-user, self-hosted Markdown knowledge bases. No organizations, anonymous KBs, server-side dreaming, PDF/DOCX conversion, or public content sharing. Git is authoritative for Markdown and the asset manifest. PostgreSQL holds authority and operational metadata. The search index is a set of rebuildable SQLite files (FTS5 + sqlite-vec) on the data volume.

License Apache-2.0. Package scope `@knowledge-base`. Rust CLI binary `kb`.

## Instance admin vs KB authority

Instance admin (Better Auth `admin` role) and knowledge-base authority are independent.

- Instance admin: users, jobs, instance settings, invites, forced 2FA, web push. Developers seed a local database with `pnpm db:seed`; there is no admin seed page. Bootstrap is one `ADMIN_EMAIL` and a durable `BootstrapState` singleton.
- KB authority bits expand before intersection: `manage => write, review`; `write => propose`; `propose => read`; `review => read`. Write never implies review.
- Admin has no implicit private KB read or manage. Admin may force-tombstone owned KBs, quarantined (REPAIR_REQUIRED) ones included, when deleting an account (with audit) but cannot browse private content by role. Ordinary account deletion is refused while the account owns any KB that is not tombstoned (active, quarantined or still being created), so no KB is left ownerless.

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
record procedure gates. There are no unsupported stubs. `knowledge_search_all`
searches several bases (named, or every readable one up to an instance-admin
limit, 16 by default) with `knowledge_search`'s own per-base checks; see
[client guides](./mcp.md). Optional Gemma/Qwen
built-ins start disabled, one active at a time; each KB can instead use a user
provider. Asset CAS retains historical bytes. Raw Markdown editing and reviewed
PRs preserve human authority. See [client guides](./mcp.md),
[operator deployment](./deploy.md) and [Cockpit seams](./cockpit-adapter.md).

## Agent write modes and provenance

Each agent credential is approved to dream, to edit directly, or both (its
write mode, chosen explicitly at approval), and the server enforces it on every
write path. Every document says who wrote it last, stamped by the server: a
person in the web app (`human`), an agent's direct edit (`agent`) or a dream
(`dream`). Dreams may consolidate what dreams and agents wrote but never touch
what a person wrote. The web app shows the label, each document's history (who
or which credential wrote each version), the writer of each file in PR
review, and a KB's recently changed documents (by a person, an agent or a
Git push). Renaming or moving a document in the web app is one Git rename
commit (or proposal update) with the bytes unchanged, so its label stays. See
[write modes and provenance](./mcp.md#write-modes-and-provenance).

Nothing written to main is lost from the web app's view. Any earlier version
of a document can be restored, after a line diff against the current one, as a
new revision (a pull request for a writer who proposes). A deleted document
keeps its history: Undo on the delete notice, its own page (its old link, at
any age), and the KB's "Recently deleted" list (documents deleted from main in
the last 30 days; at most the newest 1,000 deleting changes, and the list says
when that cuts it short) bring its last version back the same way. Unsaved
edits are marked next to Save, kept in the browser tab across a reload
(`sessionStorage`, per person; dropped when KB access is lost), with the images
uploaded for them, and reopened against the revision they were written on
(main and the pull request head while resolving a pull request), so a document
that moved meanwhile is a conflict, never an overwrite. Deleting a whole knowledge base is final.

The label lives in the document's front matter (`provenance: <value>`, stamped
by the server on every write; a client never chooses it). When that stamp is
the whole front matter, the web editor doesn't show it as text: the "By a
person" / "By an agent" chip says it, and the bytes stay as stored. Front
matter a person wrote is shown and edited as typed.

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
