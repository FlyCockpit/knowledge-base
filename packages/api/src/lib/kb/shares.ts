import { randomUUID } from "node:crypto";

import { canonicalizeEmail } from "@knowledge-base/auth/email";
import { DEFAULT_LOCALE, isSupportedLocale } from "@knowledge-base/config/locales";
import { mailboxSchema } from "@knowledge-base/env/mailbox";

import { recordAuditEvent } from "./audit";
import type { AuthorityBarrier } from "./authority-lock";
import {
  decryptKbSecretWithEnvKey,
  encryptKbSecretWithEnvKey,
  type KbEncryptedRecord,
  parseKbMasterKeyFromEnv,
} from "./envelope";
import { KbDomainError } from "./errors";
import { enqueueKbEmailOnQuery } from "./kb-email";
import { chargeKbMutation, type RatePort } from "./limits";
import type { LockQuery } from "./lock";
import {
  actorKeyForUser,
  canonicalRequestHash,
  findFinalizedReceiptForUpdate,
  recordFinalizedReceipt,
} from "./operation-intent";
import {
  authorize,
  expandBits,
  isPermission,
  type Permission,
  prismaAuthorityStore,
  sqlAuthorityStore,
} from "./permissions";
import { assertLiveIdentity, type BrowserPrincipal, KbAdmissionError } from "./principal";
import { assertKbShareCapacityForNewActiveShare } from "./quota";
import type { KbRuntimeConfig } from "./runtime";
import { endMemberSealedApprovals } from "./sealed-records";

const PERMISSION_INPUT = ["read", "propose", "write", "review", "manage"] as const;
const SHARE_LIST_PAGE = 50;

/** Operation tag for durable share-invite idempotency receipts. */
export const SHARE_INVITE_OPERATION = "SHARE_INVITE";

export type ShareInviteResult = { accepted: true; requestId: string };

export type AcceptedShareItem = {
  shareId: string;
  userId: string;
  /** The display name the member chose; managers tell members apart by it. */
  name: string;
  /**
   * The address this member was invited with, shown only to the KB owner and
   * to the manager who sent that (accepted) invitation; null for everyone else.
   */
  invitedEmail: string | null;
  bits: Permission[];
  /** Owner-set; false means this share never yields sealed-value capabilities. */
  includeSealedValues: boolean;
  createdAt: string;
};

function browserPrincipal(userId: string): BrowserPrincipal {
  return { kind: "browser", userId };
}

function parseShareListCursor(
  cursor: string | null | undefined,
): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const split = cursor.indexOf("\0");
  if (split <= 0) return null;
  const createdAt = new Date(cursor.slice(0, split));
  const id = cursor.slice(split + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

function shareListCursorKey(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}\0${id}`;
}

function validateGrantedBits(bits: readonly string[]): Permission[] {
  if (bits.length === 0) {
    throw new KbDomainError("INVALID_ARGUMENT", "At least one permission is required");
  }
  const out: Permission[] = [];
  for (const bit of bits) {
    if (!isPermission(bit)) {
      throw new KbDomainError("INVALID_ARGUMENT", "Invalid permission");
    }
    out.push(bit);
  }
  return expandBits(out);
}

/** Set equality on the canonical expanded form, so permission order never matters. */
function samePermissionSet(left: readonly string[], right: readonly Permission[]): boolean {
  const expanded = expandBits(left);
  return expanded.length === right.length && expanded.every((bit, index) => bit === right[index]);
}

function serializeEmailCiphertext(
  inviterUserId: string,
  requestId: string,
  email: string,
  masterKey: string | undefined,
): string {
  const record = encryptKbSecretWithEnvKey(
    email,
    {
      aadVersion: 1,
      purpose: "share-email",
      userId: inviterUserId,
      objectId: requestId,
      revision: "1",
    },
    masterKey,
  );
  return JSON.stringify(record);
}

export function decryptShareInvitationEmail(
  inviterUserId: string,
  requestId: string,
  emailCiphertext: string,
  masterKey: string | undefined,
): string {
  const record = JSON.parse(emailCiphertext) as KbEncryptedRecord;
  return decryptKbSecretWithEnvKey(
    record,
    {
      aadVersion: 1,
      purpose: "share-email",
      userId: inviterUserId,
      objectId: requestId,
      revision: "1",
    },
    masterKey,
  );
}

function parseShareInviteReceipt(body: unknown): ShareInviteResult {
  if (
    !body ||
    typeof body !== "object" ||
    (body as { accepted?: unknown }).accepted !== true ||
    typeof (body as { requestId?: unknown }).requestId !== "string"
  ) {
    throw new KbDomainError("INTERNAL", "Share invite receipt is unreadable");
  }
  return { accepted: true, requestId: (body as { requestId: string }).requestId };
}

type ShareInviteInput = {
  kbId: string;
  email: string;
  permissions: string[];
  idempotencyKey: string;
  /** Inviter's UI locale for the invitation email. Not part of the request hash. */
  locale?: string;
};

/**
 * `masterKey` is the raw KB_MASTER_KEY string, read by the calling boundary (router):
 * library modules never validate process env at import, so a PG harness can load them.
 */
export async function shareInvite(
  runtime: KbRuntimeConfig,
  inviterUserId: string,
  input: ShareInviteInput,
  masterKey: string | undefined,
): Promise<ShareInviteResult> {
  parseKbMasterKeyFromEnv(masterKey);
  if (!mailboxSchema.safeParse(input.email).success)
    throw new KbDomainError("INVALID_ARGUMENT", "Invalid email");
  const email = canonicalizeEmail(input.email) ?? "";
  const granted = validateGrantedBits(input.permissions);
  const requestHash = canonicalRequestHash({
    kbId: input.kbId,
    email,
    permissions: granted,
    idempotencyKey: input.idempotencyKey,
  });

  // All receipts replay through the same live authority barrier as fresh keys.
  const opId = randomUUID();
  let response: ShareInviteResult | undefined;
  const principal = browserPrincipal(inviterUserId);

  await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: shareInviteBarrier({
      ratePort: runtime.ratePort,
      inviterUserId,
      input: { ...input, email },
      granted,
      requestHash,
      setResponse: (value) => {
        response = value;
      },
      principal,
      masterKey,
      origin: runtime.canonicalOrigin,
      locale: isSupportedLocale(input.locale) ? input.locale : DEFAULT_LOCALE,
    }),
    run: async () => {
      if (!response) throw new KbDomainError("INTERNAL", "Share invite did not complete");
      return response;
    },
  });
  return response!;
}

async function inviterStillManages(
  query: LockQuery,
  kbId: string,
  inviterUserId: string,
): Promise<boolean> {
  try {
    await authorize({
      store: sqlAuthorityStore(query),
      principal: browserPrincipal(inviterUserId),
      kbId,
      operation: "manage",
      query,
    });
    return true;
  } catch (error) {
    // A dead, banned, or revoked inviter must not wedge the invitation:
    // the check result, not the error class, drives the supersede decision.
    if (error instanceof KbAdmissionError) return false;
    throw error;
  }
}

function shareInviteBarrier(options: {
  ratePort: RatePort;
  inviterUserId: string;
  input: ShareInviteInput & { email: string };
  granted: Permission[];
  requestHash: string;
  setResponse: (value: ShareInviteResult) => void;
  principal: BrowserPrincipal;
  masterKey: string | undefined;
  origin: string;
  locale: "en-US" | "es-MX";
}): AuthorityBarrier {
  const { inviterUserId, input, granted, requestHash, setResponse, principal, masterKey } = options;

  /**
   * Every fresh invitation (new, reset or re-sent under a new key)
   * queues exactly one email in this transaction. Nothing here looks up the
   * address, so known and unknown addresses take the same path.
   */
  async function queueEmail(ctx: { query: LockQuery }, requestId: string): Promise<void> {
    await enqueueKbEmailOnQuery(
      ctx.query,
      {
        template: "share_invite",
        kbId: input.kbId,
        requestId,
        origin: options.origin,
        locale: options.locale,
      },
      input.idempotencyKey,
    );
  }

  async function writeInvitation(
    ctx: { query: LockQuery },
    row: { id: string } | null,
    reasonCode: string | undefined,
  ): Promise<ShareInviteResult> {
    const requestId = randomUUID();
    const emailCiphertext = serializeEmailCiphertext(
      inviterUserId,
      requestId,
      input.email,
      masterKey,
    );
    if (row) {
      await ctx.query(
        `UPDATE "share_invitation"
            SET "inviterUserId" = $2,
                "emailCiphertext" = $3,
                "requestId" = $4,
                "idempotencyKey" = $5,
                bits = $6::text[],
                "acceptedAt" = NULL,
                "revokedAt" = NULL,
                "createdAt" = now()
          WHERE id = $1`,
        [row.id, inviterUserId, emailCiphertext, requestId, input.idempotencyKey, granted],
      );
    } else {
      await ctx.query(
        `INSERT INTO "share_invitation"
          (id, "createdAt", "kbId", "inviterUserId", "canonicalEmail", "emailCiphertext",
           "requestId", "idempotencyKey", bits)
         VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8::text[])`,
        [
          randomUUID().replaceAll("-", "").slice(0, 24),
          input.kbId,
          inviterUserId,
          input.email,
          emailCiphertext,
          requestId,
          input.idempotencyKey,
          granted,
        ],
      );
    }
    await recordAuditEvent(ctx.query, {
      opId: randomUUID(),
      action: "share_invite",
      outcome: "SUCCESS",
      actorKey: `user:${inviterUserId}`,
      actorUserIdSnapshot: inviterUserId,
      actorUserId: inviterUserId,
      kbId: input.kbId,
      metadata: reasonCode ? { requestId, reasonCode } : { requestId },
    });
    const body: ShareInviteResult = { accepted: true, requestId };
    await queueEmail(ctx, requestId);
    await recordFinalizedReceipt(ctx.query, {
      kbId: input.kbId,
      actorUserId: inviterUserId,
      operation: SHARE_INVITE_OPERATION,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      responseBody: body,
    });
    return body;
  }

  return {
    async reauthorize(ctx) {
      await authorize({
        store: sqlAuthorityStore(ctx.query),
        principal,
        kbId: input.kbId,
        operation: "manage",
        query: ctx.query,
      });
    },
    async reservePublication(ctx) {
      const receipt = await findFinalizedReceiptForUpdate(ctx.query, {
        actorKey: actorKeyForUser(inviterUserId),
        kbId: input.kbId,
        operation: SHARE_INVITE_OPERATION,
        idempotencyKey: input.idempotencyKey,
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
        }
        if (receipt.phase === "FINALIZED" && receipt.responseBody) {
          setResponse(parseShareInviteReceipt(receipt.responseBody));
          return;
        }
        throw new KbDomainError("CONFLICT", "Share invite already in progress");
      }

      // A concurrent finalized replay above consumes no mutation budget.
      // Every fresh key (including a new receipt for an existing invite) does.
      await chargeKbMutation(options.ratePort, actorKeyForUser(inviterUserId), input.kbId);
      const existingEmail = await ctx.query<{
        id: string;
        requestId: string;
        inviterUserId: string;
        acceptedAt: Date | null;
        revokedAt: Date | null;
        bits: string[];
      }>(
        `SELECT id, "requestId", "inviterUserId", "acceptedAt", "revokedAt", bits
           FROM "share_invitation"
          WHERE "kbId" = $1 AND "canonicalEmail" = $2
          FOR UPDATE`,
        [input.kbId, input.email],
      );
      const emailRow = existingEmail.rows[0];
      if (!emailRow) {
        setResponse(await writeInvitation(ctx, null, undefined));
        return;
      }

      const isPending = emailRow.acceptedAt === null && emailRow.revokedAt === null;
      if (isPending) {
        const inviterLive = await inviterStillManages(
          ctx.query,
          input.kbId,
          emailRow.inviterUserId,
        );
        if (inviterLive) {
          if (!samePermissionSet(emailRow.bits, granted)) {
            throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
          }
          // Re-send of a live pending invitation: same requestId, and the
          // receipt makes this exact response durable for future retries.
          const body: ShareInviteResult = { accepted: true, requestId: emailRow.requestId };
          await queueEmail(ctx, emailRow.requestId);
          await recordFinalizedReceipt(ctx.query, {
            kbId: input.kbId,
            actorUserId: inviterUserId,
            operation: SHARE_INVITE_OPERATION,
            idempotencyKey: input.idempotencyKey,
            requestHash,
            responseBody: body,
          });
          setResponse(body);
          return;
        }
        // The original inviter lost authority mid-flight. The caller holds the
        // authority gate, so supersede: a fresh requestId invalidates the dead
        // intent while historical receipts stay immutable.
        setResponse(await writeInvitation(ctx, emailRow, "superseded_inviter"));
        return;
      }
      // Consumed or revoked invitation: reset the row to a fresh pending intent.
      setResponse(await writeInvitation(ctx, emailRow, undefined));
    },
  };
}

/**
 * The accepting recipient's live identity and intended email are validated
 * inside the reservation transaction, so a ban or email change between the
 * outer read and the reservation cannot land a share.
 */
async function assertRecipientMatchesInvitation(
  query: LockQuery,
  recipientUserId: string,
  invitationEmail: string,
): Promise<void> {
  const row = await query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [
    recipientUserId,
  ]);
  const identity = await sqlAuthorityStore(query).loadIdentity(recipientUserId);
  assertLiveIdentity(identity);
  const canonical = row.rows[0]?.email ? canonicalizeEmail(row.rows[0].email) : null;
  if (!canonical || canonical !== invitationEmail) {
    throw new KbDomainError("FORBIDDEN", "Forbidden");
  }
}

export async function shareAccept(
  runtime: KbRuntimeConfig,
  recipientUserId: string,
  input: { requestId: string },
): Promise<{ shareId: string }> {
  const invitePreview = await runtime.prisma.shareInvitation.findFirst({
    where: { requestId: input.requestId, acceptedAt: null, revokedAt: null },
    select: { kbId: true },
  });
  if (!invitePreview) throw new KbDomainError("NOT_FOUND", "Not found");

  const opId = randomUUID();
  let shareId: string | undefined;
  await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [invitePreview.kbId],
    barrier: {
      async reauthorize(ctx) {
        const invite = await loadPendingInvitation(ctx.query, input.requestId);
        if (!invite) throw new KbDomainError("NOT_FOUND", "Not found");
        await assertRecipientMatchesInvitation(ctx.query, recipientUserId, invite.canonicalEmail);
        await authorize({
          store: sqlAuthorityStore(ctx.query),
          principal: browserPrincipal(invite.inviterUserId),
          kbId: invite.kbId,
          operation: "manage",
          query: ctx.query,
        });
      },
      async reservePublication(ctx) {
        const invite = await loadPendingInvitationForUpdate(ctx.query, input.requestId);
        if (!invite) throw new KbDomainError("NOT_FOUND", "Not found");
        await assertRecipientMatchesInvitation(ctx.query, recipientUserId, invite.canonicalEmail);
        await authorize({
          store: sqlAuthorityStore(ctx.query),
          principal: browserPrincipal(invite.inviterUserId),
          kbId: invite.kbId,
          operation: "manage",
          query: ctx.query,
        });
        await assertKbShareCapacityForNewActiveShare(ctx.query, invite.kbId, recipientUserId);
        await chargeKbMutation(runtime.ratePort, actorKeyForUser(recipientUserId), invite.kbId);
        // Only the owner ever turns includeSealedValues on
        // (`shareSetSealedValues`). A re-accept of a LIVE share keeps the
        // owner's choice; a share that was removed (revoked) ended, so reviving
        // its row is a new share and starts false, like a member's first share.
        const upsert = await ctx.query<{ id: string }>(
          `INSERT INTO "kb_share" (id, "createdAt", "kbId", "userId", bits, "includeSealedValues", "revokedAt")
           VALUES ($1, now(), $2, $3, $4::text[], false, NULL)
           ON CONFLICT ("kbId", "userId")
           DO UPDATE SET bits = EXCLUDED.bits,
                         "includeSealedValues" = "kb_share"."includeSealedValues"
                           AND "kb_share"."revokedAt" IS NULL,
                         "revokedAt" = NULL
           RETURNING id`,
          [
            randomUUID().replaceAll("-", "").slice(0, 24),
            invite.kbId,
            recipientUserId,
            invite.bits,
          ],
        );
        shareId = upsert.rows[0]?.id;
        if (!shareId) throw new KbDomainError("INTERNAL", "Share accept failed");
        await ctx.query(`UPDATE "share_invitation" SET "acceptedAt" = now() WHERE id = $1`, [
          invite.id,
        ]);
        await recordAuditEvent(ctx.query, {
          opId: randomUUID(),
          action: "share_accept",
          outcome: "SUCCESS",
          actorKey: `user:${recipientUserId}`,
          actorUserIdSnapshot: recipientUserId,
          actorUserId: recipientUserId,
          kbId: invite.kbId,
          metadata: { shareUserId: recipientUserId, requestId: input.requestId },
        });
      },
    },
    run: async () => {
      if (!shareId) throw new KbDomainError("NOT_FOUND", "Not found");
      return { shareId };
    },
  });
  return { shareId: shareId! };
}

type PendingInvitation = {
  id: string;
  kbId: string;
  inviterUserId: string;
  canonicalEmail: string;
  bits: string[];
};

async function loadPendingInvitation(
  query: LockQuery,
  requestId: string,
): Promise<PendingInvitation | null> {
  const result = await query<PendingInvitation>(
    `SELECT id, "kbId", "inviterUserId", "canonicalEmail", bits
       FROM "share_invitation"
      WHERE "requestId" = $1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

async function loadPendingInvitationForUpdate(
  query: LockQuery,
  requestId: string,
): Promise<PendingInvitation | null> {
  const result = await query<PendingInvitation>(
    `SELECT id, "kbId", "inviterUserId", "canonicalEmail", bits
       FROM "share_invitation"
      WHERE "requestId" = $1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL
       FOR UPDATE`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

export async function shareList(
  runtime: KbRuntimeConfig,
  userId: string,
  input: { kbId: string; limit?: number; cursor?: string | null },
): Promise<{ items: AcceptedShareItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), SHARE_LIST_PAGE);
  const store = prismaAuthorityStore(runtime.prisma);
  const principal = browserPrincipal(userId);
  await authorize({ store, principal, kbId: input.kbId, operation: "manage" });
  const after = parseShareListCursor(input.cursor ?? null);
  const rows = await runtime.prisma.kbShare.findMany({
    where: {
      kbId: input.kbId,
      revokedAt: null,
      ...(after
        ? {
            OR: [
              { createdAt: { gt: after.createdAt } },
              { createdAt: after.createdAt, id: { gt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      userId: true,
      bits: true,
      includeSealedValues: true,
      createdAt: true,
      user: { select: { name: true, email: true } },
    },
  });
  const page = rows.slice(0, limit);
  const invitations = await acceptedInvitationsFor(
    runtime,
    input.kbId,
    page.map((row) => row.user.email),
  );
  // Membership disclosure is manage-gated data: recheck the caller's live
  // authority after the page is loaded so a revocation that commits while the
  // rows are in flight cannot leak the member list. Invited addresses are
  // filtered by THIS (final) answer's owner, so an ownership transfer during
  // the read never shows the former owner addresses they did not send.
  const live = await authorize({ store, principal, kbId: input.kbId, operation: "manage" });
  const invitedEmails = visibleInvitedEmails(invitations, userId, live.ownerId === userId);
  const next =
    rows.length > limit ? shareListCursorKey(page.at(-1)!.createdAt, page.at(-1)!.id) : null;
  return {
    items: page.map((row) => ({
      shareId: row.id,
      userId: row.userId,
      name: row.user.name,
      invitedEmail: invitedEmails.get(canonicalizeEmail(row.user.email) ?? "") ?? null,
      bits: expandBits(row.bits),
      includeSealedValues: row.includeSealedValues,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: next,
  };
}

type AcceptedInvitation = { canonicalEmail: string; inviterUserId: string };

/**
 * Accepted invitations of this KB whose address is one of the page members'
 * current canonical email. Bounded by the page: at most one invitation per
 * (kbId, canonicalEmail). Read before the final authorization; who may see
 * which address is decided after it (`visibleInvitedEmails`).
 */
async function acceptedInvitationsFor(
  runtime: KbRuntimeConfig,
  kbId: string,
  memberEmails: readonly string[],
): Promise<AcceptedInvitation[]> {
  const canonical = [
    ...new Set(
      memberEmails
        .map((email) => canonicalizeEmail(email))
        .filter((email): email is string => typeof email === "string"),
    ),
  ];
  if (canonical.length === 0) return [];
  return runtime.prisma.shareInvitation.findMany({
    where: { kbId, canonicalEmail: { in: canonical }, acceptedAt: { not: null } },
    take: canonical.length,
    select: { canonicalEmail: true, inviterUserId: true },
  });
}

/**
 * The address a member was invited with is shown to the KB's
 * current owner (from the final live authorization) and to whoever sent that
 * invitation, never to other managers. Only addresses that are still the
 * member's email match, so this reveals nothing the viewer did not type (or,
 * for the owner, nothing a manager did not type on their KB).
 */
export function visibleInvitedEmails(
  invitations: readonly AcceptedInvitation[],
  viewerUserId: string,
  viewerIsLiveOwner: boolean,
): Map<string, string> {
  return new Map(
    invitations
      .filter((row) => viewerIsLiveOwner || row.inviterUserId === viewerUserId)
      .map((row) => [row.canonicalEmail, row.canonicalEmail]),
  );
}

/**
 * Change a live member's permission bits in place (no revoke and
 * re-invite). The same authority as invite and revoke: `manage` on the KB,
 * re-checked under the authority barrier. Only the bits change; the share
 * keeps its owner-set `includeSealedValues` (sealed eligibility never depends
 * on bits), and credentials intersect the new bits on their next call.
 */
export async function shareUpdate(
  runtime: KbRuntimeConfig,
  actorUserId: string,
  input: { kbId: string; shareUserId: string; permissions: string[] },
): Promise<{ shareUserId: string; bits: Permission[] }> {
  const granted = validateGrantedBits(input.permissions);
  await runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: {
      async reauthorize(ctx) {
        await authorize({
          store: sqlAuthorityStore(ctx.query),
          principal: browserPrincipal(actorUserId),
          kbId: input.kbId,
          operation: "manage",
          query: ctx.query,
        });
      },
      async reservePublication(ctx) {
        await chargeKbMutation(runtime.ratePort, actorKeyForUser(actorUserId), input.kbId);
        const current = await ctx.query<{ bits: string[] }>(
          `SELECT bits FROM "kb_share"
            WHERE "kbId" = $1 AND "userId" = $2 AND "revokedAt" IS NULL
            FOR UPDATE`,
          [input.kbId, input.shareUserId],
        );
        const before = current.rows[0];
        if (!before) throw new KbDomainError("NOT_FOUND", "Not found");
        await ctx.query(
          `UPDATE "kb_share" SET bits = $3::text[]
            WHERE "kbId" = $1 AND "userId" = $2 AND "revokedAt" IS NULL`,
          [input.kbId, input.shareUserId, granted],
        );
        await recordAuditEvent(ctx.query, {
          opId: randomUUID(),
          action: "share_update",
          outcome: "SUCCESS",
          actorKey: `user:${actorUserId}`,
          actorUserIdSnapshot: actorUserId,
          actorUserId,
          kbId: input.kbId,
          metadata: {
            shareUserId: input.shareUserId,
            before: JSON.stringify(expandBits(before.bits)),
            after: JSON.stringify(granted),
          },
        });
      },
    },
    run: async () => ({}),
  });
  return { shareUserId: input.shareUserId, bits: granted };
}

export async function shareRevoke(
  runtime: KbRuntimeConfig,
  actorUserId: string,
  input: { kbId: string; shareUserId: string },
): Promise<{ revoked: true }> {
  const opId = randomUUID();
  await runtime.coordinator.run({
    opId,
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: {
      async reauthorize(ctx) {
        await authorize({
          store: sqlAuthorityStore(ctx.query),
          principal: browserPrincipal(actorUserId),
          kbId: input.kbId,
          operation: "manage",
          query: ctx.query,
        });
      },
      async reservePublication(ctx) {
        await chargeKbMutation(runtime.ratePort, actorKeyForUser(actorUserId), input.kbId);
        const updated = await ctx.query(
          `UPDATE "kb_share"
              SET "revokedAt" = now()
            WHERE "kbId" = $1 AND "userId" = $2 AND "revokedAt" IS NULL`,
          [input.kbId, input.shareUserId],
        );
        if (updated.rowCount !== 1) {
          throw new KbDomainError("NOT_FOUND", "Not found");
        }
        // The share ended; so did the sealed approvals bound to it.
        await endMemberSealedApprovals(ctx.query, {
          kbId: input.kbId,
          userId: input.shareUserId,
        });
        await recordAuditEvent(ctx.query, {
          opId: randomUUID(),
          action: "share_revoke",
          outcome: "SUCCESS",
          actorKey: `user:${actorUserId}`,
          actorUserIdSnapshot: actorUserId,
          actorUserId: actorUserId,
          kbId: input.kbId,
          metadata: { shareUserId: input.shareUserId },
        });
      },
    },
    run: async () => ({ revoked: true as const }),
  });
  return { revoked: true };
}

/**
 * The owner (only) sets whether one live share includes sealed
 * values. This is the only writer that can turn the flag on; the other writes
 * only ever clear it: ownership transfer forces the former owner's retained
 * share to false, and accepting an invitation for a removed (ended) share
 * starts the new share false.
 * Owner identity is checked live under the authority barrier; a manager who
 * is not the owner is refused whatever the target or value.
 */
export async function shareSetSealedValues(
  runtime: KbRuntimeConfig,
  actorUserId: string,
  input: { kbId: string; shareUserId: string; includeSealedValues: boolean },
): Promise<{ shareUserId: string; includeSealedValues: boolean }> {
  const assertOwner = async (query: LockQuery) => {
    const store = sqlAuthorityStore(query);
    assertLiveIdentity(await store.loadIdentity(actorUserId));
    await authorize({
      store,
      principal: browserPrincipal(actorUserId),
      kbId: input.kbId,
      operation: "manage",
      query,
    });
    const kb = await store.loadKb(input.kbId);
    if (kb?.ownerId !== actorUserId) throw new KbDomainError("FORBIDDEN", "Forbidden");
  };
  await runtime.coordinator.run({
    opId: randomUUID(),
    kind: "git-write",
    kbIds: [input.kbId],
    barrier: {
      async reauthorize(ctx) {
        await assertOwner(ctx.query);
      },
      async reservePublication(ctx) {
        await assertOwner(ctx.query);
        await chargeKbMutation(runtime.ratePort, actorKeyForUser(actorUserId), input.kbId);
        const updated = await ctx.query(
          `UPDATE "kb_share"
              SET "includeSealedValues" = $3
            WHERE "kbId" = $1 AND "userId" = $2 AND "revokedAt" IS NULL`,
          [input.kbId, input.shareUserId, input.includeSealedValues],
        );
        if (updated.rowCount !== 1) throw new KbDomainError("NOT_FOUND", "Not found");
        await recordAuditEvent(ctx.query, {
          opId: randomUUID(),
          action: "share_sealed_values_set",
          outcome: "SUCCESS",
          actorKey: `user:${actorUserId}`,
          actorUserIdSnapshot: actorUserId,
          actorUserId,
          kbId: input.kbId,
          metadata: {
            shareUserId: input.shareUserId,
            reasonCode: input.includeSealedValues
              ? "include_sealed_values"
              : "exclude_sealed_values",
          },
        });
      },
    },
    run: async () => ({}),
  });
  return { shareUserId: input.shareUserId, includeSealedValues: input.includeSealedValues };
}

export { PERMISSION_INPUT as sharePermissionSchemaValues };
