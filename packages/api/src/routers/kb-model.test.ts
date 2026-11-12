import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep();
  db.appSetting.findMany.mockResolvedValue([]);
  db.appSetting.findUnique.mockResolvedValue(null);
  return { default: db };
});
vi.mock("../lib/kb/runtime", () => ({
  getKbRuntime: () => ({ prisma: { fixture: true }, connectionString: "postgres://fixture" }),
}));
/** Real server-side gate over a fake authority transaction (row + captured writes). */
const tx = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  writes: [] as Array<{ sql: string; params: unknown[] }>,
}));
vi.mock("../lib/kb/authority-lock", () => ({
  runLockedOperation: (options: {
    run: (lease: {
      transaction: <T>(work: (query: unknown) => Promise<T>) => Promise<T>;
    }) => Promise<unknown>;
  }) =>
    options.run({
      transaction: (work) =>
        work(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM "user"'))
            return {
              rows: [
                {
                  banned: false,
                  banExpires: null,
                  twoFactorEnabled: true,
                  role: "admin",
                  emailVerified: true,
                  createdAt: new Date("2026-01-01T00:00:00Z"),
                },
              ],
              rowCount: 1,
            };
          if (/FOR UPDATE OF m/.test(sql)) return { rows: tx.row ? [tx.row] : [], rowCount: 1 };
          if (/^\s*(UPDATE|INSERT)/.test(sql)) tx.writes.push({ sql, params });
          return { rows: [], rowCount: 1 };
        }),
    }),
}));
vi.mock("../lib/kb/local-model", async (original) => ({
  ...(await original<typeof import("../lib/kb/local-model")>()),
  getLocalModelStatus: vi.fn(),
  countBuiltinAttachedKbs: vi.fn(),
  enableLocalModel: vi.fn(),
  disableLocalModel: vi.fn(),
}));

import { QWEN_MODEL } from "../lib/kb/builtin-model";
import {
  countBuiltinAttachedKbs,
  disableLocalModel,
  enableLocalModel,
  getLocalModelStatus,
  projectLocalModelStatus,
} from "../lib/kb/local-model";
import { qwenMemoryEstimate } from "../lib/kb/qwen-runtime-config";
import { kbModelRouter } from "./kb-model";

const admin = {
  session: {
    user: {
      id: "admin",
      role: "admin",
      emailVerified: true,
      twoFactorEnabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  },
} as unknown as Context;
const user = {
  session: {
    user: {
      id: "user",
      role: "user",
      emailVerified: true,
      twoFactorEnabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  },
} as unknown as Context;

describe("admin local model controls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is admin-only and hides its existence (404) from anonymous and ordinary users", async () => {
    for (const context of [{ session: null }, user]) {
      const client = createRouterClient(kbModelRouter, { context: () => context as Context });
      await expect(client.status()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.attachedKnowledgeBases()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.enable()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.disable()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.remove({ confirm: "REMOVE" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        client.setRuntimeConfig({ contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(enableLocalModel).not.toHaveBeenCalled();
    expect(disableLocalModel).not.toHaveBeenCalled();
    expect(tx.writes).toEqual([]);
    expect(countBuiltinAttachedKbs).not.toHaveBeenCalled();
    expect(Object.keys(kbModelRouter).sort()).toEqual([
      "attachedKnowledgeBases",
      "disable",
      "enable",
      "remove",
      "setRuntimeConfig",
      "status",
    ]);
  });

  it("reports actual status and never accepts a caller-selected URL or artifact", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    const status = projectLocalModelStatus(null);
    vi.mocked(getLocalModelStatus).mockResolvedValue({
      ...status,
      leaked: "secret",
    } as never);
    const result = await client.status();
    expect(result).toEqual(status);
    expect(JSON.stringify(result)).not.toContain("secret");
    vi.mocked(enableLocalModel).mockResolvedValue({ ...status, state: "DOWNLOADING", epoch: 1 });
    await expect(
      // @ts-expect-error — URLs are not an allowed selector.
      client.enable({ url: "https://evil.example/model.gguf" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await client.enable();
    // The admin is the audited actor (model_enable); the input never selects an artifact.
    expect(enableLocalModel).toHaveBeenCalledWith(
      { prisma: { fixture: true }, connectionString: "postgres://fixture" },
      { userId: "admin" },
      undefined,
    );
    vi.mocked(disableLocalModel).mockResolvedValue({ ...status, state: "DISABLED", epoch: 2 });
    await expect(client.disable()).resolves.toMatchObject({ state: "DISABLED", epoch: 2 });
  });

  it("counts the knowledge bases the built-in model serves, for its confirmations", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    vi.mocked(countBuiltinAttachedKbs).mockResolvedValue(3);
    await expect(client.attachedKnowledgeBases()).resolves.toEqual({ count: 3 });
    expect(countBuiltinAttachedKbs).toHaveBeenCalledWith({ fixture: true });
  });

  it("maps storage failures to a generic unavailable error", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    vi.mocked(enableLocalModel).mockRejectedValue(new Error("pg: connection to 10.0.0.3 refused"));
    await expect(client.enable()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Model operation unavailable",
    });
  });
});

describe("admin runtime config gate (server-side WARN > 70%, BLOCK > 90%)", () => {
  const config8k = { contextTokens: 8192, kvKeyType: "f16", kvValueType: "f16" } as const;
  const need = qwenMemoryEstimate(config8k).bytes;
  function row(budgetBytes: number | null) {
    tx.row = {
      modelId: QWEN_MODEL.modelId,
      state: "DISABLED",
      epoch: 4,
      jobId: null,
      quotaReservationIds: [],
      jobState: null,
      contextTokens: 4096,
      kvKeyType: "f16",
      kvValueType: "f16",
      configEpoch: 2,
      memoryBudgetBytes: budgetBytes === null ? null : String(budgetBytes),
    };
    tx.writes = [];
  }
  beforeEach(() => {
    vi.mocked(getLocalModelStatus).mockResolvedValue(projectLocalModelStatus(null));
  });
  const configWrites = () =>
    tx.writes.filter((w) => /^\s*UPDATE/.test(w.sql) && w.sql.includes('"contextTokens"'));

  it("rejects a config estimated above 90% of the reported worker budget, even with acknowledgement", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    row(Math.floor(need / 0.95));
    await expect(
      client.setRuntimeConfig({ ...config8k, acknowledgeMemoryWarning: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: "MODEL_CONFIG_MEMORY_BLOCKED" } });
    expect(configWrites()).toEqual([]);
  });

  it("accepts a 70-90% config only with explicit acknowledgement", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    row(Math.floor(need / 0.8));
    await expect(client.setRuntimeConfig(config8k)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { code: "MODEL_CONFIG_NEEDS_ACKNOWLEDGEMENT" },
    });
    expect(configWrites()).toEqual([]);
    await expect(
      client.setRuntimeConfig({ ...config8k, acknowledgeMemoryWarning: true }),
    ).resolves.toMatchObject({ state: "DISABLED" });
    expect(configWrites()).toHaveLength(1);
    expect(configWrites()[0]!.params).toEqual(expect.arrayContaining([8192, "f16", "f16"]));
  });

  it("accepts a config at or below 70% without acknowledgement", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    row(Math.ceil(need / 0.5));
    await expect(client.setRuntimeConfig(config8k)).resolves.toMatchObject({ state: "DISABLED" });
    expect(configWrites()).toHaveLength(1);
  });

  it("fails closed when the worker has not reported a memory budget", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    row(null);
    await expect(
      client.setRuntimeConfig({ ...config8k, acknowledgeMemoryWarning: true }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: { code: "MODEL_MEMORY_BUDGET_UNKNOWN" },
    });
    expect(configWrites()).toEqual([]);
  });

  it("on a READY model the config is only queued for the worker's load probe: the active config is untouched", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    row(Math.ceil(need / 0.5));
    tx.row = { ...tx.row, state: "READY", jobId: "job-ready", probeEpoch: 4 };
    await expect(client.setRuntimeConfig(config8k)).resolves.toMatchObject({ state: "DISABLED" });
    // No write of the active config, no revision, no retarget/re-embed queue.
    expect(configWrites()).toEqual([]);
    expect(
      tx.writes.some((w) => /provider_revision|kb_qwen_reembed|knowledge_base/.test(w.sql)),
    ).toBe(false);
    const pending = tx.writes.filter((w) => w.sql.includes('"pendingContextTokens"'));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.params).toEqual(expect.arrayContaining([8192, "f16", "f16", 5]));
  });

  it("rejects values outside the decided sets before any transaction", async () => {
    const client = createRouterClient(kbModelRouter, { context: () => admin });
    row(64 * 1024 ** 3);
    for (const bad of [
      { ...config8k, contextTokens: 4000 },
      { ...config8k, kvKeyType: "f32" },
      { ...config8k, batchSize: 4096 },
    ])
      await expect(client.setRuntimeConfig(bad as never)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    expect(tx.writes).toEqual([]);
  });
});

describe("46r10 model selection", () => {
  const gemma = {
    modelId: "embeddinggemma-2-q8_0",
    contextTokens: 1024,
    kvKeyType: "f16",
    kvValueType: "f16",
  } as const;
  it("admin selection queues a different model before activation, ordinary users cannot select it", async () => {
    tx.row = {
      state: "READY",
      epoch: 3,
      jobId: "ready-job",
      jobState: "COMPLETE",
      quotaReservationIds: [],
      modelId: "qwen3-embedding-0.6b-q8_0",
      contextTokens: 1024,
      kvKeyType: "f16",
      kvValueType: "f16",
      configEpoch: 2,
      probeEpoch: 1,
      memoryBudgetBytes: String(4 * 1024 ** 3),
    };
    tx.writes = [];
    vi.mocked(getLocalModelStatus).mockResolvedValue(projectLocalModelStatus(null));
    await expect(
      createRouterClient(kbModelRouter, { context: () => user }).setRuntimeConfig(gemma),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.writes).toEqual([]);
    await createRouterClient(kbModelRouter, { context: () => admin }).setRuntimeConfig(gemma);
    expect(
      tx.writes.some((w) => w.sql.includes('"pendingModelId"') && w.params.includes(gemma.modelId)),
    ).toBe(true);
    expect(
      tx.writes.some((w) => /SET "modelId"|provider_revision|knowledge_base/.test(w.sql)),
    ).toBe(false);
  });
});
