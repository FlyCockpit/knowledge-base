import type { AssetCacheTransactions } from "./asset-storage-state";
import { cacheUnavailable } from "./asset-storage-state";
import { parseCasHash } from "./cas";
import type { LockQuery } from "./lock";

export type AssetPublicationBinding = { storageGeneration: string; locator: string };
export type AssetStorageRecord = {
  version: 1;
  mode: "s3";
  activeGeneration: string;
  locator: string;
};
type AssetMigrationTarget = {
  attemptId: string;
  state: string;
  targetGeneration: string;
  targetLocator: string;
  targetMode: string;
};

/** Runtime authority must match the active marker. Offline copies are bound to
 * a pending target and synchronous proof of BOTH native role fences. P6 owns
 * installing/activating these records; this module never changes authority.
 */
export function createAssetPublicationState(input: {
  binding: AssetPublicationBinding;
  transactions: AssetCacheTransactions;
  offline?: { attemptId: string; assertOfflineFences(): void };
}) {
  const b = Object.freeze({ ...input.binding });
  const offline = input.offline ? Object.freeze({ ...input.offline }) : undefined;
  const authorize = async (q: LockQuery) => {
    offline?.assertOfflineFences();
    const record = (
      await q<{ value: string }>(
        `SELECT value FROM app_setting WHERE key='kb.asset-storage' FOR SHARE`,
      )
    ).rows[0];
    const active: unknown = record ? JSON.parse(record.value) : undefined;
    // P6 installs the durable control table outside archive-imported metadata.
    // Its absence means migration has never been installed, never an offline
    // target grant. Once present, every pending attempt blocks runtime writes.
    const control = (
      await q<{ relation: string | null }>(
        `SELECT to_regclass('knowledge_base_control.asset_storage_migration')::text AS relation`,
      )
    ).rows[0];
    // Runtime has SELECT-only custody of offline control. Native dual fences
    // and maintenance drain exclude offline changes from live byte work; the
    // active marker above remains share-locked for this publication transaction.
    // FOR SHARE here would require UPDATE grants on operator-owned control.
    const pending = control?.relation
      ? (
          await q<AssetMigrationTarget>(
            `SELECT "attemptId"::text AS "attemptId",state::text AS state,
        "targetGeneration"::text AS "targetGeneration","targetLocator","targetMode"::text AS "targetMode"
        FROM knowledge_base_control.asset_storage_migration WHERE state::text <> 'READY' LIMIT 2`,
          )
        ).rows
      : [];
    const matches = (record: unknown) => {
      if (!record || typeof record !== "object") return false;
      const r = record as Partial<AssetStorageRecord>;
      return (
        r.version === 1 &&
        r.mode === "s3" &&
        r.activeGeneration === b.storageGeneration &&
        r.locator === b.locator
      );
    };
    if (offline) {
      const p = pending[0];
      if (
        pending.length !== 1 ||
        p?.state !== "COPYING" ||
        p.attemptId !== offline.attemptId ||
        p.targetMode !== "s3" ||
        p.targetGeneration !== b.storageGeneration ||
        p.targetLocator !== b.locator
      )
        throw cacheUnavailable();
    } else if (pending.length || !matches(active)) throw cacheUnavailable();
    offline?.assertOfflineFences();
  };
  const run = (hash: string, size: number, deadline: number, durable: boolean) => {
    parseCasHash(hash);
    return input.transactions(deadline, async (q) => {
      await authorize(q);
      if (!durable) {
        await q(
          `INSERT INTO asset_retained_object ("storageGeneration",locator,hash,size,state)
          VALUES ($1::uuid,$2,$3,$4,'PENDING') ON CONFLICT ("storageGeneration",locator,hash) DO NOTHING`,
          [b.storageGeneration, b.locator, hash, size],
        );
      }
      const row = (
        await q<{ size: number }>(
          `SELECT size FROM asset_retained_object
        WHERE "storageGeneration"=$1::uuid AND locator=$2 AND hash=$3 FOR UPDATE`,
          [b.storageGeneration, b.locator, hash],
        )
      ).rows[0];
      if (row?.size !== size) throw cacheUnavailable();
      if (durable)
        await q(
          `UPDATE asset_retained_object SET state='DURABLE'
        WHERE "storageGeneration"=$1::uuid AND locator=$2 AND hash=$3`,
          [b.storageGeneration, b.locator, hash],
        );
    });
  };
  return Object.freeze({
    binding: b,
    scope: offline ? ("offline-target" as const) : ("active" as const),
    pending: (hash: string, size: number, deadline: number) => run(hash, size, deadline, false),
    durable: (hash: string, size: number, deadline: number) => run(hash, size, deadline, true),
  });
}
export type AssetPublicationState = ReturnType<typeof createAssetPublicationState>;
