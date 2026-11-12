import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));

import type { Context } from "../context";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("@knowledge-base/env/shared", () => ({
  env: { KB_MASTER_KEY: new Secret("test-master") },
}));
vi.mock("../lib/kb/runtime", () => ({ getKbRuntime: () => ({}) }));
vi.mock("../lib/kb/providers", async (original) => ({
  ...(await original<typeof import("../lib/kb/providers")>()),
  createProvider: vi.fn(),
  probeProvider: vi.fn(),
  revokeProvider: vi.fn(),
  listMyProviders: vi.fn(),
  listSystemProviders: vi.fn(),
}));

import {
  createProvider,
  listMyProviders,
  listSystemProviders,
  probeProvider,
} from "../lib/kb/providers";
import { embeddingProvidersRouter } from "./embedding-providers";

const input = {
  name: "Provider",
  endpointUrl: "https://example.com/exact",
  model: "m",
  dimensions: 2,
  apiKey: "fixture-key",
  idempotencyKey: "test",
};
const context = {
  session: { user: { id: "owner", role: "user", twoFactorEnabled: false } },
} as Context;
describe("human provider procedures", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects NUL as BAD_REQUEST before reaching admission or persistence", async () => {
    const client = createRouterClient(embeddingProvidersRouter, { context: () => context });
    for (const field of ["name", "model"]) {
      await expect(client.create({ ...input, [field]: "a\0b" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    const { name: _name, ...configuration } = input;
    await expect(
      client.probe({ ...configuration, providerId: "p".repeat(24), model: "a\0b" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createProvider).not.toHaveBeenCalled();
    expect(probeProvider).not.toHaveBeenCalled();
  });
  it("denies anonymous calls on every procedure and exposes no attach or secret read", async () => {
    const client = createRouterClient(embeddingProvidersRouter, {
      context: () => ({ session: null }),
    });
    const providerId = "p".repeat(24);
    for (const call of [
      () => client.create(input),
      () => client.probe({ ...(({ name: _name, ...rest }) => rest)(input), providerId }),
      () => client.listMine({}),
      () => client.revoke({ providerId }),
      () => client.listSystem(),
    ])
      await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(Object.keys(embeddingProvidersRouter).sort()).toEqual([
      "create",
      "listMine",
      "listSystem",
      "probe",
      "revoke",
    ]);
    expect(createProvider).not.toHaveBeenCalled();
  });
  it("uses session ownership and shared credential config; sanitizes internal exceptions", async () => {
    const client = createRouterClient(embeddingProvidersRouter, { context: () => context });
    vi.mocked(listMyProviders).mockResolvedValue({ items: [], nextCursor: null });
    expect(await client.listMine({})).toEqual({ items: [], nextCursor: null });
    expect(listMyProviders).toHaveBeenCalledWith({}, "owner", { limit: 20 });
    vi.mocked(createProvider).mockRejectedValue(new Error("sensitive endpoint and key"));
    await expect(client.create(input)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Provider operation unavailable",
    });
    expect(createProvider).toHaveBeenCalledWith({}, "owner", input, "test-master");
  });

  it("every signed-in user can list the built-in system providers (no secret fields)", async () => {
    const client = createRouterClient(embeddingProvidersRouter, { context: () => context });
    const qwen = {
      providerId: "builtinembeddingmodel000",
      revision: 1,
      kind: "SYSTEM_BUILTIN" as const,
      name: "Qwen3-Embedding-0.6B (built-in)",
      model: "qwen3-embedding-0.6b-q8_0",
      dimensions: 1024,
      contextTokens: 1024,
      status: "ready" as const,
    };
    vi.mocked(listSystemProviders).mockResolvedValue({
      items: [{ ...qwen, endpointUrl: "x" }] as never,
    });
    const listed = await client.listSystem();
    expect(listed).toEqual({ items: [qwen] });
    expect(listSystemProviders).toHaveBeenCalledWith({}, "owner");
  });
});
