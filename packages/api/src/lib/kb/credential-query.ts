/// <reference path="./pg.d.ts" />
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { AUTHORITY_LOCK_CLASSID, AUTHORITY_LOCK_OBJID, type LockQuery } from "./lock";
import { KbAdmissionError } from "./principal";

export type CredentialQuery = <T>(
  signal: AbortSignal,
  run: (query: LockQuery) => Promise<T>,
) => Promise<T>;

/**
 * `client.connect()`, settled by the socket closing too. pg@8 never settles
 * `connect()` once `end()` ran before the startup handshake finished (its end
 * handler skips the connect callback while ending), so an abort in that window
 * would hold the caller's admission permit forever. No SQL ran on the socket.
 */
function connectUntilEnd(client: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    const ended = () => {
      client.removeListener("end", ended);
      reject(new KbAdmissionError("STORAGE_UNAVAILABLE", "Admission closed"));
    };
    client.on("end", ended);
    client.connect().then(
      () => {
        client.removeListener("end", ended);
        resolve();
      },
      (error: unknown) => {
        client.removeListener("end", ended);
        reject(error);
      },
    );
  });
}

/** Teardown time once no SQL effect can still be in flight. */
export const CREDENTIAL_TEARDOWN_MS = 5_000;

/** Close the socket without waiting for the peer (a silent peer never answers `end()`). */
function destroySocket(client: Client): void {
  client.connection?.stream?.destroy();
}

/**
 * End `client` gracefully within CREDENTIAL_TEARDOWN_MS; past it destroy the
 * socket (which closes it locally at once). Either way, join the closure.
 */
async function closeBounded(client: Client): Promise<void> {
  const ending = client.end().then(noop, noop);
  await within(ending, Date.now() + CREDENTIAL_TEARDOWN_MS, () => destroySocket(client));
  await ending;
}

/** Wait for `work` until `until` (epoch ms); past it run `late` and stop waiting. */
async function within(work: Promise<unknown>, until: number, late: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(
      () => {
        late();
        resolve();
      },
      Math.max(0, until - Date.now()),
    );
  });
  await Promise.race([work.then(noop, noop), bound]);
  clearTimeout(timer);
}

const noop = () => {};

/**
 * Permit -> one PG transaction -> authority lock. No KB locks or network bodies.
 * PostgreSQL bounds the whole transaction, including idle/lost-reply time.
 * Cancellation terminates only this owned backend and joins its acknowledgement;
 * neither a rejected caller nor a closed socket is treated as a completed SQL effect.
 *
 * Once no SQL effect can be in flight (no transaction was opened, COMMIT was
 * acknowledged, or the backend is proven terminated) teardown is bounded by
 * CREDENTIAL_TEARDOWN_MS even if the peer goes silent: past it the socket is
 * destroyed. Without that proof, ownership is kept until closure is joined.
 */
export function credentialQuery(connectionString: string): CredentialQuery {
  return async (signal, run) => {
    signal.throwIfAborted();
    const release = await acquireCredentialSlot(signal);
    try {
      return await ownedTransaction(connectionString, signal, run);
    } finally {
      release();
    }
  };
}

/**
 * Dedicated credential connections open at once in this process, besides the
 * Prisma pool. A burst of parallel MCP calls (each opens several) otherwise
 * reached PostgreSQL's max_connections (53300) and failed as internal errors,
 * other users' requests included. Past the cap a call waits briefly for a
 * slot, then is refused as busy (503 with Retry-After at the MCP boundary).
 */
export const CREDENTIAL_CONNECTIONS_MAX = 32;
const CREDENTIAL_SLOT_WAIT_MS = 2_000;
const CREDENTIAL_SLOT_WAITERS_MAX = 256;

/** Every credential connection slot is in use: shed load, retry shortly. */
export class CredentialCapacityError extends KbAdmissionError {
  constructor() {
    super("STORAGE_UNAVAILABLE", "Credential connections busy");
  }
}

let slotsInUse = 0;
const slotWaiters: Array<() => void> = [];

function releaseSlot(): void {
  const next = slotWaiters.shift();
  // Hand the slot straight to the next waiter; otherwise give it back.
  if (next) next();
  else slotsInUse -= 1;
}

async function acquireCredentialSlot(signal: AbortSignal): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };
  if (slotsInUse < CREDENTIAL_CONNECTIONS_MAX) {
    slotsInUse += 1;
    return release;
  }
  if (slotWaiters.length >= CREDENTIAL_SLOT_WAITERS_MAX) throw new CredentialCapacityError();
  await new Promise<void>((resolve, reject) => {
    const leave = () => {
      const at = slotWaiters.indexOf(granted);
      if (at >= 0) slotWaiters.splice(at, 1);
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    };
    const granted = () => {
      leave();
      resolve();
    };
    const aborted = () => {
      leave();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      leave();
      reject(new CredentialCapacityError());
    }, CREDENTIAL_SLOT_WAIT_MS);
    slotWaiters.push(granted);
    signal.addEventListener("abort", aborted, { once: true });
  });
  return release;
}

/** Test hook: the slots currently held and the calls waiting for one. */
export function credentialSlotsForTests(): { inUse: number; waiting: number } {
  return { inUse: slotsInUse, waiting: slotWaiters.length };
}

async function ownedTransaction<T>(
  connectionString: string,
  signal: AbortSignal,
  run: (query: LockQuery) => Promise<T>,
): Promise<T> {
  // Monotonic, like PostgreSQL's timers and the caller's: a wall-clock step
  // must not move this deadline relative to the server-side timeouts set from it.
  const deadline = performance.now() + 30_000;
  const remaining = () => `${Math.max(1, Math.ceil(deadline - performance.now()))}ms`;
  const applicationName = `kb-admission-${randomUUID()}`;
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    // Startup limits apply even if a setup reply is lost. PG17 is the
    // deployment/fixture contract; statement_timeout alone cannot stop idle
    // transactions retaining authority after an INSERT response is lost.
    options: "-c transaction_timeout=30000 -c idle_in_transaction_session_timeout=30000",
    application_name: applicationName,
  });
  // A cancel connection cannot share the busy connection it is canceling.
  let pid: number | undefined;
  let connected = false;
  let inTransaction = false;
  let committed = false;
  let terminated = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = (async () => {
      // Before BEGIN answered no effectful SQL was sent: nothing to terminate.
      if (!connected || pid === undefined || !inTransaction) {
        await closeBounded(client);
        return;
      }
      const cancel = new Client({
        connectionString,
        connectionTimeoutMillis: 1_000,
        statement_timeout: 1_000,
        query_timeout: 2_000,
        application_name: "kb-admission-cancel",
      });
      cancel.on("error", () => {});
      try {
        await cancel.connect();
        const drained = await cancel.query<{ terminated: boolean }>(
          "SELECT pg_terminate_backend(pid, 500) AS terminated FROM pg_stat_activity WHERE pid=$1 AND application_name=$2 AND datname=current_database() AND usename=current_user",
          [pid, applicationName],
        );
        // A positive timeout makes PG acknowledge actual termination. Zero
        // matching rows also proves this exact backend is already gone. Only
        // then force the original receive path to settle and join its drain.
        if (drained.rows.length === 0 || drained.rows[0]?.terminated === true) {
          terminated = true;
          // The backend is gone: a silent peer may never close the socket.
          await closeBounded(client);
        }
      } finally {
        await closeBounded(cancel);
      }
    })().catch(() => {
      // Server transaction/idle deadlines still bound authority, but an
      // unacknowledged cancel/closed socket is not proof of effect completion.
      // Keep ownership until the original transport and cleanup settle.
    });
  };
  const timer = setTimeout(stop, 30_000);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  client.on("error", () => {});
  const expired = () => performance.now() >= deadline;
  const deadlineExceeded = () =>
    new KbAdmissionError("STORAGE_UNAVAILABLE", "Admission deadline exceeded");
  const assertOpen = () => {
    signal.throwIfAborted();
    if (expired()) throw deadlineExceeded();
  };
  const query: LockQuery = async <R>(text: string, values: unknown[] = []) => {
    assertOpen();
    await client.query(`SET LOCAL statement_timeout = '${remaining()}'`);
    assertOpen();
    const result = await client.query<R>({ text, values, queryMode: "extended" });
    assertOpen();
    return result;
  };
  try {
    await connectUntilEnd(client);
    connected = true;
    assertOpen();
    pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    assertOpen();
    await client.query(`SET transaction_timeout = '${remaining()}'`);
    assertOpen();
    await client.query("BEGIN");
    inTransaction = true;
    await query("SET LOCAL lock_timeout = '5s'");
    await query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [
      AUTHORITY_LOCK_CLASSID,
      AUTHORITY_LOCK_OBJID,
    ]);
    const result = await run(query);
    assertOpen();
    // Record the acknowledgement before the freshness check: a COMMIT that
    // answered is proof of completion even if the caller is then refused.
    assertOpen();
    await client.query(`SET LOCAL statement_timeout = '${remaining()}'`);
    assertOpen();
    await client.query({ text: "COMMIT", values: [], queryMode: "extended" });
    committed = true;
    assertOpen();
    return result;
  } catch (error) {
    // PostgreSQL enforces this same deadline (statement/transaction timeout),
    // as does stop() at it; which side trips first is a race of milliseconds.
    // Past the deadline every failure is that refusal, never the raw driver
    // error of whichever enforcer won. An abort keeps its own reason.
    if (!signal.aborted && !(error instanceof KbAdmissionError) && expired())
      throw deadlineExceeded();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    // stop() is bounded itself: its cancel connection has connect/query
    // timeouts and both closes are bounded.
    await stopping;
    // Only proof bounds the teardown; without it ownership lasts until the
    // original transport and its cleanup settle (a silent peer is not proof).
    const proven = !connected || !inTransaction || committed || terminated;
    // After a COMMIT there is no transaction to roll back (and PostgreSQL
    // would only warn "there is no transaction in progress").
    if (connected && inTransaction && !committed && !terminated) {
      await client.query("ROLLBACK").catch(noop);
    }
    if (proven) await closeBounded(client);
    else await client.end();
  }
}
