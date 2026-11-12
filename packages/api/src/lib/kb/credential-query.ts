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
 * Permit -> one PG transaction -> authority lock. No KB locks or network bodies.
 * PostgreSQL bounds the whole transaction, including idle/lost-reply time.
 * Cancellation terminates only this owned backend and joins its acknowledgement;
 * neither a rejected caller nor a closed socket is treated as a completed SQL effect.
 */
export function credentialQuery(connectionString: string): CredentialQuery {
  return async (signal, run) => {
    signal.throwIfAborted();
    const deadline = Date.now() + 30_000;
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
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = (async () => {
        if (!connected || pid === undefined) {
          await client.end();
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
          if (drained.rows.length === 0 || drained.rows[0]?.terminated === true) await client.end();
        } finally {
          await cancel.end();
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
    const assertOpen = () => {
      signal.throwIfAborted();
      if (Date.now() >= deadline)
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Admission deadline exceeded");
    };
    const query: LockQuery = async <R>(text: string, values: unknown[] = []) => {
      assertOpen();
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
      assertOpen();
      const result = await client.query<R>({ text, values, queryMode: "extended" });
      assertOpen();
      return result;
    };
    try {
      await client.connect();
      connected = true;
      assertOpen();
      pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      assertOpen();
      await client.query(`SET transaction_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
      assertOpen();
      await client.query("BEGIN");
      await query("SET LOCAL lock_timeout = '5s'");
      await query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [
        AUTHORITY_LOCK_CLASSID,
        AUTHORITY_LOCK_OBJID,
      ]);
      const result = await run(query);
      assertOpen();
      await query("COMMIT");
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      await stopping;
      if (connected) await client.query("ROLLBACK").catch(() => {});
      await client.end();
    }
  };
}
