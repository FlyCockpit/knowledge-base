/**
 * Reads the scheduled data deletions the migration runner has carried out and
 * nobody has been told about yet, and records each one once its email went out
 * (docs/schema-migrations.md § Getting told when data is deleted).
 *
 * The runner sets `_knowledge_base_migration.contract_applied_at` when a
 * `contract.sql` runs and never writes `contract_notified_at`, which is
 * reserved for this module. Until a migration runner has created this table,
 * every read returns nothing.
 *
 * Delivery is AT LEAST ONCE: the caller reads, sends, and only then marks a
 * row (`markDataDeletionNotified`). A crash between the send and the mark
 * means that deletion is emailed again on the next run — a rare duplicate is
 * accepted over a lost notice. Parallel duplicates are kept out by the single
 * job scheduler and the consumer's concurrency 1 (apps/worker/src/runtime.ts),
 * plus the per-deletion alert cooldown in apps/worker/src/operational-alerts.ts.
 */
import prisma from "./index";
import { runnerSchema, runnerTable } from "./runner-tables";

/** Upper bound on notices read per call; the rest wait for the next call. */
export const DATA_DELETION_NOTICE_LIMIT = 20;

/**
 * Only deletions that ran within this many days are announced. Older ones
 * (including every deletion from before this feature existed, which were never
 * marked) are ignored, so turning the feature on never floods admins with
 * history, and a notice nobody could receive stops retrying after this window.
 */
export const DATA_DELETION_NOTICE_WINDOW_DAYS = 14;

export type DataDeletionNotice = {
  /** The migration folder whose contract.sql ran. */
  name: string;
  /** One human line naming what was deleted; null for rows recorded without it. */
  effects: string | null;
  deletedAt: Date;
  /** Label of the backup taken just before; null when none was configured. */
  backup: string | null;
  note: string | null;
};

type NoticeRow = {
  name: string;
  contract_effects: string | null;
  contract_applied_at: Date;
  contract_backup: string | null;
  contract_note: string | null;
};

/**
 * Up to `limit` recent (see {@link DATA_DELETION_NOTICE_WINDOW_DAYS}) applied,
 * unnotified deletions, oldest first. Reads only — nothing is marked. Returns
 * `[]` when the runner's table, or its `contract_notified_at` column, does not
 * exist.
 */
export async function listUnnotifiedDataDeletions(
  limit: number = DATA_DELETION_NOTICE_LIMIT,
  now: Date = new Date(),
): Promise<DataDeletionNotice[]> {
  const present = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = ${runnerSchema()}
         AND table_name = '_knowledge_base_migration'
         AND column_name = 'contract_notified_at'
    ) AS present`;
  if (present[0]?.present !== true) return [];

  const since = new Date(now.getTime() - DATA_DELETION_NOTICE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<NoticeRow[]>`
    SELECT name, contract_effects, contract_applied_at, contract_backup, contract_note
      FROM ${runnerTable("_knowledge_base_migration")}
     WHERE contract_applied_at >= ${since} AND contract_notified_at IS NULL
     ORDER BY contract_applied_at, name
     LIMIT ${Math.max(1, Math.min(DATA_DELETION_NOTICE_LIMIT, Number.isFinite(limit) ? Math.trunc(limit) : DATA_DELETION_NOTICE_LIMIT))}`;
  return rows.map((row) => ({
    name: row.name,
    effects: row.contract_effects,
    deletedAt: new Date(row.contract_applied_at),
    backup: row.contract_backup,
    note: row.contract_note,
  }));
}

/**
 * Record that one deletion's email went out. Idempotent: a row already marked
 * keeps its first timestamp.
 */
export async function markDataDeletionNotified(name: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE ${runnerTable("_knowledge_base_migration")} SET contract_notified_at = now()
     WHERE name = ${name} AND contract_notified_at IS NULL`;
}
