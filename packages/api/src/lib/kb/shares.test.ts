import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/env/server", () => ({
  env: { KB_MASTER_KEY: Buffer.from("a".repeat(32)).toString("base64") },
}));

vi.mock("./permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./permissions")>();
  return {
    ...actual,
    authorize: vi.fn(async () => ({
      kbId: "kb1",
      ownerId: "owner",
      state: "ACTIVE" as const,
      bits: ["manage"] as const,
      principal: { kind: "browser" as const, userId: "owner" },
    })),
  };
});

import { canonicalRequestHash } from "./operation-intent";
import { expandBits } from "./permissions";
import { KbAdmissionError } from "./principal";
import { assertKbShareCapacityForNewActiveShare } from "./quota";
import type { KbRuntimeConfig } from "./runtime";
import { shareInvite, shareList } from "./shares";

const MASTER_KEY = Buffer.from("a".repeat(32)).toString("base64");

const prisma = {
  shareInvitation: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  kbShare: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  operationIntent: { findUnique: vi.fn() },
};

type QueryOverride = { rows: Record<string, unknown>[]; rowCount?: number };

/**
 * SQL-text dispatcher so barrier bodies can be driven without a database:
 * the first matching needle wins, and mutable state (receipt rows) is
 * shared between the insert and its reload.
 */
function makeFakeQuery(overrides: Array<[needle: string, impl: () => QueryOverride]>) {
  return vi.fn(async (sql: string): Promise<QueryOverride> => {
    for (const [needle, impl] of overrides) {
      if (sql.includes(needle)) return impl();
    }
    return { rows: [] };
  });
}

function inviteHash(input: { kbId: string; email: string; permissions: string[] }): string {
  return canonicalRequestHash({
    kbId: input.kbId,
    email: input.email,
    permissions: expandBits(input.permissions),
    idempotencyKey: "same-key",
  });
}

const coordinator = {
  run: vi.fn(
    async (opts: {
      barrier?: {
        reauthorize?: (ctx: { query: ReturnType<typeof makeFakeQuery> }) => Promise<void>;
        reservePublication?: (ctx: { query: ReturnType<typeof makeFakeQuery> }) => Promise<void>;
      };
      run: () => Promise<unknown>;
    }) => {
      const query = makeFakeQuery([]);
      await opts.barrier?.reauthorize?.({ query });
      await opts.barrier?.reservePublication?.({ query });
      return opts.run();
    },
  ),
};

const ratePort = { consume: vi.fn(async () => ({ ok: true as const })) };
const runtime = {
  prisma,
  coordinator,
  ratePort,
  canonicalOrigin: "https://kb.example.com",
} as unknown as KbRuntimeConfig;

const { authorize } = await import("./permissions");
const authorizeMock = vi.mocked(authorize);

describe("shareInvite idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue({
      kbId: "kb1",
      ownerId: "owner",
      state: "ACTIVE",
      bits: ["manage"],
      principal: { kind: "browser", userId: "owner" },
    });
    prisma.operationIntent.findUnique.mockResolvedValue(null);
  });

  it("replays a finalized receipt for known and unknown addresses identically", async () => {
    const hash = inviteHash({ kbId: "kb1", email: "any@example.com", permissions: ["read"] });
    const receiptQuery = makeFakeQuery([
      [
        'FROM "operation_intent"',
        () => ({
          rows: [
            {
              requestHash: hash,
              phase: "FINALIZED",
              responseBody: { accepted: true, requestId: "req-stable" },
            },
          ],
        }),
      ],
    ]);
    coordinator.run.mockImplementation(async (opts) => {
      await opts.barrier?.reauthorize?.({ query: receiptQuery });
      await opts.barrier?.reservePublication?.({ query: receiptQuery });
      return opts.run();
    });
    const known = await shareInvite(
      runtime,
      "owner-1",
      {
        kbId: "kb1",
        email: "any@example.com",
        permissions: ["read"],
        idempotencyKey: "same-key",
      },
      MASTER_KEY,
    );
    const unknown = await shareInvite(
      runtime,
      "owner-1",
      {
        kbId: "kb1",
        email: "any@example.com",
        permissions: ["read"],
        idempotencyKey: "same-key",
      },
      MASTER_KEY,
    );
    expect(known).toEqual({ accepted: true, requestId: "req-stable" });
    expect(unknown).toEqual(known);
    expect(coordinator.run).toHaveBeenCalledTimes(2);
    expect(authorizeMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a reused key with a different request body", async () => {
    const receiptQuery = makeFakeQuery([
      [
        'FROM "operation_intent"',
        () => ({
          rows: [
            {
              requestHash: "different-hash",
              phase: "FINALIZED",
              responseBody: { accepted: true, requestId: "req-old" },
            },
          ],
        }),
      ],
    ]);
    coordinator.run.mockImplementation(async (opts) => {
      await opts.barrier?.reauthorize?.({ query: receiptQuery });
      await opts.barrier?.reservePublication?.({ query: receiptQuery });
      return opts.run();
    });
    await expect(
      shareInvite(
        runtime,
        "owner-1",
        {
          kbId: "kb1",
          email: "any@example.com",
          permissions: ["read"],
          idempotencyKey: "same-key",
        },
        MASTER_KEY,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("returns the existing requestId for a live pending invitation, order-insensitively", async () => {
    let receiptRow: Record<string, unknown> | null = null;
    const query = makeFakeQuery([
      [
        'INSERT INTO "operation_intent"',
        () => {
          receiptRow = {
            requestHash: inviteHash({
              kbId: "kb1",
              email: "member@example.com",
              permissions: ["read", "propose"],
            }),
            phase: "FINALIZED",
            responseBody: { accepted: true, requestId: "11111111-1111-4111-8111-111111111111" },
          };
          return { rows: [] };
        },
      ],
      ['FROM "operation_intent"', () => ({ rows: receiptRow ? [receiptRow] : [] })],
      [
        'FROM "share_invitation"',
        () => ({
          rows: [
            {
              id: "inv-1",
              requestId: "11111111-1111-4111-8111-111111111111",
              inviterUserId: "owner-1",
              acceptedAt: null,
              revokedAt: null,
              bits: ["propose", "read"],
            },
          ],
        }),
      ],
    ]);
    coordinator.run.mockImplementationOnce(async (opts) => {
      await opts.barrier?.reauthorize?.({ query });
      await opts.barrier?.reservePublication?.({ query });
      return opts.run();
    });

    const result = await shareInvite(
      runtime,
      "owner-1",
      {
        kbId: "kb1",
        email: "member@example.com",
        permissions: ["read", "propose"],
        idempotencyKey: "same-key",
      },
      MASTER_KEY,
    );
    expect(result).toEqual({ accepted: true, requestId: "11111111-1111-4111-8111-111111111111" });
    // A re-send under a new key queues exactly one email for the same request.
    const emails = query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO "durable_job"'),
    );
    expect(emails).toHaveLength(1);
    expect(JSON.parse(String((emails[0] as unknown as [string, unknown[]])[1][3]))).toEqual({
      template: "share_invite",
      kbId: "kb1",
      requestId: "11111111-1111-4111-8111-111111111111",
      origin: "https://kb.example.com",
      locale: "en-US",
    });
    // No invitation mutation: only the receipt insert runs.
    const updates = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('UPDATE "share_invitation"'));
    expect(updates).toHaveLength(0);
  });

  it("supersedes a pending invitation whose inviter lost authority", async () => {
    authorizeMock.mockResolvedValueOnce(undefined as never); // reauthorize: caller passes
    authorizeMock.mockRejectedValueOnce(new KbAdmissionError("FORBIDDEN", "inviter lost manage"));
    let receiptRow: Record<string, unknown> | null = null;
    const requestHash = inviteHash({
      kbId: "kb1",
      email: "member@example.com",
      permissions: ["manage"],
    });
    const query = makeFakeQuery([
      [
        'INSERT INTO "operation_intent"',
        () => {
          receiptRow = {
            requestHash,
            phase: "FINALIZED",
            responseBody: { accepted: true, requestId: "req-fresh" },
          };
          return { rows: [] };
        },
      ],
      ['FROM "operation_intent"', () => ({ rows: receiptRow ? [receiptRow] : [] })],
      [
        'FROM "share_invitation"',
        () => ({
          rows: [
            {
              id: "inv-1",
              requestId: "req-dead",
              inviterUserId: "old-manager",
              acceptedAt: null,
              revokedAt: null,
              bits: ["read"],
            },
          ],
        }),
      ],
      ['UPDATE "share_invitation"', () => ({ rows: [], rowCount: 1 })],
    ]);
    coordinator.run.mockImplementationOnce(async (opts) => {
      await opts.barrier?.reauthorize?.({ query });
      await opts.barrier?.reservePublication?.({ query });
      return opts.run();
    });

    const result = await shareInvite(
      runtime,
      "owner-1",
      {
        kbId: "kb1",
        email: "member@example.com",
        permissions: ["manage"],
        idempotencyKey: "same-key",
      },
      MASTER_KEY,
    );
    expect(result.requestId).not.toBe("req-dead");
    const update = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('UPDATE "share_invitation"'));
    expect(update).toContain('"requestId" = $4');
  });
});

describe("shareList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue({
      kbId: "kb1",
      ownerId: "owner",
      state: "ACTIVE",
      bits: ["manage"],
      principal: { kind: "browser", userId: "owner" },
    });
    prisma.kbShare.findMany.mockResolvedValue([]);
  });

  it("never queries pending invitations", async () => {
    await shareList(runtime, "owner", { kbId: "kb1" });
    expect(prisma.kbShare.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null }),
      }),
    );
    expect(prisma.shareInvitation.findFirst).not.toHaveBeenCalled();
  });

  const adaRow = {
    id: "s1",
    userId: "member",
    bits: ["read"],
    includeSealedValues: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    user: { name: "Ada", email: "Ada@Example.com" },
  };
  const authorized = (ownerId: string, userId: string) => ({
    kbId: "kb1",
    ownerId,
    state: "ACTIVE",
    bits: ["manage"],
    principal: { kind: "browser", userId },
  });

  it("names members and shows invited addresses only to their inviter or the owner", async () => {
    prisma.kbShare.findMany.mockResolvedValue([adaRow]);
    prisma.shareInvitation.findMany.mockResolvedValue([
      { canonicalEmail: "ada@example.com", inviterUserId: "other-manager" },
    ]);
    const asOwner = await shareList(runtime, "owner", { kbId: "kb1" });
    expect(asOwner.items[0]).toMatchObject({ name: "Ada", invitedEmail: "ada@example.com" });
    expect(prisma.shareInvitation.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          kbId: "kb1",
          canonicalEmail: { in: ["ada@example.com"] },
          acceptedAt: { not: null },
        },
        take: 1,
      }),
    );
    // A manager who is not the owner sees only addresses they invited.
    authorizeMock.mockResolvedValue(authorized("owner", "manager"));
    const asManager = await shareList(runtime, "manager", { kbId: "kb1" });
    expect(asManager.items[0]).toMatchObject({ name: "Ada", invitedEmail: null });
    const asInviter = await shareList(runtime, "other-manager", { kbId: "kb1" });
    expect(asInviter.items[0]).toMatchObject({ invitedEmail: "ada@example.com" });
  });

  it("filters invited addresses by the final live owner, not the first check", async () => {
    prisma.kbShare.findMany.mockResolvedValue([adaRow]);
    prisma.shareInvitation.findMany.mockResolvedValue([
      { canonicalEmail: "ada@example.com", inviterUserId: "new-owner" },
    ]);
    // Ownership moves to new-owner between the two checks; the former owner
    // keeps manage, so the second check passes but they are no longer owner.
    authorizeMock.mockReset();
    authorizeMock
      .mockResolvedValueOnce(authorized("former-owner", "former-owner"))
      .mockResolvedValueOnce(authorized("new-owner", "former-owner"));
    const result = await shareList(runtime, "former-owner", { kbId: "kb1" });
    expect(authorizeMock).toHaveBeenCalledTimes(2);
    expect(result.items[0]).toMatchObject({ name: "Ada", invitedEmail: null });
    // The reverse transfer: a manager who became owner mid-read sees the address.
    authorizeMock
      .mockResolvedValueOnce(authorized("former-owner", "manager"))
      .mockResolvedValueOnce(authorized("manager", "manager"));
    const promoted = await shareList(runtime, "manager", { kbId: "kb1" });
    expect(promoted.items[0]).toMatchObject({ invitedEmail: "ada@example.com" });
  });

  it("rechecks manage authority after the page is loaded", async () => {
    authorizeMock.mockResolvedValueOnce({
      kbId: "kb1",
      ownerId: "owner",
      state: "ACTIVE",
      bits: ["manage"],
      principal: { kind: "browser", userId: "owner" },
    });
    authorizeMock.mockRejectedValueOnce(new KbAdmissionError("FORBIDDEN", "revoked mid-read"));
    await expect(shareList(runtime, "owner", { kbId: "kb1" })).rejects.toMatchObject({
      name: "KbAdmissionError",
    });
  });
});

describe("assertKbShareCapacityForNewActiveShare", () => {
  it("rejects a new active share at the per-KB limit", async () => {
    const query = makeFakeQuery([
      ['FROM "kb_share" WHERE "kbId" = $1 AND "userId" = $2', () => ({ rows: [] })],
      ["COUNT(*)", () => ({ rows: [{ count: "1024" }] })],
    ]);
    await expect(
      assertKbShareCapacityForNewActiveShare(query as never, "kb1", "member"),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("counts an update to an already-active share as no new slot", async () => {
    const query = makeFakeQuery([
      [
        'FROM "kb_share" WHERE "kbId" = $1 AND "userId" = $2',
        () => ({ rows: [{ revokedAt: null }] }),
      ],
    ]);
    await expect(
      assertKbShareCapacityForNewActiveShare(query as never, "kb1", "member"),
    ).resolves.toBeUndefined();
    const counted = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("COUNT"));
    expect(counted).toHaveLength(0);
  });

  it("allows a reactivation while under the limit", async () => {
    const query = makeFakeQuery([
      [
        'FROM "kb_share" WHERE "kbId" = $1 AND "userId" = $2',
        () => ({ rows: [{ revokedAt: new Date() }] }),
      ],
      ["COUNT(*)", () => ({ rows: [{ count: "3" }] })],
    ]);
    await expect(
      assertKbShareCapacityForNewActiveShare(query as never, "kb1", "member"),
    ).resolves.toBeUndefined();
  });
});
