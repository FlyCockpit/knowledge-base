import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@knowledge-base/db/client";

import { type CasPublishInput, type PublishedCasBlob, parseCasHash, publishCasBytes } from "./cas";
import { KbDomainError } from "./errors";
import { CAS_BLOB_MAX_BYTES } from "./limits";
import {
  assertKbOperationGateHeld,
  type HeldLockLease,
  isLiveHeldLease,
  type LockQuery,
} from "./lock";
import { KbAdmissionError } from "./principal";
import { commitQuota, type DiskMeter, releaseQuota, reserveQuota } from "./quota";

export type AssetLineageSource = "UPLOAD" | "IMPORT";

export type GrantLineageInput = {
  kbId: string;
  hash: string;
  actorKey: string;
  actorUserIdSnapshot: string;
  actorUserId?: string | null;
  source: AssetLineageSource;
  sourceKbId?: string | null;
  sourceRev?: string | null;
};

async function upsertAssetBlobCatalogQuery(
  query: LockQuery,
  input: { hash: string; size: number; mime: string },
): Promise<void> {
  await query(
    `INSERT INTO "asset_blob" (hash, size, mime, "verifiedAt")
     VALUES ($1, $2, $3, now())
     ON CONFLICT (hash) DO NOTHING`,
    [input.hash, input.size, input.mime],
  );
}

async function grantKbAssetLineageQuery(
  query: LockQuery,
  input: GrantLineageInput,
): Promise<boolean> {
  const inserted = await query<{ hash: string }>(
    `INSERT INTO "kb_asset_lineage" (
       "kbId", hash, "actorKey", "actorUserIdSnapshot", "actorUserId", source, "sourceKbId", "sourceRev"
     ) VALUES ($1, $2, $3, $4, $5, $6::"KbAssetLineageSource", $7, $8)
     ON CONFLICT ("kbId", hash) DO NOTHING RETURNING hash`,
    [
      input.kbId,
      input.hash,
      input.actorKey,
      input.actorUserIdSnapshot,
      input.actorUserId ?? null,
      input.source,
      input.sourceKbId ?? null,
      input.sourceRev ?? null,
    ],
  );
  return inserted.rows.length > 0;
}

export async function hasKbLineage(db: PrismaClient, kbId: string, hash: string): Promise<boolean> {
  const row = await db.kbAssetLineage.findUnique({
    where: { kbId_hash: { kbId, hash } },
    select: { hash: true },
  });
  return row !== null;
}

async function hasKbLineageQuery(query: LockQuery, kbId: string, hash: string): Promise<boolean> {
  const result = await query<{ hash: string }>(
    `SELECT hash FROM "kb_asset_lineage" WHERE "kbId" = $1 AND hash = $2 LIMIT 1`,
    [kbId, hash],
  );
  return result.rows.length > 0;
}

export type PublishCasWithCatalogInput = CasPublishInput & {
  assetsDir: string;
  quota: {
    session: HeldLockLease;
    /** Trusted meter dependency; allocation directory and bytes are derived here. */
    disk: { meter: DiskMeter };
  };
  grantLineage: GrantLineageInput;
};

/** All settlement paths lock the attempt before disk, then logical quota accounts. */
async function lockPublication(query: LockQuery, id: string) {
  const result = await query<{ state: string; reservationIds: string[] }>(
    `SELECT state::text AS state, "reservationIds" FROM "cas_publication"
      WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0];
}

async function finishPublication(
  query: LockQuery,
  id: string,
  state: "FINALIZED" | "ABORTED",
): Promise<void> {
  await query(
    `UPDATE "cas_publication" SET state = $2::"CasPublicationState", "finishedAt" = now()
      WHERE id = $1 AND state = 'PENDING'::"CasPublicationState"`,
    [id, state],
  );
}

async function abortPublication(query: LockQuery, id: string): Promise<void> {
  const attempt = await lockPublication(query, id);
  if (attempt?.state !== "PENDING") return;
  await releaseQuota({ transactionQuery: query }, attempt.reservationIds);
  await finishPublication(query, id, "ABORTED");
}

/**
 * Called only by fenced recovery, under the same drained KB operation gate and
 * advisory lock as writers. Pending bytes never establish catalog or lineage.
 * Batches release DB row locks between transactions in the recovery caller.
 */
export async function recoverCasPublications(query: LockQuery, kbId: string): Promise<boolean> {
  assertKbOperationGateHeld(kbId);
  const pending = await query<{ id: string }>(
    `SELECT id FROM "cas_publication"
      WHERE "kbId" = $1 AND state = 'PENDING'::"CasPublicationState"
      ORDER BY id LIMIT 1`,
    [kbId],
  );
  const row = pending.rows[0];
  if (!row) return false;
  await abortPublication(query, row.id);
  return true;
}

/**
 * Caller authorizes the actor and supplies the coordinator's held KB lease.
 * This primitive enforces gate/lease ownership and owns quota + lineage as one
 * inseparable transition. Only immutable orphan bytes survive a failed attempt.
 */
export async function publishCasWithCatalog(
  input: PublishCasWithCatalogInput,
): Promise<PublishedCasBlob> {
  if (!input.quota || !input.grantLineage) {
    throw new KbDomainError("INVALID_ARGUMENT", "Publication requires quota and lineage");
  }
  const grant = { ...input.grantLineage };
  if (grant.hash !== input.declaredHash) {
    throw new KbDomainError("INVALID_ARGUMENT", "Lineage hash must match published content");
  }
  parseCasHash(input.declaredHash);
  if (
    !Number.isInteger(input.declaredSize) ||
    input.declaredSize < 1 ||
    input.declaredSize > CAS_BLOB_MAX_BYTES
  ) {
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid declared size");
  }
  const session = input.quota.session;
  if (!isLiveHeldLease(session)) {
    throw new KbAdmissionError(
      "STORAGE_UNAVAILABLE",
      "Publication requires a held operation lease",
    );
  }
  // SQL lock ownership alone is insufficient: the in-process gate remains held
  // through cancellation/connection loss until byte I/O and cleanup have joined.
  assertKbOperationGateHeld(grant.kbId);
  session.assertHeldKb(grant.kbId);
  session.assertCanReceiveNetworkBody();
  const id = randomUUID();
  try {
    await session.transaction(async (query) => {
      const kb = await query<{ ownerId: string | null; state: string }>(
        `SELECT "ownerId", state::text AS state FROM "knowledge_base" WHERE id = $1`,
        [grant.kbId],
      );
      const owner = kb.rows[0];
      if (!owner?.ownerId || owner.state !== "ACTIVE") {
        throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
      }
      const exists = await hasKbLineageQuery(query, grant.kbId, grant.hash);
      const amount = BigInt(input.declaredSize);
      const quota = await reserveQuota(
        { transactionQuery: query },
        {
          opId: id,
          expiresAt: new Date(Date.now() + 3_600_000),
          // The held KB lock pins owner identity. Another publication within
          // this operation can establish lineage while our bytes are streaming.
          charges: exists
            ? []
            : [
                { dimension: "KB_LINEAGE_BYTES", subjectId: grant.kbId, amount },
                { dimension: "OWNER_LINEAGE_BYTES", subjectId: owner.ownerId, amount },
              ],
          // Even dedup streams materialize a private temp of the declared length.
          disks: [{ path: input.assetsDir, meter: input.quota.disk.meter, bytes: amount }],
          heldForPublication: true,
        },
      );
      await query(
        `INSERT INTO "cas_publication" (id, "kbId", "reservationIds") VALUES ($1, $2, $3::text[])`,
        [id, grant.kbId, quota.reservationIds],
      );
    });
    const published = await publishCasBytes({
      ...input,
      deadlineAt: session.scope.deadlineAt,
      signal: input.signal
        ? AbortSignal.any([input.signal, session.scope.signal])
        : session.scope.signal,
    });
    session.assertHeldKb(grant.kbId);
    await session.transaction(async (query) => {
      const attempt = await lockPublication(query, id);
      if (attempt?.state !== "PENDING") {
        throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS publication is no longer pending");
      }
      await upsertAssetBlobCatalogQuery(query, published);
      const inserted = await grantKbAssetLineageQuery(query, grant);
      // Only the actual lineage insertion earns a logical charge, even when
      // multiple publications reserved for it within the same held operation.
      // Settle the FULL list once so both branches lock disk before logical
      // accounts. Either transition releases pending physical bytes; statfs
      // accounts for the durable file independently of reservation outcome.
      if (inserted) await commitQuota({ transactionQuery: query }, attempt.reservationIds);
      else await releaseQuota({ transactionQuery: query }, attempt.reservationIds);
      await finishPublication(query, id, "FINALIZED");
    });
    return published;
  } catch (error) {
    // A failed reservation COMMIT may be ambiguous. Recovery uses the same
    // preallocated attempt ID and its atomically persisted reservation IDs.
    // If this lease is lost/cancelled, the startup/periodic fenced sweep retries.
    try {
      await session.transaction((query) => abortPublication(query, id));
    } catch {
      // Durable PENDING remains recoverable; never claim its quota was released.
    }
    if (error instanceof KbDomainError || error instanceof KbAdmissionError) throw error;
    throw new KbAdmissionError("STORAGE_UNAVAILABLE", "CAS catalog publish failed");
  }
}
