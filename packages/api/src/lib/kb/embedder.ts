import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@knowledge-base/db/client";
import { Secret } from "@knowledge-base/env/secret";
import { z } from "zod";
import { runLockedOperation } from "./authority-lock";
import {
  EmbedderCallError,
  EmbeddingUnavailableError,
  probeFailureCode,
  requestOpenAiEmbeddings,
} from "./embed-client";
import { decryptKbSecretWithEnvKey, type KbEncryptedRecord } from "./envelope";
import { withJobAttempt } from "./job-attempt";
import { claimJobAttempt, DurableJobFenceError } from "./jobs";
import type { LockQuery } from "./lock";
import { sqlAuthorityStore } from "./permissions";
import { assertLiveIdentity } from "./principal";
import { prepareEmbeddingDocument, prepareEmbeddingQuery } from "./redact-for-embed";

/** Both index and query consumers use a pinned revision through this interface. */
export interface Embedder {
  embed(
    texts: readonly string[],
    options: {
      purpose: "document" | "query";
      signal?: AbortSignal;
      beforeDispatch?: () => Promise<void>;
    },
  ): Promise<number[][]>;
  /**
   * Built-in model only: the model's own token count of each document
   * input (prefix/EOS included) and its configured input limit, so the chunker
   * can fit pieces to the context. Other providers keep their fixed windows.
   */
  measureInputs?(
    texts: readonly string[],
    options: { signal?: AbortSignal },
  ): Promise<{ counts: number[]; limit: number }>;
}
const pinSchema = z.strictObject({
  providerId: z.string().min(1),
  revision: z.number().int().positive(),
  ownerId: z.string().min(1),
});
type Pin = z.infer<typeof pinSchema>;
type Attempt = { jobId: string; workerId: string; epoch: number };
type Options = { connectionString: string; masterKey: string | undefined };
type Revision = {
  endpointUrl: string;
  model: string;
  dimensions: number;
  ciphertext: string;
  aadVersion: number;
  keyVersion: number;
};

function locked<T>(connectionString: string, run: (query: LockQuery) => Promise<T>): Promise<T> {
  return runLockedOperation({
    connectionString,
    opId: randomUUID(),
    kind: "authority",
    run: (lease) => lease.transaction(run),
  });
}

async function loadUsable(query: LockQuery, pin: Pin, attempt?: Attempt): Promise<Revision> {
  assertLiveIdentity(await sqlAuthorityStore(query).loadIdentity(pin.ownerId));
  // Authority -> job row. Dispatcher/heartbeat take only job rows; never the reverse order.
  const rows = await query<
    Revision & {
      jobId: string;
      state: string;
      workerOwner: string | null;
      attemptEpoch: number;
      liveLease: boolean;
    }
  >(
    `SELECT r."endpointUrl",r.model,r.dimensions,r.ciphertext,r."aadVersion",r."keyVersion",r."jobId",j.state,j."workerOwner",j."attemptEpoch",(j."leaseUntil">clock_timestamp() AND j."cancelledAt" IS NULL) AS "liveLease"
     FROM provider_revision r JOIN embedding_provider p ON p.id=r."providerId" JOIN durable_job j ON j.id=r."jobId"
     WHERE p.id=$1 AND r.version=$2 AND p."ownerId"=$3 AND r."ownerSnapshot"=$3 AND p."revokedAt" IS NULL AND r.ciphertext IS NOT NULL AND p.kind='OPENAI_COMPAT' FOR UPDATE OF j`,
    [pin.providerId, pin.revision, pin.ownerId],
  );
  const row = rows.rows[0];
  if (row?.keyVersion !== 1 || row.aadVersion !== 1) throw new EmbeddingUnavailableError();
  if (attempt) {
    if (
      row.jobId !== attempt.jobId ||
      row.state !== "RUNNING" ||
      row.workerOwner !== attempt.workerId ||
      row.attemptEpoch !== attempt.epoch ||
      !row.liveLease
    )
      throw new DurableJobFenceError();
  } else if (row.state !== "COMPLETE") throw new EmbeddingUnavailableError();
  return row;
}

async function execute(
  options: Options,
  pin: Pin,
  texts: readonly string[],
  signal?: AbortSignal,
  attempt?: Attempt,
  beforeDispatch?: () => Promise<void>,
): Promise<number[][]> {
  try {
    const config = await locked(options.connectionString, async (query) => {
      const row = await loadUsable(query, pin, attempt);
      return {
        endpointUrl: row.endpointUrl,
        model: row.model,
        dimensions: row.dimensions,
        // Held as a Secret: revealed only into the provider request header.
        apiKey: new Secret(
          decryptKbSecretWithEnvKey(
            JSON.parse(row.ciphertext) as KbEncryptedRecord,
            {
              aadVersion: row.aadVersion,
              purpose: "provider-secret",
              userId: pin.ownerId,
              objectId: pin.providerId,
              revision: String(pin.revision),
            },
            options.masterKey,
          ),
        ),
      };
    });
    // No locks across external IO. Admission precedes dispatch; revocation cannot recall
    // bytes already sent. Result publication rechecks authority and the same attempt fence.
    let vectors: number[][];
    try {
      await beforeDispatch?.();
      // The provider exchange tags its own failures (`EmbedderCallError`, embed-client.ts).
      vectors = await requestOpenAiEmbeddings(config, texts, signal);
    } finally {
      config.apiKey = new Secret("");
    }
    await locked(options.connectionString, async (query) => {
      await loadUsable(query, pin, attempt);
      if (signal?.aborted) throw new EmbeddingUnavailableError();
      if (attempt) {
        const completed = await query(
          `UPDATE durable_job SET state='COMPLETE',"completedAt"=now(),"workerOwner"=NULL,"leaseUntil"=NULL,"lastHeartbeatAt"=NULL,"dispatchOwner"=NULL,"dispatchClaimUntil"=NULL WHERE id=$1 AND "workerOwner"=$2 AND "attemptEpoch"=$3 AND state='RUNNING' AND "cancelledAt" IS NULL AND "leaseUntil">clock_timestamp()`,
          [attempt.jobId, attempt.workerId, attempt.epoch],
        );
        if (completed.rowCount !== 1) throw new DurableJobFenceError();
      }
    });
    return vectors;
  } catch (error) {
    if (error instanceof DurableJobFenceError || error instanceof EmbedderCallError) throw error;
    // Admission, authority and SQL work around the call: never the degradable tag. Keep the
    // failure reason (a stable code) for the owner's probe status.
    throw new EmbeddingUnavailableError(
      error instanceof EmbeddingUnavailableError ? error.reason : undefined,
    );
  }
}

/** Caller must authorize the KB before using its pinned profile; no mutable current-provider lookup. */
export function createProviderEmbedder(options: Options, pin: Pin): Embedder {
  const snapshot = pinSchema.parse(pin);
  return {
    embed: async (texts, { signal, purpose, beforeDispatch }) => {
      const safe = texts.map((text) =>
        purpose === "query" ? prepareEmbeddingQuery(text) : prepareEmbeddingDocument(text),
      );
      return execute(options, snapshot, safe, signal, undefined, beforeDispatch);
    },
  };
}

export async function runProviderProbeDelivery(
  db: PrismaClient,
  options: Options & { durableJobId: string; workerId: string },
) {
  try {
    const claimed = await claimJobAttempt(db, {
      jobId: options.durableJobId,
      workerId: options.workerId,
      now: new Date(),
    });
    if (!claimed) return { skipped: true };
    return await withJobAttempt(claimed, { db, workerId: options.workerId }, async () => {
      if (claimed.kind !== "PROVIDER_PROBE") throw new EmbeddingUnavailableError();
      const pin = pinSchema.safeParse(claimed.desired);
      if (!pin.success) throw new EmbeddingUnavailableError();
      try {
        await execute(options, pin.data, ["knowledge base provider probe"], undefined, {
          jobId: claimed.id,
          workerId: options.workerId,
          epoch: claimed.attemptEpoch,
        });
      } catch (error) {
        // The attempt's lastError becomes this stable code (never provider text),
        // which the owner's probe status turns into a specific reason.
        if (error instanceof EmbeddingUnavailableError && error.reason)
          throw new Error(probeFailureCode(error.reason));
        throw error;
      }
      return { ready: true };
    });
  } catch {
    throw new EmbeddingUnavailableError();
  }
}
