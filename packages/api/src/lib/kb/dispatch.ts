import type { DurableJobKind, PrismaClient } from "@knowledge-base/db/client";
import { ensureRunnableJob } from "@knowledge-base/queue/ensure-job";
import { Client, type Notification } from "pg";
import {
  bullmqNameForDurableKind,
  claimDispatchBatch,
  DURABLE_DISPATCH_CHANNEL,
  durableBullmqJobId,
  durableQueuePayloadSchema,
  markDispatchPublished,
  queueNameForDurableKind,
  releaseDispatchClaim,
} from "./jobs.js";

export type DurableDispatcherHooks = {
  afterClaim?: (jobId: string) => void | Promise<void>;
  beforePublish?: (jobId: string) => void | Promise<void>;
  afterPublish?: (jobId: string) => void | Promise<void>;
};

export type DurableDispatcherDeps = {
  db: Pick<PrismaClient, "$transaction" | "durableJob"> & Parameters<typeof claimDispatchBatch>[0];
  ownerId: string;
  now: () => Date;
  getQueue: (queueName: string) => Parameters<typeof ensureRunnableJob>[0];
  hooks?: DurableDispatcherHooks;
};

export async function publishDurableRow(
  deps: DurableDispatcherDeps,
  row: { id: string; kind: DurableJobKind; attemptEpoch: number },
): Promise<void> {
  const queueName = queueNameForDurableKind(row.kind);
  const queue = deps.getQueue(queueName);
  const payload = durableQueuePayloadSchema.parse({ durableJobId: row.id });
  const jobId = durableBullmqJobId(row.id, row.attemptEpoch);
  await ensureRunnableJob(queue, bullmqNameForDurableKind(row.kind), payload, jobId);
}

export async function runDurableDispatcherCycle(deps: DurableDispatcherDeps): Promise<number> {
  const now = deps.now();
  const batch = await claimDispatchBatch(deps.db, { owner: deps.ownerId, now });
  let published = 0;
  for (const row of batch) {
    try {
      await deps.hooks?.afterClaim?.(row.id);
      // Make the durable attempt claimable BEFORE Redis can deliver it. A
      // worker can finish before Queue.add resumes; acknowledging afterwards
      // made that first delivery skip PENDING and wait for the next 2 s poll.
      // A crash/add failure here leaves PUBLISHED, which the dispatcher scans
      // and republishes idempotently. It never loses the durable demand.
      const marked = await markDispatchPublished(deps.db, {
        jobId: row.id,
        owner: deps.ownerId,
        now: deps.now(),
      });
      if (!marked) continue;
      await deps.hooks?.beforePublish?.(row.id);
      await publishDurableRow(deps, row);
      await deps.hooks?.afterPublish?.(row.id);
      published += 1;
    } catch {
      await releaseDispatchClaim(deps.db, { jobId: row.id, owner: deps.ownerId });
    }
  }
  return published;
}

export type DispatchWakeListener = { close(): Promise<void> };

/**
 * R3-W4: LISTEN on the durable enqueue channel and call `onWake` for every notification, and once
 * after each (re)connect so nothing committed while disconnected waits for the poll. Connecting
 * and LISTEN together are bounded by `setupMs` (a stalled server or handshake ends that client and
 * retries); a lost connection retries after `retryMs`. The dispatcher's poll keeps working
 * meanwhile. `close()` ends the current client first (also one still connecting), then waits for
 * it to settle, bounded by `setupMs`.
 */
export function listenForDispatchWake(
  connectionString: string,
  onWake: () => void,
  options: {
    retryMs?: number;
    setupMs?: number;
    applicationName?: string;
    /** Test seam only: the transport each client connects through. */
    stream?: () => import("node:stream").Duplex;
  } = {},
): DispatchWakeListener {
  const retryMs = options.retryMs ?? 5_000;
  const setupMs = options.setupMs ?? 10_000;
  let closed = false;
  let client: Client | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let connecting: Promise<void> = Promise.resolve();
  const reconnect = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      connecting = connect();
    }, retryMs);
    retry.unref?.();
  };
  const connect = async () => {
    if (closed) return;
    const next = new Client({
      connectionString,
      application_name: options.applicationName ?? "kb-dispatch-wake",
      connectionTimeoutMillis: setupMs,
      query_timeout: setupMs,
      ...(options.stream ? { stream: options.stream } : {}),
    });
    client = next;
    let gone = false;
    const lost = () => {
      if (gone) return;
      gone = true;
      if (client === next) client = null;
      void next.end().catch(() => {});
      reconnect();
    };
    next.on("error", lost);
    next.on("end", lost);
    next.on("notification", (message: Notification) => {
      if (message.channel === DURABLE_DISPATCH_CHANNEL) onWake();
    });
    // The whole setup (TCP, TLS, startup, authentication and LISTEN) has one bound.
    const stalled = setTimeout(() => lost(), setupMs);
    stalled.unref?.();
    try {
      await next.connect();
      await next.query(`LISTEN ${DURABLE_DISPATCH_CHANNEL}`);
      clearTimeout(stalled);
      if (closed || gone) {
        await next.end().catch(() => {});
        return;
      }
      onWake();
    } catch {
      clearTimeout(stalled);
      lost();
    }
  };
  connecting = connect();
  return {
    async close() {
      closed = true;
      clearTimeout(retry);
      // Cancel the current client actively (a pending handshake included), then join it.
      const current = client;
      client = null;
      const ended = current?.end().catch(() => {});
      let bound: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([connecting.catch(() => {}), ended]),
        new Promise<void>((resolve) => {
          bound = setTimeout(resolve, setupMs);
          bound.unref?.();
        }),
      ]);
      clearTimeout(bound);
    },
  };
}
