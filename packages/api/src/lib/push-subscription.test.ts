import { generateKeyPairSync } from "node:crypto";
import prisma, { type Prisma } from "@knowledge-base/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";

import {
  PUSH_SUBSCRIPTIONS_PER_USER,
  pushSubscriptionInputSchema,
  upsertPushSubscription,
} from "./push-subscription";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const db = vi.mocked(prisma);
const tx = mockDeep<Prisma.TransactionClient>();
const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
  format: "jwk",
});
const p256dh = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(publicKey.x ?? "", "base64url"),
  Buffer.from(publicKey.y ?? "", "base64url"),
]).toString("base64url");
const input = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
  keys: { p256dh, auth: Buffer.alloc(16, 0xfb).toString("base64url") },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockReset(tx);
  db.$transaction.mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected an interactive transaction");
    return run(tx);
  });
  tx.$queryRaw.mockResolvedValue([{ id: "user-1" }]);
  tx.pushSubscription.findUnique.mockResolvedValue(null);
  tx.pushSubscription.findMany.mockResolvedValue([]);
});

describe("pushSubscriptionInputSchema", () => {
  it("accepts browser-sized unpadded base64url keys and padded renewal keys", () => {
    expect(pushSubscriptionInputSchema.safeParse(input).success).toBe(true);
    expect(
      pushSubscriptionInputSchema.safeParse({
        ...input,
        keys: { p256dh: `${input.keys.p256dh}=`, auth: `${input.keys.auth}==` },
      }).success,
    ).toBe(true);
  });

  it.each([64, 66])("rejects a %i-byte public key", (size) => {
    const key = Buffer.alloc(size, 1);
    key[0] = 0x04;
    expect(
      pushSubscriptionInputSchema.safeParse({
        ...input,
        keys: { ...input.keys, p256dh: key.toString("base64url") },
      }).success,
    ).toBe(false);
  });

  it("rejects a public key without the uncompressed-point prefix", () => {
    expect(
      pushSubscriptionInputSchema.safeParse({
        ...input,
        keys: { ...input.keys, p256dh: Buffer.alloc(65, 2).toString("base64url") },
      }).success,
    ).toBe(false);
  });

  it.each([15, 17])("rejects a %i-byte auth secret", (size) => {
    expect(
      pushSubscriptionInputSchema.safeParse({
        ...input,
        keys: { ...input.keys, auth: Buffer.alloc(size).toString("base64url") },
      }).success,
    ).toBe(false);
  });

  it("accepts the service worker's padded standard-base64 renewal keys", () => {
    const standard = {
      p256dh: Buffer.from(input.keys.p256dh, "base64url").toString("base64"),
      auth: Buffer.alloc(16, 0xfb).toString("base64"),
    };
    expect(standard.auth).toMatch(/[+/]/);
    expect(pushSubscriptionInputSchema.safeParse({ ...input, keys: standard }).success).toBe(true);
  });

  it.each([" ", "\n", "\r", "\u2028", "\u2029", "!"])(
    "rejects invalid key character %j",
    (char) => {
      for (const key of ["p256dh", "auth"] as const) {
        expect(
          pushSubscriptionInputSchema.safeParse({
            ...input,
            keys: { ...input.keys, [key]: char + input.keys[key].slice(1) },
          }).success,
        ).toBe(false);
        expect(
          pushSubscriptionInputSchema.safeParse({
            ...input,
            keys: { ...input.keys, [key]: input.keys[key] + char },
          }).success,
        ).toBe(false);
      }
    },
  );

  it("rejects excess or incomplete padding", () => {
    for (const keys of [
      { ...input.keys, p256dh: `${input.keys.p256dh}==` },
      { ...input.keys, auth: `${input.keys.auth}=` },
      { ...input.keys, auth: `${input.keys.auth}===` },
      { ...input.keys, p256dh: `=${input.keys.p256dh.slice(1)}` },
      { ...input.keys, auth: `=${input.keys.auth.slice(1)}` },
    ]) {
      expect(pushSubscriptionInputSchema.safeParse({ ...input, keys }).success).toBe(false);
    }
  });

  it("accepts a 2048-character endpoint and rejects longer endpoints", () => {
    const endpoint = input.endpoint.padEnd(2048, "x");
    expect(pushSubscriptionInputSchema.safeParse({ ...input, endpoint }).success).toBe(true);
    expect(
      pushSubscriptionInputSchema.safeParse({ ...input, endpoint: `${endpoint}x` }).success,
    ).toBe(false);
  });

  it.each([
    "http://fcm.googleapis.com/push",
    "https://localhost/push",
    "https://127.0.0.1/push",
    "https://fcm.googleapis.com.attacker.test/push",
  ])("keeps the endpoint host allowlist for %s", (endpoint) => {
    expect(pushSubscriptionInputSchema.safeParse({ ...input, endpoint }).success).toBe(false);
  });
});

describe("upsertPushSubscription", () => {
  it("locks the user before reading and creates a subscription below the cap", async () => {
    await upsertPushSubscription("user-1", input);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledWith(
      ['SELECT id FROM "user" WHERE id = ', " FOR UPDATE"],
      "user-1",
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.pushSubscription.findUnique.mock.invocationCallOrder[0] ?? 0,
    );
    expect(tx.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: PUSH_SUBSCRIPTIONS_PER_USER - 1,
      take: PUSH_SUBSCRIPTIONS_PER_USER,
      select: { id: true },
    });
    expect(tx.pushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(tx.pushSubscription.create).toHaveBeenCalledWith({
      data: { endpoint: input.endpoint, ...input.keys, userId: "user-1" },
    });
    expect(db.pushSubscription.create).not.toHaveBeenCalled();
  });

  it("at the cap evicts the stalest subscriptions before creating, so renewal never fails", async () => {
    const row = (id: string) => ({
      id,
      userId: "user-1",
      endpoint: `${input.endpoint}/${id}`,
      ...input.keys,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    tx.pushSubscription.findMany.mockResolvedValue([row("stale-1"), row("stale-2")]);
    await upsertPushSubscription("user-1", input);
    expect(tx.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { in: ["stale-1", "stale-2"] } },
    });
    expect(tx.pushSubscription.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.pushSubscription.create.mock.invocationCallOrder[0] ?? 0,
    );
    expect(tx.pushSubscription.create).toHaveBeenCalledOnce();
  });

  it("refreshes the same user's existing endpoint at the cap without consuming a slot", async () => {
    tx.pushSubscription.findUnique.mockResolvedValue({
      id: "sub-1",
      userId: "user-1",
      endpoint: input.endpoint,
      ...input.keys,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await upsertPushSubscription("user-1", input);
    expect(tx.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(tx.pushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(tx.pushSubscription.update).toHaveBeenCalledWith({
      where: { endpoint: input.endpoint },
      data: input.keys,
    });
    expect(tx.pushSubscription.create).not.toHaveBeenCalled();
  });

  it.each(["P2002", "23505"])(
    "maps a concurrent registration's unique violation (%s) to CONFLICT",
    async (code) => {
      tx.pushSubscription.create.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed on endpoint"), { code }),
      );
      await expect(upsertPushSubscription("user-1", input)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    },
  );

  it("rethrows other storage errors unchanged", async () => {
    const failure = Object.assign(new Error("connection reset"), { code: "P1001" });
    tx.pushSubscription.create.mockRejectedValue(failure);
    await expect(upsertPushSubscription("user-1", input)).rejects.toBe(failure);
  });

  it("rejects another user's endpoint before evicting or writing", async () => {
    tx.pushSubscription.findUnique.mockResolvedValue({
      id: "sub-1",
      userId: "other-user",
      endpoint: input.endpoint,
      ...input.keys,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(upsertPushSubscription("user-1", input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(tx.pushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(tx.pushSubscription.create).not.toHaveBeenCalled();
    expect(tx.pushSubscription.update).not.toHaveBeenCalled();
  });
});
