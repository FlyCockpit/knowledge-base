import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { readDocumentAtRevision } from "@knowledge-base/api/lib/kb/documents-read";
import {
  EmbedderCallError,
  EmbeddingInputTooLongError,
} from "@knowledge-base/api/lib/kb/embed-client";
import type { Embedder } from "@knowledge-base/api/lib/kb/embedder";
import { requestIndexBuild, scheduleIndexBuild } from "@knowledge-base/api/lib/kb/generations";
import { startTestIndexReader } from "@knowledge-base/api/lib/kb/index-file/testing";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import {
  AUTHORITY_LOCK_CLASSID,
  AUTHORITY_LOCK_OBJID,
  type LockQuery,
} from "@knowledge-base/api/lib/kb/lock";
import { parseMarkdownDocument } from "@knowledge-base/api/lib/kb/parse-markdown";
import { createProvider } from "@knowledge-base/api/lib/kb/providers";
import type { QueryEmbeddingOptions } from "@knowledge-base/api/lib/kb/query-embedding";
import { withQueryCapacity, withQueryEmbedding } from "@knowledge-base/api/lib/kb/query-embedding";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { searchKnowledgeBase } from "@knowledge-base/api/lib/kb/search";
import { extractTableRows } from "@knowledge-base/api/lib/kb/structured";
import {
  type StructuredSearchInput,
  type StructuredSearchOptions,
  type StructuredSearchResult,
  structuredCursorBinding,
  structuredSearchKnowledgeBase,
} from "@knowledge-base/api/lib/kb/structured-search";
import type { PrismaClient } from "@knowledge-base/db/client";
import { captureLog } from "@knowledge-base/env/log";
import { Queue } from "bullmq";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deliverIndexBuild } from "./index-delivery";
import { openKbPostgresClusterFromEnv } from "./postgres";
import { openKbRedisFromEnv } from "./redis";

/** L-25: replies carry the fused RRF sum over its maximum for the arms that ran (rrf * 61 / arms). */
const normalizedRrfScore = (rrf: number, arms: 1 | 2) => (rrf * 61) / arms;

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
const { runQueryEmbeddingDelivery } = (await import(
  new URL("../../../../apps/worker/src/handlers/query-embedding.ts", import.meta.url).href
)) as {
  runQueryEmbeddingDelivery(
    db: PrismaClient,
    options: QueryEmbeddingOptions & {
      durableJobId: string;
      workerId: string;
      embedder?: Embedder;
    },
  ): Promise<{ accepted?: boolean; skipped?: boolean }>;
};

type Expected = { path: string; chunkIndex: number; matchedRow: Record<string, unknown> | null };
type HybridExpected = Expected & { vectorRank: number; ftsRank: number | null };
/** Shared with the local Rust backend: exact filters, spans and golden ranking must match. */
const golden = JSON.parse(
  readFileSync(
    new URL("../../../api/src/lib/kb/fixtures/structured-search.json", import.meta.url),
    "utf8",
  ),
) as {
  commitTimestamp: string;
  documents: Record<string, string>;
  structured: { name: string; input: Record<string, unknown>; expected: Expected[] }[];
  hybrid: { name: string; input: Record<string, unknown>; expected: HybridExpected[] }[];
};

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();

const prisma = db.createPrismaClient("runtime");
const redis = openKbRedisFromEnv();
const queue = new Queue("kb-structured", {
  connection: redis.client(),
  prefix: redis.key("bull"),
});
const reposDir = mkdtempSync(join(tmpdir(), "kb-structured-"));
const indexDir = mkdtempSync(join(tmpdir(), "kb-structured-index-"));
const reader = await startTestIndexReader(indexDir);
const masterKey = Buffer.alloc(32, 27).toString("base64");
const ratePort = createMemoryRatePort();
const cursorSigner = createCursorSigner(randomBytes(32));
const opts: StructuredSearchOptions = {
  connectionString: db.urls.runtime,
  masterKey,
  ratePort,
  cursorSigner,
};
const runtime: KbRuntimeConfig = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir,
  assetsDir: "/unused",
  blobStore: createDiskBlobStore("/unused"),
  canonicalOrigin: "https://kb.example.invalid",
  cursorSigner,
  ratePort,
  diskMeter: { freeBytes: async () => 1n << 40n },
  coordinator: {
    run: (o) =>
      runLockedOperation({
        connectionString: db.urls.runtime,
        opId: o.opId,
        kind: "authority",
        run: (lease) =>
          o.run({
            lease,
            signal: lease.scope.signal,
            issueWriteCapability: () => {
              throw new Error("No canonical writes");
            },
          }),
      }),
  },
};
const key = () => randomUUID().replaceAll("-", "");
const id = () => `s${key().slice(0, 23)}`;
const tx = <T>(run: (q: LockQuery) => Promise<T>) =>
  runtime.coordinator.run({
    opId: randomUUID(),
    kind: "authority",
    run: ({ lease }) => lease.transaction(run),
  });

/** The search.json fixture model: normalize([1 + #alpha, 1 + #beta]). */
function fixtureVector(text: string) {
  const words = text.toLowerCase().split(/\s+/);
  const a = 1 + words.filter((w) => w === "alpha").length;
  const b = 1 + words.filter((w) => w === "beta").length;
  const n = Math.hypot(a, b);
  return [a / n, b / n];
}
const embedder: Embedder = {
  embed: async (texts, o) => {
    await o?.beforeDispatch?.();
    return texts.map(fixtureVector);
  },
};
function commit(kbId: string, files: Record<string, string>, parent?: string) {
  const repo = join(reposDir, `kb_${kbId}.git`);
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: golden.commitTimestamp,
    GIT_COMMITTER_DATE: golden.commitTimestamp,
  };
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8" }).trim();
  if (!parent) execFileSync("git", ["init", "--bare", repo], { env, stdio: "ignore" });
  const blob = (body: string) => git(["hash-object", "-w", "--stdin"], body);
  const tree = (entries: Record<string, string>): string => {
    const dirs = new Map<string, Record<string, string>>();
    const rows: string[] = [];
    for (const [path, body] of Object.entries(entries)) {
      const [head, ...rest] = path.split("/");
      if (rest.length) dirs.set(head!, { ...dirs.get(head!), [rest.join("/")]: body });
      else rows.push(`100644 blob ${blob(body)}\t${head}`);
    }
    for (const [dir, children] of dirs) rows.push(`040000 tree ${tree(children)}\t${dir}`);
    return git(["mktree"], `${rows.sort().join("\n")}\n`);
  };
  const manifest = `${JSON.stringify({ version: 1, entries: [] })}\n`;
  const root = tree({ ...files, ".assets/manifest.json": manifest });
  const sha = git(["commit-tree", root, ...(parent ? ["-p", parent] : []), "-m", "fixture"]);
  git(["update-ref", "refs/heads/main", sha]);
  return sha;
}
async function user() {
  return prisma.user.create({
    data: {
      id: id(),
      name: "Fixture",
      email: `${id()}@example.invalid`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
}
async function publish() {
  await runDurableDispatcherCycle({
    db: prisma,
    ownerId: "structured-search-test",
    now: () => new Date(),
    getQueue: () => queue,
  });
}
async function build(jobId: string, builder: Embedder = embedder) {
  await publish();
  return deliverIndexBuild(prisma, {
    connectionString: db.urls.runtime,
    indexDir,
    reposDir,
    masterKey,
    workerId: key(),
    durableJobId: jobId,
    embedder: builder,
  });
}
async function fixture(
  files: Record<string, string> = golden.documents,
  builder: Embedder = embedder,
) {
  const owner = await user();
  const reader = await user();
  const other = await user();
  const kbId = id();
  const sha = commit(kbId, files);
  await prisma.knowledgeBase.create({
    data: {
      id: kbId,
      ownerId: owner.id,
      name: "Structured KB",
      slug: key(),
      description: "Structured search fixture knowledge base",
      state: "ACTIVE",
      headSha: sha,
    },
  });
  await prisma.kbShare.create({ data: { kbId, userId: reader.id, bits: ["read"] } });
  await prisma.kbShare.create({ data: { kbId, userId: other.id, bits: ["read"] } });
  const created = await createProvider(
    runtime,
    owner.id,
    {
      name: "Fixture",
      model: "fixture",
      endpointUrl: "https://provider.example.invalid/embeddings",
      dimensions: 2,
      apiKey: "test-only-structured-key",
      idempotencyKey: key(),
    },
    masterKey,
  );
  await prisma.durableJob.update({ where: { id: created.jobId }, data: { state: "COMPLETE" } });
  const attached = await requestIndexBuild(
    runtime,
    { principal: { kind: "browser", userId: owner.id } },
    {
      kbId,
      providerId: created.provider.providerId,
      revision: 1,
      idempotencyKey: key(),
      confirm: "RUN",
    },
  );
  expect(await build(attached.jobId, builder)).toBe("COMPLETE");
  const actor = { principal: { kind: "browser" as const, userId: reader.id } };
  const otherActor = { principal: { kind: "browser" as const, userId: other.id } };
  return { owner, reader, kbId, sha, actor, otherActor, generationId: attached.generationId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Actor = Fixture["actor"];

/** Runs one page; a query page's leased embedding is delivered through the worker adapter. */
async function page(
  f: Fixture,
  input: Omit<StructuredSearchInput, "kbId">,
  options: Partial<StructuredSearchOptions> = {},
  actor: Actor = f.actor,
  queryEmbedder: Embedder = embedder,
): Promise<StructuredSearchResult | Error> {
  let settled = false;
  const pending = structuredSearchKnowledgeBase({ ...opts, ...options }, actor, {
    kbId: f.kbId,
    ...input,
  } as StructuredSearchInput)
    .catch((error: Error) => error)
    .finally(() => {
      settled = true;
    });
  if (input.query !== undefined) {
    let request: { id: string } | null = null;
    for (let i = 0; i < 200 && !request && !settled; i++) {
      request = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      if (!request) await new Promise((r) => setTimeout(r, 10));
    }
    if (request) {
      await publish();
      await runQueryEmbeddingDelivery(prisma, {
        connectionString: db.urls.runtime,
        masterKey,
        durableJobId: request.id,
        workerId: key(),
        embedder: queryEmbedder,
      }).catch(() => {});
    }
  }
  return pending;
}
async function ok(f: Fixture, input: Omit<StructuredSearchInput, "kbId">) {
  // Golden/replay checks get an independent rate window; the quota regression below uses a shared port.
  const result = await page(f, input, { ratePort: createMemoryRatePort() });
  if (result instanceof Error) throw result;
  return result;
}
/** Follows nextCursor to the end and returns every item in order. */
async function all(f: Fixture, input: Omit<StructuredSearchInput, "kbId">) {
  const items: StructuredSearchResult["items"] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const result: StructuredSearchResult = await ok(f, { ...input, ...(cursor ? { cursor } : {}) });
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) return items;
  }
  throw new Error("pagination did not terminate");
}
const project = (items: StructuredSearchResult["items"]) =>
  items.map(({ path, chunkIndex, matchedRow }) => ({ path, chunkIndex, matchedRow }));
const leases = (kbId: string) => prisma.generationLease.count({ where: { generation: { kbId } } });
async function swap(f: Fixture, files: Record<string, string>) {
  const head = commit(f.kbId, files, f.sha);
  const b = await tx(async (q) => {
    await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
    return scheduleIndexBuild(q, f.kbId);
  });
  expect(await build(b!.jobId)).toBe("COMPLETE");
  const kb = await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } });
  expect(kb.activeGenerationId).toBe(b!.generationId);
  return { head, generationId: b!.generationId };
}

afterAll(async () => {
  await queue.close();
  await redis.close();
  await prisma.$disconnect();
  await cluster.close();
  await reader.stop();
  rmSync(reposDir, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

describe("structured search", () => {
  it("matches the golden exact-filter corpus with source spans, one page or many", async () => {
    const f = await fixture();
    for (const { name, input, expected } of golden.structured) {
      const whole = await ok(f, { ...input, limit: 50 });
      expect(project(whole.items), name).toEqual(expected);
      expect(whole).toMatchObject({
        generationId: f.generationId,
        freshness: "current",
        indexedCommitSha: f.sha,
        headSha: f.sha,
        nextCursor: null,
      });
      for (const hit of whole.items)
        expect(hit).toMatchObject({
          mode: "structured",
          score: 1,
          commitSha: f.sha,
          indexGenerationId: f.generationId,
          knowledgeBaseId: f.kbId,
        });
      // Keyset pages of one reproduce the exact same order without gaps or duplicates.
      expect(project(await all(f, { ...input, limit: 1 })), name).toEqual(expected);
    }
    // The immutable citation window contains the exact stored row source span.
    const [row] = (await ok(f, golden.structured[0]!.input)).items;
    const source = await tx((q) =>
      readDocumentAtRevision({
        reposDir,
        kbId: f.kbId,
        commitSha: row!.commitSha,
        path: row!.path,
        query: q,
      }),
    );
    expect(source.blobSha).toBe(row!.blobSha);
    expect(source.contentHash).toBe(row!.contentHash);
    const parsed = parseMarkdownDocument(Buffer.from(source.markdown, "utf8"));
    if (!("body" in parsed)) throw new Error("fixture parse");
    const window = Buffer.from(parsed.body, "utf8")
      .subarray(row!.span.startByte, row!.span.endByte)
      .toString("utf8");
    expect(window).toContain("| Ada | 36 | true | null |");
    expect(await leases(f.kbId)).toBe(0);
  });

  it("applies exact filters inside both hybrid arms before RRF, with golden ranking", async () => {
    const f = await fixture();
    for (const { name, input, expected } of golden.hybrid) {
      const result = await ok(f, { ...input, limit: 50 });
      expect(
        result.items.map(({ path, chunkIndex, matchedRow, score, mode }) => ({
          path,
          chunkIndex,
          matchedRow,
          score,
          mode,
        })),
        name,
      ).toEqual(
        expected.map((row) => ({
          path: row.path,
          chunkIndex: row.chunkIndex,
          matchedRow: row.matchedRow,
          score: normalizedRrfScore(
            1 / (60 + row.vectorRank) + (row.ftsRank ? 1 / (60 + row.ftsRank) : 0),
            2,
          ),
          mode: "hybrid",
        })),
      );
    }
    // Filters are inside the arms: the only FTS match (prose.md) is excluded before fusion, so
    // roster documents arrive through the vector arm alone and prose.md never appears.
    const filtered = await ok(f, { query: "prose", type: "roster" });
    expect(filtered.items.map((h) => [h.path, h.score])).toEqual([
      ["plans.md", normalizedRrfScore(1 / 61, 2)],
      ["people.md", normalizedRrfScore(1 / 62, 2)],
    ]);
    expect(await leases(f.kbId)).toBe(0);
  });

  it("cursors pin the page's ranking mode across embedder failure and recovery", async () => {
    const f = await fixture();
    const failing: Embedder = { embed: async () => Promise.reject(new EmbedderCallError()) };
    const fresh = () => ({ ratePort: createMemoryRatePort() });
    // Failure, then recovery: every continuation stays keyword-ranked, none repeats.
    let result = await page(f, { query: "alpha", limit: 1 }, fresh(), f.actor, failing);
    if (result instanceof Error) throw result;
    const seen = result.items.map((hit) => `${hit.path}#${hit.chunkIndex}`);
    expect(result.items.every((hit) => hit.mode === "lexical")).toBe(true);
    while (result.nextCursor) {
      const next: StructuredSearchResult | Error = await page(
        f,
        { query: "alpha", limit: 1, cursor: result.nextCursor },
        fresh(),
      );
      if (next instanceof Error) throw next;
      expect(next.items.every((hit) => hit.mode === "lexical")).toBe(true);
      expect(next.indexNotices).toMatchObject([{ code: "LEXICAL_ONLY" }]);
      for (const hit of next.items) {
        expect(seen).not.toContain(`${hit.path}#${hit.chunkIndex}`);
        seen.push(`${hit.path}#${hit.chunkIndex}`);
      }
      result = next;
    }
    expect(seen.length).toBeGreaterThan(1);
    // Hybrid first page, then the embedder fails: its keys cannot continue by keyword.
    const hybrid = await page(f, { query: "alpha", limit: 1 }, fresh());
    if (hybrid instanceof Error) throw hybrid;
    expect(hybrid.items.every((hit) => hit.mode === "hybrid")).toBe(true);
    expect(
      await page(
        f,
        { query: "alpha", limit: 1, cursor: hybrid.nextCursor! },
        fresh(),
        f.actor,
        failing,
      ),
    ).toMatchObject({ code: "INVALID_CURSOR" });
    expect(await leases(f.kbId)).toBe(0);
  });

  it("serves the lexical arm when the model rejects the query as too long (query purpose)", async () => {
    const f = await fixture();
    const tooLong: Embedder = {
      embed: async () => Promise.reject(new EmbeddingInputTooLongError()),
    };
    const result = await page(f, { query: "Ada", type: "roster" }, {}, f.actor, tooLong);
    const items = (result as { items: Array<{ mode: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(await leases(f.kbId)).toBe(0);
  });

  it("serves the lexical arm, never the queryless operation, when the query embed fails", async () => {
    const f = await fixture();
    const failing: Embedder = { embed: async () => Promise.reject(new EmbedderCallError()) };
    const result = await page(f, { query: "Ada", type: "roster" }, {}, f.actor, failing);
    expect(result).toMatchObject({
      indexNotices: [
        { kbId: f.kbId, code: "LEXICAL_ONLY", detail: "EMBEDDING_PROFILE_UNAVAILABLE" },
      ],
    });
    const items = (result as { items: Array<{ mode: string }> }).items;
    expect(items.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(await leases(f.kbId)).toBe(0);
    // The explicit queryless operation still works for the same filters.
    expect((await ok(f, { type: "roster" })).items.map((h) => h.mode)).toEqual([
      "structured",
      "structured",
    ]);
  });

  it("keeps the pinned generation's ordering across an active swap, for both modes", async () => {
    const f = await fixture();
    const queryless = await ok(f, { tags: ["work"], limit: 1 });
    const hybrid = await ok(f, {
      query: "Ada",
      structured: [{ column: "name", equals: "Ada" }],
      limit: 1,
    });
    expect(project(queryless.items)).toEqual([golden.structured[17]!.expected[0]]);
    expect(hybrid.items.map((h) => h.path)).toEqual(["plans.md"]);
    // B removes plans.md's work tag and Ada row and adds a new work document before it.
    const newer = await swap(f, {
      ...golden.documents,
      "pa.md": "---\ntags: [work]\n---\n| name |\n|---|\n| Ada |\n",
      "plans.md": "---\ntype: roster\n---\nnothing here\n",
    });
    const rest = await ok(f, { tags: ["work"], limit: 1, cursor: queryless.nextCursor! });
    expect(project(rest.items)).toEqual([golden.structured[17]!.expected[1]]);
    expect(rest).toMatchObject({
      generationId: f.generationId,
      indexedCommitSha: f.sha,
      headSha: newer.head,
      freshness: "stale",
      nextCursor: null,
    });
    const hybridRest = await ok(f, {
      query: "Ada",
      structured: [{ column: "name", equals: "Ada" }],
      limit: 1,
      cursor: hybrid.nextCursor!,
    });
    expect(hybridRest.items.map((h) => [h.path, h.indexGenerationId, h.commitSha])).toEqual([
      ["people.md", f.generationId, f.sha],
    ]);
    expect(hybridRest).toMatchObject({ generationId: f.generationId, nextCursor: null });
    // A fresh first page uses the new active generation.
    const fresh = await ok(f, { tags: ["work"] });
    expect(fresh.generationId).toBe(newer.generationId);
    expect(fresh.items.map((h) => h.path)).toEqual(["pa.md", "people.md"]);
    expect(await leases(f.kbId)).toBe(0);
  });

  it("rejects tampered, foreign, re-filtered, expired and unretained-generation cursors", async () => {
    const f = await fixture();
    const input = { tags: ["work"], limit: 1 };
    const first = await ok(f, input);
    const cursor = first.nextCursor!;
    const refused = [
      await page(f, { ...input, cursor: `${cursor.slice(0, -3)}AAA` }),
      await page(f, { ...input, cursor }, {}, f.otherActor),
      await page(f, { ...input, type: "roster", cursor }),
      await page(f, { ...input, cursor }, { cursorSigner: createCursorSigner(randomBytes(32)) }),
    ];
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60 * 1000);
    try {
      refused.push(await page(f, { ...input, cursor }));
    } finally {
      clock.mockRestore();
    }
    // Validly signed pins of a generation that is not retained, or of another commit, never repin.
    const binding = structuredCursorBinding(f.actor, f.kbId, "structured", null, input);
    const payload = cursorSigner.verify(cursor, { ...binding, sortKey: "*", revision: "*" });
    for (const forged of [
      { ...payload, sortKey: id() },
      { ...payload, revision: "0".repeat(40) },
    ])
      refused.push(await page(f, { ...input, cursor: cursorSigner.sign(forged) }));
    for (const result of refused) expect(result).toMatchObject({ code: "INVALID_CURSOR" });
    // The original cursor is still good for its own actor and filters.
    expect((await ok(f, { ...input, cursor })).items.map((h) => h.path)).toEqual(["plans.md"]);
  });

  it("denies the final page after revocation, and a page revoked before its reply", async () => {
    const f = await fixture();
    const first = await ok(f, { tags: ["work"], limit: 1 });
    const g = await fixture();
    const revoke = (x: Fixture) =>
      tx((q) =>
        q('UPDATE kb_share SET "revokedAt"=now() WHERE "kbId"=$1 AND "userId"=$2', [
          x.kbId,
          x.reader.id,
        ]),
      );
    await revoke(f);
    const denied = await page(f, { tags: ["work"], limit: 1, cursor: first.nextCursor! });
    expect(denied).toMatchObject({ code: "NOT_FOUND" });
    expect(denied).not.toHaveProperty("items");
    const midPage = await page(
      g,
      { type: "roster" },
      {
        hooks: {
          afterRead: async () => {
            await revoke(g);
          },
        },
      },
    );
    expect(midPage).toMatchObject({ code: "NOT_FOUND" });
    expect(midPage).not.toHaveProperty("items");
  });
});

const waitUntil = async (check: () => Promise<boolean>) => {
  for (let n = 0; n < 400; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("barrier was not reached");
};
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe("R27 admission and row regressions", () => {
  it("charges each queryless continuation once and rejects operation 31; hybrid spends one point", async () => {
    const f = await fixture();
    const ratePort = createMemoryRatePort();
    const first = await page(f, { tags: ["work"], limit: 1 }, { ratePort });
    if (first instanceof Error) throw first;
    expect(first.nextCursor).not.toBeNull();
    expect(
      await page(f, { tags: ["work"], limit: 1, cursor: first.nextCursor! }, { ratePort }),
    ).not.toBeInstanceOf(Error);
    expect(await page(f, { query: "Ada", type: "roster" }, { ratePort })).not.toBeInstanceOf(Error);
    expect(ratePort.counts.get(`kb:query:${f.reader.id}:${f.kbId}`)).toBe(3);
    for (let n = 3; n < 30; n++)
      expect(await page(f, { type: "roster" }, { ratePort })).not.toBeInstanceOf(Error);
    expect(ratePort.counts.get(`kb:query:${f.reader.id}:${f.kbId}`)).toBe(30);
    expect(await page(f, { type: "roster" }, { ratePort })).toMatchObject({ code: "RATE_LIMITED" });
    expect(await leases(f.kbId)).toBe(0);
  });

  it("shares four slots across hybrid and queryless operations and retains a cancelled consumer slot until drain", async () => {
    const f = await fixture();
    const pauses = [barrier(), barrier(), barrier(), barrier()];
    const reached = new Set<number>();
    const aborts = pauses.map(() => new AbortController());
    const pending = pauses.map((pause, n) => {
      const options = { ...opts, ratePort: createMemoryRatePort() };
      const consume = async () => {
        reached.add(n);
        await pause.promise;
      };
      return (
        n === 0
          ? withQueryEmbedding(
              options,
              f.actor,
              { kbId: f.kbId, query: "Ada" },
              consume,
              aborts[n]!.signal,
            )
          : structuredSearchKnowledgeBase(
              { ...options, hooks: { afterRead: consume } },
              f.actor,
              { kbId: f.kbId, type: "roster" },
              aborts[n]!.signal,
            )
      ).catch((error: Error) => error);
    });
    try {
      await waitUntil(
        async () =>
          (await prisma.queryEmbeddingRequest.count({
            where: { kbId: f.kbId, state: "PENDING" },
          })) === 1,
      );
      const request = await prisma.queryEmbeddingRequest.findFirstOrThrow({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      await publish();
      await runQueryEmbeddingDelivery(prisma, {
        connectionString: db.urls.runtime,
        masterKey,
        durableJobId: request.id,
        workerId: key(),
        embedder,
      });
      await waitUntil(async () => reached.size === 4);
      expect(await page(f, { type: "roster" })).toMatchObject({ code: "RATE_LIMITED" });
      aborts[0]!.abort();
      // Cancellation has won the deadline race, but consume is still draining.
      expect(await page(f, { type: "roster" })).toMatchObject({ code: "RATE_LIMITED" });
      pauses[0]!.release();
      expect(await pending[0]).toMatchObject({ code: "CANCELLED" });
      expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
    } finally {
      for (const controller of aborts) controller.abort();
      for (const pause of pauses) pause.release();
      await Promise.all(pending);
    }
    expect(await leases(f.kbId)).toBe(0);
    expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
  });

  it("retains reader capacity after owner connection loss until a half-open backend drains", async () => {
    const f = await fixture();
    const hold = barrier();
    const drain = barrier();
    let ready = 0;
    let cleanupReady = false;
    let readerName = "";
    const held = Array.from({ length: 3 }, () =>
      withQueryCapacity(opts, f.actor, async () => {
        ready++;
        await hold.promise;
      }).catch((error: Error) => error),
    );
    const upstream = new URL(db.urls.runtime);
    const sockets = new Set<Socket>();
    // Real PostgreSQL relay: lose the reader's FIN, then park only cleanup's
    // startup briefly. No SQL/auth bytes are modified, decoded or logged.
    const relay = createServer((front) => {
      const back = new Socket();
      sockets.add(front);
      sockets.add(back);
      let startup = Buffer.alloc(0);
      let started = false;
      let reader = false;
      front.on("error", () => {});
      back.on("error", () => front.destroy());
      front.on("close", () => {
        if (!reader) back.destroy();
      });
      back.on("close", () => front.destroy());
      back.on("data", (data) => {
        if (!front.destroyed) front.write(data);
      });
      front.on("data", (data: Buffer) => {
        if (started) {
          back.write(data);
          return;
        }
        startup = Buffer.concat([startup, data]);
        if (startup.length > 4096) {
          front.destroy();
          back.destroy();
          return;
        }
        if (startup.length < 4 || startup.length < startup.readInt32BE(0)) return;
        started = true;
        // The disposable fixture uses plaintext startup (no SSL negotiation).
        const fields = startup.subarray(8).toString("utf8").split("\0");
        const app = fields[fields.indexOf("application_name") + 1] ?? "";
        reader = app.startsWith("kb-search-") && !app.startsWith("kb-search-drain-");
        if (reader) readerName = app;
        const connect = () => {
          back.connect(Number(upstream.port), upstream.hostname, () => back.write(startup));
        };
        if (app.startsWith("kb-search-drain-")) {
          cleanupReady = true;
          void drain.promise.then(connect);
        } else connect();
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("relay address missing");
    const viaRelay = new URL(db.urls.runtime);
    viaRelay.hostname = "127.0.0.1";
    viaRelay.port = String(address.port);
    const blocker = new Client({ connectionString: db.urls.applier });
    const observer = new Client({ connectionString: db.urls.runtime });
    await blocker.connect();
    await observer.connect();
    let pending: Promise<StructuredSearchResult | Error> | undefined;
    let settled = false;
    try {
      await waitUntil(async () => ready === 3);
      await blocker.query("BEGIN");
      // EXCLUSIVE admits plain reads but blocks the page's FOR KEY SHARE of its generation.
      await blocker.query("LOCK TABLE index_generation IN EXCLUSIVE MODE");
      pending = structuredSearchKnowledgeBase(
        { ...opts, connectionString: viaRelay.href, deadlineAt: Date.now() + 12_000 },
        f.actor,
        { kbId: f.kbId, type: "roster" },
      )
        .catch((error: Error) => error)
        .finally(() => {
          settled = true;
        });
      let readPid = 0;
      await waitUntil(async () => {
        const r = await observer.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
          [readerName],
        );
        readPid = r.rows[0]?.pid ?? 0;
        return readPid !== 0;
      });
      const owner = await observer.query<{ pid: number }>(
        `SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
         WHERE a.application_name LIKE 'kb-query-capacity-%' AND l.locktype='advisory'
         AND l.granted AND l.objsubid=1
         AND l.classid=((hashtextextended($1,0)>>32)&4294967295)::oid
         AND l.objid=(hashtextextended($1,0)&4294967295)::oid`,
        [`kb:query-slot:${f.actor.principal.userId}:3`],
      );
      expect(owner.rows).toHaveLength(1);
      await observer.query("SELECT pg_terminate_backend($1)", [owner.rows[0]!.pid]);
      await waitUntil(async () => cleanupReady || settled);
      expect(
        (await observer.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [readPid])).rowCount,
      ).toBe(1);
      let fifthEntered = false;
      expect(
        await page(
          f,
          { type: "roster" },
          {
            hooks: {
              beforeRead: async () => {
                fifthEntered = true;
                throw new Error("admitted fifth search");
              },
            },
          },
        ),
      ).toMatchObject({ code: "RATE_LIMITED" });
      expect(fifthEntered).toBe(false);
      drain.release();
      expect(await pending).toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(
        (await observer.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [readPid])).rowCount,
      ).toBe(0);
      await blocker.query("ROLLBACK");
      expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
    } finally {
      drain.release();
      hold.release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end();
      await observer.end();
      await Promise.allSettled([...held, ...(pending ? [pending] : [])]);
    }
  });

  it("fails closed on a rate-store failure and releases capacity for re-entry", async () => {
    const f = await fixture();
    expect(
      await page(
        f,
        { type: "roster" },
        { ratePort: { consume: async () => ({ unavailable: true }) } },
      ),
    ).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
    expect(await leases(f.kbId)).toBe(0);
  });

  it("enforces an elapsed deadline before I/O and the same deadline after an earlier phase while PG waits", async () => {
    const f = await fixture();
    expect(await page(f, { type: "roster" }, { deadlineAt: Date.now() - 1 })).toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    const blocker = new Client({ connectionString: db.urls.runtime });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM index_generation WHERE id=$1 FOR UPDATE", [f.generationId]);
    try {
      const deadlineAt = Date.now() + 800;
      const result = await page(
        f,
        { type: "roster" },
        {
          deadlineAt,
          hooks: {
            beforeRead: async () => {
              await new Promise((resolve) => setTimeout(resolve, 200));
            },
          },
        },
      );
      expect(result).toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(Date.now()).toBeLessThan(deadlineAt + 1000);
      // The killed reader has left no backend waiting on this lock.
      const waiting = await blocker.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR KEY SHARE OF g%'`,
      );
      expect(waiting.rows[0]!.count).toBe(0);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
  });

  it("cancels a real blocked queryless statement and drains it before releasing capacity", async () => {
    const f = await fixture();
    const blocker = new Client({ connectionString: db.urls.runtime });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM index_generation WHERE id=$1 FOR UPDATE", [f.generationId]);
    const abort = new AbortController();
    const pending = structuredSearchKnowledgeBase(
      opts,
      f.actor,
      { kbId: f.kbId, type: "roster" },
      abort.signal,
    ).catch((error: Error) => error);
    try {
      await waitUntil(async () => {
        const result = await db.query(
          "runtime",
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR KEY SHARE OF g%'`,
        );
        return result.rows[0]!.count === 1;
      });
      const start = Date.now();
      abort.abort();
      expect(await pending).toMatchObject({ code: "CANCELLED" });
      expect(Date.now() - start).toBeLessThan(1500);
      const remaining = await db.query(
        "runtime",
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR KEY SHARE OF g%'`,
      );
      expect(remaining.rows[0]!.count).toBe(0);
    } finally {
      abort.abort();
      await blocker.query("ROLLBACK");
      await blocker.end();
      await pending;
    }
    expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
  });

  it.each(["cancel", "deadline"])(
    "R46r5 F4: %s at final recency admission drains the authority waiter without recording the read",
    async (exit) => {
      const f = await fixture();
      const stamp = async () =>
        (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).lastQueriedAt;
      expect(await stamp()).toBeNull();
      const blocker = new Client({ connectionString: db.urls.runtime });
      await blocker.connect();
      const read = barrier();
      const abort = new AbortController();
      const pending = structuredSearchKnowledgeBase(
        {
          ...opts,
          // Isolate abort from the deadline fault; both retain the real 5s lock budget.
          deadlineAt: exit === "deadline" ? Date.now() + 3000 : undefined,
          hooks: {
            afterRead: async () => {
              await blocker.query("SELECT pg_advisory_lock($1,$2)", [
                AUTHORITY_LOCK_CLASSID,
                AUTHORITY_LOCK_OBJID,
              ]);
              read.release();
            },
          },
        },
        f.actor,
        { kbId: f.kbId, type: "roster" },
        abort.signal,
      ).catch((error: Error) => error);
      const waiters = async () =>
        (
          await db.query(
            "runtime",
            `SELECT count(*)::int AS count FROM pg_stat_activity
             WHERE datname=current_database() AND application_name LIKE 'kb-op-%'
               AND wait_event_type='Lock' AND query='SELECT pg_advisory_lock($1, $2)'`,
          )
        ).rows[0]!.count;
      try {
        await Promise.race([
          read.promise,
          pending.then(() => {
            throw new Error("Read did not reach final recency admission");
          }),
        ]);
        await waitUntil(async () => (await waiters()) === 1);
        if (exit === "cancel") abort.abort();
        expect(await pending).toMatchObject({
          code: exit === "cancel" ? "CANCELLED" : "DEADLINE_EXCEEDED",
        });
        expect(await stamp()).toBeNull();
        await waitUntil(async () => (await waiters()) === 0);
        // The caller may settle before drain; capacity closes after the waiter.
        await waitUntil(async () => (await leases(f.kbId)) === 0);
      } finally {
        abort.abort();
        await blocker.end();
        await pending;
      }
      expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
      expect(await stamp()).not.toBeNull();
    },
  );

  it.each([false, true])(
    "retains complete crossing/oversized/max-width rows with exact immutable spans, fitted=%s",
    async (fitted) => {
      const crossing = `${"word ".repeat(300)}\n| name | detail |\n| --- | --- |\n| target | ${"x ".repeat(150).trim()} |\n`;
      const oversized = `| name | detail |\n| --- | --- |\n| target | ${"x ".repeat(512).trim()} |\n`;
      const header = ["name", ...Array.from({ length: 63 }, (_, n) => `c${n}`)];
      const maxWidth = `| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |\n| target | ${header
        .slice(1)
        .map(() => "é".repeat(1024))
        .join(" | ")} |\n`;
      const builder: Embedder = fitted
        ? {
            measureInputs: async (texts) => ({
              counts: texts.map((text) => [...text].length),
              limit: 1024,
            }),
            embed: async (texts, o) => {
              expect(texts.every((text) => [...text].length <= 1024)).toBe(true);
              return embedder.embed(texts, o);
            },
          }
        : embedder;
      const f = await fixture(
        { "crossing.md": crossing, "oversized.md": oversized, "wide.md": maxWidth },
        builder,
      );
      for (const query of [undefined, "target"]) {
        const hits = await all(f, {
          ...(query ? { query } : {}),
          structured: [{ column: "name", equals: "target" }],
          limit: 50,
        });
        for (const [path, body] of Object.entries({
          "crossing.md": crossing,
          "oversized.md": oversized,
          "wide.md": maxWidth,
        })) {
          const matching = hits.filter((hit) => hit.path === path);
          expect(matching.length).toBeGreaterThan(0);
          if (!query) expect(matching).toHaveLength(1);
          const expected = extractTableRows(body)[0]!;
          for (const hit of matching) {
            expect(hit.matchedRow).toEqual(expected.values);
            expect(hit.commitSha).toBe(f.sha);
            const source = await tx((q) =>
              readDocumentAtRevision({
                reposDir,
                kbId: f.kbId,
                commitSha: hit.commitSha,
                path,
                query: q,
              }),
            );
            const parsed = parseMarkdownDocument(Buffer.from(source.markdown));
            if (!("body" in parsed)) throw new Error("invalid fixture");
            expect(hit.span.startByte).toBeLessThanOrEqual(expected.span.startByte);
            expect(hit.span.endByte).toBeGreaterThanOrEqual(expected.span.endByte);
            expect(
              Buffer.from(parsed.body).subarray(hit.span.startByte, hit.span.endByte).toString(),
            ).toContain("target");
          }
        }
      }
    },
    60_000,
  );

  it("keeps reserved row keys through both output decoders and rejects invalid/NUL filters in both modes", async () => {
    const body =
      "| name | __proto__ | constructor | prototype |\n| --- | --- | --- | --- |\n| target | present | ctor | proto |\n";
    const f = await fixture({ "reserved.md": body });
    for (const query of [undefined, "target"]) {
      const result = await ok(f, {
        ...(query ? { query } : {}),
        structured: [{ column: "__proto__", equals: "present" }],
      });
      const row = JSON.parse(JSON.stringify(result.items[0]!.matchedRow));
      expect(Object.keys(row).sort()).toEqual(
        ["name", "__proto__", "prototype", "constructor"].sort(),
      );
      expect(Object.hasOwn(row, "__proto__")).toBe(true);
      expect(row).toEqual(extractTableRows(body)[0]!.values);
      for (const filter of [
        { type: "a\0b" },
        { title: "a\0b" },
        { tags: ["a\0b"] },
        { structured: [{ column: "a\0b", equals: "present" }] },
        { structured: [{ column: "name", equals: "a\0b" }] },
      ])
        expect(await page(f, { ...(query ? { query } : {}), ...filter })).toMatchObject({
          code: "INVALID_ARGUMENT",
        });
    }
    expect(await page(f, { timestamp: {} })).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await page(f, { timestamp: { after: golden.commitTimestamp } })).not.toBeInstanceOf(
      Error,
    );
    expect(await page(f, { timestamp: { before: "2030-01-01T00:00:00Z" } })).not.toBeInstanceOf(
      Error,
    );
  });

  it("redacts actual PostgreSQL error context at both private read catches", async () => {
    const f = await fixture();
    const canary = "r27-synthetic-private-filter";
    const log = captureLog();
    try {
      for (const query of [undefined, "Ada"]) {
        log.records.length = 0;
        const result = await page(
          f,
          { ...(query ? { query } : {}), type: "roster" },
          {
            hooks: {
              beforeRead: async () => {
                await db.query("runtime", "SELECT $1::jsonb", [
                  JSON.stringify({ name: `${canary}\0value` }),
                ]);
              },
            },
          },
        );
        expect(result).toMatchObject({ code: "INDEX_UNAVAILABLE" });
        expect(log.records).toContainEqual(
          expect.objectContaining({ site: "kb.search", errorCode: "22P05" }),
        );
        expect(JSON.stringify(log.records)).not.toContain(canary);
      }
    } finally {
      log.restore();
    }
    expect(await page(f, { type: "roster" })).not.toBeInstanceOf(Error);
  });

  it("executes scalar-boundary queries through ordinary and structured shared admission", async () => {
    const f = await fixture();
    for (const query of [
      "😀".repeat(512),
      "😀".repeat(513),
      "😀".repeat(1024),
      "a😀".repeat(512),
    ]) {
      expect(await page(f, { query })).not.toBeInstanceOf(Error);
      const pending = searchKnowledgeBase({ ...opts, ratePort: createMemoryRatePort() }, f.actor, {
        kbId: f.kbId,
        query,
      });
      await waitUntil(
        async () =>
          (await prisma.queryEmbeddingRequest.count({
            where: { kbId: f.kbId, state: "PENDING" },
          })) === 1,
      );
      const request = await prisma.queryEmbeddingRequest.findFirstOrThrow({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      await publish();
      await runQueryEmbeddingDelivery(prisma, {
        connectionString: db.urls.runtime,
        masterKey,
        durableJobId: request.id,
        workerId: key(),
        embedder,
      });
      expect((await pending).results.length).toBeGreaterThan(0);
    }
    expect(await page(f, { query: "😀".repeat(1025) })).toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      searchKnowledgeBase(opts, f.actor, { kbId: f.kbId, query: "😀".repeat(1025) }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
