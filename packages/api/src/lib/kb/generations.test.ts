import { describe, expect, it, vi } from "vitest";
import { EmbeddingUnavailableError } from "./embed-client";
import type { Embedder } from "./embedder";
import { embeddingFingerprint, qwenEmbeddingFingerprint, qwenModelIdentity } from "./fingerprint";
import {
  cancelIndexBuildJobs,
  fenceIndexAttempt,
  indexBuildSnapshotSchema,
  scheduleIndexBuild,
  selectIndexEmbedder,
  usableIndexProfile,
} from "./generations";
import { SYSTEM_BUILTIN_PROVIDER_ID } from "./local-model";
import type { LockQuery } from "./lock";
import { DEFAULT_QWEN_RUNTIME_CONFIG } from "./qwen-runtime-config";

vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
const snapshot = {
  generationId: "a".repeat(24),
  kbId: "b".repeat(24),
  epoch: "1",
  commitSha: "c".repeat(40),
  providerId: "d".repeat(24),
  revision: 1,
  ownerId: "owner",
  dimensions: 2,
  fingerprint: `sha256:${"e".repeat(64)}`,
  quantization: "binary_int8_rescore" as const,
};
const attempt = { jobId: "00000000-0000-4000-8000-000000000001", workerId: "worker", epoch: 2 };
describe("generation admission", () => {
  it("schedules a lexical-only generation when no provider is configured", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            epoch: "7",
            commitSha: snapshot.commitSha,
            providerId: null,
            revision: null,
            quantization: "binary_int8_rescore",
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const build = await scheduleIndexBuild(query as LockQuery, snapshot.kbId);
    expect(build).toMatchObject({ state: "PENDING" });
    expect(query.mock.calls[0]?.[0]).toContain('"desiredEpoch"+1');
    const sql = query.mock.calls.map((call) => String(call[0]));
    // The generation row pins no profile: providerId/version/fingerprint/dimensions stay NULL.
    const insert = sql.find((text) => text.includes("INSERT INTO index_generation"));
    expect(insert).toBeDefined();
    expect(insert).not.toContain('"providerId"');
    // The durable job carries the lexical snapshot.
    const desired = query.mock.calls
      .flatMap((call) => (call[1] as unknown[] | undefined) ?? [])
      .find((value) => typeof value === "string" && value.includes('"mode":"lexical"'));
    expect(desired).toBeDefined();
    expect(indexBuildSnapshotSchema.parse(JSON.parse(String(desired)))).toMatchObject({
      mode: "lexical",
      epoch: "7",
      kbId: snapshot.kbId,
    });
  });
  it("rejects a missing live attempt before any dependent row write", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(fenceIndexAttempt(query as LockQuery, snapshot, attempt)).rejects.toThrow("fence");
    expect(query.mock.calls[0]?.[0]).toContain("public.kb_lock_generation");
    expect(query.mock.calls[1]?.[0]).toContain('"leaseUntil">clock_timestamp()');
    expect(query.mock.calls[1]?.[1]).toEqual([
      attempt.jobId,
      attempt.workerId,
      2,
      snapshot.generationId,
    ]);
  });
  it("freezes the KB quantization in the build snapshot", async () => {
    expect(indexBuildSnapshotSchema.parse(snapshot).quantization).toBe("binary_int8_rescore");
    expect(() => indexBuildSnapshotSchema.parse({ ...snapshot, quantization: "bf16" })).toThrow();
    const { quantization: _, ...withoutQuantization } = snapshot;
    expect(() => indexBuildSnapshotSchema.parse(withoutQuantization)).toThrow();
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(scheduleIndexBuild(query as LockQuery, snapshot.kbId)).rejects.toThrow();
    expect(query.mock.calls[0]?.[0]).toContain(
      'lower(k."indexQuantization"::text) AS quantization',
    );
  });
});

describe("index build cancellation (§1.8 (d))", () => {
  /** Recording LockQuery: answers by statement shape, keeps every statement in order. */
  function recorder(ids: string[][] = [["r1", "r2"], []]) {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const query = vi.fn(async (text: string, params: unknown[] = []) => {
      statements.push(text);
      values.push(params);
      if (text.includes("transaction_isolation"))
        return { rows: [{ isolation: "read committed" }], rowCount: 1 };
      if (text.includes("FOR NO KEY UPDATE OF j"))
        return { rows: [{ id: "job-a" }, { id: "job-b" }], rowCount: 2 };
      if (text.includes('SELECT "quotaReservationIds" FROM index_generation'))
        return {
          rows: ids.map((each) => ({ quotaReservationIds: each })),
          rowCount: ids.length,
        };
      return { rows: [], rowCount: 0 };
    });
    return { query: query as unknown as LockQuery, statements, values };
  }
  const helperRegex =
    /kb_lock_generation|(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(public\.)?"?index_generation/;

  it("locks jobs, reads ids after the lock, releases, then cancels; never writes a generation", async () => {
    const { query, statements } = recorder();
    await expect(cancelIndexBuildJobs(query, { kbId: snapshot.kbId })).resolves.toEqual([
      "job-a",
      "job-b",
    ]);
    const at = (pattern: RegExp) => statements.findIndex((text) => pattern.test(text));
    const isolation = at(/transaction_isolation/);
    const lock = at(/FOR NO KEY UPDATE OF j/);
    const read = at(/SELECT "quotaReservationIds" FROM index_generation/);
    const release = at(/quota_reservation/);
    const cancel = at(/UPDATE durable_job SET state='CANCELLED'/);
    expect(isolation).toBe(0);
    expect(lock).toBeGreaterThan(isolation);
    expect(read).toBeGreaterThan(lock);
    expect(release).toBeGreaterThan(read);
    expect(cancel).toBeGreaterThan(release);
    expect(statements[lock]).toContain("ORDER BY j.id");
    for (const text of statements) expect(text).not.toMatch(helperRegex);
  });

  it("refuses to run outside READ COMMITTED", async () => {
    const query = vi.fn(async () => ({ rows: [{ isolation: "repeatable read" }], rowCount: 1 }));
    await expect(
      cancelIndexBuildJobs(query as unknown as LockQuery, { kbId: snapshot.kbId }),
    ).rejects.toThrow("READ COMMITTED");
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps each canceller's predicate and state list", async () => {
    const scopes = [
      [{ kbId: "k" }, /g\."kbId"=\$1 AND j\.state NOT IN \('COMPLETE','CANCELLED'\)/],
      [
        { providerOwnerId: "u", providerId: null },
        /p\."ownerId"=\$1 AND \(\$2::text IS NULL OR p\.id=\$2\) AND j\.state NOT IN \('COMPLETE','CANCELLED'\)/,
      ],
      [{ generationId: "g" }, /g\.id=\$1 AND j\.state NOT IN \('COMPLETE','CANCELLED'\)/],
      [
        { builtinFingerprintNot: "fp" },
        /p\.kind='SYSTEM_BUILTIN' AND g\.fingerprint<>\$1 AND \(g\.state IN \('PENDING','BUILDING','INDEXING'\) AND j\.state IN \('PENDING','PUBLISHED','RUNNING','RETRY'\)\)/,
      ],
    ] as const;
    for (const [scope, predicate] of scopes) {
      const { query, statements } = recorder([[]]);
      await cancelIndexBuildJobs(query, scope);
      expect(statements[1]).toMatch(predicate);
      // No reservation ids: nothing is released, the jobs are still cancelled.
      expect(statements.some((text) => text.includes("quota_reservation"))).toBe(false);
      expect(statements.at(-1)).toMatch(/UPDATE durable_job SET state='CANCELLED'/);
    }
  });

  it("does nothing when no job matches", async () => {
    const query = vi.fn(async (text: string) =>
      text.includes("transaction_isolation")
        ? { rows: [{ isolation: "read committed" }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    await expect(
      cancelIndexBuildJobs(query as unknown as LockQuery, { generationId: "g" }),
    ).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("SYSTEM_BUILTIN profile eligibility", () => {
  const qwenRow = {
    providerId: SYSTEM_BUILTIN_PROVIDER_ID,
    revision: 1,
    ownerId: null as string | null,
    dimensions: 1024,
    fingerprint: qwenEmbeddingFingerprint(DEFAULT_QWEN_RUNTIME_CONFIG),
    modelIdentity: qwenModelIdentity(),
    // The joined kb_local_model row: the CURRENT admin runtime config.
    currentContextTokens: 4096,
    currentKvKeyType: "f16",
    currentKvValueType: "f16",
    name: "Qwen",
    kind: "SYSTEM_BUILTIN" as const,
    model: "qwen3-embedding-0.6b-q8_0",
    endpointUrl: "builtin:qwen3-embedding-0.6b-q8_0",
  };
  function once(row: object | undefined) {
    return vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
  }

  it("the eligibility SQL admits SYSTEM_BUILTIN only while the local model is READY and ownerless", async () => {
    const query = once(qwenRow);
    await usableIndexProfile(query as unknown as LockQuery, SYSTEM_BUILTIN_PROVIDER_ID, 1, "build");
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/p\.kind='SYSTEM_BUILTIN' AND p\."ownerId" IS NULL/);
    expect(sql).toMatch(/kb_local_model m WHERE m\.id=\$3 AND m\.state='READY'/);
    // OpenAI providers keep their credential + completed probe requirements.
    expect(sql).toMatch(
      /p\.kind='OPENAI_COMPAT' AND r\.ciphertext IS NOT NULL AND j\.state='COMPLETE'/,
    );
  });

  it("a READY system Qwen revision is usable with no owner identity lookup", async () => {
    const query = once(qwenRow);
    await expect(
      usableIndexProfile(query as unknown as LockQuery, SYSTEM_BUILTIN_PROVIDER_ID, 1, "build"),
    ).resolves.toMatchObject({ kind: "SYSTEM_BUILTIN", ownerId: null, dimensions: 1024 });
    expect(query).toHaveBeenCalledOnce();
  });

  it("a revision built under OTHER build parameters is query-compatible but never buildable", async () => {
    const older = {
      ...qwenRow,
      fingerprint: qwenEmbeddingFingerprint({
        ...DEFAULT_QWEN_RUNTIME_CONFIG,
        contextTokens: 2048,
      }),
    };
    await expect(
      usableIndexProfile(
        once(older) as unknown as LockQuery,
        SYSTEM_BUILTIN_PROVIDER_ID,
        1,
        "query",
      ),
    ).resolves.toMatchObject({ kind: "SYSTEM_BUILTIN", buildCurrent: false });
    await expect(
      usableIndexProfile(
        once(older) as unknown as LockQuery,
        SYSTEM_BUILTIN_PROVIDER_ID,
        1,
        "build",
      ),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    // The current revision is both.
    await expect(
      usableIndexProfile(
        once(qwenRow) as unknown as LockQuery,
        SYSTEM_BUILTIN_PROVIDER_ID,
        1,
        "query",
      ),
    ).resolves.toMatchObject({ buildCurrent: true });
  });

  it("a model-identity change is never query-compatible", async () => {
    for (const row of [
      { ...qwenRow, modelIdentity: `sha256:${"1".repeat(64)}` },
      { ...qwenRow, modelIdentity: null },
    ])
      for (const purpose of ["query", "build"] as const)
        await expect(
          usableIndexProfile(
            once(row) as unknown as LockQuery,
            SYSTEM_BUILTIN_PROVIDER_ID,
            1,
            purpose,
          ),
        ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
  });

  it("rejects a stale runtime fingerprint for builds, an owned SYSTEM_BUILTIN row and an ownerless OpenAI row", async () => {
    await expect(
      usableIndexProfile(
        once({ ...qwenRow, fingerprint: `sha256:${"0".repeat(64)}` }) as unknown as LockQuery,
        SYSTEM_BUILTIN_PROVIDER_ID,
        1,
        "build",
      ),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    for (const row of [
      { ...qwenRow, ownerId: "user-1" },
      // Model READY but the joined current config is unreadable: fail closed.
      { ...qwenRow, currentContextTokens: null },
      {
        ...qwenRow,
        kind: "OPENAI_COMPAT",
        endpointUrl: "https://example.com/v1",
        fingerprint: embeddingFingerprint({
          endpointUrl: "https://example.com/v1",
          model: qwenRow.model,
          dimensions: 1024,
        }),
      },
      undefined,
    ])
      for (const purpose of ["query", "build"] as const)
        await expect(
          usableIndexProfile(
            once(row) as unknown as LockQuery,
            SYSTEM_BUILTIN_PROVIDER_ID,
            1,
            purpose,
          ),
        ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
  });
});

describe("index build embedder routing", () => {
  const qwen: Embedder = { embed: vi.fn() };
  const options = { connectionString: "x", masterKey: undefined };
  it("SYSTEM_BUILTIN builds use the worker's Qwen embedder, never the OpenAI adapter", () => {
    expect(
      selectIndexEmbedder({ kind: "SYSTEM_BUILTIN", ownerId: null }, snapshot, {
        ...options,
        qwenEmbedder: qwen,
      }),
    ).toBe(qwen);
  });
  it("SYSTEM_BUILTIN without a worker Qwen runtime is unavailable (the API server has none)", () => {
    expect(() =>
      selectIndexEmbedder({ kind: "SYSTEM_BUILTIN", ownerId: null }, snapshot, options),
    ).toThrow(EmbeddingUnavailableError);
  });
  it("OpenAI builds never receive the Qwen embedder and need a live owner", () => {
    const chosen = selectIndexEmbedder({ kind: "OPENAI_COMPAT", ownerId: "owner" }, snapshot, {
      ...options,
      qwenEmbedder: qwen,
    });
    expect(chosen).not.toBe(qwen);
    expect(() =>
      selectIndexEmbedder({ kind: "OPENAI_COMPAT", ownerId: null }, snapshot, options),
    ).toThrow(EmbeddingUnavailableError);
  });
});
