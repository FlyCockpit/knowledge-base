import { describe, expect, it, vi } from "vitest";
import { GEMMA_MODEL, QWEN_MODEL } from "./builtin-model";
import { builtinRuntimeEstimates } from "./builtin-registry";
import { qwenEmbeddingFingerprint, qwenModelIdentity } from "./fingerprint";
import {
  ensureSystemBuiltinProvider,
  localModelStatusSchema,
  MODEL_ERROR_CODES,
  modelDownloadDesiredSchema,
  projectLocalModelStatus,
  QWEN_MODEL_ID,
  readReadyModelRuntime,
  SYSTEM_BUILTIN_PROVIDER_ID,
  setModelRuntimeConfigInputSchema,
} from "./local-model";
import type { LockQuery } from "./lock";
import { QWEN_ARTIFACT } from "./model-artifact";
import { DEFAULT_QWEN_RUNTIME_CONFIG } from "./qwen-runtime-config";

const sql = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  seen: [] as string[],
}));
vi.mock("pg", () => ({
  Client: class {
    on() {
      return this;
    }
    removeListener() {
      return this;
    }
    async connect() {}
    async end() {}
    async query(input: string | { text: string }) {
      const text = typeof input === "string" ? input : input.text;
      sql.seen.push(text);
      return { rows: text.includes("SELECT") ? sql.rows : [], rowCount: 1 };
    }
  },
}));

const base = {
  modelId: QWEN_MODEL.modelId,
  state: "DOWNLOADING" as const,
  epoch: 2,
  runtimeIdentity: qwenModelIdentity(),
  bytesDownloaded: 100n,
  errorCode: null,
  jobState: "RUNNING" as const,
  reservedBytes: BigInt(QWEN_ARTIFACT.sizeBytes),
};

describe("local model status projection", () => {
  it("absent row is DISABLED at epoch 0 and never executable", () => {
    expect(projectLocalModelStatus(null)).toEqual({
      modelId: GEMMA_MODEL.modelId,
      fileName: GEMMA_MODEL.fileName,
      sizeBytes: GEMMA_MODEL.sizeBytes,
      sha256: GEMMA_MODEL.sha256,
      state: "DISABLED",
      epoch: 0,
      bytesDownloaded: 0,
      totalBytes: GEMMA_MODEL.sizeBytes,
      progress: 0,
      errorCode: null,
      reservedBytes: 0,
      executable: false,
      runtime: {
        contextTokens: 1024,
        kvKeyType: "f16",
        kvValueType: "f16",
        batchTokens: 1024,
        flashAttention: true,
      },
      memory: { budgetBytes: null, availableBytes: null, source: null, reportedAt: null },
      peakRssBytes: null,
      estimates: builtinRuntimeEstimates(null),
      pendingConfig: null,
      configError: null,
      removalPending: false,
      reembed: { total: 0, done: 0, failed: 0, currentKbId: null },
    });
  });

  it("projects a pending config's probe state and the last rejected config; junk errors are dropped", () => {
    const cfg = { contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "q4_0" } as const;
    const at = (pending: Parameters<typeof projectLocalModelStatus>[0]) =>
      projectLocalModelStatus(pending);
    expect(
      at({
        ...base,
        state: "READY",
        pending: { modelId: QWEN_MODEL.modelId, config: cfg, probing: false, mode: null },
      }).pendingConfig,
    ).toEqual({ ...cfg, modelId: QWEN_MODEL.modelId, state: "queued", mode: null });
    expect(
      at({
        ...base,
        state: "READY",
        pending: { modelId: QWEN_MODEL.modelId, config: cfg, probing: true, mode: "EXCLUSIVE" },
      }).pendingConfig,
    ).toEqual({ ...cfg, modelId: QWEN_MODEL.modelId, state: "probing", mode: "exclusive" });
    expect(
      at({
        ...base,
        state: "READY",
        pending: { modelId: QWEN_MODEL.modelId, config: cfg, probing: true, mode: "SIDE_BY_SIDE" },
      }).pendingConfig,
    ).toEqual({ ...cfg, modelId: QWEN_MODEL.modelId, state: "probing", mode: "side-by-side" });
    const error = { code: "MODEL_CONFIG_PROBE_TIMEOUT", ...cfg, at: "2026-09-26T10:00:00.000Z" };
    expect(at({ ...base, state: "READY", configError: error }).configError).toEqual(error);
    expect(
      at({ ...base, state: "READY", configError: { ...error, code: "native detail" } }).configError,
    ).toBeNull();
  });

  it("projects the runtime config, reported budget, real peak and per-option estimates", () => {
    const budget = 8n * 1024n ** 3n;
    const status = projectLocalModelStatus({
      ...base,
      state: "READY",
      jobState: "COMPLETE",
      config: { contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "q8_0" },
      peakRssBytes: 2_100_000_000n,
      memoryBudgetBytes: budget,
      memoryAvailableBytes: 5n * 1024n ** 3n,
      memoryBudgetSource: "cgroup-v2",
      memoryReportedAt: new Date("2026-09-26T12:00:00.000Z"),
      reembed: { total: 3, done: 1, failed: 0, currentKbId: "k".repeat(24) },
    });
    expect(status.runtime).toMatchObject({ contextTokens: 8192, kvKeyType: "q8_0" });
    expect(status.memory).toEqual({
      budgetBytes: Number(budget),
      availableBytes: 5 * 1024 ** 3,
      source: "cgroup-v2",
      reportedAt: "2026-09-26T12:00:00.000Z",
    });
    expect(status.peakRssBytes).toBe(2_100_000_000);
    expect(status.estimates).toEqual(builtinRuntimeEstimates(Number(budget)));
    expect(status.reembed).toEqual({ total: 3, done: 1, failed: 0, currentKbId: "k".repeat(24) });
    // A free-form stored source never leaks through.
    expect(
      projectLocalModelStatus({ ...base, memoryBudgetSource: "/sys/fs/secret" }).memory.source,
    ).toBeNull();
  });

  it("a READY row from a different or unrecorded runtime remains nonexecutable", () => {
    for (const runtimeIdentity of [null, "old-native-runtime"]) {
      expect(projectLocalModelStatus({ ...base, state: "READY", runtimeIdentity }).executable).toBe(
        false,
      );
    }
    expect(projectLocalModelStatus({ ...base, state: "READY" }).executable).toBe(true);
  });

  it("bounds progress to [0,1] and reports reserved disk", () => {
    expect(projectLocalModelStatus(base)).toMatchObject({
      state: "DOWNLOADING",
      bytesDownloaded: 100,
      reservedBytes: QWEN_ARTIFACT.sizeBytes,
    });
    expect(projectLocalModelStatus(base).progress).toBeCloseTo(100 / QWEN_ARTIFACT.sizeBytes);
    expect(
      projectLocalModelStatus({ ...base, bytesDownloaded: BigInt(QWEN_ARTIFACT.sizeBytes) * 2n })
        .progress,
    ).toBe(1);
    expect(projectLocalModelStatus({ ...base, bytesDownloaded: -5n }).progress).toBe(0);
  });

  it("projects an exhausted or cancelled job under DOWNLOADING as FAILED with a fixed code", () => {
    for (const jobState of ["FAILED", "CANCELLED"] as const)
      expect(projectLocalModelStatus({ ...base, jobState })).toMatchObject({
        state: "FAILED",
        errorCode: "MODEL_DOWNLOAD_FAILED",
      });
    expect(projectLocalModelStatus({ ...base, jobState: "RETRY" }).state).toBe("DOWNLOADING");
  });

  it("never leaks a free-form error: unknown codes collapse to MODEL_DOWNLOAD_FAILED", () => {
    expect(
      projectLocalModelStatus({ ...base, state: "FAILED", errorCode: "ENOENT /secret/path" })
        .errorCode,
    ).toBe("MODEL_DOWNLOAD_FAILED");
    expect(
      projectLocalModelStatus({ ...base, state: "FAILED", errorCode: "MODEL_CHECKSUM_MISMATCH" })
        .errorCode,
    ).toBe("MODEL_CHECKSUM_MISMATCH");
    expect(MODEL_ERROR_CODES).toContain("MODEL_HOST_REJECTED");
  });

  it("only READY (verified artifact + verified runtime) is executable", () => {
    expect(
      projectLocalModelStatus({
        ...base,
        state: "READY",
        jobState: "COMPLETE",
        bytesDownloaded: BigInt(QWEN_ARTIFACT.sizeBytes),
        reservedBytes: 0n,
      }),
    ).toMatchObject({ state: "READY", progress: 1, executable: true });
    for (const state of ["DISABLED", "DOWNLOADING", "FAILED"] as const)
      expect(projectLocalModelStatus({ ...base, state }).executable).toBe(false);
    // An exhausted job under DOWNLOADING projects FAILED: never executable.
    expect(projectLocalModelStatus({ ...base, jobState: "FAILED" }).executable).toBe(false);
  });

  it("MODEL_RUNTIME_UNSUPPORTED is a fixed, projectable failure code", () => {
    expect(MODEL_ERROR_CODES).toContain("MODEL_RUNTIME_UNSUPPORTED");
    expect(
      projectLocalModelStatus({
        ...base,
        state: "FAILED",
        errorCode: "MODEL_RUNTIME_UNSUPPORTED",
      }),
    ).toMatchObject({ state: "FAILED", errorCode: "MODEL_RUNTIME_UNSUPPORTED", executable: false });
  });

  it("durable desired payload is IDs and epoch only", () => {
    expect(modelDownloadDesiredSchema.parse({ modelId: QWEN_MODEL_ID, epoch: 3 })).toEqual({
      modelId: QWEN_MODEL_ID,
      epoch: 3,
    });
    for (const bad of [
      { modelId: "other", epoch: 1 },
      { modelId: QWEN_MODEL_ID, epoch: 0 },
      { modelId: QWEN_MODEL_ID, epoch: 1, url: "https://evil.example" },
    ])
      expect(modelDownloadDesiredSchema.safeParse(bad).success).toBe(false);
  });
});

describe("readReadyModelRuntime", () => {
  const db = (rows: Array<Record<string, unknown>>, seen: string[] = []) => {
    sql.rows = rows;
    sql.seen = seen;
    return { connectionString: "postgresql://unused@localhost/unused" };
  };
  it("returns the READY epoch with its runtime config and null otherwise, filtering on state READY", async () => {
    const seen: string[] = [];
    expect(
      await readReadyModelRuntime(
        db(
          [
            {
              modelId: QWEN_MODEL_ID,
              runtimeIdentity: qwenModelIdentity(),
              epoch: 5,
              contextTokens: 8192,
              kvKeyType: "q8_0",
              kvValueType: "f16",
            },
          ],
          seen,
        ),
      ),
    ).toEqual({
      modelId: QWEN_MODEL_ID,
      epoch: 5,
      config: { contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "f16" },
    });
    expect(seen.some((text) => text.includes("state = 'READY'"))).toBe(true);
    expect(await readReadyModelRuntime(db([]))).toBeNull();
    // A stored config outside the decided sets never reaches the child.
    expect(
      await readReadyModelRuntime(
        db([
          {
            modelId: QWEN_MODEL_ID,
            runtimeIdentity: qwenModelIdentity(),
            epoch: 5,
            contextTokens: 4097,
            kvKeyType: "f16",
            kvValueType: "f16",
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("ensureSystemBuiltinProvider", () => {
  function fake(revisions: Array<{ version: number; fingerprint: string }>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("max(version)"))
        return {
          rows: [
            { version: revisions.length ? Math.max(...revisions.map((r) => r.version)) : null },
          ],
          rowCount: 1,
        };
      if (sql.includes("FROM provider_revision") && sql.includes("fingerprint = $2")) {
        const match = revisions
          .filter((r) => r.fingerprint === params[1])
          .sort((a, b) => b.version - a.version);
        return { rows: match.slice(0, 1), rowCount: match.length ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    return { query: query as unknown as LockQuery, calls };
  }
  const q8 = { contextTokens: 8192, kvKeyType: "q8_0", kvValueType: "q8_0" } as const;

  it("creates the ownerless SYSTEM_BUILTIN provider and revision 1 with the config's fingerprint and model identity", async () => {
    const { query, calls } = fake([]);
    expect(
      await ensureSystemBuiltinProvider(
        query,
        "job-1",
        DEFAULT_QWEN_RUNTIME_CONFIG,
        QWEN_MODEL.modelId,
      ),
    ).toBe(1);
    const provider = calls.find((c) => c.sql.includes("INSERT INTO embedding_provider"));
    expect(provider?.sql).toContain("NULL");
    expect(provider?.sql).toContain("'SYSTEM_BUILTIN'");
    expect(provider?.params[0]).toBe(SYSTEM_BUILTIN_PROVIDER_ID);
    expect(SYSTEM_BUILTIN_PROVIDER_ID).toMatch(/^[a-z0-9]{24}$/);
    const revision = calls.find((c) => c.sql.includes("INSERT INTO provider_revision"));
    // No credential ciphertext ever exists for the system provider.
    expect(revision?.sql).toContain("NULL,1,1,'system'");
    expect(revision?.params).toEqual(
      expect.arrayContaining([
        SYSTEM_BUILTIN_PROVIDER_ID,
        1,
        qwenEmbeddingFingerprint(DEFAULT_QWEN_RUNTIME_CONFIG),
        "job-1",
        qwenModelIdentity(),
      ]),
    );
  });

  it("reuses the revision of an identical fingerprint and appends one per new config (same job allowed)", async () => {
    const current = fake([
      { version: 3, fingerprint: qwenEmbeddingFingerprint(DEFAULT_QWEN_RUNTIME_CONFIG) },
    ]);
    expect(
      await ensureSystemBuiltinProvider(
        current.query,
        "job-2",
        DEFAULT_QWEN_RUNTIME_CONFIG,
        QWEN_MODEL.modelId,
      ),
    ).toBe(3);
    expect(current.calls.some((c) => c.sql.includes("INSERT INTO provider_revision"))).toBe(false);
    // A config change on the SAME READY epoch/job appends version 4.
    const changed = fake([
      { version: 3, fingerprint: qwenEmbeddingFingerprint(DEFAULT_QWEN_RUNTIME_CONFIG) },
    ]);
    expect(await ensureSystemBuiltinProvider(changed.query, "job-2", q8, QWEN_MODEL.modelId)).toBe(
      4,
    );
    // Switching back to an earlier config reuses its (older) revision.
    const back = fake([
      { version: 3, fingerprint: qwenEmbeddingFingerprint(DEFAULT_QWEN_RUNTIME_CONFIG) },
      { version: 4, fingerprint: qwenEmbeddingFingerprint(q8) },
    ]);
    expect(
      await ensureSystemBuiltinProvider(
        back.query,
        "job-2",
        DEFAULT_QWEN_RUNTIME_CONFIG,
        QWEN_MODEL.modelId,
      ),
    ).toBe(3);
  });
});

it("46r10 rejects an unknown durable model download and accepts registered Gemma", () => {
  expect(
    modelDownloadDesiredSchema.parse({ modelId: "embeddinggemma-2-q8_0", epoch: 1 }).modelId,
  ).toBe("embeddinggemma-2-q8_0");
  expect(
    modelDownloadDesiredSchema.safeParse({ modelId: "https://evil.invalid/model", epoch: 1 })
      .success,
  ).toBe(false);
});

it("requires model identity on estimates and pending status while retaining selected-model request edits", () => {
  const config = { contextTokens: 1024, kvKeyType: "f16", kvValueType: "f16" } as const;
  const status = projectLocalModelStatus({
    ...base,
    pending: { modelId: GEMMA_MODEL.modelId, config, probing: false, mode: null },
  });
  expect(status.modelId).toBe(QWEN_MODEL.modelId);
  expect(status.pendingConfig?.modelId).toBe(GEMMA_MODEL.modelId);
  expect(localModelStatusSchema.safeParse(status).success).toBe(true);
  expect(
    localModelStatusSchema.safeParse({
      ...status,
      estimates: status.estimates.map(({ modelId: _id, ...row }) => row),
    }).success,
  ).toBe(false);
  expect(
    localModelStatusSchema.safeParse({
      ...status,
      pendingConfig: { ...status.pendingConfig, modelId: undefined },
    }).success,
  ).toBe(false);
  expect(setModelRuntimeConfigInputSchema.safeParse(config).success).toBe(true);
});
