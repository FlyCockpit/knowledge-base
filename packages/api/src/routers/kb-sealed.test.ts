import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@knowledge-base/db/client";
import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import type { Context } from "../context";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep<PrismaClient>();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@knowledge-base/env/shared", () => ({
  env: { KB_MASTER_KEY: new Secret("fixture-master") },
}));
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({}) }));
vi.mock("../lib/kb/sealed-records", async (original) => ({
  ...(await original<typeof import("../lib/kb/sealed-records")>()),
  enrollSealedRecord: vi.fn(),
  grantSealedRecord: vi.fn(),
  revokeSealedRecord: vi.fn(),
  revokeSealedGrant: vi.fn(),
}));
vi.mock("../lib/kb/sealed-overview", async (original) => ({
  ...(await original<typeof import("../lib/kb/sealed-overview")>()),
  listSealedValues: vi.fn(),
  sealedValueUsage: vi.fn(),
  listSealedConsumers: vi.fn(),
}));

import { listSealedConsumers, listSealedValues, sealedValueUsage } from "../lib/kb/sealed-overview";
import { enrollSealedRecord, revokeSealedGrant } from "../lib/kb/sealed-records";
import { kbSealedRouter } from "./kb-sealed";

const input = {
  kbId: "a".repeat(24),
  namespace: randomUUID(),
  plaintext: "router-canary",
  idempotencyKey: randomUUID(),
};
const RID = randomUUID();
const context = {
  session: { user: { id: "owner", role: "user", twoFactorEnabled: true } },
  clientIp: undefined,
} as Context;
describe("human sealed controls", () => {
  beforeEach(() => vi.clearAllMocks());
  it("denies anonymous controls and exposes only enrollment, grant and revocation", async () => {
    const client = createRouterClient(kbSealedRouter, {
      context: () => ({ session: null, clientIp: undefined }),
    });
    const reference = `{{sealed:v1:knowledge_base:${input.namespace}:${randomUUID()}}}`;
    await expect(client.enroll(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client.revoke({ kbId: input.kbId, reference, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client.grant({
        kbId: input.kbId,
        reference,
        consumerKind: "pat",
        consumerId: randomUUID(),
        recipientKeyId: randomUUID(),
        recipientPublicKey: Buffer.alloc(32, 9).toString("base64"),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.list({ kbId: input.kbId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.usage({ kbId: input.kbId, recordIds: [RID] })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client.consumers({ kbId: input.kbId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      client.revokeGrant({
        kbId: input.kbId,
        reference,
        consumerKind: "pat",
        consumerId: randomUUID(),
        recipientKeyId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(Object.keys(kbSealedRouter).sort()).toEqual([
      "consumers",
      "enroll",
      "grant",
      "list",
      "revoke",
      "revokeGrant",
      "usage",
    ]);
    expect(enrollSealedRecord).not.toHaveBeenCalled();
    expect(listSealedValues).not.toHaveBeenCalled();
    expect(sealedValueUsage).not.toHaveBeenCalled();
    expect(listSealedConsumers).not.toHaveBeenCalled();
    expect(revokeSealedGrant).not.toHaveBeenCalled();
  });
  it("uses the browser principal and scrubs exception data", async () => {
    const client = createRouterClient(kbSealedRouter, { context: () => context });
    vi.mocked(enrollSealedRecord).mockRejectedValue(new Error(input.plaintext));
    await expect(client.enroll(input)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Sealed operation unavailable",
    });
    expect(enrollSealedRecord).toHaveBeenCalledWith(
      {},
      { kind: "browser", userId: "owner" },
      input,
      "fixture-master",
    );
  });
  it("passes the browser principal to every owner read and the single-approval revoke", async () => {
    const client = createRouterClient(kbSealedRouter, { context: () => context });
    const owner = { kind: "browser", userId: "owner" };
    vi.mocked(listSealedValues).mockResolvedValue({ items: [], nextCursor: null });
    vi.mocked(sealedValueUsage).mockResolvedValue({ complete: true, usage: [] });
    vi.mocked(listSealedConsumers).mockResolvedValue({ items: [], nextCursor: null });
    await expect(client.list({ kbId: input.kbId })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listSealedValues).toHaveBeenCalledWith({}, owner, { kbId: input.kbId, limit: 20 });
    await client.usage({ kbId: input.kbId, recordIds: [RID] });
    expect(vi.mocked(sealedValueUsage).mock.calls[0]?.slice(0, 3)).toEqual([
      {},
      owner,
      { kbId: input.kbId, recordIds: [RID] },
    ]);
    await client.consumers({ kbId: input.kbId, limit: 5 });
    expect(listSealedConsumers).toHaveBeenCalledWith({}, owner, { kbId: input.kbId, limit: 5 });
    const revoke = {
      kbId: input.kbId,
      reference: `{{sealed:v1:knowledge_base:${input.namespace}:${randomUUID()}}}`,
      consumerKind: "pat" as const,
      consumerId: randomUUID(),
      recipientKeyId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    vi.mocked(revokeSealedGrant).mockRejectedValue(new Error(revoke.consumerId));
    await expect(client.revokeGrant(revoke)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Sealed operation unavailable",
    });
    expect(revokeSealedGrant).toHaveBeenCalledWith({}, owner, revoke);
  });
  it("rejects wildcard or extra fields on a single-approval revoke before any effect", async () => {
    const client = createRouterClient(kbSealedRouter, { context: () => context });
    const base = {
      kbId: input.kbId,
      reference: `{{sealed:v1:knowledge_base:${input.namespace}:${randomUUID()}}}`,
      consumerKind: "pat" as const,
      consumerId: randomUUID(),
      recipientKeyId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    await expect(client.revokeGrant({ ...base, consumerId: "*" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      client.revokeGrant({ ...base, recipientKeyId: "*" } as typeof base),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(client.revokeGrant({ ...base, all: true } as typeof base)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(revokeSealedGrant).not.toHaveBeenCalled();
  });
});
