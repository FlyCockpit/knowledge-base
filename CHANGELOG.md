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
- `BACKUP_ENABLED` now defaults to `false`; daily backups (`BACKUP_SCHEDULE=daily`) and migration dumps require `BACKUP_ENABLED=true` — set it to keep them. With `BACKUP_ENABLED=true` and no destination (missing `BACKUP_AGE_RECIPIENT`, an unwritable `BACKUP_DIR`, or neither a volume mounted at `BACKUP_DIR` nor `BACKUP_S3_BUCKET`) every migrating start is refused, even with nothing pending, and so is the migration, a brand-new database too (it gets a destination check, not a bundle).
- Both images' entrypoint is PID 1 through validation and migrations, supervises its startup children (a stop drains them; exit 143/130/129), then drops the startup-only backup/asset operator keys and execs `tini` with the CMD, so `/proc/1/environ` no longer carries them.
- Backups: `BACKUP_ENABLED` defaults to `false`. With it on, every migrating start (the server, the `migrate` job) runs the image's `pre-migrate.sh --startup-notice` check and refuses without a destination, even with nothing pending; with it off, that check prints the one backups-off notice (the `migrate` job too). A destination is a volume mounted at `BACKUP_DIR` (the mount point itself) or `BACKUP_S3_BUCKET`; the image's unmounted `/app/backups` does not count. A backup refuses a database holding PostgreSQL large objects (`BACKUP_LARGE_OBJECTS`), which restore would refuse.
- Backup host helper: declining or interrupting the typed-project prompt exits 3 with nothing stopped; a restore refused before it changed anything (`REFUSED: …`, exit 3: bad arguments, a busy or non-empty target, no completed pair, …) starts again the writers that were running; after a restore that did not finish, the writers stay stopped and the `docker start` command and same-attempt retry are printed; `restore | tee` keeps the exit status. Restore refuses archives containing PostgreSQL large objects (`RESTORE_LARGE_OBJECTS`); a missing `age` reports `RESTORE_DECRYPT_CLIENT_MISSING`.
- Local dev: `pnpm db:reset:local` refuses databases without the disposable-local mark (adopt an existing dev database once with `pnpm db:worktree --adopt`); `pnpm db:migrate:apply` refuses while a migration/lifecycle lock is held or a restore is pending; the Claude hook denies raw `prisma migrate deploy` and `prisma migrate resolve`, `--adopt` and mark-writing SQL.
- Enum value removal: the generated sync trigger is `0_knowledge_base_sync_<hash>`, so it fires before the app's own BEFORE triggers. `pnpm db:test-migrations` takes `--container-prefix`.
- Restore no longer refuses every real bundle with `RESTORE_UNSUPPORTED_PREFIX_USE_COMPATIBLE_IMAGE`: the compatibility check now reads the bundle's enum labels as the JSON array the catalog records, not as comma-separated text.
- Journal recovery settles a ref Git reports as broken (a corrupt `refs/heads/*` file) as `REPAIR_REQUIRED`, keeping the evidence, instead of failing the whole recovery sweep, startup recovery included, on every pass. Other unreadable answers are left to the per-KB recovery isolation below.
- A missing file under `/assets/` is a plain uncached 404, not a locale redirect carrying the immutable cache header. Admin authority is one function, `checkAdminAuthority`.
- The Rust `kb` CLI and reusable `kb-client` for local and remote MCP, with GitHub Release archives and installers for Linux, macOS and Windows.
- Anonymous rate limits key on the client IP through an explicit `TRUST_PROXY_HOPS` (default `0`: the socket peer; the generated Dokploy Compose sets `1`). `X-Forwarded-For` is never trusted without it, and a proxy-appended port (`1.2.3.4:5678`, `[2001:db8::1]:5678`) is stripped from the selected entry; a server behind an uncounted proxy logs `client-ip.proxy-hops` once.
- Container images for server and worker; migrations, encrypted backup and offline restore commands live in the server image, with documented Dokploy deployment and key custody.
- Journal recovery (startup and the periodic sweep) isolates each KB: a KB whose recovery fails is skipped and the rest are still recovered; at the end of the pass, failed ACTIVE KBs are marked `REPAIR_REQUIRED` and logged, if they are at most three and at most half of the ACTIVE KBs. Otherwise (it looks like one host fault), as on a lost volume fence or a database or host-level error, the pass quarantines nothing and aborts (and is retried).
- Retention no longer compacts the intents of a quarantined (`REPAIR_REQUIRED`) KB while their quota reservations are held. Admin-force account removal tombstones quarantined KBs too, and every other deletion path is refused while the account owns any KB that is not tombstoned, so none is left ownerless.
- `pnpm test:kb` Docker resource names take a prefix from `KB_TEST_NAME_PREFIX` so parallel runs from different checkouts cannot collide.
