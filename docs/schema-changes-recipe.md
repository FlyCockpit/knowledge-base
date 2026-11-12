# Schema Changes — Step-by-Step Recipes

How to change the database schema safely. Read this **before** touching `packages/db/prisma/schema/`. The mechanics behind these recipes (markers, deploy states, recovery) are in [schema-migrations.md](./schema-migrations.md); naming and modelling conventions are in [AGENTS.md](../AGENTS.md).

If you only remember one thing: **edit the schema, run `pnpm db:migrate <name>`, read the SQL, run `pnpm db:migrate:apply`, commit the schema and the migration folder together.**

## How schema changes reach production

1. You change `packages/db/prisma/schema/*.prisma` and generate a migration: a folder under `packages/db/prisma/migrations/` holding the exact SQL.
2. You review (and if needed edit) that SQL, apply it to your local database, and commit both in one PR.
3. CI applies every migration to a fresh database and checks it matches the schema, keeps existing data, and does not look like an accidental data loss ([What CI checks](#what-ci-checks)). It also writes a plain-English list of anything destructive to the job summary.
4. After merge, the deploy runs `prisma migrate deploy`, which applies only the migrations that database has not seen yet:
   - **Dokploy:** the app applies them when it starts (auto-deploy on the default branch).
   - **Container platforms:** the infra workflow runs a one-shot `migrate` job, then rolls out the app ([deploy-contract.md](./deploy.md)).

KB uses stop-first Dokploy replacement, and an admitted rollback can run old code against a newer schema. `pnpm db:migrate` keeps that safe on its own: anything the old code still reads is never dropped at deploy. A removal is split into two files in the same folder: `migration.sql` changes only what the old code tolerates (it relaxes a dropped column so the old code's inserts keep working), and `contract.sql` deletes the data about 7 days after the deploy, once no older release is running ([schema-migrations.md § Expand and contract](./schema-migrations.md#expand-and-contract)). Every schema change is one ordinary PR and one ordinary deploy. The only exceptions are renames (use `@map`, Recipe 3) and type changes (two PRs, Recipe 5).

## The commands you need

| Command | When |
|---|---|
| `pnpm db:migrate <name>` | After editing the schema. Generates the SQL (`migration.sql`, plus `contract.sql` when something is deleted); applies nothing. Use a short snake_case name: `add_phone_number`. Flags: `--remap 'Enum.OLD=NEW'` (removing an enum value), `--recover 'table.old=new'` (getting a field back before its deletion runs), `--empty`, `--no-transaction`. |
| `pnpm db:migrate:apply` | After reviewing the SQL, and after every pull or rebase. Applies `migration.sql` to your local DB and regenerates the Prisma client. It prints how many scheduled deletions it did not apply; `pnpm db:reset:local` applies them. |
| `pnpm db:migrate:rebase` | After rebasing a branch that has migrations onto the default branch. |
| `pnpm db:reset:local` | Your local DB is in a mess and you want a clean one (this checkout's DB only). |
| `pnpm db:studio` | Look at local data in the browser. |

Never run `prisma migrate dev`, `prisma migrate reset`, or `prisma db push` — see the Dangerous Commands section of AGENTS.md. All the wrappers refuse to touch anything but this checkout's own local database.

---

## Recipe 1 — Add a field to an existing model

**Goal:** add `phoneNumber` to `User`.

1. Add the field in `packages/db/prisma/schema/auth.prisma`. Make it optional (`?`) or give it a `@default(...)` — a required column with no default fails on a table that already has rows.

   ```prisma
   model User {
     // ... existing fields
     phoneNumber String?
   }
   ```

2. `pnpm db:migrate add_user_phone_number`
3. Open the new `migration.sql`. Expect one `ALTER TABLE "user" ADD COLUMN "phoneNumber" TEXT;` inside the generated `BEGIN … COMMIT;` wrapper. Nothing should be dropped.
4. `pnpm db:migrate:apply`
5. Commit the schema file and the new migration folder.

## Recipe 2 — Add a new model

**Goal:** add a `Project` model owned by a `User`.

1. Add the model (a new domain gets its own `<domain>.prisma`). Every model needs `id`, `createdAt`, `updatedAt`; every foreign key needs a relation and an index ([AGENTS.md](../AGENTS.md)). Add the back-relation on `User`.

   ```prisma
   model Project {
     id        String   @id @default(cuid(2))
     createdAt DateTime @default(now()) @db.Timestamptz(3)
     updatedAt DateTime @default(now()) @updatedAt @db.Timestamptz(3)
     name      String
     userId    String
     User      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

     @@index([userId])
   }
   ```

2. `pnpm db:migrate add_project`, read the SQL (a `CREATE TABLE`, an index, a foreign key — nothing dropped), `pnpm db:migrate:apply`, commit.

Use the KB baseline fixtures as examples for authority, asset and operation invariants.

## Recipe 3 — Rename a field

**Use `@map`. No SQL changes, no deploy coordination, one PR.** When only the name in code changes, keep the column as it is in the database and tell Prisma about it:

```prisma
model User {
  fullName String @map("name") // code says fullName; the column is still "name"
}
```

For a model, use `@@map("old_table_name")`. The schema already does this (see `auth.prisma`, `knowledge.prisma`).

1. Rename the field and add `@map("<old column name>")`. Update every use in code.
2. `pnpm db:migrate rename_user_full_name` — the generator should report **no changes**. If it produced a `DROP COLUMN` + `ADD COLUMN`, the `@map` is wrong; fix it and delete that generated folder.
3. Commit.

Old and new code both read the same column, so an ordinary deploy is safe.

## Recipe 4 — Physical rename

**Don't.** Use `@map` / `@@map` (Recipe 3), even when the old name is awkward. A physical `RENAME COLUMN`, table rename, enum rename or enum value rename breaks the release that is still running, so the generator refuses the renames it can see and CI check 5 fails the rest ("use `@map`").

There is no override: the deploy runner refuses an in-place rename on any database that already has migrations ([schema-migrations.md § No in-place breaking changes](./schema-migrations.md#expand-and-contract)). If the database name truly must change (a shared database read by an external tool, for example), stop and ask the owner.

## Recipe 5 — Backfill or change a type

Data changes go **in the migration**, next to the schema change, so every environment gets them in the same order.

**Add a required column to a table with rows:**

```sql
ALTER TABLE "project" ADD COLUMN "slug" TEXT;
UPDATE "project" SET "slug" = "id" WHERE "slug" IS NULL;
ALTER TABLE "project" ALTER COLUMN "slug" SET NOT NULL;
```

Steps: edit the schema → `pnpm db:migrate <name>` → add the backfill after the `-- knowledge-base:history-capture` block and before the `-- knowledge-base:commit-marker` block (leave every wrapper line exactly as generated) → `pnpm db:migrate:apply` → add rows that exercise the change to the fixture in `packages/db/prisma/fixtures/` (CI check 4 runs your migration against it) → commit. `SET NOT NULL` is reported, and it means the previous release can no longer be rolled back to.

**Change a column's type: two PRs.** An in-place `ALTER COLUMN … TYPE` breaks the release that is still running, so CI check 5 fails it and the deploy refuses it. Instead:

1. **PR 1.** Add a new field with a new database name, nullable (for example `amountCents Int? @map("amount_cents")`). In the same migration, backfill it from the old column (`UPDATE "invoice" SET "amount_cents" = round("amount" * 100)::INTEGER WHERE "amount_cents" IS NULL;`). The app writes both fields and still reads the old one. Merge and deploy.
2. **PR 2.** A catch-up `UPDATE … WHERE "new" IS NULL` for rows the old release wrote meanwhile; optionally `SET NOT NULL`; switch reads to the new field; remove the old field from the schema. `pnpm db:migrate` relaxes the old column and schedules its deletion. Optionally rename the field in code with `@map` (Recipe 3).

Three widenings are safe in place and need no second PR: `varchar(n)` → `varchar(m)` with m ≥ n, `varchar(n)` → `text`, and `numeric(p,s)` → `numeric(p',s)` with p' ≥ p (no `USING`, not arrays). They are still recorded as not rollback-safe. `int` → `bigint` is not on the list: it rewrites the table.

**Unique constraints and upserts.** Dropping a unique index on a column you keep also takes two PRs when code upserts by that field: remove every `upsert` / `connectOrCreate` (and any `findUnique`) keyed on it in PR 1, then drop the constraint in PR 2. The generator warns about this. The release that is still running would otherwise fail on its next upsert.

Rules of thumb:

- Make backfills safe to read twice: `WHERE "x" IS NULL`, not a blanket `UPDATE`.
- A backfill over millions of rows can exceed the 60-second statement timeout. Ask before writing one; it may need batching outside the migration.

## Other changes

- **Drop a column / remove tables.** One PR: stop reading and writing the field (or the models) in code and remove it from the schema in the same change, then `pnpm db:migrate <name>`. The generator writes `migration.sql` with only the relax step (`-- knowledge-base:relax`: a nullable column or a placeholder default, so the old release's inserts keep working) and `contract.sql` with the `DROP`. The data is deleted about 7 days after the deploy, once no older release is running. For a deployed feature's tables, delete them only after the owner confirms the data can go (export it first if needed); never edit `0_init` or any published migration.
  - **Review raw SQL consumers by hand.** Before merging, grep the code for the column or table name in `$queryRaw` / `$executeRaw` and SQL strings; a raw query that names it breaks when the deletion runs.
  - **Changed your mind?** Within those 7 days, ship a PR that adds the field back under a new name with `pnpm db:migrate <name> --recover 'table.old=new'`. It copies the data while the old column still exists ([schema-migrations.md § Expand and contract](./schema-migrations.md#expand-and-contract)). A deleted name is never reused: put the field back with `@map` to a new database name.
- **Remove an enum value.** Ask the user which value existing rows become, then `pnpm db:migrate <name> --remap 'Enum.OLD=NEW'`. `NEW` must already exist in a merged migration, and any default that names `OLD` must change in the same schema edit. Remove values from **one enum per migration**: the generator refuses two, and tells you how to split them. Adding values to the same enum in the same migration is refused too ("add the new value in an earlier PR"). Rows are remapped at deploy and the value is removed about 7 days later; if the table is larger than 64 MB, or something else in the database uses the column (a view, policy, trigger or function), the unused value is kept instead, permanently and harmlessly. If you wrote SQL functions that use this enum in another schema, they need a reconnect after the deletion runs.
- **Table rename, enum rename.** Use `@@map` / `@map`.
- **Primary-key change.** Unsupported in place. Do it as a new table via expand and contract: add the new model (new `@@map` name) with the new key, write to both tables and backfill the old rows, switch reads to the new table, then remove the old model so `contract.sql` drops it ([schema-migrations.md § Expand and contract](./schema-migrations.md#expand-and-contract)).
- **Tighten nullable → `NOT NULL`.** Backfill in the same migration (`UPDATE … WHERE "y" IS NULL`, then `SET NOT NULL`), or add a `@default(...)`.
- **Add a unique constraint where duplicates may exist.** Decide with the user which row wins, delete or merge duplicates in the same migration (a `DELETE … WHERE …` is allowed in migration files), then add the unique index.
- **Tighten an `onDelete`** (for example `Cascade` → `Restrict`). Clean up rows that would block it in the same migration, or the constraint change fails.
- **Index on a big table.** `CREATE INDEX CONCURRENTLY` cannot run in a transaction: put it in its own migration without the `BEGIN`/`COMMIT` wrapper and without `-- knowledge-base:transactional`.

## Destructive patterns to watch for

Read every generated `migration.sql`. Stop and think when you see:

- **A `DROP COLUMN` / `DROP TABLE` in `contract.sql`** you did not intend — usually a rename Prisma read as drop + add. Use `@map` (Recipe 3). CI check 5 fails a drop + add on the same table unless the line above the `DROP` in `contract.sql` is `-- intentional: drop and recreate`.
- **`ALTER COLUMN … TYPE`** — CI check 5 fails it unless it is one of the safe widenings. Use the two-PR recipe (Recipe 5).
- **`SET NOT NULL`** or **`ADD COLUMN … NOT NULL`** without a default — fails on a table with rows. Backfill first in the same migration.
- **`CREATE UNIQUE INDEX`** on a column that may have duplicates — fails at deploy. De-duplicate first.
- **`DROP CONSTRAINT … FOREIGN KEY`** with no matching `ADD CONSTRAINT` — a relation was removed. A drop paired with an add on the same table is just an `onDelete` change and is fine.

When in doubt, don't commit. Delete the generated folder, fix the schema, and generate again.

## What CI checks

The PR job `migrations` runs `pnpm db:check-migrations` against a throwaway Postgres whenever `packages/db/**` changes. Because PRs must be up to date with the base branch, it sees the merged result.

**Blocking:**

1. **Consistency** — the schema must match the database in two orders: **A** (all migrations, then all `contract.sql` files, which is what production ends up with) and **B** (the base branch with its deletions applied, then this PR's migrations, which is what the deploy does). A schema edit without a migration fails here. Before each scheduled deletion, path A also runs the deploy runner's own validation ("The deploy runner would refuse this scheduled deletion: …").
2. **Ordering** — every migration the PR adds sorts after the base branch's latest, and no two folders share a timestamp. Fix with `pnpm db:migrate:rebase`.
3. **Immutability** — no file in a migration folder already on the base branch was modified, renamed, deleted, or added (a `contract.sql` too).
4. **Applies with data** — base migrations and their deletions, then the fixture dataset in `packages/db/prisma/fixtures/`, then the PR's migrations and deletions. Rows must survive and backfilled columns keep their values. Extend the fixture when your migration touches a table.
5. **Safe for the running release** — fails anything in `migration.sql` that the release still running cannot tolerate (an in-place drop, rename or type change); SQL the analyzer cannot read unless the line above it is `-- knowledge-base:reviewed <reason>`; an unknown template version; a reused name that an earlier deletion removes; and a drop + add of a column (or a similar table), unless marked `-- intentional: drop and recreate`.

**Report-only:** a plain-English summary per migration in the job summary: "Changes now", "Deleted about 7 days after this deploys, once no older release is running", "Recovers …", "Reviewed by hand: … — attested by the author, not verified", and whether rollback to the previous release stays possible.

`-- knowledge-base:reviewed <reason>` is an attestation that the running release is unaffected, shown in the summary. Never annotate to silence a failure you have not understood.

**Before merge the agent shows that summary to the user** and says plainly what data, if any, will be lost or changed. Removals are listed as deleted about 7 days after deploy; say so plainly, and say whether rollback stays possible.

## Common mistakes

**"CI check 1 failed: schema and migrations differ."** You edited the schema but did not generate (or commit) the migration. Run `pnpm db:migrate <name>` and commit the folder.

**"CI check 2 failed after I rebased."** Someone merged a newer migration first. Run `pnpm db:migrate:rebase`, then `pnpm db:migrate:apply`, push.

**"I need to fix a migration I already merged."** You can't edit it. Write a new migration that corrects it.

**"My local database is out of sync / I want to start over."** `pnpm db:reset:local` — drops and rebuilds only this checkout's database, then seeds.

**"Types are stale after applying."** `pnpm db:migrate:apply` regenerates the client; if the editor still complains, restart the TypeScript server (or run `pnpm db:generate`).

**"Production refuses to start after my merge."** Read the log line: it names the state (`pending` with a migration the running release cannot tolerate, `failed`, `db-ahead`, `no-history-nonempty`). Follow [schema-migrations.md § Recovery runbook](./schema-migrations.md#recovery-runbook).

**"The startup log says a scheduled deletion needs a person."** The deletion failed 3 times in this release. Nothing was deleted. Write a fix migration, or stop and ask the owner ([schema-migrations.md § Recovery runbook](./schema-migrations.md#recovery-runbook)).

## See also

- [schema-migrations.md](./schema-migrations.md) — commands, markers, deploy states, expand and contract, baseline, recovery
- [AGENTS.md](../AGENTS.md) — naming, IDs, relations, indexes
- [backup-restore.md](./backup-restore.md) — backups before risky migrations, and restore
- [deploy-contract.md](./deploy.md) — how container platforms run migrations
- AGENTS.md § Dangerous Commands — Never Run These
