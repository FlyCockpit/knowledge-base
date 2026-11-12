import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { KbAdmissionError } from "./principal";

const GIB = 1n << 30n;

/** Maximum staged Markdown upload size. */
export const STAGED_MARKDOWN_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/** Total staged Markdown bytes allowed in one changes_apply edit batch. */
export const STAGED_MARKDOWN_BATCH_MAX_BYTES = 16 * 1024 * 1024;

/** Whole-tree validator budgets (enforced during traversal, before materialization). */
export const KB_TREE_LIMITS = {
  maxFiles: 4096,
  maxEntries: 8192,
  maxTreeDepth: 32,
  maxMarkdownBytes: 2 * 1024 * 1024,
  maxTreeBytes: 64 * 1024 * 1024,
  maxNewCommitsPerPush: 512,
  maxObjects: 100_000,
  maxUncompressedObjectBytes: 128 * 1024 * 1024,
} as const;

/** Maximum immutable CAS blob size. */
export const CAS_BLOB_MAX_BYTES = 25 * 1024 * 1024;

export const KB_LIMITS = {
  ownedLiveKbsPerUser: 20,
  branchesPerKb: 100,
  sharesPerKb: 1024,
  activePatsPerUser: 10,
  providersPerUser: 20,
  /** Immutable revision rows per provider (create + probes). */
  providerRevisionsPerProvider: 50,
  /** Immutable revision rows per owner across all providers (survives revoke). */
  providerRevisionsPerUser: 1000,
  gitHistoryBytesPerKb: GIB,
  casLineageBytesPerKb: GIB,
  casLineageBytesPerOwner: 5n * GIB,
  freeDiskFloorBytes: GIB,
  createsPerHourPerUser: 5,
  queriesPerMinutePerUserKb: 30,
  queryInFlightPerUser: 4,
  rebuildsPerHourPerKb: 3,
  probesPerMinutePerUser: 5,
  mutationsPerMinutePerActorKb: 60,
  uploadBytesPerHourPerUser: 100n << 20n,
  workerIndexConcurrency: 2,
  workerIndexPerKb: 1,
  workerQueryConcurrency: 4,
  workerModelChild: 1,
  workerDownloads: 1,
  workerMirrors: 2,
  workerExports: 2,
  /** Reader threads in the server's SQLite index pool (§1.6); at most n-1 run large tasks. */
  serverIndexReaders: 2,
  /** Chunk limit applied when a KB stores none and when an admin ceiling is absent (§1.9). */
  indexChunksDefault: 400_000,
  /**
   * Dirents the index reconciler reads from one `index/<kbId>/` directory per visit. A directory
   * holds only its retained and building generations' files (final, temp, journal), so more is
   * an anomaly: it is skipped with a warning instead of being read without bound.
   */
  indexDirEntryCap: 10_000,
  /** Hard per-quantization chunk bounds; no ceiling or KB limit can exceed them (decision 22). */
  indexChunkBound: {
    int8: 200_000,
    binary_int8_rescore: 400_000,
  },
} as const;

/**
 * binary_int8_rescore candidates: K(n) = min(max, max(min, ceil(n / chunksPerCandidate))).
 * Mirrored by the CLI `limits.rs` (drift test pattern).
 */
export const KB_INDEX_RESCORE = {
  minCandidates: 200,
  maxCandidates: 2000,
  chunksPerCandidate: 200,
} as const;

export type RateChargeKind = "create" | "query" | "rebuild" | "probe" | "mutation" | "upload";

export type RateCharge = {
  kind: RateChargeKind;
  key: string;
  points?: number;
};

export type RateConsumeResult =
  | { ok: true }
  | { retryAfterSeconds: number }
  | { unavailable: true };

export type RatePort = {
  consume(bucket: string, key: string, points: number): Promise<RateConsumeResult>;
};

const WINDOWS: Record<RateChargeKind, { bucket: string; points: number; durationSeconds: number }> =
  {
    create: { bucket: "kb:create", points: KB_LIMITS.createsPerHourPerUser, durationSeconds: 3600 },
    query: {
      bucket: "kb:query",
      points: KB_LIMITS.queriesPerMinutePerUserKb,
      durationSeconds: 60,
    },
    rebuild: {
      bucket: "kb:rebuild",
      points: KB_LIMITS.rebuildsPerHourPerKb,
      durationSeconds: 3600,
    },
    probe: { bucket: "kb:probe", points: KB_LIMITS.probesPerMinutePerUser, durationSeconds: 60 },
    mutation: {
      bucket: "kb:mutation",
      points: KB_LIMITS.mutationsPerMinutePerActorKb,
      durationSeconds: 60,
    },
    upload: {
      bucket: "kb:upload",
      points: Number(KB_LIMITS.uploadBytesPerHourPerUser),
      durationSeconds: 3600,
    },
  };

export function createMemoryRatePort(): RatePort & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async consume(bucket, key, points) {
      const window = Object.values(WINDOWS).find((item) => item.bucket === bucket);
      if (!window) return { unavailable: true };
      const id = `${bucket}:${key}`;
      const next = (counts.get(id) ?? 0) + points;
      if (next > window.points) return { retryAfterSeconds: window.durationSeconds };
      counts.set(id, next);
      return { ok: true };
    },
  };
}

export function createRedisRatePort(storeClient: object): RatePort {
  const limiters = new Map<string, RateLimiterRedis>();
  const limiter = (kind: RateChargeKind): RateLimiterRedis => {
    const spec = WINDOWS[kind];
    let found = limiters.get(spec.bucket);
    if (!found) {
      found = new RateLimiterRedis({
        storeClient,
        keyPrefix: spec.bucket,
        points: spec.points,
        duration: spec.durationSeconds,
      });
      limiters.set(spec.bucket, found);
    }
    return found;
  };
  return {
    async consume(bucket, key, points) {
      const kind = (Object.keys(WINDOWS) as RateChargeKind[]).find(
        (item) => WINDOWS[item].bucket === bucket,
      );
      if (!kind) return { unavailable: true };
      try {
        await limiter(kind).consume(key, points);
        return { ok: true };
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          return { retryAfterSeconds: Math.max(1, Math.ceil(error.msBeforeNext / 1000)) };
        }
        return { unavailable: true };
      }
    },
  };
}

export async function chargeRate(port: RatePort, charge: RateCharge): Promise<void> {
  const spec = WINDOWS[charge.kind];
  const result = await port.consume(spec.bucket, charge.key, charge.points ?? 1);
  if ("ok" in result) return;
  if ("unavailable" in result) {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Rate limiter unavailable");
  }
  throw new KbAdmissionError("RATE_LIMITED", "Rate limited", result.retryAfterSeconds);
}

export async function chargeKbMutation(
  port: RatePort,
  actorKey: string,
  kbId: string,
): Promise<void> {
  await chargeRate(port, { kind: "mutation", key: `${actorKey}:${kbId}` });
}

export async function chargeKbUpload(
  port: RatePort,
  userId: string,
  decodedBytes: number,
): Promise<void> {
  if (decodedBytes <= 0) return;
  await chargeRate(port, { kind: "upload", key: `user:${userId}`, points: decodedBytes });
}

/** Charge every RPC batch element. Costly admission fails closed. */
export async function chargeRpcBatch(
  port: RatePort,
  charges: readonly RateCharge[],
): Promise<void> {
  for (const charge of charges) await chargeRate(port, charge);
}

export type QuerySlotPort = {
  tryAcquire(key: string, max: number): Promise<boolean>;
  release(key: string): Promise<void>;
};

export async function acquireQuerySlot(port: QuerySlotPort, userId: string): Promise<void> {
  const ok = await port.tryAcquire(userId, KB_LIMITS.queryInFlightPerUser);
  if (!ok) throw new KbAdmissionError("RATE_LIMITED", "Rate limited", 1);
}
