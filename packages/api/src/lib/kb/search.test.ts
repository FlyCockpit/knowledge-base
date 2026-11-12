import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexFileMissingError, KbDomainError } from "./errors";
import {
  configureIndexReader,
  type IndexReaderPool,
  resetIndexReaderForTests,
} from "./index-file/pool";
import type { HybridTaskResult, IndexCitationRow } from "./index-file/reader";

const pg = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(async () => {}),
  end: vi.fn(async () => {}),
}));
vi.mock("pg", () => ({
  Client: class {
    query = pg.query;
    connect = pg.connect;
    end = pg.end;
    on() {}
  },
}));
const leased = vi.hoisted(() => ({
  requestId: "00000000-0000-4000-8000-000000000000",
  generationId: "g".repeat(24),
  fingerprint: `sha256:${"f".repeat(64)}`,
  vector: [0.6, 0.8],
  pinned: false,
  index: {
    activeGenerationId: "g".repeat(24),
    freshness: "current",
    indexedCommitSha: "a".repeat(40),
    headSha: "a".repeat(40),
  },
}));
vi.mock("./query-embedding", () => ({
  QUERY_DEADLINE_MS: 60_000,
  withQueryEmbedding: vi.fn(
    async (
      _o: unknown,
      _a: unknown,
      _i: unknown,
      consume: (v: unknown, s: AbortSignal) => unknown,
    ) => consume(leased, new AbortController().signal),
  ),
}));
const { withQueryEmbedding } = await import("./query-embedding");
const { searchKnowledgeBase, SEARCH_DEFAULT_LIMIT } = await import("./search");

const kbId = "k".repeat(24);
const commitSha = "a".repeat(40);
const options = {
  connectionString: "postgres://unused",
  masterKey: undefined,
  ratePort: { consume: vi.fn() },
};
const actor = { principal: { kind: "browser" as const, userId: "reader" } };
const row = (path: string, id: number): IndexCitationRow => ({
  id,
  path,
  chunkIndex: 0,
  documentId: null,
  commitSha,
  blobSha: "b".repeat(40),
  contentHash: `sha256:${"c".repeat(64)}`,
  span: { startToken: 0, endToken: 2, startByte: 0, endByte: 9 },
  snippet: "alpha beta",
  documentCitations: [],
  assetRefs: [],
  rowIndex: -1,
  matchedRow: null,
});
const hybrid: HybridTaskResult = {
  vector: [{ id: 2, path: "b.md", chunkIndex: 0, score: 0.1 }],
  fts: [{ id: 1, path: "a.md", chunkIndex: 0, score: -1.5 }],
  rows: [row("a.md", 1), row("b.md", 2)],
};
const generation = {
  dimensions: 2,
  commitSha,
  name: "Fixture",
  fingerprint: leased.fingerprint,
  chunkCount: 2,
  documentCount: 2,
  state: "COMPLETE",
  active: true,
};

const read = vi.fn();
function fakePool(): IndexReaderPool {
  return {
    start: async () => {},
    stop: async () => {},
    read: read as unknown as IndexReaderPool["read"],
    stats: () => ({ threads: 1, busy: 0, largeRunning: 0, queued: 0, posted: 0 }),
    threadStats: async () => [],
  };
}
function database(overrides: { lease?: object | null; commit?: () => void } = {}) {
  pg.query.mockImplementation(async (sql: string) => {
    if (sql.includes("generation_lease"))
      return { rows: overrides.lease === null ? [] : [overrides.lease ?? generation] };
    if (sql === "COMMIT") overrides.commit?.();
    return { rows: [] };
  });
}
const statements = () => pg.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  vi.clearAllMocks();
  database();
  read.mockResolvedValue({ status: "ok", result: hybrid });
  configureIndexReader(fakePool());
});
afterEach(() => resetIndexReaderForTests());

describe("hybrid search service", () => {
  it("fuses both arms of the leased file into hybrid citations pinned to the generation", async () => {
    const result = await searchKnowledgeBase(options, actor, { kbId, query: "alpha" });
    expect(SEARCH_DEFAULT_LIMIT).toBe(6);
    expect(result).toMatchObject({
      generationId: leased.generationId,
      freshness: "current",
      indexedCommitSha: commitSha,
    });
    expect(result.results.map((h) => [h.path, h.score, h.mode, h.snippet])).toEqual([
      // L-25: first of one arm, absent from the other: half the two-arm maximum.
      ["a.md", 0.5, "hybrid", "alpha beta"],
      ["b.md", 0.5, "hybrid", "alpha beta"],
    ]);
    const sql = statements();
    expect(sql).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(sql.some((text) => /idle_in_transaction_session_timeout = \d+/.test(text))).toBe(true);
    const lease = sql.find((text) => text.includes("generation_lease"))!;
    // The generation row is held FOR KEY SHARE until the file read settled (§1.5).
    expect(lease).toContain("FOR KEY SHARE OF g");
    expect(sql.join("\n")).not.toContain("alpha");
    expect(sql.indexOf("COMMIT")).toBeGreaterThan(sql.indexOf(lease));
    expect(read).toHaveBeenCalledOnce();
    const request = read.mock.calls[0]![0];
    expect(request).toMatchObject({
      task: {
        kind: "hybrid",
        input: {
          pathPrefix: null,
          documentId: null,
          filters: null,
          text: "alpha",
          vector: [0.6, 0.8],
        },
      },
      expected: {
        generationId: leased.generationId,
        kbId,
        commitSha,
        fingerprint: leased.fingerprint,
        dimensions: 2,
        chunkCount: 2,
        documentCount: 2,
      },
      active: true,
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.deadlineAt).toBeGreaterThan(Date.now());
    expect(pg.end).toHaveBeenCalled();
  });

  it("a failed file read fails the whole search with zero hits, never keyword-only", async () => {
    read.mockRejectedValue(new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable"));
    await expect(
      searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    expect(pg.end).toHaveBeenCalled();
  });

  it("fails closed when the lease is gone before the read", async () => {
    database({ lease: null });
    await expect(
      searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects oversized query/limit and sensitive text before any lease", async () => {
    for (const input of [
      { kbId, query: "x".repeat(1025) },
      { kbId, query: "" },
      { kbId, query: "ok", limit: 21 },
      { kbId, query: "ok", limit: 0 },
      { kbId, query: "ok", extra: true },
    ])
      await expect(searchKnowledgeBase(options, actor, input as never)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    await expect(
      searchKnowledgeBase(options, actor, { kbId, query: `key sk-${"a".repeat(40)}` }),
    ).rejects.toMatchObject({ code: "SENSITIVE_QUERY" });
    expect(withQueryEmbedding).not.toHaveBeenCalled();
  });

  it("honors an explicit limit after fusion", async () => {
    const result = await searchKnowledgeBase(options, actor, { kbId, query: "alpha", limit: 1 });
    expect(result.results).toHaveLength(1);
  });

  it("maps a stopped read to its deadline or cancellation code", async () => {
    read.mockResolvedValue({ status: "deadline" });
    await expect(
      searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    read.mockResolvedValue({ status: "aborted" });
    await expect(
      searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("missing index file (§1.7)", () => {
  it("logs an integrity failure for a COMPLETE generation and re-admits exactly once", async () => {
    const log = captureLog();
    read
      .mockRejectedValueOnce(new IndexFileMissingError())
      .mockResolvedValueOnce({ status: "ok", result: hybrid });
    try {
      const result = await searchKnowledgeBase(options, actor, { kbId, query: "alpha" });
      expect(result.results).toHaveLength(2);
      expect(withQueryEmbedding).toHaveBeenCalledTimes(2);
      expect(log.records).toContainEqual(
        expect.objectContaining({
          site: "kb.index-missing",
          kbId,
          generationId: leased.generationId,
        }),
      );
    } finally {
      log.restore();
    }
  });

  it("a second miss is INDEX_UNAVAILABLE", async () => {
    const log = captureLog();
    read.mockRejectedValue(new IndexFileMissingError());
    try {
      const error = await searchKnowledgeBase(options, actor, { kbId, query: "alpha" }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(KbDomainError);
      expect(error).not.toBeInstanceOf(IndexFileMissingError);
      expect(error).toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(withQueryEmbedding).toHaveBeenCalledTimes(2);
    } finally {
      log.restore();
    }
  });

  it("a lost session (COMMIT fails) is INDEX_UNAVAILABLE without integrity log or retry", async () => {
    const log = captureLog();
    database({
      commit: () => {
        throw new Error("terminating connection");
      },
    });
    read.mockRejectedValue(new IndexFileMissingError());
    try {
      await expect(
        searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
      ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(withQueryEmbedding).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.records)).not.toContain("integrity");
    } finally {
      log.restore();
    }
  });

  it("a cursor-pinned retained generation without its file is INVALID_CURSOR, no log", async () => {
    const log = captureLog();
    leased.pinned = true;
    database({ lease: { ...generation, state: "SUPERSEDED", active: false } });
    read.mockRejectedValue(new IndexFileMissingError());
    try {
      await expect(
        searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
      expect(withQueryEmbedding).toHaveBeenCalledOnce();
      expect(log.records).toEqual([]);
    } finally {
      leased.pinned = false;
      log.restore();
    }
  });
});

describe("read interlock (§1.5 CL-INTERLOCK)", () => {
  it("an abort during the file read never ends the client before the read settled", async () => {
    const controller = new AbortController();
    vi.mocked(withQueryEmbedding).mockImplementationOnce(async (_o, _a, _i, consume) =>
      (consume as (v: unknown, s: AbortSignal) => Promise<unknown>)(leased, controller.signal),
    );
    let settle!: (value: unknown) => void;
    read.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const pending = searchKnowledgeBase(options, actor, { kbId, query: "alpha" }).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    controller.abort();
    await Promise.resolve();
    expect(pg.end).not.toHaveBeenCalled();
    settle({ status: "aborted" });
    await expect(pending).resolves.toMatchObject({ code: "CANCELLED" });
    expect(pg.end).toHaveBeenCalled();
  });
});

describe("private read diagnostics", () => {
  it("logs only a SQLSTATE even when every PG error field contains a private canary", async () => {
    const canary = "synthetic-private-read-canary";
    const log = captureLog();
    const original = pg.query.getMockImplementation()!;
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("generation_lease"))
        throw Object.assign(new Error(canary), {
          code: "22P05",
          detail: canary,
          where: canary,
          query: canary,
          parameters: [canary],
          cause: new Error(canary),
        });
      return original(sql, params);
    });
    try {
      await expect(
        searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
      ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(log.records[0]).toMatchObject({
        site: "kb.search",
        errorCode: "22P05",
      });
      expect(JSON.stringify(log.records)).not.toContain(canary);
    } finally {
      log.restore();
    }
  });
});
