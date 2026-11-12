import { randomUUID } from "node:crypto";
import {
  assertOrdinaryAccountDeletionAllowed,
  isAdminForceAccountDeletion,
  OWNED_ACTIVE_KB_BLOCK_MESSAGE,
} from "@knowledge-base/auth/account-deletion-policy";
import { isAdminRole } from "@knowledge-base/auth/roles";
import type { PrismaClient } from "@knowledge-base/db/client";
import { revokeUserGrantsForRemoval } from "../mcp-token-access";
import { recordAuditEvent } from "./audit";
import { KbDomainError } from "./errors";
import { cancelIndexBuilds } from "./generations";
import type { LockQuery } from "./lock";
import { teardownMirror } from "./mirror";
import { actorKeyForUser } from "./operation-intent";
import { sqlAuthorityStore } from "./permissions";
import { assertLiveIdentity } from "./principal";
import { destroyProviderCredentials } from "./providers";
import { recoverCreatingKnowledgeBase } from "./recovery";
import type { KbRuntimeConfig } from "./runtime";
import { destroySealedAuthority } from "./sealed-records";

const OWNED_KB_PAGE = 50;

export class AccountDeletionBlockedError extends Error {
  readonly code = "ACCOUNT_DELETION_BLOCKED";

  constructor(message = OWNED_ACTIVE_KB_BLOCK_MESSAGE) {
    super(message);
    this.name = "AccountDeletionBlockedError";
  }
}

export type AccountTeardownContext = {
  query: LockQuery;
  userId: string;
  kbId: string;
  opId: string;
};

export type AccountTeardownHandler = (ctx: AccountTeardownContext) => Promise<void>;

const accountTeardownHandlers: AccountTeardownHandler[] = [];

export function registerAccountTeardownHandler(handler: AccountTeardownHandler): void {
  accountTeardownHandlers.push(handler);
}

export function listAccountTeardownHandlersForTests(): readonly AccountTeardownHandler[] {
  return accountTeardownHandlers;
}

registerAccountTeardownHandler(async ({ query, kbId }) => {
  await cancelIndexBuilds(query, kbId);
  await destroySealedAuthority(query, { kbId });
});
registerAccountTeardownHandler(teardownMirror);

export { assertOrdinaryAccountDeletionAllowed };

async function ownedKnowledgeBaseIds(prisma: PrismaClient, userId: string): Promise<string[]> {
  const ids: string[] = [];
  let lastId: string | undefined;
  for (;;) {
    const rows = await prisma.knowledgeBase.findMany({
      where: {
        ownerId: userId,
        state: { not: "TOMBSTONED" },
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take: OWNED_KB_PAGE,
    });
    ids.push(...rows.map((row) => row.id));
    if (rows.length < OWNED_KB_PAGE) return ids;
    lastId = rows.at(-1)!.id;
  }
}

export async function runAccountTeardown(
  query: LockQuery,
  kbId: string,
  userId: string,
  opId: string,
) {
  for (const handler of accountTeardownHandlers) await handler({ query, kbId, userId, opId });
}

async function tombstoneOwnedKnowledgeBases(
  query: LockQuery,
  userId: string,
  removalOpId: string,
  adminUserId: string,
): Promise<number> {
  let tombstoned = 0;
  let lastId: string | undefined;
  for (;;) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM "knowledge_base"
        WHERE "ownerId" = $1 AND state = 'ACTIVE'::"KnowledgeBaseState"
          ${lastId ? `AND id > $3` : ""}
        ORDER BY id ASC
        LIMIT $2`,
      lastId ? [userId, OWNED_KB_PAGE, lastId] : [userId, OWNED_KB_PAGE],
    );
    if (rows.rows.length === 0) break;
    for (const row of rows.rows) {
      await query(
        `UPDATE "knowledge_base"
            SET state = 'TOMBSTONED'::"KnowledgeBaseState",
                "ownerId" = NULL,
                "metadataVersion" = "metadataVersion" + 1,
                "updatedAt" = now()
          WHERE id = $1 AND "ownerId" = $2 AND state = 'ACTIVE'::"KnowledgeBaseState"`,
        [row.id, userId],
      );
      await runAccountTeardown(query, row.id, userId, removalOpId);
      await recordAuditEvent(query, {
        opId: `${removalOpId}:${row.id}`,
        action: "kb_tombstone",
        outcome: "SUCCESS",
        actorKey: actorKeyForUser(adminUserId),
        actorUserIdSnapshot: adminUserId,
        actorUserId: adminUserId,
        kbId: row.id,
        metadata: { reasonCode: "account_removal", shareUserId: userId, requestId: removalOpId },
      });
      tombstoned += 1;
      lastId = row.id;
    }
    if (rows.rows.length < OWNED_KB_PAGE) break;
  }
  return tombstoned;
}

export async function removeUserAccount(
  runtime: KbRuntimeConfig,
  targetUserId: string,
  actor: { actingUserId: string },
): Promise<{ tombstonedKbCount: number }> {
  if (!isAdminForceAccountDeletion()) {
    try {
      await assertOrdinaryAccountDeletionAllowed(runtime.prisma, targetUserId);
    } catch (error) {
      if (error instanceof Error && error.message === OWNED_ACTIVE_KB_BLOCK_MESSAGE) {
        throw new AccountDeletionBlockedError();
      }
      throw error;
    }
  }

  const opId = randomUUID();
  let tombstonedKbCount = 0;
  // Discover before entering the coordinator so its operation gates can join
  // prior writers, then acquire authority -> sorted KB advisory locks. This
  // snapshot is checked again under authority before any deletion can commit.
  const kbIds = await ownedKnowledgeBaseIds(runtime.prisma, targetUserId);

  await runtime.coordinator.run({
    opId,
    kind: kbIds.length ? "git-write" : "authority",
    kbIds,
    barrier: {
      async prepare(lease) {
        // A drained writer may have published Git but failed DB finalization.
        // Settle its journal with the owner still present, even if ordinary
        // removal subsequently rejects the newly ACTIVE ownership.
        await lease.transaction(async (query) => {
          for (const kbId of kbIds) {
            lease.assertHeldKb(kbId);
            await recoverCreatingKnowledgeBase(query, runtime.reposDir, kbId);
          }
        });
      },
      async reauthorize(ctx) {
        const identity = await sqlAuthorityStore(ctx.query).loadIdentity(actor.actingUserId);
        if (!identity) {
          throw new KbDomainError("FORBIDDEN", "Forbidden");
        }
        // Full live identity policy: ban, forced-2FA, instance state. The
        // outer gates authorize on a session snapshot that can be stale
        // (60s cookie cache, or checks that ran before a ban landed).
        assertLiveIdentity(identity);
        // Cross-user removal and admin-force tombstoning are admin
        // authorities. The async-local deletion mode is a caller assertion,
        // not authority, and the session snapshot can predate a demotion —
        // so the live role and email verification are re-verified here,
        // inside the reservation. Ordinary self-deletion (actor == target)
        // is the separately authorized non-admin case.
        if (actor.actingUserId !== targetUserId || isAdminForceAccountDeletion()) {
          const result = await ctx.query<{ role: string | null; emailVerified: boolean | null }>(
            `SELECT role, "emailVerified" FROM "user" WHERE id = $1`,
            [actor.actingUserId],
          );
          const admin = result.rows[0];
          if (!admin?.emailVerified || !isAdminRole(admin.role)) {
            throw new KbDomainError("FORBIDDEN", "Forbidden");
          }
        }
      },
      async reservePublication(ctx) {
        const unlocked = await ctx.query<{ id: string }>(
          `SELECT id FROM "knowledge_base"
            WHERE "ownerId" = $1 AND state <> 'TOMBSTONED'::"KnowledgeBaseState"
              AND NOT (id = ANY($2::text[]))
            LIMIT 1`,
          [targetUserId, kbIds],
        );
        if (unlocked.rows.length) {
          // Creation/transfer won after discovery. Do not acquire another KB
          // gate here (or delete underneath its writer); retry from discovery.
          throw new AccountDeletionBlockedError("Knowledge base ownership changed; retry removal");
        }
        if (isAdminForceAccountDeletion()) {
          tombstonedKbCount = await tombstoneOwnedKnowledgeBases(
            ctx.query,
            targetUserId,
            opId,
            actor.actingUserId,
          );
        } else {
          const owned = await ctx.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "knowledge_base"
              WHERE "ownerId" = $1 AND state = 'ACTIVE'::"KnowledgeBaseState"`,
            [targetUserId],
          );
          if (Number(owned.rows[0]?.count ?? "0") > 0) {
            throw new AccountDeletionBlockedError();
          }
        }
        await destroyProviderCredentials(ctx.query, targetUserId);
        await destroySealedAuthority(ctx.query, { userId: targetUserId });
        // Revoke before deletion: grant/PAT rows are permanent tombstones whose
        // live user FK is nulled (SET NULL) by the delete below, never cascaded.
        await revokeUserGrantsForRemoval(ctx.query, targetUserId);
        await ctx.query(`DELETE FROM "session" WHERE "userId" = $1`, [targetUserId]);
        await ctx.query(`DELETE FROM "account" WHERE "userId" = $1`, [targetUserId]);
        await ctx.query(`DELETE FROM "two_factor" WHERE "userId" = $1`, [targetUserId]);
        await ctx.query(`DELETE FROM "push_subscription" WHERE "userId" = $1`, [targetUserId]);
        await ctx.query(`DELETE FROM "kb_transfer" WHERE "fromUserId" = $1 OR "toUserId" = $1`, [
          targetUserId,
        ]);
        await ctx.query(`DELETE FROM "share_invitation" WHERE "inviterUserId" = $1`, [
          targetUserId,
        ]);
        // The audit row must land while its actor still exists: when the
        // removal is delegated (Better Auth self-deletion), actor and target
        // are the same user, and the FK is ON DELETE SET NULL — inserting
        // after the DELETE below violates audit_event_actorUserId_fkey and
        // rolls the whole removal back. The snapshot preserves attribution.
        await recordAuditEvent(ctx.query, {
          opId,
          action: "account_remove",
          outcome: "SUCCESS",
          actorKey: actorKeyForUser(actor.actingUserId),
          actorUserIdSnapshot: actor.actingUserId,
          actorUserId: actor.actingUserId,
          metadata: {
            shareUserId: targetUserId,
            reasonCode: isAdminForceAccountDeletion() ? "admin_force" : "ordinary",
          },
        });
        await ctx.query(`DELETE FROM "user" WHERE id = $1`, [targetUserId]);
      },
    },
    run: async () => ({ tombstonedKbCount }),
  });

  return { tombstonedKbCount };
}

export function mapAccountDeletionError(error: unknown): KbDomainError | null {
  if (error instanceof AccountDeletionBlockedError) {
    return new KbDomainError("CONFLICT", error.message);
  }
  return null;
}
