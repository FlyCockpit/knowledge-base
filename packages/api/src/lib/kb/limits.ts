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
  /** Live REST API keys per user (minted in Settings → API keys). */
  activeApiKeysPerUser: 10,
  /** Default live child MCP tokens per API key (Admin → Limits changes it). */
  childTokensPerApiKey: 200,
  /** Child MCP token mints per API key per hour (bounds child-row growth). */
  childMintsPerHourPerApiKey: 200,
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
  /** Reader threads in the server's SQLite index pool; at most n-1 run large tasks. */
  serverIndexReaders: 2,
  /** Chunk limit applied when a KB stores none and when an admin ceiling is absent. */
  indexChunksDefault: 400_000,
  /**
   * Dirents the index reconciler reads from one `index/<kbId>/` directory per visit. A directory
   * holds only its retained and building generations' files (final, temp, journal), so more is
   * an anomaly: it is skipped with a warning instead of being read without bound.
   */
  indexDirEntryCap: 10_000,
  /** Hard per-quantization chunk bounds; no ceiling or KB limit can exceed them. */
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

export type RateChargeKind =
  | "create"
  | "query"
  | "rebuild"
  | "probe"
  | "mutation"
  | "upload"
  | "childMint";

export type RateCharge = {
  kind: RateChargeKind;
  key: string;
  points?: number;
  /**
   * The window's budget when an instance setting replaces the compiled one
   * (the create rate, Admin → Limits). Counters are shared per bucket, so a
   * changed budget applies to the window already in progress.
   */
  limit?: number;
};

export type RateConsumeResult =
  | { ok: true }
  | { retryAfterSeconds: number }
  | { unavailable: true };

export type RatePort = {
  consume(bucket: string, key: string, points: number, limit?: number): Promise<RateConsumeResult>;
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
    childMint: {
      bucket: "kb:child-mint",
      points: KB_LIMITS.childMintsPerHourPerApiKey,
      durationSeconds: 3600,
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
    async consume(bucket, key, points, limit) {
      const window = Object.values(WINDOWS).find((item) => item.bucket === bucket);
      if (!window) return { unavailable: true };
      const id = `${bucket}:${key}`;
      const next = (counts.get(id) ?? 0) + points;
      if (next > (limit ?? window.points)) return { retryAfterSeconds: window.durationSeconds };
      counts.set(id, next);
      return { ok: true };
    },
  };
}

export function createRedisRatePort(storeClient: object): RatePort {
  // One limiter per (bucket, budget). Every limiter of a bucket shares its key
  // prefix, so they read and write the same per-key counter.
  const limiters = new Map<string, RateLimiterRedis>();
  const limiter = (kind: RateChargeKind, budget: number): RateLimiterRedis => {
    const spec = WINDOWS[kind];
    const id = `${spec.bucket}:${budget}`;
    let found = limiters.get(id);
    if (!found) {
      found = new RateLimiterRedis({
        storeClient,
        keyPrefix: spec.bucket,
        points: budget,
        duration: spec.durationSeconds,
      });
      limiters.set(id, found);
    }
    return found;
  };
  return {
    async consume(bucket, key, points, limit) {
      const kind = (Object.keys(WINDOWS) as RateChargeKind[]).find(
        (item) => WINDOWS[item].bucket === bucket,
      );
      if (!kind) return { unavailable: true };
      const budget = limit ?? WINDOWS[kind].points;
      if (!Number.isSafeInteger(budget) || budget < 1) return { unavailable: true };
      try {
        await limiter(kind, budget).consume(key, points);
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

/** A rate window's budget: how many points per how many seconds. */
export function rateWindowOf(kind: RateChargeKind): { points: number; durationSeconds: number } {
  const { points, durationSeconds } = WINDOWS[kind];
  return { points, durationSeconds };
}

export async function chargeRate(port: RatePort, charge: RateCharge): Promise<void> {
  const spec = WINDOWS[charge.kind];
  const points = charge.points ?? 1;
  // The budget argument exists only when a setting replaces the compiled one.
  const result =
    charge.limit === undefined
      ? await port.consume(spec.bucket, charge.key, points)
      : await port.consume(spec.bucket, charge.key, points, charge.limit);
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
