import {
  type AcquisitionWait,
  assertLockOrder,
  canonicalLockSequence,
  checkoutPinnedSession,
  enqueueAuthoritySection,
  enqueueKbOperation,
  type HeldLockLease,
  KbLockError,
  LOCK_WAIT_MS,
  type LockQuery,
  MutationScope,
  runWithOperationLease,
  throwIfAcquireExpired,
} from "./lock";

export type AuthorityBarrierContext = {
  query: LockQuery;
  /** Non-SQL waits must observe cancellation; the stack joins the callback. */
  signal: AbortSignal;
};

export type AuthorityBarrier = {
  /** Bounded local preparation under authority + KB locks, before the reservation transaction. */
  prepare?(lease: HeldLockLease): Promise<void>;
  /** Live ACL / ban / grant recheck, in the reservation transaction. */
  reauthorize(context: AuthorityBarrierContext): Promise<void>;
  /** Write the intent using query; the lock stack owns COMMIT, never the callback. */
  reservePublication(context: AuthorityBarrierContext): Promise<void>;
};

const activeReservations = new WeakMap<AuthorityBarrierContext, HeldLockLease>();

/** Only the lock stack can supply a live reservation transaction on its pinned session. */
export function assertAuthorityReservation(context: AuthorityBarrierContext, kbId: string): void {
  const lease = activeReservations.get(context);
  if (!lease?.holdingAuthority()) {
    throw new KbLockError("NOT_HELD", "publication requires an active authority reservation");
  }
  lease.assertHeldKb(kbId);
}

async function reserve(lease: HeldLockLease, barrier: AuthorityBarrier): Promise<void> {
  await barrier.prepare?.(lease);
  await lease.transaction(async (query) => {
    const context = { query, signal: lease.scope.signal };
    activeReservations.set(context, lease);
    try {
      await barrier.reauthorize(context);
      lease.scope.assertActive();
      await barrier.reservePublication(context);
    } finally {
      activeReservations.delete(context);
    }
  }, true);
}

export type LockedOperationKind = "authority" | "kb-write";

export type LockedOperationOptions<T> = {
  connectionString: string;
  opId: string;
  kbIds?: readonly string[];
  kind: LockedOperationKind;
  barrier?: AuthorityBarrier;
  signal?: AbortSignal;
  scope?: MutationScope;
  now?: () => number;
  lockWaitMs?: number;
  mutationDeadlineAt?: number;
  cleanup?: (lease: HeldLockLease) => Promise<void>;
  run: (lease: HeldLockLease) => Promise<T>;
};

function admissionClosed(opId: string): KbLockError {
  return new KbLockError("ADMISSION_CLOSED", "write admission is closed", opId);
}

async function withLease<T>(
  options: LockedOperationOptions<T>,
  acquireDeadlineAt: number,
  fn: (lease: HeldLockLease) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) throw admissionClosed(options.opId);
  const lease = await checkoutPinnedSession({
    connectionString: options.connectionString,
    opId: options.opId,
    acquireDeadlineAt,
    mutationDeadlineAt: options.mutationDeadlineAt,
    now: options.now,
    scope: options.scope,
  });
  try {
    const result = await runWithOperationLease(lease, () => fn(lease));
    lease.scope.assertActive();
    return result;
  } finally {
    try {
      if (options.cleanup) await options.cleanup(lease);
    } finally {
      await lease.close();
    }
  }
}

/**
 * Authority-only mutations and KB writes share this gate. The authority lock is
 * held only for reauthorization + reservation; Git/network bodies stay outside.
 */
export async function runLockedOperation<T>(options: LockedOperationOptions<T>): Promise<T> {
  const scope =
    options.scope ?? new MutationScope(options.opId, options.now, options.mutationDeadlineAt);
  const onAbort = () => scope.requestShutdown();
  options.signal?.addEventListener("abort", onAbort);
  if (options.signal?.aborted) onAbort();
  try {
    scope.assertActive();
    return await runLocked({ ...options, scope, signal: scope.signal });
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason;
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!options.scope) scope.dispose();
  }
}

async function runLocked<T>(options: LockedOperationOptions<T>): Promise<T> {
  const kbIds = options.kbIds ?? [];
  if (options.kind === "kb-write" && kbIds.length === 0) {
    throw new KbLockError(
      "LOCK_ORDER",
      "kb-write requires at least one knowledge-base id",
      options.opId,
    );
  }
  if (options.kind === "authority" && kbIds.length > 0) {
    throw new KbLockError(
      "LOCK_ORDER",
      "authority-only mutations must not take knowledge-base locks",
      options.opId,
    );
  }
  // Validate IDs before allocating persistent per-KB in-process gates.
  const sequence = canonicalLockSequence({ authority: true, kbIds });
  assertLockOrder(sequence);

  const now = options.now ?? Date.now;
  const acquireDeadlineAt = now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  const wait: AcquisitionWait = {
    deadlineAt: acquireDeadlineAt,
    now,
    signal: options.signal,
    opId: options.opId,
  };

  if (options.kind === "authority") {
    return enqueueAuthoritySection(
      () =>
        withLease(options, acquireDeadlineAt, async (lease) => {
          throwIfAcquireExpired(wait);
          await lease.acquire(sequence);
          const barrier = options.barrier;
          if (!barrier) {
            if (options.signal?.aborted) throw admissionClosed(options.opId);
            return options.run(lease);
          }
          await reserve(lease, barrier);
          lease.scope.assertActive();
          return options.run(lease);
        }),
      wait,
    );
  }

  const unique = [...new Set(kbIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const execute = (): Promise<T> =>
    withLease(options, acquireDeadlineAt, async (lease) => {
      await enqueueAuthoritySection(async () => {
        throwIfAcquireExpired(wait);
        await lease.acquire(sequence);
        const barrier = options.barrier;
        if (barrier) {
          await reserve(lease, barrier);
        }
        await lease.releaseAuthority();
      }, wait);
      lease.scope.assertActive();
      lease.assertCanReceiveNetworkBody();
      return options.run(lease);
    });

  return unique.reduceRight<(inner: () => Promise<T>) => Promise<T>>(
    (next, kbId) => (inner) => enqueueKbOperation(kbId, () => next(inner), wait),
    (inner) => inner(),
  )(execute);
}
