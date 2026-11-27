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
const {
  hitRelevance,
  indexedCommitTime,
  relevanceCalibration,
  searchKnowledgeBase,
  searchKnowledgeBaseForBrowser,
  searchKnowledgeBaseServed,
  SEARCH_DEFAULT_LIMIT,
} = await import("./search");

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

describe("browser relevance (never the fused score)", () => {
  it("adds each hit's cosine similarity and keyword match, leaving the kb/1 reply unchanged", async () => {
    const browser = await searchKnowledgeBaseForBrowser(options, actor, { kbId, query: "alpha" });
    const plain = await searchKnowledgeBase(options, actor, { kbId, query: "alpha" });
    expect(browser.results.map((h) => [h.path, h.relevance])).toEqual([
      ["a.md", { semantic: null, semanticRank: null, keyword: true, keywordRank: 1 }],
      // Cosine distance 0.1 from the vector arm: similarity 0.9.
      ["b.md", { semantic: 0.9, semanticRank: 1, keyword: false, keywordRank: null }],
    ]);
    // A mocked generation row without a provider: unknown calibration.
    expect(browser.calibration).toBe("unknown");
    const { calibration: _calibration, indexedCommittedAt, ...rest } = browser;
    // No repositories directory given: the commit time is simply unknown.
    expect(indexedCommittedAt).toBeNull();
    expect({
      ...rest,
      results: rest.results.map(({ relevance: _relevance, ...hit }) => hit),
    }).toEqual(plain);
    expect(plain.results.every((hit) => !("relevance" in hit))).toBe(true);
    expect("calibration" in plain).toBe(false);
  });

  it("reads the generation's provider model in the leased-generation statement", async () => {
    await searchKnowledgeBaseForBrowser(options, actor, { kbId, query: "alpha" });
    const lease = statements().find((text) => text.includes("generation_lease"))!;
    expect(lease).toContain('AS "providerModel"');
    expect(lease).toContain('r."calibrationFamily"');
    expect(lease).toContain("FOR KEY SHARE OF g");
  });

  it("reads the indexed commit's time from the KB repository, null when it can't", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const reposDir = mkdtempSync(join(tmpdir(), "kb-search-time-"));
    try {
      const repo = join(reposDir, `kb_${kbId}.git`);
      execFileSync("git", ["init", "-q", "--bare", repo]);
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
        GIT_COMMITTER_DATE: "1700000000 +0000",
        GIT_AUTHOR_DATE: "1700000000 +0000",
      };
      const tree = execFileSync("git", ["--git-dir", repo, "mktree"], { input: "", env })
        .toString()
        .trim();
      const sha = execFileSync("git", ["--git-dir", repo, "commit-tree", tree, "-m", "x"], { env })
        .toString()
        .trim();
      expect(await indexedCommitTime(reposDir, kbId, sha)).toBe("2023-11-14T22:13:20.000Z");
      expect(await indexedCommitTime(reposDir, kbId, "0".repeat(40))).toBeNull();
      expect(await indexedCommitTime(reposDir, kbId, null)).toBeNull();
      expect(await indexedCommitTime(reposDir, kbId, "not-a-sha")).toBeNull();
    } finally {
      rmSync(reposDir, { recursive: true, force: true });
    }
  });

  it("reads the commit time before the final authorization, so a revoked reader gets nothing", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const reposDir = mkdtempSync(join(tmpdir(), "kb-search-revoke-"));
    try {
      const repo = join(reposDir, `kb_${kbId}.git`);
      execFileSync("git", ["init", "-q", "--bare", repo]);
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
        GIT_COMMITTER_DATE: "1700000000 +0000",
        GIT_AUTHOR_DATE: "1700000000 +0000",
      };
      const tree = execFileSync("git", ["--git-dir", repo, "mktree"], { input: "", env })
        .toString()
        .trim();
      const sha = execFileSync("git", ["--git-dir", repo, "commit-tree", tree, "-m", "x"], { env })
        .toString()
        .trim();
      database({ lease: { ...generation, commitSha: sha } });
      read.mockResolvedValue({
        status: "ok",
        result: { ...hybrid, rows: hybrid.rows.map((r) => ({ ...r, commitSha: sha })) },
      });
      const seen: unknown[] = [];
      // The final authorization runs once the consumer has returned: by then
      // the time must already be read, and a revocation there wins.
      vi.mocked(withQueryEmbedding).mockImplementationOnce(async (_o, _a, _i, consume) => {
        const pinned = {
          ...leased,
          index: { ...leased.index, indexedCommitSha: sha, headSha: sha },
        };
        const out = (await consume(pinned as never, new AbortController().signal)) as {
          indexedCommittedAt: string | null;
        };
        seen.push(out.indexedCommittedAt);
        throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
      });
      await expect(
        searchKnowledgeBaseForBrowser({ ...options, reposDir }, actor, { kbId, query: "alpha" }),
      ).rejects.toBeInstanceOf(KbDomainError);
      expect(seen).toEqual(["2023-11-14T22:13:20.000Z"]);
    } finally {
      rmSync(reposDir, { recursive: true, force: true });
    }
  });

  it("keys calibration by built-in model id, else unknown; lexical generations say so", () => {
    expect(
      relevanceCalibration(
        { providerId: "builtinembeddingmodel000", providerModel: "embeddinggemma-2-q8_0" },
        false,
      ),
    ).toBe("embeddinggemma-2-q8_0");
    expect(
      relevanceCalibration(
        { providerId: "builtinembeddingmodel000", providerModel: "not-a-model" },
        false,
      ),
    ).toBe("unknown");
    expect(
      relevanceCalibration(
        { providerId: "builtinembeddingmodel000", providerModel: "qwen3-embedding-0.6b-q8_0" },
        false,
      ),
    ).toBe("qwen3-embedding-0.6b-q8_0");
    // An external provider's model name never reaches the browser.
    expect(
      relevanceCalibration({ providerId: "p".repeat(24), providerModel: "secret-model" }, false),
    ).toBe("unknown");
    for (const family of ["embeddinggemma-2-q8_0", "qwen3-embedding-0.6b-q8_0"]) {
      expect(
        relevanceCalibration({ providerId: "external", providerCalibration: family }, false),
      ).toBe(family);
    }
    for (const family of [null, "unknown", "bogus"]) {
      expect(
        relevanceCalibration({ providerId: "external", providerCalibration: family }, false),
      ).toBe("unknown");
    }
    expect(relevanceCalibration({ providerId: null, providerModel: null }, true)).toBe("lexical");
  });

  it("ranks within each arm like the fusion (duplicates keep their best rank) and clamps", () => {
    const arms = {
      vector: [
        { path: "a.md", chunkIndex: 0, score: 0.2 },
        { path: "a.md", chunkIndex: 0, score: 0.3 },
        { path: "b.md", chunkIndex: 1, score: 2.5 },
      ],
      fts: [{ path: "b.md", chunkIndex: 1, score: -3 }],
    };
    expect(hitRelevance(arms, { path: "b.md", chunkIndex: 1 })).toEqual({
      semantic: -1,
      semanticRank: 2,
      keyword: true,
      keywordRank: 1,
    });
    expect(hitRelevance(arms, { path: "a.md", chunkIndex: 0 }).semantic).toBeCloseTo(0.8);
    expect(hitRelevance(arms, { path: "c.md", chunkIndex: 0 })).toEqual({
      semantic: null,
      semanticRank: null,
      keyword: false,
      keywordRank: null,
    });
  });
});

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
      // First of one arm, absent from the other: half the two-arm maximum.
      ["a.md", 0.5, "hybrid", "alpha beta"],
      ["b.md", 0.5, "hybrid", "alpha beta"],
    ]);
    const sql = statements();
    expect(sql).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(sql.some((text) => /idle_in_transaction_session_timeout = \d+/.test(text))).toBe(true);
    const lease = sql.find((text) => text.includes("generation_lease"))!;
    // The generation row is held FOR KEY SHARE until the file read settled.
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

  it("reports which arm source served the reply (knowledge_search_all's lexical_only)", async () => {
    const hybridServed = await searchKnowledgeBaseServed(options, actor, { kbId, query: "alpha" });
    expect(hybridServed.lexical).toBe(false);
    expect(hybridServed.result).toEqual(
      await searchKnowledgeBase(options, actor, { kbId, query: "alpha" }),
    );
    pg.query.mockImplementation(async (sql: string) =>
      sql.includes("FOR KEY SHARE OF g") ? { rows: [generation] } : { rows: [] },
    );
    vi.mocked(withQueryEmbedding).mockImplementationOnce(
      async (_o, _a, _i, _consume, _signal, lexicalConsume) =>
        lexicalConsume!(
          {
            lexical: true,
            generationId: leased.generationId,
            index: leased.index as never,
            pinned: false,
            notice: null,
          },
          new AbortController().signal,
        ),
    );
    const lexicalServed = await searchKnowledgeBaseServed(options, actor, { kbId, query: "alpha" });
    expect(lexicalServed.lexical).toBe(true);
    expect(lexicalServed.result.results.every((hit) => hit.mode === "lexical")).toBe(true);
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

describe("missing index file", () => {
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

describe("read interlock", () => {
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
