/**
 * Keeps this process's row in the scheduled-deletion instance registry
 * (`_knowledge_base_instance`, created by scripts/db/lib/contracts.mjs) alive.
 *
 * The image entrypoint gives every container start a fresh
 * KB_INSTANCE_ID and the migration runner registers it with the image's
 * schema level. While a row of an older level was seen in the last 7 days,
 * no scheduled deletion that the older code might still need runs; `ready_at`
 * starts a newer level's 7-day soak. Without KB_INSTANCE_ID (local dev,
 * tests) this is a no-op.
 *
 * Never throws: a database hiccup only delays scheduled deletions (fail-safe).
 */
import { hostname } from "node:os";
import { logEvent, logInternalError } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/shared";

import prisma from "./index";
import { runnerTable } from "./runner-tables";

export const HEARTBEAT_INTERVAL_MS = 60_000;

export type InstanceHeartbeat = {
  /** Record that this instance serves traffic (server) or consumes jobs (worker). Idempotent. */
  markReady(): void;
  /** Stop ticking. The row ages out on its own; nothing is written. */
  stop(): void;
};

const NOOP: InstanceHeartbeat = { markReady() {}, stop() {} };

/** A raw-query error for a missing relation (the runner tables do not exist yet). */
function isMissingTable(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta;
  return (
    meta?.code === "42P01" ||
    /42P01|TableDoesNotExist|relation .* does not exist/.test(
      error instanceof Error ? error.message : String(error),
    )
  );
}

export function startInstanceHeartbeat({ role }: { role: "server" | "worker" }): InstanceHeartbeat {
  const id = env.KB_INSTANCE_ID;
  if (!id) return NOOP;
  const table = runnerTable("_knowledge_base_instance");
  const host = hostname();
  let ready = false;
  let stopped = false;
  let levelChecked = false;
  let missingWarned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      // The runner's own registration normally exists already; inserting
      // here covers a process it did not register (its level stays NULL,
      // which keeps every scheduled deletion waiting: fail-safe).
      const rows = await prisma.$queryRaw<Array<{ schema_level: string | null }>>`
        INSERT INTO ${table} AS i (id, role, host, ready_at)
        VALUES (${id}::uuid, ${role}, ${host}, CASE WHEN ${ready} THEN now() END)
        ON CONFLICT (id) DO UPDATE SET last_seen_at = now(),
          ready_at = coalesce(i.ready_at, EXCLUDED.ready_at)
        RETURNING schema_level`;
      if (!levelChecked) {
        levelChecked = true;
        if ((rows[0]?.schema_level ?? null) === null)
          logEvent("instance.unregistered", { service: role, rowId: id });
      }
    } catch (error) {
      if (isMissingTable(error)) {
        if (!missingWarned) logEvent("instance.registry-missing", { service: role });
        missingWarned = true;
        return;
      }
      logInternalError("instance.heartbeat", error, { service: role });
    }
  }

  function cycle() {
    if (stopped) return;
    clearTimeout(timer);
    chain = chain.then(tick).then(() => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(cycle, HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
    });
  }

  cycle();
  return {
    markReady() {
      if (ready || stopped) return;
      ready = true;
      cycle();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
