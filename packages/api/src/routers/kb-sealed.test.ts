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
}));

import { enrollSealedRecord } from "../lib/kb/sealed-records";
import { kbSealedRouter } from "./kb-sealed";

const input = {
  kbId: "a".repeat(24),
  namespace: randomUUID(),
  plaintext: "router-canary",
  idempotencyKey: randomUUID(),
};
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
    expect(Object.keys(kbSealedRouter).sort()).toEqual(["enroll", "grant", "revoke"]);
    expect(enrollSealedRecord).not.toHaveBeenCalled();
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
});
