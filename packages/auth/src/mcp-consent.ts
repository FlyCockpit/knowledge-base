import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import type { Prisma, PrismaClient } from "@knowledge-base/db/client";
import { z } from "zod";
import { isUserBanned } from "./ban";
import {
  deriveMcpConsentReferenceId,
  expandMcpBits,
  MCP_KB_PERMISSIONS,
  normalizeGrantCeiling,
} from "./mcp-grant";
import { MCP_TOOL_GROUPS } from "./mcp-tool-groups";
import { isImpersonatedSession } from "./roles";
import { sealedApprovalExpirySchema, sealedRecipientPublicKey } from "./sealed-recipient";
import {
  FORCE_2FA_SETTING_KEYS,
  forcedTwoFactorSettingKeyForRole,
  isForcedTwoFactorEnabled,
  isTwoFactorRequirementSatisfied,
} from "./two-factor-policy";

const scopes = ["mcp:read", "mcp:write", "offline_access"] as const;
const bits = z.array(z.enum(MCP_KB_PERMISSIONS)).max(5);
const toolGroups = z.array(z.enum(MCP_TOOL_GROUPS)).min(1).max(MCP_TOOL_GROUPS.length);
const kbId = z.string().regex(/^[a-z0-9]{24,32}$/);
const recipient = z.strictObject({
  kbId,
  namespace: z.uuid(),
  recordId: z.uuid(),
  recipientKeyId: z.uuid(),
  recipientPublicKey: z
    .string()
    .length(44)
    .refine((value) => {
      try {
        sealedRecipientPublicKey(value);
        return true;
      } catch {
        return false;
      }
    }),
  expiresAt: sealedApprovalExpirySchema,
});
/**
 * Credential selection shared by PAT minting through the CLI device flow: it
 * may carry exact sealed recipients, because the CLI registers its own
 * recipient key. OAuth consent uses `consentSelection`, which never does.
 */
export const credentialSelection = z
  .strictObject({
    scopes: z.array(z.enum(scopes)).min(1).max(3),
    toolGroups,
    acl: z.array(z.strictObject({ kbId, bits: bits.min(1) })).max(256),
    allowCreate: z.boolean().default(false),
    createdKbBits: bits.default([]),
    recipients: z.array(recipient).max(256).default([]),
  })
  .transform((input, ctx) => {
    try {
      if (new Set(input.scopes).size !== input.scopes.length) throw new Error();
      const ceiling = normalizeGrantCeiling({
        ...input,
        scopes: input.scopes.filter((s) => s !== "offline_access"),
      });
      const recipients = [...input.recipients].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
      if (
        new Set(recipients.map((r) => `${r.namespace}/${r.recordId}/${r.recipientKeyId}`)).size !==
        recipients.length
      )
        throw new Error();
      return {
        ...ceiling,
        scopes: scopes.filter((s) => input.scopes.includes(s)),
        acl: ceiling.acl
          .map((a) => ({ ...a, bits: expandMcpBits(a.bits) }))
          .sort((a, b) => a.kbId.localeCompare(b.kbId)),
        createdKbBits: expandMcpBits(ceiling.createdKbBits),
        recipients,
      };
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid consent selection" });
      return z.NEVER;
    }
  });
export type CredentialSelection = z.output<typeof credentialSelection>;

const consentSelectionFields = {
  scopes: z.array(z.enum(scopes)).min(1).max(3),
  toolGroups,
  acl: z.array(z.strictObject({ kbId, bits: bits.min(1) })).max(256),
  allowCreate: z.boolean().default(false),
  createdKbBits: bits.default([]),
};
/**
 * The normalized OAuth consent selection has no place for a
 * sealed-recipient capability at all (a `recipients` key is rejected), and an
 * OAuth credential never resolves sealed values, so it cannot hold `sealed`.
 */
export const consentSelection = z.strictObject(consentSelectionFields).transform((input, ctx) => {
  const parsed = credentialSelection.safeParse(input);
  if (!parsed.success || parsed.data.toolGroups.includes("sealed")) {
    ctx.addIssue({ code: "custom", message: "Invalid consent selection" });
    return z.NEVER;
  }
  const { recipients: _none, ...selection } = parsed.data;
  return selection;
});
export type ConsentSelection = z.output<typeof consentSelection>;
type Ceiling = {
  scopes: readonly string[];
  toolGroups: readonly string[];
  acl: readonly { kbId: string; bits: readonly string[] }[];
  allowCreate?: boolean;
  createdKbBits?: readonly string[];
};
export class McpConsentError extends Error {
  constructor(message = "Invalid MCP consent") {
    super(message);
  }
}
/**
 * An OAuth consent request that asks for a sealed-value capability is
 * refused outright (no grant is created or changed); sealed values are only
 * held by the CLI or a personal access token.
 */
export class McpSealedConsentError extends McpConsentError {
  readonly code = "SEALED_VALUES_REQUIRE_CLI_OR_PAT" as const;
  constructor() {
    super("Sealed values require the CLI or a personal access token.");
  }
}
const reject = (): never => {
  throw new McpConsentError();
};
const subset = (a: readonly string[], b: readonly string[]) => a.every((v) => b.includes(v));
export function isConsentSubset(a: Ceiling, b: Ceiling): boolean {
  return (
    subset(a.scopes, b.scopes) &&
    a.toolGroups.length > 0 &&
    subset(a.toolGroups, b.toolGroups) &&
    (!a.allowCreate || !!b.allowCreate) &&
    subset(expandMcpBits(a.createdKbBits ?? []), expandMcpBits(b.createdKbBits ?? [])) &&
    a.acl.every((entry) =>
      b.acl.some(
        (old) =>
          old.kbId === entry.kbId && subset(expandMcpBits(entry.bits), expandMcpBits(old.bits)),
      ),
    )
  );
}

/** Better Auth 1.7.4 signs all query pairs sorted by key then value, HMAC base64. */
export function verifyOAuthQuery(raw: string, secret: string, resource: string, now = new Date()) {
  if (!raw || raw.length > 16384) reject();
  const p = new URLSearchParams(raw);
  for (const key of p.keys()) if (key !== "ba_param" && p.getAll(key).length !== 1) reject();
  const signature = Buffer.from(p.get("sig") ?? "", "utf8");
  p.delete("sig");
  const canonical = new URLSearchParams(
    [...p].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)),
  ).toString();
  const expected = Buffer.from(createHmac("sha256", secret).update(canonical).digest("base64"));
  const expiresAt = new Date(Number(p.get("exp")) * 1000);
  const selectedScopes = (p.get("scope") ?? "").split(" ");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    p.get("resource") !== resource ||
    p.get("response_type") !== "code" ||
    p.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "") ||
    !selectedScopes.some((s) => s === "mcp:read" || s === "mcp:write") ||
    !subset(selectedScopes, scopes) ||
    new Set(selectedScopes).size !== selectedScopes.length
  )
    reject();
  const clientId = p.get("client_id");
  const redirectUri = p.get("redirect_uri");
  if (!clientId || !redirectUri) return reject();
  return {
    clientId,
    redirectUri,
    resource,
    scopes: selectedScopes,
    expiresAt,
    queryDigest: createHash("sha256").update(canonical).digest("hex"),
  };
}

export async function assertConsentIdentity(tx: Prisma.TransactionClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user || isUserBanned(user)) return reject();
  const key = forcedTwoFactorSettingKeyForRole(user.role);
  const settings = await tx.appSetting.findMany({
    where: { key: { in: [...FORCE_2FA_SETTING_KEYS] } },
    take: 2,
    select: { key: true, value: true },
  });
  if (
    !isTwoFactorRequirementSatisfied(
      user,
      isForcedTwoFactorEnabled(key, settings.find((s) => s.key === key)?.value),
    )
  )
    reject();
}
export async function assertLiveConsentSelection(
  tx: Prisma.TransactionClient,
  userId: string,
  selection: ConsentSelection & { recipients?: CredentialSelection["recipients"] },
  now: Date,
) {
  if (selection.recipients?.length) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true },
    });
    // Exact sealed approval has no unforced-policy or enrollment-grace exemption.
    if (user?.twoFactorEnabled !== true) reject();
  }
  const ids = [...new Set(selection.acl.map((entry) => entry.kbId))];
  // pagination:audited — bounded by acl .max(256)
  const kbs = await tx.knowledgeBase.findMany({
    where: { id: { in: ids } },
    select: { id: true, ownerId: true, state: true },
  });
  // pagination:audited — bounded by acl .max(256), unique (kbId, userId)
  const shares = await tx.kbShare.findMany({
    where: { userId, kbId: { in: ids } },
    select: { kbId: true, bits: true, revokedAt: true },
  });
  const kbById = new Map(kbs.map((kb) => [kb.id, kb]));
  const shareByKbId = new Map(shares.map((share) => [share.kbId, share]));
  for (const entry of selection.acl) {
    const kb = kbById.get(entry.kbId);
    const share = shareByKbId.get(entry.kbId);
    const live =
      kb?.ownerId === userId
        ? MCP_KB_PERMISSIONS
        : share && !share.revokedAt
          ? expandMcpBits(share.bits)
          : [];
    if (kb?.state !== "ACTIVE" || !subset(entry.bits, live)) reject();
  }
  const recipients = selection.recipients ?? [];
  for (const r of recipients) {
    // Recheck even if a caller already parsed the selection; all committing
    // approval writers share this live validation under the authority lock.
    try {
      sealedRecipientPublicKey(r.recipientPublicKey);
      sealedApprovalExpirySchema.parse(r.expiresAt);
    } catch {
      reject();
    }
  }
  const records = recipients.length
    ? await tx.sealedRecord.findMany({
        where: { OR: recipients.map(({ namespace, recordId }) => ({ namespace, recordId })) },
        select: {
          namespace: true,
          recordId: true,
          ownerId: true,
          kbId: true,
          revokedAt: true,
          ciphertext: true,
        },
        take: recipients.length,
      })
    : [];
  // PostgreSQL UUID equality ignores case, including for unnormalized callers.
  const recordById = new Map(records.map((r) => [`${r.namespace}/${r.recordId}`.toLowerCase(), r]));
  for (const r of recipients) {
    const record = recordById.get(`${r.namespace}/${r.recordId}`.toLowerCase());
    if (
      !record ||
      record.ownerId !== userId ||
      record.kbId !== r.kbId ||
      record.revokedAt ||
      !record.ciphertext ||
      Date.parse(r.expiresAt) <= now.getTime() ||
      !selection.acl.some((a) => a.kbId === r.kbId && a.bits.includes("read"))
    )
      reject();
  }
}

type Actor = { userId: string; sessionId: string };
export const consentApprovalInput = z.strictObject({
  referenceId: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.uuid(),
  oauthQuery: z.string().min(1).max(16384),
  // The request may name `recipients` only so the server can refuse it with a
  // typed error; `approve` never lets them reach `consentSelection`.
  selection: z.strictObject({
    ...consentSelectionFields,
    recipients: z.array(z.unknown()).max(256).optional(),
  }),
  explicitConsent: z.boolean(),
  reuseGrantId: z.uuid().optional(),
});
/**
 * Whether consent reuse removes anything from the stored grant: a scope, a
 * group, creation, a created-KB bit, a KB, or a bit on a kept KB.
 */
async function consentReuseNarrows(
  tx: Prisma.TransactionClient,
  old: {
    id: string;
    scopes: string[];
    toolGroups: string[];
    allowCreate: boolean;
    createdKbBits: string[];
  },
  next: z.output<typeof consentSelection>,
): Promise<boolean> {
  const lost = (from: readonly string[], to: readonly string[]) =>
    from.some((value) => !to.includes(value));
  if (
    lost(old.scopes, next.scopes) ||
    lost(old.toolGroups, next.toolGroups) ||
    (old.allowCreate && !next.allowCreate) ||
    lost(expandMcpBits(old.allowCreate ? old.createdKbBits : []), expandMcpBits(next.createdKbBits))
  )
    return true;
  // One bounded EXISTS over the stored ACL (which creator appends may grow past
  // the selection cap): any stored KB the new selection drops, or any stored
  // bit it lacks on a kept KB. Nothing is loaded.
  const kept = JSON.stringify(
    next.acl.map((entry) => ({ kbId: entry.kbId, bits: expandMcpBits(entry.bits) })),
  );
  const [row] = await tx.$queryRaw<{ narrows: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "grant_kb_acl" a
        LEFT JOIN jsonb_to_recordset(${kept}::jsonb) AS n("kbId" text, bits text[])
          ON n."kbId" = a."kbId"
       WHERE a."grantId" = ${old.id}::uuid
         AND (n."kbId" IS NULL OR NOT (a.bits <@ n.bits))
    ) AS narrows`;
  return row?.narrows === true;
}

/**
 * Ends every elevation in force on a grant (database clock) and records one
 * `MCP_GRANT_ELEVATION_ENDED` listing the ended ids (at most 5, the active cap).
 */
async function endActiveElevationsForConsent(
  tx: Prisma.TransactionClient,
  userId: string,
  grantId: string,
  opId: string,
): Promise<void> {
  const ended = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "mcp_grant_elevation" e SET "revokedAt" = clock_timestamp()
     WHERE e."grantId" = ${grantId}::uuid AND e."revokedAt" IS NULL
       AND e."expiresAt" > clock_timestamp()
     RETURNING e.id::text AS id`;
  if (ended.length === 0) return;
  await tx.auditEvent.create({
    data: {
      opId,
      action: "MCP_GRANT_ELEVATION_ENDED",
      outcome: "SUCCESS",
      actorKey: `user:${userId}`,
      actorUserIdSnapshot: userId,
      actorUserId: userId,
      grantIdSnapshot: grantId,
      metadata: {
        elevationIds: JSON.stringify(ended.map((row) => row.id).sort()),
        reasonCode: "narrowed",
      },
    },
  });
}

/** Owns authority lock -> DB transaction; no provider callback or network awaits inside. */
export function createMcpConsentService(options: {
  db: PrismaClient;
  secret: string;
  resource: string;
  now?: () => Date;
}) {
  const { db, secret, resource } = options;
  const now = options.now ?? (() => new Date());
  const reference = (actor: Actor, clientId: string, nonce: string) =>
    deriveMcpConsentReferenceId({ secret, sessionId: actor.sessionId, clientId, nonce });
  async function transaction<T>(
    actor: Actor,
    query: ReturnType<typeof verifyOAuthQuery>,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return db.$transaction(
      async (tx) => {
        await lockIdentityAuthority(tx);
        await assertConsentIdentity(tx, actor.userId);
        const session = await tx.session.findUnique({
          where: { id: actor.sessionId },
          select: { userId: true, expiresAt: true, impersonatedBy: true },
        });
        const client = await tx.oauthClient.findUnique({
          where: { clientId: query.clientId },
          select: { disabled: true, redirectUris: true, scopes: true, grantTypes: true },
        });
        const link = await tx.oauthClientResource.findUnique({
          where: { clientId_resourceId: { clientId: query.clientId, resourceId: resource } },
          select: { resource: { select: { disabled: true, allowedScopes: true } } },
        });
        const allowedScopes = link?.resource.allowedScopes;
        if (
          query.expiresAt <= now() ||
          !session ||
          isImpersonatedSession({ session }) ||
          session.userId !== actor.userId ||
          session.expiresAt <= now() ||
          !client ||
          client.disabled ||
          !client.redirectUris.includes(query.redirectUri) ||
          !client.grantTypes.includes("authorization_code") ||
          !subset(query.scopes, client.scopes) ||
          !link ||
          link.resource.disabled ||
          (allowedScopes !== null &&
            (!Array.isArray(allowedScopes) ||
              !query.scopes.every((s) => allowedScopes.includes(s))))
        )
          reject();
        return run(tx);
      },
      { timeout: 10000 },
    );
  }
  async function prepareIn(
    tx: Prisma.TransactionClient,
    actor: Actor,
    query: ReturnType<typeof verifyOAuthQuery>,
  ) {
    const sessionDigest = reference(actor, query.clientId, "session-binding");
    const existing = await tx.consentIntent.findUnique({
      where: { sessionDigest_queryDigest: { sessionDigest, queryDigest: query.queryDigest } },
    });
    if (existing) return { referenceId: existing.referenceId, nonce: existing.nonce };
    const nonce = randomUUID();
    const referenceId = reference(actor, query.clientId, nonce);
    await tx.consentIntent.create({
      data: {
        ...query,
        nonce,
        referenceId,
        sessionDigest,
        actorUserIdSnapshot: actor.userId,
        userId: actor.userId,
      },
    });
    return { referenceId, nonce };
  }
  return {
    async prepare(actor: Actor, raw: string) {
      const query = verifyOAuthQuery(raw, secret, resource, now());
      return transaction(actor, query, (tx) => prepareIn(tx, actor, query));
    },
    /**
     * Human consent page view: the same durable intent as `prepare`, plus a
     * display projection built ONLY from the verified signed query and DB
     * rows (never from unsigned URL parameters). `previousGrantId` is the
     * newest live OAuth generation for this user+client+resource; the page
     * passes it as `reuseGrantId` and `approve` alone decides subset reuse.
     * OAuth consent never offers a sealed-recipient capability.
     */
    async review(actor: Actor, raw: string) {
      const query = verifyOAuthQuery(raw, secret, resource, now());
      return transaction(actor, query, async (tx) => {
        const intent = await prepareIn(tx, actor, query);
        const receipt = await tx.consentIntent.findUnique({
          where: { referenceId: intent.referenceId },
          select: { grantId: true, approvedAt: true, selection: true },
        });
        const client = await tx.oauthClient.findUnique({
          where: { clientId: query.clientId },
          select: { name: true, uri: true },
        });
        const previous = await tx.mcpGrant.findFirst({
          where: {
            userId: actor.userId,
            kind: "OAUTH",
            clientId: query.clientId,
            revokedAt: null,
            consentIntents: { some: { resource } },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        return {
          ...intent,
          expiresAt: query.expiresAt,
          client: {
            clientId: query.clientId,
            name: client?.name ?? null,
            uri: client?.uri ?? null,
          },
          redirectUri: query.redirectUri,
          resource,
          scopes: query.scopes,
          previousGrantId: previous?.id ?? null,
          // The same signed request may be reopened after a reply was lost.
          approval:
            receipt?.grantId && receipt.approvedAt
              ? {
                  grantId: receipt.grantId,
                  selection: consentSelection.parse(receipt.selection),
                }
              : null,
        };
      });
    },
    async approve(actor: Actor, raw: z.input<typeof consentApprovalInput>) {
      const request = consentApprovalInput.parse(raw);
      const { recipients, ...requested } = request.selection;
      if (recipients && recipients.length > 0) throw new McpSealedConsentError();
      const selection = consentSelection.parse(requested);
      const input = { ...request, selection };
      const query = verifyOAuthQuery(input.oauthQuery, secret, resource, now());
      return transaction(actor, query, async (tx) => {
        const intent = await tx.consentIntent.findUnique({
          where: { referenceId: input.referenceId },
        });
        if (
          !intent ||
          intent.userId !== actor.userId ||
          intent.nonce !== input.nonce ||
          intent.referenceId !== reference(actor, query.clientId, input.nonce) ||
          intent.queryDigest !== query.queryDigest ||
          intent.resource !== resource ||
          intent.expiresAt <= now() ||
          !subset(input.selection.scopes, intent.scopes)
        )
          return reject();
        await assertLiveConsentSelection(tx, actor.userId, input.selection, now());
        const grantId = intent.grantId ?? input.reuseGrantId;
        const old = grantId
          ? await tx.mcpGrant.findUnique({
              where: { id: grantId },
              include: {
                acl: { where: { kbId: { in: input.selection.acl.map((a) => a.kbId) } }, take: 256 },
                consentIntents: { where: { resource }, take: 1 },
              },
            })
          : null;
        const active =
          old &&
          old.kind === "OAUTH" &&
          old.userId === actor.userId &&
          old.clientId === query.clientId &&
          !old.revokedAt &&
          old.consentIntents.length === 1;
        const reusable = active && isConsentSubset(input.selection, old);
        if (intent.grantId) {
          if (
            !reusable ||
            JSON.stringify(consentSelection.parse(intent.selection)) !==
              JSON.stringify(input.selection)
          )
            return reject();
          return { referenceId: intent.referenceId, grantId: intent.grantId };
        }
        if (!reusable && !input.explicitConsent) return reject();
        const id = reusable ? old.id : randomUUID();
        const data = {
          scopes: input.selection.scopes,
          toolGroups: input.selection.toolGroups,
          allowCreate: input.selection.allowCreate,
          createdKbBits: input.selection.createdKbBits,
        };
        if (reusable) {
          // Reuse can only reduce the shared generation, including older credentials.
          const narrows = await consentReuseNarrows(tx, old, input.selection);
          await tx.mcpGrant.update({ where: { id }, data });
          await tx.grantKbAcl.deleteMany({ where: { grantId: id } });
          // A narrowing is never masked by temporary access: end every active elevation.
          if (narrows) await endActiveElevationsForConsent(tx, actor.userId, id, intent.nonce);
        } else
          await tx.mcpGrant.create({
            data: {
              ...data,
              id,
              kind: "OAUTH",
              actorUserIdSnapshot: actor.userId,
              userId: actor.userId,
              clientId: query.clientId,
              referenceId: intent.referenceId,
            },
          });
        if (input.selection.acl.length)
          await tx.grantKbAcl.createMany({
            data: input.selection.acl.map((a) => ({ ...a, grantId: id })),
          });
        await tx.consentIntent.update({
          where: { id: intent.id },
          data: { selection: input.selection, grantId: id, approvedAt: now() },
        });
        await tx.auditEvent.create({
          data: {
            opId: intent.nonce,
            action: "MCP_CONSENT_APPROVED",
            outcome: "SUCCESS",
            actorKey: `user:${actor.userId}`,
            actorUserIdSnapshot: actor.userId,
            actorUserId: actor.userId,
            grantIdSnapshot: id,
            metadata: {},
          },
        });
        return { referenceId: intent.referenceId, grantId: id };
      });
    },
  };
}
