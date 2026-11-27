vi.mock("@knowledge-base/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

import type { PrismaClient } from "@knowledge-base/db/client";
import { beforeEach, expect, it, vi } from "vitest";
import { revokeCredentialsAfterPasswordReset } from "./credential-revocation";
import { createDeviceApprovalService } from "./device-approval";

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@knowledge-base/db", () => ({ default: db }));
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const now = new Date();
  const expiry = new Date(now.getTime() + 60_000);
  let codeLive = true;
  let minted = false;
  let revoked = false;
  let locks = 0;
  let tail = Promise.resolve();
  const tx = {
    $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
      if (sql.join("").includes("pg_advisory_xact_lock")) locks += 1;
      return 0;
    }),
    $executeRawUnsafe: vi.fn(async () => {
      if (minted) revoked = true;
      return 1;
    }),
    $queryRaw: vi.fn(async () => []),
    session: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    user: { findUnique: vi.fn(async () => ({ role: "user", twoFactorEnabled: true })) },
    appSetting: { findMany: vi.fn(async () => []) },
    knowledgeBase: { findMany: vi.fn(async () => []) },
    kbShare: { findMany: vi.fn(async () => []) },
    deviceCode: {
      findUnique: vi.fn(async () => {
        expect(locks).toBeGreaterThan(0);
        return codeLive
          ? {
              id: "code",
              status: "approved",
              expiresAt: expiry,
              userId: "user",
              clientId: "kb-cli",
              userCode: "ABCDEFGH",
              recipientKey: null,
            }
          : null;
      }),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => {
        codeLive = false;
      }),
      deleteMany: vi.fn(async () => {
        codeLive = false;
        return { count: 1 };
      }),
    },
    deviceApproval: {
      findUnique: vi.fn(async () => ({
        id: "approval",
        decision: "approved",
        approvedAt: now,
        userId: "user",
        clientId: "kb-cli",
        userCode: "ABCDEFGH",
        resource: "https://kb.invalid/mcp",
        patExpiresAt: expiry,
        expiresAt: expiry,
        selection: { scopes: ["mcp:read"], toolGroups: ["read"], acl: [] },
        consumedAt: null,
      })),
      update: vi.fn(async () => ({})),
    },
  };
  db.$transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => {
    const previous = tail;
    const done = Promise.withResolvers<void>();
    tail = done.promise;
    await previous;
    locks = 0;
    try {
      return await run(tx);
    } finally {
      done.resolve();
    }
  });
  const service = createDeviceApprovalService({
    db: db as unknown as PrismaClient,
    resource: "https://kb.invalid/mcp",
  });
  const exchange = (pause: () => Promise<void> = async () => {}) =>
    service.exchange({ deviceCode: "secret", name: "CLI" }, async () => {
      expect(locks).toBe(1);
      await pause();
      minted = true;
      return { credentialId: "token", grantId: "grant", secret: "pat", expiresAt: expiry };
    });
  return { exchange, state: () => ({ codeLive, minted, revoked }) };
}

it("device redemption holds revocation authority through mint/consume/commit; reset revokes its PAT", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exchange = f.exchange(async () => {
    entered.resolve();
    await release.promise;
  });
  await Promise.race([entered.promise, exchange]);
  const reset = revokeCredentialsAfterPasswordReset("user");
  expect(f.state().codeLive).toBe(true);
  release.resolve();
  await exchange;
  await reset;
  expect(f.state()).toEqual({ codeLive: false, minted: true, revoked: true });
});

it("reset cancels an approved device code before a waiting redemption can mint", async () => {
  const f = fixture();
  const reset = revokeCredentialsAfterPasswordReset("user");
  const exchange = f.exchange();
  await reset;
  await expect(exchange).rejects.toMatchObject({ code: "invalid_grant" });
  expect(f.state()).toEqual({ codeLive: false, minted: false, revoked: false });
});
