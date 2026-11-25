import { recordAuditEvent } from "./audit";
import { KbDomainError } from "./errors";
import { KB_LIMITS, rateWindowOf } from "./limits";
import type { LockQuery } from "./lock";

/**
 * Instance limits an instance admin may change (Admin → Limits). Each is one
 * AppSetting row; an absent or unreadable row means the default. Every limit
 * is read live at the point it is enforced, on the enforcing transaction:
 *
 * - `createsPerHour`: KB creations per owner per hour, shared by the browser,
 *   MCP and REST create paths (one rate bucket keyed by the owner).
 * - `ownedLiveKbs`: live KBs one user may own (create and ownership transfer).
 * - `childTokensPerApiKey`: live child MCP tokens one REST API key may hold.
 */
export const INSTANCE_LIMITS = {
  createsPerHour: {
    key: "kb.limits.createsPerHour",
    default: KB_LIMITS.createsPerHourPerUser,
    min: 1,
    max: 1000,
  },
  ownedLiveKbs: {
    key: "kb.limits.ownedLiveKbs",
    default: KB_LIMITS.ownedLiveKbsPerUser,
    min: 1,
    max: 10_000,
  },
  childTokensPerApiKey: {
    key: "kb.limits.childTokensPerApiKey",
    default: KB_LIMITS.childTokensPerApiKey,
    min: 1,
    max: 10_000,
  },
} as const;

export type InstanceLimitName = keyof typeof INSTANCE_LIMITS;
export const INSTANCE_LIMIT_NAMES = Object.keys(INSTANCE_LIMITS) as InstanceLimitName[];
export type InstanceLimits = Record<InstanceLimitName, number>;

function limitFrom(name: InstanceLimitName, raw: string | undefined): number {
  const spec = INSTANCE_LIMITS[name];
  if (raw === undefined || !/^[0-9]{1,6}$/.test(raw)) return spec.default;
  const value = Number(raw);
  return value >= spec.min && value <= spec.max ? value : spec.default;
}

/** One limit, read on the caller's (usually lock-holding) transaction. */
export async function readInstanceLimit(
  query: LockQuery,
  name: InstanceLimitName,
): Promise<number> {
  const { rows } = await query<{ value: string }>(`SELECT value FROM app_setting WHERE key = $1`, [
    INSTANCE_LIMITS[name].key,
  ]);
  return limitFrom(name, rows[0]?.value);
}

/** Every limit; bounded by the compile-time key list. */
export async function readInstanceLimits(query: LockQuery): Promise<InstanceLimits> {
  const keys = INSTANCE_LIMIT_NAMES.map((name) => INSTANCE_LIMITS[name].key);
  const { rows } = await query<{ key: string; value: string }>(
    `SELECT key, value FROM app_setting WHERE key = ANY($1::text[])`,
    [keys],
  );
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(
    INSTANCE_LIMIT_NAMES.map((name) => [
      name,
      limitFrom(name, stored.get(INSTANCE_LIMITS[name].key)),
    ]),
  ) as InstanceLimits;
}

/**
 * Instance-admin write in the caller's live-admin authority transaction.
 * Values outside the bounds are rejected (never clamped); each changed value
 * is audited with its before and after.
 */
export async function writeInstanceLimits(
  query: LockQuery,
  actor: { userId: string; opId: string },
  patch: Partial<InstanceLimits>,
): Promise<InstanceLimits> {
  const before = await readInstanceLimits(query);
  for (const name of INSTANCE_LIMIT_NAMES) {
    const next = patch[name];
    if (next === undefined) continue;
    const spec = INSTANCE_LIMITS[name];
    if (!Number.isSafeInteger(next) || next < spec.min || next > spec.max) {
      throw new KbDomainError("INVALID_ARGUMENT", "Invalid instance limit");
    }
  }
  for (const name of INSTANCE_LIMIT_NAMES) {
    const next = patch[name];
    if (next === undefined || next === before[name]) continue;
    await query(
      `INSERT INTO app_setting (key, value, "createdAt", "updatedAt") VALUES ($1, $2, now(), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`,
      [INSTANCE_LIMITS[name].key, String(next)],
    );
    await recordAuditEvent(query, {
      opId: `${actor.opId}:${name}`,
      action: "instance_limit_update",
      outcome: "SUCCESS",
      actorKey: `user:${actor.userId}`,
      actorUserIdSnapshot: actor.userId,
      actorUserId: actor.userId,
      metadata: { limit: name, before: String(before[name]), after: String(next) },
    });
  }
  return readInstanceLimits(query);
}

/**
 * How a create over the hourly budget is explained (web, REST): the live
 * limit, its window and when the caller may retry. Read after the refusal, so
 * it names the budget in force now.
 */
export async function describeCreateLimit(
  query: LockQuery,
  retryAfterSeconds: number | undefined,
): Promise<{ limit: number; windowSeconds: number; retryAfterSeconds: number; message: string }> {
  const { durationSeconds: windowSeconds } = rateWindowOf("create");
  const limit = await readInstanceLimit(query, "createsPerHour");
  const retry = retryAfterSeconds ?? windowSeconds;
  return {
    limit,
    windowSeconds,
    retryAfterSeconds: retry,
    message: `You can create ${limit} knowledge bases per ${windowSeconds / 60} minutes. Try again in ${retry}s.`,
  };
}
