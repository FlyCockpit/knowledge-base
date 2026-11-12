/// <reference path="./pg.d.ts" />
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID } from "@knowledge-base/db/authority-lock";
import { Client, type QueryResult } from "pg";

export { AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID };
/** KB lifecycle exclusion uses classid 0 / objid 1145389648 (`DADP`). These keys never collide with it. */
export const KB_LOCK_CLASSID = 0x4b424b42; // KBKB

export const LOCK_WAIT_MS = 5_000;
export const MUTATION_DEADLINE_MS = 30_000;

const OP_ID = /^[A-Za-z0-9_-]{1,128}$/;
const KB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const liveLeases = new WeakSet<HeldLockLease>();
const rolledBackTransactionErrors = new WeakSet<object>();

/** Preserves the original error while identifying a confirmed, usable-session rollback. */
export function isRolledBackTransactionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && rolledBackTransactionErrors.has(error);
}

const CONNECTION_SQLSTATES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "57P01",
  "57P02",
  "57P03",
  "57P04",
]);

const CONNECTION_ERRNOS = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

export type KbLockErrorCode =
  | "LOCK_ORDER"
  | "LOCK_TIMEOUT"
  | "CONNECTION_LOST"
  | "ADMISSION_CLOSED"
  | "DEADLINE_EXCEEDED"
  | "AUTHORITY_HELD"
  | "REVOKED"
  | "NOT_HELD";

export class KbLockError extends Error {
  readonly code: KbLockErrorCode;
  readonly opId: string;
  constructor(code: KbLockErrorCode, message: string, opId = "") {
    super(opId ? `op ${opId}: ${message}` : message);
    this.name = "KbLockError";
    this.code = code;
    this.opId = opId;
  }
}

/** One lifetime, from admission through checkout, reservation and finalization.
 * Callbacks must observe signal for non-SQL waits. Cancellation never detaches a
 * callback: gates remain held until it and its database work have been joined.
 */
export class MutationScope {
  private readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  readonly deadlineAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private reserved = false;
  private committing = false;
  private shutdownRequested = false;

  constructor(
    readonly opId: string,
    readonly now: () => number = Date.now,
    deadlineAt = now() + MUTATION_DEADLINE_MS,
  ) {
    this.deadlineAt = deadlineAt;
    this.timer = setTimeout(() => this.expire(), Math.max(0, deadlineAt - now()));
  }

  cancel(error: unknown): void {
    if (!this.signal.aborted) this.abort.abort(error);
  }

  private expire(): void {
    this.cancel(new KbLockError("DEADLINE_EXCEEDED", "mutation deadline exceeded", this.opId));
  }

  assertActive(): void {
    if (this.now() >= this.deadlineAt) this.expire();
    if (this.signal.aborted) throw this.signal.reason;
  }

  remainingMs(): number {
    this.assertActive();
    return Math.max(1, Math.ceil(this.deadlineAt - this.now()));
  }

  requestShutdown(): void {
    this.shutdownRequested = true;
    // Once COMMIT is sent we must resolve its outcome before canceling. A
    // successful reservation is allowed to reconcile until the same deadline.
    if (!this.reserved && !this.committing) {
      this.cancel(new KbLockError("ADMISSION_CLOSED", "write admission is closed", this.opId));
    }
  }

  beginReservationCommit(): void {
    this.assertActive();
    this.committing = true;
  }

  finishReservationCommit(committed: boolean): void {
    this.reserved = committed;
    this.committing = false;
    if (this.shutdownRequested) this.requestShutdown();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

export type LockSpec = { kind: "authority" } | { kind: "kb"; kbId: string };

export type LockQuery = <R = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<R>>;

export type AcquisitionWait = {
  deadlineAt: number;
  now: () => number;
  signal?: AbortSignal;
  opId: string;
};

const operationAls = new AsyncLocalStorage<HeldLockLease>();

export function getOperationLease(): HeldLockLease | undefined {
  return operationAls.getStore();
}

export function requireOperationLease(): HeldLockLease {
  const lease = operationAls.getStore();
  if (!lease) {
    throw new KbLockError(
      "NOT_HELD",
      "Hooks reuse the parent's operation context rather than acquiring another DB lock",
    );
  }
  return lease;
}

export function runWithOperationLease<T>(lease: HeldLockLease, fn: () => Promise<T>): Promise<T> {
  return operationAls.run(lease, fn);
}

export function isLiveHeldLease(value: unknown): value is HeldLockLease {
  return value instanceof HeldLockLease && liveLeases.has(value);
}

export function kbLockObjid(kbId: string): number {
  if (!KB_ID.test(kbId)) {
    throw new KbLockError("LOCK_ORDER", `invalid knowledge-base id`);
  }
  const digest = createHash("sha256").update("kb/lock/v1\0").update(kbId).digest();
  const n = digest.readInt32BE(0);
  return n === 0 ? 1 : n;
}

export function canonicalLockSequence(options: {
  authority: boolean;
  kbIds: readonly string[];
}): LockSpec[] {
  const unique = [...new Set(options.kbIds)];
  unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sequence: LockSpec[] = [];
  if (options.authority) sequence.push({ kind: "authority" });
  for (const kbId of unique) sequence.push({ kind: "kb", kbId });
  if (sequence.length === 0) {
    throw new KbLockError("LOCK_ORDER", "lock sequence is empty");
  }
  return sequence;
}

export function assertLockOrder(locks: readonly LockSpec[]): void {
  if (locks.length === 0) {
    throw new KbLockError("LOCK_ORDER", "lock sequence is empty");
  }
  let seenAuthority = false;
  const kbIds: string[] = [];
  for (const [index, spec] of locks.entries()) {
    if (spec.kind === "authority") {
      if (seenAuthority) {
        throw new KbLockError("LOCK_ORDER", "authority lock requested more than once");
      }
      if (index !== 0) {
        throw new KbLockError(
          "LOCK_ORDER",
          "authority lock must be acquired before any knowledge-base lock",
        );
      }
      seenAuthority = true;
      continue;
    }
    if (!KB_ID.test(spec.kbId)) {
      throw new KbLockError("LOCK_ORDER", "invalid knowledge-base id");
    }
    kbIds.push(spec.kbId);
  }
  if (new Set(kbIds).size !== kbIds.length) {
    throw new KbLockError("LOCK_ORDER", "duplicate knowledge-base lock");
  }
  const sorted = [...kbIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (kbIds.some((id, index) => id !== sorted[index])) {
    throw new KbLockError("LOCK_ORDER", "knowledge-base locks must be acquired in sorted id order");
  }
}

function remainingMs(deadlineAt: number, now: () => number): number {
  return Math.max(0, deadlineAt - now());
}

function throwIfAcquireExpired(wait: AcquisitionWait): void {
  if (wait.signal?.aborted) {
    throw new KbLockError("ADMISSION_CLOSED", "write admission is closed", wait.opId);
  }
  if (wait.now() >= wait.deadlineAt) {
    throw new KbLockError("LOCK_TIMEOUT", "advisory lock wait exceeded 5s", wait.opId);
  }
}

class SerialGate {
  private tail: Promise<void> = Promise.resolve();
  private sealed = false;

  seal(): void {
    this.sealed = true;
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  enqueue<T>(fn: () => Promise<T>, wait?: AcquisitionWait): Promise<T> {
    if (!wait) {
      const run = this.tail.then(
        () => {
          if (this.sealed) {
            throw new KbLockError("ADMISSION_CLOSED", "write admission is closed");
          }
          return fn();
        },
        () => {
          if (this.sealed) {
            throw new KbLockError("ADMISSION_CLOSED", "write admission is closed");
          }
          return fn();
        },
      );
      this.tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let admitted = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const succeed = (value: T) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const onAbort = () => {
        if (admitted) return;
        fail(new KbLockError("ADMISSION_CLOSED", "write admission is closed", wait.opId));
      };
      const onTimeout = () => {
        if (admitted) return;
        fail(new KbLockError("LOCK_TIMEOUT", "advisory lock wait exceeded 5s", wait.opId));
      };

      if (this.sealed || wait.signal?.aborted) {
        onAbort();
      } else if (wait.now() >= wait.deadlineAt) {
        onTimeout();
      }

      const timer = settled
        ? undefined
        : setTimeout(onTimeout, remainingMs(wait.deadlineAt, wait.now));
      if (!settled) wait.signal?.addEventListener("abort", onAbort);

      const enter = async (): Promise<void> => {
        if (settled) return;
        if (this.sealed || wait.signal?.aborted) {
          onAbort();
          return;
        }
        if (wait.now() >= wait.deadlineAt) {
          onTimeout();
          return;
        }
        admitted = true;
        if (timer) clearTimeout(timer);
        wait.signal?.removeEventListener("abort", onAbort);
        try {
          succeed(await fn());
        } catch (error) {
          fail(error);
        }
      };

      const run = this.tail.then(enter, enter);
      this.tail = run.then(
        () => undefined,
        () => undefined,
      );
    });
  }
}

const authorityGate = new SerialGate();
const kbGates = new Map<string, SerialGate>();
const activeKbGates = new AsyncLocalStorage<Map<string, { active: boolean }>>();

/** The gate survives session loss and must span every filesystem effect and its cleanup. */
export function assertKbOperationGateHeld(kbId: string): void {
  if (!activeKbGates.getStore()?.get(kbId)?.active) {
    throw new KbLockError("NOT_HELD", "knowledge-base operation gate is not held");
  }
}

function gateForKb(kbId: string): SerialGate {
  const existing = kbGates.get(kbId);
  if (existing) return existing;
  const created = new SerialGate();
  kbGates.set(kbId, created);
  return created;
}

/** Fail closed: never admit another writer for this knowledge-base in this process. */
export function sealKbOperationGate(kbId: string): void {
  gateForKb(kbId).seal();
}

export function isKbOperationGateSealed(kbId: string): boolean {
  return kbGates.get(kbId)?.isSealed === true;
}

/** In-process KB gate: a successor is admitted only after the previous op drains, not after a timer. */
export function enqueueKbOperation<T>(
  kbId: string,
  fn: () => Promise<T>,
  wait?: AcquisitionWait,
): Promise<T> {
  return gateForKb(kbId).enqueue(async () => {
    const entry = { active: true };
    const context = new Map(activeKbGates.getStore());
    context.set(kbId, entry);
    try {
      return await activeKbGates.run(context, fn);
    } finally {
      entry.active = false;
    }
  }, wait);
}

export function enqueueAuthoritySection<T>(
  fn: () => Promise<T>,
  wait?: AcquisitionWait,
): Promise<T> {
  return authorityGate.enqueue(fn, wait);
}

export class HeldLockLease {
  readonly opId: string;
  readonly backendPid: number;
  readonly lost: AbortSignal;
  private readonly client: Client;
  private readonly abort: AbortController;
  private readonly held: LockSpec[] = [];
  private readonly acquireDeadlineAt: number;
  private readonly now: () => number;
  private closed = false;
  private closing = false;
  private closeWork?: Promise<void>;
  private lostFlag = false;
  readonly scope: MutationScope;
  private readonly ownsScope: boolean;
  private sqlTail: Promise<unknown> = Promise.resolve();
  private transactionWork?: Promise<unknown>;
  private acquireTail: Promise<void> = Promise.resolve();
  private readonly pendingLocks = new Set<LockSpec[]>();

  constructor(input: {
    opId: string;
    client: Client;
    backendPid: number;
    abort: AbortController;
    acquireDeadlineAt?: number;
    now?: () => number;
    scope?: MutationScope;
    ownsScope?: boolean;
  }) {
    this.opId = input.opId;
    this.scope = input.scope ?? new MutationScope(input.opId, input.now);
    this.ownsScope = input.ownsScope ?? !input.scope;
    this.client = input.client;
    this.backendPid = input.backendPid;
    this.abort = input.abort;
    this.lost = input.abort.signal;
    this.now = input.now ?? Date.now;
    this.acquireDeadlineAt = input.acquireDeadlineAt ?? this.now() + LOCK_WAIT_MS;
  }

  holdingAuthority(): boolean {
    return this.held.some((spec) => spec.kind === "authority");
  }

  heldKbIds(): string[] {
    return this.held.filter((spec) => spec.kind === "kb").map((spec) => spec.kbId);
  }

  assertHeldKb(kbId: string): void {
    this.assertOpen();
    if (!this.held.some((spec) => spec.kind === "kb" && spec.kbId === kbId)) {
      throw new KbLockError("NOT_HELD", `knowledge-base lock is not held for ${kbId}`, this.opId);
    }
  }

  assertCanReceiveNetworkBody(action = "receive a network body"): void {
    this.assertOpen();
    if (this.holdingAuthority()) {
      throw new KbLockError(
        "AUTHORITY_HELD",
        `Cannot ${action} while holding the authority lock`,
        this.opId,
      );
    }
  }

  assertOpen(): void {
    if (this.closing) {
      throw new KbLockError("NOT_HELD", "operation lease is closing", this.opId);
    }
    this.assertSessionUsable();
  }

  private assertSessionUsable(): void {
    if (this.lostFlag || this.abort.signal.aborted) {
      throw new KbLockError("CONNECTION_LOST", "pinned Postgres session was lost", this.opId);
    }
    if (this.closed) {
      throw new KbLockError("NOT_HELD", "operation lease is closed", this.opId);
    }
    this.scope.assertActive();
  }

  get connectionLost(): boolean {
    return this.lostFlag;
  }

  // Serialize timeout + statement as a pair, including concurrently submitted
  // queries. A queued query checks cancellation again before touching Postgres.
  query: LockQuery = async (text, values = []) => {
    this.assertOpen();
    return this.statement(text, values);
  };

  private statement<R = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
    reservationCommit = false,
    commitState?: { sent: boolean; serverRejected: boolean },
  ): Promise<QueryResult<R>> {
    const work = this.sqlTail.then(async () => {
      this.assertSessionUsable();
      try {
        await this.client.query(`SET statement_timeout = '${this.scope.remainingMs()}ms'`);
        this.assertSessionUsable();
        // No await between the cancellation check and sending COMMIT.
        if (reservationCommit) this.scope.beginReservationCommit();
        // Extended protocol admits exactly one statement. A multi-command text
        // query would restart the same server timeout for every command.
        if (commitState) commitState.sent = true;
        const result = await this.client.query<R>({ text, values, queryMode: "extended" });
        if (reservationCommit) this.scope.finishReservationCommit(true);
        return result;
      } catch (error) {
        // A PostgreSQL ErrorResponse makes rejection definite. Transport/client
        // errors after dispatch cannot establish whether COMMIT took effect.
        if (
          commitState?.sent &&
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[0-9A-Z]{5}$/.test(error.code)
        )
          commitState.serverRejected = true;
        if (reservationCommit) this.scope.finishReservationCommit(false);
        this.throwQueryError(error);
      }
    });
    this.sqlTail = work.catch(() => undefined);
    return work;
  }

  async transaction<T>(fn: (query: LockQuery) => Promise<T>, reservation = false): Promise<T> {
    this.assertOpen();
    if (this.transactionWork) {
      return Promise.reject(new KbLockError("LOCK_ORDER", "nested transaction", this.opId));
    }
    const work = (async () => {
      await this.statement("BEGIN");
      const commitState = { sent: false, serverRejected: false };
      try {
        // An admitted transaction may finish while close() joins it. Its query
        // callback expires when its work settles; public lease ops stay closed.
        let active = true;
        let result: T;
        try {
          result = await fn(async (text, values = []) => {
            if (!active) throw new KbLockError("NOT_HELD", "transaction is closed", this.opId);
            return this.statement(text, values);
          });
        } finally {
          active = false;
        }
        await this.statement("COMMIT", [], reservation, commitState);
        return result;
      } catch (error) {
        // Join all submitted SQL before rollback. Rollback is cleanup and is
        // allowed after cancellation, while the session and KB gate are held.
        await this.sqlTail;
        if (typeof error === "object" && error !== null) rolledBackTransactionErrors.delete(error);
        try {
          await this.client.query("ROLLBACK");
          if (
            (!commitState.sent || commitState.serverRejected) &&
            !this.lostFlag &&
            !this.abort.signal.aborted &&
            typeof error === "object" &&
            error !== null
          )
            rolledBackTransactionErrors.add(error);
        } catch {
          this.markLost();
        }
        throw error;
      }
    })();
    this.transactionWork = work;
    return work.finally(() => {
      this.transactionWork = undefined;
    });
  }

  async acquire(locks: readonly LockSpec[]): Promise<void> {
    this.assertOpen();
    if (operationAls.getStore() && operationAls.getStore() !== this) {
      throw new KbLockError(
        "LOCK_ORDER",
        "Hooks reuse the parent's operation context rather than acquiring another DB lock",
        this.opId,
      );
    }
    // Reserve the entire request before yielding, including locks still being
    // acquired by earlier calls. No SQL from an invalid request is dispatched.
    const pending = locks.map((spec) => ({ ...spec }));
    assertLockOrder([...this.held, ...[...this.pendingLocks].flat(), ...pending]);
    this.pendingLocks.add(pending);
    const work = this.acquireTail.then(async () => {
      try {
        while (pending.length > 0) {
          const spec = pending[0]!;
          await this.lockOne(spec);
          this.held.push(spec);
          pending.shift();
        }
      } finally {
        this.pendingLocks.delete(pending);
      }
    });
    this.acquireTail = work.catch(() => undefined);
    return work;
  }

  async releaseAuthority(): Promise<void> {
    this.assertOpen();
    const index = this.held.findIndex((spec) => spec.kind === "authority");
    if (index < 0) return;
    await this.unlockOne({ kind: "authority" });
    this.held.splice(index, 1);
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    this.closeWork = this.finishClose();
    return this.closeWork;
  }

  private async finishClose(): Promise<void> {
    await this.acquireTail;
    await this.transactionWork?.catch(() => undefined);
    await this.sqlTail;
    try {
      if (!this.lostFlag) {
        await this.client.query("SELECT pg_advisory_unlock_all()");
      }
    } catch {
      this.markLost();
    }
    this.closed = true;
    if (this.ownsScope) this.scope.dispose();
    liveLeases.delete(this);
    try {
      await this.client.end();
    } catch {
      this.markLost();
    }
    this.held.length = 0;
  }

  markLost(): void {
    if (this.closed || this.lostFlag) return;
    this.lostFlag = true;
    this.scope.cancel(
      new KbLockError("CONNECTION_LOST", "pinned Postgres session was lost", this.opId),
    );
    if (!this.abort.signal.aborted) this.abort.abort();
  }

  private remainingAcquireMs(): number {
    return remainingMs(this.acquireDeadlineAt, this.now);
  }

  private async lockOne(spec: LockSpec): Promise<void> {
    const remaining = this.remainingAcquireMs();
    if (remaining <= 0) {
      await this.abortPartialAcquire();
      throw new KbLockError("LOCK_TIMEOUT", "advisory lock wait exceeded 5s", this.opId);
    }
    const keys = specKeys(spec);
    try {
      await this.statement(`SET lock_timeout = '${Math.ceil(remaining)}ms'`);
      await this.statement("SELECT pg_advisory_lock($1, $2)", keys);
    } catch (error) {
      await this.abortPartialAcquire();
      this.throwQueryError(error, true);
    }
  }

  private async unlockOne(spec: LockSpec): Promise<void> {
    await this.statement("SELECT pg_advisory_unlock($1, $2)", specKeys(spec));
  }

  private async abortPartialAcquire(): Promise<void> {
    try {
      await this.client.query("SELECT pg_advisory_unlock_all()");
    } catch {
      this.markLost();
    }
    this.held.length = 0;
  }

  private throwQueryError(error: unknown, duringLock = false): never {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "";
    if (code === "57014") {
      const timeout = new KbLockError("DEADLINE_EXCEEDED", "mutation deadline exceeded", this.opId);
      this.scope.cancel(timeout);
      throw timeout;
    }
    if (code === "55P03" || (duringLock && /lock timeout/i.test(String(error)))) {
      throw new KbLockError("LOCK_TIMEOUT", "advisory lock wait exceeded 5s", this.opId);
    }
    if (isPgConnectionLoss(error, code)) {
      this.markLost();
      throw new KbLockError("CONNECTION_LOST", "pinned Postgres session was lost", this.opId);
    }
    throw error;
  }
}

function isPgConnectionLoss(error: unknown, code: string): boolean {
  if (CONNECTION_SQLSTATES.has(code) || CONNECTION_ERRNOS.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /connection (terminated|ended|refused|closed)|client has encountered a connection error|server closed the connection/i.test(
    message,
  );
}

function specKeys(spec: LockSpec): [number, number] {
  if (spec.kind === "authority") return [AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID];
  return [KB_LOCK_CLASSID, kbLockObjid(spec.kbId)];
}

export async function checkoutPinnedSession(input: {
  connectionString: string;
  opId: string;
  acquireDeadlineAt?: number;
  mutationDeadlineAt?: number;
  scope?: MutationScope;
  now?: () => number;
}): Promise<HeldLockLease> {
  if (!OP_ID.test(input.opId)) {
    throw new KbLockError("LOCK_ORDER", "invalid operation id", input.opId);
  }
  if (operationAls.getStore()) {
    throw new KbLockError(
      "LOCK_ORDER",
      "Hooks reuse the parent's operation context rather than acquiring another DB lock",
      input.opId,
    );
  }
  const now = input.now ?? Date.now;
  const acquireDeadlineAt = input.acquireDeadlineAt ?? now() + LOCK_WAIT_MS;
  if (now() >= acquireDeadlineAt) {
    throw new KbLockError("LOCK_TIMEOUT", "advisory lock wait exceeded 5s", input.opId);
  }
  const scope = input.scope ?? new MutationScope(input.opId, now, input.mutationDeadlineAt);
  scope.assertActive();
  const abort = new AbortController();
  const connectMs = Math.max(
    1,
    Math.min(LOCK_WAIT_MS, remainingMs(acquireDeadlineAt, now), scope.remainingMs()),
  );
  const client = new Client({
    connectionString: input.connectionString,
    connectionTimeoutMillis: connectMs,
    application_name: `kb-op-${input.opId}`,
    statement_timeout: scope.remainingMs(),
  });
  let lease: HeldLockLease | undefined;
  const onTransportLost = () => {
    lease?.markLost();
  };
  client.on("error", onTransportLost);
  client.on("end", onTransportLost);
  try {
    await client.connect();
    scope.assertActive();
    await client.query(`SET statement_timeout = '${scope.remainingMs()}ms'`);
    const pidResult = await client.query<{ pg_backend_pid: number | string }>(
      "SELECT pg_backend_pid() AS pg_backend_pid",
    );
    const raw = pidResult.rows[0]?.pg_backend_pid;
    const backendPid = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(backendPid) || backendPid <= 0) {
      throw new KbLockError("CONNECTION_LOST", "failed to read backend pid", input.opId);
    }
    lease = new HeldLockLease({
      opId: input.opId,
      client,
      backendPid,
      abort,
      acquireDeadlineAt,
      now,
      scope,
      ownsScope: !input.scope,
    });
    scope.assertActive();
    liveLeases.add(lease);
    abort.signal.addEventListener("abort", () => lease?.markLost());
    return lease;
  } catch (error) {
    await client.end().catch(() => {});
    if (!input.scope) scope.dispose();
    scope.assertActive();
    if (error instanceof KbLockError) throw error;
    throw new KbLockError("CONNECTION_LOST", "failed to check out a Postgres session", input.opId);
  }
}

export { throwIfAcquireExpired };
