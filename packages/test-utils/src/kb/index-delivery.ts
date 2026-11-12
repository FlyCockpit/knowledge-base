import { runIndexBuildDelivery } from "@knowledge-base/api/lib/kb/index-build";

type Db = Parameters<typeof runIndexBuildDelivery>[0];
type Options = Parameters<typeof runIndexBuildDelivery>[1];
type Result = Awaited<ReturnType<typeof runIndexBuildDelivery>>;

const isSkipped = (result: Result) =>
  typeof result === "object" && result !== null && "skipped" in result && result.skipped === true;

/**
 * Delivers one INDEX_KB job as the worker eventually does: a semantic build is not
 * claimed while its lexical companion (one epoch below) is unbuilt, and the dispatcher
 * redelivers it after the companion built. This publishes and delivers a pending companion
 * first (without the caller's hooks or embedder), then delivers the job itself.
 *
 * A skipped delivery fails loudly: it means nothing was built, so a test asserting on the
 * build would otherwise pass or fail for the wrong reason. Tests that expect the skip (a held
 * permit or slot) pass `{ skipped: true }`, which then requires it. Use `runIndexBuildDelivery`
 * directly to observe the companion dependency itself.
 */
export async function deliverIndexBuild(
  db: Db,
  options: Options,
  expected: { skipped?: boolean } = {},
): Promise<Result> {
  const expectSkip = expected.skipped === true;
  const job = await db.durableJob.findUnique({ where: { id: options.durableJobId } });
  const desired = (job?.desired ?? null) as { kbId?: string; epoch?: string; mode?: string } | null;
  if (job?.kind === "INDEX_KB" && desired?.kbId && desired.epoch && desired.mode !== "lexical") {
    const companion = await db.indexGeneration.findFirst({
      where: {
        kbId: desired.kbId,
        epoch: BigInt(desired.epoch) - 1n,
        providerId: null,
        state: "PENDING",
      },
    });
    if (companion?.jobId) {
      // Fixture publication of the companion, as the dispatcher does for every PENDING job.
      await db.durableJob.updateMany({
        where: { id: companion.jobId, state: { in: ["PENDING", "RETRY"] } },
        data: { state: "PUBLISHED" },
      });
      // A companion that fails on its own (e.g. the chunk limit) leaves the job to fail alike.
      const built = await runIndexBuildDelivery(db, {
        connectionString: options.connectionString,
        reposDir: options.reposDir,
        indexDir: options.indexDir,
        masterKey: options.masterKey,
        workerId: `${options.workerId}:companion`,
        durableJobId: companion.jobId,
      }).catch(() => null);
      if (built && isSkipped(built) && !expectSkip)
        throw new Error("Lexical companion delivery was skipped; nothing was built");
    }
  }
  const result = await runIndexBuildDelivery(db, options);
  if (isSkipped(result) !== expectSkip)
    throw new Error(
      expectSkip
        ? "Index build delivery was expected to skip but ran"
        : "Index build delivery was skipped; nothing was built",
    );
  return result;
}
