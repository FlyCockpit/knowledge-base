import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_LOCALE } from "@knowledge-base/config/locales";
import { lockIdentityAuthority } from "@knowledge-base/db/authority-lock";
import type { Prisma, PrismaClient } from "@knowledge-base/db/client";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deviceAuthorization } from "better-auth/plugins";
import { z } from "zod";
import { canonicalMcpResource, patDisplayName, resolvePatExpiry } from "./mcp-config";
import {
  assertConsentIdentity,
  assertLiveConsentSelection,
  credentialSelection,
  McpConsentError,
} from "./mcp-consent";
import { isImpersonatedSession } from "./roles";
import { sealedRecipientPublicKey } from "./sealed-recipient";

export const digestDeviceCode = (raw: string) =>
  createHash("sha256").update("kb-device-v1\0").update(raw).digest("hex");
const sessionDigest = (raw: string) =>
  createHash("sha256").update("kb-device-session-v1\0").update(raw).digest("hex");
const userCode = z.string().regex(/^[A-Z0-9]{8}$/);
export const deviceSelection = credentialSelection.refine(
  (s) => !s.scopes.includes("offline_access"),
);
const decisionInput = z.strictObject({ userCode, nonce: z.uuid() });
export const deviceIntentInput = decisionInput.extend({
  selection: deviceSelection,
  expiresAt: z.iso.datetime().optional(),
});
export const deviceExchangeInput = z.strictObject({
  deviceCode: z.string().min(1).max(512),
  name: patDisplayName,
});
const recipientKey = z.strictObject({
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
});
export const deviceRecipientInput = z.strictObject({
  deviceCode: z.string().min(1).max(512),
  recipientKey,
});
type Actor = { userId: string; sessionId: string };
type Decision = "approve" | "deny";
type PollError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant";
export class DeviceApprovalError extends Error {
  constructor(readonly code: PollError = "invalid_grant") {
    super(code);
  }
}
const reject = (): never => {
  throw new DeviceApprovalError();
};
type Mint = (
  tx: Prisma.TransactionClient,
  userId: string,
  selection: z.output<typeof deviceSelection>,
  name: string,
  expiresAt: Date,
) => Promise<{ credentialId: string; grantId: string; secret: string; expiresAt: Date }>;

/** Lock order: global authority -> device row -> user row. Session revocations
 * share the committing authority lock through the Better Auth adapter. All state and mint
 * effects share ONE transaction, with no network or retained plaintext. Poll
 * errors are returned from the transaction so the polling timestamp commits. */
export function createDeviceApprovalService(options: {
  db: PrismaClient;
  resource: string;
  now?: () => Date;
}) {
  const { db, resource } = options;
  const now = options.now ?? (() => new Date());
  async function transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
    return db.$transaction(
      async (tx) => {
        await lockIdentityAuthority(tx);
        return run(tx);
      },
      { timeout: 10000, maxWait: 5000 },
    );
  }
  async function identity(tx: Prisma.TransactionClient, actor: Actor) {
    await assertConsentIdentity(tx, actor.userId);
    const session = await tx.session.findUnique({
      where: { id: actor.sessionId },
      select: { userId: true, expiresAt: true, impersonatedBy: true },
    });
    if (
      !session ||
      isImpersonatedSession({ session }) ||
      session.userId !== actor.userId ||
      session.expiresAt <= now()
    )
      reject();
  }
  async function claimed(
    tx: Prisma.TransactionClient,
    actor: Actor,
    raw: z.input<typeof decisionInput>,
  ) {
    const input = decisionInput.parse(raw);
    await tx.$queryRaw`SELECT id FROM device_code WHERE "userCode" = ${input.userCode} FOR UPDATE`;
    await identity(tx, actor);
    const code = await tx.deviceCode.findUnique({ where: { userCode: input.userCode } });
    const intent =
      code &&
      (await tx.deviceApproval.findUnique({ where: { deviceCodeDigest: code.deviceCodeDigest } }));
    if (
      !code ||
      !intent ||
      code.status !== "pending" ||
      code.expiresAt <= now() ||
      intent.expiresAt <= now() ||
      code.userId !== actor.userId ||
      intent.userId !== actor.userId ||
      intent.sessionDigest !== sessionDigest(actor.sessionId) ||
      intent.nonce !== input.nonce ||
      intent.clientId !== code.clientId ||
      intent.userCode !== code.userCode ||
      intent.resource !== resource ||
      intent.consumedAt ||
      intent.decision !== "pending"
    )
      return reject();
    return { code, intent };
  }
  async function check(
    tx: Prisma.TransactionClient,
    actor: Actor,
    input: z.input<typeof decisionInput>,
    decision: Decision,
  ) {
    const result = await claimed(tx, actor, input);
    if (decision === "approve") {
      const selected = deviceSelection.parse(result.intent.selection);
      assertRecipientBinding(result.code.recipientKey, selected);
      if (!result.intent.patExpiresAt || result.intent.patExpiresAt <= now()) reject();
      await assertLiveConsentSelection(tx, actor.userId, selected, now());
    }
    return result;
  }
  function assertRecipientBinding(key: unknown, selection: z.output<typeof deviceSelection>) {
    if (!selection.recipients.length) return;
    const registered = recipientKey.safeParse(key);
    if (
      !registered.success ||
      selection.recipients.some(
        (r) =>
          r.recipientKeyId !== registered.data.recipientKeyId ||
          r.recipientPublicKey !== registered.data.recipientPublicKey,
      )
    )
      reject();
  }
  return {
    /** Possession of the device secret registers only a public key, before any
     * human claim. No ACL or recipient records are authorized by this operation. */
    async registerRecipient(raw: z.input<typeof deviceRecipientInput>) {
      const input = deviceRecipientInput.parse(raw);
      const digest = digestDeviceCode(input.deviceCode);
      return transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM device_code WHERE "deviceCodeDigest" = ${digest} FOR UPDATE`;
        const code = await tx.deviceCode.findUnique({ where: { deviceCodeDigest: digest } });
        if (
          code?.clientId !== "kb-cli" ||
          code.status !== "pending" ||
          code.expiresAt <= now() ||
          code.userId ||
          (await tx.deviceApproval.findUnique({ where: { deviceCodeDigest: digest } }))
        )
          return reject();
        if (code.recipientKey) {
          const previous = recipientKey.parse(code.recipientKey);
          if (
            previous.recipientKeyId !== input.recipientKey.recipientKeyId ||
            previous.recipientPublicKey !== input.recipientKey.recipientPublicKey
          )
            reject();
        } else
          await tx.deviceCode.update({
            where: { id: code.id },
            data: { recipientKey: input.recipientKey },
          });
        return { registered: true };
      });
    },
    async claim(actor: Actor, raw: string) {
      const value = userCode.parse(raw);
      return transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM device_code WHERE "userCode" = ${value} FOR UPDATE`;
        await identity(tx, actor);
        const code = await tx.deviceCode.findUnique({ where: { userCode: value } });
        if (
          code?.status !== "pending" ||
          code.expiresAt <= now() ||
          code.clientId !== "kb-cli" ||
          (code.userId && code.userId !== actor.userId)
        )
          return reject();
        let intent = await tx.deviceApproval.findUnique({
          where: { deviceCodeDigest: code.deviceCodeDigest },
        });
        if (
          intent &&
          (intent.sessionDigest !== sessionDigest(actor.sessionId) || intent.decision !== "pending")
        )
          return reject();
        if (!intent)
          intent = await tx.deviceApproval.create({
            data: {
              deviceCodeDigest: code.deviceCodeDigest,
              userCode: code.userCode,
              clientId: code.clientId,
              nonce: randomUUID(),
              userId: actor.userId,
              actorUserIdSnapshot: actor.userId,
              sessionDigest: sessionDigest(actor.sessionId),
              resource,
              expiresAt: code.expiresAt,
            },
          });
        await tx.deviceCode.update({ where: { id: code.id }, data: { userId: actor.userId } });
        return {
          user_code: code.userCode,
          client_id: code.clientId,
          scope: code.scope,
          status: code.status,
          nonce: intent.nonce,
          recipient_key: code.recipientKey ? recipientKey.parse(code.recipientKey) : null,
        };
      });
    },
    async select(actor: Actor, raw: z.input<typeof deviceIntentInput>) {
      const input = deviceIntentInput.parse(raw);
      return transaction(async (tx) => {
        const { code, intent } = await claimed(tx, actor, {
          userCode: input.userCode,
          nonce: input.nonce,
        });
        if (
          intent.selection ||
          !input.selection.scopes.every((s) => (code.scope ?? "").split(" ").includes(s))
        )
          return reject();
        await assertLiveConsentSelection(tx, actor.userId, input.selection, now());
        assertRecipientBinding(code.recipientKey, input.selection);
        const patExpiresAt = resolvePatExpiry(
          input.expiresAt ? new Date(input.expiresAt) : undefined,
          now(),
        );
        if (input.selection.recipients.some((r) => new Date(r.expiresAt) > patExpiresAt))
          return reject();
        await tx.deviceApproval.update({
          where: { id: intent.id },
          data: { selection: input.selection, patExpiresAt },
        });
        return { nonce: intent.nonce };
      });
    },
    async check(actor: Actor, input: z.input<typeof decisionInput>, decision: Decision) {
      await transaction((tx) => check(tx, actor, input, decision));
    },
    async decide(actor: Actor, input: z.input<typeof decisionInput>, decision: Decision) {
      await transaction(async (tx) => {
        const { code, intent } = await check(tx, actor, input, decision);
        await tx.deviceApproval.update({
          where: { id: intent.id },
          data: {
            decision: decision === "approve" ? "approved" : "denied",
            approvedAt: decision === "approve" ? now() : null,
          },
        });
        await tx.deviceCode.update({
          where: { id: code.id },
          data: { status: decision === "approve" ? "approved" : "denied" },
        });
        await tx.auditEvent.create({
          data: {
            opId: intent.nonce,
            action: decision === "approve" ? "device_approve" : "device_deny",
            outcome: "SUCCESS",
            actorKey: `user:${actor.userId}`,
            actorUserId: actor.userId,
            actorUserIdSnapshot: actor.userId,
            metadata: {},
          },
        });
      });
    },
    async exchange(raw: z.input<typeof deviceExchangeInput>, mint: Mint) {
      const input = deviceExchangeInput.parse(raw);
      const digest = digestDeviceCode(input.deviceCode);
      const result = await transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM device_code WHERE "deviceCodeDigest" = ${digest} FOR UPDATE`;
        const code = await tx.deviceCode.findUnique({ where: { deviceCodeDigest: digest } });
        const intent = await tx.deviceApproval.findUnique({ where: { deviceCodeDigest: digest } });
        const error = (code: PollError) => ({ error: code }) as const;
        if (!code || intent?.consumedAt) return error("invalid_grant");
        if (code.expiresAt <= now() || (intent && intent.expiresAt <= now()))
          return error("expired_token");
        if (code.status === "denied" || intent?.decision === "denied")
          return error("access_denied");
        if (
          code.lastPolledAt &&
          now().getTime() - code.lastPolledAt.getTime() < (code.pollingInterval ?? 5000)
        )
          return error("slow_down");
        await tx.deviceCode.update({ where: { id: code.id }, data: { lastPolledAt: now() } });
        if (code.status === "pending") return error("authorization_pending");
        if (
          code.status !== "approved" ||
          !intent ||
          intent.decision !== "approved" ||
          !intent.approvedAt ||
          !intent.userId ||
          code.userId !== intent.userId ||
          code.clientId !== intent.clientId ||
          code.userCode !== intent.userCode ||
          intent.resource !== resource ||
          !intent.patExpiresAt ||
          intent.patExpiresAt <= now()
        )
          return error("invalid_grant");
        const selected = deviceSelection.parse(intent.selection);
        assertRecipientBinding(code.recipientKey, selected);
        await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${intent.userId} FOR UPDATE`;
        try {
          await assertConsentIdentity(tx, intent.userId);
          await assertLiveConsentSelection(tx, intent.userId, selected, now());
        } catch (cause) {
          if (!(cause instanceof McpConsentError)) throw cause;
          await tx.deviceApproval.update({
            where: { id: intent.id },
            data: { decision: "denied" },
          });
          return error("access_denied");
        }
        const minted = await mint(tx, intent.userId, selected, input.name, intent.patExpiresAt);
        for (const r of selected.recipients)
          await tx.sealedConsumerGrant.create({
            data: {
              namespace: r.namespace,
              recordId: r.recordId,
              consumerKind: "pat",
              consumerId: minted.grantId,
              grantId: minted.grantId,
              recipientKeyId: r.recipientKeyId,
              recipientPublicKey: r.recipientPublicKey,
              authorizerId: intent.userId,
              expiresAt: new Date(r.expiresAt),
            },
          });
        if (intent.expiresAt <= now() || code.expiresAt <= now())
          throw new DeviceApprovalError("expired_token");
        await tx.deviceApproval.update({ where: { id: intent.id }, data: { consumedAt: now() } });
        await tx.deviceCode.delete({ where: { id: code.id } });
        return {
          credentialId: minted.credentialId,
          userId: intent.userId,
          secret: minted.secret,
          expiresAt: minted.expiresAt.toISOString(),
          resource,
        };
      });
      if ("error" in result) throw new DeviceApprovalError(result.error);
      return result;
    },
  };
}

/** Provider hooks protect even direct auth.handler/auth.api invocation. The
 * built-in session issuer is closed; only app PAT exchange can consume codes. */
export function resolveDevicePlugins(options: {
  db: PrismaClient;
  baseUrl: string;
  webOrigin?: string;
  canonicalOrigin?: string;
}) {
  const service = createDeviceApprovalService({
    db: options.db,
    resource: canonicalMcpResource(options.canonicalOrigin ?? options.baseUrl),
  });
  const plugin = deviceAuthorization({
    expiresIn: "10m",
    interval: "5s",
    generateDeviceCode: () => randomBytes(32).toString("base64url"),
    validateClient: (id) => id === "kb-cli",
    verificationUri: new URL(`/${DEFAULT_LOCALE}/device`, options.webOrigin ?? options.baseUrl)
      .href,
    schema: { deviceCode: { fields: { deviceCode: "deviceCodeDigest" } } },
  });
  const field = plugin.schema.deviceCode.fields.deviceCode;
  const mapped = {
    ...plugin,
    schema: {
      deviceCode: {
        ...plugin.schema.deviceCode,
        fields: {
          ...plugin.schema.deviceCode.fields,
          deviceCode: {
            ...field,
            transform: {
              input: (value) => {
                if (typeof value !== "string") throw new Error("Invalid device storage input");
                return digestDeviceCode(value);
              },
            },
          },
        },
      },
    },
  } satisfies BetterAuthPlugin;
  const boundary = {
    id: "kb-device-authority",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/device" || ctx.path?.startsWith("/device/") === true,
          handler: createAuthMiddleware(async (ctx) => {
            ctx.setHeader("Cache-Control", "no-store");
            if (ctx.path === "/device/token") throw new APIError("NOT_FOUND");
            if (ctx.path === "/device/code") {
              const start = z
                .strictObject({
                  client_id: z.literal("kb-cli"),
                  scope: z.string().default("mcp:read"),
                })
                .safeParse(ctx.body);
              if (
                !start.success ||
                !/^(mcp:read|mcp:write)( (mcp:read|mcp:write))?$/.test(start.data.scope) ||
                new Set(start.data.scope.split(" ")).size !== start.data.scope.split(" ").length
              )
                throw new APIError("BAD_REQUEST");
              return { context: { body: start.data } };
            }
            const headers = new Headers(ctx.headers);
            headers.delete("authorization");
            const session = await getSessionFromCtx(
              { ...ctx, headers },
              { disableCookieCache: true },
            );
            if (!session) throw new APIError("UNAUTHORIZED");
            const actor = { userId: session.user.id, sessionId: session.session.id };
            try {
              if (ctx.path === "/device") {
                const origin = headers.get("origin");
                const trusted =
                  origin !== null &&
                  [
                    new URL(options.baseUrl).origin,
                    new URL(options.webOrigin ?? options.baseUrl).origin,
                  ].includes(origin);
                if (
                  (origin && !trusted) ||
                  (headers.get("sec-fetch-site") === "cross-site" && !trusted)
                )
                  throw new Error();
                return ctx.json(await service.claim(actor, String(ctx.query?.user_code ?? "")));
              }
              const origin = headers.get("origin");
              if (
                !origin ||
                ![
                  new URL(options.baseUrl).origin,
                  new URL(options.webOrigin ?? options.baseUrl).origin,
                ].includes(origin)
              )
                throw new Error();
              const body = z.strictObject({ userCode }).parse(ctx.body);
              const input = decisionInput.parse({
                userCode: body.userCode,
                nonce: headers.get("x-device-approval-nonce"),
              });
              if (ctx.path !== "/device/approve" && ctx.path !== "/device/deny") throw new Error();
              await service.decide(
                actor,
                input,
                ctx.path === "/device/approve" ? "approve" : "deny",
              );
              // Commit both app and plugin states atomically, then bypass the upstream non-atomic update.
              return ctx.json({ success: true });
            } catch {
              throw new APIError("FORBIDDEN", { message: "Device approval unavailable" });
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
  return [boundary, mapped] as const;
}
