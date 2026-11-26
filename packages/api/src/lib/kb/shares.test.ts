import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/env/server", () => ({
  env: { KB_MASTER_KEY: Buffer.from("a".repeat(32)).toString("base64") },
}));

const loadIdentity = vi.hoisted(() => vi.fn());

vi.mock("./permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./permissions")>();
  return {
    ...actual,
    prismaAuthorityStore: () => ({ loadIdentity, loadKb: vi.fn(), loadShare: vi.fn() }),
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
import {
  shareInvite,
  shareInviteCancel,
  shareInvitePreview,
  shareInviteResend,
  shareList,
  sharePendingList,
} from "./shares";

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

function runWith(query: ReturnType<typeof makeFakeQuery>) {
  coordinator.run.mockImplementationOnce(async (opts) => {
    await opts.barrier?.reauthorize?.({ query });
    await opts.barrier?.reservePublication?.({ query });
    return opts.run();
  });
}

const sqlOf = (query: ReturnType<typeof makeFakeQuery>) =>
  query.mock.calls.map(([sql]) => String(sql));

function paramsOf(query: ReturnType<typeof makeFakeQuery>, needle: string): unknown[] | undefined {
  const call = query.mock.calls.find(([sql]) => String(sql).includes(needle)) as
    | [string, unknown[]]
    | undefined;
  return call?.[1];
}

describe("shareInvite sign-up mode", () => {
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
  });

  it("records the server's sign-up mode in the queued email, identically for every address", async () => {
    const payloads: unknown[] = [];
    for (const email of ["known@example.com", "unknown@example.com"]) {
      let receiptRow: Record<string, unknown> | null = null;
      const query = makeFakeQuery([
        [
          'INSERT INTO "operation_intent"',
          () => {
            receiptRow = {
              requestHash: inviteHash({ kbId: "kb1", email, permissions: ["read"] }),
              phase: "FINALIZED",
              responseBody: { accepted: true, requestId: "x" },
            };
            return { rows: [] };
          },
        ],
        ['FROM "operation_intent"', () => ({ rows: receiptRow ? [receiptRow] : [] })],
      ]);
      runWith(query);
      await shareInvite(
        runtime,
        "owner",
        {
          kbId: "kb1",
          email,
          permissions: ["read"],
          idempotencyKey: "same-key",
          signupOpen: false,
        },
        MASTER_KEY,
      );
      const desired = JSON.parse(String(paramsOf(query, 'INSERT INTO "durable_job"')?.[3]));
      payloads.push({ ...desired, requestId: "<id>" });
    }
    expect(payloads[0]).toMatchObject({ template: "share_invite", signupOpen: false });
    expect(payloads[1]).toEqual(payloads[0]);
  });
});

describe("sharePendingList", () => {
  const ownerAuth = (ownerId: string, userId: string) => ({
    kbId: "kb1",
    ownerId,
    state: "ACTIVE" as const,
    bits: ["manage" as const],
    principal: { kind: "browser" as const, userId },
  });
  const row = (id: string, inviterUserId: string, createdAt: string) => ({
    id,
    createdAt: new Date(createdAt),
    canonicalEmail: `${id}@example.com`,
    inviterUserId,
    requestId: `req-${id}`,
    bits: ["write"],
    inviter: { name: `Name of ${inviterUserId}` },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockReset();
    prisma.shareInvitation.findMany.mockResolvedValue([
      row("inv2", "manager", "2026-02-02T00:00:00Z"),
      row("inv1", "other-manager", "2026-02-01T00:00:00Z"),
    ]);
  });

  it("lists only pending rows, newest first, bounded by the page size", async () => {
    authorizeMock.mockResolvedValue(ownerAuth("owner", "owner"));
    await sharePendingList(runtime, "owner", { kbId: "kb1", limit: 500 });
    const args = prisma.shareInvitation.findMany.mock.calls.at(-1)?.[0];
    expect(args).toMatchObject({
      where: { kbId: "kb1", acceptedAt: null, revokedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    // The projection never carries the address ciphertext.
    expect(args.select.emailCiphertext).toBeUndefined();
  });

  it("shows the address and link to the live owner and to the sender only", async () => {
    authorizeMock.mockResolvedValue(ownerAuth("owner", "owner"));
    const asOwner = await sharePendingList(runtime, "owner", { kbId: "kb1" });
    expect(asOwner.items.map((item) => [item.email, item.requestId, item.invitedByYou])).toEqual([
      ["inv2@example.com", "req-inv2", false],
      ["inv1@example.com", "req-inv1", false],
    ]);
    expect(asOwner.items[0]).toMatchObject({
      invitationId: "inv2",
      inviterName: "Name of manager",
      bits: expandBits(["write"]),
      sentAt: "2026-02-02T00:00:00.000Z",
    });

    authorizeMock.mockResolvedValue(ownerAuth("owner", "manager"));
    const asManager = await sharePendingList(runtime, "manager", { kbId: "kb1" });
    expect(asManager.items.map((item) => [item.email, item.requestId, item.invitedByYou])).toEqual([
      ["inv2@example.com", "req-inv2", true],
      [null, null, false],
    ]);
    // Other managers still see who sent it.
    expect(asManager.items[1]?.inviterName).toBe("Name of other-manager");
  });

  it("decides owner visibility from the final live authorization", async () => {
    authorizeMock
      .mockResolvedValueOnce(ownerAuth("former-owner", "former-owner"))
      .mockResolvedValueOnce(ownerAuth("new-owner", "former-owner"));
    const result = await sharePendingList(runtime, "former-owner", { kbId: "kb1" });
    expect(authorizeMock).toHaveBeenCalledTimes(2);
    expect(result.items.every((item) => item.email === null && item.requestId === null)).toBe(true);
  });

  it("refuses when manage is lost while the page is in flight", async () => {
    authorizeMock
      .mockResolvedValueOnce(ownerAuth("owner", "owner"))
      .mockRejectedValueOnce(new KbAdmissionError("FORBIDDEN", "revoked mid-read"));
    await expect(sharePendingList(runtime, "owner", { kbId: "kb1" })).rejects.toMatchObject({
      name: "KbAdmissionError",
    });
  });

  it("refuses a caller without manage before reading", async () => {
    authorizeMock.mockRejectedValueOnce(new KbAdmissionError("FORBIDDEN", "no manage"));
    await expect(sharePendingList(runtime, "reader", { kbId: "kb1" })).rejects.toMatchObject({
      name: "KbAdmissionError",
    });
    expect(prisma.shareInvitation.findMany).not.toHaveBeenCalled();
  });

  it("pages with a keyset cursor", async () => {
    authorizeMock.mockResolvedValue(ownerAuth("owner", "owner"));
    const first = await sharePendingList(runtime, "owner", { kbId: "kb1", limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe("2026-02-02T00:00:00.000Z\0inv2");
    await sharePendingList(runtime, "owner", { kbId: "kb1", limit: 1, cursor: first.nextCursor });
    expect(prisma.shareInvitation.findMany.mock.calls.at(-1)?.[0].where.OR).toEqual([
      { createdAt: { lt: new Date("2026-02-02T00:00:00Z") } },
      { createdAt: new Date("2026-02-02T00:00:00Z"), id: { lt: "inv2" } },
    ]);
  });
});

describe("shareInviteCancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue(undefined as never);
  });

  it("cancels this KB's pending invitation and audits it", async () => {
    const query = makeFakeQuery([
      [
        'FROM "share_invitation"',
        () => ({ rows: [{ id: "inv1", requestId: "req-1", inviterUserId: "owner" }] }),
      ],
    ]);
    runWith(query);
    await expect(
      shareInviteCancel(runtime, "manager", {
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
      }),
    ).resolves.toEqual({ cancelled: true });
    const lock = sqlOf(query).find((sql) => sql.includes('FROM "share_invitation"'));
    expect(lock).toContain('"acceptedAt" IS NULL AND "revokedAt" IS NULL');
    // The listed send pins the generation: a re-invite (new createdAt) is not this row.
    expect(lock).toContain('"createdAt" = $3::timestamptz');
    expect(paramsOf(query, 'FROM "share_invitation"')).toEqual([
      "inv1",
      "kb1",
      "2026-11-20T10:00:00.000Z",
    ]);
    expect(sqlOf(query).some((sql) => sql.includes('SET "revokedAt" = now()'))).toBe(true);
    expect(paramsOf(query, 'INSERT INTO "audit_event"')).toContain("share_invite_cancel");
    expect(ratePort.consume).toHaveBeenCalled();
    // Manage is checked under the authority barrier.
    expect(authorizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ kbId: "kb1", operation: "manage" }),
    );
  });

  it("answers NOT_FOUND for an accepted, cancelled or foreign invitation, writing nothing", async () => {
    const query = makeFakeQuery([['FROM "share_invitation"', () => ({ rows: [] })]]);
    runWith(query);
    await expect(
      shareInviteCancel(runtime, "manager", {
        kbId: "kb1",
        invitationId: "inv-other",
        sentAt: "2026-11-20T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqlOf(query).some((sql) => sql.includes('UPDATE "share_invitation"'))).toBe(false);
    expect(sqlOf(query).some((sql) => sql.includes("audit_event"))).toBe(false);
  });

  it("answers NOT_FOUND for an unreadable sentAt without querying the row", async () => {
    const query = makeFakeQuery([]);
    runWith(query);
    await expect(
      shareInviteCancel(runtime, "manager", {
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "not a date",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqlOf(query).some((sql) => sql.includes('FROM "share_invitation"'))).toBe(false);
  });

  it("refuses a caller without manage", async () => {
    authorizeMock.mockRejectedValueOnce(new KbAdmissionError("FORBIDDEN", "no manage"));
    const query = makeFakeQuery([]);
    runWith(query);
    await expect(
      shareInviteCancel(runtime, "reader", {
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ name: "KbAdmissionError" });
    expect(sqlOf(query).some((sql) => sql.includes("share_invitation"))).toBe(false);
  });
});

describe("shareInviteResend", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const pendingRow = () => ({ rows: [{ id: "inv1", requestId, inviterUserId: "owner" }] });

  beforeEach(() => {
    vi.clearAllMocks();
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue(undefined as never);
  });

  it("queues the email again for the same request id, without touching the invitation", async () => {
    const query = makeFakeQuery([['FROM "share_invitation"', pendingRow]]);
    runWith(query);
    await expect(
      shareInviteResend(runtime, "manager", {
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "r1",
        locale: "es-MX",
        signupOpen: true,
      }),
    ).resolves.toEqual({ resent: true });
    const params = paramsOf(query, 'INSERT INTO "durable_job"');
    expect(JSON.parse(String(params?.[3]))).toEqual({
      template: "share_invite",
      kbId: "kb1",
      requestId,
      origin: "https://kb.example.com",
      locale: "es-MX",
      signupOpen: true,
    });
    expect(String(params?.[1])).toContain(requestId);
    expect(sqlOf(query).some((sql) => sql.includes('UPDATE "share_invitation"'))).toBe(false);
    expect(paramsOf(query, 'INSERT INTO "audit_event"')).toContain("share_invite_resend");
    expect(ratePort.consume).toHaveBeenCalled();
  });

  it("answers NOT_FOUND for a non-pending invitation and queues nothing", async () => {
    const query = makeFakeQuery([['FROM "share_invitation"', () => ({ rows: [] })]]);
    runWith(query);
    await expect(
      shareInviteResend(runtime, "manager", {
        kbId: "kb1",
        invitationId: "gone",
        sentAt: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "r2",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqlOf(query).some((sql) => sql.includes("durable_job"))).toBe(false);
  });

  it("refuses with CONFLICT while the original sender can no longer manage", async () => {
    authorizeMock
      .mockResolvedValueOnce(undefined as never) // the caller, under the barrier
      .mockRejectedValueOnce(new KbAdmissionError("FORBIDDEN", "sender lost manage"));
    const query = makeFakeQuery([['FROM "share_invitation"', pendingRow]]);
    runWith(query);
    await expect(
      shareInviteResend(runtime, "manager", {
        kbId: "kb1",
        invitationId: "inv1",
        sentAt: "2026-11-20T10:00:00.000Z",
        idempotencyKey: "r3",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(sqlOf(query).some((sql) => sql.includes("durable_job"))).toBe(false);
  });
});

describe("shareInvitePreview", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const invite = {
    id: "inv1",
    kbId: "kb1",
    canonicalEmail: "ana@example.com",
    inviterUserId: "owner",
    bits: ["write"],
    inviter: { name: "Ana" },
    knowledgeBase: { name: "Team notes" },
  };
  const live = { banned: false, twoFactorSatisfied: true, instanceEnabled: true };
  const arrangeValid = () => {
    authorizeMock.mockReset();
    authorizeMock.mockResolvedValue(undefined as never);
    loadIdentity.mockResolvedValue(live);
    prisma.user.findUnique.mockResolvedValue({ email: "Ana@Example.com" });
    prisma.shareInvitation.findFirst.mockResolvedValue(invite);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    arrangeValid();
  });

  it("names the KB, the sender and the permissions for the invited account", async () => {
    await expect(shareInvitePreview(runtime, "ana", { requestId })).resolves.toEqual({
      kbId: "kb1",
      kbName: "Team notes",
      inviterName: "Ana",
      bits: expandBits(["write"]),
    });
    expect(prisma.shareInvitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { requestId, acceptedAt: null, revokedAt: null } }),
    );
    // The sender's live manage is what keeps the invitation acceptable.
    expect(authorizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: { kind: "browser", userId: "owner" },
        kbId: "kb1",
        operation: "manage",
      }),
    );
  });

  it("answers the same NOT_FOUND for every other case, so the id is no oracle", async () => {
    const cases: Array<() => void> = [
      // Unknown, accepted, cancelled or replaced request id.
      () => prisma.shareInvitation.findFirst.mockResolvedValue(null),
      // Someone else's address.
      () => prisma.user.findUnique.mockResolvedValue({ email: "mallory@example.com" }),
      () => prisma.user.findUnique.mockResolvedValue(null),
      // A banned or not-admissible identity.
      () => loadIdentity.mockResolvedValue({ ...live, banned: true }),
      () => loadIdentity.mockResolvedValue(null),
      // The sender lost manage, or the KB is gone.
      () => authorizeMock.mockRejectedValue(new KbAdmissionError("NOT_FOUND", "gone")),
      () => authorizeMock.mockRejectedValue(new KbAdmissionError("FORBIDDEN", "no manage")),
    ];
    const answers: unknown[] = [];
    for (const arrange of cases) {
      arrangeValid();
      arrange();
      const error = await shareInvitePreview(runtime, "caller", { requestId }).catch(
        (caught: unknown) => caught,
      );
      const { name, code, message } = error as { name: string; code: string; message: string };
      answers.push({ name, code, message });
    }
    expect(answers[0]).toEqual({ name: "KbDomainError", code: "NOT_FOUND", message: "Not found" });
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it("re-checks the recipient and the invitation after the reads (mid-read changes disclose nothing)", async () => {
    const midRead: Array<() => void> = [
      // Banned while the invitation was being read.
      () =>
        loadIdentity.mockResolvedValueOnce(live).mockResolvedValueOnce({ ...live, banned: true }),
      // Changed their email address meanwhile.
      () =>
        prisma.user.findUnique
          .mockResolvedValueOnce({ email: "Ana@Example.com" })
          .mockResolvedValueOnce({ email: "other@example.com" }),
      // Cancelled (or accepted) meanwhile.
      () =>
        prisma.shareInvitation.findFirst.mockResolvedValueOnce(invite).mockResolvedValueOnce(null),
      // Replaced by a fresh invitation row under the same request id lookup.
      () =>
        prisma.shareInvitation.findFirst
          .mockResolvedValueOnce(invite)
          .mockResolvedValueOnce({ ...invite, id: "inv2" }),
    ];
    for (const arrange of midRead) {
      arrangeValid();
      arrange();
      await expect(shareInvitePreview(runtime, "ana", { requestId })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Not found",
      });
    }
    // Unchanged: both reads agree and the preview is answered.
    vi.clearAllMocks();
    arrangeValid();
    await expect(shareInvitePreview(runtime, "ana", { requestId })).resolves.toMatchObject({
      kbName: "Team notes",
    });
    expect(loadIdentity).toHaveBeenCalledTimes(2);
    expect(prisma.shareInvitation.findFirst).toHaveBeenCalledTimes(2);
  });
});
