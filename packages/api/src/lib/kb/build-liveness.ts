import type { PrismaClient } from "@knowledge-base/db/client";

import type { LockQuery } from "./lock";
import { releaseQuota } from "./quota";

/**
 * One liveness rule for index builds (R5 review). A generation's own state
 * says how far its build got; only its durable job says whether anything will
 * still run it. Every "is there pending build work" decision uses
 * `inProgressBuildSql` (or the two state lists below), never the generation
 * state alone.
 */
export const UNFINISHED_GENERATION_STATES = ["PENDING", "BUILDING", "INDEXING"] as const;
/** Nonterminal durable job states: the job can still run (or is running). */
export const LIVE_JOB_STATES = ["PENDING", "PUBLISHED", "RUNNING", "RETRY"] as const;

const list = (states: readonly string[]) => `(${states.map((s) => `'${s}'`).join(",")})`;
/** SQL lists of the two state sets, for `state IN ${...}`. */
export const LIVE_JOB_STATES_SQL = list(LIVE_JOB_STATES);
export const UNFINISHED_GENERATION_STATES_SQL = list(UNFINISHED_GENERATION_STATES);

/** The in-progress build predicate over a generation alias and its job alias. */
export function inProgressBuildSql(generation: string, job: string): string {
  return `(${generation}.state IN ${UNFINISHED_GENERATION_STATES_SQL} AND ${job}.state IN ${LIVE_JOB_STATES_SQL})`;
}

/** `inProgressBuildSql` for states already read. */
export function isInProgressBuild(generationState: string, jobState: string): boolean {
  return (
    (UNFINISHED_GENERATION_STATES as readonly string[]).includes(generationState) &&
    (LIVE_JOB_STATES as readonly string[]).includes(jobState)
  );
}

/**
 * Settles an unfinished generation whose durable job is terminal, or is being
 * made terminal in this same transaction: it becomes FAILED (a cancelled job's
 * as `INDEX_BUILD_CANCELLED`, otherwise `errorCode`) and its disk
 * reservations are released in the statement that clears them (I1). Never
 * waits: returns false, changing nothing, when the generation's build fence or
 * one of its volume accounts is held elsewhere (the caller retries later).
 * `requireDeadJob` re-checks the job in the final compare-and-set, for callers
 * that do not hold the job row themselves.
 */
export async function failDeadBuildGeneration(
  query: LockQuery,
  generationId: string,
  options: { errorCode: string; requireDeadJob: boolean },
): Promise<boolean> {
  // The generation fence is a try-lock (the guard trigger's own try-lock is
  // then re-entrant), so a fenced worker transaction is never waited on.
  const fenced = await query<{ ok: boolean }>(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 23)) AS ok",
    [generationId],
  );
  if (!fenced.rows[0]?.ok) return false;
  const deadJob = options.requireDeadJob
    ? `AND NOT EXISTS (SELECT FROM durable_job j WHERE j.id = g."jobId" AND j.state IN ${LIVE_JOB_STATES_SQL})`
    : "";
  const row = (
    await query<{ ids: string[] }>(
      `SELECT g."quotaReservationIds" AS ids FROM index_generation g
        WHERE g.id = $1 AND g.state IN ${UNFINISHED_GENERATION_STATES_SQL} ${deadJob}`,
      [generationId],
    )
  ).rows[0];
  if (!row) return false;
  if (row.ids.length > 0) {
    // Never wait on a volume account a live reservation transaction holds
    // (reserveQuota locks it until COMMIT): take every account the release
    // needs without waiting, or leave the row for a later pass.
    const accounts = await query<{ total: number; locked: number }>(
      `WITH wanted AS (
         SELECT DISTINCT r."accountId" AS id FROM quota_reservation r WHERE r.id = ANY($1::text[])),
       taken AS (
         SELECT a.id FROM quota_account a WHERE a.id IN (SELECT id FROM wanted)
         FOR UPDATE OF a SKIP LOCKED)
       SELECT (SELECT count(*) FROM wanted)::int AS total, (SELECT count(*) FROM taken)::int AS locked`,
      [row.ids],
    );
    const taken = accounts.rows[0];
    if (!taken || taken.locked !== taken.total) return false;
    await releaseQuota({ transactionQuery: query }, row.ids);
  }
  const settled = await query<{ id: string }>(
    `UPDATE index_generation g
        SET state = 'FAILED', "quotaReservationIds" = '{}',
            "errorCode" = COALESCE(g."errorCode",
              CASE (SELECT j.state::text FROM durable_job j WHERE j.id = g."jobId")
                WHEN 'CANCELLED' THEN 'INDEX_BUILD_CANCELLED' ELSE $3 END)
      WHERE g.id = $1 AND g.state IN ${UNFINISHED_GENERATION_STATES_SQL}
        AND g."quotaReservationIds" = $2::text[] ${deadJob}
      RETURNING g.id`,
    [generationId, row.ids, options.errorCode],
  );
  return settled.rows.length === 1;
}

/**
 * A `LockQuery` over a Prisma interactive transaction, for shared domain SQL
 * that runs inside one (the dispatcher's claim transaction). Statements that
 * return rows (SELECT, VALUES or RETURNING) report them; any other statement
 * reports its affected row count.
 */
export function prismaTransactionQuery(
  tx: Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">,
): LockQuery {
  return (async (text: string, values: unknown[] = []) => {
    if (/^\s*(SELECT|WITH|VALUES)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
      const rows = await tx.$queryRawUnsafe<unknown[]>(text, ...values);
      return { rows, rowCount: rows.length };
    }
    const rowCount = await tx.$executeRawUnsafe(text, ...values);
    return { rows: [], rowCount };
  }) as LockQuery;
}
