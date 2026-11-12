import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLockedOperation } from "@knowledge-base/api/lib/kb/authority-lock";
import { createDiskBlobStore } from "@knowledge-base/api/lib/kb/blob-store-disk";
import { citationSnippet, sourceTokens } from "@knowledge-base/api/lib/kb/chunk";
import { createCursorSigner } from "@knowledge-base/api/lib/kb/cursor";
import { runDurableDispatcherCycle } from "@knowledge-base/api/lib/kb/dispatch";
import { readDocumentAtRevision } from "@knowledge-base/api/lib/kb/documents-read";
import {
  EmbedderCallError,
  EmbeddingInputTooLongError,
} from "@knowledge-base/api/lib/kb/embed-client";
import type { Embedder } from "@knowledge-base/api/lib/kb/embedder";
import { requestIndexBuild, scheduleIndexBuild } from "@knowledge-base/api/lib/kb/generations";
import { runIndexBuildDelivery } from "@knowledge-base/api/lib/kb/index-build";
import { configureIndexReader } from "@knowledge-base/api/lib/kb/index-file/pool";
import {
  generationFilePath,
  readIndexFile,
  readStoredVector,
  startTestIndexReader,
} from "@knowledge-base/api/lib/kb/index-file/testing";
import { createMemoryRatePort } from "@knowledge-base/api/lib/kb/limits";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import { parseMarkdownDocument } from "@knowledge-base/api/lib/kb/parse-markdown";
import { plainSnippet } from "@knowledge-base/api/lib/kb/plain-snippet";
import { createProvider, revokeProvider } from "@knowledge-base/api/lib/kb/providers";
import type { QueryEmbeddingOptions } from "@knowledge-base/api/lib/kb/query-embedding";
import { purgeRetiredGenerations } from "@knowledge-base/api/lib/kb/retention";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { type SearchOptions, searchKnowledgeBase } from "@knowledge-base/api/lib/kb/search";
import { structuredSearchKnowledgeBase } from "@knowledge-base/api/lib/kb/structured-search";
import type { PrismaClient } from "@knowledge-base/db/client";
import { captureLog } from "@knowledge-base/env/log";
import { Queue } from "bullmq";
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

type GoldenRow = { path: string; chunkIndex: number; vectorRank: number; ftsRank: number | null };
const golden = JSON.parse(
  readFileSync(new URL("../../../api/src/lib/kb/fixtures/search.json", import.meta.url), "utf8"),
) as {
  documents: Record<string, string>;
  assets: { path: string; hash: string; size: number; mime: string }[];
  queries: { query: string; expected: GoldenRow[] }[];
};

const cluster = await openKbPostgresClusterFromEnv();
const db = await cluster.createDatabase();
db.applyPrismaSchema();

const prisma = db.createPrismaClient("runtime");
const redis = openKbRedisFromEnv();
const queue = new Queue("kb-search", { connection: redis.client(), prefix: redis.key("bull") });
const reposDir = mkdtempSync(join(tmpdir(), "kb-search-"));
const indexDir = mkdtempSync(join(tmpdir(), "kb-search-index-"));
const reader = await startTestIndexReader(indexDir);
const masterKey = Buffer.alloc(32, 26).toString("base64");
const ratePort = createMemoryRatePort();
const opts: SearchOptions = { connectionString: db.urls.runtime, masterKey, ratePort };
const runtime: KbRuntimeConfig = {
  prisma,
  connectionString: db.urls.runtime,
  reposDir,
  assetsDir: "/unused",
  blobStore: createDiskBlobStore("/unused"),
  canonicalOrigin: "https://kb.example.invalid",
  cursorSigner: createCursorSigner(randomBytes(32)),
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

/** Fixture model documented in search.json: normalize([1 + #alpha, 1 + #beta]). */
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
function barrier() {
  let release = () => {};
  let arrive = () => {};
  const entered = new Promise<void>((r) => {
    arrive = r;
  });
  const paused = new Promise<void>((r) => {
    release = r;
  });
  return {
    entered,
    release,
    wait: async () => {
      arrive();
      await paused;
    },
  };
}
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
  const manifest = `${JSON.stringify({ version: 1, entries: golden.assets })}\n`;
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
    ownerId: "search-test",
    now: () => new Date(),
    getQueue: () => queue,
  });
}
async function build(jobId: string, builder: Embedder = embedder) {
  await publish();
  return deliverIndexBuild(prisma, {
    connectionString: db.urls.runtime,
    reposDir,
    indexDir,
    masterKey,
    workerId: key(),
    durableJobId: jobId,
    embedder: builder,
  });
}
async function fixture(
  files: Record<string, string> = golden.documents,
  name = "Fixture KB",
  model: { dimensions: number; embedder: Embedder } = { dimensions: 2, embedder },
) {
  const owner = await user();
  const reader = await user();
  const kbId = id();
  const sha = commit(kbId, files);
  await prisma.knowledgeBase.create({
    data: {
      id: kbId,
      ownerId: owner.id,
      name,
      slug: key(),
      description: "Search fixture knowledge base",
      state: "ACTIVE",
      headSha: sha,
    },
  });
  await prisma.kbShare.create({ data: { kbId, userId: reader.id, bits: ["read"] } });
  for (const asset of golden.assets) {
    await prisma.assetBlob.upsert({
      where: { hash: asset.hash },
      create: { hash: asset.hash, size: asset.size, mime: asset.mime },
      update: {},
    });
    await prisma.kbAssetLineage.create({
      data: {
        kbId,
        hash: asset.hash,
        actorKey: `user:${owner.id}`,
        actorUserIdSnapshot: owner.id,
        source: "UPLOAD",
      },
    });
  }
  const created = await createProvider(
    runtime,
    owner.id,
    {
      name: "Fixture",
      model: "fixture",
      endpointUrl: "https://provider.example.invalid/embeddings",
      dimensions: model.dimensions,
      apiKey: "test-only-search-key",
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
  await build(attached.jobId, model.embedder);
  const actor = { principal: { kind: "browser" as const, userId: reader.id } };
  return {
    owner,
    reader,
    kbId,
    sha,
    actor,
    generationId: attached.generationId,
    providerId: created.provider.providerId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Starts a search, then delivers its leased query embedding through the worker adapter. */
async function search(
  f: Fixture,
  input: Omit<Parameters<typeof searchKnowledgeBase>[2], "kbId">,
  options: Partial<SearchOptions> = {},
  queryEmbedder: Embedder = embedder,
) {
  let settled = false;
  const pending = searchKnowledgeBase({ ...opts, ...options }, f.actor, {
    kbId: f.kbId,
    ...input,
  })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
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
      ...opts,
      durableJobId: request.id,
      workerId: key(),
      embedder: queryEmbedder,
    }).catch(() => {});
  }
  return pending;
}
async function hits(f: Fixture, query: string, options?: Partial<SearchOptions>) {
  const result = await search(f, { query }, options);
  if (result instanceof Error) throw result;
  return result as Awaited<ReturnType<typeof searchKnowledgeBase>>;
}
const leases = (kbId: string) => prisma.generationLease.count({ where: { generation: { kbId } } });
/** L-25: replies carry the RRF sum normalized by its two-arm maximum. */
const expectedScore = (row: GoldenRow) =>
  normalizedRrfScore(
    (row.vectorRank ? 1 / (60 + row.vectorRank) : 0) + (row.ftsRank ? 1 / (60 + row.ftsRank) : 0),
    2,
  );

afterAll(async () => {
  await reader.stop();
  await queue.close();
  await redis.close();
  await prisma.$disconnect();
  await cluster.close();
  rmSync(reposDir, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

describe("hybrid search and immutable citations", () => {
  it("returns the frozen golden RRF ranking with exact 1/61 weights and two-arm sums", async () => {
    const f = await fixture();
    const other = await fixture(golden.documents, "Other KB");
    for (const { query, expected } of golden.queries) {
      const result = await hits(f, query);
      expect(result).toMatchObject({
        generationId: f.generationId,
        freshness: "current",
        indexedCommitSha: f.sha,
        headSha: f.sha,
      });
      expect(
        result.results.map(({ path, chunkIndex, score }) => ({ path, chunkIndex, score })),
      ).toEqual(
        expected.map((row) => ({
          path: row.path,
          chunkIndex: row.chunkIndex,
          score: expectedScore(row),
        })),
      );
      for (const hit of result.results) {
        // No hit from another KB or generation, even with byte-identical sources.
        expect(hit).toMatchObject({
          knowledgeBaseId: f.kbId,
          knowledgeBaseName: "Fixture KB",
          indexGenerationId: f.generationId,
          commitSha: f.sha,
          mode: "hybrid",
          matchedRow: null,
        });
        expect(hit.indexGenerationId).not.toBe(other.generationId);
      }
    }
    const top = (await hits(f, "alpha")).results[0]!;
    expect(top.score).toBe(normalizedRrfScore(1 / 61 + 1 / 61, 2));
    const vectorOnly = (await hits(f, "omega")).results[1]!;
    expect(vectorOnly).toMatchObject({ path: "c.md", score: 0.5 });
    expect(await leases(f.kbId)).toBe(0);
    // Filters apply inside both arms; limits bound the fused list.
    const defaults = await hits(f, "alpha");
    expect(defaults.results).toHaveLength(6);
    const filtered = await search(f, { query: "alpha", pathPrefix: "notes", limit: 20 });
    expect((filtered as typeof defaults).results.map((h) => h.path)).toEqual(["notes/ünï.md"]);
    const byId = await search(f, { query: "omega", documentId: "unicode-doc", limit: 1 });
    expect((byId as typeof defaults).results.map((h) => h.path)).toEqual(["notes/ünï.md"]);
  });

  it("reads each generation's own read-only file; searching never creates a side file", async () => {
    const f = await fixture();
    const other = await fixture({ "a.md": "alpha alpha alpha alpha\n" }, "Other KB");
    const path = generationFilePath(indexDir, f.kbId, f.generationId);
    const before = readdirSync(join(indexDir, f.kbId));
    // The generation's file, beside its built lexical companion.
    expect(before).toContain(`${f.generationId}.sqlite`);
    expect(before.every((name) => name.endsWith(".sqlite"))).toBe(true);
    for (let i = 0; i < 3; i++) {
      const result = await hits(f, "alpha");
      expect(result.results.every((hit) => hit.indexGenerationId === f.generationId)).toBe(true);
      expect(result.results.some((hit) => hit.knowledgeBaseId === other.kbId)).toBe(false);
    }
    // Opened read-only by the server's reader threads: no -journal, -wal or -shm ever appears.
    expect(readdirSync(join(indexDir, f.kbId))).toEqual(before);
    for (const side of ["-journal", "-wal", "-shm"])
      expect(existsSync(`${path}${side}`)).toBe(false);
  });

  it("keeps the leased generation, source commit, spans and freshness when HEAD and active change mid-query; A becomes SUPERSEDED", async () => {
    const f = await fixture();
    const gate = barrier();
    const pending = search(f, { query: "omega" }, { hooks: { beforeRead: gate.wait } });
    let newer: string | undefined;
    try {
      await gate.entered;
      const head = commit(f.kbId, { ...golden.documents, "a.md": "omega omega omega\n" }, f.sha);
      const b = await tx(async (q) => {
        await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
        return scheduleIndexBuild(q, f.kbId);
      });
      newer = b!.generationId;
      expect(await build(b!.jobId)).toBe("COMPLETE");
      const rows = await prisma.indexGeneration.findMany({
        // The fixture's never-built lexical companion is not part of this swap.
        where: { kbId: f.kbId, id: { in: [f.generationId, newer] } },
        select: { id: true, state: true },
      });
      // Activation CAS supersedes A in the same transaction while A's lease is still live.
      expect(Object.fromEntries(rows.map((r) => [r.id, r.state]))).toEqual({
        [f.generationId]: "SUPERSEDED",
        [newer]: "COMPLETE",
      });
      expect(
        (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } }))
          .activeGenerationId,
      ).toBe(newer);
      expect(await leases(f.kbId)).toBe(1);
    } finally {
      gate.release();
    }
    const result = (await pending) as Awaited<ReturnType<typeof searchKnowledgeBase>>;
    expect(result).toMatchObject({
      generationId: f.generationId,
      indexedCommitSha: f.sha,
      headSha: f.sha,
      freshness: "current",
    });
    expect(result.results.map((h) => h.path)).toEqual(
      golden.queries[1]!.expected.map((row) => row.path),
    );
    for (const hit of result.results) {
      expect(hit).toMatchObject({ commitSha: f.sha, indexGenerationId: f.generationId });
      // snapshot_source: the cited SHA is still readable and verifies blob and full-source hash.
      const source = await tx((q) =>
        readDocumentAtRevision({
          reposDir,
          kbId: f.kbId,
          commitSha: hit.commitSha,
          path: hit.path,
          query: q,
        }),
      );
      expect(source.blobSha).toBe(hit.blobSha);
      expect(source.contentHash).toBe(hit.contentHash);
      expect(source.markdown).toBe(golden.documents[hit.path]);
    }
    expect(await leases(f.kbId)).toBe(0);
    // A later query uses B, whose source changed a.md.
    const after = await hits(f, "omega");
    expect(after.generationId).toBe(newer);
    expect(after.results[0]).toMatchObject({ path: "a.md", commitSha: after.indexedCommitSha });
  });

  it("compares Unicode snippets, spans and citations against the immutable source", async () => {
    const words = Array.from(
      { length: 450 },
      (_, i) => ["Größe", "😀", "naïve", "é", "漢字", "omega"][i % 6],
    );
    const long = `---\nid: long-doc\ncitations:\n  - label: Data\n    target: "data:text/html,x"\n---\n${words.join("  ")}\n`;
    const f = await fixture({ "long/ü.md": long, "plain.md": "alpha\n" });
    const result = await hits(f, "naïve");
    const cited = result.results.filter((h) => h.path === "long/ü.md");
    expect(cited.map((h) => h.chunkIndex).sort()).toEqual([0, 1]);
    const source = await tx((q) =>
      readDocumentAtRevision({
        reposDir,
        kbId: f.kbId,
        commitSha: f.sha,
        path: "long/ü.md",
        query: q,
      }),
    );
    const parsed = parseMarkdownDocument(Buffer.from(source.markdown, "utf8"));
    if (!("body" in parsed)) throw new Error("fixture parse");
    const body = Buffer.from(parsed.body, "utf8");
    const tokens = sourceTokens(parsed.body);
    for (const hit of cited) {
      const window = body.subarray(hit.span.startByte, hit.span.endByte).toString("utf8");
      expect(tokens[hit.span.startToken]!.startByte).toBe(hit.span.startByte);
      expect(tokens[hit.span.endToken - 1]!.endByte).toBe(hit.span.endByte);
      // R2-27: the stored window, as plain text.
      expect(hit.snippet).toBe(
        citationSnippet(plainSnippet(citationSnippet(window.replace(/\p{White_Space}+/gu, " ")))),
      );
      expect([...hit.snippet].length).toBeLessThanOrEqual(240);
      expect(hit.documentId).toBe("long-doc");
      // Unsafe schemes are retained as inert metadata, identical to the source frontmatter.
      expect(hit.documentCitations).toEqual(source.documentCitations);
      expect(hit.documentCitations[0]?.target).toBe("data:text/html,x");
      expect(hit.contentHash).toBe(source.contentHash);
    }
    expect(cited.find((h) => h.chunkIndex === 1)?.span.startToken).toBe(320);
    const g = await fixture();
    const unicode = (await hits(g, "omega")).results[0]!;
    expect(unicode.assetRefs).toEqual(golden.assets);
    expect(unicode.documentCitations.map((c) => c.target)).toEqual([
      "https://example.invalid/a",
      "javascript:alert(1)",
    ]);
  });

  it("serves the lexical arm when the embed fails and fails with zero hits when either SQL arm fails", async () => {
    const f = await fixture();
    const failing: Embedder = { embed: async () => Promise.reject(new EmbedderCallError()) };
    const degraded = await search(f, { query: "alpha" }, {}, failing);
    expect(degraded).toMatchObject({
      generationId: f.generationId,
      indexNotices: [
        { kbId: f.kbId, code: "LEXICAL_ONLY", detail: "EMBEDDING_PROFILE_UNAVAILABLE" },
      ],
    });
    const lexical = (degraded as Awaited<ReturnType<typeof searchKnowledgeBase>>).results;
    expect(lexical.length).toBeGreaterThan(0);
    expect(lexical.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(lexical[0]!.score).toBe(1);
    for (const arm of ["vector", "fts"] as const) {
      const result = await search(
        f,
        { query: "alpha" },
        {
          hooks: {
            beforeArm: async (current) => {
              if (current === arm) throw new Error(`${arm} arm fault`);
            },
          },
        },
      );
      expect(result).toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(result).not.toHaveProperty("results");
    }
    expect(await leases(f.kbId)).toBe(0);
    expect((await hits(f, "alpha")).results).toHaveLength(6);
  });

  it("serves the active hybrid file lexically, without embedding, once its provider is revoked", async () => {
    const f = await fixture();
    await revokeProvider(runtime, f.owner.id, { providerId: f.providerId });
    const result = await search(f, { query: "alpha" });
    expect(result).toMatchObject({
      generationId: f.generationId,
      indexNotices: [{ kbId: f.kbId, code: "LEXICAL_ONLY", detail: "EMBEDDING_PROFILE_REVOKED" }],
    });
    const lexical = (result as Awaited<ReturnType<typeof searchKnowledgeBase>>).results;
    expect(lexical.length).toBeGreaterThan(0);
    expect(lexical.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(await prisma.queryEmbeddingRequest.count({ where: { kbId: f.kbId } })).toBe(0);
    expect(await leases(f.kbId)).toBe(0);
  });

  it("a revocation whose lexical rebuild activates mid-search re-admits that generation, never INDEX_UNAVAILABLE", async () => {
    const f = await fixture();
    const pending = searchKnowledgeBase(opts, f.actor, { kbId: f.kbId, query: "alpha" }).catch(
      (error: unknown) => error,
    );
    let request: { id: string } | null = null;
    for (let i = 0; i < 200 && !request; i++) {
      request = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      if (!request) await new Promise((r) => setTimeout(r, 10));
    }
    expect(request).not.toBeNull();
    // Admitted against the hybrid generation; the revocation schedules lexical@head, which
    // builds and activates (the hybrid is SUPERSEDED, still retained) before the embed fails.
    await revokeProvider(runtime, f.owner.id, { providerId: f.providerId });
    const lexical = await prisma.indexGeneration.findFirstOrThrow({
      where: { kbId: f.kbId, providerId: null, state: "PENDING" },
    });
    await build(lexical.jobId);
    expect(
      (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).activeGenerationId,
    ).toBe(lexical.id);
    await publish();
    await runQueryEmbeddingDelivery(prisma, {
      ...opts,
      durableJobId: request!.id,
      workerId: key(),
      embedder,
    }).catch(() => {});
    const result = await pending;
    expect(result).toMatchObject({ generationId: lexical.id });
    const hits = (result as Awaited<ReturnType<typeof searchKnowledgeBase>>).results;
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every((hit) => hit.mode === "lexical" && hit.indexGenerationId === lexical.id),
    ).toBe(true);
    expect(await leases(f.kbId)).toBe(0);
  });

  it("an embed failure after a newer semantic generation activated serves that generation with its own metadata", async () => {
    const f = await fixture();
    const pending = searchKnowledgeBase(opts, f.actor, { kbId: f.kbId, query: "alpha" }).catch(
      (error: unknown) => error,
    );
    let request: { id: string } | null = null;
    for (let i = 0; i < 200 && !request; i++) {
      request = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      if (!request) await new Promise((r) => setTimeout(r, 10));
    }
    expect(request).not.toBeNull();
    // Admitted on commit A; semantic@B activates before the embedding fails.
    const head = commit(f.kbId, { ...golden.documents, "z.md": "alpha newer head\n" }, f.sha);
    const b = await tx(async (q) => {
      await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
      return scheduleIndexBuild(q, f.kbId);
    });
    expect(await build(b!.jobId)).toBe("COMPLETE");
    expect(
      (await prisma.knowledgeBase.findUniqueOrThrow({ where: { id: f.kbId } })).activeGenerationId,
    ).toBe(b!.generationId);
    await publish();
    await runQueryEmbeddingDelivery(prisma, {
      ...opts,
      durableJobId: request!.id,
      workerId: key(),
      embedder: { embed: async () => Promise.reject(new EmbedderCallError()) },
    }).catch(() => {});
    const result = await pending;
    expect(result).toMatchObject({
      generationId: b!.generationId,
      indexedCommitSha: head,
      headSha: head,
      freshness: "current",
    });
    const hits = (result as Awaited<ReturnType<typeof searchKnowledgeBase>>).results;
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every(
        (hit) =>
          hit.mode === "lexical" &&
          hit.indexGenerationId === b!.generationId &&
          hit.commitSha === head,
      ),
    ).toBe(true);
    expect(await leases(f.kbId)).toBe(0);
  });

  // Closed classification, error kind x fallback outcome through the real worker adapter:
  // only the embedder failing degrades; a request-integrity failure (here a missing generation
  // lease, as liveRequest() rejects it) fails the search and never serves keywords.
  it.each([
    ["embedder error", "embedder", "lexical"],
    ["query too long for the model", "too-long", "lexical"],
    ["invalid embedding", "invalid", "lexical"],
    ["missing generation lease", "lease", "INDEX_UNAVAILABLE"],
  ] as const)("%s -> %s", async (_name, kind, outcome) => {
    const f = await fixture();
    const pending = searchKnowledgeBase(opts, f.actor, { kbId: f.kbId, query: "alpha" }).catch(
      (error: unknown) => error,
    );
    let request: { id: string } | null = null;
    for (let i = 0; i < 200 && !request; i++) {
      request = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING" },
      });
      if (!request) await new Promise((r) => setTimeout(r, 10));
    }
    expect(request).not.toBeNull();
    if (kind === "lease")
      expect(
        (await prisma.generationLease.deleteMany({ where: { requestId: request!.id } })).count,
      ).toBe(1);
    await publish();
    await runQueryEmbeddingDelivery(prisma, {
      ...opts,
      durableJobId: request!.id,
      workerId: key(),
      embedder:
        kind === "embedder"
          ? { embed: async () => Promise.reject(new EmbedderCallError()) }
          : kind === "too-long"
            ? { embed: async () => Promise.reject(new EmbeddingInputTooLongError()) }
            : kind === "invalid"
              ? { embed: async (texts) => texts.map(() => [Number.NaN, 1]) }
              : embedder,
    }).catch(() => {});
    const result = await pending;
    if (outcome === "lexical") {
      expect(result).toMatchObject({ generationId: f.generationId });
      const hits = (result as Awaited<ReturnType<typeof searchKnowledgeBase>>).results;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.mode === "lexical")).toBe(true);
    } else {
      expect(result).toMatchObject({ code: outcome });
      expect(result).not.toHaveProperty("results");
    }
    expect(await leases(f.kbId)).toBe(0);
  });

  it("read-your-writes: a search after a commit serves the new head's lexical companion as soon as it completes", async () => {
    const f = await fixture();
    const head = commit(f.kbId, { ...golden.documents, "z.md": "alpha new head\n" }, f.sha);
    const b = await tx(async (q) => {
      await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
      return scheduleIndexBuild(q, f.kbId);
    });
    const companion = await prisma.indexGeneration.findFirstOrThrow({
      where: { kbId: f.kbId, providerId: null, state: "PENDING" },
    });
    // Nothing of the head is servable yet: the older generation serves.
    expect(await hits(f, "alpha")).toMatchObject({ generationId: f.generationId });
    await publish();
    expect(
      await runIndexBuildDelivery(prisma, {
        connectionString: db.urls.runtime,
        reposDir,
        indexDir,
        masterKey,
        workerId: key(),
        durableJobId: companion.jobId,
      }),
    ).toBe("COMPLETE");
    // semantic@head is still queued; the companion already serves the new commit.
    const result = await hits(f, "alpha");
    expect(result).toMatchObject({ generationId: companion.id, indexedCommitSha: head });
    expect(result.results.some((hit) => hit.path === "z.md")).toBe(true);
    expect(result.results.every((hit) => hit.mode === "lexical")).toBe(true);
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: b!.generationId } })).state,
    ).toBe("PENDING");
  });

  it.each(["beforeRead", "vector", "fts"] as const)(
    "a profile lost at %s degrades to the lexical arm before the reply, never INDEX_UNAVAILABLE",
    async (barrier) => {
      const f = await fixture();
      const lose = () =>
        prisma.embeddingProvider
          .update({ where: { id: f.providerId }, data: { revokedAt: new Date() } })
          .then(() => {});
      const result = await search(
        f,
        { query: "alpha" },
        {
          hooks:
            barrier === "beforeRead"
              ? { beforeRead: lose }
              : {
                  beforeArm: async (arm) => {
                    if (arm === barrier) await lose();
                  },
                },
        },
      );
      expect(result).toMatchObject({
        generationId: f.generationId,
        indexNotices: [{ kbId: f.kbId, code: "LEXICAL_ONLY", detail: "EMBEDDING_PROFILE_REVOKED" }],
      });
      const hits = (result as Awaited<ReturnType<typeof searchKnowledgeBase>>).results;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.mode === "lexical")).toBe(true);
      expect(await leases(f.kbId)).toBe(0);
    },
  );

  it("denies the reply when read access is revoked before it, and enforces shared quotas", async () => {
    const f = await fixture();
    const result = await search(
      f,
      { query: "alpha" },
      {
        hooks: {
          beforeArm: async (arm) => {
            if (arm !== "fts") return;
            await tx((q) =>
              q('UPDATE kb_share SET "revokedAt"=now() WHERE "kbId"=$1 AND "userId"=$2', [
                f.kbId,
                f.reader.id,
              ]),
            );
          },
        },
      },
    );
    expect(result).toMatchObject({ code: "NOT_FOUND" });
    expect(result).not.toHaveProperty("results");
    expect(result).not.toHaveProperty("generationId");
    expect(await leases(f.kbId)).toBe(0);
    const g = await fixture();
    ratePort.counts.set(`kb:query:${g.reader.id}:${g.kbId}`, 30);
    expect(await search(g, { query: "alpha" })).toMatchObject({ code: "RATE_LIMITED" });
    expect(await prisma.queryEmbeddingRequest.count({ where: { kbId: g.kbId } })).toBe(0);
    for (const input of [{ query: "x".repeat(1025) }, { query: "alpha", limit: 21 }])
      expect(await search(g, input)).toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("server FTS goldens (parity with the local CLI)", () => {
  it("folds diacritics, ANDs punctuated runs, matches quoted phrases and keeps majority matches in hybrid", async () => {
    const f = await fixture(
      {
        "index.md": "",
        "art.md": "the art of state planning\n",
        "cafe.md": "café au lait\n",
        "mail.md": "write to user at example dot com\n",
        "other.md": "nothing relevant here\n",
        "pi.md": "pi is 3.14 roughly\n",
      },
      "FTS goldens",
    );
    for (const [query, matched] of [
      ["cafe", ["cafe.md"]],
      ["café", ["cafe.md"]],
      ["state-of-the-art", ["art.md"]],
      ["user@example.com", ["mail.md"]],
      ["3.14", ["pi.md"]],
      ["3.15", []],
      // 1 of 2 words is no majority in a hybrid search; 2 of 3 is.
      ["banana state", []],
      ["banana state planning", ["art.md"]],
      ['"state planning"', ["art.md"]],
      ['"planning state"', []],
    ] as const) {
      const result = await hits(f, query);
      // Every chunk is in the vector arm (fewer than 80); only FTS matches add a second
      // reciprocal rank, so exactly they score above one arm's normalized maximum, 0.5.
      expect(
        result.results.filter((hit) => hit.score > 0.5 + 1e-9).map((hit) => hit.path),
        query,
      ).toEqual(matched);
    }
  });
});

describe("binary_int8_rescore with a 12-dimensional external profile (pad8)", () => {
  it("builds, publishes and serves hybrid search", async () => {
    const pad = (vector: number[]) => [...vector, ...Array.from({ length: 10 }, () => 0.01)];
    const twelve: Embedder = {
      embed: async (texts, o) => {
        await o?.beforeDispatch?.();
        return texts.map((text) => pad(fixtureVector(text)));
      },
    };
    const f = await fixture(golden.documents, "Twelve", { dimensions: 12, embedder: twelve });
    const file = readIndexFile(generationFilePath(indexDir, f.kbId, f.generationId));
    expect(file.meta).toMatchObject({ dimensions: 12, quantization: "binary_int8_rescore" });
    expect(file.vectors).toBe(file.chunks.length);
    const result = await search(f, { query: "alpha" }, {}, twelve);
    if (result instanceof Error) throw result;
    const found = result as Awaited<ReturnType<typeof searchKnowledgeBase>>;
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.every((hit) => hit.mode === "hybrid")).toBe(true);
    expect(found.results[0]).toMatchObject({ path: "a.md", indexGenerationId: f.generationId });
  });
});

describe("reader interlocks against the real pool (§1.5)", () => {
  const capacityHolders = async () =>
    (
      await db.query(
        "runtime",
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE a.application_name LIKE 'kb-query-capacity-%' AND l.locktype='advisory' AND l.granted`,
      )
    ).rows[0]?.n as number;
  const readSessions = async () =>
    (
      await db.query(
        "runtime",
        `SELECT pid FROM pg_stat_activity WHERE datname=current_database()
          AND application_name LIKE 'kb-search-%' AND application_name NOT LIKE 'kb-search-drain-%'`,
      )
    ).rows.map((row) => row.pid as number);
  async function withSlowReader<T>(
    run: (pool: Awaited<ReturnType<typeof startTestIndexReader>>) => Promise<T>,
    checkDelayMs = 400,
  ) {
    const slow = await startTestIndexReader(indexDir, { checkDelayMs });
    try {
      return await run(slow);
    } finally {
      await slow.stop();
      configureIndexReader(reader);
    }
  }
  const queryless = (f: Fixture, signal?: AbortSignal) =>
    structuredSearchKnowledgeBase(
      { ...opts, cursorSigner: runtime.cursorSigner },
      f.actor,
      { kbId: f.kbId, tags: ["fixture"] },
      signal,
    ).catch((error: unknown) => error);

  it("an abort mid-read keeps the purge, the KEY SHARE lock and the capacity slot until the thread acknowledges", async () => {
    const f = await fixture();
    const retention = { connectionString: db.urls.runtime, indexDir };
    const later = new Date(Date.now() + 8 * 86_400_000);
    // Earlier cases left retired generations: purge them so only this read's one remains.
    await purgeRetiredGenerations({ ...retention, now: later });
    await withSlowReader(async (slow) => {
      const controller = new AbortController();
      const pending = queryless(f, controller.signal);
      await vi.waitFor(() => expect(slow.stats().busy).toBe(1), { timeout: 10_000 });
      // A newer build supersedes the generation under the read.
      const head = commit(f.kbId, { ...golden.documents, "a.md": "omega\n" }, f.sha);
      const b = await tx(async (q) => {
        await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
        return scheduleIndexBuild(q, f.kbId);
      });
      expect(await build(b!.jobId)).toBe("COMPLETE");
      // Only the new head's transient lexical companion, retired by b, is purgeable.
      expect((await purgeRetiredGenerations({ ...retention, now: later })).purged).toBe(1);
      expect(existsSync(generationFilePath(indexDir, f.kbId, f.generationId))).toBe(true);
      controller.abort();
      // Aborted, but the thread is still inside a slice: nothing has drained yet.
      expect(slow.stats().busy).toBe(1);
      expect(await readSessions()).toHaveLength(1);
      expect(await capacityHolders()).toBeGreaterThan(0);
      expect((await purgeRetiredGenerations({ ...retention, now: later })).purged).toBe(0);
      expect(await pending).toMatchObject({ code: "CANCELLED" });
      await vi.waitFor(async () => expect(await readSessions()).toHaveLength(0));
      expect(await capacityHolders()).toBe(0);
      expect((await purgeRetiredGenerations({ ...retention, now: later })).purged).toBe(1);
      expect(existsSync(generationFilePath(indexDir, f.kbId, f.generationId))).toBe(false);
    }, 1500);
  });

  it("a terminated read session fails INDEX_UNAVAILABLE without an integrity log", async () => {
    const f = await fixture();
    const log = captureLog();
    try {
      await withSlowReader(async (slow) => {
        const pending = queryless(f);
        await vi.waitFor(() => expect(slow.stats().busy).toBe(1), { timeout: 10_000 });
        const [pid] = await readSessions();
        expect(pid).toBeDefined();
        await db.query("runtime", "SELECT pg_terminate_backend($1)", [pid]);
        expect(await pending).toMatchObject({ code: "INDEX_UNAVAILABLE" });
      });
      expect(log.records.some((r) => r.site === "kb.index-missing")).toBe(false);
    } finally {
      log.restore();
    }
  });
});

describe("missing index files against the real pool (§1.7)", () => {
  /** Like `search`, but delivers every query embedding the operation admits (retries included). */
  async function searchDelivering(
    f: Fixture,
    input: { query: string },
    options: Partial<SearchOptions> = {},
  ) {
    let settled = false;
    const pending = searchKnowledgeBase({ ...opts, ...options }, f.actor, {
      kbId: f.kbId,
      ...input,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    const delivered = new Set<string>();
    for (let i = 0; i < 1000 && !settled; i++) {
      const request = await prisma.queryEmbeddingRequest.findFirst({
        where: { kbId: f.kbId, state: "PENDING", id: { notIn: [...delivered] } },
      });
      if (!request) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      delivered.add(request.id);
      await publish();
      await runQueryEmbeddingDelivery(prisma, {
        ...opts,
        durableJobId: request.id,
        workerId: key(),
        embedder,
      }).catch(() => {});
    }
    return { result: await pending, admissions: delivered.size };
  }
  const integrityLogs = (log: { records: { site?: unknown }[] }) =>
    log.records.filter((record) => record.site === "kb.index-missing").length;

  it("a first miss of a COMPLETE generation is logged and re-admitted once; the fresh admission succeeds", async () => {
    const f = await fixture();
    const path = generationFilePath(indexDir, f.kbId, f.generationId);
    const saved = `${path}.saved`;
    copyFileSync(path, saved);
    rmSync(path, { force: true });
    let reads = 0;
    const log = captureLog();
    try {
      const { result, admissions } = await searchDelivering(
        f,
        { query: "alpha" },
        {
          hooks: {
            beforeRead: async () => {
              reads += 1;
              // The file reappears before the re-admission's read (e.g. an operator restore).
              if (reads === 2) {
                copyFileSync(saved, path);
                chmodSync(path, 0o444);
              }
            },
          },
        },
      );
      if (result instanceof Error) throw result;
      expect(
        (result as Awaited<ReturnType<typeof searchKnowledgeBase>>).results.length,
      ).toBeGreaterThan(0);
      expect(reads).toBe(2);
      expect(admissions).toBe(2);
      expect(integrityLogs(log)).toBe(1);
    } finally {
      log.restore();
      rmSync(saved, { force: true });
    }
  });

  it("a second miss fails closed with INDEX_UNAVAILABLE", async () => {
    const f = await fixture();
    rmSync(generationFilePath(indexDir, f.kbId, f.generationId), { force: true });
    const log = captureLog();
    try {
      const { result, admissions } = await searchDelivering(f, { query: "alpha" });
      expect(result).toMatchObject({ code: "INDEX_UNAVAILABLE" });
      expect(admissions).toBe(2);
      expect(integrityLogs(log)).toBe(2);
    } finally {
      log.restore();
    }
  });

  it("a cursor pinned to a restored SUPERSEDED generation without its file is INVALID_CURSOR, no integrity log", async () => {
    const notes = {
      "a.md": "---\ntype: note\n---\nalpha one\n",
      "b.md": "---\ntype: note\n---\nbeta two\n",
    };
    const f = await fixture(notes, "Pinned");
    const structuredOptions = { ...opts, cursorSigner: runtime.cursorSigner };
    const page = await structuredSearchKnowledgeBase(structuredOptions, f.actor, {
      kbId: f.kbId,
      type: "note",
      limit: 1,
    });
    expect(page.generationId).toBe(f.generationId);
    expect(page.nextCursor).not.toBeNull();
    // After a restore the pinned generation is SUPERSEDED and its file is gone.
    const head = commit(f.kbId, { ...notes, "c.md": "---\ntype: note\n---\nomega\n" }, f.sha);
    const b = await tx(async (q) => {
      await q('UPDATE knowledge_base SET "headSha"=$2 WHERE id=$1', [f.kbId, head]);
      return scheduleIndexBuild(q, f.kbId);
    });
    expect(await build(b!.jobId)).toBe("COMPLETE");
    expect(
      (await prisma.indexGeneration.findUniqueOrThrow({ where: { id: f.generationId } })).state,
    ).toBe("SUPERSEDED");
    // A first page on the new active generation evicts the cached handle of the old one from
    // every reader thread (an open handle would otherwise keep reading the unlinked file).
    const fresh = await structuredSearchKnowledgeBase(structuredOptions, f.actor, {
      kbId: f.kbId,
      type: "note",
      limit: 1,
    });
    expect(fresh.generationId).toBe(b!.generationId);
    rmSync(generationFilePath(indexDir, f.kbId, f.generationId), { force: true });
    const log = captureLog();
    try {
      const next = await structuredSearchKnowledgeBase(structuredOptions, f.actor, {
        kbId: f.kbId,
        type: "note",
        limit: 1,
        cursor: page.nextCursor!,
      }).catch((error: unknown) => error);
      expect(next).toMatchObject({ code: "INVALID_CURSOR" });
      expect(integrityLogs(log)).toBe(0);
    } finally {
      log.restore();
    }
  });
});

describe("stored vector bytes follow the §1.4 formula through the real build", () => {
  it("normalizes each embedding exactly once (sampled and unsampled chunks alike)", async () => {
    // Near-unit raw input whose eighth component rounds differently if normalized twice.
    const raw = [...Array.from({ length: 7 }, () => 0.37778007984161377), 0.031233789399266243];
    const fixed: Embedder = {
      embed: async (texts, o) => {
        await o?.beforeDispatch?.();
        return texts.map(() => [...raw]);
      },
    };
    const f = await fixture({ "one.md": "alpha one\n" }, "Once", {
      dimensions: 8,
      embedder: fixed,
    });
    const path = generationFilePath(indexDir, f.kbId, f.generationId);
    expect(readIndexFile(path).meta).toMatchObject({
      quantization: "binary_int8_rescore",
      int8_scale: 0.37778007984161377,
    });
    // index-quantization-cases.json "dims8-near-unit-rounding-once": [127 x 7, 11], bits ff.
    expect(readStoredVector(path, 1)).toEqual({
      int8: [127, 127, 127, 127, 127, 127, 127, 11],
      bitsHex: "ff",
    });
  });
});
