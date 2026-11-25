/// <reference path="./pg.d.ts" />

import { randomInt, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { initializeConnection } from "@knowledge-base/env/connection-config";
import { logEvent } from "@knowledge-base/env/log";
import { Client } from "pg";
import { assertNoAssetMigration } from "./asset-storage-mode";
import type { LockQuery } from "./lock";

export const MAINTENANCE_LOCK = 0x4b424d41; // KBMA; separate from authority/schema locks
export const MAINTENANCE_REQUEST = "kb.maintenance.request";
export const MAINTENANCE_DRAIN_MS = 300_000;
/** Two-key advisory class (KBMP) of each participant's liveness token. The
 * token lock lives exactly as long as the participant's Postgres session, so a
 * backup coordinator that can take it proves the row's owner is gone (a crash
 * never runs `release()`). Mirrored in scripts/lib/kb-backup.mjs. */
export const MAINTENANCE_PARTICIPANT_LOCK_CLASS = 0x4b424d50;
export const MAINTENANCE_PARTICIPANT_PREFIX = "kb.maintenance.participant.";

/** `<prefix><token>.<host>.<pid>.<uuid>`: the token proves liveness; host and
 * pid only name the process in operator messages. */
export function maintenanceParticipantKey(token: number, host: string, pid: number) {
  const label = host.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 63) || "unknown";
  return `${MAINTENANCE_PARTICIPANT_PREFIX}${token}.${label}.${pid}.${randomUUID()}`;
}

/** A process owns its shared permit until all handlers and descendants drain.
 * Durable request survives coordinator death. Startup refuses even when its
 * exclusive permit has disappeared: only an offline fenced recovery clears it.
 */
export async function startMaintenanceParticipant(
  connectionString: string,
  closeAdmission: () => void,
  recover?: () => Promise<void>,
  beforeRelease?: () => Promise<void>,
  admitStorage?: (query: LockQuery) => Promise<unknown>,
) {
  const client = initializeConnection(
    "DATABASE_URL",
    () =>
      new Client({
        connectionString,
        application_name: "kb-maintenance-participant",
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
      }),
  );
  let participantKey = "";
  let requested = false;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const close = () => {
    if (requested || released) return;
    requested = true;
    closeAdmission();
  };
  client.on("error", close);
  client.on("end", close);
  const check = async (recoverStartup?: () => Promise<void>) => {
    const result = await client.query("SELECT value FROM app_setting WHERE key=$1", [
      MAINTENANCE_REQUEST,
    ]);
    if (result.rows.length) {
      const request: unknown = (() => {
        try {
          const value = result.rows[0]?.value;
          return typeof value === "string" ? JSON.parse(value) : undefined;
        } catch {
          return undefined;
        }
      })();
      const storageRequest =
        request && typeof request === "object" && "assetStorageAttempt" in request;
      if (recoverStartup && !storageRequest) {
        // Nonblocking reverse acquisition avoids deadlock with request -> drain.
        // Only abandoned maintenance permits write-capable server recovery;
        // HTTP/worker admission stays closed and this never clears the request.
        const gate = await client.query(
          "SELECT pg_try_advisory_lock_shared($1::bigint) AS held",
          [0x4b424d52],
        );
        if (gate.rows[0]?.held) await recoverStartup();
      }
      close();
    }
  };
  try {
    // A connect failure is not a configuration error: it keeps the driver's
    // class and stable code (ECONNREFUSED, 28P01, 57P03) and the caller's stage.
    await client.connect();
    const result = await client.query("SELECT pg_try_advisory_lock_shared($1::bigint) AS held", [
      MAINTENANCE_LOCK,
    ]);
    if (!result.rows[0]?.held) throw new Error("Maintenance admission is closed.");
    // This control row precedes archive import. Even a matching imported
    // receipt or a vanished coordinator cannot reopen restored authority.
    const restore = await client.query(
      "SELECT to_regclass('knowledge_base_control.kb_restore') AS present",
    );
    if (restore.rows[0]?.present) {
      const pendingRestore = await client.query(
        "SELECT state FROM knowledge_base_control.kb_restore WHERE singleton AND state<>'READY'",
      );
      if (pendingRestore.rows.length) throw new Error("Pending restore requires offline recovery.");
    }
    await assertNoAssetMigration((sql, values) => client.query(sql, values));
    await admitStorage?.((sql, values) => client.query(sql, values));
    await check(recover);
    if (requested) {
      // check() has already closed admission, so the host stops as planned and
      // never prints this refusal: say it here, once per start.
      logEvent("kb.maintenance-recovery-required", { code: "MAINTENANCE_RECOVERY_REQUIRED" });
      throw new Error(
        "Maintenance request requires offline recovery before startup: a backup left maintenance closed; re-run the backup to take the recovery snapshot.",
      );
    }
    // Session-scoped: released by Postgres when this process or its session dies.
    for (let attempt = 0; !participantKey; attempt++) {
      if (attempt === 8) throw new Error("No free maintenance participant token.");
      const token = randomInt(1, 2 ** 31);
      const held = await client.query("SELECT pg_try_advisory_lock($1::int,$2::int) AS held", [
        MAINTENANCE_PARTICIPANT_LOCK_CLASS,
        token,
      ]);
      if (!held.rows[0]?.held) continue;
      // A crashed owner's row may still carry this token: reusing it would make
      // that stale row look alive to the coordinator.
      const stale = await client.query("SELECT 1 FROM app_setting WHERE key LIKE $1 LIMIT 1", [
        `${MAINTENANCE_PARTICIPANT_PREFIX}${token}.%`,
      ]);
      if (stale.rows.length)
        await client.query("SELECT pg_advisory_unlock($1::int,$2::int)", [
          MAINTENANCE_PARTICIPANT_LOCK_CLASS,
          token,
        ]);
      else participantKey = maintenanceParticipantKey(token, hostname(), process.pid);
    }
    await client.query(
      `INSERT INTO app_setting (key,value,"createdAt","updatedAt") VALUES ($1,'LIVE',now(),now())`,
      [participantKey],
    );
  } catch (error) {
    released = true;
    await client.end();
    throw error;
  }
  function poll() {
    timer = setTimeout(() => {
      pending = check()
        .catch(close)
        .finally(() => {
          pending = undefined;
          if (!requested && !released) poll();
        });
    }, 100);
  }
  poll();
  return {
    get requested() {
      return requested;
    },
    async release() {
      if (released) return;
      // No drain acknowledgement or shared permit release before byte/SQL ownership joins.
      if (beforeRelease) await beforeRelease();
      if (released) return;
      released = true;
      clearTimeout(timer);
      await pending;
      const request = await client.query("SELECT value FROM app_setting WHERE key=$1", [
        MAINTENANCE_REQUEST,
      ]);
      if (request.rows.length)
        await client.query('UPDATE app_setting SET value=$2,"updatedAt"=now() WHERE key=$1', [
          participantKey,
          `${request.rows[0]?.value}:DRAINED`,
        ]);
      else await client.query("DELETE FROM app_setting WHERE key=$1", [participantKey]);
      await client.end();
    },
  };
}
