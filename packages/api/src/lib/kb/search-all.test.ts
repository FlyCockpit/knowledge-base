import { captureLog } from "@knowledge-base/env/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KbDomainError } from "./errors";
import { tooManyBasesMessage } from "./protocol/envelope";
import fixtures from "./protocol/fixtures.json";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  authorize: vi.fn(),
  authorizeDocumentRead: vi.fn(),
  list: vi.fn(),
  loadIndexStatus: vi.fn(),
  executeRaw: vi.fn(),
  transaction: vi.fn(),
  setting: { value: undefined as string | undefined },
}));
vi.mock("./search", () => ({ searchKnowledgeBaseServed: mocks.search }));
vi.mock("./permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./permissions")>()),
  authorize: mocks.authorize,
  prismaAuthorityStore: () => ({}),
}));
vi.mock("./documents-read", () => ({ authorizeDocumentRead: mocks.authorizeDocumentRead }));
vi.mock("./bases", async () => {
  const { KbDomainError: DomainError } = await import("./errors");
  return {
    listKnowledgeBases: mocks.list,
    mapKbDomainError: (error: unknown) => (error instanceof DomainError ? error : null),
  };
});
vi.mock("./index-status", () => ({ loadIndexStatus: mocks.loadIndexStatus }));
vi.mock("./asset-authz", () => ({
  prismaAssetQuery: () => async (sql: string) => ({
    rows:
      sql.startsWith("SELECT") && mocks.setting.value !== undefined
        ? [{ value: mocks.setting.value }]
        : [],
    rowCount: 0,
  }),
}));
vi.mock("./query-embedding", () => ({ QUERY_DEADLINE_MS: 60_000 }));

const {
  effectiveLimitPerBase,
  searchAllLimitFrom,
  searchKnowledgeBases,
  SEARCH_ALL_FINAL_CHECKS,
  SEARCH_ALL_LANES,
} = await import("./search-all");

const id = (c: string) => c.repeat(24);
const SHA = "a".repeat(40);
const HIT_TEMPLATE = (
  fixtures.tools.knowledge_search.validOutputVariants.find((v) => v.label === "populated-hit")!
    .value as { results: Record<string, unknown>[] }
).results[0]!;
const hit = (kbId: string, n: number, score: number) => ({
  ...HIT_TEMPLATE,
  knowledgeBaseId: kbId,
  path: `${kbId.slice(0, 1)}-${n}.md`,
  score,
});
const served = (kbId: string, scores: number[], lexical = false, indexNotices: unknown[] = []) => ({
  lexical,
  result: {
    results: scores.map((score, n) => hit(kbId, n + 1, score)),
    generationId: id("g"),
    freshness: "current",
    indexedCommitSha: SHA,
    headSha: SHA,
    indexNotices,
  },
});
const tx = { $executeRawUnsafe: mocks.executeRaw, $queryRawUnsafe: vi.fn() };
const options = { prisma: { $transaction: mocks.transaction } } as never;
const recheck = vi.fn(async () => {});
const actor = { principal: { kind: "browser" as const, userId: "reader" }, recheck };
const run = (raw: Record<string, unknown>, signal = new AbortController().signal, extra = {}) =>
  searchKnowledgeBases(options, actor, raw as never, { signal, ...extra });
const bare = (kbId: string, status: string, retryAfterSeconds: number | null = null) => ({
  kbId,
  status,
  hitCount: 0,
  generationId: null,
  freshness: null,
  indexedCommitSha: null,
  headSha: null,
  indexNotices: [],
  retryAfterSeconds,
});
const listed = (ids: string[], nextCursor: string | null = null) => ({
  items: ids.map((kbId) => ({ id: kbId })),
  nextCursor,
});
const searchedIds = () => mocks.search.mock.calls.map((call) => (call[2] as { kbId: string }).kbId);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockReset();
  mocks.authorize.mockReset().mockResolvedValue({ state: "ACTIVE" });
  mocks.authorizeDocumentRead.mockReset().mockResolvedValue(undefined);
  mocks.list.mockReset();
  mocks.loadIndexStatus.mockReset();
  mocks.executeRaw.mockReset().mockResolvedValue(0);
  mocks.transaction
    .mockReset()
    .mockImplementation(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
  mocks.setting.value = undefined;
  recheck.mockReset().mockResolvedValue(undefined);
});

describe("base list", () => {
  it("searches an explicit list in request order, first occurrence kept", async () => {
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, []),
    );
    const out = await run({ query: "q", kbIds: [id("b"), id("a"), id("b"), id("c")] });
    expect(out.knowledgeBases.map((row) => row.kbId)).toEqual([id("b"), id("a"), id("c")]);
    expect(searchedIds()).toEqual([id("b"), id("a"), id("c")]);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("lists every readable base, paging up to LIMIT+1, in listing order", async () => {
    mocks.setting.value = "60";
    const first = Array.from(
      { length: 50 },
      (_, n) => `${String(n).padStart(2, "0")}${"x".repeat(22)}`,
    );
    const second = Array.from(
      { length: 10 },
      (_, n) => `${String(n).padStart(2, "0")}${"y".repeat(22)}`,
    );
    mocks.list
      .mockResolvedValueOnce(listed(first, "c1"))
      .mockResolvedValueOnce(listed(second, null));
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, []),
    );
    const out = await run({ query: "q" });
    expect(mocks.list.mock.calls.map((call) => call[2])).toEqual([
      { limit: 50, cursor: null },
      { limit: 11, cursor: "c1" },
    ]);
    expect(out.knowledgeBases.map((row) => row.kbId)).toEqual([...first, ...second]);
  });

  it("refuses LIMIT+1 readable bases with TOO_MANY_BASES and searches none", async () => {
    const ids = Array.from(
      { length: 17 },
      (_, n) => `${String(n).padStart(2, "0")}${"z".repeat(22)}`,
    );
    mocks.list.mockResolvedValueOnce(listed(ids, "more"));
    const error = await run({ query: "q" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KbDomainError);
    expect(error).toMatchObject({
      code: "INVALID_ARGUMENT",
      message: tooManyBasesMessage(16),
      details: { reason: "TOO_MANY_BASES", max: 16 },
    });
    expect(mocks.list.mock.calls[0]![2]).toEqual({ limit: 17, cursor: null });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("accepts exactly LIMIT readable bases", async () => {
    const ids = Array.from(
      { length: 16 },
      (_, n) => `${String(n).padStart(2, "0")}${"z".repeat(22)}`,
    );
    mocks.list.mockResolvedValueOnce(listed(ids, null));
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, []),
    );
    const out = await run({ query: "q" });
    expect(out.knowledgeBases).toHaveLength(16);
    expect(out.limitPerBase).toBe(4);
  });

  it("honours a custom admin limit", async () => {
    mocks.setting.value = "3";
    mocks.list.mockResolvedValueOnce(listed([id("a"), id("b"), id("c"), id("d")], "more"));
    await expect(run({ query: "q" })).rejects.toMatchObject({
      details: { reason: "TOO_MANY_BASES", max: 3 },
    });
    expect(mocks.list.mock.calls[0]![2]).toEqual({ limit: 4, cursor: null });
  });

  it("zero readable bases is an empty success", async () => {
    mocks.list.mockResolvedValueOnce(listed([], null));
    await expect(run({ query: "q" })).resolves.toEqual({
      results: [],
      order: "rank_interleaved",
      limitPerBase: 4,
      knowledgeBases: [],
    });
  });

  it.each([
    [undefined, 16],
    ["", 16],
    ["0", 16],
    ["65", 16],
    ["07", 16],
    ["1.5", 16],
    ["abc", 16],
    ["1", 1],
    ["64", 64],
    ["20", 20],
  ])("stored limit %j reads as %d", (stored, limit) => {
    expect(searchAllLimitFrom(stored)).toBe(limit);
  });
});

describe("effective per-base limit", () => {
  it.each([
    [undefined, 1, 4],
    [undefined, 0, 4],
    [10, 10, 10],
    [10, 11, 9],
    [4, 30, 3],
    [10, 64, 1],
    [1, 64, 1],
  ])("requested %j over %d bases gives %d", (requested, bases, limit) => {
    expect(effectiveLimitPerBase(requested, bases)).toBe(limit);
  });

  it("passes the effective limit to every base search", async () => {
    const ids = Array.from(
      { length: 11 },
      (_, n) => `${String(n).padStart(2, "0")}${"q".repeat(22)}`,
    );
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, []),
    );
    const out = await run({ query: "q", kbIds: ids, limitPerBase: 10 });
    expect(out.limitPerBase).toBe(9);
    expect(mocks.search.mock.calls.every((call) => call[2].limit === 9)).toBe(true);
  });
});

describe("merge", () => {
  it("interleaves by per-base rank in row order, never by score", async () => {
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      input.kbId === id("a")
        ? served(id("a"), [0.1, 0.05, 0.01])
        : input.kbId === id("b")
          ? served(id("b"), [0.99, 0.98])
          : served(id("c"), [0.5]),
    );
    const out = await run({ query: "q", kbIds: [id("a"), id("b"), id("c")] });
    expect(out.results.map((h) => [h.knowledgeBaseId, h.rank, h.score])).toEqual([
      [id("a"), 1, 0.1],
      [id("b"), 1, 0.99],
      [id("c"), 1, 0.5],
      [id("a"), 2, 0.05],
      [id("b"), 2, 0.98],
      [id("a"), 3, 0.01],
    ]);
    expect(out.order).toBe("rank_interleaved");
    expect(out.knowledgeBases.map((row) => row.hitCount)).toEqual([3, 2, 1]);
    // Hits keep their own fields unchanged.
    expect(out.results[0]).toEqual({ ...hit(id("a"), 1, 0.1), rank: 1 });
  });
});

describe("per-base status", () => {
  const notice = { kbId: id("b"), code: "LEXICAL_ONLY", detail: "SEMANTIC_INDEX_BUILDING" };

  it("maps ok and lexical_only from the arm source, with that base's index facts", async () => {
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      input.kbId === id("a") ? served(id("a"), [0.2]) : served(id("b"), [], true, [notice]),
    );
    const out = await run({ query: "q", kbIds: [id("a"), id("b")] });
    expect(out.knowledgeBases).toEqual([
      {
        kbId: id("a"),
        status: "ok",
        hitCount: 1,
        generationId: id("g"),
        freshness: "current",
        indexedCommitSha: SHA,
        headSha: SHA,
        indexNotices: [],
        retryAfterSeconds: null,
      },
      {
        kbId: id("b"),
        status: "lexical_only",
        hitCount: 0,
        generationId: id("g"),
        freshness: "current",
        indexedCommitSha: SHA,
        headSha: SHA,
        indexNotices: [notice],
        retryAfterSeconds: null,
      },
    ]);
  });

  it.each([
    [new KbDomainError("RATE_LIMITED", "r", 7), bare(id("a"), "rate_limited", 7)],
    [new KbDomainError("RATE_LIMITED", "r"), bare(id("a"), "rate_limited", null)],
    [new KbDomainError("DEADLINE_EXCEEDED", "d"), bare(id("a"), "deadline")],
    [new KbDomainError("STORAGE_UNAVAILABLE", "s"), bare(id("a"), "unavailable")],
    [new KbDomainError("INTERNAL", "i"), bare(id("a"), "unavailable")],
    [new Error("boom"), bare(id("a"), "unavailable")],
    [new KbDomainError("CANCELLED", "lock revoked, not the caller"), bare(id("a"), "unavailable")],
    [new KbDomainError("NOT_FOUND", "n"), bare(id("a"), "not_found")],
    [new KbDomainError("FORBIDDEN", "f"), bare(id("a"), "not_found")],
  ])("maps %s", async (error, row) => {
    mocks.search.mockRejectedValue(error);
    const out = await run({ query: "q", kbIds: [id("a")] });
    expect(out.knowledgeBases).toEqual([row]);
    expect(out.results).toEqual([]);
  });

  const index = (over: Record<string, unknown>) => ({
    index: {
      activeGenerationId: null,
      activeState: null,
      desiredState: null,
      freshness: "unavailable",
      ...over,
    },
  });
  it.each([
    [index({ desiredState: "PENDING" }), "rebuilding"],
    [index({ desiredState: "BUILDING", freshness: "building" }), "rebuilding"],
    [index({ desiredState: "INDEXING", freshness: "building" }), "rebuilding"],
    [index({ desiredState: "FAILED", freshness: "failed" }), "unavailable"],
    [
      index({
        activeGenerationId: id("g"),
        activeState: "COMPLETE",
        desiredState: "BUILDING",
        freshness: "building",
      }),
      "unavailable",
    ],
  ])("INDEX_UNAVAILABLE with status %j is %s", async (profile, status) => {
    mocks.search.mockRejectedValue(new KbDomainError("INDEX_UNAVAILABLE", "u"));
    mocks.loadIndexStatus.mockResolvedValue(profile);
    const out = await run({ query: "q", kbIds: [id("a")] });
    expect(out.knowledgeBases).toEqual([bare(id("a"), status)]);
    expect(mocks.loadIndexStatus).toHaveBeenCalledWith(expect.any(Function), id("a"));
  });

  it("INDEX_UNAVAILABLE whose status read fails stays unavailable", async () => {
    mocks.search.mockRejectedValue(new KbDomainError("INDEX_UNAVAILABLE", "u"));
    mocks.loadIndexStatus.mockRejectedValue(new KbDomainError("STORAGE_UNAVAILABLE", "s"));
    const out = await run({ query: "q", kbIds: [id("a")] });
    expect(out.knowledgeBases).toEqual([bare(id("a"), "unavailable")]);
  });

  it("bounds the rebuilding status read by what is left of the shared deadline", async () => {
    mocks.search.mockRejectedValue(new KbDomainError("INDEX_UNAVAILABLE", "u"));
    mocks.loadIndexStatus.mockResolvedValue({ index: { desiredState: "FAILED" } });
    const deadlineAt = Date.now() + 20_000;
    await searchKnowledgeBases(
      { ...(options as object), deadlineAt } as never,
      actor,
      {
        query: "q",
        kbIds: [id("a")],
      } as never,
      { signal: new AbortController().signal },
    );
    const [, txOptions] = mocks.transaction.mock.calls[0] as [
      unknown,
      { timeout: number; maxWait: number },
    ];
    expect(txOptions.timeout).toBeGreaterThan(0);
    expect(txOptions.maxWait).toBeGreaterThan(0);
    // Waiting for a connection plus running the transaction fit in what is left.
    expect(txOptions.maxWait + txOptions.timeout).toBeLessThanOrEqual(20_000);
    const set = String(mocks.executeRaw.mock.calls[0]?.[0]);
    expect(set).toMatch(/^SET LOCAL statement_timeout = \d+$/);
    expect(Number(set.split("= ")[1])).toBeLessThanOrEqual(20_000);
  });

  it("runs the final checks a few at a time and waits for every one", async () => {
    const ids = Array.from({ length: 12 }, (_, n) => String.fromCharCode(97 + n).repeat(24));
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, [1]),
    );
    let inFlight = 0;
    let peak = 0;
    let done = 0;
    mocks.authorizeDocumentRead.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      done++;
    });
    const out = await run({ query: "q", kbIds: ids });
    expect(done).toBe(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SEARCH_ALL_FINAL_CHECKS);
    expect(out.knowledgeBases.map((row) => row.kbId)).toEqual(ids);
    expect(out.knowledgeBases.every((row) => row.status === "ok")).toBe(true);
  });

  it("skips the rebuilding status read once the shared deadline passed", async () => {
    const deadlineAt = Date.now() + 30;
    mocks.search.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new KbDomainError("INDEX_UNAVAILABLE", "u");
    });
    const out = await searchKnowledgeBases(
      { ...(options as object), deadlineAt } as never,
      actor,
      { query: "q", kbIds: [id("a")] } as never,
      { signal: new AbortController().signal },
    );
    expect(out.knowledgeBases).toEqual([bare(id("a"), "unavailable")]);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.loadIndexStatus).not.toHaveBeenCalled();
  });

  it("a base not started before the shared deadline reports deadline without running", async () => {
    const deadlineAt = Date.now() + 40;
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return served(input.kbId, [0.1]);
    });
    const out = await searchKnowledgeBases(
      { prisma: {}, deadlineAt } as never,
      actor,
      { query: "q", kbIds: [id("a"), id("b"), id("c"), id("d")] },
      { signal: new AbortController().signal },
    );
    expect(searchedIds()).toEqual([id("a"), id("b")]);
    expect(mocks.search.mock.calls.every((call) => call[0].deadlineAt === deadlineAt)).toBe(true);
    expect(out.knowledgeBases.map((row) => row.status)).toEqual([
      "ok",
      "ok",
      "deadline",
      "deadline",
    ]);
    expect(out.knowledgeBases[2]).toEqual(bare(id("c"), "deadline"));
  });

  it("passes one shared absolute deadline of at most 60 s to every base", async () => {
    const before = Date.now();
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, []),
    );
    await run({ query: "q", kbIds: [id("a"), id("b"), id("c")] });
    const deadlines = new Set(mocks.search.mock.calls.map((call) => call[0].deadlineAt));
    expect(deadlines.size).toBe(1);
    const [deadline] = [...deadlines];
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe("existence", () => {
  it("a missing and an unreadable base give byte-identical replies", async () => {
    mocks.search.mockRejectedValueOnce(new KbDomainError("NOT_FOUND", "Knowledge base not found"));
    const missing = await run({ query: "q", kbIds: [id("a")] });
    mocks.search.mockRejectedValueOnce(new KbDomainError("FORBIDDEN", "Forbidden"));
    const unreadable = await run({ query: "q", kbIds: [id("a")] });
    expect(JSON.stringify(unreadable)).toBe(JSON.stringify(missing));
    expect(missing.knowledgeBases).toEqual([bare(id("a"), "not_found")]);
    // Neither is re-authorized: there is nothing more to hide.
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["authorize", new KbDomainError("RATE_LIMITED", "r", 9)],
    ["authorize", new KbDomainError("INDEX_UNAVAILABLE", "u")],
    ["recheck", new KbDomainError("STORAGE_UNAVAILABLE", "s")],
  ])("a failure is not_found when the error-path %s fails (%s)", async (which, error) => {
    mocks.search.mockRejectedValue(error);
    if (which === "authorize")
      mocks.authorize.mockRejectedValue(new KbDomainError("NOT_FOUND", "n"));
    else recheck.mockRejectedValueOnce(new KbDomainError("FORBIDDEN", "f"));
    const out = await run({ query: "q", kbIds: [id("a")] });
    expect(out.knowledgeBases).toEqual([bare(id("a"), "not_found")]);
    expect(mocks.loadIndexStatus).not.toHaveBeenCalled();
  });

  it("re-authorizes a failure for read right after it, as dispatchTool's error path does", async () => {
    mocks.search.mockRejectedValue(new KbDomainError("RATE_LIMITED", "r", 3));
    await run({ query: "q", kbIds: [id("a")] });
    expect(mocks.authorize.mock.calls[0]![0]).toMatchObject({
      principal: actor.principal,
      kbId: id("a"),
      operation: "read",
    });
  });

  it("the final check drops the hits of a base that lost access", async () => {
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, [0.3, 0.2]),
    );
    mocks.authorizeDocumentRead.mockImplementation(async (input: { kbId: string }) => {
      if (input.kbId === id("b")) throw new KbDomainError("NOT_FOUND", "n");
    });
    const out = await run({ query: "q", kbIds: [id("a"), id("b")] });
    expect(out.knowledgeBases[1]).toEqual(bare(id("b"), "not_found"));
    expect(out.results.every((h) => h.knowledgeBaseId === id("a"))).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("the final check also covers failed and unstarted rows", async () => {
    mocks.search.mockRejectedValue(new KbDomainError("RATE_LIMITED", "r", 3));
    // Readable right after the failure, gone at the final check.
    mocks.authorize
      .mockResolvedValueOnce({ state: "ACTIVE" })
      .mockRejectedValueOnce(new KbDomainError("NOT_FOUND", "n"));
    const out = await run({ query: "q", kbIds: [id("a")] });
    expect(out.knowledgeBases).toEqual([bare(id("a"), "not_found")]);
  });

  it("a failing final connection recheck fails the whole call", async () => {
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) =>
      served(input.kbId, [0.1]),
    );
    recheck.mockRejectedValueOnce(new KbDomainError("FORBIDDEN", "f"));
    await expect(run({ query: "q", kbIds: [id("a")] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("lanes, cancellation and whole-call failures", () => {
  it(`runs at most ${SEARCH_ALL_LANES} base searches at once, in list order`, async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return served(input.kbId, []);
    });
    const ids = ["a", "b", "c", "d", "e", "f"].map(id);
    await run({ query: "q", kbIds: ids });
    expect(peak).toBe(2);
    expect(searchedIds()).toEqual(ids);
  });

  it("cancel fails the call CANCELLED only after every in-flight base settled", async () => {
    const controller = new AbortController();
    const settled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.search.mockImplementation(
      async (_o, _a, input: { kbId: string }, signal: AbortSignal) => {
        if (input.kbId === id("a")) controller.abort();
        await gate;
        settled.push(input.kbId);
        if (signal.aborted) throw new KbDomainError("CANCELLED", "Cancelled");
        return served(input.kbId, []);
      },
    );
    const call = run({ query: "q", kbIds: ["a", "b", "c", "d"].map(id) }, controller.signal);
    let done = false;
    void call
      .catch(() => {})
      .finally(() => {
        done = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    release();
    await expect(call).rejects.toMatchObject({ code: "CANCELLED" });
    // The two lanes' bases settled; nothing new started after the abort.
    expect(settled.sort()).toEqual([id("a"), id("b")]);
    expect(searchedIds()).toEqual([id("a"), id("b")]);
  });

  it("a sensitive query fails the whole call before any base", async () => {
    await expect(
      run({ query: `key sk-${"a".repeat(40)}`, kbIds: [id("a")] }),
    ).rejects.toMatchObject({ code: "SENSITIVE_QUERY" });
    await expect(run({ query: `key sk-${"a".repeat(40)}` })).rejects.toMatchObject({
      code: "SENSITIVE_QUERY",
    });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("invalid input fails the whole call", async () => {
    for (const raw of [{ query: "" }, { query: "q", kbIds: [] }, { query: "q", limitPerBase: 11 }])
      await expect(run(raw)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("an INVALID_ARGUMENT from a base fails the whole call after the lanes settle", async () => {
    let otherSettled = false;
    mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) => {
      if (input.kbId === id("a")) throw new KbDomainError("INVALID_ARGUMENT", "x");
      await new Promise((resolve) => setTimeout(resolve, 10));
      otherSettled = true;
      return served(input.kbId, []);
    });
    await expect(run({ query: "q", kbIds: ["a", "b", "c"].map(id) })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(otherSettled).toBe(true);
    expect(searchedIds()).toEqual([id("a"), id("b")]);
  });

  it("never logs the query", async () => {
    const query = "CANARY_QUERY_TEXT";
    const logged = captureLog();
    try {
      mocks.search.mockImplementation(async (_o, _a, input: { kbId: string }) => {
        if (input.kbId === id("a")) throw new Error(`failed for ${query}`);
        throw new KbDomainError("STORAGE_UNAVAILABLE", `storage ${query}`);
      });
      await run({ query, kbIds: [id("a"), id("b")] });
      expect(logged.records).toHaveLength(2);
      expect(JSON.stringify(logged.records)).not.toContain(query);
      expect(logged.records[0]).toMatchObject({ tool: "knowledge_search_all", code: "INTERNAL" });
    } finally {
      logged.restore();
    }
  });
});
