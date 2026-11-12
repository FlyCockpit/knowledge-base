import { randomBytes } from "node:crypto";
import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureIndexReader,
  type IndexReaderPool,
  resetIndexReaderForTests,
} from "./index-file/pool";
import type { IndexCitationRow } from "./index-file/reader";

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
const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("./permissions", async (original) => ({
  ...(await original<typeof import("./permissions")>()),
  authorize: auth.authorize,
}));
vi.mock("./index-status", async (importOriginal) => ({
  servedFreshness: (await importOriginal<typeof import("./index-status")>()).servedFreshness,
  loadIndexStatus: vi.fn(async () => ({ profile: null, index: { ...index } })),
  qwenRebuildReason: vi.fn(async () => null),
}));
// Real permit/deadline/drain behavior is exercised in the PostgreSQL suite.
vi.mock("./authority-lock", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return {
    runLockedOperation: async <T>(
      options: import("./authority-lock").LockedOperationOptions<T>,
    ) => {
      const lease = mockDeep<import("./lock").HeldLockLease>();
      lease.transaction.mockImplementation(async (run) => run(pg.query));
      return options.run(lease);
    },
  };
});
vi.mock("./query-embedding", () => ({
  QUERY_DEADLINE_MS: 60_000,
  withQueryCapacity: vi.fn(async (_options, _actor, consume, signal) =>
    consume(signal ?? new AbortController().signal),
  ),
  GENERATION_LEASE_MS: 90_000,
  withQueryEmbedding: vi.fn(async () => {
    const { KbDomainError } = await import("./errors");
    throw new KbDomainError("INDEX_UNAVAILABLE", "Query embedding unavailable");
  }),
}));
const { withQueryEmbedding } = await import("./query-embedding");
const { createCursorSigner, CURSOR_TTL_MS } = await import("./cursor");
const { compareIsoUtc } = await import("./protocol/common");
const {
  decodeHybridKey,
  decodeRankedKey,
  decodeRowKey,
  encodeHybridKey,
  encodeRankedKey,
  encodeRowKey,
  isoSortKey,
  normalizeStructuredQuery,
  pageAfterHybrid,
  STRUCTURED_GENERATION_RETENTION_MS,
  structuredSearchKnowledgeBase,
} = await import("./structured-search");

const kbId = "k".repeat(24);
const generationId = "g".repeat(24);
const commitSha = "a".repeat(40);
const signer = createCursorSigner(randomBytes(32));
const options = {
  connectionString: "postgres://unused",
  masterKey: undefined,
  ratePort: { consume: vi.fn(async () => ({ ok: true as const })) },
  cursorSigner: signer,
};
const actor = { principal: { kind: "browser" as const, userId: "reader" } };
const hit = (path: string, rowIndex: number): IndexCitationRow => ({
  id: 1,
  path,
  chunkIndex: 0,
  rowIndex,
  matchedRow: rowIndex < 0 ? null : { k: rowIndex },
  documentId: null,
  commitSha,
  blobSha: "b".repeat(40),
  contentHash: `sha256:${"c".repeat(64)}`,
  span: { startToken: 0, endToken: 2, startByte: 0, endByte: 9 },
  snippet: "alpha beta",
  documentCitations: [],
  assetRefs: [],
});
const index = vi.hoisted(() => ({
  activeGenerationId: "g".repeat(24) as string | null,
  desiredGenerationId: "g".repeat(24),
  desiredEpoch: "1",
  activeState: "COMPLETE",
  desiredState: "COMPLETE",
  indexedCommitSha: "a".repeat(40),
  headSha: "a".repeat(40),
  dimensions: 2,
  fingerprint: `sha256:${"f".repeat(64)}`,
  freshness: "current",
  errorCode: null,
}));
let rows = [hit("a.md", 0), hit("a.md", 3), hit("b.md", 1)];
const read = vi.fn();
function database() {
  pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FOR KEY SHARE"))
      return params?.[0] === generationId
        ? {
            rows: [
              {
                commitSha,
                name: "Fixture",
                providerId: "provider",
                providerVersion: 1,
                fingerprint: `sha256:${"f".repeat(64)}`,
                dimensions: 2,
                chunkCount: 3,
                documentCount: 2,
                state: "COMPLETE",
              },
            ],
          }
        : { rows: [] };
    return { rows: [] };
  });
  read.mockImplementation(async (request: { task: { input: { limit: number } } }) => ({
    status: "ok",
    result: rows.slice(0, request.task.input.limit),
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  rows = [hit("a.md", 0), hit("a.md", 3), hit("b.md", 1)];
  auth.authorize.mockResolvedValue({ kbId, ownerId: "owner", state: "ACTIVE", bits: ["read"] });
  database();
  configureIndexReader({
    start: async () => {},
    stop: async () => {},
    read: read as unknown as IndexReaderPool["read"],
    stats: () => ({ threads: 1, busy: 0, largeRunning: 0, queued: 0, posted: 0 }),
    threadStats: async () => [],
  });
});
afterEach(() => resetIndexReaderForTests());

describe("structured search input", () => {
  it.each([
    [{ kbId }],
    [{ kbId, tags: [] }],
    [{ kbId, structured: [] }],
    [
      {
        kbId,
        type: "a",
        timestamp: { after: "2026-01-02T00:00:00Z", before: "2026-01-01T00:00:00Z" },
      },
    ],
    [{ kbId, timestamp: { after: "2026-01-01T00:00:00Z", before: "2026-01-01T00:00:00.000Z" } }],
    [{ kbId, timestamp: { after: "2026-02-30T00:00:00Z" } }],
    [{ kbId, timestamp: { after: "2026-01-01T00:00:00+01:00" } }],
    [{ kbId, structured: Array.from({ length: 17 }, () => ({ column: "a", equals: 1 })) }],
    [{ kbId, structured: [{ column: "a", equals: Number.POSITIVE_INFINITY }] }],
    [{ kbId, structured: [{ column: "a", equals: "x".repeat(1025) }] }],
    [{ kbId, structured: [{ column: "a", equals: { nested: true } }] }],
    [{ kbId, structured: [{ column: "a", equals: [1] }] }],
    [{ kbId, type: "a", extra: 1 }],
  ])("rejects %j with INVALID_ARGUMENT and no database or embed work", async (input) => {
    expect(() => normalizeStructuredQuery(input as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    await expect(
      structuredSearchKnowledgeBase(options, actor, input as never),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(pg.query).not.toHaveBeenCalled();
    expect(withQueryEmbedding).not.toHaveBeenCalled();
  });

  it("normalizes exact filters: NFC/trim type and tags, Unicode-casefolded title", () => {
    const n = normalizeStructuredQuery({
      kbId,
      type: " Réport ",
      title: "STRASSE",
      tags: ["b", " a ", "b"],
      structured: [{ column: "Name", equals: "x" }],
    });
    expect(n.query).toBeNull();
    expect(n.filters).toMatchObject({
      type: "Réport",
      tags: ["a", "b"],
      row: { Name: "x" },
      impossible: false,
    });
    expect(n.filters.titleFolded).toBe(
      normalizeStructuredQuery({ kbId, title: "straße" }).filters.titleFolded,
    );
  });

  it("same-column conditions with different values can never match; equal values collapse", () => {
    const conflict = normalizeStructuredQuery({
      kbId,
      structured: [
        { column: "a", equals: 1 },
        { column: "a", equals: "1" },
      ],
    });
    expect(conflict.filters.impossible).toBe(true);
    const same = normalizeStructuredQuery({
      kbId,
      structured: [
        { column: "a", equals: 1 },
        { column: "a", equals: 1.0 },
      ],
    });
    expect(same.filters).toMatchObject({ impossible: false, row: { a: 1 } });
  });

  it("orders ISO sort keys exactly like compareIsoUtc, including nanosecond fractions", () => {
    const stamps = [
      "2026-09-24T12:00:00Z",
      "2026-09-24T12:00:00.000000001Z",
      "2026-09-24T12:00:00.1Z",
      "2026-09-24T12:00:00.100000000Z",
      "2026-09-24T12:00:00.999999999Z",
      "2026-09-24T12:00:01Z",
      "1999-12-31T23:59:59.5Z",
    ];
    for (const a of stamps)
      for (const b of stamps) {
        const expected = compareIsoUtc(a, b)!;
        const ka = isoSortKey(a);
        const kb = isoSortKey(b);
        expect(Math.sign(ka < kb ? -1 : ka > kb ? 1 : 0)).toBe(Math.sign(expected));
      }
  });
});

describe("structured filters reach the index reader as data", () => {
  it("passes client column names and values only as task data, never into SQL text", async () => {
    const hostile = 'x"; SELECT pg_sleep(9); --';
    const n = normalizeStructuredQuery({ kbId, structured: [{ column: hostile, equals: "v'--" }] });
    expect(n.raw).toEqual({ structured: [{ column: hostile, equals: "v'--" }] });
    await structuredSearchKnowledgeBase(options, actor, {
      kbId,
      structured: [{ column: hostile, equals: "v'--" }],
    });
    const sql = pg.query.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).not.toContain("pg_sleep");
    expect(sql).not.toContain("v'--");
    expect(read.mock.calls[0]?.[0].task.input.filters).toEqual({
      structured: [{ column: hostile, equals: "v'--" }],
    });
  });

  it("forwards only the filter fields of a request", () => {
    const n = normalizeStructuredQuery({
      kbId,
      type: "note",
      title: "T",
      tags: ["a"],
      timestamp: { after: "2026-01-01T00:00:00Z" },
      limit: 3,
    });
    expect(n.raw).toEqual({
      type: "note",
      title: "T",
      tags: ["a"],
      timestamp: { after: "2026-01-01T00:00:00Z" },
    });
  });
});

describe("cursor keys and pinned pages", () => {
  it("round-trips row and hybrid keys, including paths containing separators", () => {
    expect(decodeRowKey(encodeRowKey({ path: "a:b/ü.md", rowIndex: 7 }))).toEqual({
      path: "a:b/ü.md",
      rowIndex: 7,
    });
    expect(decodeRowKey(encodeRowKey({ path: "x.md", rowIndex: -1 }))).toEqual({
      path: "x.md",
      rowIndex: -1,
    });
    const score = 1 / 61 + 1 / 62;
    expect(decodeHybridKey(encodeHybridKey({ path: "a:1:b.md", chunkIndex: 3, score }))).toEqual({
      path: "a:1:b.md",
      chunkIndex: 3,
      score,
    });
    for (const bad of ["", "x", "1", "NaN:0:a", "1.5:a", "01:a", "-2:a"])
      expect(() => decodeRowKey(bad)).toThrowError(
        expect.objectContaining({ code: "INVALID_CURSOR" }),
      );
    for (const mode of ["hybrid", "lexical"] as const)
      expect(
        decodeRankedKey(encodeRankedKey(mode, { path: "a:1:b.md", chunkIndex: 3, score })),
      ).toEqual({ mode, key: { path: "a:1:b.md", chunkIndex: 3, score } });
    // A key without its ranking mode (or another tag) is refused.
    for (const bad of [encodeHybridKey({ path: "a.md", chunkIndex: 0, score }), "x:1:0:a.md"])
      expect(() => decodeRankedKey(bad)).toThrowError(
        expect.objectContaining({ code: "INVALID_CURSOR" }),
      );
    for (const bad of ["", "1:a", "Infinity:0:a", "1:x:a"])
      expect(() => decodeHybridKey(bad)).toThrowError(
        expect.objectContaining({ code: "INVALID_CURSOR" }),
      );
  });

  it("continues after the exact fused key and rejects missing or drifted keys", () => {
    const fused = [
      { path: "a.md", chunkIndex: 0, score: 0.3 },
      { path: "b.md", chunkIndex: 0, score: 0.2 },
      { path: "c.md", chunkIndex: 1, score: 0.1 },
    ];
    expect(pageAfterHybrid(fused, null, 2)).toEqual({ page: fused.slice(0, 2), hasMore: true });
    expect(pageAfterHybrid(fused, fused[1]!, 2)).toEqual({ page: fused.slice(2), hasMore: false });
    expect(() =>
      pageAfterHybrid(fused, { path: "z.md", chunkIndex: 0, score: 0.2 }, 2),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
    expect(() => pageAfterHybrid(fused, { ...fused[1]!, score: 0.25 }, 2)).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR" }),
    );
  });

  it("keeps generations retained longer than any cursor stays valid", () => {
    expect(STRUCTURED_GENERATION_RETENTION_MS).toBeGreaterThan(CURSOR_TTL_MS);
  });
});

describe("queryless structured operation", () => {
  it("is explicit: pins the active complete generation, orders by path+row, pages with a signed cursor", async () => {
    const first = await structuredSearchKnowledgeBase(options, actor, {
      kbId,
      structured: [{ column: "k", equals: 0 }],
      limit: 2,
    });
    expect(withQueryEmbedding).not.toHaveBeenCalled();
    expect(first).toMatchObject({
      generationId,
      indexedCommitSha: commitSha,
      headSha: commitSha,
      freshness: "current",
    });
    expect(first.items.map((h) => [h.path, h.mode, h.matchedRow, h.score])).toEqual([
      ["a.md", "structured", { k: 0 }, 1],
      ["a.md", "structured", { k: 3 }, 1],
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const statements = pg.query.mock.calls.map(([sql]) => String(sql));
    const lease = statements.findIndex((sql) => sql.includes("FOR KEY SHARE OF g"));
    const commit = statements.indexOf("COMMIT");
    expect(lease).toBeGreaterThan(-1);
    expect(statements.some((sql) => /idle_in_transaction_session_timeout/.test(sql))).toBe(true);
    // The file read runs between the KEY SHARE lease and its COMMIT.
    expect(read).toHaveBeenCalledOnce();
    expect(commit).toBeGreaterThan(lease);
    expect(read.mock.calls[0]?.[0]).toMatchObject({
      task: { kind: "queryless", input: { after: null, limit: 3 } },
      expected: { generationId, kbId, commitSha, chunkCount: 3, documentCount: 2 },
      active: true,
    });
    expect(statements.findIndex((sql) => sql.includes('SET "lastQueriedAt"'))).toBeGreaterThan(
      commit,
    );
    // Authorization before and after the page read.
    expect(auth.authorize).toHaveBeenCalledTimes(2);

    rows = [hit("b.md", 1)];
    pg.query.mockClear();
    const second = await structuredSearchKnowledgeBase(options, actor, {
      kbId,
      structured: [{ column: "k", equals: 0 }],
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((h) => h.path)).toEqual(["b.md"]);
    expect(second.nextCursor).toBeNull();
    expect(read.mock.calls.at(-1)?.[0].task.input.after).toEqual({ path: "a.md", rowIndex: 3 });
  });

  it("rejects a cursor bound to other filters, another actor, or tampering", async () => {
    const first = await structuredSearchKnowledgeBase(options, actor, {
      kbId,
      type: "note",
      limit: 1,
    });
    const cursor = first.nextCursor!;
    for (const [who, input] of [
      [actor, { kbId, type: "other", cursor }],
      [
        { principal: { kind: "browser" as const, userId: "other" } },
        { kbId, type: "note", cursor },
      ],
      [actor, { kbId, type: "note", query: "alpha", cursor }],
      [actor, { kbId, type: "note", cursor: `${cursor.slice(0, -2)}xx` }],
    ] as const)
      await expect(
        structuredSearchKnowledgeBase(options, who, input as never),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("with a query never falls back to the queryless operation when the embed fails", async () => {
    await expect(
      structuredSearchKnowledgeBase(options, actor, { kbId, query: "alpha", type: "note" }),
    ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    expect(withQueryEmbedding).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it("denies the page when authorization is revoked before the reply", async () => {
    auth.authorize
      .mockResolvedValueOnce({ kbId, ownerId: "owner", state: "ACTIVE", bits: ["read"] })
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "NOT_FOUND" }));
    await expect(
      structuredSearchKnowledgeBase(options, actor, { kbId, type: "note" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(pg.query.mock.calls.some(([sql]) => String(sql).includes('SET "lastQueriedAt"'))).toBe(
      false,
    );
  });

  it("re-admits a queryless page once after a missing file, then fails closed", async () => {
    const { IndexFileMissingError } = await import("./errors");
    const { withQueryCapacity } = await import("./query-embedding");
    const log = captureLog();
    try {
      read.mockRejectedValueOnce(new IndexFileMissingError());
      const page = await structuredSearchKnowledgeBase(options, actor, { kbId, type: "note" });
      expect(page.items.length).toBeGreaterThan(0);
      expect(withQueryCapacity).toHaveBeenCalledTimes(2);
      expect(log.records).toContainEqual(
        expect.objectContaining({ site: "kb.index-missing", kbId, generationId }),
      );
      read.mockRejectedValue(new IndexFileMissingError());
      const error = await structuredSearchKnowledgeBase(options, actor, {
        kbId,
        type: "note",
      }).catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(IndexFileMissingError);
      expect(error).toMatchObject({ code: "INDEX_UNAVAILABLE" });
    } finally {
      log.restore();
    }
  });

  it("requires a complete active generation for the first queryless page", async () => {
    index.activeGenerationId = null;
    try {
      await expect(
        structuredSearchKnowledgeBase(options, actor, { kbId, type: "note" }),
      ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
    } finally {
      index.activeGenerationId = generationId;
    }
  });
});

describe("private read diagnostics", () => {
  it("logs only a SQLSTATE even when every PG error field contains a private canary", async () => {
    const canary = "synthetic-private-read-canary";
    const log = captureLog();
    const original = pg.query.getMockImplementation()!;
    pg.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FOR KEY SHARE"))
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
        structuredSearchKnowledgeBase(options, actor, { kbId, type: "note" }),
      ).rejects.toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(log.records[0]).toMatchObject({
        site: "kb.search",
        stage: "structured-read",
        errorCode: "22P05",
      });
      expect(JSON.stringify(log.records)).not.toContain(canary);
    } finally {
      log.restore();
    }
  });
});
