/// <reference path="./pg.d.ts" />

import { randomUUID } from "node:crypto";
import { initializeConnection } from "@knowledge-base/env/connection-config";
import { Client } from "pg";
import { assertNoAssetMigration } from "./asset-storage-mode";
import type { LockQuery } from "./lock";

export const MAINTENANCE_LOCK = 0x4b424d41; // KBMA; separate from authority/schema locks
export const MAINTENANCE_REQUEST = "kb.maintenance.request";
export const MAINTENANCE_DRAIN_MS = 300_000;

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
  const participantKey = `kb.maintenance.participant.${randomUUID()}`;
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
    if (requested) throw new Error("Maintenance request requires offline recovery before startup.");
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
