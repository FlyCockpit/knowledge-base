# Schema migrations

Knowledge Base uses Prisma Migrate with committed SQL. `packages/db/prisma/schema/` describes the desired schema; `packages/db/prisma/migrations/0_init/migration.sql` creates the current baseline, including KB constraints, triggers and indexes. Later timestamped folders contain `migration.sql` and, for scheduled deletions, `contract.sql`; a release folder also holds `replaces.json` and a `replaced/` copy of what it squashed ([Releases](#releases)). Each PR ships its own migration; at each release the folders added since the last release tag are squashed into one release migration, so an upgrade between releases runs exactly one. Merged folders are immutable: never edit, rename or delete one. The one exception is the release squash, which moves migrations added since the last release into the release folder byte for byte; a migration in a release tag never changes at all. CI check 3 enforces both. Ship schema and SQL together.

## Local commands

| Command | Purpose |
| --- | --- |
| `pnpm db:worktree` | Create this checkout's local and shadow databases, mark each one it creates as disposable, and write its DATABASE_URL. `--adopt` (a person at a terminal) marks older ones. |
| `pnpm db:migrate <name>` | Generate reviewed expand SQL and optional delayed contract; applies nothing. |
| `pnpm db:migrate:apply` | Apply locally, recover intact transactional failures, regenerate Prisma client. Skips contracts. Takes the migration runner lock and refuses, changing nothing, while another session holds the runner/Prisma/DADP lock or a KB restore is pending. |
| `pnpm db:migrate:rebase` | Reorder unmerged folders after rebasing and recheck consistency on scratch DBs. |
| `pnpm db:reset:local` | Explicitly rebuild this checkout's disposable local DB, apply contracts and seed, only when it carries the disposable-local mark; EXPECTED_DB is refused. |
| `pnpm db:check-migrations --base <ref>` | Run the CI checks (five, six when the change adds a release folder) against a disposable CHECK_DATABASE_URL. |
| `pnpm db:release-squash <last-tag> <release-name>` | In the version-bump PR: squash every migration added since `<last-tag>` into one release folder ([Releases](#releases)). Writes files only. |
| `pnpm db:check-release <last-tag>` | The release PR's checks (Guards A and B) against `<last-tag>`. Needs CHECK_DATABASE_URL. |
| `pnpm db:baseline` | Template create-flow only: folds an inherited template history into a new app's own `0_init`. It refuses without the template's `packages/db/prisma/template-history.json` marker, so it is inert here: this app's history already starts at its own `0_init`. |
| `pnpm db:test-unit` / `pnpm db:test-migrations` | Database-free runner tests / isolated real-Postgres migration, contract, KB lock, release reconciliation and baseline scenarios. `db:test-migrations` starts a throwaway `postgres:18` container named `<prefix>-<hex>` with a random password (`--container-prefix <prefix>`; otherwise `TEST_CONTAINER_PREFIX`, shared with `pnpm test:kb`, goes in front of the default `knowledge-base-test-migrations`) and removes it at the end, also on Ctrl-C or TERM; `--server-url <superuser url>` uses a disposable server you already run. Every database and role it creates has a per-run random name, so it never touches `knowledge_base` or a checkout's database, and it does not inherit DATABASE_URL, EXPECTED_DB, guard escapes or BACKUP_ENABLED. |

Main checkout uses `knowledge_base` (or EXPECTED_DB); worktrees use `knowledge_base_wt_<10 hex>`. Shadows use `<name>_shadow`. Guards require these exact names on localhost/127.0.0.1/::1 and reject query parameters that can redirect connections. EXPECTED_PORT defaults 5432. Never use a shared database for generation, reset or migration checks. Linux wrappers require `/usr/local/bin/kb-child-guard`; packaged development supplies it. Do not bypass the guard if it is missing.

Edit schema, generate, read the SQL, add fixtures/backfills where needed, apply locally and submit schema plus folder for review. Use `@map`/`@@map` for renames and the [two-PR recipe](./schema-changes-recipe.md) for type changes. Never run Prisma's dev/reset or schema-push flow.

## Migration file markers

The generator writes `-- knowledge-base:transactional`, `-- knowledge-base:history-capture` and `-- knowledge-base:commit-marker`. Keep their BEGIN, timeout, history-capture, commit-marker and COMMIT wrapper bytes intact; insert hand-written statements between the generated blocks. Recovery distinguishes committed-but-unrecorded work from rolled-back attempts using those markers. Do not change `knowledge_base.history`, reset session settings or hide a destructive change in a DO block.

`-- knowledge-base:reviewed <reason>` immediately above an unreadable statement attests that it preserves running-release compatibility; it never excuses a drop, rename or type change. It makes rollback unsafe. `-- knowledge-base:relax`, `enum-remove` and `recover` are versioned generated templates; CI regenerates and compares them. Never hand-write contracts. Use `--empty` for a data backfill; statements that cannot be transactional need their own reviewed `--empty --no-transaction` migration.

## Blocking CI checks

1. Replay consistency against desired Prisma schema and application catalog, including both expand/contract execution orders.
2. Ordering: new folders sort after the base branch's latest folder.
3. Immutability: every merged migration/contract file remains byte-identical.
4. Applies with data: load migration-specific fixtures, replay changes and assert checks return zero wrong rows.
5. Safety and probable accidental rename: reject in-place breaking changes, invalid wrappers/templates, unreviewed opaque SQL and retired-name reuse.
6. Release squash (only when the change adds a release folder): `replaces.json` and the `replaced/` copies agree, the release folder is the replaced SQL verbatim and in order, and every prefix of the replaced chain, reconciled as the runner does, ends with the fresh schema.

If the replay catalogs differ, check 1 lists each object's kind and identity and whether it is missing or has a different definition. SQL bodies are not dumped into the report.
Replay comparison permits only asymmetric extra enum labels proven by that replay's own generated-contract kept-label notices, preserving the order of remaining labels, missing-object checks and exact comparison of every other definition.

The first port treats a base revision without a migrations directory as empty history. `0_init` still undergoes wrapper, replay/catalog and fixture checks; its first-install context has no running release. No such exception applies to later migrations or an existing database. PR CI records the destructive summary as a job summary and artifact.

Fixtures are `packages/db/prisma/fixtures/<folder>.sql` and `<folder>.check.sql`. Add edge-case rows for affected data and checks for every invariant. A check never asserts that a fixture row exists: CI also runs every check on databases that never had your rows (a release applied to the last release's data, Guard B). A data fixture of a squashed migration moves to `fixtures/<release>/<folder>.sql`; CI replays the release section by section and loads it right after its section. Initial fixtures exercise authority, OAuth, generations, quota, operations, PRs, assets, lineage and cache protections. A custom trigger/check omitted from Prisma's representable schema still needs migration and fixture coverage.

## Deploy and wait

The server image runs migrations before starting; MIGRATE_ON_START defaults true. The dedicated worker defaults false and waits up to 300 seconds, registering the same per-start KB_INSTANCE_ID used by its heartbeat. Waiting is read-only except registry writes; it never runs contracts. With an explicit one-shot `migrate` job, set false on runtime services. One-shots do not register runtime instances.

| State | Admission |
| --- | --- |
| up-to-date | Register and start; leader may run due safe contracts. |
| pending | Leader validates, backs up only with `BACKUP_ENABLED=true`, then deploys. Worker waits. |
| db-ahead | Admit only if all newer migrations are rollback-safe and none of their contracts ran; registry pauses deletions. |
| failed | Wait for an active runner, or recover an intact transaction once; otherwise refuse. |
| no-history-nonempty | Refuse. No automatic baseline or adoption. |
| restore-pending | Refuse every apply/wait/rollback/hold branch until offline recovery reaches READY. |

**Release migrations.** Under the runner lock, before it classifies the database, the leader reconciles migrations that a release folder replaced ([Releases](#releases)): a database that applied some or all of them one by one is moved onto the release in one transaction, instead of being treated as db-ahead. Followers keep waiting while it does.

Backups default off (`BACKUP_ENABLED=false`): pending migrations and due contracts never call the backup hook, even if storage is present. With `BACKUP_ENABLED=true` the leader calls `scripts/backup/pre-migrate.sh --label pre-migrate` for the [full encrypted bundle](./backup-restore.md) (Postgres, Git and disk CAS bytes or verified S3 references) before every pending deploy on an initialized database. No hook in the image, a missing encryption recipient/output, a failed bundle, a missing or mismatched result, or a failed configured upload stops the migration before anything is applied. There is no first-install exemption from the destination: a brand-new database has nothing to bundle (and the bundle coordinates through the catalog `0_init` creates), so there the hook runs `--check-destination` (recipient, a writable BACKUP_DIR that is a mounted volume unless BACKUP_S3_BUCKET is set, BACKUP_S3_* settings; no bundle; the entrypoint runs the same check at every migrating start), and a failed check or a missing hook refuses the migration too. A verified local completed pair is valid when S3 is unconfigured. There is no database-only fallback. A genuinely empty managed catalog with no applied history and `0_init` first in the pending set (rechecked under locks) is still a first install for the in-place breaking-change refusal and the contract soak.

Dokploy replaces KB containers stop-first on one host. Worker wait or a second leader may expire during a long bundle; keep restart enabled and retry after leader completion. Failed migration admission can mean downtime. Confirm the live commit with `pnpm deploy:check <url>` and use the deeper `pnpm dokploy:verify` on the host as needed.

## Expand and contract

The generator moves table/column/type deletions into `contract.sql`; expand SQL keeps old writes possible using reviewed placeholder defaults or relaxed nullability. Enum removal uses `--remap 'Enum.OLD=NEW'`, a generated sync/remap block and later enum rebuild. The sync block adds a `BEFORE INSERT OR UPDATE` trigger per affected table that rewrites `OLD` to `NEW` during the overlap. It is named `0_knowledge_base_sync_<hash>`: BEFORE triggers on a table fire in name order (byte order), so it runs before every trigger with an unquoted name and every quoted one starting with a letter, and they see `NEW`, never `OLD`; only a quoted name starting with a space, punctuation or `0` could sort earlier. The contract drops it. Never reuse a retired database name. Primary-key changes require the new-table recipe.

Contracts wait for at least seven days after ready admission of the new release, no live older registration and no active restore/cluster/owner hold. Restored registries are invalidated. The runner validates checksums, retained names, live catalog and templates again and, with `BACKUP_ENABLED=true`, takes a full pre-drop bundle (`--label pre-drop`) before deleting unless this run already took the pre-migration one; a failed bundle or a missing hook skips every deletion this run (the app still starts). A fresh database takes no pre-drop bundle. Dead registrations do not prove readiness; heartbeat starts only after KB maintenance admission, and ready follows actual server/consumer readiness. Deletion notices are retried by the worker.

### No in-place breaking changes

The runner refuses in-place drops, renames and type changes on initialized databases. Use mapped names, generated contracts or the two-PR type-change recipe. There is no maintenance override.

Use image command `hold-deletions [days|--clear]` for an owner hold (default seven days). Restore automatically writes a seven-day hold using greatest semantics, preserving longer existing holds. No in-place breaking override exists; rename with mapping and change types in two PRs.

## Locks and interruption

Runner lock 72707370 serializes classify/recover/backup/deploy/admission. Mutation uses KB DADP 1145389648; guarded Prisma engines take 72707369 themselves. Parent must release DADP before pre-migrate/pre-drop hooks and never hold Prisma's lock while invoking deploy/resolve. Raw contract DDL uses the connection owning DADP.

Snapshot takes DADP then Prisma exclusion and captures history, contract state and catalog in the same exported snapshot as pg_dump. Applied history may be an out-of-order subset of shipped folders; every applied name must be unique, shipped and checksum-matched. Unfinished attempts are refused. It never reacquires its parent's runner lock. Offline restore/storage takes runner nonblocking before preflight, then request → maintenance → DADP → Prisma. No nested runner during restore. Native children drain before locks/fences release, including cancellation. Revalidate restore intent, catalog/history and contract state under mutation exclusion after backup; changed facts restart classification and backup.

## Recovery runbook

An intact transactional migration with a committed marker is resolved applied without replay. Without a marker it is resolved rolled back before the required snapshot, then retried once after backup. Unmarked/broken wrappers or repeated failures stop deployment. Inspect the error and history read-only; repair through a new migration or reviewed operator recovery. Never edit merged SQL or clear history to force startup.

### A database with tables but no migration history

A nonempty database without history is refused. There is no automatic adoption path for it: use an empty disposable destination or a separately reviewed maintainer migration. Checksum mismatch requires restoring the original migration bytes and adding a new folder.

Restore only completed encrypted bundles into empty DB and empty/skeleton-only data volume with both runtimes stopped. Snapshot history may be behind the restoring image: restore source state unchanged only if catalog preflight proves current restore projections compatible. Otherwise use a compatible image. Do not run pending migrations inside offline restore; next normal startup takes a new full bundle and applies them. Preserve source/attempt binding, durable restore intent and original master/auth keys. See [backup and restore](./backup-restore.md).

## Releases

One migration per release. The version-bump PR squashes every migration added since the last release tag into one release migration that **concatenates** their SQL (never regenerated from a schema diff, which turns a rename into drop + add and loses backfills). Release tags are `v*` (`RELEASE_TAG_PATTERN` overrides that).

In every PR: renames keep the database name with `@map`/`@@map`, or add the new column, copy the data in the same migration and let `contract.sql` delete the old one later (mark the drop `-- intentional: drop and recreate`); backfills live in the migration; every data change gets fixture rows and a `.check.sql`; dev and test databases always run real migrations. A non-transactional migration or an enum-value removal cannot be squashed.

In the version-bump PR, on a clean tree:

```bash
pnpm db:release-squash v1.1.0 1.2.0   # last release tag, new release name
git diff                               # one release folder, the per-PR folders gone
CHECK_DATABASE_URL=<disposable superuser URL> pnpm db:check-release v1.1.0
pnpm db:migrate:apply                  # your local database is reconciled onto the release
```

`db:release-squash` refuses unless the tag's migrations are untouched, and refuses uncommitted, untracked or ignored files under `migrations/` and `fixtures/`. It writes `<timestamp>_release_1_2_0/`: `migration.sql` (the replaced bodies in folder order inside one generated transactional wrapper, each section headed `-- knowledge-base:from <folder>`), `contract.sql` (the replaced contracts in order, same headers, only when one had a contract), `replaces.json` (replaced names and the sha256 of each file) and `replaced/<folder>/` (byte-exact copies). It deletes the per-PR folders and removes the **previous** release's `replaced/` and `replaces.json`. Data fixtures move to `fixtures/<release>/<folder>.sql`; checks are concatenated into `fixtures/<release>.check.sql`. Never edit a release folder by hand; CI regenerates it from `replaced/` and requires an exact match. A migration without the transactional wrapper or with an enum-remove block refuses the squash, writing nothing: release without a squash this time. If another migration merges first and sorts after the release folder, check 2 fails: redo the squash on the rebased branch (`pnpm db:migrate:rebase` refuses to re-timestamp a release folder).

`pnpm db:check-release <last-tag>` (CI runs it on every PR that adds a release folder): **Guard A, equivalence** — check 1 from empty and from the tag, the release folder is exactly the replaced SQL concatenated, and a database built from every prefix of the replaced chain (with and without its scheduled deletions), reconciled by the runner's own code, ends with the fresh schema and passes every fixture check (check 6). **Guard B, upgrade** — a database at the tag with its fixture data, then the release: every row survives and every check returns no rows (check 4). Immutability is checked against the tag (check 3).

Deploying from releases or from the default branch both work. The runner and `pnpm db:migrate:apply` read each `replaces.json` before `prisma migrate deploy`. A database that applied none of the replaced migrations applies the release normally. One that applied all of them records the release and removes the replaced rows in one transaction; no schema SQL runs. One that applied some runs the missing ones from `replaced/` in that same transaction, after the pre-migration bundle when `BACKUP_ENABLED=true`. In the runner the reconciliation plans and applies under DADP (released around the bundle hook), revalidates the facts after the backup (a change restarts classification and backup), and re-reads the whole history under Prisma's lock before running anything. If every replaced `contract.sql` already ran, the release's contract is recorded as applied; if some did, only the remaining sections run after the usual soak; either way the release is not rollback-safe. It refuses to start, changing nothing, when a `replaced/` copy does not match `replaces.json`, an applied replaced migration has other contents than recorded, a replaced `contract.sql` recorded here (already run or still waiting) differs from the one `replaces.json` records, one is recorded as failed, or the database has an applied migration that is neither in the image nor replaced. A database that skipped a whole release with only some replaced migrations applied, after `replaced/` was removed, is refused as db-ahead: deploy that release's image first.

## Getting told when data is deleted

The worker checks committed deletion records every fifteen minutes and emails verified administrators who allow operational alerts, using their locale. Delivery is at least once: a record is marked notified only after at least one successful delivery. Missing SMTP, missing recipients, cooldown or delivery failure leaves it pending for retry; only deletions from the last fourteen days are eligible.

The notice names the migration and deleted objects. To recover a retired field, use the generated recover recipe while retained data exists. After deletion, inspect the pre-drop encrypted bundle and restore it into isolated empty DB/data targets with a compatible image; extract the needed data under review. A full production restore revokes authority and rolls back unrelated data, so it requires an explicit recovery decision. See [encrypted bundle recovery](./backup-restore.md).
