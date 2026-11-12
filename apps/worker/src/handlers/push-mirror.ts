import { randomUUID } from "node:crypto";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { decryptDeployKey } from "@knowledge-base/api/lib/kb/deploy-key";
import { requireKbMasterKey } from "@knowledge-base/api/lib/kb/envelope";
import { kbBareRepoPath } from "@knowledge-base/api/lib/kb/git-read";
import {
  claimJobAttempt,
  completeJobAttempt,
  failJobAttempt,
  heartbeatJobAttempt,
} from "@knowledge-base/api/lib/kb/jobs";
import { finishMirrorAttempt, reserveMirrorAttempt } from "@knowledge-base/api/lib/kb/mirror";
import prisma from "@knowledge-base/db";
import type { PrismaClient } from "@knowledge-base/db/client";
import { env } from "@knowledge-base/env/shared";
import { kbDataPaths } from "@knowledge-base/env/topology";
import { type PushMirrorJobData, pushMirrorJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";
import {
  MIRROR_TMPFS,
  MirrorDrainError,
  type MirrorOutcome,
  type MirrorTransportInput,
  recoverMirrorScratch,
  runMirrorSsh,
} from "../lib/mirror-ssh";

const workerId = `mirror:${randomUUID()}`;
export async function runMirrorDelivery(
  db: PrismaClient,
  options: {
    durableJobId: string;
    workerId: string;
    connectionString: string;
    reposDir: string;
    masterKey?: string;
    signal?: AbortSignal;
    scratchRoot?: string;
    transport?: (input: MirrorTransportInput) => Promise<MirrorOutcome>;
  },
) {
  const job = await claimJobAttempt(db, {
    jobId: options.durableJobId,
    workerId: options.workerId,
    now: new Date(),
  });
  if (!job) return { skipped: true };
  const a = await db.mirrorAttempt.findUniqueOrThrow({ where: { id: job.id } });
  const action =
    job.desired && typeof job.desired === "object" && "action" in job.desired
      ? job.desired.action
      : null;
  if (job.kind !== "PUSH_MIRROR" || (action !== "PUSH" && action !== "ACTIVATE"))
    throw new Error("Invalid mirror job");
  const fence = { jobId: job.id, workerId: options.workerId, attemptEpoch: job.attemptEpoch };
  const controller = new AbortController(),
    abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let monitoring = true,
    monitorPending = false,
    chain = Promise.resolve(),
    reserved = false,
    uncertainPush = false,
    safeToSettle = false;
  let result: MirrorOutcome | { state: "CANCELLED"; resultCode: string } = {
    state: "CANCELLED",
    resultCode: "AUTHORITY_CHANGED",
  };
  const timer = setInterval(() => {
    if (monitorPending) return;
    monitorPending = true;
    chain = Promise.resolve()
      .then(async () => {
        if (!monitoring) return;
        if (!(await heartbeatJobAttempt(db, { ...fence, now: new Date() }))) abort();
        const remote = await db.kbRemote.findUnique({ where: { kbId: a.kbId } });
        if (!remote || remote.state === "DISCONNECTED") abort();
      })
      .catch(abort)
      .finally(() => {
        monitorPending = false;
      });
  }, 250);
  try {
    await runLockedOperation({
      connectionString: options.connectionString,
      opId: randomUUID(),
      kind: "kb-write",
      kbIds: [a.kbId],
      // Do not cancel lock cleanup on shutdown: all exits still settle retired keys.
      barrier: {
        prepare: async () => {
          await recoverMirrorScratch(a.id, options.scratchRoot ?? MIRROR_TMPFS);
          safeToSettle = true;
        },
        reauthorize: async () => {},
        reservePublication: async ({ query }) => {
          const live = (
            await query<{ state: string }>(
              `SELECT state::text AS state FROM kb_mirror_attempt WHERE id=$1::uuid`,
              [a.id],
            )
          ).rows[0];
          uncertainPush =
            action === "PUSH" && (live?.state === "RESERVED" || live?.state === "UNKNOWN");
          if (live?.state === "RESERVED") {
            // A previous execution released its KB lock (or crashed). The helper
            // has drained above; retain UNKNOWN until remote SHA reconciliation.
            await finishMirrorAttempt(query, {
              attemptId: a.id,
              state: "UNKNOWN",
              resultCode: "WORKER_RESTART",
            });
            result = { state: "UNKNOWN", resultCode: "WORKER_RESTART" };
          } else if (live?.state === "UNKNOWN")
            result = { state: "UNKNOWN", resultCode: "REMOTE_OUTCOME_UNKNOWN" };
          else if (live?.state !== "QUEUED") {
            result = {
              state: live?.state === "COMPLETED" ? "COMPLETED" : "CANCELLED",
              resultCode: "SETTLED",
            };
            return;
          }
          const owned = (
            await query(
              `SELECT id FROM durable_job WHERE id=$1 AND state='RUNNING' AND "workerOwner"=$2 AND "attemptEpoch"=$3 AND "leaseUntil">now()`,
              [job.id, options.workerId, job.attemptEpoch],
            )
          ).rows.length;
          if (!owned || controller.signal.aborted) return;
          reserved = await reserveMirrorAttempt(query, { attemptId: a.id });
        },
      },
      run: async (lease) => {
        if (!reserved) return;
        const stop = () => abort();
        lease.scope.signal.addEventListener("abort", stop, { once: true });
        const master = requireKbMasterKey(options.masterKey);
        try {
          const key = await db.deployKeyVersion.findUniqueOrThrow({ where: { id: a.keyId } });
          const seed = decryptDeployKey(key.ciphertext!, key, master);
          try {
            // The pre-dispatch sweep cannot acknowledge newly admitted work.
            safeToSettle = false;
            result = await (options.transport ?? runMirrorSsh)({
              attemptId: a.id,
              canonicalRepo: kbBareRepoPath(options.reposDir, a.kbId),
              url: key.url,
              hostKeys: key.hostKeys,
              seed,
              sha: a.mainSha,
              activate: action === "ACTIVATE",
              signal: controller.signal,
            });
          } finally {
            seed.destroy();
            // The preparation acknowledgement precedes this execution. Acquire
            // a fresh one under its KB lease, even when transport throws.
            await recoverMirrorScratch(a.id, options.scratchRoot ?? MIRROR_TMPFS);
            safeToSettle = true;
          }
        } finally {
          master.fill(0);
          lease.scope.signal.removeEventListener("abort", stop);
        }
      },
    });
  } catch (error) {
    if (!safeToSettle || error instanceof MirrorDrainError)
      throw new MirrorDrainError("Mirror drain unconfirmed"); // leave RESERVED until a proven drain
    result = { state: reserved ? "UNKNOWN" : "CANCELLED", resultCode: "EXECUTION_UNAVAILABLE" };
  } finally {
    monitoring = false;
    clearInterval(timer);
    await chain;
    options.signal?.removeEventListener("abort", abort);
  }
  // A later probe/rejection cannot disprove an earlier accepted-but-unacknowledged
  // push. Only successful remote-SHA reconciliation closes that logical outcome.
  if (uncertainPush && (result.state === "FAILED" || result.state === "CANCELLED"))
    result = { state: "UNKNOWN", resultCode: "REMOTE_OUTCOME_UNKNOWN" };
  // Lock order: release execution's KB lease before reacquiring authority.
  // No key is destroyed until the transport/helper has joined every child.
  await runLockedOperation({
    connectionString: options.connectionString,
    opId: randomUUID(),
    kind: "authority",
    run: (lease) =>
      lease.transaction(async (query) => {
        const owned = (
          await query(
            `SELECT id FROM durable_job WHERE id=$1 AND "workerOwner"=$2 AND "attemptEpoch"=$3 FOR UPDATE`,
            [job.id, options.workerId, job.attemptEpoch],
          )
        ).rows.length;
        if (owned)
          await finishMirrorAttempt(query, {
            attemptId: a.id,
            ...result,
            activate: action === "ACTIVATE",
          });
      }),
  });
  if (result.state === "UNKNOWN" && !controller.signal.aborted)
    await failJobAttempt(db, {
      ...fence,
      now: new Date(),
      error: "Mirror outcome unknown; inspect remote",
    });
  else await completeJobAttempt(db, { ...fence, now: new Date() });
  return result;
}
export function handlePushMirrorJob(job: Job<PushMirrorJobData>, signal?: AbortSignal) {
  return runMirrorDelivery(prisma, {
    ...pushMirrorJobSchema.parse(job.data),
    workerId,
    signal,
    connectionString: env.DATABASE_URL.reveal(),
    reposDir: kbDataPaths(env.KB_DATA_ROOT).reposDir,
    masterKey: env.KB_MASTER_KEY?.reveal(),
  });
}

/** Startup inventory includes exhausted durable jobs: retries are not a cleanup
 * guarantee. One page at a time, serialized behind each KB execution lease. */
export async function recoverMirrorReservations(
  db: PrismaClient,
  connectionString: string,
  root = MIRROR_TMPFS,
) {
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.mirrorAttempt.findMany({
      where: { state: "RESERVED", ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: 50,
      select: { id: true, kbId: true },
    });
    if (!rows.length) return;
    for (const row of rows)
      await runLockedOperation({
        connectionString,
        opId: randomUUID(),
        kind: "kb-write",
        kbIds: [row.kbId],
        barrier: {
          prepare: () => recoverMirrorScratch(row.id, root),
          reauthorize: async () => {},
          reservePublication: async ({ query }) => {
            const still = (
              await query(
                `SELECT id FROM kb_mirror_attempt WHERE id=$1::uuid AND state='RESERVED'`,
                [row.id],
              )
            ).rows.length;
            if (still)
              await finishMirrorAttempt(query, {
                attemptId: row.id,
                state: "UNKNOWN",
                resultCode: "WORKER_RESTART",
              });
          },
        },
        run: async () => {},
      });
    cursor = rows.at(-1)!.id;
  }
}
