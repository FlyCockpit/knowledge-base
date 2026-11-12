/// <reference path="./pg.d.ts" />
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { forEachPage } from "../pagination";
import type { AssetStorageLifecycle } from "./asset-storage-lifecycle";
import { parseCasHash } from "./cas";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import type { LockQuery } from "./lock";
import { KbAdmissionError } from "./principal";
import { type DiskMeter, releaseQuota, reserveQuota } from "./quota";

export const cacheUnavailable = () =>
  new KbAdmissionError("STORAGE_UNAVAILABLE", "Asset cache unavailable");

/** Short READ COMMITTED transactions, never a caller's authority/KB transaction.
 * The implementation must join SQL before returning, including ambiguous COMMIT.
 */
export type AssetCacheTransactions = <T>(
  deadlineAt: number,
  work: (query: LockQuery) => Promise<T>,
) => Promise<T>;

export function createAssetCacheTransactions(connectionString: string): AssetCacheTransactions {
  return async (deadlineAt, work) => {
    const remaining = Math.min(5000, Math.floor(deadlineAt - Date.now()));
    if (remaining < 1) throw cacheUnavailable();
    const client = new Client({
      connectionString,
      application_name: "kb-asset-cache",
      connectionTimeoutMillis: remaining,
      statement_timeout: remaining,
      query_timeout: remaining,
      options: `-c lock_timeout=${remaining} -c idle_in_transaction_session_timeout=${remaining}`,
    });
    let ending: Promise<void> | undefined;
    const timeout = setTimeout(() => {
      ending = client.end();
      void ending.catch(() => {});
    }, remaining);
    // A lost session retains durable claims; it never proves that IO stopped.
    client.on("error", () => {});
    try {
      await client.connect();
      await client.query("BEGIN");
      const query: LockQuery = (sql, values) => {
        if (Date.now() >= deadlineAt) return Promise.reject(cacheUnavailable());
        return client.query(sql, values);
      };
      try {
        const result = await work(query);
        await query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      await (ending ?? client.end());
    }
  };
}

export type AssetCacheBinding = {
  cacheId: string;
  volumeId: string;
  storageGeneration: string;
  /** Canonical mode/locator plus cache configuration generation, excluding secrets. */
  configuration: string;
  limit: bigint;
};

export type CacheEntry = {
  cacheId: string;
  hash: string;
  incarnation: string;
  size: number;
  state: "FILLING" | "READY" | "INVALID" | "EVICTING";
  fillOwner: string;
  tempName: string;
  device: string | null;
  inode: string | null;
  mtimeNs: string | null;
  ctimeNs: string | null;
  finalAlias: boolean;
  tempDirectory: string | null;
  finalDirectory: string | null;
  cleanupAttempt: string | null;
  cleanupOwner: string | null;
  quotaReservations: string[];
  lastFetchSequence: string;
};

export type CachePin = { id: string; entry: CacheEntry };
export type CacheFingerprint = { device: string; inode: string; mtimeNs: string; ctimeNs: string };

type StateRow = {
  storageGeneration: string;
  configuration: string;
  effectiveLimit: string;
  chargedBytes: string;
};

export function createAssetStorageState(input: {
  binding: AssetCacheBinding;
  transactions: AssetCacheTransactions;
  lifecycle: AssetStorageLifecycle;
  assetsDir: string;
  meter: DiskMeter;
}) {
  const { binding: b, lifecycle, transactions } = input;
  if (b.limit < BigInt(CAS_BLOB_MAX_BYTES)) throw cacheUnavailable();
  const lock = async (q: LockQuery, checkLimit = true) => {
    const row = (
      await q<StateRow>(
        `SELECT "storageGeneration", configuration, "effectiveLimit", "chargedBytes"
       FROM asset_cache_state WHERE id=$1 FOR UPDATE`,
        [b.cacheId],
      )
    ).rows[0];
    if (
      !row ||
      row.storageGeneration !== b.storageGeneration ||
      row.configuration !== b.configuration ||
      (checkLimit && BigInt(row.effectiveLimit) !== b.limit)
    )
      throw cacheUnavailable();
    return row;
  };
  const diskLock = async (q: LockQuery) => {
    const held = await q(
      `SELECT id FROM quota_account WHERE dimension='DISK_VOLUME' AND "subjectId"=$1 FOR UPDATE`,
      [b.volumeId],
    );
    if (!held.rows.length) throw cacheUnavailable();
  };
  const run = <T>(deadline: number, work: (q: LockQuery, state: StateRow) => Promise<T>) =>
    transactions(deadline, async (q) => {
      await diskLock(q);
      return work(q, await lock(q));
    });
  const owner = async (q: LockQuery) => {
    if (
      !(
        await q(
          `SELECT epoch FROM asset_cache_owner WHERE epoch=$1::uuid AND "cacheId"=$2 AND role=$3::"AssetStorageRole" AND NOT retired`,
          [lifecycle.epoch, b.cacheId, lifecycle.role],
        )
      ).rows.length
    )
      throw cacheUnavailable();
  };
  const exact = async (q: LockQuery, entry: CacheEntry) =>
    (
      await q<CacheEntry>(
        `SELECT * FROM asset_cache_entry WHERE "cacheId"=$1 AND hash=$2 AND incarnation=$3::uuid FOR UPDATE`,
        [b.cacheId, entry.hash, entry.incarnation],
      )
    ).rows[0];
  const pin = async (q: LockQuery, entry: CacheEntry): Promise<CachePin> => {
    const id = randomUUID();
    await q(
      `INSERT INTO asset_cache_pin (id,incarnation,"ownerEpoch") VALUES ($1::uuid,$2::uuid,$3::uuid)`,
      [id, entry.incarnation, lifecycle.epoch],
    );
    return { id, entry };
  };
  // Every known-drained attempt, including a claim with an ambiguous COMMIT,
  // remains retryable until its exact conditional relinquishment is acknowledged.
  // Attempt tokens are never reused, even within one role generation.
  const drainedCleanups = new Map<string, CacheEntry>();
  const relinquishCleanup = async (entry: CacheEntry, deadline: number) => {
    if (!entry.cleanupAttempt) throw cacheUnavailable();
    const attempt = entry.cleanupAttempt;
    drainedCleanups.set(attempt, entry);
    await run(deadline, async (q) => {
      await q(
        `UPDATE asset_cache_entry SET "cleanupOwner"=NULL WHERE "cacheId"=$1 AND incarnation=$2::uuid AND "cleanupAttempt"=$3::uuid AND "cleanupOwner"=$4::uuid AND state='EVICTING'`,
        [b.cacheId, entry.incarnation, attempt, lifecycle.epoch],
      );
    });
    drainedCleanups.delete(attempt);
  };
  return {
    binding: b,
    /** Caller holds BOTH offline role fences and has verified the empty cache namespace.
     * Attaching to existing metadata never creates/rebuilds or reaps anything.
     */
    async initializeEmpty(assertOfflineFences: () => void, deadline: number) {
      assertOfflineFences();
      await transactions(deadline, async (q) => {
        await q(
          `INSERT INTO quota_account (id,dimension,"subjectId",committed,reserved,"updatedAt")
          VALUES ($1,'DISK_VOLUME',$2,0,0,now()) ON CONFLICT (dimension,"subjectId") DO NOTHING`,
          [randomUUID(), b.volumeId],
        );
        await diskLock(q);
        await q(
          `INSERT INTO asset_cache_state (id,"storageGeneration",configuration,"effectiveLimit","chargedBytes","fetchSequence")
          VALUES ($1,$2::uuid,$3,$4::bigint,0,0) ON CONFLICT (id) DO NOTHING`,
          [b.cacheId, b.storageGeneration, b.configuration, b.limit.toString()],
        );
        await lock(q);
        assertOfflineFences();
      });
    },
    /** Startup only, once per role generation. Fence proof covers this role alone.
     * Same-epoch attachments are idempotent and never reap sibling pins.
     */
    async registerOwner(assertRoleFence: () => void, deadline?: number) {
      const nextDeadline = () => deadline ?? Date.now() + 5000;
      const assertActive = () => {
        lifecycle.signal.throwIfAborted();
        assertRoleFence();
      };
      assertActive();
      await run(nextDeadline(), async (q) => {
        const existing = (
          await q<{ role: string; retired: boolean; cacheId: string }>(
            `SELECT role,retired,"cacheId" FROM asset_cache_owner WHERE epoch=$1::uuid`,
            [lifecycle.epoch],
          )
        ).rows[0];
        if (existing) {
          if (
            existing.role !== lifecycle.role ||
            existing.retired ||
            existing.cacheId !== b.cacheId
          )
            throw cacheUnavailable();
          return;
        }
        // Mark only prior generations of the proven role. Pins are reclaimed in bounded pages below.
        await q(
          `UPDATE asset_cache_owner SET retired=true WHERE "cacheId"=$1 AND role=$2::"AssetStorageRole" AND NOT retired`,
          [b.cacheId, lifecycle.role],
        );
        await q(
          `INSERT INTO asset_cache_owner (epoch,"cacheId",role,retired) VALUES ($1::uuid,$2,$3::"AssetStorageRole",false)`,
          [lifecycle.epoch, b.cacheId, lifecycle.role],
        );
        assertActive();
      });
      await forEachPage(
        ({ afterId, take }) =>
          run(nextDeadline(), async (q) => {
            assertActive();
            return (
              await q<{ id: string }>(
                `SELECT p.id FROM asset_cache_pin p JOIN asset_cache_owner o ON o.epoch=p."ownerEpoch"
            WHERE o."cacheId"=$1 AND o.role=$2::"AssetStorageRole" AND o.retired
              AND ($3::uuid IS NULL OR p.id>$3::uuid) ORDER BY p.id LIMIT $4`,
                [b.cacheId, lifecycle.role, afterId ?? null, take],
              )
            ).rows;
          }),
        100,
        (ids) =>
          run(nextDeadline(), async (q) => {
            assertActive();
            await q(
              `DELETE FROM asset_cache_pin p WHERE p.id=ANY($1::uuid[]) AND EXISTS (
            SELECT 1 FROM asset_cache_owner o WHERE o.epoch=p."ownerEpoch" AND o."cacheId"=$2 AND o.role=$3::"AssetStorageRole" AND o.retired)`,
              [ids.map((r) => r.id), b.cacheId, lifecycle.role],
            );
          }),
      );
      let after = "";
      for (;;) {
        const rows = await run(nextDeadline(), async (q) => {
          assertActive();
          const entries = (
            await q<CacheEntry>(
              `SELECT e.* FROM asset_cache_entry e
            WHERE e."cacheId"=$1 AND e.hash>$2 AND (
              (e.state='FILLING' AND EXISTS (SELECT 1 FROM asset_cache_owner o WHERE o.epoch=e."fillOwner" AND o.retired AND o.role=$3::"AssetStorageRole"))
              OR EXISTS (SELECT 1 FROM asset_cache_owner o WHERE o.epoch=e."cleanupOwner" AND o.retired AND o.role=$3::"AssetStorageRole"))
            ORDER BY e.hash LIMIT 100 FOR UPDATE OF e`,
              [b.cacheId, after, lifecycle.role],
            )
          ).rows;
          if (entries.length)
            await q(
              `UPDATE asset_cache_entry e SET
              state=CASE WHEN state='FILLING' AND EXISTS (SELECT 1 FROM asset_cache_owner WHERE epoch=e."fillOwner" AND retired) THEN 'INVALID'::"AssetCacheStatus" ELSE state END,
              "cleanupOwner"=CASE WHEN EXISTS (SELECT 1 FROM asset_cache_owner WHERE epoch=e."cleanupOwner" AND retired) THEN NULL ELSE "cleanupOwner" END
              WHERE incarnation=ANY($1::uuid[]) AND "cacheId"=$2`,
              [entries.map((e) => e.incarnation), b.cacheId],
            );
          return entries;
        });
        if (!rows.length) break;
        after = rows[rows.length - 1]!.hash;
      }
    },
    async inspectAlias(
      column: "hash" | "tempName",
      value: string,
      deadline: number,
      // Only synchronous filesystem observation is allowed here. The cache lock
      // fences identity recording, promotion and incarnation removal/refill;
      // an unrecorded creator cannot write until recordFile commits.
      inspect?: (entry: CacheEntry | undefined) => undefined,
    ) {
      return run(deadline, async (q) => {
        const entry = (
          await q<CacheEntry>(
            `SELECT * FROM asset_cache_entry WHERE "cacheId"=$1 AND "${column}"=$2 LIMIT 1`,
            [b.cacheId, value],
          )
        ).rows[0];
        inspect?.(entry);
        return entry;
      });
    },
    async inspectAliases(
      column: "hash" | "tempName",
      values: string[],
      deadline: number,
      inspect: (value: string, entry: CacheEntry | undefined) => undefined,
    ) {
      if (!values.length || values.length > 100) throw cacheUnavailable();
      await run(deadline, async (q) => {
        const entries = (
          await q<CacheEntry>(
            // Fence each point probe and defer the cacheId constant to an
            // InitPlan. A new cacheId absent from stale MCV statistics otherwise
            // looks like one row: the planner can scan the temp-name index's
            // entire cacheId prefix for EVERY hash instead of using both keys.
            `SELECT e.* FROM unnest($2::text[]) a(value) CROSS JOIN LATERAL (
              SELECT * FROM asset_cache_entry WHERE "cacheId"=(SELECT $1::text OFFSET 0) AND "${column}"=a.value LIMIT 1
            ) e LIMIT 100`,
            [b.cacheId, values],
          )
        ).rows;
        const byValue = new Map(entries.map((e) => [e[column], e]));
        // All observations happen synchronously under the same lock as cache
        // identity/promotion/removal, including unknown names and absent aliases.
        for (const value of values) inspect(value, byValue.get(value));
      });
    },
    async checkAccounting(deadline: number) {
      await run(deadline, async (q, s) => {
        const totals = (
          await q<{ bytes: string }>(
            `SELECT COALESCE(sum(size),0)::text AS bytes FROM asset_cache_entry WHERE "cacheId"=$1`,
            [b.cacheId],
          )
        ).rows[0]!;
        if (BigInt(totals.bytes) !== BigInt(s.chargedBytes)) throw cacheUnavailable();
      });
    },
    async acquire(hash: string, size: number, deadline: number): Promise<CachePin | undefined> {
      parseCasHash(hash);
      return run(deadline, async (q) => {
        await owner(q);
        const e = (
          await q<CacheEntry>(
            `SELECT * FROM asset_cache_entry WHERE "cacheId"=$1 AND hash=$2 AND state='READY' FOR UPDATE`,
            [b.cacheId, hash],
          )
        ).rows[0];
        if (!e) return;
        if (e.size !== size) throw cacheUnavailable();
        return pin(q, e);
      });
    },
    async reserve(
      hash: string,
      size: number,
      deadline: number,
      allocationPath: string,
    ): Promise<CachePin | undefined> {
      parseCasHash(hash);
      if (!Number.isSafeInteger(size) || size < 1) throw cacheUnavailable();
      if (BigInt(size) > b.limit) return;
      return run(deadline, async (q, s) => {
        await owner(q);
        if (
          (
            await q(`SELECT hash FROM asset_cache_entry WHERE "cacheId"=$1 AND hash=$2`, [
              b.cacheId,
              hash,
            ])
          ).rows.length
        )
          return;
        if (BigInt(s.chargedBytes) + BigInt(size) > b.limit) return;
        const incarnation = randomUUID();
        const quota = await reserveQuota(
          { transactionQuery: q },
          {
            opId: incarnation,
            charges: [],
            expiresAt: new Date(deadline),
            heldForPublication: true,
            disks: [{ path: allocationPath, bytes: BigInt(size), meter: input.meter }],
          },
        );
        const e = (
          await q<CacheEntry>(
            `INSERT INTO asset_cache_entry (
          "cacheId",hash,incarnation,size,state,"fillOwner","tempName","finalAlias","quotaReservations","lastFetchSequence")
          VALUES ($1,$2,$3::uuid,$4,'FILLING',$5::uuid,$6,false,$7::text[],0) RETURNING *`,
            [
              b.cacheId,
              hash,
              incarnation,
              size,
              lifecycle.epoch,
              `cache-${incarnation}`,
              quota.reservationIds,
            ],
          )
        ).rows[0]!;
        await q(
          `UPDATE asset_cache_state SET "chargedBytes"="chargedBytes"+$2::bigint WHERE id=$1`,
          [b.cacheId, size],
        );
        return pin(q, e);
      });
    },
    async recordFile(
      entry: CacheEntry,
      fingerprint: CacheFingerprint,
      directory: string,
      deadline: number,
    ) {
      await run(deadline, async (q) => {
        await owner(q);
        const e = await exact(q, entry);
        if (e?.state !== "FILLING" || e.fillOwner !== lifecycle.epoch || e.inode !== null)
          throw cacheUnavailable();
        await q(
          `UPDATE asset_cache_entry SET device=$2,inode=$3,"mtimeNs"=$4,"ctimeNs"=$5,"tempDirectory"=$6 WHERE incarnation=$1::uuid`,
          [
            e.incarnation,
            fingerprint.device,
            fingerprint.inode,
            fingerprint.mtimeNs,
            fingerprint.ctimeNs,
            directory,
          ],
        );
      });
    },
    async beforeLink(entry: CacheEntry, directory: string, deadline: number) {
      await run(deadline, async (q) => {
        await owner(q);
        const e = await exact(q, entry);
        if (e?.state !== "FILLING" || e.fillOwner !== lifecycle.epoch || !e.inode)
          throw cacheUnavailable();
        await q(
          `UPDATE asset_cache_entry SET "finalAlias"=true,"finalDirectory"=$2 WHERE incarnation=$1::uuid`,
          [e.incarnation, directory],
        );
      });
    },
    async ready(entry: CacheEntry, fingerprint: CacheFingerprint, deadline: number) {
      await run(deadline, async (q) => {
        await owner(q);
        const e = await exact(q, entry);
        if (
          e?.state !== "FILLING" ||
          e.fillOwner !== lifecycle.epoch ||
          e.inode !== fingerprint.inode ||
          e.device !== fingerprint.device ||
          !e.finalAlias
        )
          throw cacheUnavailable();
        await releaseQuota({ transactionQuery: q }, e.quotaReservations);
        await q(
          `UPDATE asset_cache_entry SET state='READY',"mtimeNs"=$2,"ctimeNs"=$3,"quotaReservations"='{}' WHERE incarnation=$1::uuid`,
          [e.incarnation, fingerprint.mtimeNs, fingerprint.ctimeNs],
        );
      });
    },
    async invalidate(entry: CacheEntry, deadline: number) {
      await run(deadline, async (q) => {
        await q(
          `UPDATE asset_cache_entry SET state='INVALID' WHERE "cacheId"=$1 AND incarnation=$2::uuid AND state IN ('FILLING','READY')`,
          [b.cacheId, entry.incarnation],
        );
      });
    },
    async release(pin: CachePin, deadline: number) {
      await run(deadline, async (q) => {
        await q(
          `DELETE FROM asset_cache_pin WHERE id=$1::uuid AND incarnation=$2::uuid AND "ownerEpoch"=$3::uuid`,
          [pin.id, pin.entry.incarnation, lifecycle.epoch],
        );
      });
    },
    async isReady(entry: CacheEntry, deadline: number): Promise<boolean> {
      return run(deadline, async (q) => (await exact(q, entry))?.state === "READY");
    },
    async claimCleanup(
      deadline: number,
      hash?: string,
      evictReady = false,
    ): Promise<CacheEntry | undefined> {
      let claimed: CacheEntry | undefined;
      try {
        return await run(deadline, async (q) => {
          await owner(q);
          const candidates: CacheEntry[] = [];
          if (hash !== undefined) {
            const e = (
              await q<CacheEntry>(
                `SELECT e.* FROM asset_cache_entry e WHERE e."cacheId"=$1 AND e.hash=$2
                AND (e.state IN ('INVALID','EVICTING') OR ($3::boolean AND e.state='READY'))
                AND e."cleanupOwner" IS NULL AND NOT EXISTS (SELECT 1 FROM asset_cache_pin p WHERE p.incarnation=e.incarnation)
                LIMIT 1 FOR UPDATE OF e`,
                [b.cacheId, hash, evictReady],
              )
            ).rows[0];
            if (e) candidates.push(e);
          } else {
            // One ordered index probe per state, then compare at most three
            // heads. A multi-state predicate cannot use a state-first index's
            // recency order and would sort the whole cache under both locks.
            const statuses = evictReady
              ? ["INVALID", "EVICTING", "READY"]
              : ["INVALID", "EVICTING"];
            for (const status of statuses) {
              const e = (
                await q<CacheEntry>(
                  `SELECT e.* FROM asset_cache_entry e WHERE e."cacheId"=$1 AND e.state=$2::"AssetCacheStatus"
                  AND e."cleanupOwner" IS NULL AND NOT EXISTS (SELECT 1 FROM asset_cache_pin p WHERE p.incarnation=e.incarnation)
                  ORDER BY e."lastFetchSequence",e.hash COLLATE "C" LIMIT 1 FOR UPDATE OF e`,
                  [b.cacheId, status],
                )
              ).rows[0];
              if (e) candidates.push(e);
            }
          }
          candidates.sort((a, c) => {
            const sequence = BigInt(a.lastFetchSequence) - BigInt(c.lastFetchSequence);
            if (sequence !== 0n) return sequence < 0n ? -1 : 1;
            return a.hash < c.hash ? -1 : a.hash > c.hash ? 1 : 0;
          });
          const e = candidates[0];
          if (!e) return;
          claimed = (
            await q<CacheEntry>(
              `UPDATE asset_cache_entry SET state='EVICTING',"cleanupOwner"=$2::uuid,
          "cleanupAttempt"=$3::uuid WHERE incarnation=$1::uuid RETURNING *`,
              [e.incarnation, lifecycle.epoch, randomUUID()],
            )
          ).rows[0];
          return claimed;
        });
      } catch (error) {
        // No filesystem IO starts until this method returns. A lost COMMIT ACK
        // may therefore relinquish only this exact attempt, never credit bytes.
        if (claimed) await relinquishCleanup(claimed, Date.now() + 5000).catch(() => {});
        throw error;
      }
    },
    async finishCleanup(entry: CacheEntry, deadline: number) {
      await run(deadline, async (q) => {
        const e = await exact(q, entry);
        if (!e) return; // Lost acknowledgement: already credited/removed.
        if (
          e.state !== "EVICTING" ||
          e.cleanupAttempt !== entry.cleanupAttempt ||
          e.cleanupOwner !== lifecycle.epoch
        )
          throw cacheUnavailable();
        if (
          (
            await q(`SELECT id FROM asset_cache_pin WHERE incarnation=$1::uuid LIMIT 1`, [
              e.incarnation,
            ])
          ).rows.length
        )
          throw cacheUnavailable();
        await releaseQuota({ transactionQuery: q }, e.quotaReservations);
        await q(
          `DELETE FROM asset_cache_entry WHERE incarnation=$1::uuid AND "cleanupAttempt"=$2::uuid`,
          [e.incarnation, e.cleanupAttempt],
        );
        await q(
          `UPDATE asset_cache_state SET "chargedBytes"="chargedBytes"-$2::bigint WHERE id=$1`,
          [b.cacheId, e.size],
        );
      });
    },
    relinquishCleanup,
    async relinquishDrainedCleanups() {
      for (const entry of [...drainedCleanups.values()].slice(0, 100))
        await relinquishCleanup(entry, Date.now() + 5000);
    },
    async repairPage(after: string, deadline: number): Promise<string[]> {
      return run(deadline, async (q) =>
        (
          await q<{ hash: string }>(
            `SELECT hash FROM asset_cache_entry WHERE "cacheId"=$1 AND hash>$2 AND state IN ('INVALID','EVICTING') ORDER BY hash LIMIT 100`,
            [b.cacheId, after],
          )
        ).rows.map((r) => r.hash),
      );
    },
    async touch(entry: Pick<CacheEntry, "incarnation">, deadline: number) {
      // Advisory only: no quota/pin read or mutation, no readback/retry on lost ACK.
      await transactions(deadline, async (q) => {
        await lock(q);
        const changed = await q(
          `UPDATE asset_cache_entry SET "lastFetchSequence"=GREATEST("lastFetchSequence",
          (SELECT "fetchSequence"+1 FROM asset_cache_state WHERE id=$1))
          WHERE "cacheId"=$1 AND incarnation=$2::uuid AND state IN ('FILLING','READY') RETURNING hash`,
          [b.cacheId, entry.incarnation],
        );
        if (changed.rows.length)
          await q(`UPDATE asset_cache_state SET "fetchSequence"="fetchSequence"+1 WHERE id=$1`, [
            b.cacheId,
          ]);
      });
    },
    async installLimit(
      limit: bigint,
      configuration: string,
      assertOfflineFences: () => void,
      deadline: number,
    ) {
      if (limit < BigInt(CAS_BLOB_MAX_BYTES)) throw cacheUnavailable();
      assertOfflineFences();
      await run(deadline, async (q, s) => {
        // Caller retired both roles under dual fences and trimmed using the OLD limit.
        if (
          BigInt(s.chargedBytes) > limit ||
          (
            await q(
              `SELECT epoch FROM asset_cache_owner WHERE "cacheId"=$1 AND NOT retired LIMIT 1`,
              [b.cacheId],
            )
          ).rows.length
        )
          throw cacheUnavailable();
        await q(
          `UPDATE asset_cache_state SET "effectiveLimit"=$2::bigint,configuration=$3 WHERE id=$1`,
          [b.cacheId, limit.toString(), configuration],
        );
        assertOfflineFences();
      });
    },
    async retireOffline(assertOfflineFences: () => void, deadline: number) {
      assertOfflineFences();
      await run(deadline, async (q) => {
        await q(`UPDATE asset_cache_owner SET retired=true WHERE "cacheId"=$1`, [b.cacheId]);
        assertOfflineFences();
      });
    },
  };
}
