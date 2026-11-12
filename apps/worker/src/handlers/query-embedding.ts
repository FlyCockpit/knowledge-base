import { randomUUID } from "node:crypto";
import { degradableEmbedderError } from "@knowledge-base/api/lib/kb/embed-client";
import { createProviderEmbedder, type Embedder } from "@knowledge-base/api/lib/kb/embedder";
import { withJobAttempt } from "@knowledge-base/api/lib/kb/job-attempt";
import { claimJobAttempt, DurableJobFenceError } from "@knowledge-base/api/lib/kb/jobs";
import {
  completeQueryEmbedding,
  dispatchQueryEmbedding,
  failQueryEmbedding,
  type QueryEmbeddingOptions,
} from "@knowledge-base/api/lib/kb/query-embedding";
import prisma from "@knowledge-base/db";
import type { PrismaClient } from "@knowledge-base/db/client";
import { env } from "@knowledge-base/env/shared";
import { type QueryEmbeddingJobData, queryEmbeddingJobSchema } from "@knowledge-base/queue/jobs";
import type { Job } from "bullmq";

const workerId = `query-embedding:${randomUUID()}`;

function selectQueryEmbedder(
  pin: {
    kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN";
    providerId: string;
    revision: number;
    ownerId: string | null;
  },
  options: QueryEmbeddingOptions & { qwenEmbedder?: Embedder },
): Embedder {
  if (pin.kind === "SYSTEM_BUILTIN") {
    if (!options.qwenEmbedder) throw new DurableJobFenceError();
    return options.qwenEmbedder;
  }
  if (pin.ownerId === null) throw new DurableJobFenceError();
  return createProviderEmbedder(options, {
    providerId: pin.providerId,
    revision: pin.revision,
    ownerId: pin.ownerId,
  });
}
export async function runQueryEmbeddingDelivery(
  db: PrismaClient,
  options: QueryEmbeddingOptions & {
    durableJobId: string;
    workerId: string;
    signal?: AbortSignal;
    embedder?: Embedder;
    /** Forked-child adapter for SYSTEM_BUILTIN pins; absent => unavailable. */
    qwenEmbedder?: Embedder;
  },
) {
  const job = await claimJobAttempt(db, {
    jobId: options.durableJobId,
    workerId: options.workerId,
    now: new Date(),
  });
  if (!job) return { skipped: true };
  const attempt = { jobId: job.id, workerId: options.workerId, epoch: job.attemptEpoch };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let embedderFailed = false;
  try {
    return await withJobAttempt(job, { db, workerId: options.workerId }, async () => {
      try {
        if (job.kind !== "QUERY_EMBEDDING") throw new DurableJobFenceError();
        controller.signal.throwIfAborted();
        const pin = await dispatchQueryEmbedding(options, attempt);
        timer = setTimeout(abort, Math.max(1, pin.deadline.getTime() - Date.now()));
        const embedder = options.embedder ?? selectQueryEmbedder(pin, options);
        let vectors: number[][];
        try {
          vectors = await embedder.embed([pin.text], {
            purpose: "query",
            signal: controller.signal,
            beforeDispatch: async () => {
              controller.signal.throwIfAborted();
              await dispatchQueryEmbedding(options, attempt);
              controller.signal.throwIfAborted();
            },
          });
        } catch (error) {
          // Closed classification: only the adapter's tagged provider/model call failure
          // (not its admission, authority or SQL work, a fence, or the request's deadline) is
          // the degradable EMBEDDING_UNAVAILABLE closure.
          embedderFailed = degradableEmbedderError(error, "query") && !controller.signal.aborted;
          throw error;
        }
        controller.signal.throwIfAborted();
        return await completeQueryEmbedding(options, attempt, vectors);
      } catch {
        // This CAS cannot scrub a successor's request. Never leak provider errors to Redis/logs.
        await failQueryEmbedding(options, attempt, { embedder: embedderFailed }).catch(() => {});
        throw new DurableJobFenceError("Query embedding unavailable");
      }
    });
  } finally {
    clearTimeout(timer);
    abort();
    options.signal?.removeEventListener("abort", abort);
  }
}
export function handleQueryEmbeddingJob(
  job: Job<QueryEmbeddingJobData>,
  signal?: AbortSignal,
  qwenEmbedder?: Embedder,
) {
  const { durableJobId } = queryEmbeddingJobSchema.parse(job.data);
  return runQueryEmbeddingDelivery(prisma, {
    durableJobId,
    workerId,
    signal,
    qwenEmbedder,
    connectionString: env.DATABASE_URL.reveal(),
    masterKey: env.KB_MASTER_KEY?.reveal(),
  });
}
