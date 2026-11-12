import { createHmac, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import {
  sealedApprovalExpirySchema,
  sealedRecipientPublicKey,
} from "@knowledge-base/auth/sealed-recipient";
import { z } from "zod";
import { remoteSealedNamespace } from "./attachment";
import { recordAuditEvent } from "./audit";
import {
  decryptKbSecretBytes,
  encryptKbSecret,
  type KbSecretIdentity,
  requireKbMasterKey,
} from "./envelope";
import { KbDomainError } from "./errors";
import { chargeKbMutation } from "./limits";
import type { LockQuery } from "./lock";
import {
  canonicalRequestHash,
  findOperationIntent,
  recordFinalizedReceipt,
} from "./operation-intent";
import { sqlAuthorityStore } from "./permissions";
import { assertLiveIdentity, type Principal } from "./principal";
import { isoSchema, keySchema, uuidSchema } from "./protocol/common";
import type { KbRuntimeConfig } from "./runtime";
import { parseSealedReference, sealedReference } from "./sealed-reference";

const unresolved = () => new KbDomainError("UNRESOLVED_REFERENCE", "Unresolved reference");
const invalid = () => new KbDomainError("INVALID_ARGUMENT", "Invalid sealed input");
const plaintextSchema = z
  .string()
  .min(1)
  .max(16384)
  .refine((v) => v.isWellFormed() && Buffer.byteLength(v, "utf8") <= 16384);
const common = { kbId: z.string().regex(/^[a-z0-9]{24,32}$/), idempotencyKey: keySchema };
const referenceSchema = z
  .string()
  .max(160)
  .refine((v) => {
    try {
      parseSealedReference(v);
      return true;
    } catch {
      return false;
    }
  });
export const sealedEnrollInput = z.strictObject({
  ...common,
  namespace: uuidSchema,
  recordId: uuidSchema.optional(),
  plaintext: plaintextSchema,
});
export const sealedRevokeInput = z.strictObject({ ...common, reference: referenceSchema });
export const sealedGrantInput = sealedRevokeInput.extend({
  // OAuth grants never hold sealed-recipient capabilities; only PATs
  // (human-minted or CLI device flow, which register their own recipient key).
  consumerKind: z.literal("pat"),
  consumerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  recipientKeyId: uuidSchema,
  recipientPublicKey: z.string().length(44),
  expiresAt: isoSchema.and(sealedApprovalExpirySchema),
});
const resultSchema = z.strictObject({
  operationId: uuidSchema,
  reference: referenceSchema,
  version: z.literal(1),
  revoked: z.boolean(),
});
type Result = z.infer<typeof resultSchema>;
type Runtime = Pick<KbRuntimeConfig, "coordinator" | "canonicalOrigin" | "ratePort">;
type Identity = { namespace: string; recordId: string; version: number };

/** Owned nonserializable plaintext. Borrow synchronously, then destroy in finally. */
export class SecretLiteral {
  #bytes: Buffer;
  #destroyed = false;
  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
  }
  static fromUtf8(value: string): SecretLiteral {
    if (!plaintextSchema.safeParse(value).success) throw invalid();
    return new SecretLiteral(Buffer.from(value, "utf8"));
  }
  static take(bytes: Buffer): SecretLiteral {
    if (!bytes.length || bytes.length > 16384) {
      bytes.fill(0);
      throw invalid();
    }
    return new SecretLiteral(bytes);
  }
  use<T>(run: (bytes: Buffer) => T): T {
    if (this.#destroyed) throw unresolved();
    return run(this.#bytes);
  }
  destroy() {
    this.#bytes.fill(0);
    this.#destroyed = true;
  }
  toJSON(): never {
    throw new Error("Secret literal cannot be serialized");
  }
  [inspect.custom]() {
    return "[SecretLiteral redacted]";
  }
}
function aad(identity: Identity): KbSecretIdentity {
  return {
    aadVersion: 1,
    purpose: "sealed-literal",
    userId: identity.namespace,
    objectId: identity.recordId,
    revision: String(identity.version),
  };
}
export function encryptSealedRecord(
  literal: SecretLiteral,
  identity: Identity,
  master: Buffer,
): string {
  return literal.use((bytes) => JSON.stringify(encryptKbSecret(bytes, aad(identity), master)));
}
export function decryptSealedRecord(
  ciphertext: string,
  identity: Identity,
  master: Buffer,
): SecretLiteral {
  try {
    return SecretLiteral.take(decryptKbSecretBytes(JSON.parse(ciphertext), aad(identity), master));
  } catch {
    throw unresolved();
  }
}

/** No network/Git effect: identity, exact owner, mutation, receipt and audit share one
 * authority-locked SQL transaction. Session attributes supplied by a caller are never authority. */
async function asOwner<T>(
  runtime: Runtime,
  principal: Principal,
  kbId: string,
  run: (query: LockQuery) => Promise<T>,
): Promise<T> {
  if (principal.kind !== "browser")
    throw new KbDomainError("FORBIDDEN", "Browser identity required");
  return runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) =>
      lease.transaction(async (query) => {
        const store = sqlAuthorityStore(query);
        assertLiveIdentity(await store.loadIdentity(principal.userId));
        // Sealed control requires enrollment independently of global forcing/grace.
        // Read live evidence inside the same authority transaction as the effect/replay.
        const user = await query<{ twoFactorEnabled: boolean | null }>(
          `SELECT "twoFactorEnabled" FROM "user" WHERE id=$1`,
          [principal.userId],
        );
        if (user.rows[0]?.twoFactorEnabled !== true)
          throw new KbDomainError("FORBIDDEN", "Two-factor authentication required");
        const kb = await store.loadKb(kbId);
        if (kb?.state !== "ACTIVE" || kb.ownerId !== principal.userId)
          throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
        return run(query);
      }),
  });
}
type RecordRow = { version: number; ciphertext: string | null; revokedAt: Date | null };
async function record(query: LockQuery, kbId: string, identity: Omit<Identity, "version">) {
  const rows = await query<RecordRow>(
    `SELECT version,ciphertext,"revokedAt" FROM sealed_record WHERE "kbId"=$1 AND namespace=$2::uuid AND "recordId"=$3::uuid`,
    [kbId, identity.namespace, identity.recordId],
  );
  return rows.rows[0];
}
function assertLive(row: RecordRow | undefined): asserts row is RecordRow {
  if (!row || row.revokedAt || row.ciphertext === null || row.version !== 1) throw unresolved();
}
function exactNamespace(runtime: Runtime, kbId: string, namespace: string) {
  if (namespace !== remoteSealedNamespace(runtime.canonicalOrigin, kbId)) throw unresolved();
}
async function replay(
  query: LockQuery,
  userId: string,
  input: z.infer<typeof sealedRevokeInput> | z.infer<typeof sealedEnrollInput>,
  operation: string,
  requestHash: string,
) {
  const prior = await findOperationIntent(query, {
    actorKey: `user:${userId}`,
    kbId: input.kbId,
    operation,
    idempotencyKey: input.idempotencyKey,
  });
  if (prior && prior.requestHash !== requestHash)
    throw new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
  return prior ? resultSchema.parse(prior.responseBody) : null;
}
async function receipt(
  query: LockQuery,
  userId: string,
  input: { kbId: string; idempotencyKey: string },
  operation: string,
  requestHash: string,
  reference: string,
  revoked = false,
): Promise<Result> {
  // Every successful policy mutation and its receipt commit in one transaction.
  await query(
    `UPDATE knowledge_base SET "sealedPolicyGeneration"="sealedPolicyGeneration"+1 WHERE id=$1`,
    [input.kbId],
  );
  const responseBody: Result = { operationId: randomUUID(), reference, version: 1, revoked };
  await recordAuditEvent(query, {
    opId: responseBody.operationId,
    action: operation.toLowerCase(),
    outcome: "SUCCESS",
    actorKey: `user:${userId}`,
    actorUserId: userId,
    actorUserIdSnapshot: userId,
    kbId: input.kbId,
    revision: "1",
    metadata: { requestId: parseSealedReference(reference).recordId },
  });
  await recordFinalizedReceipt(query, {
    ...input,
    actorUserId: userId,
    operation,
    requestHash,
    opId: responseBody.operationId,
    responseBody,
  });
  return responseBody;
}

export async function enrollSealedRecord(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof sealedEnrollInput>,
  keyValue: string | undefined,
): Promise<Result> {
  const input = sealedEnrollInput.parse(raw),
    master = requireKbMasterKey(keyValue);
  const literal = SecretLiteral.fromUtf8(input.plaintext);
  try {
    const hash = literal.use((bytes) =>
      createHmac("sha256", master)
        .update(
          JSON.stringify([
            "kb/sealed/enroll/1",
            principal.userId,
            input.kbId,
            input.namespace,
            input.recordId ?? null,
          ]),
        )
        .update(bytes)
        .digest("hex"),
    );
    return await asOwner(runtime, principal, input.kbId, async (query) => {
      exactNamespace(runtime, input.kbId, input.namespace);
      const prior = await replay(query, principal.userId, input, "SEALED_ENROLL", hash);
      if (prior) {
        assertLive(await record(query, input.kbId, parseSealedReference(prior.reference)));
        return prior;
      }
      const identity = {
        namespace: input.namespace,
        recordId: input.recordId ?? randomUUID(),
        version: 1,
      };
      if (await record(query, input.kbId, identity))
        throw new KbDomainError("CONFLICT", "Record identity already exists");
      await chargeKbMutation(runtime.ratePort, `user:${principal.userId}`, input.kbId);
      await query(
        `INSERT INTO sealed_record (namespace,"recordId","kbId","ownerId","ownerSnapshot",version,ciphertext) VALUES ($1::uuid,$2::uuid,$3,$4,$4,1,$5)`,
        [
          identity.namespace,
          identity.recordId,
          input.kbId,
          principal.userId,
          encryptSealedRecord(literal, identity, master),
        ],
      );
      return receipt(
        query,
        principal.userId,
        input,
        "SEALED_ENROLL",
        hash,
        sealedReference(identity.namespace, identity.recordId),
      );
    });
  } finally {
    literal.destroy();
    master.fill(0);
  }
}

function validateRecipientKey(value: string): void {
  try {
    sealedRecipientPublicKey(value);
  } catch {
    throw invalid();
  }
}
const GRANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Sealed-value eligibility, the single SQL definition used at grant
 * creation and at every resolution: the KB's current owner, or a user whose
 * live share on it has the owner-set `includeSealedValues`. A share without
 * it never yields a sealed-value capability, whatever its permission bits.
 * `kb` and `user` are SQL expressions (parameters or column references).
 */
export function sealedValuesEligibleSql(kb: string, user: string): string {
  return `(EXISTS (SELECT 1 FROM knowledge_base ek WHERE ek.id=${kb} AND ek."ownerId"=${user})
    OR EXISTS (SELECT 1 FROM kb_share es WHERE es."kbId"=${kb} AND es."userId"=${user}
      AND es."revokedAt" IS NULL AND es."includeSealedValues"))`;
}

/**
 * pat consumers bind to the exact existing, live PAT McpGrant generation (FK
 * RESTRICT) whose holder is sealed-eligible on this KB. The binding survives
 * later revocation as a reference to that exact tombstone; it is never
 * re-pointed. Remote consumers are always PATs, including device-flow PATs;
 * local-store consumers and OAuth grants have no remote approval.
 */
async function exactLiveConsumerGrant(
  query: LockQuery,
  kbId: string,
  consumerId: string,
): Promise<string> {
  if (!GRANT_UUID.test(consumerId)) throw invalid();
  const rows = await query<{ kind: string; revokedAt: Date | null; eligible: boolean }>(
    `SELECT g.kind::text AS kind, g."revokedAt",
            (g."userId" IS NOT NULL AND ${sealedValuesEligibleSql("$2", 'g."userId"')}) AS eligible
       FROM mcp_grant g WHERE g.id = $1::uuid FOR SHARE OF g`,
    [consumerId, kbId],
  );
  const row = rows.rows[0];
  if (!row || row.revokedAt || row.kind !== "PAT" || !row.eligible) throw invalid();
  return consumerId;
}

export async function grantSealedRecord(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof sealedGrantInput>,
): Promise<Result> {
  const input = sealedGrantInput.parse(raw),
    identity = parseSealedReference(input.reference),
    hash = canonicalRequestHash(input);
  validateRecipientKey(input.recipientPublicKey);
  return asOwner(runtime, principal, input.kbId, async (query) => {
    exactNamespace(runtime, input.kbId, identity.namespace);
    assertLive(await record(query, input.kbId, identity));
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw invalid();
    const prior = await replay(query, principal.userId, input, "SEALED_GRANT", hash);
    if (prior) return prior;
    const values = [
      identity.namespace,
      identity.recordId,
      input.consumerKind,
      input.consumerId,
      input.recipientKeyId,
    ];
    const existing = await query(
      `SELECT 1 FROM sealed_consumer_grant WHERE namespace=$1::uuid AND "recordId"=$2::uuid AND "consumerKind"=$3 AND "consumerId"=$4 AND "recipientKeyId"=$5::uuid`,
      values,
    );
    if (existing.rows.length)
      throw new KbDomainError("CONFLICT", "Approval identity already exists");
    const grantId = await exactLiveConsumerGrant(query, input.kbId, input.consumerId);
    await chargeKbMutation(runtime.ratePort, `user:${principal.userId}`, input.kbId);
    await query(
      `INSERT INTO sealed_consumer_grant (namespace,"recordId","consumerKind","consumerId","recipientKeyId","recipientPublicKey","authorizerId","expiresAt","grantId") VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8::timestamptz,$9::uuid)`,
      [...values, input.recipientPublicKey, principal.userId, input.expiresAt, grantId],
    );
    return receipt(query, principal.userId, input, "SEALED_GRANT", hash, input.reference);
  });
}
export async function revokeSealedRecord(
  runtime: Runtime,
  principal: Principal,
  raw: z.input<typeof sealedRevokeInput>,
): Promise<Result> {
  const input = sealedRevokeInput.parse(raw),
    identity = parseSealedReference(input.reference),
    hash = canonicalRequestHash(input);
  return asOwner(runtime, principal, input.kbId, async (query) => {
    exactNamespace(runtime, input.kbId, identity.namespace);
    if (!(await record(query, input.kbId, identity))) throw unresolved();
    const prior = await replay(query, principal.userId, input, "SEALED_REVOKE", hash);
    if (prior) return prior;
    await chargeKbMutation(runtime.ratePort, `user:${principal.userId}`, input.kbId);
    await query(
      `DELETE FROM sealed_consumer_grant WHERE namespace=$1::uuid AND "recordId"=$2::uuid`,
      [identity.namespace, identity.recordId],
    );
    await query(
      `UPDATE sealed_record SET ciphertext=NULL,"revokedAt"=COALESCE("revokedAt",now()) WHERE namespace=$1::uuid AND "recordId"=$2::uuid`,
      [identity.namespace, identity.recordId],
    );
    return receipt(query, principal.userId, input, "SEALED_REVOKE", hash, input.reference, true);
  });
}

/**
 * Ownership transfer, inside the accept transaction: sealed control is
 * exact-owner only, so the KB's records move to the new owner and every
 * consumer approval the former owner issued on them is removed. The former
 * owner keeps an ordinary `manage` share, which never carries sealed control,
 * and a later transfer back cannot resurrect a removed approval.
 */
export async function transferSealedOwnership(
  query: LockQuery,
  input: { kbId: string; fromUserId: string; toUserId: string },
): Promise<void> {
  await query(
    `DELETE FROM sealed_consumer_grant g USING sealed_record r
      WHERE g.namespace=r.namespace AND g."recordId"=r."recordId" AND r."kbId"=$1 AND g."authorizerId"=$2`,
    [input.kbId, input.fromUserId],
  );
  await query(`UPDATE sealed_record SET "ownerId"=$2,"ownerSnapshot"=$2 WHERE "kbId"=$1`, [
    input.kbId,
    input.toUserId,
  ]);
}

/**
 * Inside the member-removal transaction: removing a member ends their
 * share, so every consumer approval on this KB's records bound to one of that
 * member's PAT grants is removed. Eligibility (`sealedValuesEligibleSql`)
 * already stops them resolving while the share is ended; removing them means a
 * later share (re-invite, and the owner turning `includeSealedValues` back on)
 * can never resurrect an approval issued for the ended one.
 */
export async function endMemberSealedApprovals(
  query: LockQuery,
  input: { kbId: string; userId: string },
): Promise<void> {
  await query(
    `DELETE FROM sealed_consumer_grant g USING sealed_record r, mcp_grant m
      WHERE g.namespace=r.namespace AND g."recordId"=r."recordId" AND r."kbId"=$1
        AND g."grantId"=m.id AND m."userId"=$2`,
    [input.kbId, input.userId],
  );
}

/** Caller owns authority transaction. Records survive to forbid UUID/version reuse. */
export async function destroySealedAuthority(
  query: LockQuery,
  scope: { kbId: string } | { userId: string },
): Promise<void> {
  const byKb = "kbId" in scope,
    value = byKb ? scope.kbId : scope.userId;
  const condition = byKb ? 'r."kbId"=$1' : 'r."ownerSnapshot"=$1';
  await query(
    `DELETE FROM sealed_consumer_grant g USING sealed_record r WHERE g.namespace=r.namespace AND g."recordId"=r."recordId" AND (${condition}${byKb ? "" : ' OR g."authorizerId"=$1'})`,
    [value],
  );
  await query(
    `UPDATE knowledge_base SET "sealedPolicyGeneration"="sealedPolicyGeneration"+1
      WHERE id IN (SELECT r."kbId" FROM sealed_record r WHERE ${condition})`,
    [value],
  );
  await query(
    `UPDATE sealed_record r SET ciphertext=NULL,"revokedAt"=COALESCE("revokedAt",now()) WHERE ${condition}`,
    [value],
  );
}

/**
 * Point lookup only, under the caller's authority lock. Never a wildcard or
 * record list. An approval resolves only while its authorizer is still the
 * KB's exact owner (sealed control never travels with a share), only
 * for a PAT consumer (never OAuth), and only while the resolving user
 * is sealed-eligible on the KB right now (owner, or a live share with the
 * owner-set `includeSealedValues`).
 */
export async function loadSealedResolution(
  query: LockQuery,
  input: {
    kbId: string;
    namespace: string;
    recordId: string;
    consumerKind: "pat";
    consumerId: string;
    recipientKeyId: string;
    userId: string;
  },
): Promise<{ ciphertext: string; version: number; recipientPublicKey: string; expiresAt: Date }> {
  if (input.consumerKind !== "pat") throw unresolved();
  const result = await query<RecordRow & { recipientPublicKey: string; expiresAt: Date }>(
    `SELECT r.version,r.ciphertext,r."revokedAt",g."recipientPublicKey",g."expiresAt"
     FROM sealed_record r JOIN sealed_consumer_grant g ON g.namespace=r.namespace AND g."recordId"=r."recordId"
     JOIN knowledge_base k ON k.id=r."kbId" AND k."ownerId"=g."authorizerId"
     WHERE r."kbId"=$1 AND r.namespace=$2::uuid AND r."recordId"=$3::uuid
       AND g."consumerKind"='pat' AND g."consumerId"=$4 AND g."recipientKeyId"=$5::uuid
       AND r."revokedAt" IS NULL AND r.ciphertext IS NOT NULL AND r.version=1
       AND g."expiresAt">clock_timestamp()
       AND ${sealedValuesEligibleSql("$1", "$6")}`,
    [
      input.kbId,
      input.namespace,
      input.recordId,
      input.consumerId,
      input.recipientKeyId,
      input.userId,
    ],
  );
  const row = result.rows[0];
  assertLive(row);
  if (!row.ciphertext || !(row.expiresAt instanceof Date) || row.expiresAt.getTime() <= Date.now())
    throw unresolved();
  return {
    ciphertext: row.ciphertext,
    version: row.version,
    recipientPublicKey: row.recipientPublicKey,
    expiresAt: row.expiresAt,
  };
}
