import { randomUUID } from "node:crypto";
import { recordAuditEvent } from "./audit";
import type { AuthorityBarrier } from "./authority-lock";
import { KbDomainError } from "./errors";
import { cancelIndexBuilds, scheduleIndexBuild, supersedeInactiveGenerations } from "./generations";
import { enqueueKbEmailOnQuery } from "./kb-email";
import { chargeKbMutation, type RatePort } from "./limits";
import type { LockQuery } from "./lock";
import { teardownMirror } from "./mirror";
import { actorKeyForUser, canonicalRequestHash } from "./operation-intent";
import { authorize, expandBits, sqlAuthorityStore } from "./permissions";
import { assertLiveIdentity, type BrowserPrincipal, KbAdmissionError } from "./principal";
import { assertKbShareCapacityForNewActiveShare, transferCommittedOwnerLiveKb } from "./quota";
import type { KbRuntimeConfig } from "./runtime";
import { transferSealedOwnership } from "./sealed-records";

export type TransferLifecycleContext = {
  query: LockQuery;
  kbId: string;
  fromUserId: string;
  toUserId: string;
};

export type TransferLifecycleHandler = (ctx: TransferLifecycleContext) => Promise<void>;

const transferLifecycleHandlers: TransferLifecycleHandler[] = [];

export function registerTransferLifecycleHandler(handler: TransferLifecycleHandler): void {
  transferLifecycleHandlers.push(handler);
}

export function listTransferLifecycleHandlersForTests(): readonly TransferLifecycleHandler[] {
  return transferLifecycleHandlers;
}

/** Generation teardown is part of the ownership transaction. */
registerTransferLifecycleHandler(async ({ query, kbId, toUserId }) => {
  await cancelIndexBuilds(query, kbId);
  await query('UPDATE knowledge_base SET "activeGenerationId"=NULL WHERE id=$1', [kbId]);
  await query(
    `UPDATE knowledge_base k SET "profileProviderId"=NULL,"profileVersion"=NULL,"activeGenerationId"=NULL
    WHERE k.id=$1 AND EXISTS (SELECT FROM embedding_provider p WHERE p.id=k."profileProviderId" AND p.kind<>'SYSTEM_BUILTIN' AND p."ownerId" IS DISTINCT FROM $2)`,
    [kbId, toUserId],
  );
  await supersedeInactiveGenerations(query, kbId);
  await scheduleIndexBuild(query, kbId);
});
/** Recipient must configure fresh mirror credentials: disconnect + cancel attempts. */
registerTransferLifecycleHandler(teardownMirror);
/** Sealed control is exact-owner only; it follows ownership. */
registerTransferLifecycleHandler(({ query, kbId, fromUserId, toUserId }) =>
  transferSealedOwnership(query, { kbId, fromUserId, toUserId }),
);

/**
 * On acceptance the former owner keeps `manage` as an ordinary share
 * that the new owner can remove. Stored expanded, like every other share.
 */
export const FORMER_OWNER_SHARE_BITS = expandBits(["manage"]);

function browserPrincipal(userId: string): BrowserPrincipal {
  return { kind: "browser", userId };
}

export async function transferRequest(
  runtime: KbRuntimeConfig,
  ownerUserId: string,
  input: {
    kbId: string;
    recipientUserId: string;
    metadataVersion: number;
    idempotencyKey: string;
  },
): Promise<{ requestId: string }> {
  const requestHash = canonicalRequestHash(input);
  const opId = randomUUID();
  let requestId: string | undefined;
  await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: transferRequestBarrier({
      ratePort: runtime.ratePort,
      origin: runtime.canonicalOrigin,
      ownerUserId,
      input,
      requestHash,
      setRequestId: (id) => {
        requestId = id;
      },
    }),
    run: async () => {
      if (!requestId) throw new KbDomainError("CONFLICT", "Transfer request failed");
      return { requestId };
    },
  });
  return { requestId: requestId! };
}

function transferRequestBarrier(options: {
  ratePort: RatePort;
  origin: string;
  ownerUserId: string;
  input: {
    kbId: string;
    recipientUserId: string;
    metadataVersion: number;
    idempotencyKey: string;
  };
  requestHash: string;
  setRequestId: (id: string) => void;
}): AuthorityBarrier {
  const { ownerUserId, input, requestHash, setRequestId } = options;
  return {
    async reauthorize(ctx) {
      const kb = await ctx.query<{
        ownerId: string | null;
        metadataVersion: number;
        state: string;
      }>(
        `SELECT "ownerId", "metadataVersion", state::text AS state
           FROM "knowledge_base" WHERE id = $1`,
        [input.kbId],
      );
      const row = kb.rows[0];
      if (!row || row.state === "TOMBSTONED") {
        throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
      }
      if (row.ownerId !== ownerUserId) {
        throw new KbDomainError("FORBIDDEN", "Forbidden");
      }
      const ownerIdentity = await sqlAuthorityStore(ctx.query).loadIdentity(ownerUserId);
      assertLiveIdentity(ownerIdentity);
      await authorize({
        store: sqlAuthorityStore(ctx.query),
        principal: browserPrincipal(ownerUserId),
        kbId: input.kbId,
        operation: "manage",
        query: ctx.query,
      });
    },
    async reservePublication(ctx) {
      const prior = await ctx.query<{
        requestId: string;
        toUserId: string;
        metadataVersion: number;
      }>(
        `SELECT "requestId", "toUserId", "metadataVersion"
           FROM "kb_transfer"
          WHERE "fromUserId" = $1 AND "kbId" = $2 AND "idempotencyKey" = $3
          FOR UPDATE`,
        [ownerUserId, input.kbId, input.idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing) {
        const hash = canonicalRequestHash({
          kbId: input.kbId,
          recipientUserId: existing.toUserId,
          metadataVersion: existing.metadataVersion,
          idempotencyKey: input.idempotencyKey,
        });
        if (hash !== requestHash) {
          throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
        }
        setRequestId(existing.requestId);
        return;
      }
      const current = await ctx.query<{ metadataVersion: number }>(
        'SELECT "metadataVersion" FROM knowledge_base WHERE id = $1',
        [input.kbId],
      );
      if (current.rows[0]?.metadataVersion !== input.metadataVersion) {
        throw new KbDomainError("CONFLICT", "Metadata version conflict");
      }
      const share = await ctx.query<{ bits: string[] | null }>(
        `SELECT bits FROM "kb_share"
          WHERE "kbId" = $1 AND "userId" = $2 AND "revokedAt" IS NULL`,
        [input.kbId, input.recipientUserId],
      );
      if (!share.rows[0]) {
        throw new KbDomainError("FORBIDDEN", "Recipient is not an accepted member");
      }
      await chargeKbMutation(options.ratePort, actorKeyForUser(ownerUserId), input.kbId);
      const pending = await ctx.query<{
        requestId: string;
        metadataVersion: number;
        fromUserId: string;
      }>(
        `SELECT "requestId", "metadataVersion", "fromUserId"
           FROM "kb_transfer"
          WHERE "kbId" = $1 AND state = 'PENDING'::"KbTransferState"
          FOR UPDATE`,
        [input.kbId],
      );
      const open = pending.rows[0];
      if (open) {
        if (open.fromUserId !== ownerUserId || open.metadataVersion !== input.metadataVersion) {
          await ctx.query(
            `UPDATE "kb_transfer"
                SET state = 'CANCELLED'::"KbTransferState", "cancelledAt" = now(), "updatedAt" = now()
              WHERE "kbId" = $1 AND state = 'PENDING'::"KbTransferState"`,
            [input.kbId],
          );
        } else {
          throw new KbDomainError("CONFLICT", "Transfer already pending");
        }
      }
      const requestId = randomUUID();
      await ctx.query(
        `INSERT INTO "kb_transfer"
          (id, "createdAt", "updatedAt", "kbId", "fromUserId", "toUserId",
           "metadataVersion", state, "requestId", "idempotencyKey")
         VALUES ($1, now(), now(), $2, $3, $4, $5, 'PENDING'::"KbTransferState", $6, $7)`,
        [
          randomUUID().replaceAll("-", "").slice(0, 24),
          input.kbId,
          ownerUserId,
          input.recipientUserId,
          input.metadataVersion,
          requestId,
          input.idempotencyKey,
        ],
      );
      await recordAuditEvent(ctx.query, {
        opId: randomUUID(),
        action: "transfer_request",
        outcome: "SUCCESS",
        actorKey: `user:${ownerUserId}`,
        actorUserIdSnapshot: ownerUserId,
        actorUserId: ownerUserId,
        kbId: input.kbId,
        metadata: { requestId, metadataVersion: String(input.metadataVersion) },
      });
      // The offer is emailed to the recipient (worker-side, queued here
      // atomically with the transfer row); the UI keeps the copyable link.
      await enqueueKbEmailOnQuery(
        ctx.query,
        { template: "transfer_offer", kbId: input.kbId, requestId, origin: options.origin },
        input.idempotencyKey,
      );
      setRequestId(requestId);
    },
  };
}

export async function transferAccept(
  runtime: KbRuntimeConfig,
  recipientUserId: string,
  input: { requestId: string },
): Promise<{ ownerId: string; metadataVersion: number }> {
  const opId = randomUUID();
  let result: { ownerId: string; metadataVersion: number } | undefined;

  const transfer = await runtime.prisma.kbTransfer.findUnique({
    where: { requestId: input.requestId },
    select: { kbId: true, toUserId: true, state: true },
  });
  if (transfer?.state !== "PENDING") {
    throw new KbDomainError("NOT_FOUND", "Not found");
  }
  if (transfer.toUserId !== recipientUserId) {
    throw new KbDomainError("FORBIDDEN", "Forbidden");
  }

  await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [transfer.kbId],
    barrier: {
      async reauthorize(ctx) {
        const row = await ctx.query<{
          ownerId: string | null;
          metadataVersion: number;
          state: string;
        }>(
          `SELECT "ownerId", "metadataVersion", state::text AS state
             FROM "knowledge_base" WHERE id = $1 FOR UPDATE`,
          [transfer.kbId],
        );
        const kb = row.rows[0];
        if (!kb || kb.state === "TOMBSTONED") {
          throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
        }
        const pending = await ctx.query<{
          fromUserId: string;
          metadataVersion: number;
          toUserId: string;
        }>(
          `SELECT "fromUserId", "metadataVersion", "toUserId"
             FROM "kb_transfer"
            WHERE "requestId" = $1 AND state = 'PENDING'::"KbTransferState"
            FOR UPDATE`,
          [input.requestId],
        );
        const t = pending.rows[0];
        if (!t || t.toUserId !== recipientUserId) {
          throw new KbDomainError("NOT_FOUND", "Not found");
        }
        if (kb.ownerId !== t.fromUserId) {
          throw new KbDomainError("CONFLICT", "Transfer is stale");
        }
        if (kb.metadataVersion !== t.metadataVersion) {
          throw new KbDomainError("CONFLICT", "Metadata version conflict");
        }
        const ownerIdentity = await sqlAuthorityStore(ctx.query).loadIdentity(t.fromUserId);
        assertLiveIdentity(ownerIdentity);
        await authorize({
          store: sqlAuthorityStore(ctx.query),
          principal: browserPrincipal(t.fromUserId),
          kbId: transfer.kbId,
          operation: "manage",
          query: ctx.query,
        });
        await authorize({
          store: sqlAuthorityStore(ctx.query),
          principal: browserPrincipal(recipientUserId),
          kbId: transfer.kbId,
          operation: "read",
          query: ctx.query,
        });
      },
      async reservePublication(ctx) {
        const pending = await ctx.query<{
          fromUserId: string;
          metadataVersion: number;
        }>(
          `SELECT "fromUserId", "metadataVersion"
             FROM "kb_transfer"
            WHERE "requestId" = $1 AND state = 'PENDING'::"KbTransferState"
            FOR UPDATE`,
          [input.requestId],
        );
        const t = pending.rows[0];
        if (!t) throw new KbDomainError("NOT_FOUND", "Not found");

        await chargeKbMutation(runtime.ratePort, actorKeyForUser(recipientUserId), transfer.kbId);
        try {
          await transferCommittedOwnerLiveKb(
            { transactionQuery: ctx.query },
            { fromUserId: t.fromUserId, toUserId: recipientUserId, opId },
          );
        } catch (error) {
          if (error instanceof KbAdmissionError && error.code === "QUOTA_EXCEEDED") {
            throw new KbDomainError("CONFLICT", "Recipient quota exceeded");
          }
          throw error;
        }

        const updated = await ctx.query<{ ownerId: string; metadataVersion: number }>(
          `UPDATE "knowledge_base"
              SET "ownerId" = $2,
                  "metadataVersion" = "metadataVersion" + 1,
                  "updatedAt" = now()
            WHERE id = $1
              AND "ownerId" = $3
              AND "metadataVersion" = $4
              AND state <> 'TOMBSTONED'::"KnowledgeBaseState"
          RETURNING "ownerId", "metadataVersion"`,
          [transfer.kbId, recipientUserId, t.fromUserId, t.metadataVersion],
        );
        const kb = updated.rows[0];
        if (!kb) throw new KbDomainError("CONFLICT", "Metadata version conflict");

        // The new owner holds every bit through ownership; their member share
        // is retired so it never outlives a later transfer away. That frees
        // the slot the former owner's share takes, so acceptance never trips
        // the per-KB share limit.
        await ctx.query(
          `UPDATE "kb_share" SET "revokedAt" = now()
            WHERE "kbId" = $1 AND "userId" = $2 AND "revokedAt" IS NULL`,
          [transfer.kbId, recipientUserId],
        );
        await assertKbShareCapacityForNewActiveShare(ctx.query, transfer.kbId, t.fromUserId);
        // The retained share never includes sealed values (the
        // one non-owner-setter write of the flag, and only ever to false).
        await ctx.query(
          `INSERT INTO "kb_share" (id, "createdAt", "kbId", "userId", bits, "includeSealedValues", "revokedAt")
           VALUES ($1, now(), $2, $3, $4::text[], false, NULL)
           ON CONFLICT ("kbId", "userId")
           DO UPDATE SET bits = EXCLUDED.bits, "includeSealedValues" = false, "revokedAt" = NULL`,
          [
            randomUUID().replaceAll("-", "").slice(0, 24),
            transfer.kbId,
            t.fromUserId,
            FORMER_OWNER_SHARE_BITS,
          ],
        );

        await ctx.query(
          `UPDATE "kb_transfer"
              SET state = 'ACCEPTED'::"KbTransferState", "acceptedAt" = now(), "formerOwnerBits" = $2::text[]
            WHERE "requestId" = $1`,
          [input.requestId, FORMER_OWNER_SHARE_BITS],
        );

        for (const handler of transferLifecycleHandlers) {
          await handler({
            query: ctx.query,
            kbId: transfer.kbId,
            fromUserId: t.fromUserId,
            toUserId: recipientUserId,
          });
        }

        await recordAuditEvent(ctx.query, {
          opId: randomUUID(),
          action: "transfer_accept",
          outcome: "SUCCESS",
          actorKey: `user:${recipientUserId}`,
          actorUserIdSnapshot: recipientUserId,
          actorUserId: recipientUserId,
          kbId: transfer.kbId,
          metadata: {
            requestId: input.requestId,
            metadataVersion: String(kb.metadataVersion),
            ownerId: kb.ownerId,
          },
        });
        await recordAuditEvent(ctx.query, {
          opId: randomUUID(),
          action: "transfer_former_owner_share",
          outcome: "SUCCESS",
          actorKey: `user:${recipientUserId}`,
          actorUserIdSnapshot: recipientUserId,
          actorUserId: recipientUserId,
          kbId: transfer.kbId,
          metadata: { requestId: input.requestId, shareUserId: t.fromUserId },
        });
        result = { ownerId: kb.ownerId, metadataVersion: kb.metadataVersion };
      },
    },
    run: async () => {
      if (!result) throw new KbDomainError("CONFLICT", "Transfer accept failed");
      return result;
    },
  });
  return result!;
}
