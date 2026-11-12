import {
  assertLiveConsentSelection,
  credentialSelection,
  McpConsentError,
} from "@knowledge-base/auth/mcp-consent";
import { issueMcpGenerationClaims } from "@knowledge-base/auth/mcp-refresh";
import prisma from "@knowledge-base/db";
import type { KnowledgeBase, Prisma, SealedRecord, User } from "@knowledge-base/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { LockQuery } from "./kb/lock";
import type { KbWriteOperationContext } from "./kb/runtime";
import { updateGrant } from "./mcp-token-access";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const db = vi.mocked(prisma);
const tx = mockDeep<Prisma.TransactionClient>();
const now = new Date("2026-09-26T00:00:00Z");
const kbId = "a".repeat(24);
const recipient = {
  kbId,
  namespace: "cfd00cbf-feb7-4dcd-81db-69938c394d75",
  recordId: "bf9d9446-ef55-4d5b-8f4f-c4f6351b1111",
  recipientKeyId: "3a2aa717-f797-4b54-8be2-b7d161910444",
  recipientPublicKey: Buffer.alloc(32, 7).toString("base64"),
  expiresAt: "2026-09-27T00:00:00.000Z",
};
const other = { ...recipient, namespace: "afd00cbf-feb7-4dcd-81db-69938c394d75" };
const selection = credentialSelection.parse({
  scopes: ["mcp:read"],
  toolGroups: ["read", "sealed"],
  acl: [{ kbId, bits: ["read"] }],
  recipients: [recipient, other],
});
const record = (r: typeof recipient): SealedRecord =>
  mockDeep<SealedRecord>({
    namespace: r.namespace,
    recordId: r.recordId,
    ownerId: "user",
    kbId,
    revokedAt: null,
    ciphertext: "ciphertext",
  });

beforeEach(() => {
  mockReset(tx);
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected an interactive transaction");
    return run(tx);
  });
  tx.user.findUnique.mockResolvedValue(
    mockDeep<User>({ id: "user", twoFactorEnabled: true, banned: false, role: "user" }),
  );
  tx.appSetting.findMany.mockResolvedValue([]);
  tx.knowledgeBase.findMany.mockResolvedValue([
    mockDeep<KnowledgeBase>({ id: kbId, ownerId: "user", state: "ACTIVE" }),
  ]);
  tx.kbShare.findMany.mockResolvedValue([]);
  // Deliberately use a different order than the normalized selection.
  tx.sealedRecord.findMany.mockResolvedValue([record(recipient), record(other)]);
});

describe("live consent sealed-record batching", () => {
  it("loads all composite identities in one bounded query and matches unordered results", async () => {
    await expect(assertLiveConsentSelection(tx, "user", selection, now)).resolves.toBeUndefined();
    expect(tx.sealedRecord.findMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        OR: selection.recipients.map(({ namespace, recordId }) => ({ namespace, recordId })),
      },
      select: {
        namespace: true,
        recordId: true,
        ownerId: true,
        kbId: true,
        revokedAt: true,
        ciphertext: true,
      },
      take: 2,
    });
    expect(tx.sealedRecord.findUnique).not.toHaveBeenCalled();
  });

  it("preserves PostgreSQL UUID case equality and repeated records for different keys", async () => {
    const recipients = [
      { ...recipient, namespace: recipient.namespace.toUpperCase() },
      { ...recipient, recipientKeyId: other.namespace },
    ];
    tx.sealedRecord.findMany.mockResolvedValue([record(recipient)]);
    await expect(
      assertLiveConsentSelection(tx, "user", { ...selection, recipients }, now),
    ).resolves.toBeUndefined();
    expect(tx.sealedRecord.findMany).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "foreign owner", "foreign KB", "revoked", "no ciphertext"])(
    "rejects a %s record with the same consent error after one query",
    async (condition) => {
      const found = record(recipient);
      if (condition === "foreign owner") found.ownerId = "other";
      if (condition === "foreign KB") found.kbId = "b".repeat(24);
      if (condition === "revoked") found.revokedAt = now;
      if (condition === "no ciphertext") found.ciphertext = null;
      tx.sealedRecord.findMany.mockResolvedValue(
        condition === "missing" ? [record(other)] : [record(other), found],
      );
      await expect(assertLiveConsentSelection(tx, "user", selection, now)).rejects.toThrow(
        new McpConsentError(),
      );
      expect(tx.sealedRecord.findMany).toHaveBeenCalledTimes(1);
      expect(tx.sealedRecord.findUnique).not.toHaveBeenCalled();
    },
  );

  it("still rejects expired recipients, missing read ACLs and an unenrolled user", async () => {
    for (const input of [
      { ...selection, recipients: [{ ...recipient, expiresAt: now.toISOString() }] },
      { ...selection, acl: [] },
    ]) {
      await expect(assertLiveConsentSelection(tx, "user", input, now)).rejects.toThrow(
        McpConsentError,
      );
    }
    tx.user.findUnique.mockResolvedValue(mockDeep<User>({ twoFactorEnabled: false }));
    await expect(assertLiveConsentSelection(tx, "user", selection, now)).rejects.toThrow(
      McpConsentError,
    );
  });

  it("issues no sealed-record query without recipients or for malformed key/expiry input", async () => {
    await assertLiveConsentSelection(tx, "user", { ...selection, recipients: [] }, now);
    for (const patch of [{ recipientPublicKey: "bad" }, { expiresAt: "bad" }]) {
      await expect(
        assertLiveConsentSelection(
          tx,
          "user",
          { ...selection, recipients: [{ ...recipient, ...patch }] },
          now,
        ),
      ).rejects.toThrow(McpConsentError);
    }
    expect(tx.sealedRecord.findMany).not.toHaveBeenCalled();
  });
});

describe("OAuth claims require current-format stored consent", () => {
  const input = {
    referenceId: "a".repeat(64),
    grantId: "11111111-1111-4111-8111-111111111111",
    userId: "user",
    clientId: "client",
    resource: "https://kb.example.invalid/mcp",
    scopes: ["mcp:read"],
    grantType: "refresh_token",
    tokenScopes: ["mcp:read", "offline_access"],
    tokenExpiresAt: new Date(now.getTime() + 600_000),
  };

  it.each(["authorization_code", "refresh_token"])(
    "%s accepts kb_admin-bound creation and rejects unbound creation without changing grants",
    async (grantType) => {
      for (const toolGroups of [["read", "kb_admin"], ["read"]]) {
        const intent = mockDeep<Prisma.ConsentIntentGetPayload<{ include: { grant: true } }>>({
          userId: input.userId,
          clientId: input.clientId,
          resource: input.resource,
          approvedAt: now,
          expiresAt: input.tokenExpiresAt,
          scopes: ["mcp:read", "mcp:write", "offline_access"],
          selection: {
            scopes: ["mcp:read", "mcp:write", "offline_access"],
            toolGroups,
            acl: [],
            allowCreate: true,
            createdKbBits: ["read"],
          },
          grant: {
            id: input.grantId,
            kind: "OAUTH",
            userId: input.userId,
            clientId: input.clientId,
            revokedAt: null,
            scopes: ["mcp:read", "mcp:write", "offline_access"],
          },
        });
        tx.consentIntent.findUnique.mockResolvedValue(intent);
        const claims = issueMcpGenerationClaims(db, { ...input, grantType }, () => now);
        if (toolGroups.includes("kb_admin")) {
          await expect(claims).resolves.toEqual({ mcp_grant_id: input.grantId });
        } else {
          await expect(claims).rejects.toThrow();
        }
      }
      expect(tx.mcpGrant.create).not.toHaveBeenCalled();
      expect(tx.mcpGrant.update).not.toHaveBeenCalled();
      expect(tx.consentIntent.update).not.toHaveBeenCalled();
    },
  );
});

describe("grant edits and elevations require kb_admin for creation", () => {
  it.each([undefined, "1h"] as const)(
    "checks the complete next ceiling when duration is %s",
    async (duration) => {
      const context = mockDeep<KbWriteOperationContext>();
      const runtime = mockDeep<Parameters<typeof updateGrant>[0]>();
      runtime.coordinator.run.mockImplementation(async ({ run }) => run(context));
      const grantId = "11111111-1111-4111-8111-111111111111";
      for (const toolGroups of [["read"], ["read", "kb_admin"]]) {
        const statements: string[] = [];
        const query = (async (sql: string) => {
          statements.push(sql);
          if (sql.includes('FROM "mcp_grant" g')) {
            return {
              rows: [
                {
                  userId: "user",
                  kind: "OAUTH",
                  scopes: ["mcp:write"],
                  toolGroups,
                  allowCreate: true,
                  createdKbBits: ["read"],
                  revokedAt: null,
                  tokenId: null,
                  tokenRevokedAt: null,
                  tokenExpiresAt: null,
                },
              ],
              rowCount: 1,
            };
          }
          return {
            rows: [{ id: "user", banned: false, twoFactorEnabled: true, role: "user" }],
            rowCount: 1,
          };
        }) as LockQuery;
        context.lease.transaction.mockImplementation(async (run) => run(query));
        // Reasserting the existing created bits makes a valid no-op edit. It
        // must not grandfather an inconsistent stored ceiling, even temporarily.
        const result = updateGrant(runtime, "user", {
          id: grantId,
          createdKbBits: ["read"],
          ...(duration ? { duration } : {}),
        });
        if (toolGroups.includes("kb_admin")) {
          await expect(result).resolves.toEqual({ id: grantId, widened: false, narrowed: false });
        } else {
          await expect(result).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        }
        expect(statements.every((sql) => sql.trimStart().startsWith("SELECT"))).toBe(true);
      }
    },
  );
});
