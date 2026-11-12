import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat, statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { KB_LIMITS } from "./limits";
import { HeldLockLease, type LockQuery } from "./lock";
import { KbAdmissionError } from "./principal";

export type QuotaDimension =
  | "OWNER_LIVE_KB"
  | "KB_BRANCH"
  | "KB_HISTORY_BYTES"
  | "KB_LINEAGE_BYTES"
  | "OWNER_LINEAGE_BYTES";

export type QuotaReservationOutcome = "RESERVED" | "COMMITTED" | "RELEASED" | "EXPIRED";

const DISK_VOLUME = "DISK_VOLUME";
const MAX_RESERVATION_ENTRIES = 32;
const execFileAsync = promisify(execFile);

export type DiskMeter = {
  freeBytes(): Promise<bigint>;
};

export type DiskAllocation = {
  /** Existing allocation directory; quota derives its shared filesystem identity. */
  path: string;
  /** New physical bytes, counted once independently of logical lineage/history. */
  bytes: bigint;
  meter: DiskMeter;
};

export type QuotaCharge = {
  dimension: QuotaDimension;
  subjectId: string;
  amount: bigint;
};

export type QuotaLease = {
  opId: string;
  reservationIds: string[];
  charges: QuotaCharge[];
};

/**
 * A lease owns standalone transactions. Composition must explicitly supply the
 * current READ COMMITTED transaction callback (e.g. the authority barrier query).
 * Its caller owns COMMIT and publication bookkeeping. Never pass an autocommit query.
 */
export type QuotaSession = HeldLockLease | { transactionQuery: LockQuery };

export function capacityFor(dimension: QuotaDimension): bigint {
  switch (dimension) {
    case "OWNER_LIVE_KB":
      return BigInt(KB_LIMITS.ownedLiveKbsPerUser);
    case "KB_BRANCH":
      return BigInt(KB_LIMITS.branchesPerKb);
    case "KB_HISTORY_BYTES":
      return KB_LIMITS.gitHistoryBytesPerKb;
    case "KB_LINEAGE_BYTES":
      return KB_LIMITS.casLineageBytesPerKb;
    case "OWNER_LINEAGE_BYTES":
      return KB_LIMITS.casLineageBytesPerOwner;
    default: {
      const exhaustive: never = dimension;
      return exhaustive;
    }
  }
}

export function statfsDiskMeter(path: string): DiskMeter {
  return {
    async freeBytes() {
      const stats = await statfs(path, { bigint: true });
      return stats.bavail * stats.bsize;
    },
  };
}

/** Same filesystem account for cache, staging, Git and export allocations. */
export async function diskVolumeIdentity(path: string): Promise<string> {
  const stats = await stat(path, { bigint: true });
  if (!stats.isDirectory())
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Disk allocation directory unavailable");
  const { stdout } = await execFileAsync(
    "/usr/bin/stat",
    ["--file-system", "--format=%t:%i", "--", path],
    { encoding: "utf8", timeout: 1000, maxBuffer: 128, env: { LC_ALL: "C" } },
  );
  const id = stdout.trim();
  if (!/^[0-9a-f]+:[0-9a-f]+$/.test(id) || /:0+$/.test(id))
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Filesystem identity unavailable");
  return `fs:${id}`;
}

export async function assertDiskFloor(meter: DiskMeter, extraBytes = 0n): Promise<void> {
  let free: bigint;
  try {
    free = await meter.freeBytes();
  } catch {
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Disk measurement unavailable");
  }
  if (free < KB_LIMITS.freeDiskFloorBytes + extraBytes) {
    throw new KbAdmissionError("QUOTA_EXCEEDED", "Insufficient free disk");
  }
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Quota storage unavailable");
}

async function failClosed<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KbAdmissionError) throw error;
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Quota storage unavailable");
  }
}

async function withQuotaTransaction<T>(
  session: QuotaSession,
  work: (query: LockQuery) => Promise<T>,
): Promise<T> {
  if (session instanceof HeldLockLease) return session.transaction(work);
  const query = session.transactionQuery;
  // SAVEPOINT fails outside an explicit transaction, including on a read-only
  // prefix with no assigned xid. It also isolates a caught multi-charge failure.
  const savepoint = `quota_${randomUUID().replaceAll("-", "")}`;
  await query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await work(query);
    await query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await query(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

/** Lock volumes before any logical accounts/reservations, in volume-id order. */
export async function lockReservationVolumes(
  query: LockQuery,
  ids: readonly string[],
): Promise<void> {
  await query(
    `SELECT a.id FROM "quota_account" a
      WHERE a.dimension = 'DISK_VOLUME'::"QuotaDimension"
        AND EXISTS (SELECT 1 FROM "quota_reservation" r
                     WHERE r."accountId" = a.id AND r.id = ANY($1::text[]))
      ORDER BY a."subjectId" COLLATE "C"
      FOR UPDATE OF a`,
    [ids],
  );
}

async function insertCharge(
  query: LockQuery,
  input: {
    accountId: string;
    reservationId: string;
    dimension: string;
    subjectId: string;
    amount: bigint;
    capacity: bigint;
    includeCommitted: boolean;
    opId: string;
    expiresAt: Date;
    heldForPublication: boolean;
  },
): Promise<string> {
  const charged = await query<{ id: string }>(
    `INSERT INTO "quota_account" (id, dimension, "subjectId", committed, reserved, "updatedAt")
     SELECT $1, $2::"QuotaDimension", $3, 0, $4::bigint, now()
      WHERE $4::bigint <= $6::bigint
     ON CONFLICT (dimension, "subjectId") DO UPDATE
       SET reserved = "quota_account".reserved + EXCLUDED.reserved,
           "updatedAt" = now()
     WHERE CASE WHEN $5::boolean
       THEN "quota_account".committed + "quota_account".reserved + EXCLUDED.reserved
       ELSE "quota_account".reserved + EXCLUDED.reserved
     END <= $6::bigint
     RETURNING id`,
    [
      input.accountId,
      input.dimension,
      input.subjectId,
      input.amount.toString(),
      input.includeCommitted,
      input.capacity.toString(),
    ],
  );
  const accountId = charged.rows[0]?.id;
  if (!accountId) throw new KbAdmissionError("QUOTA_EXCEEDED", "Quota exceeded");
  await query(
    `INSERT INTO "quota_reservation" (
       id, "accountId", amount, "opId", "expiresAt", outcome, "heldForPublication"
     )
     VALUES ($1, $2, $3::bigint, $4, $5::timestamptz, 'RESERVED'::"QuotaReservationOutcome", $6)`,
    [
      input.reservationId,
      accountId,
      input.amount.toString(),
      input.opId,
      input.expiresAt.toISOString(),
      input.heldForPublication,
    ],
  );
  return input.reservationId;
}

export async function reserveQuota(
  session: QuotaSession,
  input: {
    opId: string;
    /** At most 32 distinct logical accounts per reservation transaction. */
    charges: readonly QuotaCharge[];
    expiresAt: Date;
    /** At most 32 allocations; include zero-byte existing-CAS imports. */
    disks: readonly DiskAllocation[];
    id?: () => string;
    heldForPublication?: boolean;
  },
): Promise<QuotaLease> {
  // Multiple operations can charge the same account (two lineage charges per
  // new asset). Bound accounts, preserving every positive byte before admission.
  const accounts = new Map<string, QuotaCharge>();
  for (const charge of input.charges) {
    if (charge.amount <= 0n) throw new KbAdmissionError("QUOTA_EXCEEDED", "Quota exceeded");
    const key = JSON.stringify([charge.dimension, charge.subjectId]);
    const previous = accounts.get(key);
    accounts.set(key, { ...charge, amount: (previous?.amount ?? 0n) + charge.amount });
    if (accounts.size > MAX_RESERVATION_ENTRIES)
      throw new KbAdmissionError("QUOTA_EXCEEDED", "Too many quota allocations");
  }
  const charges = [...accounts.values()];
  if (input.disks.length > MAX_RESERVATION_ENTRIES) {
    throw new KbAdmissionError("QUOTA_EXCEEDED", "Too many quota allocations");
  }
  if (input.disks.length === 0 || input.disks.some((disk) => !disk.path || disk.bytes < 0n)) {
    throw new KbAdmissionError("QUOTA_EXCEEDED", "Invalid disk allocation");
  }
  const nextId = input.id ?? crypto.randomUUID.bind(crypto);
  const heldForPublication = input.heldForPublication === true;
  return failClosed(async () => {
    // GNU stat exposes statfs.f_fsid, which Node's statfs omits. Unlike a path,
    // mount ID or st_dev (e.g. Btrfs subvolumes), this identifies the filesystem
    // across directory/mount aliases and remounts. Linux runtime images already
    // provide /usr/bin/stat via Debian's essential coreutils package.
    // Resolve here so callers cannot split one pool with arbitrary account IDs.
    const volumes = new Map<string, { volumeId: string; bytes: bigint; meters: DiskMeter[] }>();
    for (const disk of input.disks) {
      const volumeId = await diskVolumeIdentity(disk.path);
      const volume = volumes.get(volumeId) ?? { volumeId, bytes: 0n, meters: [] };
      volume.bytes += disk.bytes;
      volume.meters.push(disk.meter);
      volumes.set(volumeId, volume);
    }
    return withQuotaTransaction(session, async (query) => {
      const reservationIds: string[] = [];
      // The row lock precedes measurement and is retained through transaction
      // completion. Finalization takes the same lock before dropping pending
      // bytes. Materialized bytes may be counted twice temporarily, never omitted.
      // Callers finalize only after writes finish (or aborted files are removed).
      const disks = [...volumes.values()].sort((a, b) =>
        Buffer.compare(Buffer.from(a.volumeId), Buffer.from(b.volumeId)),
      );
      for (const disk of disks) {
        await query(
          `INSERT INTO "quota_account" (id, dimension, "subjectId", committed, reserved, "updatedAt")
           VALUES ($1, 'DISK_VOLUME', $2, 0, 0, now())
           ON CONFLICT (dimension, "subjectId") DO NOTHING`,
          [nextId(), disk.volumeId],
        );
        const locked = await query<{ id: string; reserved: unknown }>(
          `SELECT id, reserved FROM "quota_account"
            WHERE dimension = 'DISK_VOLUME' AND "subjectId" = $1 FOR UPDATE`,
          [disk.volumeId],
        );
        const account = locked.rows[0];
        if (!account)
          throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Quota storage unavailable");
        const pending = asBigInt(account.reserved);
        for (const meter of disk.meters) {
          await assertDiskFloor(meter, pending + disk.bytes);
        }
        if (disk.bytes > 0n) {
          await query(
            `UPDATE "quota_account" SET reserved = reserved + $1::bigint, "updatedAt" = now()
              WHERE id = $2`,
            [disk.bytes.toString(), account.id],
          );
          const id = nextId();
          await query(
            `INSERT INTO "quota_reservation" (id, "accountId", amount, "opId", "expiresAt", "heldForPublication")
             VALUES ($1, $2, $3::bigint, $4, $5::timestamptz, $6)`,
            [
              id,
              account.id,
              disk.bytes.toString(),
              input.opId,
              input.expiresAt.toISOString(),
              heldForPublication,
            ],
          );
          reservationIds.push(id);
        }
      }
      for (const charge of charges) {
        reservationIds.push(
          await insertCharge(query, {
            accountId: nextId(),
            reservationId: nextId(),
            dimension: charge.dimension,
            subjectId: charge.subjectId,
            amount: charge.amount,
            capacity: capacityFor(charge.dimension),
            includeCommitted: true,
            opId: input.opId,
            expiresAt: input.expiresAt,
            heldForPublication,
          }),
        );
      }
      return { opId: input.opId, reservationIds, charges };
    });
  });
}

async function finalizeReservation(
  query: LockQuery,
  reservationId: string,
  next: Exclude<QuotaReservationOutcome, "RESERVED">,
  now: Date,
): Promise<"applied" | "replay" | "absent"> {
  const allowExpiredCommit = next === "COMMITTED";
  const claimed = await query<{
    accountId: string;
    amount: unknown;
    dimension: string;
  }>(
    `UPDATE "quota_reservation" AS r
        SET outcome = $2::"QuotaReservationOutcome", "releasedAt" = now()
       FROM "quota_account" AS a
      WHERE r.id = $1
        AND r."accountId" = a.id
        AND r.outcome = 'RESERVED'::"QuotaReservationOutcome"
        AND r."releasedAt" IS NULL
        AND (
          $2::"QuotaReservationOutcome" <> 'COMMITTED'::"QuotaReservationOutcome"
          OR r."heldForPublication"
          OR r."expiresAt" > $3::timestamptz
        )
     RETURNING r."accountId", r.amount, a.dimension::text AS dimension`,
    [reservationId, next, now.toISOString()],
  );
  const row = claimed.rows[0];
  if (row) {
    const amount = asBigInt(row.amount);
    const consumeCommitted = next === "COMMITTED" && row.dimension !== DISK_VOLUME;
    const moved = consumeCommitted
      ? await query(
          `UPDATE "quota_account"
              SET reserved = reserved - $1::bigint,
                  committed = committed + $1::bigint,
                  "updatedAt" = now()
            WHERE id = $2 AND reserved >= $1::bigint`,
          [amount.toString(), row.accountId],
        )
      : await query(
          `UPDATE "quota_account"
              SET reserved = reserved - $1::bigint, "updatedAt" = now()
            WHERE id = $2 AND reserved >= $1::bigint`,
          [amount.toString(), row.accountId],
        );
    if ((moved.rowCount ?? 0) < 1) {
      throw new KbAdmissionError("STORAGE_UNAVAILABLE", "Quota storage unavailable");
    }
    return "applied";
  }
  const existing = await query<{ outcome: string }>(
    `SELECT outcome::text AS outcome FROM "quota_reservation" WHERE id = $1`,
    [reservationId],
  );
  const outcome = existing.rows[0]?.outcome;
  if (!outcome) return "absent";
  if (next === "COMMITTED" && outcome === "COMMITTED") return "replay";
  if ((next === "RELEASED" || next === "EXPIRED") && outcome !== "RESERVED") return "replay";
  if (allowExpiredCommit) return "absent";
  return "replay";
}

/** Move one committed OWNER_LIVE_KB charge between users inside an authority transaction. */
export async function transferCommittedOwnerLiveKb(
  session: QuotaSession,
  input: { fromUserId: string; toUserId: string; opId: string },
): Promise<void> {
  const amount = 1n;
  await failClosed(() =>
    withQuotaTransaction(session, async (query) => {
      await releaseCommittedCharge(
        { transactionQuery: query },
        {
          dimension: "OWNER_LIVE_KB",
          subjectId: input.fromUserId,
          amount,
          opId: `${input.opId}:release`,
        },
      );
      const capacity = capacityFor("OWNER_LIVE_KB");
      const accountId = randomUUID();
      const charged = await query<{ id: string }>(
        `INSERT INTO "quota_account" (id, dimension, "subjectId", committed, reserved, "updatedAt")
         SELECT $1, 'OWNER_LIVE_KB'::"QuotaDimension", $2, $3::bigint, 0, now()
         ON CONFLICT (dimension, "subjectId") DO UPDATE
           SET committed = "quota_account".committed + $3::bigint,
               "updatedAt" = now()
         WHERE "quota_account".committed + "quota_account".reserved + $3::bigint <= $4::bigint
         RETURNING id`,
        [accountId, input.toUserId, amount.toString(), capacity.toString()],
      );
      if (!charged.rows[0]) {
        throw new KbAdmissionError("QUOTA_EXCEEDED", "Quota exceeded");
      }
      await query(
        `INSERT INTO "quota_reservation" (
           id, "accountId", amount, "opId", "expiresAt", outcome, "heldForPublication"
         )
         VALUES ($1, $2, $3::bigint, $4, now() + interval '1 hour', 'COMMITTED'::"QuotaReservationOutcome", false)`,
        [randomUUID(), charged.rows[0].id, amount.toString(), `${input.opId}:commit`],
      );
    }),
  );
}

/** Release a previously committed logical charge exactly once (e.g. owner live KB on tombstone). */
export async function releaseCommittedCharge(
  session: QuotaSession,
  input: { dimension: QuotaDimension; subjectId: string; amount: bigint; opId: string },
): Promise<void> {
  if (input.amount <= 0n) {
    throw new KbAdmissionError("QUOTA_EXCEEDED", "Invalid quota release");
  }
  await failClosed(() =>
    withQuotaTransaction(session, async (query) => {
      const existing = await query<{ id: string }>(
        `SELECT id FROM "quota_reservation"
          WHERE "opId" = $1 AND outcome = 'RELEASED'::"QuotaReservationOutcome"`,
        [input.opId],
      );
      if (existing.rows[0]) return;
      const account = await query<{ id: string; committed: unknown }>(
        `SELECT id, committed FROM "quota_account"
          WHERE dimension = $1::"QuotaDimension" AND "subjectId" = $2
          FOR UPDATE`,
        [input.dimension, input.subjectId],
      );
      const row = account.rows[0];
      if (!row) return;
      const committed = asBigInt(row.committed);
      if (committed < input.amount) return;
      await query(
        `UPDATE "quota_account"
            SET committed = committed - $1::bigint, "updatedAt" = now()
          WHERE id = $2`,
        [input.amount.toString(), row.id],
      );
      const reservationId = randomUUID();
      await query(
        `INSERT INTO "quota_reservation" (
           id, "accountId", amount, "opId", "expiresAt", outcome, "heldForPublication"
         )
         VALUES ($1, $2, $3::bigint, $4, now() + interval '1 hour', 'RELEASED'::"QuotaReservationOutcome", false)`,
        [reservationId, row.id, input.amount.toString(), input.opId],
      );
    }),
  );
}

export async function releaseQuota(
  session: QuotaSession,
  reservationIds: readonly string[],
): Promise<void> {
  await failClosed(() =>
    withQuotaTransaction(session, async (query) => {
      await lockReservationVolumes(query, reservationIds);
      const now = new Date();
      for (const reservationId of reservationIds) {
        await finalizeReservation(query, reservationId, "RELEASED", now);
      }
    }),
  );
}

export async function commitQuota(
  session: QuotaSession,
  reservationIds: readonly string[],
): Promise<void> {
  await failClosed(() =>
    withQuotaTransaction(session, async (query) => {
      await lockReservationVolumes(query, reservationIds);
      const now = new Date();
      for (const reservationId of reservationIds) {
        const result = await finalizeReservation(query, reservationId, "COMMITTED", now);
        if (result === "absent") {
          throw new KbAdmissionError("QUOTA_EXCEEDED", "Reservation cannot be committed");
        }
      }
    }),
  );
}

export async function expireQuota(session: QuotaSession, now = new Date()): Promise<number> {
  return failClosed(() =>
    withQuotaTransaction(session, async (query) => {
      const due = await query<{ id: string }>(
        `SELECT id FROM "quota_reservation"
          WHERE outcome = 'RESERVED'::"QuotaReservationOutcome"
            AND "releasedAt" IS NULL
            AND "expiresAt" <= $1::timestamptz
            AND NOT "heldForPublication"
          ORDER BY id
          LIMIT 100`,
        [now.toISOString()],
      );
      const ids = due.rows.map((row) => row.id);
      await lockReservationVolumes(query, ids);
      let expired = 0;
      for (const id of ids) {
        const result = await finalizeReservation(query, id, "EXPIRED", now);
        if (result === "applied") expired += 1;
      }
      return expired;
    }),
  );
}

/**
 * Every transition that would add a NEW active share row enforces the
 * per-KB share limit inside the authority transaction (share acceptance and
 * the former-owner share created by ownership transfer). Updating an
 * already-active share never consumes another slot.
 */
export async function assertKbShareCapacityForNewActiveShare(
  query: LockQuery,
  kbId: string,
  userId: string,
): Promise<void> {
  const existing = await query<{ revokedAt: Date | null }>(
    `SELECT "revokedAt" FROM "kb_share" WHERE "kbId" = $1 AND "userId" = $2 FOR UPDATE`,
    [kbId, userId],
  );
  const row = existing.rows[0];
  if (row && row.revokedAt === null) return;
  const counted = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "kb_share" WHERE "kbId" = $1 AND "revokedAt" IS NULL`,
    [kbId],
  );
  if (Number(counted.rows[0]?.count ?? "0") >= KB_LIMITS.sharesPerKb) {
    throw new KbAdmissionError("QUOTA_EXCEEDED", "Knowledge base share limit reached");
  }
}
