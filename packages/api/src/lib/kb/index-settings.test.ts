import { beforeEach, describe, expect, it, vi } from "vitest";
import { KbDomainError } from "./errors";
import { scheduleIndexBuild } from "./generations";
import {
  assertQuantizationChange,
  buildFailureOf,
  CHUNK_CEILING_SETTING_KEYS,
  type ChunkCeilings,
  chunkCeilingFrom,
  effectiveChunkLimit,
  getIndexSettings,
  INDEX_QUANTIZATIONS,
  indexSettingsRefusal,
  loadChunkCeilings,
  setChunkCeiling,
  setChunkCeilingInputSchema,
  setIndexChunkLimit,
  setIndexQuantization,
  validateChunkCeiling,
  validateChunkLimit,
} from "./index-settings";
import { KB_LIMITS } from "./limits";
import type { LockQuery } from "./lock";
import { findFinalizedReceiptForUpdate, recordFinalizedReceipt } from "./operation-intent";
import { authorize } from "./permissions";
import type { KbRuntimeConfig } from "./runtime";

vi.mock("./permissions", async (importActual) => ({
  ...(await importActual<typeof import("./permissions")>()),
  authorize: vi.fn(),
  sqlAuthorityStore: vi.fn(() => ({})),
}));
vi.mock("./generations", () => ({ scheduleIndexBuild: vi.fn() }));
vi.mock("./operation-intent", async (importActual) => ({
  ...(await importActual<typeof import("./operation-intent")>()),
  findFinalizedReceiptForUpdate: vi.fn(),
  recordFinalizedReceipt: vi.fn(),
}));

const BOUND = KB_LIMITS.indexChunkBound;
const DEFAULT = KB_LIMITS.indexChunksDefault;
const kbId = "k".repeat(24);

function refusalOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return indexSettingsRefusal(error);
  }
}

async function refusalOfAsync(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return indexSettingsRefusal(error);
  }
}

type FakeDb = {
  settings: Map<string, string>;
  kb: {
    quantization: string;
    indexChunkLimit: number | null;
    activeChunkCount: number | null;
    errorCode: string | null;
  };
  sql: string[];
  audits: unknown[][];
  receipts: Map<string, { requestHash: string; responseBody: unknown }>;
};

function fakeDb(overrides: Partial<FakeDb["kb"]> = {}): FakeDb & { query: LockQuery } {
  const db: FakeDb = {
    settings: new Map(),
    kb: {
      quantization: "BINARY_INT8_RESCORE",
      indexChunkLimit: null,
      activeChunkCount: null,
      errorCode: null,
      ...overrides,
    },
    sql: [],
    audits: [],
    receipts: new Map(),
  };
  const query = (async (text: string, values: unknown[] = []) => {
    db.sql.push(text);
    if (/FROM app_setting/.test(text)) {
      const keys = values[0] as string[];
      const rows = keys
        .filter((key) => db.settings.has(key))
        .map((key) => ({ key, value: db.settings.get(key) }));
      return { rows, rowCount: rows.length };
    }
    if (/INSERT INTO app_setting/.test(text)) {
      db.settings.set(values[0] as string, values[1] as string);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM knowledge_base k/.test(text)) return { rows: [{ ...db.kb }], rowCount: 1 };
    if (/SET "indexChunkLimit"/.test(text)) {
      db.kb.indexChunkLimit = values[1] as number | null;
      return { rows: [], rowCount: 1 };
    }
    if (/SET "indexQuantization"/.test(text)) {
      db.kb.quantization = values[1] as string;
      return { rows: [], rowCount: 1 };
    }
    if (/INSERT INTO "audit_event"/.test(text)) {
      db.audits.push(values);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL ${text}`);
  }) as LockQuery;
  return Object.assign(db, { query });
}

function runtimeFor(query: LockQuery): KbRuntimeConfig {
  return {
    ratePort: { consume: vi.fn(async () => ({ ok: true })) },
    coordinator: {
      run: ({ run }: { run: (ctx: unknown) => Promise<unknown> }) =>
        run({ lease: { transaction: (work: (q: LockQuery) => unknown) => work(query) } }),
    },
  } as unknown as KbRuntimeConfig;
}

/**
 * A transaction fake with rollback: every write (settings, KB row, audits, receipts)
 * made inside a callback that throws is discarded, like the real authority transaction.
 * Receipts live in the same fake store, so replay sees only committed operations.
 */
function txRuntime(db: ReturnType<typeof fakeDb>) {
  const consume = vi.fn(async () => ({ ok: true }));
  vi.mocked(findFinalizedReceiptForUpdate).mockImplementation(async (_query, where) => {
    const found = db.receipts.get(`${where.actorKey}|${where.operation}|${where.idempotencyKey}`);
    return (found ?? null) as Awaited<ReturnType<typeof findFinalizedReceiptForUpdate>>;
  });
  vi.mocked(recordFinalizedReceipt).mockImplementation(async (_query, input) => {
    db.receipts.set(`${input.actorKey}|${input.operation}|${input.idempotencyKey}`, {
      requestHash: input.requestHash,
      responseBody: input.responseBody,
    });
  });
  const runtime = {
    ratePort: { consume },
    coordinator: {
      run: ({ run }: { run: (ctx: unknown) => Promise<unknown> }) =>
        run({
          lease: {
            transaction: async (work: (q: LockQuery) => Promise<unknown>) => {
              const snapshot = {
                settings: new Map(db.settings),
                kb: { ...db.kb },
                audits: [...db.audits],
                receipts: new Map(db.receipts),
              };
              try {
                return await work(db.query);
              } catch (error) {
                db.settings = snapshot.settings;
                db.kb = snapshot.kb;
                db.audits = snapshot.audits;
                db.receipts = snapshot.receipts;
                throw error;
              }
            },
          },
        }),
    },
  } as unknown as KbRuntimeConfig;
  return { runtime, consume };
}

const actor = { principal: { kind: "browser" as const, userId: "owner" } };
const ceilings = (values: Partial<ChunkCeilings> = {}): ChunkCeilings => ({
  int8: Math.min(DEFAULT, BOUND.int8),
  binary_int8_rescore: Math.min(DEFAULT, BOUND.binary_int8_rescore),
  ...values,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authorize).mockResolvedValue({
    kbId,
    ownerId: "owner",
    state: "ACTIVE",
    bits: ["read", "propose", "write", "review", "manage"],
    principal: actor.principal,
  });
  vi.mocked(findFinalizedReceiptForUpdate).mockResolvedValue(null);
  vi.mocked(scheduleIndexBuild).mockResolvedValue({
    generationId: "g".repeat(24),
    jobId: "00000000-0000-4000-8000-000000000001",
    state: "PENDING",
  });
});

describe("bounds (decision 22)", () => {
  it("uses the measured per-quantization bounds even below the base default", () => {
    expect(BOUND).toEqual({ int8: 200_000, binary_int8_rescore: 400_000 });
    expect(DEFAULT).toBe(400_000);
  });
});

describe("admin ceiling", () => {
  it.each(INDEX_QUANTIZATIONS)("accepts bound[%s] and refuses bound+1, 0, non-integers", (q) => {
    expect(validateChunkCeiling(q, BOUND[q])).toBe(BOUND[q]);
    expect(refusalOf(() => validateChunkCeiling(q, BOUND[q] + 1))).toBe(
      "CHUNK_CEILING_ABOVE_BOUND",
    );
    expect(refusalOf(() => validateChunkCeiling(q, 0))).toBe("INVALID_AMOUNT");
    expect(refusalOf(() => validateChunkCeiling(q, -5))).toBe("INVALID_AMOUNT");
    expect(refusalOf(() => validateChunkCeiling(q, 1.5))).toBe("INVALID_AMOUNT");
    expect(refusalOf(() => validateChunkCeiling(q, Number.NaN))).toBe("INVALID_AMOUNT");
  });

  it("reads absent as the default and clamps a stored value above the bound", async () => {
    for (const q of INDEX_QUANTIZATIONS) {
      expect(chunkCeilingFrom(q, undefined)).toBe(Math.min(DEFAULT, BOUND[q]));
      expect(chunkCeilingFrom(q, "garbage")).toBe(Math.min(DEFAULT, BOUND[q]));
      expect(chunkCeilingFrom(q, String(BOUND[q] + 1))).toBe(BOUND[q]);
      expect(chunkCeilingFrom(q, "123")).toBe(123);
    }
    const db = fakeDb();
    db.settings.set(CHUNK_CEILING_SETTING_KEYS.int8, "9999999");
    db.settings.set(CHUNK_CEILING_SETTING_KEYS.binary_int8_rescore, "500000");
    expect(await loadChunkCeilings(db.query)).toEqual({
      int8: BOUND.int8,
      binary_int8_rescore: BOUND.binary_int8_rescore,
    });
  });

  it("upserts the setting and audits index_chunk_ceiling_set in the caller's transaction", async () => {
    const db = fakeDb();
    const view = await setChunkCeiling(
      db.query,
      { userId: "admin" },
      {
        quantization: "binary_int8_rescore",
        amount: 300_000,
      },
    );
    expect(db.settings.get(CHUNK_CEILING_SETTING_KEYS.binary_int8_rescore)).toBe("300000");
    expect(view.binary_int8_rescore).toEqual({
      ceiling: 300_000,
      bound: BOUND.binary_int8_rescore,
    });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]?.[2]).toBe("index_chunk_ceiling_set");
    expect(JSON.parse(String(db.audits[0]?.[10]))).toEqual({
      state: "binary_int8_rescore",
      amount: "300000",
    });
    const refused = fakeDb();
    expect(
      await refusalOfAsync(() =>
        setChunkCeiling(refused.query, { userId: "admin" }, { quantization: "int8", amount: 0 }),
      ),
    ).toBe("INVALID_AMOUNT");
    expect(refused.settings.size).toBe(0);
    expect(refused.audits).toHaveLength(0);
  });
});

describe("owner chunk limit", () => {
  it("refuses above min(ceiling, bound), accepts at it, and null resets", () => {
    const c = ceilings({ int8: DEFAULT, binary_int8_rescore: 300_000 });
    expect(validateChunkLimit(300_000, "binary_int8_rescore", c)).toBe(300_000);
    expect(refusalOf(() => validateChunkLimit(300_001, "binary_int8_rescore", c))).toBe(
      "CHUNK_LIMIT_ABOVE_CEILING",
    );
    expect(refusalOf(() => validateChunkLimit(DEFAULT + 1, "int8", c))).toBe(
      "CHUNK_LIMIT_ABOVE_CEILING",
    );
    // Even an unclamped caller-supplied ceiling cannot raise int8 above its bound.
    expect(validateChunkLimit(200_000, "int8", c)).toBe(200_000);
    expect(refusalOf(() => validateChunkLimit(200_001, "int8", c))).toBe(
      "CHUNK_LIMIT_ABOVE_CEILING",
    );
    expect(validateChunkLimit(null, "int8", c)).toBeNull();
    expect(refusalOf(() => validateChunkLimit(0, "int8", c))).toBe("INVALID_AMOUNT");
    expect(refusalOf(() => validateChunkLimit(10.5, "int8", c))).toBe("INVALID_AMOUNT");
  });

  it("writes under the configure_index_limit authority with the KB row locked", async () => {
    const db = fakeDb();
    db.settings.set(CHUNK_CEILING_SETTING_KEYS.binary_int8_rescore, "350000");
    const view = await setIndexChunkLimit(runtimeFor(db.query), actor, {
      kbId,
      amount: 350_000,
    });
    expect(vi.mocked(authorize).mock.calls[0]?.[0]).toMatchObject({
      operation: "configure_index_limit",
    });
    expect(db.sql.find((text) => /FROM knowledge_base k/.test(text))).toMatch(/FOR UPDATE OF k/);
    expect(view).toMatchObject({
      limit: 350_000,
      effectiveLimit: 350_000,
      maxLimit: 350_000,
    });
    expect(db.audits[0]?.[2]).toBe("index_chunk_limit_set");
    expect(JSON.parse(String(db.audits[0]?.[10]))).toEqual({ kbId, amount: "350000" });
    await setIndexChunkLimit(runtimeFor(db.query), actor, { kbId, amount: null });
    expect(db.kb.indexChunkLimit).toBeNull();
    expect(JSON.parse(String(db.audits[1]?.[10]))).toEqual({ kbId, amount: "default" });
    expect(
      await refusalOfAsync(() =>
        setIndexChunkLimit(runtimeFor(db.query), actor, { kbId, amount: 350_001 }),
      ),
    ).toBe("CHUNK_LIMIT_ABOVE_CEILING");
    expect(db.audits).toHaveLength(2);
  });

  it("propagates the owner-only denial without writing", async () => {
    const db = fakeDb();
    vi.mocked(authorize).mockRejectedValue(new KbDomainError("FORBIDDEN", "Forbidden"));
    await expect(
      setIndexChunkLimit(runtimeFor(db.query), actor, { kbId, amount: 10 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.sql).toHaveLength(0);
  });
});

describe("effective chunk limit", () => {
  it("is the min of limit (or default), ceiling and bound in every combination", () => {
    for (const q of INDEX_QUANTIZATIONS)
      for (const limit of [null, 1, DEFAULT - 1, DEFAULT + 1, BOUND[q], BOUND[q] + 1])
        for (const ceiling of [1, DEFAULT, BOUND[q], BOUND[q] * 2]) {
          const c = ceilings({ [q]: ceiling });
          expect(effectiveChunkLimit({ indexChunkLimit: limit }, q, c)).toBe(
            Math.min(limit ?? DEFAULT, ceiling, BOUND[q]),
          );
        }
  });
});

describe("quantization change", () => {
  const raised = ceilings({
    int8: BOUND.int8,
    binary_int8_rescore: BOUND.binary_int8_rescore,
  });

  it("refuses binary → int8 with a stored 300k limit until the owner lowers it", async () => {
    expect(
      refusalOf(() =>
        assertQuantizationChange(
          { indexChunkLimit: 300_000, activeChunkCount: null },
          "int8",
          raised,
        ),
      ),
    ).toBe("CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND");
    expect(() =>
      assertQuantizationChange(
        { indexChunkLimit: BOUND.int8, activeChunkCount: null },
        "int8",
        raised,
      ),
    ).not.toThrow();

    const db = fakeDb({ indexChunkLimit: 300_000 });
    for (const q of INDEX_QUANTIZATIONS)
      db.settings.set(CHUNK_CEILING_SETTING_KEYS[q], String(BOUND[q]));
    const input = {
      kbId,
      quantization: "int8" as const,
      idempotencyKey: "quantization-key-1",
      confirm: "RUN" as const,
    };
    expect(
      await refusalOfAsync(() => setIndexQuantization(runtimeFor(db.query), actor, input)),
    ).toBe("CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND");
    expect(scheduleIndexBuild).not.toHaveBeenCalled();
    expect(db.kb.quantization).toBe("BINARY_INT8_RESCORE");

    db.kb.indexChunkLimit = 200_000;
    const result = await setIndexQuantization(runtimeFor(db.query), actor, input);
    expect(result.state).toBe("PENDING");
    expect(db.kb.quantization).toBe("INT8");
    expect(scheduleIndexBuild).toHaveBeenCalledWith(db.query, kbId);
    expect(vi.mocked(authorize).mock.calls.at(-1)?.[0]).toMatchObject({ operation: "manage" });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]?.[1]).toBe(result.operationId);
    expect(db.audits[0]?.[2]).toBe("index_quantization_set");
    expect(JSON.parse(String(db.audits[0]?.[10]))).toEqual({ kbId, state: "int8" });
  });

  it("refuses when the active generation exceeds the new effective limit", async () => {
    expect(
      refusalOf(() =>
        assertQuantizationChange(
          { indexChunkLimit: null, activeChunkCount: BOUND.int8 + 1 },
          "int8",
          ceilings(),
        ),
      ),
    ).toBe("ACTIVE_INDEX_TOO_LARGE");
    expect(() =>
      assertQuantizationChange(
        { indexChunkLimit: null, activeChunkCount: BOUND.int8 },
        "int8",
        ceilings(),
      ),
    ).not.toThrow();
    const db = fakeDb({ indexChunkLimit: 100, activeChunkCount: 101 });
    expect(
      await refusalOfAsync(() =>
        setIndexQuantization(runtimeFor(db.query), actor, {
          kbId,
          quantization: "int8",
          idempotencyKey: "quantization-key-2",
          confirm: "RUN",
        }),
      ),
    ).toBe("ACTIVE_INDEX_TOO_LARGE");
    expect(scheduleIndexBuild).not.toHaveBeenCalled();
  });

  it("rejects float32 in both oRPC settings input schemas before storage", async () => {
    const db = fakeDb();
    await expect(
      setIndexQuantization(runtimeFor(db.query), actor, {
        kbId,
        quantization: "float32" as never,
        idempotencyKey: "unsupported-quantization",
        confirm: "RUN",
      }),
    ).rejects.toThrow();
    expect(
      setChunkCeilingInputSchema.safeParse({ quantization: "float32", amount: DEFAULT }).success,
    ).toBe(false);
    expect(db.sql).toHaveLength(0);
  });

  it("switches an unset limit to int8 only when the active index fits 200k", async () => {
    const db = fakeDb({ activeChunkCount: 200_001 });
    const runtime = runtimeFor(db.query);
    const input = {
      kbId,
      quantization: "int8" as const,
      idempotencyKey: "default-limit-switch",
      confirm: "RUN" as const,
    };
    expect(await refusalOfAsync(() => setIndexQuantization(runtime, actor, input))).toBe(
      "ACTIVE_INDEX_TOO_LARGE",
    );
    expect(db.kb.quantization).toBe("BINARY_INT8_RESCORE");
    expect(scheduleIndexBuild).not.toHaveBeenCalled();
    db.kb.activeChunkCount = 200_000;
    await setIndexQuantization(runtime, actor, input);
    expect(await getIndexSettings(runtime, actor, kbId)).toMatchObject({
      quantization: "int8",
      limit: null,
      effectiveLimit: 200_000,
    });
    expect(scheduleIndexBuild).toHaveBeenCalledWith(db.query, kbId);
  });

  it("requires RUN", async () => {
    const db = fakeDb();
    await expect(
      setIndexQuantization(runtimeFor(db.query), actor, {
        kbId,
        quantization: "int8",
        idempotencyKey: "quantization-key-3",
        confirm: "DELETE" as never,
      }),
    ).rejects.toThrow();
    expect(db.sql).toHaveLength(0);
  });
});

describe("settings view", () => {
  it("reports caps per quantization, owner capability and build failure", async () => {
    const db = fakeDb({ errorCode: "INDEX_CHUNK_LIMIT_EXCEEDED", activeChunkCount: 12 });
    db.settings.set(CHUNK_CEILING_SETTING_KEYS.int8, "600000");
    const view = await getIndexSettings(runtimeFor(db.query), actor, kbId);
    expect(view).toEqual({
      quantization: "binary_int8_rescore",
      limit: null,
      effectiveLimit: DEFAULT,
      maxLimit: DEFAULT,
      caps: { int8: BOUND.int8, binary_int8_rescore: DEFAULT },
      defaultLimit: DEFAULT,
      activeChunkCount: 12,
      canConfigureLimit: true,
      buildFailure: "CHUNK_LIMIT",
    });
    expect(vi.mocked(authorize).mock.calls[0]?.[0]).toMatchObject({ operation: "read" });
    vi.mocked(authorize).mockResolvedValue({
      kbId,
      ownerId: "owner",
      state: "ACTIVE",
      bits: ["read", "propose", "write", "review", "manage"],
      principal: { kind: "browser", userId: "manager" },
    });
    expect((await getIndexSettings(runtimeFor(db.query), actor, kbId)).canConfigureLimit).toBe(
      false,
    );
  });

  it("clamps the int8 default, maximum and legacy ceiling to 200k on read and reset", async () => {
    const db = fakeDb({ quantization: "INT8" });
    const runtime = runtimeFor(db.query);
    for (const stored of [undefined, "400000"]) {
      if (stored) db.settings.set(CHUNK_CEILING_SETTING_KEYS.int8, stored);
      expect(await getIndexSettings(runtime, actor, kbId)).toMatchObject({
        limit: null,
        effectiveLimit: 200_000,
        maxLimit: 200_000,
        caps: { int8: 200_000, binary_int8_rescore: 400_000 },
      });
    }
    expect(
      await refusalOfAsync(() => setIndexChunkLimit(runtime, actor, { kbId, amount: 200_001 })),
    ).toBe("CHUNK_LIMIT_ABOVE_CEILING");
    expect(await setIndexChunkLimit(runtime, actor, { kbId, amount: 200_000 })).toMatchObject({
      limit: 200_000,
      effectiveLimit: 200_000,
    });
    expect(await setIndexChunkLimit(runtime, actor, { kbId, amount: null })).toMatchObject({
      limit: null,
      effectiveLimit: 200_000,
    });
  });

  it("maps only the two explained build failures", () => {
    expect(buildFailureOf("INDEX_CHUNK_LIMIT_EXCEEDED")).toBe("CHUNK_LIMIT");
    expect(buildFailureOf("INDEX_DISK_FULL")).toBe("DISK_FULL");
    expect(buildFailureOf("INDEX_BUILD_FAILED")).toBeNull();
    expect(buildFailureOf(null)).toBeNull();
  });
});

describe("setQuantization retry and rollback", () => {
  const input = {
    kbId,
    quantization: "int8" as const,
    idempotencyKey: "quantization-replay-1",
    confirm: "RUN" as const,
  };

  it("replays an identical request from its receipt without a second schedule, charge or audit", async () => {
    const db = fakeDb();
    const { runtime, consume } = txRuntime(db);
    const first = await setIndexQuantization(runtime, actor, input);
    const replay = await setIndexQuantization(runtime, actor, input);
    expect(replay).toEqual(first);
    expect(scheduleIndexBuild).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(db.audits).toHaveLength(1);
    expect(db.receipts.size).toBe(1);
  });

  it("refuses the same key with a different payload as IDEMPOTENCY_MISMATCH", async () => {
    const db = fakeDb();
    const { runtime, consume } = txRuntime(db);
    await setIndexQuantization(runtime, actor, input);
    await expect(
      setIndexQuantization(runtime, actor, { ...input, quantization: "binary_int8_rescore" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect(db.kb.quantization).toBe("INT8");
    expect(scheduleIndexBuild).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(db.audits).toHaveLength(1);
  });

  it("rolls back the quantization write, receipt and audit when no build can be scheduled", async () => {
    const db = fakeDb();
    const { runtime } = txRuntime(db);
    vi.mocked(scheduleIndexBuild).mockResolvedValue(null);
    await expect(setIndexQuantization(runtime, actor, input)).rejects.toMatchObject({
      code: "INDEX_UNAVAILABLE",
    });
    // The UPDATE ran inside the transaction, and was discarded with it.
    expect(db.sql.some((text) => /SET "indexQuantization"/.test(text))).toBe(true);
    expect(db.kb.quantization).toBe("BINARY_INT8_RESCORE");
    expect(db.audits).toHaveLength(0);
    expect(db.receipts.size).toBe(0);
    // Nothing was finalized, so a retry with the same key runs for real.
    vi.mocked(scheduleIndexBuild).mockResolvedValue({
      generationId: "g".repeat(24),
      jobId: "00000000-0000-4000-8000-000000000001",
      state: "PENDING",
    });
    await expect(setIndexQuantization(runtime, actor, input)).resolves.toMatchObject({
      state: "PENDING",
    });
    expect(db.kb.quantization).toBe("INT8");
    expect(db.audits).toHaveLength(1);
  });
});
