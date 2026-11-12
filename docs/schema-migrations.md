# Schema migrations

Knowledge Base uses Prisma Migrate with committed SQL. `packages/db/prisma/schema/` describes the desired schema; `packages/db/prisma/migrations/0_init/migration.sql` creates the current baseline, including KB constraints, triggers and indexes. Later timestamped folders contain `migration.sql` and, for scheduled deletions, `contract.sql`. Merged folders are immutable. Ship schema and SQL together.

## Local commands

| Command | Purpose |
| --- | --- |
| `pnpm db:worktree` | Create this checkout's local and shadow databases and write its DATABASE_URL. |
| `pnpm db:migrate <name>` | Generate reviewed expand SQL and optional delayed contract; applies nothing. |
| `pnpm db:migrate:apply` | Apply locally, recover intact transactional failures, regenerate Prisma client. Skips contracts. |
| `pnpm db:migrate:rebase` | Reorder unmerged folders after rebasing and recheck consistency on scratch DBs. |
| `pnpm db:reset:local` | Explicitly rebuild this checkout's disposable local DB, apply contracts and seed. |
| `pnpm db:check-migrations --base <ref>` | Run five checks against a disposable CHECK_DATABASE_URL. |
| `pnpm db:test-unit` / `pnpm db:test-migrations` | Database-free runner tests / isolated real-Postgres migration, contract and KB lock scenarios. |

Main checkout uses `knowledge_base` (or EXPECTED_DB); worktrees use `knowledge_base_wt_<10 hex>`. Shadows use `<name>_shadow`. Guards require these exact names on localhost/127.0.0.1/::1 and reject query parameters that can redirect connections. EXPECTED_PORT defaults 5432. Never use a shared database for generation, reset or migration checks. Linux wrappers require `/usr/local/bin/kb-child-guard`; packaged development supplies it. Do not bypass the guard if it is missing.

Edit schema, generate, read the SQL, add fixtures/backfills where needed, apply locally and submit schema plus folder for review. Use `@map`/`@@map` for renames and the [two-PR recipe](./schema-changes-recipe.md) for type changes. Never run Prisma's dev/reset or schema-push flow.

## Migration file markers

The generator writes `-- knowledge-base:transactional`, `-- knowledge-base:history-capture` and `-- knowledge-base:commit-marker`. Keep their BEGIN, timeout, history-capture, commit-marker and COMMIT wrapper bytes intact; insert hand-written statements between the generated blocks. Recovery distinguishes committed-but-unrecorded work from rolled-back attempts using those markers. Do not change `knowledge_base.history`, reset session settings or hide a destructive change in a DO block.

`-- knowledge-base:reviewed <reason>` immediately above an unreadable statement attests that it preserves running-release compatibility; it never excuses a drop, rename or type change. It makes rollback unsafe. `-- knowledge-base:relax`, `enum-remove` and `recover` are versioned generated templates; CI regenerates and compares them. Never hand-write contracts. Use `--empty` for a data backfill; statements that cannot be transactional need their own reviewed `--empty --no-transaction` migration.

## Five blocking CI checks

1. Replay consistency against desired Prisma schema and application catalog, including both expand/contract execution orders.
2. Ordering: new folders sort after the base branch's latest folder.
3. Immutability: every merged migration/contract file remains byte-identical.
4. Applies with data: load migration-specific fixtures, replay changes and assert checks return zero wrong rows.
5. Safety and probable accidental rename: reject in-place breaking changes, invalid wrappers/templates, unreviewed opaque SQL and retired-name reuse.

If the replay catalogs differ, check 1 lists each object's kind and identity and whether it is missing or has a different definition. SQL bodies are not dumped into the report.
Replay comparison permits only asymmetric extra enum labels proven by that replay's own generated-contract kept-label notices, preserving the order of remaining labels, missing-object checks and exact comparison of every other definition.

The first port treats a base revision without a migrations directory as empty history. `0_init` still undergoes wrapper, replay/catalog and fixture checks; its first-install context has no running release. No such exception applies to later migrations or an existing database. PR CI records the destructive summary as a job summary and artifact.

Fixtures are `packages/db/prisma/fixtures/<folder>.sql` and `<folder>.check.sql`. Add edge-case rows for affected data and checks for every invariant. Initial fixtures exercise authority, OAuth, generations, quota, operations, PRs, assets, lineage and cache protections. A custom trigger/check omitted from Prisma's representable schema still needs migration and fixture coverage.

## Deploy and wait

The server image runs migrations before starting; MIGRATE_ON_START defaults true. The dedicated worker defaults false and waits up to 300 seconds, registering the same per-start KB_INSTANCE_ID used by its heartbeat. Waiting is read-only except registry writes; it never runs contracts. With an explicit one-shot `migrate` job, set false on runtime services. One-shots do not register runtime instances.

| State | Admission |
| --- | --- |
| up-to-date | Register and start; leader may run due safe contracts. |
| pending | Leader validates and backs up, then deploys. Worker waits. |
| db-ahead | Admit only if all newer migrations are rollback-safe and none of their contracts ran; registry pauses deletions. |
| failed | Wait for an active runner, or recover an intact transaction once; otherwise refuse. |
| no-history-nonempty | Refuse. No automatic baseline or adoption. |
| restore-pending | Refuse every apply/wait/rollback/hold branch until offline recovery reaches READY. |

A genuinely empty managed catalog with no applied history and `0_init` first in the pending set permits a first-install backup exemption for all pending folders, rechecked under locks. Once any application schema or data exists, pending migrations and due contracts require the [full encrypted bundle](./backup-restore.md): Postgres, Git and disk CAS bytes or verified S3 references. Missing encryption recipient/output, disabled backup or failed configured upload blocks mutation. A verified local completed pair is valid when S3 is unconfigured. There is no database-only fallback.

Dokploy replaces KB containers stop-first on one host. Worker wait or a second leader may expire during a long bundle; keep restart enabled and retry after leader completion. Failed migration admission can mean downtime. Confirm the live commit with `pnpm deploy:check <url>` and use the deeper `pnpm dokploy:verify` on the host as needed.

## Expand and contract

The generator moves table/column/type deletions into `contract.sql`; expand SQL keeps old writes possible using reviewed placeholder defaults or relaxed nullability. Enum removal uses `--remap 'Enum.OLD=NEW'`, a generated sync/remap block and later enum rebuild. Never reuse a retired database name. Primary-key changes require the new-table recipe.

Contracts wait for at least seven days after ready admission of the new release, no live older registration and no active restore/cluster/owner hold. Restored registries are invalidated. The runner validates checksums, retained names, live catalog and templates again and takes a full pre-drop bundle before deleting. Dead registrations do not prove readiness; heartbeat starts only after KB maintenance admission, and ready follows actual server/consumer readiness. Deletion notices are retried by the worker.

### No in-place breaking changes

The runner refuses in-place drops, renames and type changes on initialized databases. Use mapped names, generated contracts or the two-PR type-change recipe. There is no maintenance override.

Use image command `hold-deletions [days|--clear]` for an owner hold (default seven days). Restore automatically writes a seven-day hold using greatest semantics, preserving longer existing holds. No in-place breaking override exists; rename with mapping and change types in two PRs.

## Locks and interruption

Runner lock 72707370 serializes classify/recover/backup/deploy/admission. Mutation uses KB DADP 1145389648; guarded Prisma engines take 72707369 themselves. Parent must release DADP before pre-migrate/pre-drop hooks and never hold Prisma's lock while invoking deploy/resolve. Raw contract DDL uses the connection owning DADP.

Snapshot takes DADP then Prisma exclusion and captures history, contract state and catalog in the same exported snapshot as pg_dump. Applied history may be an out-of-order subset of shipped folders; every applied name must be unique, shipped and checksum-matched. Unfinished attempts are refused. It never reacquires its parent's runner lock. Offline restore/storage takes runner nonblocking before preflight, then request → maintenance → DADP → Prisma. No nested runner during restore. Native children drain before locks/fences release, including cancellation. Revalidate restore intent, catalog/history and contract state under mutation exclusion after backup; changed facts restart classification and backup.

## Recovery runbook

An intact transactional migration with a committed marker is resolved applied without replay. Without a marker it is resolved rolled back before the required snapshot, then retried once after backup. Unmarked/broken wrappers or repeated failures stop deployment. Inspect the error and history read-only; repair through a new migration or reviewed operator recovery. Never edit merged SQL or clear history to force startup.

### A database with tables but no migration history

A nonempty database without history is refused. This unreleased baseline has no automatic legacy adoption path: use an empty disposable destination or a separately reviewed maintainer migration. Checksum mismatch requires restoring the original migration bytes and adding a new folder.

Restore only completed encrypted bundles into empty DB and empty/skeleton-only data volume with both runtimes stopped. Snapshot history may be behind the restoring image: restore source state unchanged only if catalog preflight proves current restore projections compatible. Otherwise use a compatible image. Do not run pending migrations inside offline restore; next normal startup takes a new full bundle and applies them. Preserve source/attempt binding, durable restore intent and original master/auth keys. See [backup and restore](./backup-restore.md).

## Getting told when data is deleted

The worker checks committed deletion records every fifteen minutes and emails verified administrators who allow operational alerts, using their locale. Delivery is at least once: a record is marked notified only after at least one successful delivery. Missing SMTP, missing recipients, cooldown or delivery failure leaves it pending for retry; only deletions from the last fourteen days are eligible.

The notice names the migration and deleted objects. To recover a retired field, use the generated recover recipe while retained data exists. After deletion, inspect the pre-drop encrypted bundle and restore it into isolated empty DB/data targets with a compatible image; extract the needed data under review. A full production restore revokes authority and rolls back unrelated data, so it requires an explicit recovery decision. See [encrypted bundle recovery](./backup-restore.md).
