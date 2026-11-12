import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { Context } from "../context";
import { KbDomainError } from "../lib/kb/errors";
import { requestIndexBuild } from "../lib/kb/generations";
import {
  getIndexSettings,
  readChunkCeilings,
  setChunkCeiling,
  setIndexChunkLimit,
  setIndexQuantization,
} from "../lib/kb/index-settings";
import { getIndexProfile } from "../lib/kb/index-status";
import { kbIndexRouter } from "./kb-index";

vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
vi.mock("../lib/kb/generations", () => ({ requestIndexBuild: vi.fn() }));
vi.mock("../lib/kb/index-status", () => ({ getIndexProfile: vi.fn() }));
vi.mock("../lib/kb/index-settings", async (importActual) => ({
  ...(await importActual<typeof import("../lib/kb/index-settings")>()),
  getIndexSettings: vi.fn(),
  setIndexQuantization: vi.fn(),
  setIndexChunkLimit: vi.fn(),
  readChunkCeilings: vi.fn(),
  setChunkCeiling: vi.fn(),
}));
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({}) }));
const kbId = "a".repeat(24);
const input = { kbId, confirm: "RUN" as const, idempotencyKey: "rebuild-key-00001" };
function client(authenticated = true) {
  const session = mockDeep<NonNullable<Context["session"]>>();
  session.user.id = "owner";
  session.user.twoFactorEnabled = true;
  session.user.banned = false;
  return createRouterClient(kbIndexRouter, {
    context: () => ({ session: authenticated ? session : null }),
  });
}
beforeEach(() => vi.resetAllMocks());
describe("index router", () => {
  it("requires authentication on every entry", async () => {
    await expect(client(false).status({ kbId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(false).profile({ kbId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(false).rebuild(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client(false).setProfile({ ...input, providerId: "b".repeat(24), revision: 1 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requestIndexBuild).not.toHaveBeenCalled();
    expect(getIndexProfile).not.toHaveBeenCalled();
  });
  it("requires RUN and delegates actor-bound durable creation", async () => {
    await expect(client().rebuild({ ...input, confirm: "DELETE" } as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(requestIndexBuild).not.toHaveBeenCalled();
    await client().rebuild(input);
    expect(requestIndexBuild).toHaveBeenCalledWith(
      {},
      { principal: { kind: "browser", userId: "owner" } },
      input,
    );
    vi.mocked(requestIndexBuild).mockRejectedValue(
      new KbDomainError("FORBIDDEN", "Provider not owned"),
    );
    await expect(
      client().setProfile({ ...input, providerId: "b".repeat(24), revision: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

const browser = { principal: { kind: "browser", userId: "owner" } };
const quantizationInput = {
  kbId,
  quantization: "int8" as const,
  idempotencyKey: "quantization-key-1",
  confirm: "RUN" as const,
};
const refusal = (reason: string) =>
  new KbDomainError("INVALID_ARGUMENT", "Index settings refused", undefined, { reason });

function adminClient(role: "admin" | "user") {
  const user = {
    id: "admin-user",
    email: "a@example.com",
    name: "A",
    emailVerified: true,
    role,
    twoFactorEnabled: true,
    image: null,
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  };
  return createRouterClient(kbIndexRouter, {
    context: () => ({ session: { user, session: { userId: user.id } } as never }),
  });
}

describe("index settings leaves (§1.9)", () => {
  it("requires authentication on every per-KB settings leaf", async () => {
    await expect(client(false).settings({ kbId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client(false).setQuantization(quantizationInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(client(false).setChunkLimit({ kbId, amount: 10 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(getIndexSettings).not.toHaveBeenCalled();
    expect(setIndexQuantization).not.toHaveBeenCalled();
    expect(setIndexChunkLimit).not.toHaveBeenCalled();
  });

  it("delegates with the browser actor; the service owns the KB authorization", async () => {
    await client().settings({ kbId });
    expect(getIndexSettings).toHaveBeenCalledWith({}, browser, kbId);
    await client().setQuantization(quantizationInput);
    expect(setIndexQuantization).toHaveBeenCalledWith({}, browser, quantizationInput);
    await client().setChunkLimit({ kbId, amount: null });
    expect(setIndexChunkLimit).toHaveBeenCalledWith({}, browser, { kbId, amount: null });
    vi.mocked(setIndexChunkLimit).mockRejectedValue(new KbDomainError("FORBIDDEN", "Forbidden"));
    await expect(client().setChunkLimit({ kbId, amount: 5 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    vi.mocked(setIndexQuantization).mockRejectedValue(new KbDomainError("FORBIDDEN", "Forbidden"));
    await expect(client().setQuantization(quantizationInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("requires RUN and a known quantization before any service call", async () => {
    await expect(
      client().setQuantization({ ...quantizationInput, confirm: "DELETE" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client().setQuantization({ ...quantizationInput, quantization: "int4" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(setIndexQuantization).not.toHaveBeenCalled();
  });

  it.each([
    "INVALID_AMOUNT",
    "CHUNK_LIMIT_ABOVE_CEILING",
    "CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND",
    "ACTIVE_INDEX_TOO_LARGE",
  ])("surfaces the %s refusal reason as BAD_REQUEST data", async (reason) => {
    vi.mocked(setIndexChunkLimit).mockRejectedValue(refusal(reason));
    vi.mocked(setIndexQuantization).mockRejectedValue(refusal(reason));
    await expect(client().setChunkLimit({ kbId, amount: 5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason },
    });
    await expect(client().setQuantization(quantizationInput)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      data: { reason },
    });
  });

  it("hides the admin ceiling leaves behind 404 for non-admins", async () => {
    await expect(client(false).chunkCeiling()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adminClient("user").chunkCeiling()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      adminClient("user").setChunkCeiling({ quantization: "int8", amount: 5 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(readChunkCeilings).not.toHaveBeenCalled();
    expect(setChunkCeiling).not.toHaveBeenCalled();
  });

  it("runs admin ceiling writes in the live-admin authority transaction", async () => {
    const { default: prisma } = await import("@knowledge-base/db");
    const db = prisma as unknown as {
      $transaction: ReturnType<typeof vi.fn>;
      $queryRaw: ReturnType<typeof vi.fn>;
      appSetting: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    };
    db.appSetting.findMany.mockResolvedValue([]);
    db.appSetting.findUnique.mockResolvedValue(null);
    db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    db.$queryRaw.mockResolvedValue([
      {
        role: "admin",
        emailVerified: true,
        banned: false,
        banExpires: null,
        twoFactorEnabled: true,
        createdAt: new Date(),
      },
    ]);
    await adminClient("admin").setChunkCeiling({ quantization: "int8", amount: 500_000 });
    expect(setChunkCeiling).toHaveBeenCalledWith(
      expect.any(Function),
      { userId: "admin-user" },
      {
        quantization: "int8",
        amount: 500_000,
      },
    );
    vi.mocked(setChunkCeiling).mockRejectedValue(refusal("CHUNK_CEILING_ABOVE_BOUND"));
    await expect(
      adminClient("admin").setChunkCeiling({ quantization: "int8", amount: 9_000_000 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { reason: "CHUNK_CEILING_ABOVE_BOUND" } });
    await adminClient("admin").chunkCeiling();
    expect(readChunkCeilings).toHaveBeenCalledWith(expect.any(Function));
  });
});
